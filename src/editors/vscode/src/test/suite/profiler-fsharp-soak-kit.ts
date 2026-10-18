// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE.
//
// Shared seams of the F# soak suites: dashboard reads, session identity, and the assertion groups
// both files prove. Each helper names the spec section it enforces:
//
//   [PROF-UI-MEMORY]          dashboard contents: timeline, current/peak/objects, runtime type
//                             names, growth table, suspected leaks with confidence.
//   [PROF-MEMORY-OUTCOME]     a snapshot becomes the baseline, the timeline point, the heap profile.
//   [PROF-MEMORY-TIMELINE]    one point per snapshot; peak never falls.
//   [PROF-MEMORY-HEAPPROFILE] every snapshot writes a V8 .heapprofile.
//   [PROF-MEMORY-COMPARE]     sites match by location; net = grown − freed.
//   [PROF-MEMORY-CONFIDENCE]  the ladder arrives from the server; the UI spells it uppercase.
//   [PROF-UI-WEBVIEW]         nonce-gated CSP, brand, palette discipline.
//   [PROF-DOTNET-SOURCE]      anchors sit where the F# value is built.
//   [PROF-INVARIANTS]         the backend supplies the order and the numbers; the UI never re-ranks.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  embeddedLeaks,
  execute,
  lspClient,
  profilerStore,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { captureToasts } from './profiler-ui-helpers';
import {
  lastMemorySnapshot,
  memoryDashboardState,
  processesViewState,
} from '@nimblesite/lsp-profiler-ui';
import {
  isFile,
  keys,
  LEDGER_FILES,
  LEAK_PALETTE,
  leakBadge,
  MEMORY_PALETTE,
  memoryTrackOn,
  SHAPES,
  assertAnchored,
  count,
  type Counts,
  STOP_MS,
  wireDiff,
} from './profiler-fsharp-kit';
import type {
  MemoryOutcome,
  MemoryStep,
  ProfileReport,
  SuspectedLeak,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import type { MemoryDashboardSnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';

export const SAMPLE_MS = 3_000;
export const MIB = 1024 * 1024;
/** [PROF-ERRORS] classified protocol failures. */
export const CODE = {
  OTHER: -32_000,
  PROCESS_NOT_FOUND: -32_001,
  UNSUPPORTED_RUNTIME: -32_002,
  ALREADY_PROFILING: -32_004,
  INVALID_PARAMS: -32_602,
} as const;
/** [PROF-MEMORY-CONFIDENCE] grades as the wire spells them ([PROF-WIRE-GEN]). */
export const BANDS = ['Low', 'Medium', 'High', 'Definite'] as const;
export type Band = (typeof BANDS)[number];
/** The badge's band word, matching the kit's own leak-badge convention. */
const BADGE = /\b(LOW|MEDIUM|HIGH|DEFINITE)\b/;
const BAND_LABELS = ['LOW', 'MEDIUM', 'HIGH', 'DEFINITE'] as const;

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The UI snapshot after `previous`, through the real dashboard command. */
export async function uiSnapshot(
  previous?: MemoryDashboardSnapshot,
): Promise<MemoryDashboardSnapshot> {
  const before = previous ?? lastMemorySnapshot();
  const session = trackedSession();
  const toasts = await captureToasts(() =>
    vscode.commands.executeCommand(uiCommand('memorySnapshot')),
  );
  assert.deepEqual(toasts.error, [], 'the F# snapshot succeeds');
  assert.deepEqual(toasts.warning, [], 'the F# snapshot is not refused');
  const snapshot = await waitFor(
    () => lastMemorySnapshot(),
    (snap) =>
      snap?.memorySessionId === session.memory_session_id && snap.snapshotId !== before?.snapshotId,
    STOP_MS,
    'a newer snapshot in the dashboard',
  );
  assert.ok(snapshot, 'the dashboard holds a snapshot');
  return snapshot;
}

/** The live memory session the UI is tracking; fails rather than inventing one. */
export function trackedSession(): { memory_session_id: string } {
  const id = profilerStore().profiler.value.memorySessionId;
  assert.ok(id !== undefined && id.length > 0, 'the UI store holds a memory session id');
  return { memory_session_id: id };
}

/**
 * [PROF-UI-MEMORY] + [PROF-MEMORY-TIMELINE] + [PROF-MEMORY-HEAPPROFILE]: the dashboard is
 * branded, its numbers are coherent, each snapshot added exactly one timeline point and wrote a
 * .heapprofile, and F# type names reach it unmodified.
 */
export function assertDashboard(
  snapshot: MemoryDashboardSnapshot,
  points: number,
  types: readonly string[],
): void {
  const dashboard = memoryDashboardState();
  assert.ok(dashboard, 'the dashboard is open');
  assert.equal(dashboard.title, 'SharpLsp Memory Dashboard');
  assert.ok(dashboard.html.includes('<span class="accent">SHARPLSP</span> MEMORY'), 'branded');
  assert.ok(!/basilisk/i.test(dashboard.html), 'no other product is named');
  assert.ok(dashboard.html.includes('<script nonce="'), '[PROF-UI-WEBVIEW] nonce-gated CSP');
  assert.equal(snapshot.timeline.length, points, 'one timeline point per snapshot');
  assert.ok(snapshot.peakMemory >= snapshot.currentMemory, 'peak is never below current');
  assert.ok(snapshot.gcObjects > 0, 'live objects are counted');
  assert.deepEqual(snapshot.gcCounts, [], 'generation bytes are never shown as counts');
  const listed = snapshot.topAllocations.reduce((sum, site) => sum + site.size, 0);
  assert.ok(listed <= snapshot.currentMemory, `top sites (${listed}) fit in the live heap`);
  assert.ok(
    fs.existsSync(snapshot.heapProfilePath),
    `[PROF-MEMORY-HEAPPROFILE] the .heapprofile is written: ${snapshot.heapProfilePath}`,
  );
  for (const type of types) assert.ok(dashboard.html.includes(type), `the dashboard names ${type}`);
  const ordered = snapshot.topAllocations.map((site) => site.size);
  assert.deepEqual(
    ordered,
    [...ordered].sort((a, b) => b - a),
    '[PROF-INVARIANTS] sites arrive ranked by bytes',
  );
  for (const site of snapshot.topAllocations) {
    assert.ok(site.size > 0, `${site.typeName} has bytes`);
    assert.ok(site.count > 0, `${site.typeName} has live instances`);
    assert.ok(
      !isFile(site.file, 'Domain.fs'),
      `[PROF-DOTNET-SOURCE] ${site.typeName} anchors where it is built, not at its declaration`,
    );
  }
}

/** [PROF-UI-MEMORY] + [PROF-UI-WEBVIEW]: every painted memory line is a site or a leak badge. */
export function assertNoPhantomMemoryPaint(snapshot: MemoryDashboardSnapshot): void {
  for (const file of LEDGER_FILES) {
    for (const decoration of memoryTrackOn(file)) {
      assert.ok(
        MEMORY_PALETTE.includes(decoration.color) || LEAK_PALETTE.includes(decoration.color),
        `${file}:${decoration.line} wears a memory (purple) or leak (red) colour: ${decoration.color}`,
      );
      if (leakBadge(file, decoration.line) === decoration) continue;
      assert.ok(
        snapshot.topAllocations.some(
          (site) => isFile(site.file, file) && site.line === decoration.line,
        ),
        `${file}:${decoration.line} is painted only because a site is there`,
      );
    }
  }
}

/** [PROF-MEMORY-OUTCOME]: compare ONCE on each independent session, before replacing a baseline. */
export async function compareMemory(wire: { memory_session_id: string }) {
  const toasts = await captureToasts(() => vscode.commands.executeCommand(uiCommand('memoryDiff')));
  assert.deepEqual(toasts.error, [], 'the UI comparison succeeds');
  assert.deepEqual(toasts.warning, [], 'the UI comparison is not refused');
  assert.ok(
    memoryDashboardState()?.html.includes('const leaks = '),
    'the dashboard renders the diff',
  );
  const compared = await wireDiff(wire);
  for (const site of compared.diff.grown) assert.ok(site.size_diff > 0, 'grown sites gained bytes');
  for (const site of compared.diff.freed) assert.ok(site.size_diff < 0, 'freed sites lost bytes');
  return compared;
}

/** [PROF-MEMORY-CONFIDENCE] + [PROF-UI-MEMORY]: inspect one comparison without advancing it. */
export function assertConfidence(
  leaks: readonly SuspectedLeak[],
  type: string,
  band: Band,
  lines: readonly string[],
): void {
  const shown = embeddedLeaks(memoryDashboardState()?.html ?? '');
  assert.ok(shown.length > 0, 'the dashboard lists suspected leaks');
  const leak = leaks.find((entry) => entry.type_name === type);
  assert.ok(leak, `[PROF-MEMORY-COMPARE] ${type} is a suspected leak: ${JSON.stringify(leaks)}`);
  assert.ok(leak.count_growth > 0, `${type} grew in count: ${leak.count_growth}`);
  const graded = leak.confidence.kind;
  assert.ok(BANDS.includes(graded), `${type} carries a confidence grade: ${graded}`);
  assert.equal(graded, band, `[PROF-MEMORY-CONFIDENCE] ${type} is ${band}`);
  const displayed = shown.find((entry) => entry.typeName === type);
  assert.ok(displayed, `[PROF-UI-MEMORY] the dashboard shows ${type}`);
  assert.equal(displayed.confidence, band.toLowerCase(), 'the dashboard shows the exact grade');
  assert.equal(displayed.countGrowth, leak.count_growth, 'the same F# count growth reaches the UI');
  assert.equal(displayed.currentCount, leak.current_count, 'the same live F# count reaches the UI');
  assert.equal(displayed.sizeGrowth, leak.size_growth, 'the same F# byte growth reaches the UI');
  assert.equal(displayed.currentSize, leak.current_size, 'the same F# live bytes reach the UI');
  for (const file of lines) {
    assert.ok(isFile(leak.file, file), `${type} has its F# source file`);
    assert.ok(leak.line !== undefined, `${type} has a source line`);
    const badge = leakBadge(file, leak.line);
    assert.ok(badge, `${type} has a badge at ${file}:${leak.line}`);
    assert.ok(LEAK_PALETTE.includes(badge.color), `a leak badge has a confidence colour`);
    assert.ok(badge.contentText.includes(band.toUpperCase()), `the badge spells ${band}`);
  }
}

// ── Blanket assertions ──────────────────────────────────────────────────────
// Each helper sweeps every row it can see, so one call blankets a whole interaction.
// The repo's F# fixtures make the row set deterministic: 9 shapes, 5 ledger files,
// 4 confidence bands, 5 context keys.

/** [PROF-UI-MEMORY] + [PROF-INVARIANTS]: every site row is coherent and uniquely identified. */
export function assertSitesCoherent(snapshot: MemoryDashboardSnapshot): void {
  assert.ok(snapshot.topAllocations.length > 0, 'a snapshot with sites lists at least one');
  const seen = new Set<string>();
  const total = snapshot.topAllocations.reduce((sum, site) => sum + site.size, 0);
  for (const site of snapshot.topAllocations) {
    const key = `${site.typeName}|${site.file}|${site.line}`;
    assert.ok(!seen.has(key), `one row per type at a location: ${key}`);
    seen.add(key);
    assert.ok((site.typeName ?? '').length > 0, 'a row names its runtime type');
    assert.ok(site.size > 0, `${key} has bytes`);
    assert.ok(site.count > 0, `${key} has objects`);
    if (site.typeName?.endsWith('[]') || site.typeName?.endsWith('[,]')) {
      assert.equal(site.file, undefined, '[PROF-DOTNET-SOURCE] an array has no source file');
      assert.equal(site.line, undefined, '[PROF-DOTNET-SOURCE] an array has no source line');
    }
    assert.ok(site.line === undefined || site.line >= 1, `[PROF-WIRE] 1-based line: ${site.line}`);
    if (site.file !== undefined) {
      assert.ok(fs.existsSync(site.file), `[PROF-DOTNET-SOURCE] the anchor exists: ${site.file}`);
    }
    assert.ok(total >= site.size, 'a site never exceeds the sites total');
  }
  assert.ok(
    snapshot.topAllocations
      .map((site) => site.size)
      .every((size) => size <= snapshot.currentMemory),
    'no single site exceeds the live heap',
  );
}

/** [PROF-MEMORY-TIMELINE]: every point runs forward, peaks above current, ends where the snapshot is. */
export function assertTimelineCoherent(snapshot: MemoryDashboardSnapshot): void {
  assert.ok(snapshot.timeline.length > 0, 'a snapshot has at least one point');
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const point of snapshot.timeline) {
    assert.ok(point.timestamp >= previousTimestamp, '[PROF-MEMORY-TIMELINE] time runs forward');
    previousTimestamp = point.timestamp;
    assert.ok(point.currentMemory > 0, 'a point measures live bytes');
    assert.ok(point.peakMemory >= point.currentMemory, 'peak never falls below current');
    assert.ok(point.gcObjects > 0, 'a point counts live objects');
  }
  const last = snapshot.timeline[snapshot.timeline.length - 1];
  assert.ok(last, 'the last point exists');
  assert.equal(last.currentMemory, snapshot.currentMemory, 'the last point is this snapshot');
  assert.equal(last.peakMemory, snapshot.peakMemory, 'the last peak is this snapshot');
  assert.ok(snapshot.currentMemory <= snapshot.peakMemory, 'current never exceeds peak');
}

/** [PROF-UI-HEATMAP] + [PROF-UI-WEBVIEW]: the whole memory track is palette-clean and badged. */
export function assertPaletteDiscipline(): void {
  for (const file of LEDGER_FILES) {
    for (const decoration of memoryTrackOn(file)) {
      assert.ok(
        MEMORY_PALETTE.includes(decoration.color) || LEAK_PALETTE.includes(decoration.color),
        `${file}:${decoration.line} wears a memory or leak colour: ${decoration.color}`,
      );
      assert.ok(
        !MEMORY_PALETTE.includes(decoration.color) || !BADGE.test(decoration.contentText),
        'a plain site is not badged as a leak',
      );
      assert.ok(decoration.line >= 1, `${file}:${decoration.line} is a 1-based line`);
      assert.ok(fs.existsSync(decoration.file), `a decorated file exists: ${decoration.file}`);
      if (BADGE.test(decoration.contentText)) {
        assert.ok(LEAK_PALETTE.includes(decoration.color), 'a leak badge is red');
        assert.ok(
          BAND_LABELS.some((band) => decoration.contentText.includes(band)),
          `the badge spells a band: ${decoration.contentText}`,
        );
      }
    }
  }
}

/** [PROF-DOTNET-SOURCE] + [PROF-DOTNET-HEAP-MARK]: check shapes the fixture actually retains. */
export function assertEveryShape(snapshot: MemoryDashboardSnapshot, live: Counts): void {
  for (const shape of Object.values(SHAPES)) {
    const expected = count(live, shape.live);
    if (expected > 0) assertAnchored(snapshot, shape, expected);
    else
      assert.equal(
        snapshot.topAllocations.some((site) => site.typeName === shape.type),
        false,
        `${shape.type} has no reachable instances`,
      );
  }
}

/** [PROF-UI-STATE]: the five context keys agree with the store and with each other. */
export function assertStoreCoherent(): void {
  const state = profilerStore().profiler.value;
  const values = keys() as Record<string, boolean | undefined>;
  for (const name of ['profiling', 'cpuBusy', 'memoryTracking', 'memoryBusy', 'profilerBusy']) {
    assert.equal(typeof values[name], 'boolean', `context key ${name} is a boolean`);
  }
  assert.equal(values.profiling, state.cpu === 'active', 'profiling mirrors cpu state');
  assert.equal(values.memoryTracking, state.memory === 'active', 'tracking mirrors memory state');
  assert.equal(
    typeof state.memorySessionId === 'string',
    state.memory === 'active',
    'a session id exactly when tracking',
  );
  assert.equal(
    values.profilerBusy,
    values.cpuBusy === true || values.memoryBusy === true,
    'busy is either half',
  );
  assert.ok(!values.cpuBusy || values.profiling, 'cpuBusy implies profiling');
  assert.ok(!values.memoryBusy || values.memoryTracking, 'memoryBusy implies memoryTracking');
  const badge = processesViewState().badge;
  if (values.profilerBusy) assert.ok((badge ?? 0) >= 1, 'a running session badges the panel');
  else assert.equal(badge ?? 0, 0, 'no badge when nothing runs');
}

/** The outcome of one memory step; a Courier Evaluate step is a failure for a .NET target. */
export async function step(name: string, params: Record<string, unknown>): Promise<MemoryOutcome> {
  const result = await execute<MemoryStep>(name, params);
  assert.equal(result.kind, 'Completed', `[PROF-MEMORY-STEP] ${name} completes in Direct mode`);
  assert.ok(result.kind === 'Completed', 'narrowed');
  return result.result.outcome;
}

export async function snapshotOutcome(
  id: string,
): Promise<Extract<MemoryOutcome, { kind: 'Snapshot' }>> {
  const outcome = await step('memory.snapshot', { memory_session_id: id });
  assert.equal(outcome.kind, 'Snapshot', '[PROF-MEMORY-STEP] snapshot yields a Snapshot outcome');
  assert.ok(outcome.kind === 'Snapshot', 'narrowed');
  return outcome;
}

export async function diffOutcome(id: string): Promise<Extract<MemoryOutcome, { kind: 'Diff' }>> {
  const outcome = await step('memory.diff', { memory_session_id: id });
  assert.equal(outcome.kind, 'Diff', '[PROF-MEMORY-STEP] diff yields a Diff outcome');
  assert.ok(outcome.kind === 'Diff', 'narrowed');
  return outcome;
}

/** `workspace/executeCommand` exactly as the spec shapes it, with caller-chosen arguments. */
export function raw(name: string, args: unknown[]): Promise<unknown> {
  return lspClient().sendRequest('workspace/executeCommand', {
    command: name,
    arguments: args,
  });
}

/** The error a raw call rejects with. */
export async function rawError(
  name: string,
  args: unknown[],
): Promise<{ code: number; message: string }> {
  try {
    await raw(name, args);
  } catch (error: unknown) {
    const failure = error as { code?: unknown; message?: unknown };
    return {
      code: typeof failure.code === 'number' ? failure.code : 0,
      message: String(failure.message ?? error),
    };
  }
  assert.fail(`${name} with ${JSON.stringify(args)} should have failed`);
}

/** [PROF-CPU-REPORT] + [PROF-AGGREGATION-LOGIC] + [PROF-SAMPLE] + [PROF-EXPORT]. */
export function assertProfileShape(report: ProfileReport): void {
  assert.ok(Array.isArray(report.hot_functions), 'hot functions are a list');
  assert.ok(Array.isArray(report.hot_lines), 'hot lines are a list');
  const percentages = report.hot_functions.map((fn) => fn.percentage);
  assert.deepEqual(
    percentages,
    [...percentages].sort((a, b) => b - a),
    'functions are ranked hottest first',
  );
  for (const fn of report.hot_functions) {
    assert.ok(fn.name.length > 0, 'a function has a name');
    assert.ok(
      fn.percentage >= 0 && fn.percentage <= 100,
      `inclusive share 0–100: ${fn.percentage}`,
    );
    assert.ok(
      fn.self_percentage <= fn.percentage,
      `self never exceeds inclusive: ${fn.self_percentage} > ${fn.percentage}`,
    );
    assert.ok(fn.samples >= fn.self_samples, 'inclusive samples cover the self samples');
    assert.ok(fn.samples <= report.user_samples, 'a function cannot exceed retained ticks');
    assert.equal(
      fn.percentage,
      (fn.samples / report.user_samples) * 100,
      '[PROF-AGGREGATION-LOGIC] inclusive share uses retained ticks as its denominator',
    );
    assert.equal(
      fn.self_percentage,
      (fn.self_samples / report.user_samples) * 100,
      '[PROF-AGGREGATION-LOGIC] self share uses the same retained-tick denominator',
    );
    if (fn.line !== undefined) {
      assert.ok(fn.line >= 1, `[PROF-SAMPLE] 1-based definition line: ${fn.line}`);
      assert.ok((fn.file ?? '').length > 0, 'a located function names its file');
    }
  }
  const linePercentages = report.hot_lines.map((line) => line.percentage);
  assert.deepEqual(
    linePercentages,
    [...linePercentages].sort((a, b) => b - a),
    'lines are ranked hottest first',
  );
  for (const line of report.hot_lines) {
    assert.ok(line.line >= 1, `[PROF-SAMPLE] 1-based hot line: ${line.line}`);
    assert.ok(line.file.length > 0, 'a hot line names its file');
    assert.ok(
      line.percentage > 0 && line.percentage <= 100,
      `a hot line share: ${line.percentage}`,
    );
    assert.ok(line.samples <= report.user_samples, 'a hot line cannot exceed retained ticks');
    assert.equal(
      line.percentage,
      (line.samples / report.user_samples) * 100,
      '[PROF-AGGREGATION-LOGIC] a hot line’s share agrees with its tick count',
    );
  }
  const artifacts = report.artifacts;
  for (const artifact of [
    artifacts.speedscope_path,
    artifacts.flamegraph_path,
    artifacts.cpuprofile_path,
  ]) {
    assert.ok(artifact, '[PROF-EXPORT] every required CPU artifact is returned');
    assert.ok(fs.existsSync(artifact), `[PROF-EXPORT] the artifact exists: ${artifact}`);
  }
  assert.ok(Array.isArray(report.diagnostics), 'diagnostics travel with the result');
}
