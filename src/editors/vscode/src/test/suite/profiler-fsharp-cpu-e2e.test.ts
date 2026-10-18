// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// CPU profiling of a real F# program, FsPricingEngine: a retail checkout backend
// whose workloads are the F# shapes a profiler must name and place —
//   - active patterns over CSV rows;
//   - a recursive discount-rule engine that matches every union case;
//   - Levenshtein search over a 2D array, ranked through a List.sortBy closure;
//   - Dijkstra over an immutable Set and Map with an inner `let rec`;
//   - seq expressions and a task {} builder.
// Every journey starts where a user starts: the program's row in the processes
// panel. It then reads back everything the editor shows: the live chrome, the
// gating keys, the heat map and its tiers, the results panel, and the three
// exported artifacts. lspkit's [PROF-CPU-START], [PROF-CPU-SNAPSHOT],
// [PROF-CPU-PROGRESS], [PROF-UI-CPU], [PROF-UI-HEATMAP], [PROF-EXPORT].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { lastProfileResult, recordedOperations } from '@nimblesite/lsp-profiler-ui';
import {
  disposeFlamegraphPanel,
  flamegraphPanelOpen,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-flamegraph-html';
import type { ProfileSessionList } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  execute,
  executeError,
  profilerStore,
  profilingSuite,
  setProfilerSetting,
  stopProfiling,
  uiCommand,
  waitFor,
} from './profiler-kit';
import {
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
  heatOn,
  hotFunction,
  processRow,
  profileRow,
  showSources,
  type Span,
  STOP_MS,
  within,
} from './profiler-fsharp-kit';

const SAMPLE_MS = 3_000;

/** One F# workload of FsPricingEngine and where its time must land. */
interface Workload {
  readonly command: string;
  readonly shape: string;
  /** Functions that must be hot, in `span.file`. The first names the artifacts. */
  readonly identifiers: readonly string[];
  /** The lines its hot lines fall in. */
  readonly span: Span;
}

const WORKLOADS: readonly Workload[] = [
  {
    command: 'parse',
    shape: 'active patterns over 2,000 CSV rows',
    identifiers: ['parseAll', 'parseLine'],
    span: { file: 'Csv.fs', first: 14, last: 39 },
  },
  {
    command: 'price',
    shape: 'a recursive discount-rule engine matching every union case',
    identifiers: ['basketTotal', 'applyRules'],
    span: { file: 'Pricing.fs', first: 10, last: 68 },
  },
  {
    command: 'search',
    shape: 'Levenshtein over a 2D array, ranked through a List.sortBy closure',
    identifiers: ['rank', 'distance'],
    span: { file: 'Search.fs', first: 10, last: 28 },
  },
  {
    command: 'route',
    shape: 'Dijkstra over an immutable Set and Map with an inner let rec',
    identifiers: ['shortestPath'],
    span: { file: 'Routing.fs', first: 29, last: 47 },
  },
  {
    command: 'report',
    shape: 'seq expressions grouped and summed, and a task {} builder',
    identifiers: ['dailyTotals'],
    span: { file: 'Reports.fs', first: 13, last: 47 },
  },
];

/**
 * Ground truth: the four pure-CPU stages of a mixed run, each entered through
 * exactly one F# function, whose time FsPricingEngine measures itself and
 * reports as `<stage>_us`. The report stage is left out: its task {} awaits
 * Task.Yield, so its wall time includes waiting, which a CPU sampler rightly
 * does not count.
 */
const GROUND_TRUTH = [
  { stage: 'parse', identifier: 'parseAll', file: 'Csv.fs' },
  { stage: 'price', identifier: 'basketTotal', file: 'Pricing.fs' },
  { stage: 'search', identifier: 'rank', file: 'Search.fs' },
  { stage: 'route', identifier: 'shortestPath', file: 'Routing.fs' },
] as const;
/** A stage that took at least this share of the measured time must be found. */
const MAJOR_SHARE = 0.15;
/** How far a sampled share may sit from the measured one. */
const SHARE_TOLERANCE = 0.15;

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

async function sessions(): Promise<ProfileSessionList['sessions']> {
  return (await execute<ProfileSessionList>('cpu.list', {})).sessions;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Both progress notifications opened and closed in order since `from`. */
function assertProgressClosed(from: number): void {
  const ops = recordedOperations().slice(from);
  for (const title of ['SharpLsp: Starting CPU profiler', 'SharpLsp: Stopping profiler']) {
    const begin = ops.indexOf(`begin:${title}`);
    assert.ok(begin !== -1, `"${title}" shows progress: ${ops.join(' | ')}`);
    assert.ok(ops.indexOf(`end:${title}`, begin) > begin, `"${title}" closes`);
  }
}

suite('F# CPU profiling — FsPricingEngine, one F# shape at a time', () => {
  const live = profilingSuite('profiler-fs-cpu-', ENGINE);
  teardown(async function () {
    this.timeout(STOP_MS * 2);
    await endProfiling();
    await setProfilerSetting('showInlineHeatMap', undefined);
    disposeFlamegraphPanel();
    await command(live.target, 'idle');
  });

  for (const workload of WORKLOADS) {
    test(`${workload.shape}: Profile CPU from the F# program's row → live chrome → UI snapshot → stop → heat map, results panel and artifacts name ${workload.identifiers.join(', ')}`, async function () {
      this.timeout(STOP_MS * 3);
      const { target } = live;
      const started = await command(target, `run ${workload.command}`);
      await showSources(ENGINE, [workload.span.file, 'Program.fs']);

      // The row the user clicks, before anything runs.
      const row = await processRow(target.pid);
      assertIdleRow(row, target.pid, ENGINE);
      assert.equal(profilerStore().profiler.value.cpu, 'idle', 'nothing profiles yet');

      // Click Profile CPU: the chrome, the keys and the wire agree on one session.
      const opsBefore = recordedOperations().length;
      const sessionId = await profileRow(row);
      await assertCpuLive(target.pid);
      const top = await awaitLiveProgress();
      assert.ok(top.length > 0, 'the live readout names a top function');
      const listed = (await sessions()).filter((s) => s.pid === target.pid);
      assert.equal(listed.length, 1, 'exactly one server session for the program');
      const [mine] = listed;
      assert.ok(mine);
      assert.equal(mine.session_id, sessionId, 'the UI drives the listed session');
      assert.equal(mine.runtime, 'dotnet');
      assert.ok(mine.runtime_version.length > 0, 'the runtime version is reported');
      assert.ok(!Number.isNaN(Date.parse(mine.started_at)), `RFC 3339 start: ${mine.started_at}`);
      assert.ok(mine.sample_count > 0, `the live count is real: ${mine.sample_count}`);

      // A second click and a second wire start are both refused; the session survives.
      await vscode.commands.executeCommand(uiCommand('profileProcess'), row);
      assert.equal(profilerStore().profiler.value.cpuSessionId, sessionId, 'the click is a no-op');
      const refused = await executeError('cpu.start', { pid: target.pid });
      assert.equal(refused?.code, -32004, `ALREADY_PROFILING: ${refused?.message}`);
      assert.equal((await sessions()).filter((s) => s.pid === target.pid).length, 1);

      // A UI snapshot reports the F# code so far and the session keeps running.
      await vscode.commands.executeCommand(uiCommand('profileSnapshot'));
      const snapshot = await waitFor(
        () => lastProfileResult(),
        (result) => result?.sessionId === sessionId,
        STOP_MS,
        'the snapshot result of this session',
      );
      assert.ok(snapshot);
      assertRanked(snapshot);
      for (const identifier of workload.identifiers) {
        assert.ok(
          hotFunction(snapshot, identifier, workload.span.file),
          `the snapshot already names ${identifier} in ${workload.span.file}: ${snapshot.hotFunctions.map((f) => f.name).join(', ')}`,
        );
      }
      assert.equal(profilerStore().profiler.value.cpu, 'active', 'a snapshot never ends it');
      await delay(SAMPLE_MS);

      // Stop: the session ends everywhere, and the result covers the whole run.
      await stopProfiling(STOP_MS);
      await assertCpuIdle(target.pid);
      assert.deepEqual(
        (await sessions()).filter((s) => s.pid === target.pid),
        [],
        'the stopped session leaves the list',
      );
      const result = lastProfileResult();
      assert.ok(result);
      assert.equal(result.sessionId, sessionId, 'the stop result is this session’s');
      assert.ok(
        result.totalSamples > snapshot.totalSamples,
        `sampling went on past the snapshot: ${result.totalSamples} > ${snapshot.totalSamples}`,
      );
      assertRanked(result);
      for (const identifier of workload.identifiers) {
        const fn = hotFunction(result, identifier, workload.span.file);
        assert.ok(fn, `${identifier} is hot in ${workload.span.file}`);
        assert.ok(fn.line >= 1, `${identifier} carries its F# line`);
      }
      assert.ok(
        result.hotLines.some((line) => within(workload.span, line.file, line.line)),
        `a hot line sits in ${workload.span.file} ${workload.span.first}-${workload.span.last}`,
      );
      assert.equal(
        heatOn('Program.fs').length > 0,
        result.hotLines.some((l) => l.file.endsWith('Program.fs')),
        'Program.fs is painted exactly when it has hot lines',
      );
      assertHeatMap(result, workload.span);
      assertResultsPanel(result, workload.identifiers);
      assertArtifacts(result, workload.identifiers[0] ?? '', workload.span.file);
      assertProgressClosed(opsBefore);

      // Closing the panel never strands the result: Show Profile Results re-opens it.
      disposeFlamegraphPanel();
      assert.equal(flamegraphPanelOpen(), false);
      await vscode.commands.executeCommand(uiCommand('profileShowResults'));
      await waitFor(
        () => flamegraphPanelOpen(),
        (open) => open,
        5_000,
        'the panel re-opens',
      );
      assertResultsPanel(result, workload.identifiers);

      // Attaching was never invasive: the program kept working throughout.
      const after = await command(target, 'stats');
      assert.ok(
        count(after, 'iterations') > count(started, 'iterations'),
        `the F# program kept running under the profiler: ${JSON.stringify(after)}`,
      );
    });
  }

  test('one session, two phases: parse → snapshot → switch to search → snapshot → stop paints both files; heat map off, then a mixed run paints every module', async function () {
    this.timeout(STOP_MS * 5);
    const { target } = live;
    const [parse, search, route] = WORKLOADS.filter((w) =>
      ['parse', 'search', 'route'].includes(w.command),
    );
    assert.ok(parse && search && route);
    await command(target, 'run parse');
    await showSources(ENGINE, ['Csv.fs', 'Search.fs']);
    const sessionId = await profileRow(await processRow(target.pid));
    await awaitLiveProgress();

    // Phase one: only CSV parsing has run, so search cannot be hot yet.
    await vscode.commands.executeCommand(uiCommand('profileSnapshot'));
    const first = await waitFor(
      () => lastProfileResult(),
      (r) => r?.sessionId === sessionId,
      STOP_MS,
      'phase-one snapshot',
    );
    assert.ok(first && hotFunction(first, 'parseAll', 'Csv.fs'), 'parsing is hot in phase one');
    assert.equal(hotFunction(first, 'distance', 'Search.fs'), undefined, 'search never ran yet');

    // Phase two: the same session sees the switch.
    await command(target, 'run search');
    await delay(SAMPLE_MS * 2);
    await vscode.commands.executeCommand(uiCommand('profileSnapshot'));
    const second = await waitFor(
      () => lastProfileResult(),
      (r) =>
        r !== first &&
        r?.sessionId === sessionId &&
        hotFunction(r, 'distance', 'Search.fs') !== undefined,
      STOP_MS,
      'phase-two snapshot naming distance',
    );
    assert.ok(second);
    assert.ok(second.totalSamples > first.totalSamples, 'the second snapshot covers more');
    assert.ok(hotFunction(second, 'parseAll', 'Csv.fs'), 'phase one is still in the session');
    await stopProfiling(STOP_MS);
    const both = lastProfileResult();
    assert.ok(both && both.totalSamples >= second.totalSamples, 'the stop covers both phases');
    assertHeatMap(both, parse.span);
    assertHeatMap(both, search.span);

    // Heat map off: the result still lands in the panel, but no tint is painted.
    await setProfilerSetting('showInlineHeatMap', false);
    await command(target, 'run route');
    await showSources(ENGINE, ['Routing.fs']);
    const routed = await profileRow(await processRow(target.pid));
    await awaitLiveProgress();
    await stopProfiling(STOP_MS);
    const quiet = lastProfileResult();
    assert.ok(quiet?.sessionId === routed, 'a second session on the same program');
    assert.ok(hotFunction(quiet, 'shortestPath', 'Routing.fs'), 'routing is hot');
    assert.deepEqual(heatOn('Routing.fs'), [], 'the setting turns the tint off');
    assertResultsPanel(quiet, ['shortestPath']);

    // Heat map back on, every workload at once: each module is hot and painted.
    await setProfilerSetting('showInlineHeatMap', true);
    await command(target, 'run mixed');
    const files = WORKLOADS.map((w) => w.span.file);
    await showSources(ENGINE, files);
    await profileRow(await processRow(target.pid));
    await awaitLiveProgress();
    await delay(SAMPLE_MS * 2);
    await stopProfiling(STOP_MS);
    const mixed = lastProfileResult();
    assert.ok(mixed);
    assertRanked(mixed);
    for (const workload of WORKLOADS) {
      const identifier = workload.identifiers[0] ?? '';
      assert.ok(hotFunction(mixed, identifier, workload.span.file), `mixed: ${identifier} is hot`);
      assertHeatMap(mixed, workload.span);
    }
    assertResultsPanel(
      mixed,
      WORKLOADS.map((w) => w.identifiers[0] ?? ''),
    );
    await command(target, 'idle');
  });

  test('the profiler tells the truth about where F# time goes: on a mixed run, each stage’s share of the samples matches the share FsPricingEngine measured with its own Stopwatch, and the stages rank in the same order', async function () {
    this.timeout(STOP_MS * 3);
    const { target } = live;
    await command(target, 'run mixed');
    await showSources(ENGINE, ['Csv.fs', 'Search.fs', 'Routing.fs']);
    const before = await command(target, 'stats');
    await profileRow(await processRow(target.pid));
    await awaitLiveProgress();
    await delay(SAMPLE_MS * 3);
    await stopProfiling(STOP_MS);
    const after = await command(target, 'stats');
    const result = lastProfileResult();
    assert.ok(result);
    assertRanked(result);

    // The four pure-CPU stages, each entered through exactly one F# function.
    const stages = GROUND_TRUTH.map((stage) => ({
      ...stage,
      micros: count(after, `${stage.stage}_us`) - count(before, `${stage.stage}_us`),
      sampled: hotFunction(result, stage.identifier, stage.file)?.percentage ?? 0,
    }));
    const measuredTotal = stages.reduce((sum, s) => sum + s.micros, 0);
    const sampledTotal = stages.reduce((sum, s) => sum + s.sampled, 0);
    assert.ok(measuredTotal > 0, `the program measured its own stages: ${JSON.stringify(after)}`);
    assert.ok(sampledTotal > 0, 'the profiler attributed samples to the stages');
    const shares = stages.map((s) => ({
      ...s,
      truth: s.micros / measuredTotal,
      seen: s.sampled / sampledTotal,
    }));
    const major = shares.filter((s) => s.truth >= MAJOR_SHARE);
    assert.ok(major.length >= 2, `at least two stages carry real time: ${JSON.stringify(shares)}`);
    for (const stage of major) {
      assert.ok(stage.sampled > 0, `${stage.identifier} took ${pct(stage.truth)} and must be hot`);
      assert.ok(
        Math.abs(stage.seen - stage.truth) <= SHARE_TOLERANCE,
        `${stage.identifier}: the profiler says ${pct(stage.seen)}, the Stopwatch ${pct(stage.truth)}`,
      );
    }
    const ranked = [...major].sort((a, b) => b.truth - a.truth);
    for (const [index, higher] of ranked.entries()) {
      const lower = ranked[index + 1];
      if (lower !== undefined && higher.truth >= lower.truth * 1.5) {
        assert.ok(
          higher.sampled > lower.sampled,
          `${higher.identifier} (${pct(higher.truth)}) must outrank ${lower.identifier} (${pct(lower.truth)})`,
        );
      }
    }
  });
});
