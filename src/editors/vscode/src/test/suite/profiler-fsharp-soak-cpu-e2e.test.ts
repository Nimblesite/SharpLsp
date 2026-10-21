// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE.
//
// CPU soak suites: long sessions over SharpLsp's two real F# programs, with the CPU and memory
// tracks live at the same time. Every assertion comes from a spec section:
//
//   [PROF-CPU-START]          a second CPU session on the same PID is ALREADY_PROFILING.
//   [PROF-CPU-SESSIONS]       cpu.list carries the session's identity for its lifetime.
//   [PROF-CPU-SNAPSHOT]       a snapshot returns a report without ending the session.
//   [PROF-CPU-PROGRESS]       progress begins and ends around the session.
//   [PROF-CPU-REPORT]         samples, rate, hot functions, hot lines, artifacts.
//   [PROF-AGGREGATION-LOGIC]  shares stay 0–100 and ranked; mixed keeps every stage hot.
//   [PROF-AGGREGATION-THRESHOLD] functions hot at 2%, lines at 1%.
//   [PROF-EXPORT]             artifacts exist and validate; an export error is reported, not thrown.
//   [PROF-UI-HEATMAP]         CPU and memory never share a colour; the setting controls tint.
//   [PROF-UI-MEMORY]          the memory dashboard stays coherent while CPU profiles.
//   [PROF-UI-STATE]           the store, not the webview, says what is running.
//   [PROF-MEMORY-SESSION]     stopping CPU leaves memory tracking.
//   [PROF-DOTNET-SOURCE]      F# functions anchor in their own file at 1-based lines.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  formatSampleCount,
  formatProfileDuration,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-format';
import {
  appliedMemoryDecorations,
  appliedProfileDecorations,
  flamegraphPanelState,
  lastProfileResult,
  memoryStatusText,
  processesViewState,
  profilerStatusText,
  recordedOperations,
} from '@nimblesite/lsp-profiler-ui';
import {
  execute,
  executeError,
  completed,
  profilerStore,
  profilingSuite,
  setProfilerSetting,
  snapshotSession,
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
  endProfiling,
  ENGINE,
  handlerSite,
  heatOn,
  hotFunction,
  isFile,
  keys,
  LEDGER,
  memoryTrackOn,
  PRICE_ALL,
  processRow,
  profileRow,
  SHAPES,
  showSources,
  STOP_MS,
  within,
  wireLeak,
} from './profiler-fsharp-kit';
import type { MemoryStep } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
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
  delay,
  SAMPLE_MS,
  uiSnapshot,
} from './profiler-fsharp-soak-kit';

/** The wire `cpu.list` entry, as [PROF-CPU-SESSIONS] requires it. */
interface SessionInfo {
  readonly session_id: string;
  readonly pid: number;
  readonly runtime: string;
  readonly started_at?: string;
}

/** The live sessions the server lists. */
async function sessions(): Promise<readonly SessionInfo[]> {
  return (await execute<{ sessions: SessionInfo[] }>('cpu.list', {})).sessions;
}

suite('F# soak — FsPricingEngine through five workloads in one long CPU session', () => {
  // The test turns the heat map off mid-way; a failure there must not leave it off for later suites.
  const live = profilingSuite('profiler-fs-soak-engine-', ENGINE, {
    stopping: endProfiling,
    stopped: () => setProfilerSetting('showInlineHeatMap', undefined),
  });

  test('five stages, one program, one row: each stage is attributed to its own F# file with ranked shares, the artifacts validate, a second session is refused, and the heat map follows its setting', async function () {
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
      assert.ok(top.length > 0, '[PROF-CPU-PROGRESS] a live top function while profiling');
      const state = profilerStore().profiler.value;
      assert.ok(
        profilerStatusText()?.includes(`${formatSampleCount(state.sampleCount)} samples`),
        '[PROF-CPU-PROGRESS] the live status shows this session’s sample count',
      );
      assert.ok(
        profilerStatusText()?.includes(formatProfileDuration(state.durationSecs)),
        '[PROF-CPU-PROGRESS] the live status shows this session’s elapsed time',
      );
      assert.equal(state.cpuSessionId, sessionId, 'the counters belong to the clicked F# process');
      assertStoreCoherent();
      assert.deepEqual(keys(), {
        profiling: true,
        cpuBusy: true,
        memoryTracking: false,
        memoryBusy: false,
        profilerBusy: true,
      });

      // ── [PROF-CPU-SESSIONS] the live session is listed with its identity.
      const listed = await sessions();
      const session = listed.find((entry) => entry.session_id === sessionId);
      assert.ok(session, 'the running session is in cpu.list');
      assert.equal(session.pid, target.pid);
      assert.equal(session.runtime, 'dotnet', '[PROF-RUNTIME] the F# program classifies as .NET');
      assert.ok((session.started_at ?? '').length > 0, 'a start time is reported');
      assert.equal(
        listed.filter((entry) => entry.pid === target.pid).length,
        1,
        'one session per PID',
      );

      // ── [PROF-CPU-START] a second session on the same PID is refused, not silently stacked.
      const refused = await executeError('cpu.start', { pid: target.pid });
      assert.ok(refused, 'the second start fails');
      assert.notEqual(refused.code, 0, `an error code is returned: ${JSON.stringify(refused)}`);
      assert.equal(
        (await sessions()).filter((entry) => entry.pid === target.pid).length,
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
      assert.ok(
        snapshot.hotFunctions.every((fn) => fn.selfPercentage <= fn.percentage),
        '[PROF-AGGREGATION-LOGIC] self never exceeds inclusive on every snapshot row',
      );
      assert.ok(
        snapshot.hotLines.every((line) => line.line >= 1 && line.percentage > 0),
        '[PROF-DOTNET-SOURCE] every snapshot hot line is 1-based and non-zero',
      );
      assert.equal(
        (await sessions()).some((entry) => entry.session_id === sessionId),
        true,
        '[PROF-CPU-SNAPSHOT] the session is still active after a snapshot',
      );

      // ── [PROF-CPU-STOP] + [PROF-CPU-REPORT] + [PROF-EXPORT]: stop publishes the full report.
      await stopProfiling(STOP_MS);
      await assertCpuIdle(target.pid);
      assertStoreCoherent();
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
      assert.ok(
        result.totalSamples >= snapshot.totalSamples,
        '[PROF-CPU-STOP] stop includes every tick from this session’s snapshot',
      );
      assertRanked(result);
      const fn = hotFunction(result, stage.identifier, stage.file);
      assert.ok(
        fn,
        `[PROF-AGGREGATION-LOGIC] ${stage.identifier} is hot in ${stage.file}: ${result.hotFunctions.map((f) => f.name).join(', ')}`,
      );
      assert.ok(fn.percentage >= 2, '[PROF-AGGREGATION-THRESHOLD] a function is hot at 2%');
      assert.ok(fn.percentage <= 100, 'a share is 0–100');
      assert.ok(
        within({ file: stage.file, first: stage.first, last: stage.last }, fn.file, fn.line ?? 0),
        `[PROF-DOTNET-SOURCE] ${stage.identifier} anchors in its stage: ${fn.line}`,
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
      for (const fn of result.hotFunctions) {
        assert.ok(fn.percentage >= 0 && fn.percentage <= 100, `share in range: ${fn.name}`);
        assert.ok(fn.selfPercentage <= fn.percentage, `self ≤ inclusive: ${fn.name}`);
        assert.ok(fn.name.length > 0, 'a hot function has a name');
        if (fn.file !== undefined) assert.ok(fn.file.length > 0, `${fn.name} names a file`);
      }
      for (const line of result.hotLines) {
        assert.ok(line.line >= 1, '[PROF-DOTNET-SOURCE] 1-based line');
        assert.ok(line.percentage > 0 && line.percentage <= 100, 'share in range');
        assert.ok(line.file.length > 0, 'a hot line names its file');
      }
      assert.ok(
        result.hotFunctions.length > 0 && result.hotLines.length > 0,
        '[PROF-CPU-REPORT] a hot report has both tables',
      );
      assertArtifacts(result, stage.identifier, stage.file);
      assert.equal(result.exportError, undefined, '[PROF-EXPORT] no export error');
      assert.deepEqual(
        await sessions(),
        [],
        '[PROF-CPU-SESSIONS] no session is active after a stop',
      );

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
    for (const stage of stages) {
      await command(target, stage.command);
      await delay(SAMPLE_MS);
    }
    await stopProfiling(STOP_MS);
    const loud = lastProfileResult();
    assert.ok(loud, 'a result with the heat map on');
    assert.ok(heatOn('Routing.fs').length > 0, 'the tint returns with the setting');
    assertPaletteDiscipline();
    for (const stage of stages) {
      assert.ok(
        hotFunction(loud, stage.identifier, stage.file),
        `[PROF-AGGREGATION-LOGIC] mixed keeps ${stage.identifier} hot`,
      );
      assertHeatMap(loud, { file: stage.file, first: stage.first, last: stage.last });
    }
    assert.equal(flamegraphPanelState()?.title, 'SharpLsp Profiler', 'one panel for the results');
    assert.deepEqual(
      appliedProfileDecorations().filter((decoration) => decoration.color === undefined),
      [],
      '[PROF-UI-HEATMAP] every CPU decoration carries a palette colour',
    );
    await command(target, 'idle');
  });
});

suite('F# soak — FsOrderLedger with CPU and memory tracking at once', () => {
  const live = profilingSuite('profiler-fs-soak-joint-', LEDGER, { stopping: endProfiling });

  test('the burn loop is the hotspot while memory tracks the same program: both tracks paint at once in different colours, stopping CPU leaves memory live, and the diff is taken on a running program', async function () {
    this.timeout(STOP_MS * 8);
    const { target } = live;

    // ── Interaction 1: the burn loop and the first batch, with both sources on screen.
    const warm = await command(target, 'burn on');
    assert.equal(count(warm, 'orders'), 0, 'a fresh burn starts from nothing');
    const batch = await command(target, 'place 300');
    assert.equal(count(batch, 'handlers'), 300, 'one handler per order');
    await showSources(LEDGER, ['Ledger.fs', 'Bus.fs', 'History.fs']);

    // ── Interaction 2: [PROFILER-SHARED-LIBRARY-VSCODE] both one-click flows on one program.
    await trackMemory(target.pid);
    assert.equal(profilerStore().profiler.value.memory, 'active', 'memory is tracking first');
    const row = await processRow(target.pid);
    const sessionId = await profileRow(row);
    await assertCpuLive(target.pid);
    assert.equal(
      keys().memoryTracking,
      true,
      '[PROF-MEMORY-SESSION] memory survives the CPU start',
    );
    await awaitLiveProgress();

    // ── Interaction 3: [PROF-CPU-REPORT] the burn loop is the hotspot of this session.
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
    assertStoreCoherent();
    assert.ok(
      liveResult.hotFunctions.some((fn) => within(PRICE_ALL, fn.file, fn.line ?? 0)),
      `the burn loop is hot: ${liveResult.hotFunctions.map((f) => f.name).join(', ')}`,
    );
    assertHeatMap(liveResult, PRICE_ALL);
    await vscode.commands.executeCommand(uiCommand('profileShowResults'));
    assertResultsPanel(liveResult, ['priceAll']);
    assert.ok(liveResult.totalSamples > 0, 'samples were recorded');
    assert.equal(profilerStore().profiler.value.memory, 'active', 'memory kept tracking');

    // ── Interaction 4: [PROF-UI-HEATMAP] the memory track paints during the CPU session too.
    const snap = await uiSnapshot();
    const wire = await snapshotSession(target.pid);
    assertAnchored(snap, SHAPES.order, 300);
    assert.equal(handlerSite(snap).count, 300, 'the handler closures are all reachable');
    assertDashboard(snap, 1, [SHAPES.order.type]);
    assertNoPhantomMemoryPaint(snap);
    assertSitesCoherent(snap);
    assertTimelineCoherent(snap);
    assertPaletteDiscipline();
    assertEveryShape(snap, batch);
    assert.ok(memoryStatusText()?.includes('tracking'), 'memory still tracks during the burn');
    assert.ok(heatOn('Ledger.fs').length > 0, 'the CPU heat map paints Ledger.fs');
    assert.ok(memoryTrackOn('Ledger.fs').length > 0, 'the memory track paints Ledger.fs');
    for (const cpuLine of heatOn('Ledger.fs')) {
      assert.ok(
        memoryTrackOn('Ledger.fs').every((memoryLine) => cpuLine.color !== memoryLine.color),
        'CPU and memory never share a colour on one file',
      );
    }

    // ── Interaction 5: more work in the same session grows the heap, not the sample count alone.
    const grew = await command(target, 'place 200');
    assert.equal(count(grew, 'orders'), 500, 'the second batch lands in the same session');
    const growth = await compareMemory(wire);
    assertConfidence(growth.leaks, SHAPES.order.type, 'Low', ['Ledger.fs']);
    assert.equal(
      wireLeak(growth.leaks, SHAPES.order.type)?.count_growth,
      200,
      '[PROF-MEMORY-COMPARE] exactly the new F# orders grew',
    );
    const after = await uiSnapshot(snap);
    assert.ok(after.currentMemory >= snap.currentMemory, 'the heap grew under the CPU session');
    assertAnchored(after, SHAPES.order, 500);
    assert.equal(after.timeline.length, 2, '[PROF-MEMORY-TIMELINE] one point per snapshot');
    assertSitesCoherent(after);
    assertTimelineCoherent(after);
    assertPaletteDiscipline();
    assertEveryShape(after, grew);

    // ── Interaction 6: stopping CPU leaves memory tracking and clears only the heat map.
    await stopProfiling(STOP_MS);
    await assertCpuIdle(target.pid);
    assert.equal(keys().memoryTracking, true, 'stopping CPU never stops memory');
    assert.equal(profilerStore().profiler.value.memory, 'active', 'the memory session is intact');
    assert.ok(memoryStatusText()?.includes('tracking'), `memory chrome: ${memoryStatusText()}`);
    assert.equal(profilerStatusText(), undefined, 'the CPU chrome is gone');
    assert.ok(memoryTrackOn('Ledger.fs').length > 0, 'the memory track stays painted');

    // ── Interaction 7: the process still answers after CPU stop, while memory tracks it.
    assert.equal(count(await command(target, 'burn off'), 'orders'), 500);

    // ── Interaction 8: stop everything; nothing survives.
    await command(target, 'burn off');
    await command(target, 'release all');
    await stopTracking();
    assert.equal(memoryStatusText(), undefined, 'the memory chrome hides');
    assert.deepEqual(appliedMemoryDecorations(), [], 'the memory track clears');
    assert.ok(heatOn('Ledger.fs').length > 0, 'the completed CPU report remains painted');
    assert.equal(
      flamegraphPanelState() !== undefined,
      true,
      '[PROF-UI-STATE] the results stay readable',
    );
    assert.deepEqual(keys(), {
      profiling: false,
      cpuBusy: false,
      memoryTracking: false,
      memoryBusy: false,
      profilerBusy: false,
    });
    assert.equal(processesViewState().badge, undefined, 'no badge once idle');
    completed(await execute<MemoryStep>('memory.stop', wire));
    assert.deepEqual(await sessions(), [], 'no CPU session is left running');
    assertStoreCoherent();
    assertPaletteDiscipline();
  });
});
