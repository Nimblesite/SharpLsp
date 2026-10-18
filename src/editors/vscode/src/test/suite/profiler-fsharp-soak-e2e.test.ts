// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE.
//
// Memory soak suites: one long session per test, many user interactions, and every assertion
// driven from a spec section quoted at the interaction that proves it. The confidence ladder is
// the centrepiece:
//
//   [PROF-MEMORY-CONFIDENCE]  "One growth → Low", "Two consecutive growths, or one growth over
//                             10 MiB → Medium", "Three consecutive growths → High", "A
//                             non-growing diff resets that site's streak".
//   [PROF-MEMORY-COMPARE]     sites match by location; growth in bytes and count; net = grown − freed.
//   [PROF-MEMORY-OUTCOME]     a snapshot becomes the baseline and the timeline point.
//   [PROF-MEMORY-TIMELINE]    one point per snapshot; peak never falls.
//   [PROF-MEMORY-START]       Direct mode; the first step is a baseline snapshot.
//   [PROF-MEMORY-SESSION]     CPU and memory sessions are independent.
//   [PROF-UI-MEMORY]          the dashboard's numbers, rows and confidences.
//   [PROF-UI-PROCESSES]       the row of a live F# program, with Track Memory on it.
//   [PROF-UI-CAPABILITIES]    an assembly entry is never opened as source.
//   [PROF-UI-HEATMAP]         the memory track clears on stop; CPU never paints a memory colour.
//   [PROF-DOTNET-SOURCE]      F# records, union cases and closures anchor where they are built.
//   [PROF-DOTNET-HEAP-GRAPH]  a closed generic FSharpMap record is one site.
import * as assert from 'node:assert/strict';
import {
  appliedMemoryDecorations,
  memoryStatusText,
  processesViewState,
  profilerStatusText,
} from '@nimblesite/lsp-profiler-ui';
import type { MemoryStep } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  execute,
  profilerStore,
  profilingSuite,
  snapshotSession,
  stopTracking,
  trackMemory,
} from './profiler-kit';
import {
  assertAnchored,
  assertIdleRow,
  command,
  count,
  endProfiling,
  handlerSite,
  isFile,
  keys,
  LEDGER,
  LEDGER_FILES,
  LEAK_PALETTE,
  leakBadge,
  memoryTrackOn,
  processRow,
  SHAPES,
  showSources,
  STOP_MS,
  VERSIONED,
  wireLeak,
} from './profiler-fsharp-kit';
import {
  assertConfidence,
  assertDashboard,
  assertEveryShape,
  assertNoPhantomMemoryPaint,
  assertPaletteDiscipline,
  assertSitesCoherent,
  assertStoreCoherent,
  assertTimelineCoherent,
  compareMemory,
  MIB,
  uiSnapshot,
} from './profiler-fsharp-soak-kit';

/** `lspProfiler/memory/start`, exactly as [PROF-MEMORY-START] shapes it. */
interface MemoryStart {
  readonly memory_session_id: string;
  readonly runtime: string;
  readonly mode: { readonly kind: string };
  readonly step: MemoryStep;
}

suite('F# soak — FsOrderLedger: the leak-confidence ladder over one long session', () => {
  const live = profilingSuite('profiler-fs-soak-confidence-', LEDGER, { stopping: endProfiling });

  test('Low → Medium → High by consecutive growths, then a 12 MiB single growth as Medium, then release resets the streak to nothing — asserting the dashboard after every one of the ten interactions', async function () {
    this.timeout(STOP_MS * 10);
    const { target } = live;

    // ── Interaction 1: [PROF-MEMORY-START] opens a Direct session; start acknowledges it.
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
        'Ack',
        '[PROF-DOTNET-MEMORY] a wire start does not capture a baseline',
      );
      assert.ok(
        started.step.result.diagnostics.every((entry) => entry.uri.length > 0),
        'a diagnostic always names its URI',
      );
    }
    completed(
      await execute<MemoryStep>('memory.stop', { memory_session_id: started.memory_session_id }),
    );

    // The UI starts its own session and owns exactly one.
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

    // ── Interaction 2: [PROF-UI-PROCESSES] + [PROF-UI-CAPABILITIES] — the row of a live program.
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
    const wire = await snapshotSession(target.pid);
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
    assertSitesCoherent(baseline);
    assertTimelineCoherent(baseline);
    assertPaletteDiscipline();
    assertStoreCoherent();
    assertEveryShape(baseline, seeded);

    // ── Interaction 4: growth #1 → Low. [PROF-MEMORY-CONFIDENCE] one growth is Low.
    const first = await command(target, 'place 500');
    assert.equal(count(first, 'handlers'), 1_000, 'the handlers accumulate');
    const low = await compareMemory(wire);
    assertConfidence(low.leaks, SHAPES.order.type, 'Low', ['Ledger.fs']);
    assertConfidence(low.leaks, handlerSite(baseline).typeName!, 'Low', ['Bus.fs']);
    const lowSnap = await uiSnapshot(baseline);
    assert.ok(lowSnap.currentMemory > baseline.currentMemory, 'the heap grew');
    assertAnchored(lowSnap, SHAPES.order, 1_000);
    assertNoPhantomMemoryPaint(lowSnap);
    assertSitesCoherent(lowSnap);
    assertTimelineCoherent(lowSnap);
    assertPaletteDiscipline();
    assertStoreCoherent();
    assertEveryShape(lowSnap, first);

    // ── Interaction 5: growth #2 → Medium (two consecutive growths).
    const second = await command(target, 'place 500');
    assertConfidence((await compareMemory(wire)).leaks, SHAPES.order.type, 'Medium', ['Ledger.fs']);
    const mediumSnap = await uiSnapshot(lowSnap);
    assert.ok(mediumSnap.currentMemory >= lowSnap.currentMemory, 'the heap only grew');
    assert.equal(mediumSnap.timeline.length, 3, 'a third timeline point');
    assertDashboard(mediumSnap, 3, [SHAPES.order.type]);
    assertSitesCoherent(mediumSnap);
    assertTimelineCoherent(mediumSnap);
    assertPaletteDiscipline();
    assertEveryShape(mediumSnap, second);

    // ── Interaction 6: growth #3 → High (three consecutive growths).
    const third = await command(target, 'place 500');
    assertConfidence((await compareMemory(wire)).leaks, SHAPES.order.type, 'High', ['Ledger.fs']);
    const highSnap = await uiSnapshot(mediumSnap);
    assert.equal(handlerSite(highSnap).count, 2_000, 'two thousand never-removed handlers');
    assertAnchored(highSnap, SHAPES.order, 2_000);
    assertNoPhantomMemoryPaint(highSnap);
    assertSitesCoherent(highSnap);
    assertTimelineCoherent(highSnap);
    assertPaletteDiscipline();
    assertEveryShape(highSnap, third);
    for (const decoration of memoryTrackOn('Ledger.fs').slice(0, 20)) {
      assert.ok(
        highSnap.topAllocations.some(
          (site) => isFile(site.file, 'Ledger.fs') && site.line === decoration.line,
        ),
        `Ledger.fs:${decoration.line} is painted from a reported site`,
      );
    }

    // ── Interaction 7: [PROF-MEMORY-CONFIDENCE] "one growth over 10 MiB → Medium", single growth.
    const bloom = await command(target, 'blob 12');
    assert.equal(count(bloom, 'blobs'), 1, 'one retained 12 MiB array');
    assertConfidence((await compareMemory(wire)).leaks, 'System.Byte[]', 'Medium', []);
    const bloomSnap = await uiSnapshot(highSnap);
    assert.ok(
      bloomSnap.currentMemory > highSnap.currentMemory + 8 * MIB,
      `12 MiB of retained array shows up: ${bloomSnap.currentMemory - highSnap.currentMemory}`,
    );
    assert.equal(bloomSnap.timeline.length, 5, 'the blob snapshot is the fifth point');
    assertSitesCoherent(bloomSnap);
    assertTimelineCoherent(bloomSnap);
    assertPaletteDiscipline();
    const bigSite = bloomSnap.topAllocations.find((site) => site.typeName === 'System.Byte[]');
    assert.ok(bigSite, 'the retained array is a top site');
    assert.ok(bigSite.size > 8 * MIB, `the site is the 12 MiB array: ${bigSite.size}`);

    // ── Interaction 8: a non-growing diff resets the streak and frees the blob.
    const freed = await command(target, 'release all');
    assert.equal(count(freed, 'blobs'), 0, 'release all drops the blob');
    assert.equal(count(freed, 'handlers'), 2_000, 'release all never clears the Event handlers');
    const afterRelease = await compareMemory(wire);
    assert.equal(
      leakBadge('Ledger.fs', SHAPES.order.line),
      undefined,
      'the old Order badge clears',
    );
    const resetSnap = await uiSnapshot(bloomSnap);
    assert.ok(resetSnap.currentMemory < bloomSnap.currentMemory, 'the heap shrank');
    assertSitesCoherent(resetSnap);
    assertTimelineCoherent(resetSnap);
    assertPaletteDiscipline();
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
      afterRelease.diff.total_freed >= 12 * MIB,
      `the freed 12 MiB counts toward the freed total: ${afterRelease.diff.total_freed}`,
    );

    // ── Interaction 9: [PROF-UI-MEMORY] the bands reach the badges, in red and uppercase.
    const badges = LEDGER_FILES.flatMap((file) =>
      memoryTrackOn(file).filter((decoration) => leakBadge(file, decoration.line) === decoration),
    );
    for (const badge of badges) {
      assert.ok(
        LEAK_PALETTE.includes(badge.color),
        `leak badges are red, never purple: ${badge.color}`,
      );
      assert.ok(
        ['LOW', 'MEDIUM', 'HIGH', 'DEFINITE'].some((band) => badge.contentText.includes(band)),
        `the badge spells a band: ${badge.contentText}`,
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
    assert.equal(processesViewState().badge, undefined, 'no badge once idle');
    completed(await execute<MemoryStep>('memory.stop', wire));
    assertStoreCoherent();
    assert.deepEqual(
      (await execute<{ sessions: unknown[] }>('cpu.list', {})).sessions,
      [],
      '[PROF-MEMORY-SESSION] the memory session never created a CPU session',
    );
  });
});

suite('F# soak — FsOrderLedger: mailbox, cache and immutable history retention', () => {
  const live = profilingSuite('profiler-fs-soak-retention-', LEDGER, { stopping: endProfiling });

  test('a paused mailbox and a memoize cache in one session: the queue is a leak while paused and gone after resume, the cache never evicts, and the undo history is a closed generic record over FSharpMap', async function () {
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
    const wire = await snapshotSession(target.pid);
    assertAnchored(first, SHAPES.audit, 400);
    assert.equal(
      handlerSite(first).count,
      count(queued, 'handlers'),
      'all retained handlers are counted',
    );
    assertSitesCoherent(first);
    assertTimelineCoherent(first);
    assertPaletteDiscipline();
    assertStoreCoherent();

    // ── Interaction 2: quote 400 distinct SKUs. [PROF-MEMORY-OUTCOME] memoize cache leak.
    const quoted = await command(target, 'quote 400');
    assert.equal(count(quoted, 'quotes'), 400, 'each new SKU is cached');
    const growth = await compareMemory(wire);
    assertConfidence(growth.leaks, SHAPES.quote.type, 'Low', ['Quotes.fs']);
    const second = await uiSnapshot(first);
    assertAnchored(second, SHAPES.quote, 400);
    assert.ok(second.currentMemory >= first.currentMemory, 'the cache grows the heap');
    assertSitesCoherent(second);
    assertTimelineCoherent(second);
    assertPaletteDiscipline();
    assert.equal(second.timeline.length, 2, '[PROF-MEMORY-TIMELINE] a point per snapshot');

    // ── Interaction 3: the undo history keeps every immutable Map, as a closed generic.
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
    assertSitesCoherent(third);
    assertTimelineCoherent(third);
    assertPaletteDiscipline();

    // ── Interaction 4: a retained mailbox is not evidence of growth; add entries then compare.
    const more = await command(target, 'place 400');
    const queuedGrowth = await compareMemory(wire);
    assertConfidence(queuedGrowth.leaks, SHAPES.audit.type, 'Low', ['Audit.fs']);
    assert.equal(wireLeak(queuedGrowth.leaks, SHAPES.audit.type)?.count_growth, 400);
    assert.equal(count(more, 'audits'), 800);
    for (const shape of [SHAPES.quote, SHAPES.rejected, SHAPES.audit]) {
      assert.equal(
        memoryTrackOn(shape.file).some((decoration) => decoration.line === shape.line),
        shape.type !== SHAPES.rejected.type,
        `${shape.type} is painted only when it is a site`,
      );
    }

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
    assert.equal(fourth.timeline.length, 4, 'one timeline point per snapshot');
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
    assertSitesCoherent(fourth);
    assertTimelineCoherent(fourth);
    assertPaletteDiscipline();

    // ── Interaction 6: [PROF-MEMORY-COMPARE] sites match by location, so the cache site is stable.
    const quotesBefore = fourth.topAllocations.find((site) => site.typeName === SHAPES.quote.type);
    await command(target, 'quote 400');
    const fifth = await uiSnapshot(fourth);
    const quotesAfter = fifth.topAllocations.find((site) => site.typeName === SHAPES.quote.type);
    assert.ok(quotesAfter, 'the cache is still a site');
    assert.equal(quotesAfter.line, SHAPES.quote.line, 'the same location matches the earlier site');
    assert.ok(quotesAfter.count > (quotesBefore?.count ?? 0), 'the cache grew in count');
    assert.ok(quotesAfter.size > (quotesBefore?.size ?? 0), 'the cache grew in bytes');
    assert.ok(quotesAfter.size >= (quotesBefore?.size ?? 0), 'growth is never negative here');
    assertSitesCoherent(fifth);
    assertTimelineCoherent(fifth);
    assertPaletteDiscipline();

    // ── Interaction 7: release orders leaves the true leaks standing.
    const released = await command(target, 'release orders');
    assert.equal(count(released, 'orders'), 0, 'the ledger holds no order');
    assert.equal(count(released, 'quotes'), 800, 'the memoize cache still holds every SKU');
    assert.equal(
      count(released, 'handlers'),
      count(more, 'handlers'),
      'the handlers are never removed',
    );
    assert.equal(count(released, 'audits'), 0, 'the mailbox is still drained');
    const sixth = await uiSnapshot(fifth);
    assertAnchored(sixth, SHAPES.order, 400);
    assert.equal(count(released, 'snapshots'), 2, 'history still retains the first 400 orders');
    assert.equal(
      handlerSite(sixth).count,
      count(released, 'handlers'),
      'the closure leak survives',
    );
    assertAnchored(sixth, SHAPES.quote, 800);
    assert.ok(sixth.currentMemory <= fifth.currentMemory, 'releasing orders shrank the heap');
    assertNoPhantomMemoryPaint(sixth);
    assertSitesCoherent(sixth);
    assertTimelineCoherent(sixth);
    assertPaletteDiscipline();
    assertStoreCoherent();

    // Only dropping history too makes the Orders unreachable ([PROF-DOTNET-HEAP-MARK]).
    await command(target, 'release all');
    const unrooted = await uiSnapshot(sixth);
    assert.equal(
      unrooted.topAllocations.some((site) => site.typeName === SHAPES.order.type),
      false,
    );
    assertAnchored(unrooted, SHAPES.quote, 800);

    // ── Interaction 8: stop.
    await stopTracking();
    completed(await execute<MemoryStep>('memory.stop', wire));
    assert.equal(memoryStatusText(), undefined, 'the chrome hides');
    assert.deepEqual(appliedMemoryDecorations(), [], 'no decorations survive the stop');
    assert.deepEqual(
      (await execute<{ sessions: unknown[] }>('cpu.list', {})).sessions,
      [],
      'no CPU session was ever opened by a memory test',
    );
  });
});
