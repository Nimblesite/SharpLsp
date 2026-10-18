// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// The F# profiler suites drive SharpLsp's two real-world F# programs
// (src/sharplsp/tests/fixtures/fsharp-profiling) through the extension's own UI
// over the real LSP. This kit owns what every F# suite shares:
//   - the fixtures' stdin protocol and the exact live counts they report;
//   - the exact source lines each F# shape lands on;
//   - the spec checks every suite repeats on what the editor shows: the live
//     chrome, the heat map, the results panel, the exported artifacts and the
//     memory track (lspkit's [PROF-UI-CPU], [PROF-UI-HEATMAP], [PROF-EXPORT],
//     [PROF-UI-MEMORY], [PROF-AGGREGATION-THRESHOLD]).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  appliedMemoryDecorations,
  appliedProfileDecorations,
  contextKeyValues,
  flamegraphPanelState,
  processesViewState,
  profilerStatusText,
  type ProcessTreeItem,
  type ProfileResult,
} from '@nimblesite/lsp-profiler-ui';
import type { AppliedDecoration } from '@nimblesite/lsp-profiler-ui/out/src/profiler-decorations';
import type { MemoryDashboardSnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import type {
  HeapDiff,
  MemoryStep,
  ProfileSessionList,
  SuspectedLeak,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  execute,
  fixtureFile,
  profilerStore,
  rowOf,
  stopProfiling,
  stopTracking,
  type Target,
  tooltipText,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { comparablePath } from './test-helpers';
import { LSP_RESPONSE_MS, PROCESS_START_MS } from './test-timeouts';

export const ENGINE = 'FsPricingEngine';
export const LEDGER = 'FsOrderLedger';

/** The CPU heat palette, critical to cool ([PROF-UI-WEBVIEW]: orange/amber for CPU). */
export const CPU_PALETTE = ['#e8500a', '#f97316', '#fbbf24', '#4a5468'];
/** The purple memory-allocation palette ([PROF-UI-WEBVIEW]: purple for memory). */
export const MEMORY_PALETTE = ['#c084fc', '#a78bfa', '#8b5cf6', '#7c3aed'];
/** The leak-confidence palette ([PROF-UI-WEBVIEW]: red for leaks). */
export const LEAK_PALETTE = ['#ef4444', '#f87171', '#fb923c', '#a78bfa'];
/** How long one profiler step may take: an attach, a stop with symbolization, a heap capture. */
export const STOP_MS = 90_000;
/** A leak badge names its confidence in its after-line text. */
const BADGE = /\b(LOW|MEDIUM|HIGH|DEFINITE)\b/;

// ── The fixtures' stdin protocol ─────────────────────────────────────────────

/** The exact live counts a fixture reports after every command. */
export type Counts = Readonly<Record<string, number>>;

/** Send `line`; assert the fixture accepted it; return the integer counts it reported. */
export async function command(target: Target, line: string): Promise<Counts> {
  const reply = await target.send(line);
  assert.ok(reply.startsWith(`OK ${line}`), `the fixture must accept "${line}": ${reply}`);
  const pairs = reply
    .split(' ')
    .filter((word) => word.includes('='))
    .map((word) => word.split('=') as [string, string])
    .filter(([, value]) => Number.isInteger(Number(value)));
  return Object.fromEntries(pairs.map(([key, value]) => [key, Number(value)]));
}

/** One count from a reply; fails when the fixture did not report it. */
export function count(counts: Counts, key: string): number {
  const value = counts[key];
  assert.ok(value !== undefined, `the reply carries ${key}: ${JSON.stringify(counts)}`);
  return value;
}

// ── Where each F# shape lands ────────────────────────────────────────────────

/** A 1-based line range inside one fixture file. */
export interface Span {
  readonly file: string;
  readonly first: number;
  readonly last: number;
}

/** True when `line` of `file` falls inside `span`. */
export function within(span: Span, file: string | undefined, line: number): boolean {
  return isFile(file, span.file) && line >= span.first && line <= span.last;
}

/** True when `file` is the fixture file named `name` (any fixture). */
export function isFile(file: string | undefined, name: string): boolean {
  return file !== undefined && path.basename(comparablePath(file)) === comparablePath(name);
}

/** The absolute path of a fixture file, as the editor and the server name it. */
export function sourceOf(fixture: string, file: string): string {
  return fixtureFile(fixture, file);
}

/** Open fixture files side by side, so decorations have editors to land on. */
export async function showSources(fixture: string, files: readonly string[]): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (const [index, file] of files.entries()) {
    const document = await vscode.workspace.openTextDocument(sourceOf(fixture, file));
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: index === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Beside,
    });
  }
  const visible = vscode.window.visibleTextEditors.map((e) => path.basename(e.document.fileName));
  for (const file of files) {
    assert.ok(visible.includes(file), `${file} is visible: ${visible.join(', ')}`);
  }
}

// ── The processes panel row of a live F# program ─────────────────────────────

/** Refresh the panel and return the real row the user would click for `pid`. */
export async function processRow(pid: number): Promise<ProcessTreeItem> {
  await vscode.commands.executeCommand(uiCommand('refreshProcesses'));
  const row = await waitFor(
    () => rowOf(pid),
    (item) => item !== undefined,
    LSP_RESPONSE_MS,
    `the processes panel row of PID ${pid}`,
  );
  assert.ok(row && 'process' in row, `PID ${pid} renders as a process row`);
  return row as ProcessTreeItem;
}

/** [PROF-UI-PROCESSES] + [PROF-UI-CAPABILITIES]: what an idle F# program's row shows. */
export function assertIdleRow(row: ProcessTreeItem, pid: number, name: string): void {
  assert.equal(row.id, `process:${pid}`, 'a stable row id');
  const tip = tooltipText(row);
  for (const needle of [`PID ${pid}`, '.NET: ', 'CPU: ', 'Memory: ', 'Runtime: ']) {
    assert.ok(tip.includes(needle), `the tooltip carries "${needle}": ${tip}`);
  }
  assert.equal(row.process.pid, pid);
  assert.equal(row.process.runtime, 'dotnet', 'an F# program is classified as .NET');
  assert.ok(row.process.name.includes(name), `the row names the program: ${row.process.name}`);
  assert.equal(row.process.debuggable, true, 'a live F# program is attachable');
  assert.ok(row.process.runtimeVersion, 'the runtime version is resolved');
  assert.equal(row.contextValue, 'processDebuggee', 'direct memory: Track Memory is offered');
  assert.equal(row.command, undefined, 'an assembly entry is never opened as source');
  assert.ok(
    !(row.iconPath instanceof vscode.ThemeIcon && row.iconPath.id === 'flame'),
    'an idle row does not flame',
  );
}

/** Profile CPU from the real row, exactly as its inline button does. */
export async function profileRow(row: ProcessTreeItem): Promise<string> {
  await vscode.commands.executeCommand(uiCommand('profileProcess'), row);
  await waitFor(
    () => profilerStore().profiler.value.cpu,
    (cpu) => cpu === 'active',
    PROCESS_START_MS,
    `CPU session on PID ${row.process.pid}`,
  );
  const id = profilerStore().profiler.value.cpuSessionId;
  assert.ok(id, 'a live session id');
  return id;
}

// ── Live chrome ([PROF-UI-STATE], [PROF-UI-PROCESSES]) ───────────────────────

/** The `sharplsp.profiler.*` gating keys the library last wrote. */
export function keys(): Record<string, unknown> {
  const values = contextKeyValues();
  const read = (name: string) => values.get(`sharplsp.profiler.${name}`);
  return {
    profiling: read('profiling'),
    cpuBusy: read('cpuBusy'),
    memoryTracking: read('memoryTracking'),
    memoryBusy: read('memoryBusy'),
    profilerBusy: read('profilerBusy'),
  };
}

/** Everything a live CPU session on `pid` paints, with no memory session running. */
export async function assertCpuLive(pid: number): Promise<void> {
  const session = profilerStore().profiler.value;
  assert.equal(session.cpuPid, pid, 'the session profiles the clicked program');
  assert.ok(profilerStatusText()?.includes('Profiling'), `status: ${profilerStatusText()}`);
  assert.deepEqual(
    { profiling: keys().profiling, cpuBusy: keys().cpuBusy, profilerBusy: keys().profilerBusy },
    { profiling: true, cpuBusy: true, profilerBusy: true },
    'the CPU gating keys follow the session',
  );
  assert.equal(processesViewState().badge, 1, 'a badge while busy');
  assert.ok(
    processesViewState().message?.startsWith(`🔥 Profiling PID ${pid}`) === true,
    `the panel message names the PID: ${processesViewState().message}`,
  );
  const row = await waitFor(
    () => rowOf(pid),
    (item) => item?.contextValue === 'processProfiling',
    LSP_RESPONSE_MS,
    'the profiled row to swap to its Stop action',
  );
  assert.ok(
    row?.iconPath instanceof vscode.ThemeIcon && row.iconPath.id === 'flame',
    'the profiled row flames',
  );
}

/** Wait for live progress: elapsed time, a sample count and a top function. */
export async function awaitLiveProgress(): Promise<string> {
  const store = profilerStore();
  const live = await waitFor(
    () => store.profiler.value,
    (s) => s.durationSecs >= 1 && s.sampleCount > 0 && (s.topFunction ?? '').length > 0,
    LSP_RESPONSE_MS * 2,
    'live progress: elapsed time, samples and a top function',
  );
  await waitFor(
    () => profilerStatusText() ?? '',
    (text) => /[1-9][\d.]* ?K? samples/.test(text),
    LSP_RESPONSE_MS,
    'the live sample count in the status bar',
  );
  return live.topFunction ?? '';
}

/** Nothing is profiling CPU: store, status bar, keys and the row agree. */
export async function assertCpuIdle(pid: number): Promise<void> {
  assert.equal(profilerStore().profiler.value.cpu, 'idle');
  assert.equal(profilerStore().profiler.value.cpuSessionId, undefined, 'no stale session id');
  assert.equal(profilerStatusText(), undefined, 'the CPU status bar hides');
  assert.equal(keys().profiling, false);
  assert.equal(keys().cpuBusy, false);
  const row = await waitFor(
    () => rowOf(pid),
    (item) => item !== undefined && item.contextValue !== 'processProfiling',
    LSP_RESPONSE_MS,
    'the row to drop its profiling marker',
  );
  assert.equal(row?.contextValue, 'processDebuggee');
}

// ── The CPU result as the editor shows it ────────────────────────────────────

/** The heat tier a share paints with; `undefined` near a tier boundary. */
export function cpuTier(percentage: number): string | undefined {
  const tiers: readonly [number, string][] = [
    [20, '#e8500a'],
    [10, '#f97316'],
    [5, '#fbbf24'],
    [0, '#4a5468'],
  ];
  if ([20, 10, 5].some((edge) => Math.abs(percentage - edge) < 0.5)) return undefined;
  return tiers.find(([floor]) => percentage > floor)?.[1];
}

/** [PROF-AGGREGATION-LOGIC] + [PROF-AGGREGATION-THRESHOLD]: shares are sane and ranked. */
export function assertRanked(result: ProfileResult): void {
  assert.ok(result.totalSamples > 0, `samples: ${result.totalSamples}`);
  const shares = result.hotFunctions.map((fn) => fn.percentage);
  assert.deepEqual(
    shares,
    [...shares].sort((a, b) => b - a),
    'hot functions arrive ranked',
  );
  for (const fn of result.hotFunctions) {
    assert.ok(fn.percentage <= 100 && fn.percentage >= 2, `${fn.name}: ${fn.percentage}%`);
    assert.ok(fn.selfPercentage <= fn.percentage + 1e-9, `${fn.name}: self within inclusive`);
    assert.ok(fn.samples <= result.totalSamples, `${fn.name}: never more samples than ticks`);
  }
  for (const line of result.hotLines) {
    assert.ok(
      line.percentage <= 100 && line.percentage >= 1,
      `line ${line.line}: ${line.percentage}%`,
    );
    assert.ok(line.line >= 1, 'lines are 1-based in the editor');
  }
}

/** A hot function whose name contains `identifier` and that resolves to `file`. */
export function hotFunction(result: ProfileResult, identifier: string, file: string) {
  return result.hotFunctions.find((fn) => fn.name.includes(identifier) && isFile(fn.file, file));
}

/** The heat map as painted on `file`. */
export function heatOn(file: string): AppliedDecoration[] {
  return appliedProfileDecorations().filter((d) => isFile(d.file, file));
}

/** [PROF-UI-HEATMAP]: `span` is painted, in the CPU palette, graded by each line's share. */
export function assertHeatMap(result: ProfileResult, span: Span): void {
  const painted = heatOn(span.file);
  assert.ok(
    painted.some((d) => within(span, d.file, d.line)),
    `${span.file} ${span.first}-${span.last} is painted: ${JSON.stringify(painted.map((d) => d.line))}`,
  );
  for (const decoration of painted) {
    assert.ok(CPU_PALETTE.includes(decoration.color), `CPU track colour: ${decoration.color}`);
    assert.ok(/\d%/.test(decoration.contentText), `a share is shown: ${decoration.contentText}`);
    const hot = result.hotLines.find(
      (l) => isFile(l.file, span.file) && l.line === decoration.line,
    );
    assert.ok(hot, `line ${decoration.line} is painted only because it is a hot line`);
    const tier = cpuTier(hot.percentage);
    if (tier !== undefined) {
      assert.equal(decoration.color, tier, `line ${hot.line} at ${hot.percentage}% wears its tier`);
    }
  }
}

/** [PROF-UI-CPU]: the branded results panel lists `identifiers` and links to source. */
export function assertResultsPanel(result: ProfileResult, identifiers: readonly string[]): void {
  const panel = flamegraphPanelState();
  assert.ok(panel, 'the results panel is open');
  assert.equal(panel.title, 'SharpLsp Profiler');
  assert.ok(panel.html.includes('<span class="accent">SHARPLSP</span> PROFILER'), 'brand');
  assert.ok(!/basilisk/i.test(panel.html), 'no other product named');
  assert.ok(panel.html.includes('<script nonce="'), 'a nonce-gated script ([PROF-UI-WEBVIEW])');
  assert.ok(panel.html.includes('navigateToSource'), 'rows navigate to their F# source');
  assert.ok(panel.html.includes(String(result.totalSamples)), 'the summary shows the samples');
  for (const identifier of identifiers) {
    assert.ok(panel.html.includes(identifier), `the panel lists the F# function ${identifier}`);
  }
}

interface Speedscope {
  shared: { frames: { name: string; file?: string; line?: number }[] };
  profiles: { samples: number[][]; weights: number[] }[];
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string } }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

function readJson(file: string | undefined, what: string): unknown {
  assert.ok(file !== undefined && fs.existsSync(file), `${what} is written: ${String(file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** [PROF-EXPORT]: all three artifacts exist, validate, and carry the F# function. */
export function assertArtifacts(result: ProfileResult, identifier: string, file: string): void {
  assert.equal(result.exportError, undefined, `no export error: ${result.exportError}`);
  const speedscope = readJson(result.outputFile, 'the speedscope profile') as Speedscope;
  const { frames } = speedscope.shared;
  const keysSeen = frames.map((f) => `${f.name}|${f.file ?? ''}|${f.line ?? ''}`);
  assert.equal(new Set(keysSeen).size, keysSeen.length, 'frames are deduplicated');
  assert.ok(
    frames.some((f) => f.name.includes(identifier) && isFile(f.file, file)),
    `a speedscope frame names ${identifier} in ${file}`,
  );
  assert.ok(speedscope.profiles.length > 0, 'one profile per thread');
  for (const profile of speedscope.profiles) {
    assert.equal(profile.samples.length, profile.weights.length, 'samples match weights');
    assert.ok(
      profile.weights.every((w) => Number.isFinite(w) && w >= 0),
      'weights are sane',
    );
    assert.ok(
      profile.samples.flat().every((i) => i >= 0 && i < frames.length),
      'indices in range',
    );
  }
  const v8 = readJson(result.cpuProfilePath, 'the V8 .cpuprofile') as CpuProfile;
  const ids = new Set(v8.nodes.map((n) => n.id));
  assert.equal(v8.samples.length, v8.timeDeltas.length, 'one time delta per sample');
  assert.ok(
    v8.samples.every((id) => ids.has(id)),
    'every sample names a node',
  );
  assert.ok(v8.endTime >= v8.startTime, 'time runs forward');
  assert.ok(
    v8.nodes.some((n) => n.callFrame.functionName.includes(identifier)),
    `a .cpuprofile node names ${identifier}`,
  );
  assert.ok(result.flamegraphPath !== undefined, 'a flame graph is exported');
  const svg = fs.readFileSync(result.flamegraphPath, 'utf8');
  assert.ok(
    svg.includes('<svg') && svg.includes(identifier),
    `the flame graph shows ${identifier}`,
  );
}

// ── Memory, as the editor and the wire show it ───────────────────────────────

/** One F# heap type and the exact line that constructs it. */
export interface Constructed {
  readonly type: string;
  readonly file: string;
  readonly line: number;
}

/**
 * FsOrderLedger's heap shapes, each at the exact line that constructs it
 * ([PROF-DOTNET-SOURCE]: F# records and union cases have only hidden sequence
 * points, so they anchor where they are built, never at their declaration in
 * Domain.fs). The count key names the reply count of live instances.
 */
export const SHAPES = {
  order: { type: 'FsOrderLedger.Order', file: 'Ledger.fs', line: 43, live: 'orders' },
  customer: { type: 'FsOrderLedger.CustomerId', file: 'Ledger.fs', line: 33, live: 'orders' },
  line: { type: 'FsOrderLedger.OrderLine', file: 'Ledger.fs', line: 41, live: 'orders' },
  paid: { type: 'FsOrderLedger.OrderStatus+Paid', file: 'Ledger.fs', line: 37, live: 'paid' },
  shipped: {
    type: 'FsOrderLedger.OrderStatus+Shipped',
    file: 'Ledger.fs',
    line: 38,
    live: 'shipped',
  },
  cancelled: {
    type: 'FsOrderLedger.OrderStatus+Cancelled',
    file: 'Ledger.fs',
    line: 39,
    live: 'cancelled',
  },
  quote: { type: 'FsOrderLedger.Quote', file: 'Quotes.fs', line: 32, live: 'quotes' },
  audit: { type: 'FsOrderLedger.AuditEntry', file: 'Audit.fs', line: 53, live: 'audits' },
  rejected: {
    type: 'FsOrderLedger.OrderRejected',
    file: 'Rejections.fs',
    line: 13,
    live: 'rejections',
  },
} as const satisfies Record<string, Constructed & { live: string }>;

/** The never-removed Bus handler: an F# closure built at Bus.fs:16, one per subscription. */
export const HANDLER = { file: 'Bus.fs', line: 16 } as const;
/** History's generic record, closed over its Map argument ([PROF-DOTNET-HEAP-GRAPH]). */
export const VERSIONED =
  'FsOrderLedger.Versioned`1[Microsoft.FSharp.Collections.FSharpMap`2[System.Int32,FsOrderLedger.Order]]';
/** Ledger.priceAll, the `burn on` loop: where the ledger's CPU time lands. */
export const PRICE_ALL: Span = { file: 'Ledger.fs', first: 63, last: 70 };
/** Every file of FsOrderLedger a shape is constructed in. */
export const LEDGER_FILES = ['Ledger.fs', 'Bus.fs', 'Quotes.fs', 'Audit.fs', 'Rejections.fs'];

/** The handler closure's site: the F# closure type built at Bus.fs:16. */
export function handlerSite(snapshot: MemoryDashboardSnapshot | undefined) {
  const site = snapshot?.topAllocations.find(
    (s) => isFile(s.file, HANDLER.file) && s.line === HANDLER.line,
  );
  assert.ok(
    site?.typeName,
    `the subscribe closure is a site at Bus.fs:16: ${JSON.stringify(snapshot?.topAllocations.map((s) => [s.typeName, s.file, s.line]))}`,
  );
  assert.ok(site.typeName.startsWith('FsOrderLedger.Bus'), `named in its module: ${site.typeName}`);
  return site;
}

/** The snapshot site of `type`, asserted present. */
export function siteOf(snapshot: MemoryDashboardSnapshot | undefined, type: string) {
  const site = snapshot?.topAllocations.find((s) => s.typeName === type);
  assert.ok(
    site,
    `${type} is a site: ${snapshot?.topAllocations.map((s) => s.typeName).join(', ')}`,
  );
  return site;
}

/** [PROF-DOTNET-SOURCE]: `shape` anchors at its constructing line and is painted there. */
export function assertAnchored(
  snapshot: MemoryDashboardSnapshot | undefined,
  shape: Constructed,
  live?: number,
): void {
  const site = siteOf(snapshot, shape.type);
  assert.ok(isFile(site.file, shape.file), `${shape.type} resolves to ${shape.file}: ${site.file}`);
  assert.equal(site.line, shape.line, `${shape.type} anchors where the program constructs it`);
  assert.ok(site.size > 0, `${shape.type} has bytes`);
  if (live !== undefined) assert.equal(site.count, live, `${shape.type}: every live instance`);
  const painted = memoryTrackOn(shape.file).filter((d) => d.line === shape.line);
  assert.ok(
    painted.some((d) => MEMORY_PALETTE.includes(d.color)),
    `the memory track paints ${shape.file}:${shape.line} purple: ${JSON.stringify(painted)}`,
  );
}

/** The memory track (allocations and leak badges) as painted on `file`. */
export function memoryTrackOn(file: string): AppliedDecoration[] {
  return appliedMemoryDecorations().filter((d) => isFile(d.file, file));
}

/** The leak badge painted at `file`:`line`, if any. */
export function leakBadge(file: string, line: number): AppliedDecoration | undefined {
  return memoryTrackOn(file).find((d) => d.line === line && BADGE.test(d.contentText));
}

/** A wire diff on its own session: the heap diff and its suspected leaks. */
export async function wireDiff(session: {
  memory_session_id: string;
}): Promise<{ diff: HeapDiff; leaks: SuspectedLeak[] }> {
  const result = completed(await execute<MemoryStep>('memory.diff', session));
  assert.equal(result.outcome.kind, 'Diff', 'a diff answers with a diff');
  const { diff, leaks } = result.outcome as { diff: HeapDiff; leaks: SuspectedLeak[] };
  assert.equal(diff.net_growth, diff.total_growth - diff.total_freed, 'net = grown - freed');
  assert.ok(diff.total_growth >= 0 && diff.total_freed >= 0, 'totals are magnitudes');
  return { diff, leaks };
}

/** The wire leak of `type`, if suspected. */
export function wireLeak(leaks: readonly SuspectedLeak[], type: string): SuspectedLeak | undefined {
  return leaks.find((leak) => leak.type_name === type);
}

/**
 * Stop the ledger's background work and drain its mailbox. Its retained state
 * is left as the test made it: later tests start from a dirty heap on purpose,
 * and read every count they assert from the fixture's own replies.
 */
export async function settleLedger(target: Target): Promise<void> {
  for (const line of ['burn off', 'drip off', 'audit resume', 'release blobs']) {
    await command(target, line);
  }
}

/**
 * End everything a test left running: the UI's CPU and memory sessions and any
 * wire CPU session. Every F# suite runs it after each test, so one failure
 * never leaves a session that fails the next test for the wrong reason.
 */
export async function endProfiling(): Promise<void> {
  const session = profilerStore().profiler.value;
  if (session.cpu !== 'idle') await stopProfiling(STOP_MS);
  if (session.memory !== 'idle') await stopTracking();
  const listed = await execute<ProfileSessionList>('cpu.list', {});
  for (const running of listed.sessions) {
    await execute('cpu.stop', { session_id: running.session_id });
  }
}
