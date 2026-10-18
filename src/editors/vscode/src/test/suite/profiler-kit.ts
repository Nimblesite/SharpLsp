// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. Shared seams of the profiler
// suites: the library's store through the extension API, the .NET fixture
// targets, and the wire commands the extension drives.
import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  profilerStatusText,
  type ProcessesProvider,
  type ProfilerStore,
} from '@nimblesite/lsp-profiler-ui';
import type { MemoryStep, RefGraph } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  closeAllEditors,
  EXTENSION_ID,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { ACTIVATION_MS, PROCESS_START_MS } from './test-timeouts';

/** The profiler's commands as the server advertises them. */
export function lspCommand(name: string): string {
  return `sharplsp.lspProfiler.${name}`;
}

/** The library's client-side commands under SharpLsp's prefix. */
export function uiCommand(name: string): string {
  return `sharplsp.profiler.${name}`;
}

interface ProfilerApi {
  profiler?: { ui: { store: ProfilerStore; processes: ProcessesProvider } };
  getLspClient?: () => LanguageClient | undefined;
}

/** The live profiler store published by the extension. */
export function profilerStore(): ProfilerStore {
  const api = vscode.extensions.getExtension<ProfilerApi>(EXTENSION_ID)?.exports;
  const store = api?.profiler?.ui.store;
  assert.ok(store, 'the extension must publish the profiler store');
  return store;
}

/** The processes tree's data provider: the rows the panel renders. */
export function processesProvider(): ProcessesProvider {
  const provider =
    vscode.extensions.getExtension<ProfilerApi>(EXTENSION_ID)?.exports?.profiler?.ui.processes;
  assert.ok(provider, 'the extension must publish the processes provider');
  return provider;
}

/** The top-level rows of the processes panel as it renders them now. */
export function panelRows(): vscode.TreeItem[] {
  return processesProvider().getChildren();
}

/** The panel row of `pid`, searching inside group headers too. */
export function rowOf(pid: number): vscode.TreeItem | undefined {
  const provider = processesProvider();
  const rows = provider
    .getChildren()
    .flatMap((item) =>
      item.contextValue === 'processGroup' ? provider.getChildren(item) : [item],
    );
  return rows.find((item) => item.id === `process:${pid}`);
}

/** A row's tooltip as plain text. */
export function tooltipText(item: vscode.TreeItem): string {
  const tip = item.tooltip;
  return typeof tip === 'string' ? tip : (tip?.value ?? '');
}

/** The running language client. */
export function lspClient(): LanguageClient {
  const client = vscode.extensions
    .getExtension<ProfilerApi>(EXTENSION_ID)
    ?.exports?.getLspClient?.();
  if (!client?.isRunning()) {
    throw new Error('the language client must be running');
  }
  return client;
}

/** Run one profiler operation over the wire exactly as the library does. */
export async function execute<T>(name: string, params: Record<string, unknown>): Promise<T> {
  return lspClient().sendRequest<T>('workspace/executeCommand', {
    command: lspCommand(name),
    arguments: [params],
  });
}

/** The error a wire call rejects with, or `undefined` when it succeeded. */
export async function executeError(
  name: string,
  params: Record<string, unknown>,
): Promise<{ code: number; message: string } | undefined> {
  try {
    await execute(name, params);
    return undefined;
  } catch (error: unknown) {
    const failure = error as { code?: unknown; message?: unknown };
    return {
      code: typeof failure.code === 'number' ? failure.code : 0,
      message: String(failure.message ?? error),
    };
  }
}

const FIXTURES = path.resolve(__dirname, '../../../../../sharplsp/tests/fixtures');
/** lspkit's own targets, which prove the engine on every .NET language. */
const LSPKIT_FIXTURES = path.resolve(__dirname, '../../../../../../lspkit/dotnet/fixtures');

/** A profiling target: its project folder, target framework and source file. */
interface FixtureProject {
  readonly dir: string;
  readonly framework: string;
  readonly source: string;
}

const FIXTURE_PROJECTS: Readonly<Record<string, FixtureProject>> = {
  ProfileTarget: { dir: FIXTURES, framework: 'net10.0', source: 'Program.cs' },
  ProfileLeakTarget: { dir: FIXTURES, framework: 'net10.0', source: 'Program.cs' },
  // F#: records holding union cases leak into a module value ([PROF-TESTING]).
  HotLeakAppFs: { dir: LSPKIT_FIXTURES, framework: 'net8.0', source: 'Program.fs' },
};

function fixtureProject(name: string): FixtureProject {
  const project = FIXTURE_PROJECTS[name];
  assert.ok(project, `unknown profiling fixture ${name}`);
  return project;
}

/** `dotnet` from PATH, else the user-local install the test host's PATH may lack. */
function dotnetExecutable(): string {
  const candidates = [
    'dotnet',
    path.join(os.homedir(), '.dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'),
  ];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate;
  }
  throw new Error('dotnet SDK not found: install it or put it on PATH');
}

/** Build a fixture project once (Release) and return its binary. */
export function buildFixture(name: string): string {
  const { dir, framework } = fixtureProject(name);
  const project = path.join(dir, name);
  const binary = path.join(
    project,
    'bin',
    'Release',
    framework,
    process.platform === 'win32' ? `${name}.exe` : name,
  );
  if (!fs.existsSync(binary)) {
    const build = spawnSync(dotnetExecutable(), ['build', '-c', 'Release', '--nologo', '-v', 'q'], {
      cwd: project,
      encoding: 'utf8',
    });
    assert.equal(
      build.status,
      0,
      `building ${name} failed: ${build.stderr ?? build.error?.message}`,
    );
  }
  assert.ok(fs.existsSync(binary), `${binary} missing after build`);
  return binary;
}

/** The source file of a fixture, where hot lines and allocation sites land. */
export function fixtureSource(name: string): string {
  const { dir, source } = fixtureProject(name);
  return path.join(dir, name, source);
}

/** A running fixture; `stop()` closes its stdin so it exits, then kills it. */
export class Target {
  private constructor(
    private readonly child: ChildProcess,
    readonly pid: number,
  ) {}

  static async start(name: string): Promise<Target> {
    const child = spawn(buildFixture(name), [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, SHARPLSP_PROFILE_TARGET_PARENT_PID: String(process.pid) },
    });
    const ready = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) resolve(buffer.split('\n')[0] ?? '');
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        reject(new Error(`${name} exited early with ${code}`));
      });
    });
    assert.ok(ready.startsWith('READY'), `${name} must print READY: ${ready}`);
    assert.ok(child.pid !== undefined, 'spawned pid');
    // Let the runtime open its diagnostics endpoint before anyone attaches.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return new Target(child, child.pid);
  }

  stop(): void {
    this.child.stdin?.end();
    this.child.kill();
  }
}

/** What a suite adds around the shared lifecycle; each runs inside its hook. */
export interface ProfilingSuiteHooks {
  /** After the target starts. */
  readonly started?: () => PromiseLike<unknown>;
  /** Before the target stops: end a session a failed test left running. */
  readonly stopping?: () => PromiseLike<unknown>;
  /** After the target stops: restore what the suite changed. */
  readonly stopped?: () => PromiseLike<unknown>;
}

/** The running fixture of the suite that registered it. */
export interface ProfilingSuite {
  /** The target; asserts it started. */
  readonly target: Target;
}

/**
 * Register the lifecycle every profiler suite shares: activate the extension in a
 * scratch directory and start `fixture`; afterwards stop it, close every editor
 * and remove the directory.
 */
export function profilingSuite(
  prefix: string,
  fixture: string,
  hooks: ProfilingSuiteHooks = {},
): ProfilingSuite {
  let tmpDir = '';
  let running: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS);
    ({ tmpDir } = await setupLspTestSuite(prefix));
    running = await Target.start(fixture);
    await hooks.started?.();
  });
  suiteTeardown(async () => {
    await hooks.stopping?.();
    running?.stop();
    await hooks.stopped?.();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });
  return {
    get target() {
      assert.ok(running, `${fixture} must be running`);
      return running;
    },
  };
}

/** Open `file` so decorations have an editor to land on. */
export async function openSource(file: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(file);
  return vscode.window.showTextDocument(document, { preview: false });
}

/** Poll until `until` accepts `read()`'s value. */
export async function waitFor<T>(
  read: () => T,
  until: (value: T) => boolean,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (!until(last)) {
    assert.ok(
      Date.now() < deadline,
      `${what} not reached within ${timeoutMs}ms (last: ${JSON.stringify(last)})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = read();
  }
  return last;
}

/** The result of a step direct mode completes; fails on a courier `Evaluate` step. */
export function completed(step: MemoryStep): Extract<MemoryStep, { kind: 'Completed' }>['result'] {
  if (step.kind !== 'Completed') {
    throw new Error(`direct mode completes every step: ${JSON.stringify(step)}`);
  }
  return step.result;
}

/** The suspected leaks the dashboard embedded for its script (`const leaks = [...]`). */
export function embeddedLeaks(html: string): { typeName?: string }[] {
  const marker = 'const leaks = ';
  const at = html.indexOf(marker);
  if (at < 0) return [];
  const end = html.indexOf(';\n', at);
  try {
    return JSON.parse(html.slice(at + marker.length, end)) as { typeName?: string }[];
  } catch {
    return [];
  }
}

/** Profile `pid` from its processes-panel row; resolves once the session records. */
export async function profileFromRow(pid: number): Promise<void> {
  await vscode.commands.executeCommand(uiCommand('profileProcess'), {
    process: { pid, debuggable: true, runtime: 'dotnet' },
  });
  await waitFor(
    () => profilerStore().profiler.value.cpu,
    (cpu) => cpu === 'active',
    PROCESS_START_MS,
    'CPU session active',
  );
}

/** Run a stop command; resolves once `state` reads idle. */
async function stopAndWait(command: string, state: () => string, timeoutMs: number): Promise<void> {
  await vscode.commands.executeCommand(uiCommand(command));
  await waitFor(state, (value) => value === 'idle', timeoutMs, `${command} reached idle`);
}

/** Stop CPU profiling through the real command; resolves once the session is idle. */
export function stopProfiling(timeoutMs: number): Promise<void> {
  return stopAndWait('profileStop', () => profilerStore().profiler.value.cpu, timeoutMs);
}

/** Stop memory tracking through the real command; resolves once tracking is idle. */
export function stopTracking(): Promise<void> {
  return stopAndWait('memoryStop', () => profilerStore().profiler.value.memory, PROCESS_START_MS);
}

/**
 * Profile `pid` from its panel row for `sampleMs`: the live session profiles it
 * and shows in the status bar. Then stop it through the real command.
 */
export async function profileFromRowFor(
  pid: number,
  sampleMs: number,
  stopMs: number,
): Promise<void> {
  await profileFromRow(pid);
  assert.equal(profilerStore().profiler.value.cpuPid, pid, 'the session profiles the target');
  assert.ok(
    profilerStatusText()?.includes('Profiling'),
    `status bar shows the live session: ${profilerStatusText()}`,
  );
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  await stopProfiling(stopMs);
}

/** A wire memory session on `pid`, its first snapshot taken. */
export async function snapshotSession(pid: number): Promise<{ memory_session_id: string }> {
  const started = await execute<{ memory_session_id: string }>('memory.start', { pid });
  const session = { memory_session_id: started.memory_session_id };
  completed(await execute<MemoryStep>('memory.snapshot', session));
  return session;
}

/** The retention graph of `typeName` in the session's latest snapshot; its instances are the targets. */
export async function retentionGraph(
  session: { memory_session_id: string },
  typeName: string,
  maxDepth = 6,
  limit = 40,
): Promise<RefGraph> {
  const refs = completed(
    await execute<MemoryStep>('memory.references', {
      ...session,
      type_name: typeName,
      limit,
      max_depth: maxDepth,
    }),
  );
  assert.equal(refs.outcome.kind, 'Refs', 'references answer with a graph');
  const { graph } = refs.outcome as { graph: RefGraph };
  assert.ok(
    graph.nodes.some((node) => node.is_target && node.type_name === typeName),
    `${typeName} instances are target nodes, got types: ${graph.nodes.map((n) => n.type_name).join(', ')}`,
  );
  return graph;
}

/** Start tracking `pid` through the real command; resolves once the store is tracking. */
export async function trackMemory(pid: number): Promise<void> {
  await vscode.commands.executeCommand(uiCommand('memoryStart'), pid);
  await waitFor(
    () => profilerStore().profiler.value.memory,
    (memory) => memory === 'active',
    30_000,
    'memory tracking active',
  );
}
