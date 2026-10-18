// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. The helpers Basilisk's profiler
// suites import (via lspkit's UI package suites), bound to SharpLsp's live
// extension so those suites run here unchanged.
//
// The dev build leaves node_modules external, so the suites and the running
// extension share one copy of @nimblesite/lsp-profiler-ui. `createProfilerStore`
// installs its host's identity and logger process-wide, so a detached host is
// SharpLsp's own with only the client and debuggee map swapped.
import { signal, type ReadonlySignal, type Signal } from '@preact/signals-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { LaunchMetric, ProfilerHost, ProfilerStore } from '@nimblesite/lsp-profiler-ui';
import type { ProcessInfo } from '@nimblesite/lsp-profiler-ui/out/src/process-explorer-rows';
import type { ProcessInfo as WireProcess } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import { delay } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';
import type { ProfileResult } from '@nimblesite/lsp-profiler-ui/out/src/profiler-decorations';
import type { MemoryDashboardSnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import type {
  MemoryDiffResult,
  MemorySnapshotResult,
  SuspectedLeak,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-decorations';
import { numberField, rawField } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';
import * as assert from 'node:assert/strict';
import { errorMessage } from './profiler-ui-caught-error';
import { lspClient, profilerStore } from './profiler-kit';
import {
  closeAllEditors as closeEditors,
  removeDirRecursive,
  setupLspTestSuite as setupSharpLspSuite,
} from './test-helpers';

export { EXTENSION_ID } from './test-helpers';
export { POLL_INTERVAL_MS, WAIT_MS } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';

const DEFAULT_POLL_INTERVAL_MS = 100;

/** Write to a signal a consumer only reads (test seams). */
export function seedSignal<T>(target: ReadonlySignal<T>, value: T): void {
  (target as Signal<T>).value = value;
}

/** A language client stand-in exposing only `members`. */
export function fakeLanguageClient(members: Record<string, unknown>): LanguageClient {
  return members as unknown as LanguageClient;
}

/** The live store. */
export function getStore(): ProfilerStore {
  return profilerStore();
}

/** The `workspace/executeCommand` names the server advertised at initialize. */
export function advertisedServerCommands(): ReadonlySet<string> {
  return new Set(lspClient().initializeResult?.capabilities.executeCommandProvider?.commands ?? []);
}

/** The wire form of a UI process, for test doubles that stand in for the server. */
export function toWireProcess(process: ProcessInfo): WireProcess {
  return {
    pid: process.pid,
    ppid: process.ppid,
    name: process.name,
    runtime: process.runtime,
    ...(process.runtimeVersion === null ? {} : { runtime_version: process.runtimeVersion }),
    ...(process.interpreterPath === null ? {} : { executable: process.interpreterPath }),
    ...(process.script === null ? {} : { entry: process.script }),
    cpu_percent: process.cpuPercent,
    memory_bytes: process.memoryBytes,
    runtime_secs: process.runtimeSecs,
    ...(process.user === null ? {} : { user: process.user }),
    requires_elevation: process.requiresElevation,
    in_workspace: process.inWorkspace,
    ...(process.launcher === null ? {} : { launcher: process.launcher }),
    attachable: process.debuggable,
    ...(process.undebuggableReason === null
      ? {}
      : { unattachable_reason: process.undebuggableReason }),
  };
}

/**
 * Turn the Processes panel's grouping off. It opens grouped by runtime version
 * ([PROF-UI-PROCESSES]); tests of row order, filtering and row shape read a flat list.
 */
export function ungroup(store: ProfilerStore): void {
  while (store.processes.value.groupMode !== 'none') {
    store.cycleProcessGroup();
  }
}

/** The launch configuration SharpLsp's host builds for `metric`; asserts it exists. */
export function launchConfigOf(metric: LaunchMetric, program: string): vscode.DebugConfiguration {
  const config = profilerStore().host.launchConfig(metric, program);
  if (config === undefined) {
    throw new Error(`SharpLsp builds no ${metric} launch configuration`);
  }
  return config;
}

/** A detached copy of SharpLsp's host: no client, no debuggee. */
export function fakeHost(overrides: Partial<ProfilerHost> = {}): ProfilerHost {
  return {
    ...profilerStore().host,
    client: signal<LanguageClient | undefined>(undefined),
    sessionIdToPid: signal<ReadonlyMap<string, number>>(new Map()),
    ...overrides,
  };
}

export interface PollOptions<T> {
  readonly fn: () => Promise<T> | T;
  readonly until: (value: T) => boolean;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly description?: string;
}

/** Poll until `until` accepts the value; the two-argument form uses a 10s budget. */
export async function pollUntilResult<T>(options: PollOptions<T>): Promise<T>;
export async function pollUntilResult<T>(
  fn: () => Promise<T> | T,
  until: (value: T) => boolean,
): Promise<T>;
export async function pollUntilResult<T>(
  first: PollOptions<T> | (() => Promise<T> | T),
  until?: (value: T) => boolean,
): Promise<T> {
  const options: PollOptions<T> =
    typeof first === 'function'
      ? { fn: first, until: until ?? (() => true), timeoutMs: 10_000 }
      : first;
  const deadline = Date.now() + options.timeoutMs;
  let last: T = await options.fn();
  while (!options.until(last)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${options.description ?? 'condition'} not met within ${options.timeoutMs}ms (last: ${JSON.stringify(last)})`,
      );
    }
    await delay(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    last = await options.fn();
  }
  return last;
}

export async function closeAllEditors(): Promise<void> {
  await closeEditors();
}

/** A temp dir plus a C# source file, once the real server is running. */
export async function setupLspTestSuite(
  tmpDirPrefix: string,
): Promise<{ tmpDir: string; hotFile: string }> {
  const { tmpDir } = await setupSharpLspSuite(tmpDirPrefix);
  const hotFile = path.join(tmpDir, 'Hot.cs');
  fs.writeFileSync(
    hotFile,
    'static class Hot\n{\n    static int Main()\n    {\n        var total = 0;\n        return total;\n    }\n}\n',
  );
  await closeAllEditors();
  return { tmpDir, hotFile };
}

export function removeTestDir(dir: string): void {
  if (dir === '' || !fs.existsSync(dir)) {
    return;
  }
  removeDirRecursive(dir);
}

export function teardownLspTestSuite(tmpDir: string): void {
  removeTestDir(tmpDir);
}

/** Write `content` to `filename` under `tmpDir` and open it in an editor. */
export async function openSourceFile(
  tmpDir: string,
  filename: string,
  content: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  return { doc, uri };
}

/**
 * The hooks every ported suite shares: the real server running, a scratch dir,
 * `cleanup` and a closed editor after each test. Returns the scratch dir.
 */
export function useLspSuite(prefix: string, cleanup: () => void = () => undefined): () => string {
  let tmpDir = '';
  suiteSetup(async function () {
    this.timeout(90_000);
    ({ tmpDir } = await setupLspTestSuite(prefix));
  });
  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });
  teardown(async () => {
    cleanup();
    await closeAllEditors();
  });
  return () => tmpDir;
}

/**
 * Run `command`: a profiler protocol command over `workspace/executeCommand`,
 * exactly as the UI library calls it; any other through VS Code.
 */
export async function runCommand(command: string, ...args: unknown[]): Promise<unknown> {
  if (command.startsWith('sharplsp.lspProfiler.')) {
    return lspClient().sendRequest('workspace/executeCommand', { command, arguments: args });
  }
  return vscode.commands.executeCommand(command, ...args);
}

/** The message `command` rejects with; fails the test when it resolves. */
export async function rejectionOf(command: string, ...args: unknown[]): Promise<string> {
  try {
    await runCommand(command, ...args);
  } catch (error: unknown) {
    return errorMessage(error);
  }
  assert.fail(`${command} ${JSON.stringify(args)} must be rejected`);
}

/** Assert `message` names at least one of `needles`. */
export function assertMentions(message: string, needles: readonly string[], what: string): void {
  assert.ok(
    needles.some((needle) => message.includes(needle)),
    `${what}: expected one of ${JSON.stringify(needles)}, got: ${message}`,
  );
}

/** The `sessions` array of a `cpu.list` reply; fails with `message` when absent. */
export function sessionsOf(result: unknown, message: string): unknown[] {
  const sessions = rawField(result, 'sessions');
  assert.ok(Array.isArray(sessions), message);
  return sessions as unknown[];
}

/** True when `commandId` is registered: registering it again throws. */
export function isRegistered(commandId: string): boolean {
  try {
    vscode.commands.registerCommand(commandId, () => undefined).dispose();
    return false;
  } catch {
    return true;
  }
}

/** The notifications shown while a body ran, by severity, with the actions each offered. */
export interface Toasts {
  readonly info: { message: string; actions: string[] }[];
  readonly warning: string[];
  readonly error: string[];
}

type ToastWindow = Record<
  'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage',
  unknown
>;

/** Swap every notification for a recorder while `body` runs. */
export async function captureToasts(body: () => PromiseLike<unknown>): Promise<Toasts> {
  const toasts: Toasts = { info: [], warning: [], error: [] };
  const window = vscode.window as unknown as ToastWindow;
  const original: ToastWindow = {
    showInformationMessage: window.showInformationMessage,
    showWarningMessage: window.showWarningMessage,
    showErrorMessage: window.showErrorMessage,
  };
  window.showInformationMessage = async (message: string, ...items: unknown[]) => {
    toasts.info.push({ message, actions: items.filter((i): i is string => typeof i === 'string') });
    return undefined;
  };
  window.showWarningMessage = async (message: string) => void toasts.warning.push(message);
  window.showErrorMessage = async (message: string) => void toasts.error.push(message);
  try {
    await body();
  } finally {
    Object.assign(window, original);
  }
  return toasts;
}

/** Swap `showWarningMessage` for a recorder while `body` runs. */
export async function captureWarnings(body: () => Promise<unknown>): Promise<string[]> {
  return (await captureToasts(body)).warning;
}

/** A C# source with twelve numbered lines, for decorations to land on. */
export const DECORATED_SOURCE = Array.from(
  { length: 12 },
  (_, index) => `// line ${index + 1}`,
).join('\n');

/** A CPU result, overriding the fields a test cares about. */
export function profileResult(overrides: Partial<ProfileResult> = {}): ProfileResult {
  return {
    sessionId: 's-1',
    duration: 2.5,
    totalSamples: 250,
    outputFile: '/tmp/profile.speedscope.json',
    hotFunctions: [],
    hotLines: [],
    ...overrides,
  };
}

/** A memory snapshot result, overriding the fields a test cares about. */
export function memorySnapshot(
  overrides: Partial<MemorySnapshotResult> = {},
): MemorySnapshotResult {
  return {
    memorySessionId: 'mem-1',
    snapshotId: 'snap-1',
    currentMemory: 1_048_576,
    peakMemory: 2_097_152,
    topAllocations: [],
    ...overrides,
  };
}

/** A suspected leak on `file:line`, overriding the fields a test cares about. */
export function suspectedLeak(
  file: string,
  line: number,
  overrides: Partial<SuspectedLeak> = {},
): SuspectedLeak {
  return {
    file,
    line,
    sizeGrowth: 2_097_152,
    countGrowth: 300,
    currentSize: 8_388_608,
    confidence: 'HIGH',
    reason: 'Monotonic growth pattern',
    ...overrides,
  };
}

/** A memory diff carrying `leaks`. */
export function memoryDiff(
  leaks: SuspectedLeak[],
  overrides: Partial<MemoryDiffResult> = {},
): MemoryDiffResult {
  return {
    totalGrowth: 5_242_880,
    totalFreed: 524_288,
    netGrowth: 4_718_592,
    suspectedLeaks: leaks,
    ...overrides,
  };
}

/** Assert `html` contains every key (or, with `present` false, none), failing with its reason. */
export function assertHtml(html: string, checks: Record<string, string>, present = true): void {
  for (const [needle, why] of Object.entries(checks)) {
    assert.equal(html.includes(needle), present, why);
  }
}

/** Assert a webview declares a CSP, nonce-gates its script, and kept hostile data inert. */
export function assertHardened(html: string, what: string): void {
  assert.ok(html.includes('Content-Security-Policy'), `${what} must declare a CSP`);
  assert.ok(
    /script-src 'nonce-[^']+'/.test(html),
    `${what}: the inline script must be nonce-gated`,
  );
  assert.ok(!html.includes('</script><img'), `${what}: untrusted data must not close the <script>`);
}

// ── Process-row fixtures ([PROF-UI-PROCESSES]) ─────────────────────

const MB = 1024 * 1024;

/**
 * A debuggable process row; each caller overrides what it exercises. The
 * one fixture every Processes-panel test builds its table from.
 */
export function processFixture(pid: number, overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid,
    ppid: 1,
    name: 'python3.12',
    interpreterPath: '/usr/bin/python3.12',
    script: null,
    runtime: 'python',
    runtimeVersion: '3.12.1',
    cpuPercent: 0,
    memoryBytes: MB,
    runtimeSecs: 1,
    user: null,
    requiresElevation: false,
    inWorkspace: false,
    launcher: null,
    debuggable: true,
    undebuggableReason: null,
    ...overrides,
  };
}

/** Read the PID a process row carries (the arg passed to inline commands). */
export function rowPid(item: vscode.TreeItem): number | undefined {
  // `process` is attached to the row by the provider under test, not by
  // `vscode.TreeItem`, so it is read back by name rather than asserted on.
  return numberField(rawField(item, 'process'), 'pid');
}

/** The row of `pid`, failing the test when the panel dropped it. */
export function rowByPid(
  rows: readonly vscode.TreeItem[],
  pid: number,
  what: string,
): vscode.TreeItem {
  const row = rows.find((item) => rowPid(item) === pid);
  assert.ok(row !== undefined, `${what}: the PID ${pid} row must exist`);
  return row;
}

// ── Decoration ledgers ─────────────────────────────────────────────

/** What one applied decoration must show: its line, a colour, text it carries. */
export interface PaintedExpectation {
  readonly line?: number;
  readonly color?: string;
  /** A substring the decoration's after-line text must include. */
  readonly includes?: string;
}

/** Assert a decoration was applied and shows exactly what `expect` names. */
export function assertPainted(
  painted: { line: number; color: string; contentText: string } | undefined,
  expect: PaintedExpectation,
  what: string,
): void {
  assert.ok(painted !== undefined, `${what}: a decoration must be applied`);
  if (expect.line !== undefined) {
    assert.equal(painted.line, expect.line, `${what}: it lands on its line`);
  }
  if (expect.color !== undefined) {
    assert.equal(painted.color, expect.color, `${what}: it wears its colour`);
  }
  if (expect.includes !== undefined) {
    assert.ok(painted.contentText.includes(expect.includes), painted.contentText);
  }
}

// ── Dashboard snapshots ────────────────────────────────────────────

/** A minimal dashboard snapshot (fresh session: one capture, no diff yet). */
export function dashboardSnapshot(
  overrides: Partial<MemoryDashboardSnapshot> = {},
): MemoryDashboardSnapshot {
  return {
    memorySessionId: 'mem-1',
    snapshotId: 'snap-1',
    currentMemory: 1_048_576,
    peakMemory: 2_097_152,
    gcObjects: 1200,
    gcCounts: [700, 12, 3],
    topAllocations: [{ file: '/app/Program.cs', line: 10, size: 4096, count: 8 }],
    timeline: [],
    heapProfilePath: '',
    ...overrides,
  };
}
