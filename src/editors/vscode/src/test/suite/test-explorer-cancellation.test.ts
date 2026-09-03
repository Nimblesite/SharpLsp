// Coarse end-to-end coverage for pressing ⏹ (Stop) in the Test Explorer, against
// a REAL F# xUnit project built by the real `dotnet` CLI.
//
// Stop has to do something OBSERVABLE, and a cancellation test that only checks
// outcomes cannot see whether it did: a run that ignores cancellation entirely
// still leaves a red test red and a skipped test skipped. So the fixture carries
// two deliberately LONG-RUNNING tests that each write a `started` marker, sleep,
// and then write a `finished` marker. That makes every half of the contract
// falsifiable on disk:
//
//   • the CONTROL run is not cancelled, so every marker appears and every
//     outcome is cached — proving the fixture really does write `finished`, and
//     so that its ABSENCE below means something,
//   • the CANCELLED run presses Stop the moment `started` appears, so `finished`
//     must NEVER appear even long after the sleep would have elapsed. `dotnet
//     test` runs tests in a testhost GRANDCHILD, so this fails unless the whole
//     process TREE is terminated, not just the `dotnet` parent,
//   • no result may be cached for any selected test, because a result that
//     arrives after Stop describes a run that was killed mid-flight,
//   • and the controller's single `dotnet` queue ([TEST-REACTIVITY]) must be
//     DRAINED afterwards, not left holding an abandoned invocation: the next ▶
//     the user presses has to work.
//
// The permutations are the gestures a user actually makes: Stop on ▶, on Run
// with Coverage, on a namespace row, on the assembly root, on a multi-select, a
// token that was already cancelled before the handler started, Stop pressed
// twice, Stop after the run already ended, and two cancelled runs back to back.
//
// Covers [TEST-RUN-TRX], [TEST-REACTIVITY], [TEST-COVERAGE] and the Stop half of
// [TEST-EXPLORER]. F# first.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { findCoberturaFiles } from '../../test-coverage.js';
import { filterClause } from '../../test-filter.js';
import { statusLensTitle } from '../../test-lens.js';
import {
  createSolution,
  projectXml,
  warmDiscovery,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import { COVERAGE_DIR_NAME, COVERLET_PACKAGE, reportDirsOf } from './test-coverage-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  drainDiscovery,
  findItem,
  pollUntilDiscovered,
  rootsOf,
  runAlreadyCancelled,
  runAndCancelWhen,
  runViaProfile,
} from './test-explorer-kit';
import { itemsFor, sorted } from './test-explorer-outcome-assertions';
import { pollUntilResult, removeDirRecursive, sleep } from './test-helpers.js';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/**
 * How long each long-running fixture test sleeps.
 *
 * Long enough that an UNCANCELLED run cannot possibly finish inside
 * {@link STOP_BUDGET_MS}, and short enough that the control run — which waits
 * every sleep out — stays affordable.
 */
const FIXTURE_SLEEP_SECONDS = 12;
const FIXTURE_SLEEP_MS = FIXTURE_SLEEP_SECONDS * 1_000;

/**
 * How long the run handler may take to return AFTER Stop is pressed.
 *
 * Comfortably under {@link FIXTURE_SLEEP_MS}: a run that merely awaited the
 * batch instead of killing it could not return this early.
 */
const STOP_BUDGET_MS = 6_000;

/** How fast a run must return when its token was cancelled before it began. */
const PRE_CANCELLED_BUDGET_MS = 4_000;

/** Extra time past the sleep before concluding the process is really gone. */
const TERMINATION_GRACE_MS = 8_000;

/** The F# module every fixture test lives in — the tree's namespace row. */
const NAMESPACE = 'Fs.Cancel.Fixtures';

/**
 * How that module renders: a CLASS row named for the TYPE under a NAMESPACE
 * row carrying the rest. An F# module compiles to a CLR type, so the tree
 * splits `Fs.Cancel.Fixtures` exactly as it splits a C# class.
 */
const MODULE_TYPE = NAMESPACE.slice(NAMESPACE.lastIndexOf('.') + 1);
const MODULE_NAMESPACE = NAMESPACE.slice(0, NAMESPACE.lastIndexOf('.'));

/** The project, which is also the assembly root's label. */
const PROJECT = 'CancelFs';

/** One long-running fixture test and the two markers it writes. */
interface LongTest {
  readonly binding: string;
  readonly fqn: string;
  readonly started: string;
  readonly finished: string;
}

const longTest = (binding: string, suffix: string): LongTest => ({
  binding,
  fqn: `${NAMESPACE}.${binding}`,
  started: `started-${suffix}`,
  finished: `finished-${suffix}`,
});

/**
 * Two long tests, not one.
 *
 * A single one cannot distinguish "the run was cancelled" from "the one test
 * that was running was cancelled": a selection of two proves Stop ends the whole
 * BATCH, because xUnit runs both facts of one module sequentially, so whichever
 * is second must never even start.
 *
 * WHICH is second is xUnit's choice, not this file's. `DefaultTestCaseOrderer`
 * sorts the facts of a class by a hash of their names, so source order predicts
 * nothing — every assertion below names the test Stop actually caught, and the
 * ones queued behind it, rather than assuming an index.
 */
const LONG_TESTS: readonly LongTest[] = [
  longTest('sleeps until stopped', 'one'),
  longTest('also sleeps until stopped', 'two'),
];

/** The fast test batched alongside them. */
const FAST_TEST = `${NAMESPACE}.adds two numbers`;

/** Every test the fixture exposes. */
const ALL_TESTS: readonly string[] = [...LONG_TESTS.map((each) => each.fqn), FAST_TEST];

/** Every marker file an uncancelled run of the whole fixture writes. */
const EVERY_MARKER: readonly string[] = LONG_TESTS.flatMap((each) => [each.started, each.finished]);

/**
 * The fixture source, with the marker directory baked in as an F# literal.
 *
 * The directory is only known once the temp root exists, and separators are
 * normalised to `/` — .NET accepts them on every platform, so no escaping of
 * Windows backslashes is needed inside the literal.
 */
function fixtureSource(markerDir: string): string {
  const sleeper = (each: LongTest): string[] => [
    '[<Fact>]',
    `let \`\`${each.binding}\`\` () =`,
    `    mark "${each.started}"`,
    `    Thread.Sleep(TimeSpan.FromSeconds ${String(FIXTURE_SLEEP_SECONDS)}.0)`,
    `    mark "${each.finished}"`,
    '',
  ];
  return [
    `module ${NAMESPACE}`,
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
    ...LONG_TESTS.flatMap(sleeper),
    '[<Fact>]',
    'let ``adds two numbers`` () = Assert.Equal(3, 1 + 2)',
    '',
  ].join('\n');
}

suite('Test Explorer e2e — pressing Stop kills the run', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let markerDir: string;
  let coverageDir: string;

  /** True once the fixture has written `name` into the marker directory. */
  const marked = (name: string): boolean => fs.existsSync(path.join(markerDir, name));

  /** Every marker currently on disk, so a failure names what actually ran. */
  const markersOnDisk = (): string[] => fs.readdirSync(markerDir).sort();

  /** Wipe every marker, so the next run's evidence is its own. */
  const clearMarkers = (): void => {
    for (const name of fs.readdirSync(markerDir)) {
      fs.rmSync(path.join(markerDir, name), { force: true });
    }
  };

  /** Every long test that has announced itself, in the order they are declared. */
  const startedLongTests = (): LongTest[] => LONG_TESTS.filter((each) => marked(each.started));

  /** The long tests xUnit had QUEUED behind `running` when Stop landed. */
  const queuedBehind = (running: LongTest): LongTest[] =>
    LONG_TESTS.filter((each) => each.fqn !== running.fqn);

  /**
   * Resolve with the long test xUnit actually started FIRST — the "the run is
   * under way" signal.
   *
   * It polls for ANY long test's `started` marker rather than a named one on
   * purpose. xUnit picks the order (see {@link LONG_TESTS}), so waiting on a
   * named marker waits the OTHER test's entire sleep out first, and then presses
   * Stop on a batch whose earlier test has already legitimately finished —
   * indistinguishable, from the markers alone, from a cancellation that failed.
   *
   * The ceiling is one CLI round trip: the marker lands a second or two into the
   * `dotnet test` invocation, not a whole fixture sleep later.
   */
  const untilRunning = async (): Promise<LongTest | undefined> =>
    pollUntilResult(
      () => Promise.resolve(startedLongTests()[0]),
      (found) => found !== undefined,
      DOTNET_CLI_MS,
    );

  /** How fast one Stop gesture returned, and which long test it caught running. */
  interface StopOutcome {
    readonly afterStop: number;
    readonly running: LongTest;
  }

  /**
   * Press ▶/coverage on `items` and press ⏹ the moment the run is demonstrably
   * under way, reporting how long the handler took to return after Stop and
   * which long test was executing when it did.
   */
  const runAndStop = async (
    kind: vscode.TestRunProfileKind,
    items: readonly vscode.TestItem[],
  ): Promise<StopOutcome> => {
    let stoppedAt = 0;
    const trigger = untilRunning().then((seen) => {
      stoppedAt = Date.now();
      return seen;
    });
    await assert.doesNotReject(async () => {
      await runAndCancelWhen(api.testController, kind, items, trigger);
    }, 'a cancelled run must resolve, never reject — a rejected runHandler leaves the run spinning');
    const running = await trigger;
    assert.ok(running, 'a long test must have started, or Stop cancelled nothing at all');
    return { afterStop: Date.now() - stoppedAt, running };
  };

  /**
   * Assert Stop ended the whole batch: the test it caught was TERMINATED rather
   * than waited out, and every test queued behind it never ran at all.
   *
   * Call it only after the fixture sleep has demonstrably elapsed, so a process
   * that survived has had every chance to write its finish marker.
   */
  const assertBatchKilled = (running: LongTest, why: string): void => {
    const markers = (): string => markersOnDisk().join(', ') || '(none)';
    for (const each of LONG_TESTS) {
      assert.strictEqual(
        marked(each.finished),
        false,
        `${each.fqn} must be TERMINATED by Stop ${why} — it wrote its finish marker, so ` +
          '`dotnet test` (or the testhost grandchild it spawns) outlived the cancellation; ' +
          `markers on disk: ${markers()}`,
      );
    }
    for (const queued of queuedBehind(running)) {
      assert.strictEqual(
        marked(queued.started),
        false,
        `Stop ends the whole BATCH ${why}: ${queued.fqn} was queued behind ${running.fqn} ` +
          `and must never start; markers on disk: ${markers()}`,
      );
    }
    assert.deepStrictEqual(
      startedLongTests().map((each) => each.fqn),
      [running.fqn],
      `exactly the one test Stop caught ever ran ${why}; markers on disk: ${markers()}`,
    );
  };

  /** Assert the controller's queue really drained, and how fast. */
  const assertIdlePromptly = async (why: string): Promise<void> => {
    const idleAt = Date.now();
    await api.testController.whenIdle();
    assert.ok(
      Date.now() - idleAt < STOP_BUDGET_MS,
      `${why}: the cancelled invocation must be OVER, not merely abandoned while still running`,
    );
  };

  suiteSetup(async function () {
    // Cold restore + build + VSTest adapter JIT over the fixture solution.
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testcancel-'));
    markerDir = path.join(root, 'markers');
    coverageDir = path.join(root, COVERAGE_DIR_NAME);
    fs.mkdirSync(markerDir, { recursive: true });
    const projectDir = writeProject(
      path.join(root, PROJECT),
      `${PROJECT}.fsproj`,
      // `coverlet.collector` is what turns `--collect:"XPlat Code Coverage"`
      // into a report on disk. Without it a coverage run writes NOTHING, and
      // "the killed run left no report" holds for a reason that has nothing to
      // do with cancellation — so does "the completed run left one", falsely.
      projectXml([...XUNIT_PACKAGES, COVERLET_PACKAGE], 'Tests.fs'),
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
    this.timeout(DOTNET_CLI_MS);
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('a run left alone writes EVERY marker and caches every outcome', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The control. Without it, "the finished marker is absent" below could hold
    // simply because the fixture never writes one.
    //
    // Interaction 1 — the tree is exactly the fixture, and nothing has run.
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'both long tests and the fast test must be discovered',
    );
    clearMarkers();
    assert.deepStrictEqual(markersOnDisk(), [], 'no run has happened yet, so no markers exist');
    const items = itemsFor(api, ALL_TESTS);
    assert.strictEqual(
      items.length,
      ALL_TESTS.length,
      'every fixture test resolved to a tree item',
    );
    assert.deepStrictEqual(
      items.map((item) => item.id),
      [...ALL_TESTS],
      'and to the tests actually selected',
    );

    // Interaction 2 — press ▶ and let it finish. Every long test runs to
    // COMPLETION, and the run really did wait for them.
    const started = Date.now();
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    const elapsed = Date.now() - started;
    assert.deepStrictEqual(
      markersOnDisk(),
      sorted(EVERY_MARKER),
      'each long test must write both its markers when left alone — otherwise nothing ' +
        'below tests anything',
    );
    assert.ok(
      elapsed >= FIXTURE_SLEEP_MS * LONG_TESTS.length,
      `an uncancelled run waits every ${String(FIXTURE_SLEEP_SECONDS)}s sleep out; ` +
        `took ${String(elapsed)}ms for ${String(LONG_TESTS.length)} of them`,
    );

    // Interaction 3 — every outcome is cached, green, and renders as a pass.
    for (const id of ALL_TESTS) {
      const result = api.testController.getResult(id);
      assert.ok(result, `the control run must cache a result for ${id}`);
      assert.strictEqual(result.outcome, 'passed', `${id} passes when left alone`);
      assert.strictEqual(result.passed, true, `${id} carries the pass flag`);
      assert.strictEqual(
        (result.message ?? '').includes('No result reported'),
        false,
        `${id} really ran, so it reports no missing-result note`,
      );
      assert.ok(Number(result.duration) >= 0, `${id} carries a measured duration`);
      assert.strictEqual(
        statusLensTitle(result).startsWith('$(pass) Passed'),
        true,
        `${id} renders above its binding as a pass`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size >= ALL_TESTS.length,
      true,
      'one batched invocation reported every selected test',
    );
  });

  test('pressing Stop TERMINATES the running test process TREE and suppresses its results', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — a clean slate, and a cache that already holds real passes,
    // so a suppressed result is visibly different from a fresh one.
    clearMarkers();
    assert.deepStrictEqual(markersOnDisk(), [], 'markers cleared before the run');
    const baseline = new Map(api.testController.cachedResults);
    for (const id of ALL_TESTS) {
      assert.strictEqual(
        baseline.get(id)?.outcome,
        'passed',
        `the control run left a PASS cached for ${id}`,
      );
    }

    // Interaction 2 — press ▶, then ⏹ the moment the first long test announces
    // itself. Stop must END the run, not wait it out.
    const { afterStop, running } = await runAndStop(
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );
    assert.strictEqual(marked(running.started), true, 'the run really was under way');
    assert.ok(
      afterStop < STOP_BUDGET_MS,
      `Stop must END the run: returned ${String(afterStop)}ms after Stop, budget ` +
        `${String(STOP_BUDGET_MS)}ms, fixture sleep ${String(FIXTURE_SLEEP_MS)}ms`,
    );

    // Interaction 3 — past the point where a SURVIVING test process would have
    // written `finished`, no long test has finished and none of the ones queued
    // behind it ever started.
    await sleep(FIXTURE_SLEEP_MS + TERMINATION_GRACE_MS - afterStop);
    assertBatchKilled(running, 'on ▶');

    // Interaction 4 — every result is suppressed, the cache is untouched and the
    // tree is exactly as it was.
    for (const id of ALL_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(id),
        baseline.get(id),
        `a result arriving after Stop must be SUPPRESSED for ${id}, leaving the last real run standing`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'a cancelled run invents no cache entries',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and leaves the tree exactly as it was',
    );
    await assertIdlePromptly('after Stop on ▶');
  });

  test('pressing Stop during a Run with Coverage kills it and attaches no report', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — a clean slate. Coverage lands beside the solution, and
    // nothing is there yet.
    clearMarkers();
    removeDirRecursive(coverageDir);
    assert.deepStrictEqual(markersOnDisk(), [], 'markers cleared');
    assert.strictEqual(fs.existsSync(coverageDir), false, `${COVERAGE_DIR_NAME} starts absent`);
    const baseline = new Map(api.testController.cachedResults);

    // Interaction 2 — Run with Coverage, then ⏹. The coverage profile spawns the
    // same batched `dotnet test`, so Stop has the same contract on it.
    const { afterStop, running } = await runAndStop(
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_TESTS),
    );
    assert.ok(
      afterStop < STOP_BUDGET_MS,
      `Stop must end a COVERAGE run just as promptly: ${String(afterStop)}ms`,
    );

    // Interaction 3 — the process tree is dead, so no long test finished…
    await sleep(FIXTURE_SLEEP_MS + TERMINATION_GRACE_MS - afterStop);
    assertBatchKilled(running, 'under the Coverage profile too');

    // Interaction 4 — …and nothing from the killed run is reported: no outcome,
    // and no Cobertura report describing coverage that was never collected.
    for (const id of ALL_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(id),
        baseline.get(id),
        `a cancelled coverage run must suppress ${id}'s result too`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'and invent no cache entries',
    );
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir),
      [],
      'a run killed mid-flight collected nothing, so it must leave no Cobertura report ' +
        'for the gutter to paint from',
    );
    await assertIdlePromptly('after Stop on Run with Coverage');
  });

  test('a token already cancelled before the handler starts spawns nothing at all', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — clean slate. The workbench can hand the handler a token
    // that is already cancelled: the user pressed ⏹ while the run was queued.
    clearMarkers();
    const baseline = new Map(api.testController.cachedResults);
    assert.deepStrictEqual(markersOnDisk(), [], 'nothing has run');

    // Interaction 2 — the handler must resolve, and fast: it has nothing to do.
    const started = Date.now();
    await assert.doesNotReject(async () => {
      await runAlreadyCancelled(
        api.testController,
        vscode.TestRunProfileKind.Run,
        itemsFor(api, ALL_TESTS),
      );
    }, 'a pre-cancelled run must resolve, never reject');
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < PRE_CANCELLED_BUDGET_MS,
      `a run whose token was already cancelled must not restore, build and execute ` +
        `anything; it took ${String(elapsed)}ms`,
    );

    // Interaction 3 — no test process was ever spawned, so not one marker was
    // written, even after the sleep would have elapsed.
    await sleep(FIXTURE_SLEEP_MS);
    assert.deepStrictEqual(
      markersOnDisk(),
      [],
      'a pre-cancelled run must not spawn a test process whose results it would then ' +
        `have to throw away; markers written: ${markersOnDisk().join(', ') || '(none)'}`,
    );

    // Interaction 4 — and nothing was reported or forgotten.
    for (const id of ALL_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(id),
        baseline.get(id),
        `${id}'s cached result is untouched by a run that never ran`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'cache size unchanged',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and the tree is untouched',
    );
    await assertIdlePromptly('after a pre-cancelled run');
  });

  test('pressing Stop on the NAMESPACE row cancels every test beneath it', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the user presses ▶ on the group row, not on a leaf. An F#
    // module compiles to a CLR TYPE, so `Fs.Cancel.Fixtures` renders the same
    // way a C# class does: a class row named `Fixtures` under a namespace row
    // named `Fs.Cancel` (Assembly → Namespace → Class → Test). The row holding
    // every binding is therefore the module's class row.
    clearMarkers();
    const leaf = findItem(api.testController.items, FAST_TEST);
    assert.ok(leaf, `${FAST_TEST} must be a row in the tree`);
    const namespaceNode = leaf.parent;
    assert.ok(namespaceNode, 'a leaf hangs off the group it belongs to');
    assert.strictEqual(
      namespaceNode.label,
      MODULE_TYPE,
      'and that parent is the F# module, by its TYPE name',
    );
    assert.strictEqual(
      namespaceNode.parent?.label,
      MODULE_NAMESPACE,
      'which itself hangs off the namespace enclosing the module',
    );
    assert.strictEqual(
      `${MODULE_NAMESPACE}.${MODULE_TYPE}`,
      NAMESPACE,
      'and the two rejoin to exactly the module the fixture declares',
    );
    assert.strictEqual(
      namespaceNode.children.size,
      ALL_TESTS.length,
      'the module contains every fixture test',
    );
    const baseline = new Map(api.testController.cachedResults);

    // Interaction 2 — Stop, once the batch is demonstrably running.
    const { afterStop, running } = await runAndStop(vscode.TestRunProfileKind.Run, [namespaceNode]);
    assert.ok(
      afterStop < STOP_BUDGET_MS,
      `Stop on a group row must end the run as promptly as on a leaf: ${String(afterStop)}ms`,
    );
    assert.strictEqual(marked(running.started), true, 'the batch really was running');
    for (const queued of queuedBehind(running)) {
      assert.strictEqual(
        marked(queued.started),
        false,
        `${queued.fqn} sits under the same group row and must never start once it is cancelled`,
      );
    }

    // Interaction 3 — every test beneath the row is suppressed, not just the one
    // that happened to be executing.
    for (const id of ALL_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(id),
        baseline.get(id),
        `${id} sits under the cancelled group row, so its result is suppressed`,
      );
    }
    assert.strictEqual(api.testController.cachedResults.size, baseline.size, 'no entries invented');
    assert.strictEqual(
      namespaceNode.children.size,
      ALL_TESTS.length,
      'and the group row keeps its children',
    );
    await assertIdlePromptly('after Stop on the namespace row');
  });

  test('pressing Stop on the ASSEMBLY root cancels the whole project', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the top row of the Testing view, which is the project.
    clearMarkers();
    const roots = rootsOf(api.testController.items);
    assert.strictEqual(roots.length, 1, 'the fixture is one project, so one assembly root');
    const assemblyNode = roots[0];
    assert.ok(assemblyNode, 'the assembly root is readable');
    assert.strictEqual(assemblyNode.label, PROJECT, 'labelled for the project');
    assert.strictEqual(
      assemblyNode.id.startsWith('assembly:'),
      true,
      `an assembly root is a GROUP id, never an FQN; got ${assemblyNode.id}`,
    );
    const baseline = new Map(api.testController.cachedResults);

    // Interaction 2 — run everything from the root, then Stop.
    const { afterStop, running } = await runAndStop(vscode.TestRunProfileKind.Run, [assemblyNode]);
    assert.ok(
      afterStop < STOP_BUDGET_MS,
      `Stop on the assembly root must end the run: ${String(afterStop)}ms`,
    );
    assert.strictEqual(marked(running.started), true, 'the whole-project batch really was running');

    // Interaction 3 — nothing is attributed, and the whole tree survives. A
    // cancelled root run that cleared the tree would look like a failed
    // discovery to the user.
    for (const id of ALL_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(id),
        baseline.get(id),
        `${id} is under the cancelled root, so its result is suppressed`,
      );
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'the tree is left standing after a cancelled root run',
    );
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'and still shows exactly one assembly root',
    );
    await assertIdlePromptly('after Stop on the assembly root');
  });

  test('Stop on a MULTI-SELECT of the two long tests cancels both clauses', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — a selection of two, OR-ed into one filter expression
    // ([TEST-FILTER-ESCAPE]). Both names carry SPACES, which are not grammar and
    // must not be escaped.
    clearMarkers();
    const selection = LONG_TESTS.map((each) => each.fqn);
    for (const fqn of selection) {
      assert.ok(fqn.includes(' '), `${fqn} is an idiomatic F# backtick binding`);
      assert.strictEqual(
        filterClause(fqn),
        `FullyQualifiedName=${fqn}`,
        'a space needs no backslash — escaping one would make the filter match nothing',
      );
    }
    const items = itemsFor(api, selection);
    assert.strictEqual(items.length, LONG_TESTS.length, 'both long tests are selected');
    const baseline = new Map(api.testController.cachedResults);

    // Interaction 2 — Stop while the first of them runs.
    const { afterStop, running } = await runAndStop(vscode.TestRunProfileKind.Run, items);
    assert.ok(afterStop < STOP_BUDGET_MS, `Stop ends the batch: ${String(afterStop)}ms`);
    assert.strictEqual(marked(running.started), true, 'one of the two clauses ran');
    assert.strictEqual(
      selection.includes(running.fqn),
      true,
      `${running.fqn} is one of the two clauses actually selected`,
    );

    // Interaction 3 — the other clause never got its turn, and neither reports.
    for (const queued of queuedBehind(running)) {
      assert.strictEqual(
        marked(queued.started),
        false,
        `${queued.fqn} is the OTHER selected clause and must never start once the batch is cancelled`,
      );
    }
    for (const fqn of selection) {
      assert.deepStrictEqual(
        api.testController.getResult(fqn),
        baseline.get(fqn),
        `${fqn} is part of the cancelled selection, so its result is suppressed`,
      );
    }
    assert.deepStrictEqual(
      api.testController.getResult(FAST_TEST),
      baseline.get(FAST_TEST),
      'and the test that was never selected is untouched either way',
    );
    await assertIdlePromptly('after Stop on a multi-select');
  });

  test('after a cancelled run, the very next ▶ reports REAL results', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Every `dotnet` invocation is serialized through one queue
    // ([TEST-REACTIVITY]). A cancelled run that left its invocation in the queue
    // poisons every later one — the symptom is the next run hanging, or VSTest
    // dying on the shared bin/obj output.
    //
    // Interaction 1 — cancel a run of the whole fixture.
    clearMarkers();
    const { afterStop } = await runAndStop(vscode.TestRunProfileKind.Run, itemsFor(api, ALL_TESTS));
    assert.ok(afterStop < STOP_BUDGET_MS, `the run was cancelled: ${String(afterStop)}ms`);
    await assertIdlePromptly('before re-running');

    // Interaction 2 — press ▶ again, on the fast test alone. It must actually
    // run, and promptly.
    clearMarkers();
    const started = Date.now();
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [FAST_TEST]),
    );
    const elapsed = Date.now() - started;
    const result = api.testController.getResult(FAST_TEST);
    assert.ok(result, `${FAST_TEST} must report after a cancelled run — the queue drained`);
    assert.strictEqual(result.outcome, 'passed', 'and report the real outcome');
    assert.strictEqual(result.passed, true, 'with the pass flag set');
    assert.strictEqual(
      (result.message ?? '').includes('No result reported'),
      false,
      'a re-run after Stop attributes a real TRX result, not a missing one',
    );
    assert.ok(
      elapsed < FIXTURE_SLEEP_MS,
      `selecting only the fast test must not drag the long ones in: ${String(elapsed)}ms`,
    );

    // Interaction 3 — the long tests were NOT in the selection, so they never
    // ran, which is how we know the filter was rebuilt rather than reused from
    // the cancelled run.
    for (const each of LONG_TESTS) {
      assert.strictEqual(
        marked(each.started),
        false,
        `${each.fqn} was not selected, so the re-run must not execute it`,
      );
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and the tree still holds every test',
    );
  });

  test('two cancelled runs back to back both stop, and neither poisons the other', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — cancel once.
    clearMarkers();
    const baseline = new Map(api.testController.cachedResults);
    const first = await runAndStop(vscode.TestRunProfileKind.Run, itemsFor(api, ALL_TESTS));
    assert.ok(
      first.afterStop < STOP_BUDGET_MS,
      `the first Stop returned in ${String(first.afterStop)}ms`,
    );
    assert.strictEqual(marked(first.running.started), true, 'the first run really started');
    await assertIdlePromptly('between the two cancelled runs');

    // Interaction 2 — cancel again immediately. The second run must still get as
    // far as actually starting the long test: a queue left holding the first
    // invocation would never let it.
    clearMarkers();
    const second = await runAndStop(vscode.TestRunProfileKind.Run, itemsFor(api, ALL_TESTS));
    assert.ok(
      second.afterStop < STOP_BUDGET_MS,
      `the second Stop returned in ${String(second.afterStop)}ms`,
    );
    assert.strictEqual(
      marked(second.running.started),
      true,
      'the SECOND run must reach the point of executing a test — proof the first ' +
        'cancellation released the queue rather than abandoning an invocation in it',
    );

    // Interaction 3 — neither run reported anything.
    for (const id of ALL_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(id),
        baseline.get(id),
        `${id} was cancelled twice and reported neither time`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'two cancelled runs invent no cache entries between them',
    );
    await assertIdlePromptly('after the second cancelled run');
  });

  test('Stop pressed AFTER a run has already finished changes nothing', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — let a run of the fast test finish normally.
    clearMarkers();
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [FAST_TEST]),
    );
    const settled = api.testController.getResult(FAST_TEST);
    assert.ok(settled, 'the completed run cached a result');
    assert.strictEqual(settled.outcome, 'passed', 'a real pass');
    const baseline = new Map(api.testController.cachedResults);

    // Interaction 2 — press ⏹ long after the handler returned. Cancelling a
    // token nothing is listening to must be inert, not a crash and not an
    // erasure of the result the user is looking at.
    const source = new vscode.CancellationTokenSource();
    assert.doesNotThrow(() => {
      source.cancel();
      source.cancel();
    }, 'pressing Stop twice on a finished run must not throw');
    source.dispose();

    // Interaction 3 — the result the user can see is exactly as it was.
    assert.deepStrictEqual(
      api.testController.getResult(FAST_TEST),
      settled,
      'a late Stop must not retract a result that was already reported',
    );
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'nor drop any other cached result',
    );
    assert.strictEqual(
      statusLensTitle(settled).startsWith('$(pass) Passed'),
      true,
      'and the lens still shows the pass',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'with the tree untouched',
    );
    await assertIdlePromptly('after a late Stop');
  });

  test('a cancelled run leaves DISCOVERY intact, and a refresh still re-discovers', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Discovery and execution share one `dotnet` queue and one bin/obj output
    // ([TEST-REACTIVITY]). A cancellation that killed the queue would present as
    // an empty Testing view the next time the user pressed refresh.
    //
    // Interaction 1 — cancel a run.
    clearMarkers();
    const before = sorted(collectLeafIds(api.testController.items));
    const { afterStop, running } = await runAndStop(
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );
    assert.ok(afterStop < STOP_BUDGET_MS, `the run was cancelled: ${String(afterStop)}ms`);
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      before,
      'the tree survives the cancellation itself',
    );
    await assertIdlePromptly('before refreshing');

    // Interaction 2 — press refresh. The build the cancelled run left behind
    // must not stop discovery from completing.
    await drainDiscovery(() => {
      void api.testController.activateAndDiscover();
    }, api.testController);
    const after = await pollUntilDiscovered(api.testController, ALL_TESTS);
    assert.deepStrictEqual(
      sorted(after),
      before,
      'refreshing after a cancelled run re-discovers exactly the same tests',
    );

    // Interaction 3 — the tree is whole: one root, one namespace, every leaf.
    const roots = rootsOf(api.testController.items);
    assert.strictEqual(roots.length, 1, 'one assembly root after re-discovery');
    assert.strictEqual(roots[0]?.label, PROJECT, 'still labelled for the project');
    for (const id of ALL_TESTS) {
      const item = findItem(api.testController.items, id);
      assert.ok(item, `${id} must still be a row after a cancelled run and a refresh`);
      assert.strictEqual(item.id, id, 'under its own fully-qualified name');
    }
    assert.deepStrictEqual(
      markersOnDisk().filter((name) => name.startsWith('finished-')),
      [],
      'and re-discovery never EXECUTES a test — `--list-tests` builds, it does not run',
    );
    assert.deepStrictEqual(
      startedLongTests().map((each) => each.fqn),
      [running.fqn],
      'nor STARTS one: the only test that ever ran is the one the cancelled run caught, ' +
        `and it never finished; markers on disk: ${markersOnDisk().join(', ') || '(none)'}`,
    );
  });

  test('Stop on a selection of ONE long test kills it and touches nothing else', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The narrowest selection there is. A cancellation implemented by killing
    // "the current run" rather than "this invocation" is indistinguishable from
    // a correct one on a whole-tree selection, and shows up here.
    //
    // Interaction 1 — select exactly one long test. Its name carries SPACES, so
    // the clause is the bare name ([TEST-FILTER-ESCAPE]).
    clearMarkers();
    const first = LONG_TESTS[0];
    assert.ok(first, 'the fixture declares a long test');
    assert.ok(first.fqn.includes(' '), 'whose name is an idiomatic F# backtick binding');
    assert.strictEqual(
      filterClause(first.fqn),
      `FullyQualifiedName=${first.fqn}`,
      'a space is not filter grammar and must not be escaped',
    );
    const items = itemsFor(api, [first.fqn]);
    assert.strictEqual(items.length, 1, 'exactly one row is selected');
    assert.strictEqual(items[0]?.id, first.fqn, 'and it is the long test');
    const baseline = new Map(api.testController.cachedResults);

    // Interaction 2 — Stop the moment it announces itself.
    const { afterStop, running } = await runAndStop(vscode.TestRunProfileKind.Run, items);
    assert.strictEqual(marked(first.started), true, 'the one selected test really started');
    assert.strictEqual(
      running.fqn,
      first.fqn,
      'and it is the one Stop caught — a selection of one leaves xUnit no ordering choice',
    );
    assert.ok(
      afterStop < STOP_BUDGET_MS,
      `Stop must end a single-test run just as promptly: ${String(afterStop)}ms`,
    );

    // Interaction 3 — the process tree is dead, and the tests that were NOT
    // selected were never touched in the first place.
    await sleep(FIXTURE_SLEEP_MS + TERMINATION_GRACE_MS - afterStop);
    assert.strictEqual(
      marked(first.finished),
      false,
      `${first.fqn} must be TERMINATED, not waited out; markers: ${markersOnDisk().join(', ') || '(none)'}`,
    );
    const second = LONG_TESTS[1];
    assert.ok(second, 'the fixture declares a second long test');
    assert.strictEqual(
      marked(second.started),
      false,
      'a test outside the selection must never run, cancelled or not',
    );

    // Interaction 4 — nothing is reported, nothing is forgotten, nothing moved.
    for (const id of ALL_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(id),
        baseline.get(id),
        `${id} keeps whatever it had — a cancelled run reports nothing and retracts nothing`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'cache size unchanged',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and the tree is untouched',
    );
    await assertIdlePromptly('after Stop on a single test');
  });

  test('after a cancelled run, the WHOLE tree still runs to completion', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The recovery case at full width. [TEST-REACTIVITY] serializes every
    // `dotnet` invocation through one queue over shared `bin/`/`obj/` output, so
    // a cancellation that left a half-killed build behind poisons the next full
    // run — the symptom is VSTest dying with "The application to execute does
    // not exist: …testhost.dll".
    //
    // Interaction 1 — cancel a run of everything.
    clearMarkers();
    const { afterStop, running } = await runAndStop(
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );
    assert.ok(afterStop < STOP_BUDGET_MS, `the run was cancelled: ${String(afterStop)}ms`);
    assert.strictEqual(marked(running.started), true, 'having really started');
    await assertIdlePromptly('before the recovery run');

    // Interaction 2 — run the whole tree again and let it finish. Every long
    // test writes BOTH markers this time.
    clearMarkers();
    const started = Date.now();
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );
    const elapsed = Date.now() - started;
    assert.deepStrictEqual(
      markersOnDisk(),
      sorted(EVERY_MARKER),
      'the recovery run executes every long test to completion — a poisoned queue would have ' +
        'produced a build error instead',
    );
    assert.ok(
      elapsed >= FIXTURE_SLEEP_MS * LONG_TESTS.length,
      `and really waited every sleep out; took ${String(elapsed)}ms`,
    );

    // Interaction 3 — every outcome is real, green and rendered as such
    // ([TEST-RUN-TRX], [TEST-STATUS-LENS]).
    for (const id of ALL_TESTS) {
      const result = api.testController.getResult(id);
      assert.ok(result, `${id} must report after the recovery run`);
      assert.strictEqual(result.outcome, 'passed', `${id} passes when left alone`);
      assert.strictEqual(result.passed, true, `${id} carries the pass flag`);
      assert.strictEqual(
        (result.message ?? '').includes('No result reported'),
        false,
        `${id} really ran, so it reports no missing result`,
      );
      assert.ok(Number(result.duration) >= 0, `${id} carries a measured duration`);
      assert.strictEqual(
        statusLensTitle(result).startsWith('$(pass) Passed'),
        true,
        `${id} renders above its binding as a pass`,
      );
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and the tree is whole',
    );
  });

  test('a cancelled COVERAGE run leaves the NEXT coverage run a clean directory', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-COVERAGE] points `--results-directory` at a FRESHLY EMPTIED
    // `.sharplsp-coverage`, and a run killed mid-flight is exactly the case that
    // leaves debris there: a half-written run-id folder whose report describes
    // nothing. The next run must not show it.
    //
    // Interaction 1 — cancel a coverage run, and see what it left behind.
    clearMarkers();
    removeDirRecursive(coverageDir);
    const { afterStop } = await runAndStop(
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_TESTS),
    );
    assert.ok(afterStop < STOP_BUDGET_MS, `the coverage run was cancelled: ${String(afterStop)}ms`);
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir),
      [],
      'a run killed mid-flight collected nothing, so it attaches no report',
    );
    // Whatever the kill DID leave behind is what the next run has to sweep.
    const debris = fs.existsSync(coverageDir) ? fs.readdirSync(coverageDir).sort() : [];
    await assertIdlePromptly('after the cancelled coverage run');

    // Interaction 2 — now let a coverage run FINISH, over the fast test alone so
    // it costs one round trip.
    clearMarkers();
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [FAST_TEST]),
    );
    assert.strictEqual(fs.existsSync(coverageDir), true, 'the completed run created the directory');
    const entries = fs.readdirSync(coverageDir).sort();
    const dirs = entries.filter((entry) =>
      fs.statSync(path.join(coverageDir, entry)).isDirectory(),
    );
    const trx = entries.filter((entry) => entry.toLowerCase().endsWith('.trx'));
    assert.strictEqual(trx.length, 1, `one TRX for the one project: ${entries.join(' | ')}`);
    assert.strictEqual(
      reportDirsOf(coverageDir).length,
      1,
      `and exactly ONE run-id folder holding a report — the collector writes one per test ` +
        `project, and there is one: ${entries.join(' | ')}`,
    );
    assert.deepStrictEqual(
      entries.filter((entry) => debris.includes(entry)),
      [],
      `the killed run's debris must have been SWEPT, not handed to the next run: it left ` +
        `${debris.join(' | ') || '(nothing)'}, and the directory now holds ${entries.join(' | ')}`,
    );
    assert.deepStrictEqual(
      sorted([...trx, ...dirs]),
      sorted(entries),
      'with nothing else beside the solution',
    );

    // Interaction 3 — the report that IS there describes the run that just ran.
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(reports.length, 1, 'one Cobertura report, from the completed run');
    for (const report of reports) {
      assert.strictEqual(
        path.basename(report),
        'coverage.cobertura.xml',
        "the collector's own file name",
      );
      assert.strictEqual(
        path.dirname(path.dirname(report)),
        coverageDir,
        `${report} sits exactly one directory down`,
      );
      assert.strictEqual(
        fs.readFileSync(report, 'utf8').includes('<coverage'),
        true,
        `${report} is valid Cobertura XML`,
      );
    }

    // Interaction 4 — and the completed coverage run attributed its outcome, so
    // the cancellation before it changed nothing about how a real run reports.
    const result = api.testController.getResult(FAST_TEST);
    assert.ok(result, `${FAST_TEST} must report under the Coverage profile`);
    assert.strictEqual(result.outcome, 'passed', 'as a pass');
    assert.strictEqual(result.passed, true, 'with the flag set');
    assert.strictEqual(
      (result.message ?? '').includes('No result reported'),
      false,
      'and no missing-result note',
    );
    for (const each of LONG_TESTS) {
      assert.strictEqual(
        marked(each.started),
        false,
        `${each.fqn} was not in the coverage selection and must not have run`,
      );
    }
  });

  test('Stop that lands after the run finished neither invents nor retracts a result', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The race the other cancellation tests deliberately avoid: ⏹ pressed on a
    // selection fast enough to have already completed. Both landings are
    // legitimate, and the contract holds either way — what is never legitimate
    // is a fabricated outcome or a notRun for a test the run did report.
    //
    // Interaction 1 — a baseline the assertions below can be compared against.
    clearMarkers();
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [FAST_TEST]),
    );
    const settled = api.testController.getResult(FAST_TEST);
    assert.ok(settled, 'the control run cached a result');
    assert.strictEqual(settled.outcome, 'passed', 'a real pass');
    const baseline = new Map(api.testController.cachedResults);

    // Interaction 2 — run the fast test again and press ⏹ almost immediately.
    // Whether the process beats the signal is a race, so nothing here asserts
    // WHICH landing happened.
    await assert.doesNotReject(async () => {
      await runViaProfile(
        api.testController,
        vscode.TestRunProfileKind.Run,
        itemsFor(api, [FAST_TEST]),
        1,
      );
    }, 'a cancelled run must resolve, never reject, however the race lands');

    // Interaction 3 — the result is EITHER the one already cached (the run was
    // suppressed) OR a fresh real pass. It is never a failure, never notRun, and
    // never a "no result" note.
    const after = api.testController.getResult(FAST_TEST);
    assert.ok(after, 'the last known result must survive a cancellation either way');
    assert.strictEqual(
      ['passed'].includes(after.outcome),
      true,
      `${FAST_TEST} passes; a cancelled run may suppress that but never contradict it — ` +
        `got ${after.outcome}`,
    );
    assert.strictEqual(after.passed, true, 'so the pass flag stands');
    assert.strictEqual(
      (after.message ?? '').includes('No result reported'),
      false,
      'a cancelled run must not turn a passing test into a missing result',
    );
    assert.notStrictEqual(after.outcome, 'notRun', 'nor into a notRun');
    assert.strictEqual(
      statusLensTitle(after).startsWith('$(pass) Passed'),
      true,
      'and the lens still shows the pass',
    );

    // Interaction 4 — no other test was invented, dropped or disturbed.
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'a cancelled run invents no cache entries, whichever way the race landed',
    );
    for (const each of LONG_TESTS) {
      assert.deepStrictEqual(
        api.testController.getResult(each.fqn),
        baseline.get(each.fqn),
        `${each.fqn} was not selected and must be untouched`,
      );
      assert.strictEqual(marked(each.started), false, 'and must not have run');
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and the tree is whole',
    );
    await assertIdlePromptly('after a Stop that raced the run');
  });
});
