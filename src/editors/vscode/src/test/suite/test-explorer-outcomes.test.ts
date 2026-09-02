// Coarse end-to-end coverage for the Test Explorer's RUN path — run profiles,
// per-test outcome attribution and coverage — against REAL on-disk C# and F#
// xUnit projects in a REAL solution built by the real `dotnet` CLI.
//
// Regression suite for the run half of issue #180, where the Explorer spawned
// ONE `dotnet test` PER SELECTED TEST and read the outcome off the console
// summary: N tests cost N builds; a SKIPPED test prints `Skipped! - Failed: 0,
// Passed: 0, Skipped: 1` and was reported as a FAILURE (the headline bug); a
// theory whose rows DISAGREE was judged by whichever row VSTest wrote last; and
// every failure read "Test failed", because `--verbosity quiet` suppresses the
// `Error Message:` block carrying the assertion text.
//
// Everything below asserts the TRX-based replacement, and F# comes first:
// `Fs.Xunit.Fixtures.adds two numbers with spaces` has SPACES in its FQN and
// must survive the `--filter FullyQualifiedName=` round-trip.
//
// Covers [TEST-RUN-TRX], [TEST-FILTER-ESCAPE], [TEST-STATUS-LENS] and
// [TEST-COVERAGE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  findCoberturaFile,
  findCoberturaFiles,
  loadDetailedCoverage,
  parseCoberturaXml,
} from '../../test-coverage.js';
import { escapeFilterValue, filterExpression } from '../../test-filter.js';
import { formatDuration, statusLensTitle } from '../../test-lens.js';
import { buildFilterArgs } from '../../testing.js';
import { createSolution, warmDiscovery } from './dotnet-project-kit';
import { DEBUG_TYPE_ID, DebugSessionRecorder } from './run-debug-kit';
import { fixtureFor, LIBRARY_TEST, writeCoverageFixture } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  drainDiscovery,
  findItem,
  nextResultsChange,
  pollUntilDiscovered,
  profileOfKind,
  runViaProfile,
} from './test-explorer-kit';
import { comparablePath, pollUntilResult, removeDirRecursive } from './test-helpers.js';
import {
  assertEveryOutcome,
  assertFailed,
  assertPassed,
  assertSkipped,
  cachedFor,
  fixtureKeys,
  itemsFor,
  sorted,
} from './test-explorer-outcome-assertions';
import { DEBUG_SESSION_MS, DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

const CS = fixtureFor('xunit-csharp');
const FSX = fixtureFor('xunit-fsharp');

/** The idiomatic F# backtick fact whose xUnit FQN literally contains spaces. */
const FS_SPACED = 'Fs.Xunit.Fixtures.adds two numbers with spaces';
/** An NUnit `[TestCase]` FQN: parentheses that VSTest's filter grammar reserves. */
const NUNIT_CASE = 'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)';

/** Theories whose rows DISAGREE — one row passes, one fails, one shared FQN. */
const FS_MIXED = FSX.mixedParameterized ?? 'Fs.Xunit.Fixtures.mixed theory';
const CS_MIXED = CS.mixedParameterized ?? 'Cs.Xunit.Fixtures.CalculatorTests.Mixed_Theory';
/** Every test the two xUnit fixtures expose that ends green. F# first. */
const PASSING = [
  FSX.passing,
  FS_SPACED,
  FSX.parameterized,
  CS.passing,
  CS.parameterized,
  LIBRARY_TEST,
] as const;
/** Every test that ends red, including the two mixed-row theories. */
const FAILING = [FSX.failing, FS_MIXED, CS.failing, CS_MIXED] as const;
/** Every test that is skipped — never a failure, never a pass. */
const SKIPPED = [FSX.skipped, CS.skipped] as const;
/** The whole tree the two fixtures produce. */
const ALL_TESTS: readonly string[] = [...PASSING, ...FAILING, ...SKIPPED];
/** The same partition, handed to the shared outcome assertions. */
const OUTCOME_GROUPS = { passing: PASSING, failing: FAILING, skipped: SKIPPED };

/** Where the Coverage profile drops TRX + Cobertura, next to the solution. */
const COVERAGE_DIR_NAME = '.sharplsp-coverage';
/** The terminal the Debug profile opens for the user to attach to. */
const DEBUG_TERMINAL = 'SharpLsp Test Debug';

suite('Test Explorer e2e — run profiles, outcome attribution and coverage', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let coverageDir: string;
  suiteSetup(async function () {
    // Cold restore + build of both fixture projects plus the adapter JIT.
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testoutcomes-'));
    coverageDir = path.join(root, COVERAGE_DIR_NAME);
    slnPath = await createSolution(root, 'Outcomes', writeCoverageFixture(root));

    // Build BOTH projects and pay the adapter JIT once, so runs measure a WARM
    // `dotnet test` rather than a cold restore.
    await warmDiscovery(slnPath, root);
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    // A solution load also schedules a DEBOUNCED sweep; let it land first.
    await drainDiscovery(() => undefined, api.testController);
    await pollUntilDiscovered(api.testController, ALL_TESTS);
  });
  teardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Never touch the fixture while a `dotnet` invocation is still in flight.
    await api.testController.whenIdle();
    removeDirRecursive(coverageDir);
  });
  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Drain re-discovery first: `dotnet test` pointed at a removed directory
    // hangs and poisons the whole host.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('pressing ▶ on the whole tree attributes a pass, a failure and a SKIP to each own test', async function () {
    this.timeout(DOTNET_CLI_MS);
    assert.strictEqual(
      FSX.passing,
      'Fs.Xunit.Fixtures.addsTwoNumbers',
      'the F# fixture pins the FQN dotnet actually reports',
    );
    assert.strictEqual(
      FSX.failing,
      'Fs.Xunit.Fixtures.fails on purpose',
      'an F# backtick FQN keeps its spaces all the way through',
    );
    assert.strictEqual(
      FSX.mixedParameterized,
      FS_MIXED,
      'the F# mixed-row theory is declared by the fixture',
    );
    assert.strictEqual(
      CS.mixedParameterized,
      CS_MIXED,
      'the C# mixed-row theory is declared by the fixture',
    );
    assert.deepStrictEqual(
      [PASSING.length, FAILING.length, SKIPPED.length],
      [6, 4, 2],
      'six green (including the library test), four red (both mixed theories) and two skipped',
    );
    assert.strictEqual(
      ALL_TESTS.length,
      12,
      'the two xUnit fixtures plus the library test expose twelve distinct FQNs',
    );
    assert.strictEqual(
      new Set(ALL_TESTS).size,
      12,
      'and the expectation list itself holds no duplicate',
    );
    assert.strictEqual(
      PASSING.includes(LIBRARY_TEST),
      true,
      'the library test is a real pass, not a fixture prop',
    );
    const treeIds = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      sorted(treeIds),
      sorted(ALL_TESTS),
      `exactly the fixture's tests must be discovered first: ${treeIds.join(' | ')}`,
    );
    assert.strictEqual(
      new Set(treeIds).size,
      treeIds.length,
      `the tree must not hold a duplicate item: ${treeIds.join(' | ')}`,
    );
    const items = itemsFor(api, ALL_TESTS);
    assert.strictEqual(
      items.length,
      ALL_TESTS.length,
      'every expected test resolved to a tree item',
    );
    assert.deepStrictEqual(
      items.map((item) => item.id),
      [...ALL_TESTS],
      'the selection handed to ▶ is exactly the tree, in order',
    );
    assert.deepStrictEqual(
      buildFilterArgs(items),
      ['--filter', filterExpression(ALL_TESTS)],
      'one escaped FullyQualifiedName clause per selected test, OR-ed into ONE invocation',
    );

    // The user interaction under test: ▶ on the root of the Testing view.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    assertEveryOutcome(api, OUTCOME_GROUPS);
    assert.strictEqual(
      cachedFor(api, FS_SPACED).outcome,
      'passed',
      'an F# name containing SPACES survives the --filter round-trip and reports its own result',
    );
    assert.strictEqual(
      cachedFor(api, FS_MIXED).outcome,
      'failed',
      'a theory whose rows disagree is judged by its WORST row, not the last one written',
    );
    assert.strictEqual(
      cachedFor(api, CS_MIXED).outcome,
      'failed',
      'the C# mixed theory fails even though one of its two rows passed',
    );
    assert.strictEqual(
      cachedFor(api, CS.parameterized).outcome,
      'passed',
      'a theory whose rows ALL pass stays green through the worst-row merge',
    );
    assert.strictEqual(
      (cachedFor(api, CS.parameterized).duration ?? -1) >= 0,
      true,
      "a theory's row durations are summed into one number",
    );
    assert.deepStrictEqual(
      sorted(fixtureKeys(api, ALL_TESTS)),
      sorted(ALL_TESTS),
      'one cached result per test run — none merged, dropped or invented',
    );
    assert.strictEqual(
      fixtureKeys(api, ALL_TESTS).length,
      items.length,
      'the number of cached results equals the number of items run',
    );
    assert.strictEqual(
      new Set(fixtureKeys(api, ALL_TESTS)).size,
      ALL_TESTS.length,
      'and the cache is keyed by FQN, so no key repeats',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'running tests must not mutate the tree',
    );
  });

  test('the whole tree runs in ONE dotnet invocation, not one per selected test', async function () {
    this.timeout(DOTNET_CLI_MS);
    const items = itemsFor(api, ALL_TESTS);
    assert.strictEqual(
      items.length,
      ALL_TESTS.length,
      'the whole tree is selected, exactly as ▶ on the root does',
    );
    assert.strictEqual(
      items.length >= 8,
      true,
      `the timing argument needs a real selection, got ${items.length}`,
    );
    assert.deepStrictEqual(
      buildFilterArgs([{ id: CS.passing }]),
      ['--filter', `FullyQualifiedName=${CS.passing}`],
      'a single test is one clause, so the timing baseline really is one test',
    );

    // One test through the SAME run path, timed: the fixed cost of one
    // invocation (restore + build + load) on this machine.
    const singleStarted = Date.now();
    const single = await api.testController.runSingle(CS.passing);
    const singleMs = Date.now() - singleStarted;
    assertPassed(single, CS.passing);
    assert.strictEqual(
      single.outcome,
      'passed',
      'the timed baseline is the green C# fact, not an error path',
    );
    assert.strictEqual(
      singleMs > 0,
      true,
      'a real dotnet invocation takes measurable wall-clock time',
    );
    assert.strictEqual(
      singleMs < DOTNET_CLI_MS,
      true,
      `a warm single-test invocation must finish well inside the CLI ceiling, took ${singleMs}ms`,
    );
    assert.strictEqual(
      api.testController.getResult(CS.passing),
      single,
      'runSingle caches the very object it resolved',
    );
    const wholeStarted = Date.now();
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    const wholeMs = Date.now() - wholeStarted;

    // Per-test spawning costs ≈ N × singleMs; one invocation costs ≈ singleMs
    // plus the other tests' execution. The 60% margin proves "not per-test", it
    // does not benchmark the machine.
    const ceiling = Math.round(items.length * singleMs * 0.6);
    assert.strictEqual(
      ceiling > 0,
      true,
      `the ceiling must be a real budget, got ${ceiling}ms from a ${singleMs}ms baseline`,
    );
    assert.strictEqual(
      wholeMs < ceiling,
      true,
      `${items.length} tests took ${wholeMs}ms; one invocation each would cost about ${items.length * singleMs}ms, so ${ceiling}ms or more means the run is still per-test`,
    );
    assert.strictEqual(wholeMs > 0, true, 'the whole-tree run really executed');
    assertEveryOutcome(api, OUTCOME_GROUPS);
    assert.strictEqual(
      fixtureKeys(api, ALL_TESTS).length,
      ALL_TESTS.length,
      'a single invocation still produced one result per test',
    );
    assert.deepStrictEqual(
      sorted(fixtureKeys(api, ALL_TESTS)),
      sorted(ALL_TESTS),
      'and every result is keyed by fully-qualified name',
    );
    assert.strictEqual(
      cachedFor(api, CS.passing).outcome,
      'passed',
      'runSingle and the profile run cache through the very same path',
    );
    assert.notStrictEqual(
      api.testController.getResult(CS.passing),
      single,
      'the whole-tree run rewrote the entry runSingle had cached',
    );
    assert.strictEqual(
      cachedFor(api, FS_SPACED).passed,
      true,
      'the spaced F# name is green in the one-invocation run too',
    );
    assert.strictEqual(
      cachedFor(api, FSX.skipped).outcome,
      'skipped',
      'and a skip stays a skip when twelve tests share one invocation',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'neither invocation mutated the tree',
    );
  });

  test('onResultsChanged fires exactly once for a profile run and once for a single re-run', async function () {
    this.timeout(DOTNET_CLI_MS);
    const items = itemsFor(api, [CS.passing, FSX.failing]);
    assert.strictEqual(items.length, 2, 'two items are selected for the profile run');
    assert.deepStrictEqual(
      items.map((item) => item.id),
      [CS.passing, FSX.failing],
      'a C# pass and an F# failure, so one run proves both directions at once',
    );

    // Subscribe BEFORE ▶: every listener must be told, or the UI stays stale.
    let firings = 0;
    const counter = api.testController.onResultsChanged(() => {
      firings += 1;
    });
    assert.strictEqual(firings, 0, 'subscribing must not itself fire a notification');
    const profileChange = nextResultsChange(api.testController, DOTNET_CLI_MS);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    assert.strictEqual(
      await profileChange,
      true,
      'the ▶ profile must fire onResultsChanged when it ends',
    );
    assert.strictEqual(
      firings,
      1,
      `one completed profile run is exactly one notification, got ${firings}`,
    );
    const passed = cachedFor(api, CS.passing);
    const failed = cachedFor(api, FSX.failing);
    assertPassed(passed, CS.passing);
    assertFailed(failed, FSX.failing);
    assert.strictEqual(
      (failed.message ?? '').includes('Assert.Equal() Failure'),
      true,
      `listeners see the REAL assertion text: ${failed.message ?? 'none'}`,
    );
    const singleChange = nextResultsChange(api.testController, DOTNET_CLI_MS);
    const single = await api.testController.runSingle(FSX.skipped);
    assert.strictEqual(await singleChange, true, 'runSingle must fire onResultsChanged as well');
    assertSkipped(single, FSX.skipped);
    assert.strictEqual(
      single.passed,
      false,
      'a skipped test is not a pass, whichever entry point ran it',
    );
    assert.strictEqual(
      single.outcome,
      'skipped',
      'NotExecuted maps to skipped on the runSingle path too',
    );
    assert.strictEqual(
      api.testController.getResult(FSX.skipped),
      single,
      'the value runSingle resolved is the value it cached',
    );
    assert.strictEqual(
      statusLensTitle(single),
      '$(debug-step-over) Skipped',
      'and the lens renders that skip the moment listeners are told',
    );
    counter.dispose();
    // Read the counter into a const: TypeScript narrows a `let` only mutated
    // inside a closure, and the narrowed type is unusable in the message.
    const observed: number = firings;
    assert.strictEqual(
      observed,
      2,
      `exactly one notification per completed run — no duplicate and no missing fire, got ${String(observed)}`,
    );
    assert.strictEqual(
      api.testController.getResult(CS.passing),
      passed,
      "a single re-run must not disturb another test's cached result object",
    );
    assert.strictEqual(
      api.testController.getResult(FSX.failing),
      failed,
      'nor the failure the profile run recorded',
    );
    assert.strictEqual(
      fixtureKeys(api, ALL_TESTS).length >= 3,
      true,
      `the three tests driven here are all cached, got ${fixtureKeys(api, ALL_TESTS).length}`,
    );
    assert.notStrictEqual(
      api.testController.getResult(FSX.skipped),
      undefined,
      'the skipped test now has a cached result of its own',
    );
  });

  test('running a SUBSET refreshes only the selected tests results', async function () {
    this.timeout(DOTNET_CLI_MS);
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );
    // The snapshot holds the RESULT OBJECTS: a re-run replaces an entry with a
    // NEW one, so identity is an exact test of which results are fresh.
    const snapshot = new Map(api.testController.cachedResults);
    assert.strictEqual(
      fixtureKeys(api, ALL_TESTS).length,
      ALL_TESTS.length,
      'the baseline run cached every test',
    );
    assert.strictEqual(
      snapshot.size >= ALL_TESTS.length,
      true,
      `the baseline snapshot covers the whole tree, got ${snapshot.size}`,
    );
    assert.strictEqual(
      snapshot.get(CS.failing)?.outcome,
      'failed',
      'the baseline already had the red test red, so "refreshed" means identity, not a changed outcome',
    );
    const subset = [CS.failing, FSX.skipped] as const;
    assert.strictEqual(
      subset.every((id) => snapshot.has(id)),
      true,
      'the baseline cached every test the subset re-runs',
    );
    const subsetItems = itemsFor(api, subset);
    assert.deepStrictEqual(
      subsetItems.map((item) => item.id),
      [...subset],
      'exactly the two selected items reach the run handler',
    );
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, subsetItems);
    for (const id of subset) {
      assert.notStrictEqual(
        api.testController.getResult(id),
        snapshot.get(id),
        `${id} was selected, so its cached result must be refreshed`,
      );
    }
    for (const id of ALL_TESTS.filter((candidate) => !subset.includes(candidate))) {
      assert.strictEqual(
        api.testController.getResult(id),
        snapshot.get(id),
        `${id} was NOT selected, so its cached result must be left exactly as it was`,
      );
    }
    const refreshed = ALL_TESTS.filter(
      (id) => api.testController.getResult(id) !== snapshot.get(id),
    );
    assert.deepStrictEqual(
      sorted(refreshed),
      sorted(subset),
      `exactly the selected tests were refreshed, not ${refreshed.join(' | ')}`,
    );
    assert.strictEqual(refreshed.length, 2, 'two selected, two refreshed');
    assertFailed(cachedFor(api, CS.failing), CS.failing);
    assertSkipped(cachedFor(api, FSX.skipped), FSX.skipped);
    assert.strictEqual(
      cachedFor(api, FSX.skipped).outcome,
      'skipped',
      'a re-run skip is still a skip — never promoted to a failure by a smaller selection',
    );
    assert.strictEqual(
      cachedFor(api, CS.passing).passed,
      true,
      'and an unselected pass keeps the green result it already had',
    );
    assert.deepStrictEqual(
      sorted(fixtureKeys(api, ALL_TESTS)),
      sorted(ALL_TESTS),
      'a subset run adds no keys and removes none',
    );
    assert.strictEqual(
      api.testController.cachedResults.size,
      snapshot.size,
      'the cache is updated in place, never rebuilt',
    );
    assert.strictEqual(
      new Set(fixtureKeys(api, ALL_TESTS)).size,
      ALL_TESTS.length,
      'and still holds no duplicate key',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'a subset run leaves the whole tree standing',
    );
  });

  test('the Coverage profile writes a Cobertura report beside the solution and still attributes outcomes', async function () {
    this.timeout(DOTNET_CLI_MS);
    assert.strictEqual(
      fs.existsSync(coverageDir),
      false,
      `${COVERAGE_DIR_NAME} must not exist before the run — teardown removes it`,
    );
    assert.strictEqual(
      coverageDir,
      path.join(root, COVERAGE_DIR_NAME),
      'coverage lands beside the solution, not in a temp directory the user cannot find',
    );
    // The library test MUST be in the selection: `coverlet` only reports
    // assemblies the run actually LOADED, so covering a library nothing
    // exercised yields a valid Cobertura document with an empty <packages/>.
    const selection = [CS.passing, CS.parameterized, FSX.passing, LIBRARY_TEST] as const;
    const items = itemsFor(api, selection);
    assert.strictEqual(
      items.length,
      4,
      'four items are selected for the coverage run, one of them exercising the library',
    );
    assert.deepStrictEqual(
      items.map((item) => item.id),
      [...selection],
      'the coverage selection spans BOTH fixture projects',
    );
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, items);
    assert.strictEqual(
      fs.existsSync(coverageDir),
      true,
      `the coverage run must create ${coverageDir}`,
    );
    const entries = fs.readdirSync(coverageDir);
    const trx = entries.filter((entry) => entry.toLowerCase().endsWith('.trx'));
    const dirs = entries.filter((entry) =>
      fs.statSync(path.join(coverageDir, entry)).isDirectory(),
    );
    assert.strictEqual(
      trx.length,
      2,
      `a coverage run is still a test run: one TRX per project: ${entries.join(' | ')}`,
    );
    assert.strictEqual(
      dirs.length >= 1,
      true,
      `the collector writes its report into its own folder: ${entries.join(' | ')}`,
    );
    assert.deepStrictEqual(
      sorted([...trx, ...dirs]),
      sorted(entries),
      'nothing but TRX reports and collector folders is left beside the solution',
    );
    // One report PER TEST PROJECT, each in its own run-id folder. Reading only
    // the first silently drops every other project's coverage — and which one is
    // "first" is directory order, so the bug is invisible half the time.
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(
      reports.length >= 1,
      true,
      `at least one report must be written under ${coverageDir}; found: ${entries.join(' | ')}`,
    );
    assert.deepStrictEqual([...reports].sort(), reports, 'the reports come back in a stable order');
    for (const each of reports) {
      assert.strictEqual(
        path.basename(each),
        'coverage.cobertura.xml',
        "every report carries the collector's file name",
      );
      assert.strictEqual(
        path.dirname(path.dirname(each)),
        coverageDir,
        `${each} must sit exactly one directory down`,
      );
    }
    assert.strictEqual(
      findCoberturaFile(coverageDir),
      reports[0],
      'the singular helper is the first of the plural one',
    );
    const report = reports[0];
    assert.ok(
      report,
      `findCoberturaFiles must locate a report under ${coverageDir}; found: ${entries.join(' | ')}`,
    );
    assert.strictEqual(
      path.basename(report),
      'coverage.cobertura.xml',
      "the collector's own file name",
    );
    assert.strictEqual(
      path.dirname(path.dirname(report)),
      coverageDir,
      'written exactly one directory down',
    );
    assert.strictEqual(
      fs.readFileSync(report, 'utf8').includes('<coverage'),
      true,
      'the report really is Cobertura XML',
    );
    const files = reports.flatMap((each) => parseCoberturaXml(each));
    // An empty <packages/> is the tell that nothing the run LOADED was
    // instrumented, so name the report in the failure rather than just the count.
    assert.strictEqual(
      files.length >= 1,
      true,
      `at least one covered file must be parsed across ${reports.length} report(s), got ${files.length}`,
    );
    assert.strictEqual(
      files.some((file) => path.basename(file.uri.fsPath) === 'Calculator.cs'),
      true,
      `the library the tests exercise must be the thing covered; got ${files.map((file) => path.basename(file.uri.fsPath)).join(' | ')}`,
    );
    const library = files.find((file) => path.basename(file.uri.fsPath) === 'Calculator.cs');
    assert.ok(library, 'the library FileCoverage is readable');
    assert.strictEqual(
      library.statementCoverage.covered > 0,
      true,
      'Add/Subtract/Multiply were called, so covered lines are non-zero',
    );
    assert.strictEqual(
      library.statementCoverage.covered < library.statementCoverage.total,
      true,
      `NeverCalled is never called, so coverage must be PARTIAL: ${library.statementCoverage.covered}/${library.statementCoverage.total}`,
    );
    for (const file of files) {
      assert.strictEqual(
        file.statementCoverage.total > 0,
        true,
        `${file.uri.fsPath} must count statements`,
      );
      assert.strictEqual(
        file.statementCoverage.covered <= file.statementCoverage.total,
        true,
        `${file.uri.fsPath}: covered ${file.statementCoverage.covered} cannot exceed total ${file.statementCoverage.total}`,
      );
      assert.strictEqual(
        path.isAbsolute(file.uri.fsPath),
        true,
        `every FileCoverage names a real source file, got '${file.uri.fsPath}'`,
      );
    }
    const first = files[0];
    assert.ok(first, 'the first FileCoverage is readable');
    const details = loadDetailedCoverage(first);
    assert.strictEqual(
      details.length,
      first.statementCoverage.total,
      'the per-line detail VS Code asks for on demand covers every counted line',
    );
    const hit = details.filter(
      (detail) => detail instanceof vscode.StatementCoverage && Number(detail.executed) > 0,
    ).length;
    assert.strictEqual(
      hit,
      first.statementCoverage.covered,
      'and the executed lines in that detail add up to the summary the gutter shows',
    );

    // Coverage must not cost outcome attribution: it is the same run path.
    for (const id of selection) assertPassed(cachedFor(api, id), id);
    assert.strictEqual(
      fixtureKeys(api, ALL_TESTS).length,
      ALL_TESTS.length,
      'the coverage run updated results without dropping any',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'and it left the tree exactly as it was',
    );
  });

  test('the profiles are Run/Debug/Coverage and Debug opens a terminal instead of caching a result', async function () {
    this.timeout(DOTNET_CLI_MS);
    const profiles = api.testController.profiles;
    assert.strictEqual(profiles.length, 3, 'exactly three run profiles are registered');
    assert.deepStrictEqual(
      profiles.map((profile) => profile.kind),
      [
        vscode.TestRunProfileKind.Run,
        vscode.TestRunProfileKind.Debug,
        vscode.TestRunProfileKind.Coverage,
      ],
      'in the order the Test Explorer renders them',
    );
    assert.deepStrictEqual(
      profiles.map((profile) => profile.label),
      ['Run', 'Debug', 'Run with Coverage'],
      'with the labels the user picks from',
    );
    assert.strictEqual(
      new Set(profiles.map((profile) => profile.kind)).size,
      3,
      'no kind is registered twice, so no button runs the wrong handler',
    );
    // VS Code tracks a default PER KIND, and each kind here has exactly one
    // profile, so all three report `isDefault`. What matters is that the kinds
    // are distinct — one profile per button, none shadowing another.
    assert.strictEqual(
      profiles.filter((profile) => profile.isDefault).length,
      profiles.length,
      'each kind has exactly one profile, so each is the default for its own button',
    );
    const runProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Run);
    const debugProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Debug);
    const coverageProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Coverage);
    assert.strictEqual(runProfile.isDefault, true, '▶ must map to Run, not to Debug or Coverage');
    assert.strictEqual(
      debugProfile.kind,
      vscode.TestRunProfileKind.Debug,
      'the Debug button maps to the Debug profile, never to Run',
    );
    assert.strictEqual(
      coverageProfile.kind,
      vscode.TestRunProfileKind.Coverage,
      'and the Coverage button to the Coverage profile',
    );
    assert.notStrictEqual(runProfile, debugProfile, 'Run and Debug are distinct profiles');
    assert.notStrictEqual(runProfile, coverageProfile, 'as are Run and Coverage');
    assert.strictEqual(
      typeof coverageProfile.loadDetailedCoverage,
      'function',
      "Coverage must answer VS Code's on-demand per-line request",
    );
    assert.strictEqual(
      runProfile.loadDetailedCoverage,
      undefined,
      'and only Coverage answers it — Run collects nothing',
    );
    const target = CS.failing;
    // The terminal is sent a filter EXPRESSION, so metacharacters need escaping.
    assert.strictEqual(
      filterExpression([target]),
      `FullyQualifiedName=${target}`,
      'one selected test debugs under exactly one clause',
    );
    assert.strictEqual(
      filterExpression([FS_SPACED, target]),
      `FullyQualifiedName=${FS_SPACED}|FullyQualifiedName=${target}`,
      'a multi-test debug request keeps every test, OR-ed together',
    );
    assert.strictEqual(
      escapeFilterValue(NUNIT_CASE),
      'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)',
      'an NUnit [TestCase] FQN is escaped, or the adapter throws instead of running',
    );
    const before = api.testController.getResult(target);
    const sizeBefore = api.testController.cachedResults.size;
    const terminalsBefore = vscode.window.terminals.length;
    // Debugging executes nothing, so it must not be reported as a run either.
    const noChange = nextResultsChange(api.testController, 3_000);
    // Armed BEFORE the interaction: `onDidStartDebugSession` fires once, when
    // the adapter's launch round-trip succeeds, so a recorder installed
    // afterwards observes nothing and every assertion built on it is vacuous.
    const sessions = new DebugSessionRecorder();
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Debug,
      itemsFor(api, [target]),
    );
    const isDebugTerminal = (open: readonly vscode.Terminal[]): boolean =>
      open.some((terminal) => terminal.name === DEBUG_TERMINAL);
    const terminals = await pollUntilResult(
      async () => vscode.window.terminals,
      isDebugTerminal,
      DEBUG_SESSION_MS,
      250,
    );
    const names = terminals.map((terminal) => terminal.name).join(' | ');
    const debugTerminal = terminals.find((terminal) => terminal.name === DEBUG_TERMINAL);
    assert.ok(
      debugTerminal,
      `the Debug profile must open a '${DEBUG_TERMINAL}' terminal; open terminals: ${names}`,
    );
    assert.strictEqual(debugTerminal.name, DEBUG_TERMINAL, 'named so the user can find it');
    assert.strictEqual(
      debugTerminal.exitStatus,
      undefined,
      'and left live so a debugger can attach',
    );
    assert.strictEqual(
      terminals.length,
      terminalsBefore + 1,
      'exactly one terminal is opened per debug request',
    );
    assert.strictEqual(
      terminals.filter((terminal) => terminal.name === DEBUG_TERMINAL).length,
      1,
      'and a debug request never stacks up duplicates of it',
    );
    assert.strictEqual(
      await noChange,
      false,
      'debugging caches nothing, so no listener may be told results changed',
    );
    assert.strictEqual(
      api.testController.getResult(target),
      before,
      `${target} must keep the result its last real RUN produced — debugging must never fabricate one`,
    );
    assert.strictEqual(
      api.testController.cachedResults.size,
      sizeBefore,
      'the Debug profile must not add cache entries',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_TESTS),
      'nor touch the tree',
    );

    // Interaction 3 — a terminal is not a debugger. [DEBUG-FEATURES-TESTS] makes
    // "Debug individual test" a P1 row carried over DAP, and closes with the
    // rule that SharpLsp "sets `VSTEST_HOST_DEBUG=1` and attaches to the waiting
    // `testhost.exe`/`dotnet-testhost` child": the waiting host is only half the
    // gesture. A run that stops at the terminal leaves the user pressing Debug
    // and watching nothing happen — issue #233.
    const started = await sessions.waitForSessions(1, DEBUG_SESSION_MS).catch(() => sessions.ours);
    sessions.dispose();
    assert.notStrictEqual(
      started.length,
      0,
      'pressing Debug in the Testing view must START a debug session, not merely open a ' +
        'terminal for the user to attach to by hand',
    );
    assert.deepStrictEqual(
      [...new Set(started.map((session) => session.type))],
      [DEBUG_TYPE_ID],
      'and it is the SharpLsp adapter that attaches, not some other extension',
    );
    assert.strictEqual(
      started[0]?.configuration['justMyCode'],
      true,
      '"Just My Code in test context | launch config | P1": stepping out of a test must not ' +
        'land the user inside the xUnit runner',
    );
    assert.strictEqual(
      api.testController.getResult(target),
      before,
      'and attaching still caches nothing: a debug session is not a run',
    );
    debugTerminal.dispose();
  });

  test('a cancelled run resolves cleanly and never reports a pass', async function () {
    this.timeout(DOTNET_CLI_MS);
    // Whether cancellation lands before or after the invocation starts, neither
    // a red nor a skipped test may ever end up marked as passed.
    const selection = [CS.failing, FSX.skipped] as const;
    assert.strictEqual(
      selection.length,
      2,
      'a red and a skipped test — a cancelled run must not repaint either green',
    );
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, selection),
    );
    assertFailed(cachedFor(api, CS.failing), CS.failing);
    assertSkipped(cachedFor(api, FSX.skipped), FSX.skipped);
    const baseline = new Map(api.testController.cachedResults);
    const treeBefore = collectLeafIds(api.testController.items);
    assert.strictEqual(
      baseline.size > 0,
      true,
      'the baseline run cached something to compare against',
    );
    assert.strictEqual(
      treeBefore.length,
      ALL_TESTS.length,
      'the whole tree is standing before the cancelled run',
    );
    assert.strictEqual(baseline.get(CS.failing)?.outcome, 'failed', 'the baseline red test is red');
    assert.strictEqual(
      baseline.get(FSX.skipped)?.outcome,
      'skipped',
      'and the baseline skip is a skip',
    );

    // The user hits ⏹ immediately: the token is cancelled on the first tick.
    await assert.doesNotReject(async () => {
      await runViaProfile(
        api.testController,
        vscode.TestRunProfileKind.Run,
        itemsFor(api, selection),
        0,
      );
    }, 'a cancelled run must resolve, never reject — a rejected runHandler leaves the run spinning');
    for (const id of selection) {
      const result = cachedFor(api, id);
      assert.notStrictEqual(
        result.outcome,
        'passed',
        `${id} must never be marked passed by a cancelled run`,
      );
      assert.strictEqual(
        result.passed,
        false,
        `${id} must not carry a pass flag after cancellation`,
      );
      assert.strictEqual(
        ['failed', 'skipped', 'notRun'].includes(result.outcome),
        true,
        `${id} must keep an honest outcome after cancellation, got '${result.outcome}'`,
      );
    }
    assert.strictEqual(
      cachedFor(api, FSX.skipped).outcome,
      'skipped',
      'cancelling must not turn a skip into a failure either',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, FSX.skipped)),
      '$(debug-step-over) Skipped',
      'and the lens still renders it as a skip',
    );
    assert.strictEqual(cachedFor(api, CS.failing).passed, false, 'nor a failure into a pass');
    assert.notStrictEqual(
      cachedFor(api, CS.failing).message,
      undefined,
      'a cancelled run must not strip the failure text the last real run recorded',
    );
    assert.strictEqual(
      api.testController.cachedResults.size,
      baseline.size,
      'a cancelled run invents no cache entries',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(treeBefore),
      'a cancelled run leaves the tree exactly as it was',
    );
    assert.strictEqual(
      api.testController.getResult(CS.passing),
      baseline.get(CS.passing),
      'and must not touch tests it never selected',
    );
    assert.deepStrictEqual(
      sorted(fixtureKeys(api, ALL_TESTS)),
      sorted(ALL_TESTS),
      'a cancelled run removes no cached results',
    );
  });

  test('running an id no project contains reports notRun, names the id, and leaves the tree alone', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ghost = 'Ghost.Namespace.NoSuchClass.NoSuchTest';
    const treeBefore = collectLeafIds(api.testController.items);
    assert.strictEqual(
      treeBefore.includes(ghost),
      false,
      'the ghost id must not be in the tree to begin with',
    );
    assert.strictEqual(
      findItem(api.testController.items, ghost),
      undefined,
      'and it resolves to no tree item',
    );
    assert.strictEqual(
      api.testController.getResult(ghost),
      undefined,
      'nothing is cached for a test that never ran',
    );
    const sizeBefore = api.testController.cachedResults.size;
    const result = await api.testController.runSingle(ghost);
    assert.strictEqual(
      result.outcome,
      'notRun',
      `a filter matching nothing is 'notRun', neither a failure nor a pass (got '${result.outcome}')`,
    );
    assert.notStrictEqual(
      result.outcome,
      'failed',
      'reporting an unmatched filter as a failure is the old summary-scraping bug',
    );
    assert.notStrictEqual(
      result.outcome,
      'passed',
      'and reporting it as a pass would be worse still',
    );
    assert.strictEqual(result.passed, false, 'an unmatched filter is certainly not a pass');
    assert.strictEqual(
      result.message,
      `No result reported for ${ghost}`,
      `the user is told exactly which id matched nothing, got: ${result.message ?? 'none'}`,
    );
    assert.strictEqual(
      (result.message ?? '').includes(ghost),
      true,
      'the message names the id verbatim, spaces and all',
    );
    assert.strictEqual(
      typeof result.duration,
      'number',
      'the invocation still took wall-clock time, and that is reported',
    );
    assert.strictEqual(
      (result.duration ?? -1) >= 0,
      true,
      `a real invocation was made and timed, got ${String(result.duration)}`,
    );
    assert.strictEqual(
      api.testController.getResult(ghost),
      result,
      'runSingle caches exactly the result it resolved',
    );
    assert.strictEqual(
      api.testController.cachedResults.size,
      sizeBefore + 1,
      'exactly one new cache entry, for the ghost id',
    );
    assert.strictEqual(
      statusLensTitle(result),
      `$(circle-slash) Not run: No result reported for ${ghost}`,
      'the lens renders a not-run state carrying the reason',
    );
    assert.strictEqual(
      statusLensTitle(result).startsWith('$(error)'),
      false,
      'and never the error icon',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(treeBefore),
      'an unknown id must not add, remove or reorder tree items',
    );
    assert.strictEqual(
      findItem(api.testController.items, ghost),
      undefined,
      'running an unknown id must not invent a tree item for it',
    );
    assert.deepStrictEqual(
      sorted(fixtureKeys(api, ALL_TESTS)),
      sorted(ALL_TESTS),
      "and it must not disturb the fixture's cached results",
    );
  });

  test('the status lens renders exactly what the cache holds for a pass, a skip and a failure', async function () {
    this.timeout(DOTNET_CLI_MS);
    const selection = [CS.passing, CS.skipped, CS.failing, FSX.skipped, FSX.failing] as const;
    const items = itemsFor(api, selection);
    assert.strictEqual(
      items.length,
      5,
      'one pass, two skips and two failures are run for this test',
    );
    assert.deepStrictEqual(
      items.map((item) => item.id),
      [...selection],
      'and the run gets exactly them',
    );
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    const passed = cachedFor(api, CS.passing);
    assertPassed(passed, CS.passing);
    const passTitle = statusLensTitle(passed);
    assert.strictEqual(
      passTitle,
      `$(pass) Passed${formatDuration(passed.duration)}`,
      'a pass renders the pass icon and the duration the cache holds',
    );
    assert.strictEqual(
      /^\$\(pass\) Passed \((?:\d+ms|\d+\.\ds)\)$/.test(passTitle),
      true,
      `a pass renders ms under a second and seconds above it: ${passTitle}`,
    );
    assert.strictEqual(passTitle.includes('Failed'), false, 'a passing test never says Failed');
    const skip = cachedFor(api, CS.skipped);
    assertSkipped(skip, CS.skipped);
    const skipTitle = statusLensTitle(skip);
    assert.strictEqual(
      skipTitle,
      '$(debug-step-over) Skipped',
      'a skip renders as Skipped — rendering it as Failed is the bug this suite guards',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, FSX.skipped)),
      '$(debug-step-over) Skipped',
      'and an F# skip renders identically',
    );
    assert.strictEqual(
      skipTitle.includes('$(error)'),
      false,
      'a skip never carries the error icon',
    );
    assert.strictEqual(
      skipTitle.includes('$(pass)'),
      false,
      'a skip never carries the pass icon either',
    );
    const failure = cachedFor(api, CS.failing);
    assertFailed(failure, CS.failing);
    const failTitle = statusLensTitle(failure);
    assert.strictEqual(
      failTitle.startsWith('$(error) Failed: '),
      true,
      `a failure renders the error icon: ${failTitle}`,
    );
    assert.strictEqual(
      failTitle,
      `$(error) Failed: ${failure.message ?? ''}`,
      'the lens shows the cached message verbatim, with nothing summarised away',
    );
    assert.strictEqual(
      failTitle.includes('Assert.Equal() Failure'),
      true,
      `the lens must carry the real assertion text: ${failTitle}`,
    );
    assert.strictEqual(
      failTitle.includes('Expected'),
      true,
      `including the Expected detail: ${failTitle}`,
    );
    assert.notStrictEqual(
      failTitle,
      '$(error) Failed: Test failed',
      'the lens must never fall back to the generic placeholder',
    );
    const fsFailure = cachedFor(api, FSX.failing);
    assert.strictEqual(
      statusLensTitle(fsFailure),
      `$(error) Failed: ${fsFailure.message ?? ''}`,
      'an F# failure renders its own cached text, not the C# one',
    );
    assert.strictEqual(
      statusLensTitle(fsFailure).includes('Assert.Equal() Failure'),
      true,
      'and it carries its assertion text just as a C# failure does',
    );
    assert.strictEqual(
      statusLensTitle(fsFailure).startsWith('$(error) Failed: '),
      true,
      'an F# failure renders the error icon exactly as a C# one does',
    );
    assert.strictEqual(fsFailure.passed, false, 'and an F# failure is never a pass');
    const item = itemsFor(api, [FS_SPACED])[0];
    assert.ok(item, 'the spaced F# fact is still in the tree after the run');
    assert.strictEqual(
      item.label,
      'adds two numbers with spaces',
      'the label keeps every space the FQN carries',
    );
    assert.strictEqual(
      item.description,
      FS_SPACED,
      'and the description carries the whole FQN the lens keys on',
    );
    assert.strictEqual(
      comparablePath(item.uri?.fsPath ?? ''),
      comparablePath(path.dirname(slnPath)),
      "the item points at the loaded solution's folder",
    );
  });
});
