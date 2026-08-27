// Coarse end-to-end coverage for pressing ⏹ (Stop) in the Test Explorer, against
// a REAL F# xUnit project built by the real `dotnet` CLI.
//
// Stop has to do something OBSERVABLE, and a cancellation test that only checks
// outcomes cannot see whether it did: a run that ignores cancellation entirely
// still leaves a red test red and a skipped test skipped. So the fixture carries
// a deliberately LONG-RUNNING test that writes a `started` marker, sleeps, and
// then writes a `finished` marker. That makes both halves of the contract
// falsifiable on disk:
//
//   • the CONTROL run is not cancelled, so both markers appear and the outcome
//     is cached — proving the fixture really does write `finished`, and so that
//     its ABSENCE below means something,
//   • the CANCELLED run presses Stop the moment `started` appears, so `finished`
//     must NEVER appear even long after the sleep would have elapsed. `dotnet
//     test` runs tests in a testhost GRANDCHILD, so this fails unless the whole
//     process TREE is terminated, not just the `dotnet` parent,
//   • and no result may be cached for either selected test, because a result
//     that arrives after Stop describes a run that was killed mid-flight.
//
// Covers [TEST-RUN-TRX] and the Stop half of [TEST-EXPLORER]. F# first.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  createSolution,
  projectXml,
  warmDiscovery,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  activateTestExplorer,
  collectItemIds,
  drainDiscovery,
  pollUntilDiscovered,
  runAndCancelWhen,
  runViaProfile,
} from './test-explorer-kit';
import { itemsFor, sorted } from './test-explorer-outcome-assertions';
import { pollUntilResult, removeDirRecursive, sleep } from './test-helpers.js';

/** A cold restore + build plus a control run that deliberately takes its time. */
const SUITE_TIMEOUT_MS = 900_000;

/**
 * How long the long-running fixture test sleeps.
 *
 * Long enough that an UNCANCELLED run cannot possibly finish inside
 * {@link STOP_BUDGET_MS}, and short enough that the control run — which waits
 * the whole sleep out — stays cheap.
 */
const FIXTURE_SLEEP_SECONDS = 20;
const FIXTURE_SLEEP_MS = FIXTURE_SLEEP_SECONDS * 1_000;

/**
 * How long the run handler may take to return AFTER Stop is pressed.
 *
 * Comfortably under {@link FIXTURE_SLEEP_MS}: a run that merely awaited the
 * batch instead of killing it could not return this early.
 */
const STOP_BUDGET_MS = 12_000;

/** Extra time past the sleep before concluding the process is really gone. */
const TERMINATION_GRACE_MS = 15_000;

/** How long to wait for the long test to announce that it has started. */
const START_TIMEOUT_MS = 300_000;

/** Marker file names the fixture writes. */
const STARTED_MARKER = 'started';
const FINISHED_MARKER = 'finished';

/** The long-running F# test, and the fast one batched alongside it. */
const LONG_TEST = 'Fs.Cancel.Fixtures.sleeps until stopped';
const FAST_TEST = 'Fs.Cancel.Fixtures.adds two numbers';
const ALL_TESTS: readonly string[] = [LONG_TEST, FAST_TEST];

/**
 * The fixture source, with the marker directory baked in as an F# literal.
 *
 * The directory is only known once the temp root exists, and separators are
 * normalised to `/` — .NET accepts them on every platform, so no escaping of
 * Windows backslashes is needed inside the literal.
 */
function fixtureSource(markerDir: string): string {
  return [
    'module Fs.Cancel.Fixtures',
    '',
    'open System',
    'open System.IO',
    'open System.Threading',
    'open Xunit',
    '',
    `let private markers = "${markerDir.split(path.sep).join('/')}"`,
    '',
    'let private mark (name: string) = File.WriteAllText(Path.Combine(markers, name), "1")',
    '',
    '[<Fact>]',
    'let ``sleeps until stopped`` () =',
    `    mark "${STARTED_MARKER}"`,
    `    Thread.Sleep(TimeSpan.FromSeconds ${String(FIXTURE_SLEEP_SECONDS)}.0)`,
    `    mark "${FINISHED_MARKER}"`,
    '',
    '[<Fact>]',
    'let ``adds two numbers`` () = Assert.Equal(3, 1 + 2)',
    '',
  ].join('\n');
}

suite('Test Explorer e2e — pressing Stop kills the run', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let markerDir: string;
  let startedMarker: string;
  let finishedMarker: string;

  /** True once the fixture has written `name` into the marker directory. */
  const marked = (name: string): boolean => fs.existsSync(path.join(markerDir, name));

  /** Resolve once the long test announces it is running, else after the timeout. */
  const untilStarted = async (): Promise<boolean> =>
    pollUntilResult(
      () => Promise.resolve(marked(STARTED_MARKER)),
      (seen) => seen,
      START_TIMEOUT_MS,
    );

  suiteSetup(async function () {
    this.timeout(SUITE_TIMEOUT_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testcancel-'));
    markerDir = path.join(root, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });
    startedMarker = path.join(markerDir, STARTED_MARKER);
    finishedMarker = path.join(markerDir, FINISHED_MARKER);
    const projectDir = writeProject(
      path.join(root, 'CancelFs'),
      'CancelFs.fsproj',
      projectXml(XUNIT_PACKAGES, 'Tests.fs'),
      'Tests.fs',
      fixtureSource(markerDir),
    );
    const slnPath = await createSolution(root, 'Cancellation', [projectDir]);
    // Pay restore, build and adapter JIT once, so a run measures the RUN.
    await warmDiscovery(slnPath, root);
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await drainDiscovery(() => undefined, api.testController);
    await pollUntilDiscovered(api.testController, ALL_TESTS);
  });

  suiteTeardown(async function () {
    this.timeout(SUITE_TIMEOUT_MS);
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('a run left alone writes BOTH markers and caches both outcomes', async function () {
    this.timeout(SUITE_TIMEOUT_MS);
    // The control. Without it, "the finished marker is absent" below could hold
    // simply because the fixture never writes one.
    assert.deepStrictEqual(
      sorted(collectItemIds(api.testController.items)),
      sorted(ALL_TESTS),
      'exactly the long test and the fast test must be discovered',
    );
    assert.strictEqual(fs.existsSync(startedMarker), false, 'no run has happened yet');
    assert.strictEqual(fs.existsSync(finishedMarker), false, 'so neither marker exists');
    const items = itemsFor(api, ALL_TESTS);
    assert.strictEqual(items.length, 2, 'both fixture tests resolved to tree items');
    const started = Date.now();
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    const elapsed = Date.now() - started;
    assert.strictEqual(
      fs.existsSync(startedMarker),
      true,
      'the long test must actually have run — otherwise nothing below tests anything',
    );
    assert.strictEqual(
      fs.existsSync(finishedMarker),
      true,
      'and must have run to COMPLETION, writing its finish marker',
    );
    assert.ok(
      elapsed >= FIXTURE_SLEEP_MS,
      `an uncancelled run waits the whole ${String(FIXTURE_SLEEP_SECONDS)}s out, took ${String(elapsed)}ms`,
    );
    const long = api.testController.getResult(LONG_TEST);
    const fast = api.testController.getResult(FAST_TEST);
    assert.ok(long, `the control run must cache a result for ${LONG_TEST}`);
    assert.ok(fast, `and one for ${FAST_TEST}`);
    assert.strictEqual(long.outcome, 'passed', 'the long test passes when left alone');
    assert.strictEqual(fast.outcome, 'passed', 'and so does the fast one batched with it');
    assert.strictEqual(long.passed, true, 'a real pass carries the pass flag');
    assert.strictEqual(fast.passed, true, 'for both tests of the single batched invocation');
  });

  test('pressing Stop TERMINATES the running test process and suppresses its results', async function () {
    this.timeout(SUITE_TIMEOUT_MS);
    fs.rmSync(startedMarker, { force: true });
    fs.rmSync(finishedMarker, { force: true });
    assert.strictEqual(fs.existsSync(startedMarker), false, 'markers cleared before the run');
    assert.strictEqual(fs.existsSync(finishedMarker), false, 'both of them');
    const baseline = new Map(api.testController.cachedResults);
    assert.strictEqual(
      baseline.get(LONG_TEST)?.outcome,
      'passed',
      'the control run left a PASS cached, so a suppressed result is visibly different',
    );
    let stoppedAt = 0;
    const trigger = untilStarted().then((seen) => {
      stoppedAt = Date.now();
      return seen;
    });
    await assert.doesNotReject(async () => {
      await runAndCancelWhen(
        api.testController,
        vscode.TestRunProfileKind.Run,
        itemsFor(api, ALL_TESTS),
        trigger,
      );
    }, 'a cancelled run must resolve, never reject — a rejected runHandler leaves the run spinning');
    const afterStop = Date.now() - stoppedAt;
    assert.strictEqual(
      await trigger,
      true,
      'the long test must have started, or Stop cancelled nothing at all',
    );
    assert.strictEqual(fs.existsSync(startedMarker), true, 'and said so on disk');
    assert.ok(
      afterStop < STOP_BUDGET_MS,
      `Stop must END the run, not wait it out: returned ${String(afterStop)}ms after Stop, ` +
        `budget ${String(STOP_BUDGET_MS)}ms, fixture sleep ${String(FIXTURE_SLEEP_MS)}ms`,
    );

    // Past the point where a SURVIVING test process would have written `finished`.
    await sleep(FIXTURE_SLEEP_MS + TERMINATION_GRACE_MS - afterStop);
    assert.strictEqual(
      fs.existsSync(finishedMarker),
      false,
      'the spawned test process must be TERMINATED by Stop — it wrote its finish marker, ' +
        'so `dotnet test` (or the testhost grandchild it spawns) outlived the cancellation',
    );
    assert.deepStrictEqual(
      api.testController.getResult(LONG_TEST),
      baseline.get(LONG_TEST),
      'a result arriving after Stop must be SUPPRESSED, leaving the last real run standing',
    );
    assert.deepStrictEqual(
      api.testController.getResult(FAST_TEST),
      baseline.get(FAST_TEST),
      'including for the fast test batched into the same invocation',
    );
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'a cancelled run invents no cache entries',
    );
    assert.deepStrictEqual(
      sorted(collectItemIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and leaves the tree exactly as it was',
    );
    const idleAt = Date.now();
    await api.testController.whenIdle();
    assert.ok(
      Date.now() - idleAt < STOP_BUDGET_MS,
      'the cancelled invocation must be OVER, not merely abandoned while still running',
    );
  });
});
