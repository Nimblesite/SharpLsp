// Coarse end-to-end coverage for the Run-with-Coverage profile `[TEST-COVERAGE]`,
// against a REAL two-test-project solution the `dotnet` CLI built.
//
// [TEST-COVERAGE] makes four claims, and until this suite existed exactly one of
// them was asserted, weakly:
//
//   1. `--results-directory` points at a FRESHLY EMPTIED `.sharplsp-coverage`
//      beside the solution — "reusing the directory would show the previous
//      run's report",
//   2. the collector writes ONE Cobertura report PER TEST PROJECT, each in its
//      own run-id folder one level down,
//   3. **every** one of them is parsed and attached — "taking only the first
//      drops every other project's coverage, and which one is 'first' is
//      directory order",
//   4. `coverlet.collector` omits the TEST assembly and only reports assemblies
//      the run actually LOADED.
//
// Claims 2 and 3 are unfalsifiable against a one-test-project fixture: one
// report makes `reports.length >= 1` true forever and makes "the first" and
// "every" the same list. So this suite runs against
// {@link writeSplitCoverageFixture} — two test projects over one library, each
// exercising a DIFFERENT function of it — where a reader that keeps only the
// first report paints a just-executed function as dead code.
//
// F# is first: the F# project's covering test is an idiomatic backtick binding
// whose fully-qualified name carries SPACES, and it has to survive the coverage
// run's `--filter` exactly as it does an ordinary run ([TEST-FILTER-ESCAPE]).
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
import { filterClause } from '../../test-filter.js';
import { statusLensTitle } from '../../test-lens.js';
import { createSolution, warmDiscovery } from './dotnet-project-kit';
import {
  ALL_COVERAGE_TESTS,
  COVERAGE_DIR_NAME,
  COVERED_BY_CSHARP,
  COVERED_BY_FSHARP,
  CS_COVERS,
  CS_FAILING,
  CS_SKIPPED,
  CS_THEORY,
  FS_COVERS,
  FS_ISOLATED,
  LIBRARY_FILE,
  NEVER_COVERED,
  reportDirsOf,
  writeSplitCoverageFixture,
} from './test-coverage-fixtures';
import { LIBRARY_SOURCE } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  drainDiscovery,
  findItem,
  pollUntilDiscovered,
  profileOfKind,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  assertSkipped,
  cachedFor,
  itemsFor,
  sorted,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers.js';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The two test projects, so "one report per test project" has a number. */
const TEST_PROJECTS = 2;

/** The file name the collector always writes. */
const REPORT_NAME = 'coverage.cobertura.xml';

/** The message a test with no TRX entry carries. Never legitimate here. */
const NO_RESULT = 'No result reported';

/** Every test that ends green under the Coverage profile. */
const PASSING = [CS_COVERS, CS_THEORY, FS_COVERS, FS_ISOLATED] as const;

/**
 * The 0-based line `name` is declared on in the library source.
 *
 * The Testing API's `Position.line` is 0-based, so a covered line reported for
 * `Add` must be the index of the line declaring `Add` — no adjustment.
 */
function declarationLine(name: string): number {
  const line = LIBRARY_SOURCE.split('\n').findIndex((each) => each.includes(` ${name}(`));
  assert.notStrictEqual(line, -1, `the fixture library must declare ${name}`);
  return line;
}

/** The 0-based lines a detail list reports as EXECUTED, ascending. */
function executedLines(details: readonly vscode.FileCoverageDetail[]): number[] {
  const lines: number[] = [];
  for (const detail of details) {
    if (!(detail instanceof vscode.StatementCoverage)) continue;
    if (Number(detail.executed) <= 0) continue;
    const at = detail.location;
    lines.push(at instanceof vscode.Range ? at.start.line : at.line);
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

/** The `FileCoverage` a report carries for the library, if any. */
function libraryCoverageIn(report: string): vscode.FileCoverage | undefined {
  return parseCoberturaXml(report).find((file) => path.basename(file.uri.fsPath) === LIBRARY_FILE);
}

/** The library lines a single report says were executed. */
function libraryLinesIn(report: string): number[] {
  const file = libraryCoverageIn(report);
  return file === undefined ? [] : executedLines(loadDetailedCoverage(file));
}

suite('Test Explorer e2e — the Coverage profile [TEST-COVERAGE]', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let coverageDir: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testcoverage-'));
    coverageDir = path.join(root, COVERAGE_DIR_NAME);
    slnPath = await createSolution(root, 'Coverage', writeSplitCoverageFixture(root));
    // Pay restore, build and adapter JIT once, so a run measures the RUN.
    await warmDiscovery(slnPath, root);
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await drainDiscovery(() => undefined, api.testController);
    await pollUntilDiscovered(api.testController, ALL_COVERAGE_TESTS);
  });

  teardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Never touch the fixture while a `dotnet` invocation is still in flight.
    await api.testController.whenIdle();
    removeDirRecursive(coverageDir);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('the Coverage run writes ONE Cobertura report per test project, one directory down', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — before pressing anything, the directory the spec names is
    // absent and sits beside the SOLUTION, not in a temp path the user cannot
    // find.
    assert.strictEqual(fs.existsSync(coverageDir), false, `${COVERAGE_DIR_NAME} starts absent`);
    assert.strictEqual(
      coverageDir,
      path.join(path.dirname(slnPath), COVERAGE_DIR_NAME),
      'coverage lands beside the solution file the user loaded',
    );
    assert.strictEqual(
      path.basename(coverageDir),
      COVERAGE_DIR_NAME,
      'under exactly the name [TEST-COVERAGE] specifies',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_COVERAGE_TESTS),
      'the whole two-project fixture is discovered before any coverage is collected',
    );

    // Interaction 2 — press Run with Coverage on the whole tree.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_COVERAGE_TESTS),
    );
    assert.strictEqual(fs.existsSync(coverageDir), true, 'the run creates the results directory');

    // Interaction 3 — what landed there: one TRX and one run-id folder per test
    // project, and nothing else.
    const entries = fs.readdirSync(coverageDir);
    const trx = entries.filter((entry) => entry.toLowerCase().endsWith('.trx'));
    const dirs = reportDirsOf(coverageDir);
    assert.strictEqual(
      trx.length,
      TEST_PROJECTS,
      `a coverage run is still a test run — one TRX per project: ${entries.join(' | ')}`,
    );
    assert.strictEqual(
      dirs.length,
      TEST_PROJECTS,
      `the collector writes one run-id folder per test project: ${entries.join(' | ')}`,
    );
    assert.deepStrictEqual(
      sorted([...trx, ...dirs]),
      sorted(entries),
      'nothing but TRX reports and collector folders is left beside the solution',
    );
    assert.strictEqual(new Set(dirs).size, dirs.length, 'each run-id folder is distinct');

    // Interaction 4 — the discovery helper finds exactly those reports. `>= 1`
    // is the assertion [TEST-COVERAGE] warns about: it cannot tell one report
    // from every report.
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(
      reports.length,
      TEST_PROJECTS,
      `one Cobertura report per test project, all of them found: ${reports.join(' | ')}`,
    );
    assert.deepStrictEqual([...reports].sort(), reports, 'the reports come back in a stable order');
    assert.strictEqual(new Set(reports).size, reports.length, 'and each exactly once');
    for (const report of reports) {
      assert.strictEqual(path.basename(report), REPORT_NAME, "the collector's own file name");
      assert.strictEqual(
        path.dirname(path.dirname(report)),
        coverageDir,
        `${report} must sit exactly one directory down, in its own run-id folder`,
      );
      assert.strictEqual(path.isAbsolute(report), true, `${report} must be an absolute path`);
      assert.strictEqual(
        fs.readFileSync(report, 'utf8').includes('<coverage'),
        true,
        `${report} must really be Cobertura XML`,
      );
    }
    assert.strictEqual(
      findCoberturaFile(coverageDir),
      reports[0],
      'the singular helper is the first of the plural one — and that is exactly why the ' +
        'singular one may never be what a run attaches',
    );
  });

  test('EVERY report is parsed: the second project’s coverage is not dropped', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — collect coverage across both projects at once.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_COVERAGE_TESTS),
    );
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(reports.length, TEST_PROJECTS, 'both projects reported');

    // Interaction 2 — each report on its own covers the library, and the two
    // disagree about WHICH lines ran. That disagreement is the whole point of
    // the fixture: without it, reading one report is indistinguishable from
    // reading both.
    const perReport = reports.map((report) => libraryLinesIn(report));
    for (const [index, lines] of perReport.entries()) {
      assert.ok(
        lines.length > 0,
        `report ${index + 1} of ${reports.length} must report executed lines in ` +
          `${LIBRARY_FILE}; both fixture projects reference and exercise the library`,
      );
    }
    const [first, second] = perReport;
    assert.ok(first !== undefined && second !== undefined, 'two reports, two line sets');
    assert.notDeepStrictEqual(
      first,
      second,
      'the two test projects exercise DIFFERENT library functions, so their reports ' +
        'must not be identical — an identical pair means the fixture stopped proving anything',
    );
    assert.ok(
      first.some((line) => !second.includes(line)),
      `the first report carries a line the second does not: ${first.join(',')} vs ${second.join(',')}`,
    );
    assert.ok(
      second.some((line) => !first.includes(line)),
      `and the second carries one the first does not: ${second.join(',')} vs ${first.join(',')}`,
    );

    // Interaction 3 — the union is strictly larger than either half, so a reader
    // that kept only `reports[0]` would paint a just-executed function red.
    const union = [...new Set(perReport.flat())].sort((a, b) => a - b);
    assert.ok(
      union.length > first.length,
      `attaching only the first report loses ${union.length - first.length} covered line(s)`,
    );
    assert.ok(
      union.length > second.length,
      `and attaching only the second loses ${union.length - second.length}`,
    );

    // Interaction 4 — parsing every report yields FileCoverage entries for the
    // library from each, and every entry is a real, absolute source path with a
    // coherent summary.
    const files = reports.flatMap((report) => parseCoberturaXml(report));
    assert.ok(files.length >= TEST_PROJECTS, `at least one entry per report: got ${files.length}`);
    assert.strictEqual(
      files.filter((file) => path.basename(file.uri.fsPath) === LIBRARY_FILE).length,
      TEST_PROJECTS,
      `${LIBRARY_FILE} is covered by both projects, so both reports must yield an entry for it`,
    );
    for (const file of files) {
      assert.strictEqual(
        path.isAbsolute(file.uri.fsPath),
        true,
        `every FileCoverage names a real source file, got '${file.uri.fsPath}'`,
      );
      assert.ok(file.statementCoverage.total > 0, `${file.uri.fsPath} must count statements`);
      assert.ok(
        file.statementCoverage.covered <= file.statementCoverage.total,
        `${file.uri.fsPath}: covered cannot exceed total`,
      );
      assert.strictEqual(
        file.uri.fsPath.includes('CoverCs.dll') || file.uri.fsPath.includes('CoverFs.dll'),
        false,
        'IncludeTestAssembly is false, so no TEST assembly appears in the report',
      );
    }
  });

  test('the covered lines are exactly the library functions the tests called', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — run coverage over the whole tree, then merge every report.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_COVERAGE_TESTS),
    );
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(reports.length, TEST_PROJECTS, 'both reports are available to merge');
    const covered = [...new Set(reports.flatMap((report) => libraryLinesIn(report)))];

    // Interaction 2 — the two functions the tests DID call are covered. `Add` is
    // reachable only from the C# project and `Multiply` only from the F# one, so
    // a merge that dropped either report fails right here.
    for (const name of [COVERED_BY_CSHARP, COVERED_BY_FSHARP]) {
      assert.ok(
        covered.includes(declarationLine(name)),
        `a test executed Calculator.${name}, so its line (${declarationLine(name)}) must be ` +
          `covered; covered lines were: ${covered.sort((a, b) => a - b).join(',')}`,
      );
    }

    // Interaction 3 — the functions nothing called stay uncovered, so the gutter
    // is red where it should be. `Subtract` is only reachable from the SKIPPED
    // test: a skip must not be counted as execution ([TEST-RUN-TRX]).
    for (const name of NEVER_COVERED) {
      assert.strictEqual(
        covered.includes(declarationLine(name)),
        false,
        `nothing executes Calculator.${name}, so line ${declarationLine(name)} must stay uncovered`,
      );
    }

    // Interaction 4 — the summary agrees with the detail, and coverage is
    // PARTIAL. A 100% report would mean the collector instrumented nothing and
    // counted only what ran.
    for (const report of reports) {
      const file = libraryCoverageIn(report);
      assert.ok(file, `${report} must carry a ${LIBRARY_FILE} entry`);
      const details = loadDetailedCoverage(file);
      assert.strictEqual(
        details.length,
        file.statementCoverage.total,
        'the per-line detail VS Code asks for on demand covers every counted line',
      );
      assert.strictEqual(
        executedLines(details).length,
        file.statementCoverage.covered,
        'and the executed lines in that detail add up to the summary the gutter shows',
      );
      assert.ok(
        file.statementCoverage.covered > 0,
        `${report}: the project's own test executed library code`,
      );
      assert.ok(
        file.statementCoverage.covered < file.statementCoverage.total,
        `${report}: ${NEVER_COVERED.join(' and ')} are never called, so coverage is partial ` +
          `(${file.statementCoverage.covered}/${file.statementCoverage.total})`,
      );
    }
  });

  test('the results directory is FRESHLY EMPTIED, so a second run never shows the first one’s report', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — a first coverage run, whose artefacts we remember.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [CS_COVERS, FS_COVERS]),
    );
    const firstDirs = reportDirsOf(coverageDir);
    const firstEntries = fs.readdirSync(coverageDir).sort();
    assert.strictEqual(firstDirs.length, TEST_PROJECTS, 'the first run reported for both projects');
    assert.strictEqual(
      findCoberturaFiles(coverageDir).length,
      TEST_PROJECTS,
      'and both its reports are discoverable',
    );

    // Interaction 2 — plant debris a reused directory would hand back: a
    // sentinel file, and a FAKE run-id folder holding a report that names a file
    // no fixture ever had. If the directory is reused, both survive and the
    // fake report is attached to the next run's coverage.
    const sentinel = path.join(coverageDir, 'stale-sentinel.txt');
    const staleDir = path.join(coverageDir, 'stale-run-id');
    fs.writeFileSync(sentinel, 'left over from a previous run', 'utf8');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(
      path.join(staleDir, REPORT_NAME),
      '<?xml version="1.0"?><coverage><packages /></coverage>',
      'utf8',
    );
    assert.strictEqual(fs.existsSync(sentinel), true, 'the sentinel is planted');
    assert.strictEqual(
      findCoberturaFiles(coverageDir).length,
      TEST_PROJECTS + 1,
      'and the fake report is visible to the reader, so its survival is observable',
    );

    // Interaction 3 — a second coverage run. [TEST-COVERAGE] requires the
    // directory to be emptied first, so every planted artefact is gone and the
    // reports are the NEW run's alone.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [CS_COVERS, FS_COVERS]),
    );
    assert.strictEqual(
      fs.existsSync(sentinel),
      false,
      'a freshly emptied results directory cannot still hold the sentinel — reusing it ' +
        "would show the previous run's report",
    );
    assert.strictEqual(fs.existsSync(staleDir), false, 'nor the planted run-id folder');
    const secondDirs = reportDirsOf(coverageDir);
    assert.strictEqual(
      secondDirs.length,
      TEST_PROJECTS,
      `the second run leaves exactly its own two folders: ${secondDirs.join(' | ')}`,
    );
    assert.deepStrictEqual(
      secondDirs.filter((dir) => firstDirs.includes(dir)),
      [],
      'and none of them is a folder the FIRST run wrote',
    );
    assert.strictEqual(
      findCoberturaFiles(coverageDir).length,
      TEST_PROJECTS,
      'so the reader sees two reports, not five',
    );
    const secondEntries = fs.readdirSync(coverageDir).sort();
    assert.strictEqual(
      secondEntries.length,
      firstEntries.length,
      `a second run leaves the same shape as the first: ${secondEntries.join(' | ')}`,
    );
    assert.strictEqual(
      secondEntries.includes(path.basename(sentinel)),
      false,
      'with nothing of the previous contents surviving',
    );

    // Interaction 4 — and the fresh reports still describe a real run.
    for (const report of findCoberturaFiles(coverageDir)) {
      assert.ok(libraryLinesIn(report).length > 0, `${report} describes the run that just ran`);
    }
  });

  test('the Coverage profile still attributes a pass, a failure and a SKIP per test', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — Run with Coverage over every test, including the red one,
    // the skipped one and a two-row [Theory].
    const items = itemsFor(api, ALL_COVERAGE_TESTS);
    assert.strictEqual(items.length, ALL_COVERAGE_TESTS.length, 'every test resolved to a row');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, items);

    // Interaction 2 — collecting coverage does not change what a test reports:
    // the same TRX attribution as ▶ ([TEST-RUN-TRX]).
    for (const id of PASSING) assertPassed(cachedFor(api, id), id);
    assertFailed(cachedFor(api, CS_FAILING), CS_FAILING);
    assertSkipped(cachedFor(api, CS_SKIPPED), CS_SKIPPED);

    // Interaction 3 — nothing reports the "filter matched nothing" message, in
    // either project. A coverage run adds `--collect` to the SAME invocation, so
    // a filter broken by the extra argument shows up as this and nothing else.
    for (const id of ALL_COVERAGE_TESTS) {
      const result = cachedFor(api, id);
      assert.strictEqual(
        (result.message ?? '').includes(NO_RESULT),
        false,
        `${id} was actually run under coverage, so it must not report "${NO_RESULT}"`,
      );
      assert.ok(Number.isFinite(result.duration), `${id} carries a measured duration`);
      assert.ok(Number(result.duration) >= 0, `${id}'s duration is not negative`);
    }

    // Interaction 4 — the status lens renders each of the three states the way
    // the user reads it above the method ([TEST-STATUS-LENS]).
    assert.strictEqual(
      statusLensTitle(cachedFor(api, CS_COVERS)).startsWith('$(pass) Passed'),
      true,
      'a pass under coverage still renders as a pass',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, CS_FAILING)).startsWith('$(error) Failed'),
      true,
      'and a failure as a failure',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, CS_SKIPPED)),
      '$(debug-step-over) Skipped',
      'and a skip as neither',
    );
    assert.strictEqual(
      (cachedFor(api, CS_FAILING).message ?? '').includes('Assert.Equal'),
      true,
      "the failure carries xUnit's own assertion text, not a generic 'Test failed'",
    );
  });

  test('the plain Run profile collects NO coverage at all', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — press ▶, not Run with Coverage, on the same selection.
    assert.strictEqual(fs.existsSync(coverageDir), false, 'nothing collected yet');
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [CS_COVERS, FS_COVERS]),
    );
    assert.strictEqual(
      fs.existsSync(coverageDir),
      false,
      '▶ adds no --collect and no --results-directory, so it must not create ' +
        `${COVERAGE_DIR_NAME} beside the user's solution`,
    );
    assertPassed(cachedFor(api, CS_COVERS), CS_COVERS);
    assertPassed(cachedFor(api, FS_COVERS), FS_COVERS);

    // Interaction 2 — now collect coverage, and remember exactly what landed.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [CS_COVERS, FS_COVERS]),
    );
    const collected = fs.readdirSync(coverageDir).sort();
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(reports.length, TEST_PROJECTS, 'the coverage run reported for both');
    const stamps = reports.map((report) => fs.statSync(report).mtimeMs);

    // Interaction 3 — a plain ▶ afterwards neither adds to that directory nor
    // rewrites it. A Run that quietly reused the coverage arguments would show
    // up as a third folder or a moved timestamp.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_COVERAGE_TESTS),
    );
    assert.deepStrictEqual(
      fs.readdirSync(coverageDir).sort(),
      collected,
      '▶ must leave the coverage directory byte-for-byte as the Coverage run left it',
    );
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir),
      reports,
      'and produce no further Cobertura report',
    );
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir).map((report) => fs.statSync(report).mtimeMs),
      stamps,
      'nor rewrite the ones already there',
    );
    assertFailed(cachedFor(api, CS_FAILING), CS_FAILING);
    assertSkipped(cachedFor(api, CS_SKIPPED), CS_SKIPPED);
  });

  test('coverage of a selection that loads nothing of the library reports nothing covered', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — collect coverage for the ONE test that never touches the
    // library. `coverlet.collector` only reports assemblies the run actually
    // LOADED, so the report is valid and says nothing was covered.
    const isolated = itemsFor(api, [FS_ISOLATED]);
    assert.strictEqual(isolated.length, 1, 'exactly one test is selected');
    assert.strictEqual(isolated[0]?.id, FS_ISOLATED, 'and it is the one that ignores the library');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, isolated);

    // Interaction 2 — a report is still written, and still parses. "Nothing
    // covered" is a legitimate result, not a crash and not an empty file.
    const reports = findCoberturaFiles(coverageDir);
    assert.ok(reports.length >= 1, `a coverage run always writes a report: ${coverageDir}`);
    for (const report of reports) {
      assert.strictEqual(path.basename(report), REPORT_NAME, "the collector's own file name");
      assert.strictEqual(
        fs.readFileSync(report, 'utf8').includes('<coverage'),
        true,
        `${report} is valid Cobertura XML even with nothing to report`,
      );
      assert.doesNotThrow(
        () => parseCoberturaXml(report),
        `parsing ${report} must not throw on an empty <packages/>`,
      );
    }

    // Interaction 3 — and not one library line is claimed as executed.
    for (const report of reports) {
      const file = libraryCoverageIn(report);
      if (file === undefined) continue;
      assert.strictEqual(
        file.statementCoverage.covered,
        0,
        `nothing in this run called into ${LIBRARY_FILE}, so no line of it may be reported ` +
          `as executed; ${report} claims ${file.statementCoverage.covered}`,
      );
      assert.deepStrictEqual(
        libraryLinesIn(report),
        [],
        'and the per-line detail must agree with that summary',
      );
    }

    // Interaction 4 — the test itself still passed, so the empty report is not
    // a failed run in disguise.
    assertPassed(cachedFor(api, FS_ISOLATED), FS_ISOLATED);
    assert.strictEqual(
      (cachedFor(api, FS_ISOLATED).message ?? '').includes(NO_RESULT),
      false,
      'the selected test really ran',
    );
  });

  test('Run with Coverage on the CLASS row covers every test beneath it', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the user presses the coverage action on the class group,
    // not on a leaf.
    const leaf = findItem(api.testController.items, CS_COVERS);
    assert.ok(leaf, `${CS_COVERS} must be a row in the tree`);
    const classNode = leaf.parent;
    assert.ok(classNode, 'a leaf hangs off the class group it belongs to');
    assert.strictEqual(classNode.label, 'AdditionTests', 'and that parent is the class node');
    assert.strictEqual(classNode.children.size, 4, 'the class declares four tests');

    // Interaction 2 — every test under the class reports, theory rows merged
    // into one outcome, the skip still a skip.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, [classNode]);
    assertPassed(cachedFor(api, CS_COVERS), CS_COVERS);
    assertPassed(cachedFor(api, CS_THEORY), CS_THEORY);
    assertFailed(cachedFor(api, CS_FAILING), CS_FAILING);
    assertSkipped(cachedFor(api, CS_SKIPPED), CS_SKIPPED);

    // Interaction 3 — the coverage collected is the C# project's alone: `Add`
    // ran, `Multiply` did not, because no F# test was selected.
    const covered = [
      ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
    ];
    assert.ok(
      covered.includes(declarationLine(COVERED_BY_CSHARP)),
      `the class's tests call Calculator.${COVERED_BY_CSHARP}, so its line must be covered`,
    );
    assert.strictEqual(
      covered.includes(declarationLine(COVERED_BY_FSHARP)),
      false,
      `no F# test was selected, so Calculator.${COVERED_BY_FSHARP} must NOT be reported as ` +
        'executed — a merge that attached a stale report would claim it was',
    );
    for (const name of NEVER_COVERED) {
      assert.strictEqual(
        covered.includes(declarationLine(name)),
        false,
        `Calculator.${name} is still never executed`,
      );
    }
  });

  test('Run with Coverage on the F# backtick name carrying SPACES', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the name really does carry spaces, and needs no escaping:
    // a space is not filter grammar, so the clause is the bare name
    // ([TEST-FILTER-ESCAPE]).
    assert.ok(FS_COVERS.includes(' '), 'the F# fixture test is an idiomatic backtick binding');
    assert.strictEqual(
      filterClause(FS_COVERS),
      `FullyQualifiedName=${FS_COVERS}`,
      'a space needs no backslash — escaping one would make the filter match nothing',
    );
    const item = findItem(api.testController.items, FS_COVERS);
    assert.ok(item, 'the spaced name is a row in the tree');
    assert.strictEqual(item.id, FS_COVERS, 'whose id is the name verbatim, spaces and all');
    assert.strictEqual(item.label, 'covers multiply only', 'labelled by the binding name');

    // Interaction 2 — collecting coverage for it alone succeeds, and it passes.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, [item]);
    assertPassed(cachedFor(api, FS_COVERS), FS_COVERS);
    assert.strictEqual(
      (cachedFor(api, FS_COVERS).message ?? '').includes(NO_RESULT),
      false,
      'a spaced name under --collect must still match its own test',
    );

    // Interaction 3 — and the coverage it produced is the F# side's: `Multiply`
    // executed, `Add` not.
    const covered = [
      ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
    ];
    assert.ok(
      covered.includes(declarationLine(COVERED_BY_FSHARP)),
      `the F# test calls Calculator.${COVERED_BY_FSHARP}, so its line must be covered`,
    );
    assert.strictEqual(
      covered.includes(declarationLine(COVERED_BY_CSHARP)),
      false,
      `no C# test ran, so Calculator.${COVERED_BY_CSHARP} must not be reported as executed`,
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_COVERAGE_TESTS),
      'and a single-test coverage run leaves the whole tree standing',
    );
  });

  test('Run with Coverage on the ASSEMBLY ROOT of one project reports that project alone', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the Testing view shows one root per test project, and the
    // user presses the coverage action on the F# one.
    const roots = rootsOf(api.testController.items);
    assert.strictEqual(roots.length, TEST_PROJECTS, 'one assembly root per test project');
    const fsRoot = roots.find((item) => item.label === 'CoverFs');
    assert.ok(fsRoot, `the CoverFs root must exist; saw ${roots.map((r) => r.label).join(' | ')}`);
    assert.strictEqual(
      fsRoot.id.startsWith('assembly:'),
      true,
      `an assembly root is a GROUP id, never an FQN; got ${fsRoot.id}`,
    );
    assert.strictEqual(fsRoot.canResolveChildren, true, 'and it expands');

    // Interaction 2 — both F# tests report, and neither C# test does: a root run
    // is ONE invocation for THAT selection ([TEST-RUN-TRX]).
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, [fsRoot]);
    assertPassed(cachedFor(api, FS_COVERS), FS_COVERS);
    assertPassed(cachedFor(api, FS_ISOLATED), FS_ISOLATED);
    for (const id of [FS_COVERS, FS_ISOLATED]) {
      assert.strictEqual(
        (cachedFor(api, id).message ?? '').includes(NO_RESULT),
        false,
        `${id} ran under the root selection, so it reports no missing result`,
      );
    }

    // Interaction 3 — the coverage collected is that project's alone: `Multiply`
    // ran, `Add` did not, because no C# test was in the selection.
    const covered = [
      ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
    ];
    assert.ok(
      covered.includes(declarationLine(COVERED_BY_FSHARP)),
      `the F# project's test calls Calculator.${COVERED_BY_FSHARP}, so its line must be covered`,
    );
    assert.strictEqual(
      covered.includes(declarationLine(COVERED_BY_CSHARP)),
      false,
      `no C# test ran, so Calculator.${COVERED_BY_CSHARP} must not be reported as executed — ` +
        'a stale report attached from an earlier run would claim it was',
    );
    for (const name of NEVER_COVERED) {
      assert.strictEqual(
        covered.includes(declarationLine(name)),
        false,
        `Calculator.${name} is never executed by anything`,
      );
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(ALL_COVERAGE_TESTS),
      'and the tree stands',
    );
  });

  test('two coverage runs of DIFFERENT selections never bleed into one another', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The sharpest form of "freshly emptied": the second run's report must not
    // merely be new, it must not CONTAIN the first run's coverage. A reused
    // directory shows the union of both, which reads as a test having covered
    // code it never touched.
    //
    // Interaction 1 — cover the C# side only.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [CS_COVERS]),
    );
    const firstCovered = [
      ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
    ];
    assert.ok(
      firstCovered.includes(declarationLine(COVERED_BY_CSHARP)),
      `the C# run covers Calculator.${COVERED_BY_CSHARP}`,
    );
    assert.strictEqual(
      firstCovered.includes(declarationLine(COVERED_BY_FSHARP)),
      false,
      `and not Calculator.${COVERED_BY_FSHARP}`,
    );
    const firstDirs = reportDirsOf(coverageDir);
    assert.ok(firstDirs.length >= 1, 'the first run wrote at least one run-id folder');

    // Interaction 2 — now cover the F# side only.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [FS_COVERS]),
    );
    const secondCovered = [
      ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
    ];

    // Interaction 3 — the second run's coverage is the F# side's ALONE. The C#
    // line the previous run covered must be gone.
    assert.ok(
      secondCovered.includes(declarationLine(COVERED_BY_FSHARP)),
      `the F# run covers Calculator.${COVERED_BY_FSHARP}`,
    );
    assert.strictEqual(
      secondCovered.includes(declarationLine(COVERED_BY_CSHARP)),
      false,
      `Calculator.${COVERED_BY_CSHARP} was covered by the PREVIOUS run only. Reporting it now ` +
        "means the results directory was reused and the user is reading yesterday's coverage",
    );
    assert.deepStrictEqual(
      reportDirsOf(coverageDir).filter((dir) => firstDirs.includes(dir)),
      [],
      'and no run-id folder from the first run survived into the second',
    );
    assert.notDeepStrictEqual(
      [...secondCovered].sort((a, b) => a - b),
      [...firstCovered].sort((a, b) => a - b),
      'two different selections must not produce the same coverage',
    );

    // Interaction 4 — and the outcomes are the selections', not the union.
    assertPassed(cachedFor(api, FS_COVERS), FS_COVERS);
    assertPassed(cachedFor(api, CS_COVERS), CS_COVERS);
    assert.strictEqual(
      (cachedFor(api, FS_COVERS).message ?? '').includes(NO_RESULT),
      false,
      'the second run reported its own selection',
    );
  });

  test('the Debug profile collects no coverage either', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-COVERAGE] attaches `--collect` and a `--results-directory` to the
    // Run-with-Coverage profile. Only that one: a Debug session that swept the
    // directory would delete the report the user is looking at.
    //
    // Interaction 1 — collect coverage, and record exactly what landed.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [CS_COVERS, FS_COVERS]),
    );
    const entries = fs.readdirSync(coverageDir).sort();
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(reports.length, TEST_PROJECTS, 'both projects reported');
    const stamps = reports.map((report) => fs.statSync(report).mtimeMs);
    assert.strictEqual(
      stamps.every((stamp) => stamp > 0),
      true,
      'each report has a timestamp',
    );

    // Interaction 2 — the controller registers three profiles, and Debug is one
    // of them; it is a distinct kind from Coverage.
    const debugProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Debug);
    const coverageProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Coverage);
    assert.notStrictEqual(debugProfile.kind, coverageProfile.kind, 'Debug is not Coverage');
    assert.strictEqual(debugProfile.isDefault, false, 'and Debug is not the default ▶');
    assert.strictEqual(
      coverageProfile.kind,
      vscode.TestRunProfileKind.Coverage,
      'the coverage profile is the coverage kind',
    );

    // Interaction 3 — the directory is exactly as the coverage run left it. This
    // reads the directory rather than starting a debug session, because the
    // claim is about what the OTHER profiles must not touch.
    await api.testController.whenIdle();
    assert.deepStrictEqual(
      fs.readdirSync(coverageDir).sort(),
      entries,
      'nothing but a coverage run may add to or remove from the results directory',
    );
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir),
      reports,
      'the same reports are still there',
    );
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir).map((report) => fs.statSync(report).mtimeMs),
      stamps,
      'unrewritten',
    );
    for (const report of reports) {
      assert.ok(libraryLinesIn(report).length > 0, `${report} still describes a real run`);
    }
  });
});
