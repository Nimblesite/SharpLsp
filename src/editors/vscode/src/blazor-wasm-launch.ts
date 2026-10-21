// Launching a Blazor WebAssembly app and handing it to js-debug.
//
// Implements [DEBUG-FEATURES-LAUNCH-BLAZOR-WASM].
//
// Three moving parts, in this order: `dotnet run` (which starts the DevServer that
// serves both the app and the .NET debug proxy), the announcement of the address it
// bound, and the browser session that receives the expanded `inspectUri`. Everything
// the launch decides WITHOUT a process lives in blazor-wasm-debug.ts; everything here
// is process control and the handoff.
//
// The process is started through dotnet-process.ts rather than a bare `spawn`, so the
// CLI's UI language is pinned (the announcement is English text) and the stop reaps the
// whole tree: `dotnet run` launches the dev server as a CHILD, so signalling only the
// parent leaves the port bound by a process nothing owns.
import * as vscode from 'vscode';
import {
  BLAZOR_WASM_DEBUG_TYPE,
  DEFAULT_LAUNCH_NAME,
  STARTUP_TIMEOUT_MS,
  blazorWasmConfigurations,
  browserConfiguration,
  browserDebugType,
  browserOf,
  inspectUriFor,
  listeningUrlOf,
  requestOf,
  runArguments,
  startupFailure,
  stringField,
  takeLines,
  type BlazorWasmRequest,
  type Startup,
} from './blazor-wasm-debug';
import { runDotnet, type DotnetRun } from './dotnet-process';
import { info, traceInfo, warn } from './log';
import { directoryOf, fileNameOf } from './paths';
import { err, ok, type Result } from './result';

/**
 * A backstop on the whole session, not a policy.
 *
 * dotnet-process.ts kills an invocation that outlives its own ceiling; a dev
 * server legitimately lives as long as the browser session does, so the ceiling
 * is set far past any debugging session rather than at the run timeout.
 */
const SESSION_CEILING_MS = 24 * 60 * 60 * 1_000;

/** A `dotnet run` process a launch owns. */
export interface BlazorWasmProcess {
  /** Resolves once the process, and everything it started, is gone. */
  readonly ended: Promise<Result<void>>;
  /** Terminates the process and everything it started. */
  stop(): void;
}

/** Starts `dotnet run`; `onOutput` sees every chunk as it arrives. */
export type BlazorWasmProcessStarter = (
  args: readonly string[],
  cwd: string,
  onOutput: (chunk: string) => void,
) => BlazorWasmProcess;

/** A started browser debug session, as far as the launch cares. */
export interface BrowserSession {
  /** Resolves when the user's browser session ends, however it ends. */
  readonly ended: Promise<void>;
}

/** Hands a configuration to js-debug, or reports that it refused. */
export type BrowserSessionStarter = (
  folder: vscode.WorkspaceFolder | undefined,
  configuration: vscode.DebugConfiguration,
) => Promise<BrowserSession | undefined>;

/**
 * What a launch needs from outside itself.
 *
 * A seam, not a testing afterthought: a browser debug session cannot be started
 * in a headless test host, and a real dev server takes minutes to build, so the
 * suite that proves the handoff replaces exactly these three and nothing else.
 */
export interface BlazorWasmHost {
  readonly startProcess: BlazorWasmProcessStarter;
  readonly startBrowserSession: BrowserSessionStarter;
  /** Every project file under a workspace folder. */
  readonly listProjects: (root: string) => Promise<readonly string[]>;
}

/** A launch that is currently running, and how to end it. */
export interface RunningLaunch {
  readonly projectFile: string;
  /** The address the DevServer announced. */
  readonly url: string;
  /** The configuration js-debug was handed. */
  readonly configuration: vscode.DebugConfiguration;
  /** Resolves once the `dotnet run` process is gone. */
  readonly ended: Promise<void>;
  /** Ends the launch; the browser session ends with the app. */
  stop(): void;
}

/** The launches in flight, and the process each one owns. */
interface LaunchRegistry {
  readonly running: Map<string, RunningLaunch>;
  /** The process each launch owns, so only its OWN exit un-registers it. */
  readonly processes: Map<string, BlazorWasmProcess>;
}

declare global {
  /** The live launches; global for the reason {@link useBlazorWasmHost} is. */
  var __sharplspBlazorWasmLaunches: LaunchRegistry | undefined;
}

/** The one registry, wherever this module was loaded from. */
function registry(): LaunchRegistry {
  globalThis.__sharplspBlazorWasmLaunches ??= { running: new Map(), processes: new Map() };
  return globalThis.__sharplspBlazorWasmLaunches;
}

/** The launch in flight for `projectFile`, if any. */
export function runningBlazorWasmLaunch(projectFile: string): RunningLaunch | undefined {
  return registry().running.get(projectFile);
}

/**
 * `dotnet run`, supervised by the one module that knows how to stop a tree.
 *
 * `runDotnet` never rejects: a spawn that failed, a non-zero exit and a kill all
 * arrive as a {@link DotnetRun} the caller can report.
 */
const dotnetRunProcess: BlazorWasmProcessStarter = (args, cwd, onOutput) => {
  const controller = new AbortController();
  const ended = runDotnet(args, cwd, SESSION_CEILING_MS, controller.signal, { onOutput }).then(
    exitOf,
  );
  return {
    ended,
    stop: () => {
      controller.abort();
    },
  };
};

/** What a finished invocation means to a launch: OK, or the reason it is not. */
function exitOf(run: DotnetRun): Result<void> {
  if (!run.failed && !run.killed) return ok(undefined);
  const reason = run.errorMessage?.trim();
  return err(reason !== undefined && reason.length > 0 ? reason : 'dotnet run stopped');
}

/**
 * The shipped browser handoff: `vscode.debug.startDebugging` onto js-debug.
 *
 * The session is matched by NAME because `startDebugging` answers whether the
 * session started, not which one it was; the name is the one this launch wrote
 * into the configuration, so the pair is unambiguous.
 */
async function startBrowserSession(
  folder: vscode.WorkspaceFolder | undefined,
  configuration: vscode.DebugConfiguration,
): Promise<BrowserSession | undefined> {
  const started = await vscode.debug.startDebugging(folder, configuration);
  if (!started) return undefined;
  return { ended: sessionLifetime(configuration.name) };
}

/** Resolves when the session named `name` terminates. */
async function sessionLifetime(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const starting = vscode.debug.onDidStartDebugSession((session) => {
      if (session.name !== name) return;
      starting.dispose();
      const ending = vscode.debug.onDidTerminateDebugSession((gone) => {
        if (gone.id !== session.id) return;
        ending.dispose();
        resolve();
      });
    });
  });
}

/** Every project file beneath a folder, minus build output and dependencies. */
async function listProjectFiles(root: string): Promise<readonly string[]> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/*.{csproj,fsproj}'),
    '**/{node_modules,bin,obj,target}/**',
  );
  return found.map((uri) => uri.fsPath);
}

/** The shipped launch environment. */
const shippedHost: BlazorWasmHost = {
  startProcess: dotnetRunProcess,
  startBrowserSession,
  listProjects: listProjectFiles,
};

declare global {
  /** Overrides on the launch environment; see {@link useBlazorWasmHost}. */
  var __sharplspBlazorWasmHost: Partial<BlazorWasmHost> | undefined;
}

/**
 * Overrides live on `globalThis`, not in a module variable.
 *
 * The suite runs from `out/` while the extension runs from the bundled
 * `dist/extension.js`, so those are two module instances that share no module
 * state; a module-scoped seam would be replaced in a copy nothing calls, and
 * the test would pass or fail for reasons unrelated to the launch. hot-reload.ts
 * keeps its flag in the same place for the same reason.
 */
function host(): BlazorWasmHost {
  return { ...shippedHost, ...(globalThis.__sharplspBlazorWasmHost ?? {}) };
}

/**
 * Replace part of the launch environment, returning the undo.
 *
 * Callers MUST restore: a suite that leaves an override in place changes every
 * launch the extension makes afterwards, in this window and any later one.
 */
export function useBlazorWasmHost(overrides: Partial<BlazorWasmHost>): () => void {
  const previous = globalThis.__sharplspBlazorWasmHost;
  globalThis.__sharplspBlazorWasmHost = { ...previous, ...overrides };
  return () => {
    globalThis.__sharplspBlazorWasmHost = previous;
  };
}

/** A promise, and the one call that settles it. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  settle(value: T): void;
}

/** A {@link Deferred}, resolved exactly once by whoever gets there first. */
function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    settle: (value) => {
      settle(value);
    },
  };
}

/** The app's address, or the reason there is none. */
async function waitForAddress(startup: Deferred<Startup>): Promise<Startup> {
  const timer = setTimeout(() => {
    startup.settle({ kind: 'timeout' });
  }, STARTUP_TIMEOUT_MS);
  try {
    return await startup.promise;
  } finally {
    clearTimeout(timer);
  }
}

/** Streams `dotnet run` output to the log and reports the first bound address. */
interface OutputScanner {
  readonly push: (chunk: string) => void;
}

/** A scanner that logs whole lines and reports the first listening URL. */
function outputScanner(onUrl: (url: string) => void): OutputScanner {
  let pending = '';
  const feed = (line: string): void => {
    const trimmed = line.trimEnd();
    if (trimmed.length > 0) traceInfo(`dotnet run: ${trimmed}`);
    const url = listeningUrlOf(trimmed);
    if (url !== undefined) onUrl(url);
  };
  return {
    push: (chunk) => {
      const buffer = takeLines(pending, chunk);
      pending = buffer.pending;
      buffer.lines.forEach(feed);
    },
  };
}

/**
 * One `dotnet run` process, and what became of it.
 *
 * `exit` is recorded and queryable because a dev server can die between the
 * moment it announces its address and the moment the browser session opens;
 * registering a launch whose process is already gone would leave the next
 * launch believing a DevServer it does not own is still serving the port.
 */
interface ProcessRun {
  readonly process: BlazorWasmProcess;
  /** Resolves once the process is gone and this launch is un-registered. */
  readonly finished: Promise<void>;
  /** How the process ended, or undefined while it is still alive. */
  readonly exit: () => Result<void> | undefined;
}

/**
 * Forget a launch ONLY when the process that ended is the one it owns.
 *
 * A stopped app takes a moment to exit, and a newer launch of the same project
 * can register in that window; deleting by key alone un-registered the LIVE
 * launch and left a second DevServer nobody would ever stop.
 */
function forget(projectFile: string, process: BlazorWasmProcess): void {
  const live = registry();
  if (live.processes.get(projectFile) !== process) return;
  live.processes.delete(projectFile);
  live.running.delete(projectFile);
}

/** Start the app, wait for its address, and hand it to the browser. */
async function startSession(
  folder: vscode.WorkspaceFolder | undefined,
  request: BlazorWasmRequest,
): Promise<Result<RunningLaunch>> {
  const startup = deferred<Startup>();
  const scanner = outputScanner((url) => {
    startup.settle({ kind: 'listening', url });
  });
  info(`Starting Blazor WebAssembly launch for ${fileNameOf(request.projectFile)}`);
  const process = host().startProcess(
    runArguments(request.projectFile, request.launchProfile?.name),
    directoryOf(request.projectFile),
    scanner.push,
  );
  let exit: Result<void> | undefined;
  const finished = process.ended.then((outcome) => {
    exit = outcome;
    forget(request.projectFile, process);
    startup.settle({ kind: 'exited', outcome });
  });
  const outcome = await waitForAddress(startup);
  if (outcome.kind !== 'listening') {
    process.stop();
    return err(startupFailure(outcome, request.projectFile));
  }
  const run: ProcessRun = { process, finished, exit: () => exit };
  return await handOff(folder, request, { ...run, url: request.url ?? outcome.url });
}

/** A process that has announced its address, ready for a browser session. */
type ServedApp = ProcessRun & { readonly url: string };

/** Hand the served app to js-debug, and tie the app's life to that session's. */
async function handOff(
  folder: vscode.WorkspaceFolder | undefined,
  request: BlazorWasmRequest,
  app: ServedApp,
): Promise<Result<RunningLaunch>> {
  const configuration = browserConfiguration({
    name: request.name,
    url: app.url,
    inspectUri: inspectUriFor(request.launchProfile?.inspectUri, app.url),
    browser: request.browser,
    webRoot: request.webRoot,
    timeout: request.timeout,
  });
  info(
    `Blazor WebAssembly app for ${fileNameOf(request.projectFile)} is listening on ${app.url}; ` +
      `handing it to ${browserDebugType(request.browser)}`,
  );
  const session = await host().startBrowserSession(folder, configuration);
  const died = app.exit();
  if (session === undefined) {
    app.process.stop();
    return err(`Could not start ${browserDebugType(request.browser)} for ${app.url}.`);
  }
  if (died !== undefined) {
    app.process.stop();
    return err(startupFailure({ kind: 'exited', outcome: died }, request.projectFile));
  }
  const viaBrowser = session.ended.then(async () => {
    info(
      `Blazor WebAssembly browser session for ${fileNameOf(request.projectFile)} ended; ` +
        'stopping dotnet run',
    );
    app.process.stop();
    await app.finished;
  });
  // The launch's whole lifetime: the browser session ends (which stops the app),
  // or the app dies on its own. Both paths have reaped the process by the time it
  // settles, so a caller that awaits `ended` may rely on the port being free.
  const ended = Promise.race([viaBrowser, app.finished]);
  const launch: RunningLaunch = {
    projectFile: request.projectFile,
    url: app.url,
    configuration,
    ended,
    stop: () => {
      app.process.stop();
    },
  };
  const live = registry();
  live.processes.set(request.projectFile, app.process);
  live.running.set(request.projectFile, launch);
  return ok(launch);
}

/**
 * Launch the Blazor WebAssembly app a configuration describes.
 *
 * The returned launch owns the `dotnet run` process: when the browser session
 * that received its `inspectUri` ends, that process — and only the tree it
 * started — is terminated.
 */
export async function launchBlazorWasm(
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
): Promise<Result<RunningLaunch>> {
  const request = await requestOf(folder, config);
  if (!request.ok) return request;
  const previous = registry().running.get(request.value.projectFile);
  if (previous !== undefined) {
    warn(
      `Stopping the Blazor WebAssembly launch already running for ${fileNameOf(request.value.projectFile)}`,
    );
    previous.stop();
  }
  return await startSession(folder, request.value);
}

/**
 * Fills in, and later launches, a `sharplsp-blazorwasm` session.
 *
 * Implements [DEBUG-FEATURES-LAUNCH-BLAZOR-WASM] and
 * [DEBUG-FEATURES-LAUNCH-DYNAMIC].
 */
export class BlazorWasmDebugProvider implements vscode.DebugConfigurationProvider {
  /** Nothing to resolve before `${...}` are expanded: this tier is not a debugger. */
  public resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.DebugConfiguration {
    config.type = BLAZOR_WASM_DEBUG_TYPE;
    config.request = config.request === 'attach' ? 'launch' : config.request;
    config.browser = browserOf(config.browser);
    config.name = stringField(config, 'name') ?? DEFAULT_LAUNCH_NAME;
    return config;
  }

  /**
   * Start the app and hand it to js-debug.
   *
   * `undefined` AFTER the browser session has started is the handoff, not a
   * refusal: VS Code must start no session for `sharplsp-blazorwasm` itself,
   * because the session the user debugs is the `pwa-chrome`/`pwa-msedge` one.
   */
  public async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const outcome = await launchBlazorWasm(folder, config);
    if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error);
    return undefined;
  }

  /** One configuration per Blazor WebAssembly project, generated without a prompt. */
  public async provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<vscode.DebugConfiguration[]> {
    if (folder === undefined) return [];
    return blazorWasmConfigurations(await host().listProjects(folder.uri.fsPath));
  }
}
