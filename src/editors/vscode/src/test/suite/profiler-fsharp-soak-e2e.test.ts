// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE.
//
// Soak suites: long sessions, many user interactions per test, against SharpLsp's real-world F#
// programs (src/sharplsp/tests/fixtures/fsharp-profiling). Every assertion below comes from a
// spec section, quoted in the comment above the interaction that proves it — the tests assert
// the contract, not the implementation:
//
//   [PROF-MEMORY-CONFIDENCE]  the confidence ladder: Low → Medium → High by consecutive growths,
//                            and "one growth over 10 MiB" as the single-growth Medium case.
//   [PROF-MEMORY-COMPARE]     sites match by location, growth in bytes AND count, net = grown − freed.
//   [PROF-MEMORY-OUTCOME]     a snapshot becomes the baseline, the timeline point and the heap profile.
//   [PROF-MEMORY-TIMELINE]    one timeline point per snapshot, trending upward while bytes rise.
//   [PROF-MEMORY-HEAPPROFILE] every snapshot writes a V8 .heapprofile.
//   [PROF-UI-MEMORY]          dashboard: timeline, current/peak/objects, top sites labelled with the
//                             runtime's own F# type name, growth table, suspected leaks with confidence.
//   [PROF-UI-PROCESSES]       one row per process with name, PID, runtime, version, CPU, memory.
//   [PROF-UI-CAPABILITIES]    an assembly entry is never opened as source; no runtime-ID branching.
//   [PROF-UI-HEATMAP]         CPU and memory on separate tracks, tint controlled by a setting.
//   [PROF-UI-WEBVIEW]         nonce-gated CSP, orange/amber CPU, purple memory, red leaks.
//   [PROF-CPU-START]          a second CPU session on the same PID is ALREADY_PROFILING.
//   [PROF-CPU-SESSIONS]       cpu.list carries the live session until it stops.
//   [PROF-CPU-SNAPSHOT]       a snapshot returns a report without ending the session.
//   [PROF-CPU-PROGRESS]       progress begins and ends around the session.
//   [PROF-CPU-REPORT]         the report carries samples, rate, hot functions, hot lines, artifacts.
//   [PROF-AGGREGATION-LOGIC]  per-tick shares never pass 100% and stay ranked.
//   [PROF-AGGREGATION-THRESHOLD] functions hot at 2%, lines at 1%.
//   [PROF-EXPORT]             three artifacts on stop; an export failure never fails the report.
//   [PROF-DOTNET-SOURCE]      F# records, union cases and closures anchor where they are built.
//   [PROFILER-SHARED-LIBRARY-VSCODE] the one-click flows and the F# target that proves them.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  appliedMemoryDecorations,
  appliedProfileDecorations,
  flamegraphPanelState,
  lastMemorySnapshot,
  lastProfileResult,
  memoryDashboardState,
  memoryStatusText,
  processesViewState,
  profilerStatusText,
  recordedOperations,
} from '@nimblesite/lsp-profiler-ui';
import type { MemoryDashboardSnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import type { MemoryStep } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  embeddedLeaks,
  execute,
  executeError,
  profilerStore,
  profilingSuite,
  setProfilerSetting,
  stopProfiling,
  stopTracking,
  trackMemory,
  uiCommand,
  waitFor,
} from './profiler-kit';
import {
  assertAnchored,
  assertArtifacts,
  assertCpuIdle,
  assertCpuLive,
  assertHeatMap,
  assertIdleRow,
  assertRanked,
  assertResultsPanel,
  awaitLiveProgress,
  command,
  count,
  ENGINE,
  endProfiling,
  handlerSite,
  heatOn,
  hotFunction,
  isFile,
  keys,
  LEDGER,
  LEDGER_FILES,
  LEAK_PALETTE,
  leakBadge,
  MEMORY_PALETTE,
  memoryTrackOn,
  PRICE_ALL,
  processRow,
  profileRow,
  SHAPES,
  showSources,
  STOP_MS,
  VERSIONED,
  wireDiff,
  wireLeak,
  within,
} from './profiler-fsharp-kit';

const SAMPLE_MS = 3_000;
const MIB = 1024 * 1024;
/** [PROF-MEMORY-CONFIDENCE] grades, as the wire spells them ([PROF-WIRE-GEN]). */
const BANDS = ['Low', 'Medium', 'High', 'Definite'] as const;
type Band = (typeof BANDS)[number];
/** The same grades, as the dashboard and its badges spell them. */
const BAND_LABELS = ['LOW', 'MEDIUM', 'HIGH', 'DEFINITE'] as const;

/** `lspProfiler/memory/start`, exactly as [PROF-MEMORY-START] shapes it. */
interface MemoryStart {
  readonly memory_session_id: string;
  readonly runtime: string;
  readonly mode: { readonly kind: string };
  readonly step: MemoryStep;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The UI snapshot after `previous`, through the real dashboard command. */
async function uiSnapshot(previous?: MemoryDashboardSnapshot): Promise<MemoryDashboardSnapshot> {
  await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
  const snapshot = await waitFor(
    () => lastMemorySnapshot(),
    (snap) => snap !== undefined && snap.snapshotId !== previous?.snapshotId,
    STOP_MS,
    'a newer snapshot in the dashboard',
  );
  assert.ok(snapshot, 'the dashboard holds a snapshot');
  return snapshot;
}

/** The live memory session the UI is tracking; fails rather than inventing one. */
function trackedSession(): { memory_session_id: string } {
  const id = profilerStore().profiler.value.memorySessionId;
  assert.ok(id !== undefined && id.length > 0, 'the UI store holds a memory session id');
  return { memory_session_id: id };
}

/**
 * [PROF-UI-MEMORY] + [PROF-MEMORY-TIMELINE] + [PROF-MEMORY-HEAPPROFILE]: the dashboard is
 * branded, its numbers are coherent, each snapshot added exactly one timeline point and wrote a
 * .heapprofile, and F# type names reach it unmodified.
 */
function assertDashboard(
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
function assertNoPhantomMemoryPaint(snapshot: MemoryDashboardSnapshot): void {
  for (const file of LEDGER_FILES) {
    for (const decoration of memoryTrackOn(file)) {
      assert.ok(
        MEMORY_PALETTE.includes(decoration.color) || LEAK_PALETTE.includes(decoration.color),
        `${file}:${decoration.line} wears a memory (purple) or leak (red) colour: ${decoration.color}`,
      );
      if (leakBadge(file, decoration.line) === decoration) continue;
      assert.ok(
        snapshot.topAllocations.some((s) => isFile(s.file, file) && s.line === decoration.line),
        `${file}:${decoration.line} is painted only because a site is there`,
      );
    }
  }
}

/**
 * [PROF-MEMORY-COMPARE] + [PROF-MEMORY-CONFIDENCE]: the diff agrees over the wire and in the
 * dashboard, and `type` carries exactly `band` — the confidence ladder, not a heuristic.
 */
async function assertConfidence(type: string, band: Band, lines: readonly string[]): Promise<void> {
  await vscode.commands.executeCommand(uiCommand('memoryDiff'));
  const shown = await waitFor(
    () => embeddedLeaks(memoryDashboardState()?.html ?? ''),
    (leaks) => leaks.length > 0,
    STOP_MS,
    'suspected leaks in the dashboard',
  );
  const { diff, leaks } = await wireDiff(trackedSession());
  assert.equal(diff.net_growth, diff.total_growth - diff.total_freed, 'net = grown − freed');
  assert.ok(diff.total_growth >= 0 && diff.total_freed >= 0, 'totals are magnitudes');
  const leak = wireLeak(leaks, type);
  assert.ok(leak, `[PROF-MEMORY-COMPARE] ${type} is a suspected leak: ${JSON.stringify(leaks)}`);
  assert.ok(leak.count_growth > 0, `${type} grew in count: ${leak.count_growth}`);
  const graded = leak.confidence.kind;
  assert.ok(BANDS.includes(graded), `${type} carries a confidence grade: ${graded}`);
  assert.equal(graded, band, `[PROF-MEMORY-CONFIDENCE] ${type} is ${band}`);
  assert.ok(
    shown.some((entry) => entry.typeName === type),
    `[PROF-UI-MEMORY] the dashboard shows ${type}: ${JSON.stringify(shown.map((l) => l.typeName))}`,
  );
  for (const file of lines) {
    const badges = memoryTrackOn(file).filter(
      (decoration) => leakBadge(file, decoration.line) === decoration,
    );
    for (const badge of badges) {
      assert.ok(LEAK_PALETTE.includes(badge.color), `a leak badge is red: ${badge.color}`);
      assert.ok(
        BAND_LABELS.some((name) => badge.contentText.includes(name)),
        `the badge spells the band: ${badge.contentText}`,
      );
    }
  }
}

suite('F# soak — FsOrderLedger: the leak-confidence ladder over one long session', () => {
  const live = profilingSuite('profiler-fs-soak-confidence-', LEDGER, { stopping: endProfiling });

  // [PROF-MEMORY-CONFIDENCE] Table: "One growth → Low", "Two consecutive growths, or one growth
  // over 10 MiB → Medium", "Three consecutive growths → High", "A non-growing diff resets that
  // site's streak". One test walks the whole table on the never-removed Bus handler and the
  // retained Order records, then proves the reset with a release.
  test('Low → Medium → High by consecutive growths, then a 12 MiB single growth as Medium, then release resets the streak to nothing — asserting the dashboard after every one of the six interactions', async function () {
    this.timeout(STOP_MS * 10);
    const { target } = live;

    // ── Interaction 1: [PROF-MEMORY-START] opens a session with its mode and limits.
    await showSources(LEDGER, LEDGER_FILES);
    const started = await execute<MemoryStart>('memory.start', { pid: target.pid });
    assert.ok(started.memory_session_id.length > 0, 'a session id');
    assert.equal(started.runtime, 'dotnet', '[PROF-RUNTIME] an F# program is a .NET runtime');
    assert.equal(started.mode.kind, 'Direct', '[PROF-MEMORY-MODE] .NET reads the live heap itself');
    assert.equal(started.step.kind, 'Completed', 'a Direct session needs no evaluation script');
    if (started.step.kind === 'Completed') {
      assert.equal(
        started.step.result.memory_session_id,
        started.memory_session_id,
        'the first step belongs to its own session',
      );
      assert.equal(
        started.step.result.outcome.kind,
        'Snapshot',
        '[PROF-MEMORY-MODE] Run & Track Memory takes a baseline snapshot first',
      );
    }
    completed(
      await execute<MemoryStep>('memory.stop', { memory_session_id: started.memory_session_id }),
    );
    await trackMemory(target.pid);
    assert.equal(profilerStore().profiler.value.memory, 'active', 'the UI tracks the program');
    assert.deepEqual(keys(), {
      profiling: false,
      cpuBusy: false,
      memoryTracking: true,
      memoryBusy: true,
      profilerBusy: true,
    });
    assert.ok(memoryStatusText()?.includes('tracking'), `status: ${memoryStatusText()}`);
    assert.equal(profilerStatusText(), undefined, 'no CPU chrome while only memory runs');

    // ── Interaction 2: [PROF-UI-PROCESSES] + [PROF-UI-CAPABILITIES] — the row of a live F# program.
    const row = await processRow(target.pid);
    assertIdleRow(row, target.pid, LEDGER);
    assert.equal(row.process.runtime, 'dotnet', 'classified as .NET');
    assert.equal(row.contextValue, 'processDebuggee', 'direct mode offers Track Memory');
    assert.equal(row.command, undefined, 'an assembly entry is never opened as source');

    // ── Interaction 3: the baseline. [PROF-MEMORY-OUTCOME] snapshot = baseline + timeline point.
    const seeded = await command(target, 'place 500');
    assert.equal(count(seeded, 'orders'), 500, 'every order is live');
    assert.equal(count(seeded, 'handlers'), 500, 'one never-removed handler per order');
    for (const status of ['pending', 'paid', 'shipped', 'cancelled']) {
      assert.equal(count(seeded, status), 125, `ids cycle evenly: ${status}`);
    }
    const baseline = await uiSnapshot();
    assertDashboard(baseline, 1, [SHAPES.order.type, SHAPES.paid.type]);
    for (const shape of [
      SHAPES.order,
      SHAPES.customer,
      SHAPES.line,
      SHAPES.paid,
      SHAPES.shipped,
      SHAPES.cancelled,
    ]) {
      assertAnchored(baseline, shape, count(seeded, shape.live));
    }
    assert.equal(handlerSite(baseline).count, 500, 'one handler closure per subscription');
    assertNoPhantomMemoryPaint(baseline);

    // ── Interaction 4: growth #1 → Low.
    const first = await command(target, 'place 500');
    assert.equal(count(first, 'handlers'), 1_000, 'the handlers accumulate');
    const lowSnap = await uiSnapshot(baseline);
    assertAnchored(lowSnap, SHAPES.order, 1_000);
    assertNoPhantomMemoryPaint(lowSnap);
    await assertConfidence(SHAPES.order.type, 'Low', ['Ledger.fs']);
    await assertConfidence('FsOrderLedger.Bus', 'Low', ['Bus.fs']);

    // ── Interaction 5: growth #2 → Medium (two consecutive growths).
    await command(target, 'place 500');
    const mediumSnap = await uiSnapshot(lowSnap);
    assert.ok(mediumSnap.currentMemory >= lowSnap.currentMemory, 'the heap only grew');
    assert.equal(mediumSnap.timeline.length, 3, 'a third timeline point');
    assertDashboard(mediumSnap, 3, [SHAPES.order.type]);
    await assertConfidence(SHAPES.order.type, 'Medium', ['Ledger.fs']);

    // ── Interaction 6: growth #3 → High (three consecutive growths).
    await command(target, 'place 500');
    const highSnap = await uiSnapshot(mediumSnap);
    assert.equal(handlerSite(highSnap).count, 2_000, 'two thousand never-removed handlers');
    assertAnchored(highSnap, SHAPES.order, 2_000);
    assertNoPhantomMemoryPaint(highSnap);
    await assertConfidence(SHAPES.order.type, 'High', ['Ledger.fs']);
    const trimmed = memoryTrackOn('Ledger.fs').slice(0, 20);
    for (const decoration of trimmed) {
      assert.ok(
        highSnap.topAllocations.some(
          (s) => isFile(s.file, 'Ledger.fs') && s.line === decoration.line,
        ),
        `Ledger.fs:${decoration.line} is painted from a reported site`,
      );
    }

    // ── Interaction 7: [PROF-MEMORY-CONFIDENCE] "one growth over 10 MiB → Medium", single growth.
    const bloom = await command(target, 'blob 12');
    assert.equal(count(bloom, 'blobs'), 1, 'one retained 12 MiB array');
    const bloomSnap = await uiSnapshot(highSnap);
    assert.ok(
      bloomSnap.currentMemory > highSnap.currentMemory + 8 * MIB,
      `12 MiB of retained array shows up: ${bloomSnap.currentMemory - highSnap.currentMemory}`,
    );
    await assertConfidence('System.Byte[]', 'Medium', []);
    assert.equal(bloomSnap.timeline.length, 5, 'the blob snapshot is the fifth point');

    // ── Interaction 8: a non-growing diff resets the streak and frees the blob.
    const freed = await command(target, 'release all');
    assert.equal(count(freed, 'blobs'), 0, 'release all drops the blob');
    assert.equal(count(freed, 'handlers'), 2_000, 'release all never clears the Event handlers');
    const resetSnap = await uiSnapshot(bloomSnap);
    assert.ok(resetSnap.currentMemory < bloomSnap.currentMemory, 'the heap shrank');
    await vscode.commands.executeCommand(uiCommand('memoryDiff'));
    const afterRelease = await wireDiff(trackedSession());
    assert.equal(
      wireLeak(afterRelease.leaks, 'System.Byte[]'),
      undefined,
      '[PROF-MEMORY-CONFIDENCE] freed allocations are never suspected',
    );
    assert.equal(
      wireLeak(afterRelease.leaks, SHAPES.order.type),
      undefined,
      'a non-growing diff resets the order streak',
    );
    assert.ok(
      wiredOrZero(afterRelease.diff.total_freed) >= 8 * MIB,
      `the freed 12 MiB counts toward the freed total: ${afterRelease.diff.total_freed}`,
    );

    // ── Interaction 9: [PROF-UI-MEMORY] the wording of the bands reaches the badges.
    const badges = LEDGER_FILES.flatMap((file) =>
      memoryTrackOn(file).filter((decoration) => leakBadge(file, decoration.line) === decoration),
    );
    for (const badge of badges) {
      assert.ok(
        LEAK_PALETTE.includes(badge.color),
        `leak badges are red, never purple: ${badge.color}`,
      );
    }

    // ── Interaction 10: stop clears the track and every key, and leaves nothing running.
    await stopTracking();
    assert.equal(profilerStore().profiler.value.memory, 'idle');
    assert.equal(memoryStatusText(), undefined, 'the memory status bar hides');
    assert.deepEqual(keys(), {
      profiling: false,
      cpuBusy: false,
      memoryTracking: false,
      memoryBusy: false,
      profilerBusy: false,
    });
    assert.deepEqual(appliedMemoryDecorations(), [], '[PROF-UI-HEATMAP] the memory track clears');
    assert.equal(processesViewState().badge, 0, 'no badge once idle');
  });

  test('a paused mailbox and a memoize cache in one session: the queue is a leak while paused and gone after resume, the cache never evicts, and the undo history is a generic record over FSharpMap', async function () {
    this.timeout(STOP_MS * 8);
    const { target } = live;
    await showSources(LEDGER, ['Audit.fs', 'Quotes.fs', 'History.fs']);
    await trackMemory(target.pid);

    // ── Interaction 1: pause the auditor, then grow it. [PROF-MEMORY-OUTCOME] mailbox leak.
    await command(target, 'audit pause');
    const queued = await command(target, 'place 400');
    assert.equal(count(queued, 'audits'), 400, 'a paused auditor retains every posted entry');
    assert.equal(count(queued, 'orders'), 400, 'the orders still land');
    const first = await uiSnapshot();
    assertAnchored(first, SHAPES.audit, 400);
    assert.equal(handlerSite(first).count, 400, 'the handler closures are all reachable');

    // ── Interaction 2: quote 400 distinct SKUs. [PROF-MEMORY-OUTCOME] memoize cache leak.
    const quoted = await command(target, 'quote 400');
    assert.equal(count(quoted, 'quotes'), 400, 'each new SKU is cached');
    const second = await uiSnapshot(first);
    assertAnchored(second, SHAPES.quote, 400);
    assert.ok(second.currentMemory >= first.currentMemory, 'the cache grows the heap');

    // ── Interaction 3: the undo history keeps every immutable Map, as a generic record.
    await command(target, 'history');
    const historic = await command(target, 'history');
    assert.equal(count(historic, 'snapshots'), 2, 'two versioned snapshots recorded');
    const third = await uiSnapshot(second);
    const versioned = third.topAllocations.filter((site) => site.typeName === VERSIONED);
    assert.equal(
      versioned.length,
      1,
      `[PROF-DOTNET-HEAP-GRAPH] one site for the closed generic: ${versioned.map((s) => s.typeName).join(', ')}`,
    );
    for (const site of versioned) {
      assert.ok(isFile(site.file, 'History.fs'), `history anchors in History.fs: ${site.file}`);
      assert.equal(site.count, 2, 'both snapshots are live');
      assert.ok(site.size > 0, 'the snapshot map costs bytes');
    }
    assertDashboard(third, 3, [VERSIONED]);

    // ── Interaction 4: the mailbox is a leak while paused; the diff says so with confidence.
    await assertConfidence(SHAPES.audit.type, 'Low', ['Audit.fs']);
    await assertConfidence(SHAPES.quote.type, 'Low', ['Quotes.fs']);

    // ── Interaction 5: resume drains the queue; the next snapshot cannot see it.
    const drained = await command(target, 'audit resume');
    assert.equal(count(drained, 'audits'), 0, 'resuming drains every queued entry');
    const fourth = await uiSnapshot(third);
    assert.equal(
      fourth.topAllocations.some((site) => site.typeName === SHAPES.audit.type),
      false,
      'drained audit entries are gone from the live heap',
    );
    assertAnchored(fourth, SHAPES.quote, 400);
    assert.ok(fourth.timeline.length === 4, 'one timeline point per snapshot');
    const firstPoint = fourth.timeline[0];
    const latestPoint = fourth.timeline[fourth.timeline.length - 1];
    assert.ok(firstPoint && latestPoint, 'the timeline carries its endpoints');
    assert.ok(
      latestPoint.peakMemory >= firstPoint.peakMemory,
      '[PROF-MEMORY-TIMELINE] peak never falls below the first point',
    );
    for (const point of fourth.timeline) {
      assert.ok(point.peakMemory >= point.currentMemory, 'peak is never below current');
      assert.ok(point.gcObjects > 0, 'a point counts live objects');
    }
    assertNoPhantomMemoryPaint(fourth);

    // ── Interaction 6: [PROF-MEMORY-COMPARE] sites match by location, so the cache site is stable.
    const quotesBefore = fourth.topAllocations.find((s) => s.typeName === SHAPES.quote.type);
    await command(target, 'quote 400');
    const fifth = await uiSnapshot(fourth);
    const quotesAfter = fifth.topAllocations.find((s) => s.typeName === SHAPES.quote.type);
    assert.ok(quotesAfter, 'the cache is still a site');
    assert.equal(quotesAfter.line, SHAPES.quote.line, 'the same location matches the earlier site');
    assert.ok(quotesAfter.count > (quotesBefore?.count ?? 0), 'the cache grew in count');
    assert.ok(quotesAfter.size > (quotesBefore?.size ?? 0), 'the cache grew in bytes');
    for (const shape of [SHAPES.quote, SHAPES.rejected]) {
      assert.equal(
        memoryTrackOn(shape.file).some((d) => d.line === shape.line),
        shape.type === SHAPES.quote.type,
        `${shape.type} is painted only when it is a site`,
      );
    }

    // ── Interaction 7: release orders leaves the true leaks standing.
    const released = await command(target, 'release orders');
    assert.equal(count(released, 'orders'), 0, 'the ledger holds no order');
    assert.equal(count(released, 'quotes'), 800, 'the memoize cache still holds every SKU');
    assert.equal(count(released, 'handlers'), 400, 'the handlers are never removed');
    assert.equal(count(released, 'audits'), 0, 'the mailbox is still drained');
    const sixth = await uiSnapshot(fifth);
    assert.equal(
      sixth.topAllocations.some((site) => site.typeName === SHAPES.order.type),
      false,
      'a released type is never still a heap site',
    );
    assert.equal(handlerSite(sixth).count, 400, 'the closure leak survives the release');
    assertAnchored(sixth, SHAPES.quote, 800);

    // ── Interaction 8: stop.
    await stopTracking();
    assert.equal(memoryStatusText(), undefined, 'the chrome hides');
    assert.deepEqual(appliedMemoryDecorations(), [], 'no decorations survive the stop');
    assert.deepEqual(
      (await execute<{ sessions: unknown[] }>('cpu.list', {})).sessions,
      [],
      'no CPU session was ever opened by a memory test',
    );
  });
});

suite('F# soak — FsPricingEngine + FsOrderLedger under CPU and memory at once', () => {
  const live = profilingSuite('profiler-fs-soak-joint-', ENGINE, { stopping: endProfiling });

  test('five stages, one program, one row: each stage is attributed to its own F# file with ranked shares, the artifacts validate, a second session is refused, and Stop is idempotent', async function () {
    this.timeout(STOP_MS * 12);
    const { target } = live;
    const stages = [
      { command: 'run parse', identifier: 'parseAll', file: 'Csv.fs', first: 14, last: 39 },
      { command: 'run price', identifier: 'applyRules', file: 'Pricing.fs', first: 10, last: 68 },
      { command: 'run search', identifier: 'distance', file: 'Search.fs', first: 9, last: 28 },
      { command: 'run route', identifier: 'shortestPath', file: 'Routing.fs', first: 29, last: 47 },
      { command: 'run report', identifier: 'dailyTotals', file: 'Reports.fs', first: 13, last: 47 },
    ] as const;
    await showSources(
      ENGINE,
      stages.map((stage) => stage.file),
    );

    let previousSamples = 0;
    for (const stage of stages) {
      // ── Interaction: switch the workload, then profile this stage from the real row.
      const started = await command(target, stage.command);
      assert.ok(count(started, 'iterations') >= 0, 'the workload switch is acknowledged');
      const row = await processRow(target.pid);
      assertIdleRow(row, target.pid, ENGINE);
      const before = recordedOperations().length;
      const sessionId = await profileRow(row);
      await assertCpuLive(target.pid);
      const top = await awaitLiveProgress();
      assert.ok(top.length > 0, 'a live top function while profiling');
      assert.ok(profilerStatusText()?.includes('Profiling'), 'the status bar names the session');

      // ── [PROF-CPU-SESSIONS] the live session is listed with its identity.
      const listed = (await execute<{ sessions: ProfileReportLike[] }>('cpu.list', {})).sessions;
      const session = listed.find((entry) => entry.session_id === sessionId);
      assert.ok(session, 'the running session is in cpu.list');
      assert.equal(session.pid, target.pid);
      assert.equal(session.runtime, 'dotnet', '[PROF-RUNTIME] the F# program classifies as .NET');
      assert.ok((session.started_at ?? '').length > 0, 'a start time is reported');

      // ── [PROF-CPU-START] a second session on the same PID is refused, not silently stacked.
      const refused = await executeError('cpu.start', { pid: target.pid });
      assert.ok(refused, 'the second start fails');
      assert.equal(
        refused.code !== 0,
        true,
        `an error code is returned: ${JSON.stringify(refused)}`,
      );
      assert.equal(
        (await execute<{ sessions: ProfileReportLike[] }>('cpu.list', {})).sessions.filter(
          (entry) => entry.pid === target.pid,
        ).length,
        1,
        'exactly one session exists after the refusal',
      );

      // ── [PROF-CPU-SNAPSHOT] a snapshot returns a report without ending the session.
      await delay(SAMPLE_MS);
      await vscode.commands.executeCommand(uiCommand('profileSnapshot'));
      const snapshot = await waitFor(
        () => lastProfileResult(),
        (result) => result?.sessionId === sessionId && result.totalSamples > 0,
        STOP_MS,
        'a mid-session snapshot',
      );
      assert.ok(snapshot, 'the snapshot is a full report');
      assert.equal(
        profilerStore().profiler.value.cpu,
        'active',
        'the session survived the snapshot',
      );
      assert.ok(snapshot.totalSamples > 0, 'the snapshot carries samples');

      // ── [PROF-CPU-STOP] + [PROF-REPORT] + [PROF-EXPORT]: stop publishes the full report.
      await stopProfiling(STOP_MS);
      await assertCpuIdle(target.pid);
      const ops = recordedOperations().slice(before);
      assert.ok(
        ops.some((op) => op.startsWith('begin:')),
        '[PROF-CPU-PROGRESS] progress began',
      );
      assert.ok(
        ops.some((op) => op.startsWith('end:')),
        '[PROF-CPU-PROGRESS] progress ended',
      );
      const result = lastProfileResult();
      assert.ok(result, `a result for ${stage.command}`);
      assert.equal(result.sessionId, sessionId, 'the result belongs to its own session');
      assert.ok(result.totalSamples >= previousSamples, 'samples accumulate within a session');
      previousSamples = result.totalSamples;
      assertRanked(result);
      const fn = hotFunction(result, stage.identifier, stage.file);
      assert.ok(
        fn,
        `[PROF-AGGREGATION-LOGIC] ${stage.identifier} is hot in ${stage.file}: ${result.hotFunctions.map((f) => f.name).join(', ')}`,
      );
      assert.ok(fn.percentage >= 2, '[PROF-AGGREGATION-THRESHOLD] a function is hot at 2%');
      assert.ok(
        within({ file: stage.file, first: stage.first, last: stage.last }, fn.file, fn.line ?? 0),
        `${stage.identifier}: ${fn.line}`,
      );
      assert.ok(
        result.hotLines.some(
          (line) =>
            isFile(line.file, stage.file) &&
            line.line >= stage.first &&
            line.line <= stage.last &&
            line.percentage >= 1,
        ),
        '[PROF-AGGREGATION-THRESHOLD] a hot line sits in the stage at 1% or more',
      );
      assertHeatMap(result, { file: stage.file, first: stage.first, last: stage.last });
      assertResultsPanel(result, [stage.identifier]);
      assertArtifacts(result, stage.identifier, stage.file);
      assert.equal(result.exportError, undefined, '[PROF-EXPORT] no export error');

      // ── The program never stopped: attaching is not invasive.
      const after = await command(target, 'stats');
      assert.ok(count(after, 'iterations') > count(started, 'iterations'), 'the F# program ran on');
    }

    // ── [PROF-UI-HEATMAP] the setting controls tint without losing results.
    await setProfilerSetting('showInlineHeatMap', false);
    await command(target, 'run route');
    await profileRow(await processRow(target.pid));
    await awaitLiveProgress();
    await delay(SAMPLE_MS);
    await stopProfiling(STOP_MS);
    const quiet = lastProfileResult();
    assert.ok(quiet, 'a result with the heat map off');
    assert.deepEqual(heatOn('Routing.fs'), [], 'the setting wins over the tint');
    assertResultsPanel(quiet, ['shortestPath']);
    await setProfilerSetting('showInlineHeatMap', true);
    await command(target, 'run mixed');
    await profileRow(await processRow(target.pid));
    await awaitLiveProgress();
    await delay(SAMPLE_MS * 2);
    await stopProfiling(STOP_MS);
    const loud = lastProfileResult();
    assert.ok(loud, 'a result with the heat map on');
    assert.ok(heatOn('Routing.fs').length > 0, 'the tint returns with the setting');
    for (const stage of stages) {
      assert.ok(
        hotFunction(loud, stage.identifier, stage.file),
        `mixed keeps ${stage.identifier} hot`,
      );
      assertHeatMap(loud, { file: stage.file, first: stage.first, last: stage.last });
    }
    assert.equal(flamegraphPanelState()?.title, 'SharpLsp Profiler', 'one panel for the results');
    assert.deepEqual(
      appliedProfileDecorations().filter((d) => d.color === undefined),
      [],
      'every CPU decoration carries a palette colour',
    );
    await command(target, 'idle');
    assert.deepEqual(
      (await execute<{ sessions: unknown[] }>('cpu.list', {})).sessions,
      [],
      'no session survives the soak',
    );
  });

  test('CPU and memory together on FsOrderLedger: the burn loop is the hotspot, both tracks paint at once, stopping CPU leaves memory tracking, and the diff is taken on a live program', async function () {
    this.timeout(STOP_MS * 8);
    const { target } = live;

    // ── Interaction 1: the burn loop and the first batch, with both sources on screen.
    const warm = await command(target, 'burn on');
    assert.equal(count(warm, 'orders'), 0, 'a fresh burn starts from nothing');
    const batch = await command(target, 'place 300');
    assert.equal(count(batch, 'handlers'), 300, 'one handler per order');
    await showSources(LEDGER, ['Ledger.fs', 'Bus.fs', 'History.fs']);

    // ── Interaction 2: [PROFILER-SHARED-LIBRARY-VSCODE] both one-click flows on the same program.
    await trackMemory(target.pid);
    assert.equal(profilerStore().profiler.value.memory, 'active', 'memory is tracking first');
    const row = await processRow(target.pid);
    const sessionId = await profileRow(row);
    await assertCpuLive(target.pid);
    assert.equal(keys().memoryTracking, true, 'the memory session survives the CPU one');
    await awaitLiveProgress();

    // ── Interaction 3: [PROF-CPU-STOP] the burn loop is the hotspot of this session.
    await delay(SAMPLE_MS * 2);
    await vscode.commands.executeCommand(uiCommand('profileSnapshot'));
    const liveResult = await waitFor(
      () => lastProfileResult(),
      (result) => result?.sessionId === sessionId && result.totalSamples > 0,
      STOP_MS,
      'a CPU snapshot of the burning F# program',
    );
    assert.ok(liveResult, 'a snapshot exists');
    assertRanked(liveResult);
    assert.ok(
      liveResult.hotFunctions.some((fn) => within(PRICE_ALL, fn.file, fn.line ?? 0)),
      `the burn loop is hot: ${liveResult.hotFunctions.map((f) => f.name).join(', ')}`,
    );
    assertHeatMap(liveResult, PRICE_ALL);
    assertResultsPanel(liveResult, ['priceAll']);
    assert.ok(liveResult.totalSamples > 0, 'samples were recorded');

    // ── Interaction 4: [PROF-UI-HEATMAP] the memory track paints during the CPU session too.
    const snap = await uiSnapshot();
    assertAnchored(snap, SHAPES.order, 300);
    assert.equal(handlerSite(snap).count, 300, 'the handler closures are all reachable');
    assertDashboard(snap, 1, [SHAPES.order.type]);
    assertNoPhantomMemoryPaint(snap);
    assert.ok(memoryStatusText()?.includes('tracking'), 'memory still tracks during the burn');
    assert.ok(heatOn('Ledger.fs').length > 0, 'the CPU heat map paints Ledger.fs');
    assert.ok(memoryTrackOn('Ledger.fs').length > 0, 'the memory track paints Ledger.fs');
    for (const cpuLine of heatOn('Ledger.fs')) {
      assert.ok(
        memoryTrackOn('Ledger.fs').every((memoryLine) => cpuLine.color !== memoryLine.color),
        'CPU and memory never share a colour on one file',
      );
    }

    // ── Interaction 5: more work in the same session grows the heap.
    const grew = await command(target, 'place 200');
    assert.equal(count(grew, 'orders'), 500, 'the second batch lands in the same session');
    const after = await uiSnapshot(snap);
    assert.ok(after.currentMemory >= snap.currentMemory, 'the heap grew under the CPU session');
    assertAnchored(after, SHAPES.order, 500);
    assert.equal(after.timeline.length, 2, '[PROF-MEMORY-TIMELINE] one point per snapshot');

    // ── Interaction 6: stopping CPU leaves memory tracking and clears only the heat map.
    await stopProfiling(STOP_MS);
    await assertCpuIdle(target.pid);
    assert.equal(keys().memoryTracking, true, 'stopping CPU never stops memory');
    assert.equal(profilerStore().profiler.value.memory, 'active', 'the memory session is intact');
    assert.ok(memoryStatusText()?.includes('tracking'), `memory chrome: ${memoryStatusText()}`);
    assert.equal(profilerStatusText(), undefined, 'the CPU chrome is gone');
    assert.equal(memoryTrackOn('Ledger.fs').length > 0, true, 'the memory track stays painted');

    // ── Interaction 7: the diff is taken on a program that is still running.
    await assertConfidence(SHAPES.order.type, 'Low', ['Ledger.fs']);

    // ── Interaction 8: stop everything; nothing survives.
    await command(target, 'burn off');
    await command(target, 'release all');
    await stopTracking();
    assert.equal(memoryStatusText(), undefined, 'the memory chrome hides');
    assert.deepEqual(appliedMemoryDecorations(), [], 'the memory track clears');
    assert.deepEqual(appliedProfileDecorations(), [], 'the heat map clears');
    assert.equal(flamegraphPanelState() !== undefined, true, 'the results stay readable');
    assert.deepEqual(keys(), {
      profiling: false,
      cpuBusy: false,
      memoryTracking: false,
      memoryBusy: false,
      profilerBusy: false,
    });
    assert.equal(processesViewState().badge, 0, 'no badge once idle');
    assert.deepEqual(
      (await execute<{ sessions: unknown[] }>('cpu.list', {})).sessions,
      [],
      'no CPU session is left running',
    );
  });
});

/** The wire `cpu.list` entry shape, as [PROF-CPU-SESSIONS] requires it. */
interface ProfileReportLike {
  readonly session_id: string;
  readonly pid: number;
  readonly runtime: string;
  readonly started_at?: string;
}

/** A freed total that must be a real number; zero when the runtime reports none. */
function wiredOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
