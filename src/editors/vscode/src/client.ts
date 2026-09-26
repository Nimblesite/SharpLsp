import { joinPath } from './paths';
import * as fs from 'node:fs';
import { type ExtensionContext, type Disposable, window, workspace } from 'vscode';
import {
  CloseAction,
  ErrorAction,
  type CloseHandlerResult,
  type ErrorHandlerResult,
  type Executable,
  LanguageClient,
  type LanguageClientOptions,
  type Message,
  type ServerOptions,
  TransportKind,
  State,
  RevealOutputChannelOn,
} from 'vscode-languageclient/node';
import { EXTENSION_ID, EXTENSION_NAME, SERVER_BINARY, SERVER_BINARY_WIN } from './constants.js';
import { getErrorMessage } from './utils.js';
import * as config from './config.js';
import * as log from './log.js';
import { createOpenSync, type OpenSync } from './open-sync.js';
import { createAnsiStrippingChannel } from './output-filter.js';
import { serverStdioOptions } from './server-stderr.js';
import { detectRuntimePlatform } from './platform.js';
import * as state from './state.js';
import { type SharpLspStatusBar, ServerState } from './status.js';
import { dotnetHostEnvironment } from './dotnetRuntime.js';

/** The documents the client syncs to the server, and holds requests about. */
export const DOCUMENT_SELECTOR = [
  { scheme: 'file', language: 'csharp' },
  { scheme: 'file', language: 'fsharp' },
  { scheme: 'untitled', language: 'csharp' },
  { scheme: 'untitled', language: 'fsharp' },
];

export interface DeploymentPaths {
  readonly serverPath?: string;
  readonly csharpSidecarPath?: string;
  readonly fsharpSidecarPath?: string;
}

/** Create, start, and return a new `LanguageClient`. */
export async function start(
  context: ExtensionContext,
  statusBar: SharpLspStatusBar,
  deploymentPaths: DeploymentPaths = {},
  dotnetPath?: string,
): Promise<LanguageClient | undefined> {
  const serverPath = deploymentPaths.serverPath ?? resolveServerPath(context);
  if (serverPath === undefined) {
    const msg =
      'SharpLsp binary not found. Install via `cargo install sharplsp` or set `sharplsp.lspPath`.';
    log.info(msg);
    window.showErrorMessage(msg);
    statusBar.setState(ServerState.Error);
    return undefined;
  }

  log.info(`Server binary: ${serverPath}`);

  const run: Executable = {
    command: serverPath,
    args: [...config.serverExtraArgs()],
    transport: TransportKind.stdio,
    options: {
      env: {
        ...process.env,
        RUST_LOG: config.loggingLevel(),
        ...sidecarEnv(deploymentPaths, dotnetPath),
      },
    },
  };

  const serverOptions: ServerOptions = { run, debug: run };
  const openSync = createOpenSync(DOCUMENT_SELECTOR);

  const clientOptions: LanguageClientOptions = {
    documentSelector: DOCUMENT_SELECTOR,
    // Never auto-reveal / steal focus to the Output panel when the server logs an
    // error. vscode-languageclient defaults this to RevealOutputChannelOn.Error,
    // which yanks the user's focus on every server-side diagnostic — intrusive UX,
    // and in the e2e suite it stole window.activeTextEditor mid-test (folding /
    // scaffolding / copy-name focus-race flakiness). Users open logs explicitly
    // via the Show Output / Show Trace commands.
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    // Strip ANSI escape codes from the server's raw stderr before it reaches
    // the user-facing Output panel (issue #78). The host gates ANSI on whether
    // stderr is a TTY, but this is defence-in-depth against any leaked codes.
    outputChannel: createAnsiStrippingChannel(log.output()),
    // The host writes every tracing level to stderr (stdout is the protocol),
    // and the client's default handler tags each stderr line `error`. Read the
    // level off the line instead, so the channel's level column means
    // something ([DIST-CLEAN-OUTPUT]).
    stdioOptions: serverStdioOptions(),
    traceOutputChannel: log.trace(),
    errorHandler: makeErrorHandler(statusBar),
    // After every (re)start a request waits for its document's didOpen, so it
    // never reaches a fresh server ahead of the document it is about.
    middleware: openSync.middleware,
  };

  const client = new LanguageClient(EXTENSION_ID, EXTENSION_NAME, serverOptions, clientOptions);

  wireClientState(client, statusBar, openSync, context);

  statusBar.setState(ServerState.Starting);
  await client.start();
  return client;
}

function sidecarEnv(deploymentPaths: DeploymentPaths, dotnetPath?: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (deploymentPaths.csharpSidecarPath !== undefined) {
    env.SHARPLSP_CSHARP_SIDECAR_PATH = deploymentPaths.csharpSidecarPath;
  }
  if (deploymentPaths.fsharpSidecarPath !== undefined) {
    env.SHARPLSP_FSHARP_SIDECAR_PATH = deploymentPaths.fsharpSidecarPath;
  }
  if (dotnetPath !== undefined && dotnetPath !== '') {
    Object.assign(env, dotnetHostEnvironment(dotnetPath));
  }
  return env;
}

/** Wire client state changes to the status bar indicator and the request hold. */
function wireClientState(
  client: LanguageClient,
  statusBar: SharpLspStatusBar,
  openSync: OpenSync,
  context: ExtensionContext,
): void {
  const listener: Disposable = client.onDidChangeState((event) => {
    openSync.observe(event.newState);
    state.serverRunning.value = event.newState === State.Running;
    switch (event.newState) {
      case State.Starting:
        statusBar.setState(ServerState.Starting);
        break;
      case State.Running:
        statusBar.setState(ServerState.Running);
        log.info('Server is running.');
        break;
      case State.Stopped:
        statusBar.setState(ServerState.Stopped);
        log.info('Server stopped.');
        break;
      // vscode-languageclient 10 added this state: the server never reached
      // Running because `start()` itself failed. Reporting it as Stopped would
      // render a failure as the clean shutdown the user asked for, and leave
      // the one indicator they have showing a dimmed circle. Error is the state
      // whose tooltip offers the click-to-restart that recovers it.
      case State.StartFailed:
        statusBar.setState(ServerState.Error);
        log.error('Server failed to start.');
        break;
    }
  });
  context.subscriptions.push(listener);
}

/**
 * Custom error handler that restarts sharplsp with exponential backoff.
 *
 * The default vscode-languageclient handler shows an error notification
 * on every unexpected close, including the transient kills that happen
 * when VS Code restarts the extension host or when a dev workflow
 * replaces the binary on disk. This handler:
 *
 *   - Suppresses the modal error dialog on close (uses `handled: true`)
 *   - Allows up to MAX_RESTARTS automatic restarts
 *   - After MAX_RESTARTS, stops and shows one actionable message
 *   - Never lets a connection ERROR end the session while restarts remain,
 *     because `ErrorAction.Shutdown` is the one decision `closed()` can never
 *     recover from
 */
function makeErrorHandler(statusBar: SharpLspStatusBar): {
  error(error: Error, message: Message | undefined, count: number | undefined): ErrorHandlerResult;
  closed(): CloseHandlerResult;
} {
  const MAX_RESTARTS = 5;
  // Two crashes further apart than this are unrelated, not a loop. Without it
  // the budget is a lifetime allowance: a server that dies once every couple of
  // hours exhausts it in a working day and then never restarts again.
  const CRASH_WINDOW_MS = 3 * 60 * 1_000;
  let restartCount = 0;
  let lastClosedAt = 0;

  return {
    error(
      _error: Error,
      _message: Message | undefined,
      count: number | undefined,
    ): ErrorHandlerResult {
      if ((count ?? 0) <= 3) {
        return { action: ErrorAction.Continue };
      }
      // `Shutdown` stops the client outright, and a stopped client never calls
      // `closed()` — so escalating here would forfeit every restart below. A
      // dead transport closes on its own; recovery belongs to `closed()`.
      if (restartCount < MAX_RESTARTS) {
        return { action: ErrorAction.Continue };
      }
      return { action: ErrorAction.Shutdown };
    },

    closed(): CloseHandlerResult {
      const now = Date.now();
      if (now - lastClosedAt > CRASH_WINDOW_MS) {
        restartCount = 0;
      }
      lastClosedAt = now;
      restartCount += 1;
      if (restartCount <= MAX_RESTARTS) {
        log.info(
          `sharplsp closed unexpectedly (restart ${String(restartCount)}/${String(MAX_RESTARTS)})`,
        );
        return { action: CloseAction.Restart, handled: true };
      }
      log.error(`sharplsp closed ${String(MAX_RESTARTS)} times — giving up`);
      statusBar.setState(ServerState.Error);
      void window
        .showErrorMessage(
          'SharpLsp: language server failed to start after multiple attempts. Check the SharpLsp output channel for details.',
          'Show Output',
        )
        .then((choice) => {
          if (choice === 'Show Output') {
            log.output().show();
          }
        });
      restartCount = 0;
      return { action: CloseAction.DoNotRestart, handled: true };
    },
  };
}

/**
 * Resolve the sharplsp binary path.
 *
 * Priority:
 *   1. User-configured `sharplsp.lspPath`
 *   2. `SHARPLSP_EXECUTABLE_PATH` for test and development runs
 *   3. Bundled binary in `<extension>/bin/<platform>/`
 *   4. Bundled binary in `<extension>/bin/`
 *   5. Binary name on `$PATH` (client resolves via shell)
 */
function resolveServerPath(context: ExtensionContext): string | undefined {
  const configured = expandPath(config.serverPath());
  if (configured !== '' && fs.existsSync(configured)) {
    return configured;
  }

  const envPath = process.env.SHARPLSP_EXECUTABLE_PATH;
  if (envPath !== undefined && envPath !== '' && fs.existsSync(envPath)) {
    return envPath;
  }

  const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;
  const platform = detectRuntimePlatform();

  const bundled = joinPath(context.extensionPath, 'bin', platform, binaryName);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const bundledBinary = joinPath(context.extensionPath, 'bin', binaryName);
  if (fs.existsSync(bundledBinary)) {
    return bundledBinary;
  }

  // Dev fallback: look for a Cargo debug build three levels above the extension dir.
  // Extension lives at <repo>/src/editors/vscode, so ../../../target/debug/<binary> is the repo build.
  const devBuild = joinPath(context.extensionPath, '..', '..', '..', 'target', 'debug', binaryName);
  if (fs.existsSync(devBuild)) {
    return devBuild;
  }

  // Fall back to PATH — the language client resolves the command via the shell.
  return binaryName;
}

/** Expand ${workspaceFolder} in a user-configured path. */
function expandPath(raw: string): string {
  if (!raw.includes('${workspaceFolder}')) return raw;
  const folder = workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return raw.replace('${workspaceFolder}', folder);
}

/** How long a graceful `shutdown` may take before the restart respawns anyway. */
const RESTART_STOP_TIMEOUT_MS = 10_000;

/**
 * Restart the server on the user's behalf. Implements [DIST-FAILURE-UX] rule 6.
 *
 * `LanguageClient.restart()` is `stop()` then `start()`, and the library's
 * `stop()` gives `shutdown` two seconds before it throws WITHOUT starting
 * anything - which turns the recovery command into a way to kill the client.
 * A hung server is the very reason a user reaches for Restart, so the stop
 * gets a real budget and the start happens whether or not the old process
 * bowed out in time.
 */
export async function restart(lspClient: LanguageClient): Promise<void> {
  try {
    await lspClient.stop(RESTART_STOP_TIMEOUT_MS);
  } catch (err: unknown) {
    log.warn(`Graceful stop failed; starting a fresh server anyway: ${getErrorMessage(err)}`);
  }
  await lspClient.start();
}
