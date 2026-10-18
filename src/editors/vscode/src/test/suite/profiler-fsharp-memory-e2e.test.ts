// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// Memory tracking and leak detection on a real F# service, FsOrderLedger: an
// event-sourced order ledger with the leaks F# code really has —
//   - event handlers that are never removed (closures held by an F# Event);
//   - a memoize cache that never evicts;
//   - an unbounded MailboxProcessor queue;
//   - an undo history that keeps every immutable Map.
// Its heap is the shapes only F# emits: records, a single-case union, union
// cases as nested classes, a nullary case with no class at all, struct records
// and struct unions stored inline, an F# exception, and a generic record closed
// over FSharpMap. The fixture reports the exact live count of every shape after
// each command, so every snapshot, diff and confidence step is checked exactly,
// through the UI and over the wire at once. lspkit's [PROF-MEMORY-OUTCOME],
// [PROF-MEMORY-COMPARE], [PROF-MEMORY-CONFIDENCE], [PROF-MEMORY-TIMELINE],
// [PROF-MEMORY-HEAPPROFILE], [PROF-DOTNET-SOURCE], [PROF-UI-MEMORY], [PROF-UI-HEATMAP].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  appliedMemoryDecorations,
  lastMemorySnapshot,
  lastProfileResult,
  memoryDashboardState,
  memoryStatusText,
  processesViewState,
  profilerStatusText,
  recordedOperations,
} from '@nimblesite/lsp-profiler-ui';
import { memStartTitle } from '@nimblesite/lsp-profiler-ui/out/src/memory-capture';
import { referenceTypeCandidates } from '@nimblesite/lsp-profiler-ui/out/src/memory-ref-picker';
import type { MemoryDashboardSnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import type { MemoryStep } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  embeddedLeaks,
  execute,
  executeError,
  profilerStore,
  profilingSuite,
  snapshotSession,
  stopProfiling,
  stopTracking,
  trackMemory,
  uiCommand,
  waitFor,
} from './profiler-kit';
import {
  assertAnchored,
  assertHeatMap,
  assertIdleRow,
  awaitLiveProgress,
  command,
  count,
  type Counts,
  handlerSite,
  heatOn,
  hotFunction,
  isFile,
  keys,
  LEAK_PALETTE,
  leakBadge,
  LEDGER,
  LEDGER_FILES,
  memoryTrackOn,
  PRICE_ALL,
  processRow,
  profileRow,
  SHAPES,
  showSources,
  wireDiff,
  wireLeak,
} from './profiler-fsharp-kit';

const STEP_MS = 90_000;
const SEEDED = { orders: 12_000, quotes: 4_000, rejections: 1_500 };

/** Take a UI snapshot and wait until the dashboard holds a newer one. */
async function uiSnapshot(previous?: MemoryDashboardSnapshot): Promise<MemoryDashboardSnapshot> {
  await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
  const snapshot = await waitFor(
    () => lastMemorySnapshot(),
    (snap) => snap !== undefined && snap.snapshotId !== previous?.snapshotId,
    STEP_MS,
    'a new snapshot in the dashboard',
  );
  assert.ok(snapshot);
  return snapshot;
}

/** Every F# shape is a site at its constructing line, with every live instance counted. */
function assertZoo(snapshot: MemoryDashboardSnapshot, counts: Counts): void {
  for (const shape of Object.values(SHAPES)) {
    if (count(counts, shape.live) > 0) assertAnchored(snapshot, shape, count(counts, shape.live));
  }
  assert.equal(handlerSite(snapshot).count, count(counts, 'handlers'), 'one closure per handler');
  const names = snapshot.topAllocations.map((s) => s.typeName ?? '');
  for (const absent of [
    'FsOrderLedger.OrderStatus+Pending',
    'FsOrderLedger.Address',
    'FsOrderLedger.Money',
  ]) {
    assert.ok(
      !names.includes(absent),
      `${absent} is never a heap type: nullary cases have no class, struct records and struct unions live inline`,
    );
  }
  assert.ok(
    !snapshot.topAllocations.some((s) => isFile(s.file, 'Domain.fs')),
    'no F# record or union anchors at its declaration: they anchor where they are built',
  );
  for (const site of snapshot.topAllocations) {
    if (site.typeName?.startsWith('Microsoft.FSharp.') === true) {
      assert.ok(
        !LEDGER_FILES.some((file) => isFile(site.file, file)),
        `FSharp.Core's ${site.typeName} is never placed in the ledger's code`,
      );
    }
  }
}

/** [PROF-UI-MEMORY]: the dashboard's own numbers are coherent and branded. */
function assertDashboard(snapshot: MemoryDashboardSnapshot, types: readonly string[]): void {
  const dashboard = memoryDashboardState();
  assert.ok(dashboard, 'the dashboard is open');
  assert.equal(dashboard.title, 'SharpLsp Memory Dashboard');
  assert.ok(dashboard.html.includes('<span class="accent">SHARPLSP</span> MEMORY'), 'brand');
  assert.ok(!/basilisk/i.test(dashboard.html), 'no other product named');
  assert.ok(dashboard.html.includes('<script nonce="'), 'a nonce-gated script');
  assert.ok(dashboard.html.includes('Generation sizes'), 'heap regions are labelled as bytes');
  assert.deepEqual(snapshot.gcCounts, [], 'generation bytes are never shown as counts');
  for (const type of types) assert.ok(dashboard.html.includes(type), `the dashboard names ${type}`);
  assert.ok(snapshot.peakMemory >= snapshot.currentMemory, 'peak is never below current');
  const listed = snapshot.topAllocations.reduce((sum, site) => sum + site.size, 0);
  assert.ok(listed <= snapshot.currentMemory, `top sites (${listed}) fit in the live heap`);
  assert.ok(snapshot.gcObjects > 0, 'live objects are counted');
  assert.ok(
    snapshot.heapProfilePath.length > 0 && fs.existsSync(snapshot.heapProfilePath),
    `each snapshot writes a .heapprofile: ${snapshot.heapProfilePath}`,
  );
  const profile = JSON.parse(fs.readFileSync(snapshot.heapProfilePath, 'utf8')) as {
    head?: unknown;
  };
  assert.ok(profile.head !== undefined, 'the .heapprofile has a call tree head');
}

/** Every painted memory decoration on a ledger file stands on a reported site. */
function assertNoPhantomPaint(snapshot: MemoryDashboardSnapshot): void {
  for (const file of LEDGER_FILES) {
    for (const decoration of memoryTrackOn(file)) {
      if (leakBadge(file, decoration.line) === decoration) continue;
      assert.ok(
        snapshot.topAllocations.some((s) => isFile(s.file, file) && s.line === decoration.line),
        `${file}:${decoration.line} is painted only because a site is there`,
      );
    }
  }
}

suite('F# memory — FsOrderLedger through the UI and the wire', () => {
  const live = profilingSuite('profiler-fs-mem-', LEDGER, {
    stopping: async () => {
      if (profilerStore().profiler.value.cpu !== 'idle') await stopProfiling(STEP_MS);
      if (profilerStore().profiler.value.memory !== 'idle') await stopTracking();
    },
  });

  test('the F# heap zoo: seed every leak → Track Memory from the row → snapshot anchors every shape at its line with every instance counted → drain the mailbox → snapshot again → release → only the true leaks survive → stop clears everything', async function () {
    this.timeout(STEP_MS * 6);
    const { target } = live;
    await command(target, 'audit pause');
    const seeded = await command(target, `place ${SEEDED.orders}`);
    assert.equal(count(seeded, 'orders'), SEEDED.orders);
    assert.equal(count(seeded, 'audits'), SEEDED.orders, 'a paused mailbox queues every entry');
    for (const status of ['pending', 'paid', 'shipped', 'cancelled']) {
      assert.equal(count(seeded, status), SEEDED.orders / 4, `ids cycle evenly: ${status}`);
    }
    await command(target, `quote ${SEEDED.quotes}`);
    await command(target, `reject ${SEEDED.rejections}`);
    await command(target, 'history');
    const counts = await command(target, 'history');
    assert.equal(count(counts, 'snapshots'), 2);
    await showSources(LEDGER, LEDGER_FILES);

    // Track Memory: the chrome, the keys and the progress notification follow.
    const row = await processRow(target.pid);
    assertIdleRow(row, target.pid, LEDGER);
    const opsBefore = recordedOperations().length;
    await trackMemory(target.pid);
    assert.ok(memoryStatusText()?.includes('tracking'), `status: ${memoryStatusText()}`);
    assert.equal(profilerStatusText(), undefined, 'no CPU status while only memory runs');
    assert.deepEqual(keys(), {
      profiling: false,
      cpuBusy: false,
      memoryTracking: true,
      memoryBusy: true,
      profilerBusy: true,
    });
    assert.deepEqual(processesViewState(), { message: '🗄️ Tracking memory allocations…', badge: 1 });
    const ops = recordedOperations().slice(opsBefore);
    assert.ok(ops.includes(`begin:${memStartTitle()}`) && ops.includes(`end:${memStartTitle()}`));
    const session = profilerStore().profiler.value.memorySessionId;
    assert.ok(session, 'a memory session id');

    // Snapshot one: every shape, exactly, at its line; nothing invented.
    const first = await uiSnapshot();
    assertZoo(first, counts);
    assertDashboard(first, Object.values(SHAPES).map((s) => s.type));
    assertNoPhantomPaint(first);
    assert.equal(first.timeline.length, 1, 'the first point of the timeline');
    const offered = referenceTypeCandidates(first);
    const typed = first.topAllocations.flatMap((s) => (s.typeName ? [s.typeName] : []));
    assert.ok(offered.length > 0 && offered.every((t) => typed.includes(t)), 'the picker offers only reported types');
    const positions = offered.map((t) => typed.indexOf(t));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'in the server’s rank order');
    for (const shape of [SHAPES.order, SHAPES.shipped, SHAPES.quote]) {
      assert.ok(offered.includes(shape.type), `the picker offers ${shape.type}`);
    }

    // A second Track Memory is refused and keeps the session.
    await vscode.commands.executeCommand(uiCommand('memoryStart'), target.pid);
    assert.equal(profilerStore().profiler.value.memorySessionId, session);

    // Drain the mailbox and place more: the next snapshot follows exactly.
    await command(target, 'audit resume');
    const grown = await command(target, 'place 400');
    assert.equal(count(grown, 'audits'), 0, 'the mailbox drained');
    const second = await uiSnapshot(first);
    assertZoo(second, grown);
    assert.ok(
      !second.topAllocations.some((s) => s.typeName === SHAPES.audit.type),
      'drained audit entries are gone from the live heap',
    );
    assert.equal(second.timeline.length, 2, 'one timeline point per snapshot');
    const [p1, p2] = second.timeline;
    assert.ok(p1 && p2 && p2.timestamp >= p1.timestamp, 'points run forward in time');

    // Release the ledger: orders die; the handler and memoize leaks survive exactly.
    const released = await command(target, 'release all');
    assert.deepEqual(
      [count(released, 'orders'), count(released, 'rejections'), count(released, 'snapshots')],
      [0, 0, 0],
    );
    const third = await uiSnapshot(second);
    for (const dead of [SHAPES.order, SHAPES.customer, SHAPES.line, SHAPES.shipped, SHAPES.rejected]) {
      assert.ok(
        !third.topAllocations.some((s) => s.typeName === dead.type),
        `${dead.type} died with the ledger`,
      );
    }
    assert.equal(handlerSite(third).count, count(released, 'handlers'), 'handlers still leak');
    assertAnchored(third, SHAPES.quote, count(released, 'quotes'));
    assert.ok(third.currentMemory < second.currentMemory, 'releasing the ledger shrinks the heap');
    assert.equal(third.timeline.length, 3);
    assertNoPhantomPaint(third);
    assert.equal(
      memoryTrackOn('Ledger.fs').filter((d) => d.line === SHAPES.order.line).length,
      0,
      'the Order line is no longer painted once no Order lives',
    );

    // Stop: the session ends everywhere.
    await stopTracking();
    assert.equal(memoryStatusText(), undefined);
    assert.deepEqual(keys(), {
      profiling: false,
      cpuBusy: false,
      memoryTracking: false,
      memoryBusy: false,
      profilerBusy: false,
    });
    assert.deepEqual(processesViewState(), { message: undefined, badge: undefined });
    assert.deepEqual(appliedMemoryDecorations(), [], 'the memory track is cleared');
    assert.equal(lastMemorySnapshot(), undefined, 'per-session state is dropped');
  });

  test('leak confidence, exactly as specified, on two sessions at once: Low → Medium → High on three growths, reset by a flat diff, Low again, freed by a release, Medium on one growth over 10 MiB → High; the dashboard and the wire agree at every step', async function () {
    this.timeout(STEP_MS * 10);
    const { target } = live;
    await showSources(LEDGER, ['Ledger.fs']);
    await trackMemory(target.pid);
    await uiSnapshot();
    const wire = await snapshotSession(target.pid);

    /** Diff on both sessions; return the wire leaks and the dashboard's leaks. */
    async function bothDiff() {
      await vscode.commands.executeCommand(uiCommand('memoryDiff'));
      const html = await waitFor(
        () => memoryDashboardState()?.html ?? '',
        (h) => h.includes('const leaks = '),
        STEP_MS,
        'the dashboard leak analysis',
      );
      const shown = embeddedLeaks(html);
      return { ...(await wireDiff(wire)), shown };
    }

    /** One growth round: place, diff both, and check the Order leak at `level`. */
    async function grow(level: 'Low' | 'Medium' | 'High') {
      const before = profilerStore().profiler.value.memorySessionId;
      const counts = await command(target, 'place 1000');
      const { leaks, shown, diff } = await bothDiff();
      assert.equal(profilerStore().profiler.value.memorySessionId, before, 'one UI session');
      assert.ok(diff.total_growth > 0, 'the heap grew');
      const order = wireLeak(leaks, SHAPES.order.type);
      assert.ok(order, `Order is suspected after a growth: ${JSON.stringify(leaks.map((l) => l.type_name))}`);
      assert.equal(order.confidence.kind, level, `${level} on this growth`);
      assert.equal(order.count_growth, 1000, 'exactly the orders placed');
      assert.equal(order.current_count, count(counts, 'orders'), 'every live order');
      assert.ok(order.size_growth > 0 && order.current_size > 0);
      assert.ok(isFile(order.file, 'Ledger.fs') && order.line === SHAPES.order.line, 'at its line');
      assert.ok(order.reason.length > 0, 'the reason is said');
      for (const [shape, each] of [[SHAPES.shipped, 250], [SHAPES.customer, 1000]] as const) {
        assert.equal(wireLeak(leaks, shape.type)?.count_growth, each, `${shape.type} grew by ${each}`);
      }
      const ui = shown.find((leak) => leak.typeName === SHAPES.order.type);
      assert.ok(ui, 'the dashboard lists the Order leak');
      assert.equal(ui.confidence, level.toLowerCase(), 'the dashboard shows the server’s confidence');
      assert.equal(ui.countGrowth, 1000);
      assert.equal(ui.line, SHAPES.order.line);
      const badge = leakBadge('Ledger.fs', SHAPES.order.line);
      assert.ok(badge?.contentText.includes(level.toUpperCase()), `a ${level} badge: ${JSON.stringify(badge)}`);
      assert.ok(LEAK_PALETTE.includes(badge.color), `leak colour: ${badge.color}`);
    }

    await grow('Low');
    await grow('Medium');
    await grow('High');

    // A flat diff resets the streak on both surfaces, and the badge goes.
    const flat = await bothDiff();
    assert.equal(wireLeak(flat.leaks, SHAPES.order.type), undefined, 'no growth, no suspicion');
    assert.ok(!flat.shown.some((l) => l.typeName === SHAPES.order.type), 'the dashboard agrees');
    assert.equal(leakBadge('Ledger.fs', SHAPES.order.line), undefined, 'the badge is gone');
    await grow('Low');

    // Releasing frees: counted as freed and net, never as a leak.
    await command(target, 'release orders');
    const freed = await bothDiff();
    assert.ok(freed.diff.total_freed > 0, 'freed bytes are counted');
    assert.ok(freed.diff.net_growth < 0, 'the heap shrank on net');
    assert.ok(
      freed.diff.freed.some((site) => site.type_name === SHAPES.order.type),
      'the released orders are listed as freed',
    );
    assert.equal(wireLeak(freed.leaks, SHAPES.order.type), undefined, 'freed is never a leak');

    // One growth over 10 MiB is Medium at once; two more growths make it High.
    const blobLevels = [['blob 12', 'Medium'], ['blob 1', 'Medium'], ['blob 1', 'High']] as const;
    for (const [line, level] of blobLevels) {
      await command(target, line);
      const { leaks, shown } = await bothDiff();
      const bytes = wireLeak(leaks, 'System.Byte[]');
      assert.ok(bytes, `byte arrays are suspected after "${line}"`);
      assert.equal(bytes.confidence.kind, level, `"${line}" → ${level}`);
      assert.equal(bytes.file, undefined, 'a framework type has no location');
      const ui = shown.find((leak) => leak.typeName === 'System.Byte[]');
      assert.equal(ui?.confidence, level.toLowerCase(), 'shown in the dashboard all the same');
      assert.ok(bytes.size_growth >= 1_048_576, `at least the retained MiB: ${bytes.size_growth}`);
    }

    await command(target, 'release blobs');
    await stopTracking();
    completed(await execute<MemoryStep>('memory.stop', wire));
    for (const step of ['memory.snapshot', 'memory.diff', 'memory.stop']) {
      assert.equal((await executeError(step, wire))?.code, -32000, `${step} after stop is refused`);
    }
  });

  test('two tracks on one F# file: Track Memory and Profile CPU on the same program at once → both painted on Ledger.fs → stopping CPU keeps the memory track → stopping memory keeps the heat map', async function () {
    this.timeout(STEP_MS * 5);
    const { target } = live;
    await command(target, 'place 3000');
    await command(target, 'burn on');
    await showSources(LEDGER, ['Ledger.fs']);
    await trackMemory(target.pid);
    const snapshot = await uiSnapshot();
    assertAnchored(snapshot, SHAPES.order);

    const row = await processRow(target.pid);
    await profileRow(row);
    assert.deepEqual(keys(), {
      profiling: true,
      cpuBusy: true,
      memoryTracking: true,
      memoryBusy: true,
      profilerBusy: true,
    });
    assert.ok(profilerStatusText()?.includes('Profiling'), 'the CPU status shows');
    assert.ok(memoryStatusText()?.includes('tracking'), 'the memory status still shows');
    assert.equal(processesViewState().badge, 1, 'one badge for a busy profiler');
    await awaitLiveProgress();
    await stopProfiling(STEP_MS);

    const result = lastProfileResult();
    assert.ok(result && hotFunction(result, 'priceAll', 'Ledger.fs'), 'pricing the ledger is hot');
    assertHeatMap(result, PRICE_ALL);
    const memoryTrack = memoryTrackOn('Ledger.fs');
    assert.ok(memoryTrack.some((d) => d.line === SHAPES.order.line), 'the memory track survives');
    assert.deepEqual(
      { profiling: keys().profiling, memoryTracking: keys().memoryTracking, busy: keys().profilerBusy },
      { profiling: false, memoryTracking: true, busy: true },
      'stopping CPU leaves memory running',
    );
    assert.ok(memoryStatusText()?.includes('tracking'));

    const heat = heatOn('Ledger.fs');
    await stopTracking();
    assert.deepEqual(memoryTrackOn('Ledger.fs'), [], 'the memory track clears');
    assert.deepEqual(heatOn('Ledger.fs'), heat, 'the CPU heat map is another track and stays');
    assert.equal(keys().profilerBusy, false);
    await command(target, 'burn off');
  });
});
