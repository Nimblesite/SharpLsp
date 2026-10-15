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
import type { ProcessesProvider, ProfilerStore } from '@nimblesite/lsp-profiler-ui';
import { EXTENSION_ID } from './test-helpers';

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
  const project = path.join(FIXTURES, name);
  const binary = path.join(
    project,
    'bin',
    'Release',
    'net10.0',
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
  return path.join(FIXTURES, name, 'Program.cs');
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
