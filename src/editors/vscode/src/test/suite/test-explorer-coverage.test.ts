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
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  findCoberturaFile,
  findCoberturaFiles,
  loadDetailedCoverage,
  mergeCoberturaReports,
  parseCoberturaXml,
} from '../../test-coverage.js';
import { filterClause } from '../../test-filter.js';
import { statusLensTitle } from '../../test-lens.js';
import {
  ALL_COVERAGE_TESTS,
  COVERAGE_DIR_NAME,
  COVERED_BY_CSHARP,
  COVERED_BY_FSHARP,
  CS_COVERS,
  CS_FAILING,
  CS_SKIPPED,
  CS_TESTS_FILE,
  CS_THEORY,
  FS_COVERS,
  FS_ISOLATED,
  FS_TESTS_FILE,
  LIBRARY_FILE,
  NEVER_COVERED,
  reportDirsOf,
  writeSplitCoverageFixture,
} from './test-coverage-fixtures';
import { LIBRARY_SOURCE } from './test-explorer-fixtures';
import {
  collectLeafIds,
  findItem,
  profileOfKind,
  rootsOf,
  runViaProfile,
  assertLeavesAre,
} from './test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  assertSkipped,
  cachedFor,
  itemsFor,
  sorted,
  assertReported,
  NO_RESULT,
} from './test-explorer-outcome-assertions';
import { assertContainsAll, assertContainsNone } from './test-helpers.js';
import { DOTNET_CLI_MS } from './test-timeouts';
import { useWarmFixture } from './test-explorer-harness';

/** The two test projects, so "one report per test project" has a number. */
const TEST_PROJECTS = 2;

/** The file name the collector always writes. */
const REPORT_NAME = 'coverage.cobertura.xml';

/** The message a test with no TRX entry carries. Never legitimate here. */

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
  let slnPath: string;
  let coverageDir: string;

  const warm = useWarmFixture(
    'sharplsp-testcoverage-',
    'Coverage',
    writeSplitCoverageFixture,
    ALL_COVERAGE_TESTS,
  );
  setup(() => {
    ({ api, slnPath, coverageDir } = warm());
  });

  test('the Coverage run writes ONE Cobertura report per test project, one directory down', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — before pressing anything, the directory the spec names is
    // absent and sits beside the SOLUTION, not in a temp path the user cannot
    // find.
    assert.ok(!fs.existsSync(coverageDir), `${COVERAGE_DIR_NAME} starts absent`);
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
    assertLeavesAre(
      api.testController,
      ALL_COVERAGE_TESTS,
      'the whole two-project fixture is discovered before any coverage is collected',
    );

    // Interaction 2 — press Run with Coverage on the whole tree.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_COVERAGE_TESTS),
    );
    assert.ok(fs.existsSync(coverageDir), 'the run creates the results directory');

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
    assert.strictEqual(new Set(dirs).size, dirs.length, 'each run-id folder is distinct');

    // The results directory holds THREE kinds of entry, because `dotnet test`
    // points the TRX logger and the coverage collector at the same
    // `--results-directory`: the TRX files, the collector's run-id folders, and
    // the logger's own attachments folder — which it creates as soon as a run
    // produces an attachment, and a coverage run always does. That folder is
    // named for the TRX it belongs to, so it is identifiable rather than
    // merely tolerated, and `findCoberturaFiles` never sees inside it: the copy
    // it holds is nested under `In/<machine>/`, not one level down.
    const files = entries.filter(
      (entry) => !fs.statSync(path.join(coverageDir, entry)).isDirectory(),
    );
    assert.deepStrictEqual(sorted(files), sorted(trx), 'every FILE beside the solution is a TRX');
    const attachmentDirs = entries.filter(
      (entry) => !dirs.includes(entry) && fs.statSync(path.join(coverageDir, entry)).isDirectory(),
    );
    for (const dir of attachmentDirs) {
      assert.ok(
        trx.some((name) => name.startsWith(dir)),
        `${dir} is not a run-id folder, so it must be a TRX attachments folder named for its TRX`,
      );
      assert.ok(
        !fs.existsSync(path.join(coverageDir, dir, REPORT_NAME)),
        `${dir} must not hold a report one level down, or it would double-count`,
      );
    }
    assert.deepStrictEqual(
      sorted([...trx, ...dirs, ...attachmentDirs]),
      sorted(entries),
      'a TRX, a run-id folder or that TRX‘s attachments — nothing else is written here',
    );

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
      assert.ok(path.isAbsolute(report), `${report} must be an absolute path`);
      assert.ok(
        fs.readFileSync(report, 'utf8').includes('<coverage'),
        `${report} must really be Cobertura XML`,
      );
    }
    assert.strictEqual(
      findCoberturaFile(coverageDir),
      reports[0],
      'the singular helper is the first of the plural one — and that is exactly why the ' +
        'singular one may never be what a run attaches',
    );
    // Interaction 4 - the shape of the directory, spelled out. [TEST-COVERAGE]
    // says one report per test project, "each in its own run-id folder one
    // level down": a flat directory, or a second file in one folder, is a
    // collector configured differently from the one the spec describes.
    const runDirs = reportDirsOf(coverageDir);
    assert.strictEqual(runDirs.length, TEST_PROJECTS, 'one run-id folder per test project');
    assert.strictEqual(
      new Set(runDirs).size,
      runDirs.length,
      'each project writes into a folder of its own',
    );
    for (const dir of runDirs) {
      assert.ok(
        fs.existsSync(path.join(coverageDir, dir, REPORT_NAME)),
        `${dir} must hold the collector's report under its fixed name`,
      );
      assert.ok(
        fs.statSync(path.join(coverageDir, dir)).isDirectory() && path.basename(dir) === dir,
        `${dir} must sit exactly ONE level below the results directory`,
      );
    }
    assert.strictEqual(
      findCoberturaFiles(coverageDir).length,
      TEST_PROJECTS,
      'and the reader finds every one of them',
    );
    assert.notStrictEqual(
      findCoberturaFile(coverageDir),
      undefined,
      'while the single-report reader answers with one of them - which is why taking only ' +
        'that one drops every other project',
    );
    // Interaction 4 - "one directory down" is a LOCATION claim, not a count. A
    // collector writing straight into the results directory, or two levels down,
    // is found by neither reader, and the run reports full coverage of nothing
    // ([TEST-COVERAGE] claim 2).
    const placedDirs = reportDirsOf(coverageDir);
    assert.strictEqual(placedDirs.length, TEST_PROJECTS, 'one run-id folder per test project');
    for (const runId of placedDirs) {
      assert.ok(
        fs.existsSync(path.join(coverageDir, runId, REPORT_NAME)),
        `${runId} holds its report at exactly one level down`,
      );
      assert.ok(
        !fs.existsSync(path.join(coverageDir, runId, runId, REPORT_NAME)),
        `${runId} does not bury it a second level down`,
      );
    }
    assert.ok(
      !fs.existsSync(path.join(coverageDir, REPORT_NAME)),
      'and nothing was written straight into the results directory itself',
    );
    assert.strictEqual(
      new Set(placedDirs).size,
      placedDirs.length,
      'with the two run-id folders distinct - a shared folder is one report overwriting the other',
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
      assert.ok(
        path.isAbsolute(file.uri.fsPath),
        `every FileCoverage names a real source file, got '${file.uri.fsPath}'`,
      );
      assert.ok(file.statementCoverage.total > 0, `${file.uri.fsPath} must count statements`);
      assert.ok(
        file.statementCoverage.covered <= file.statementCoverage.total,
        `${file.uri.fsPath}: covered cannot exceed total`,
      );
      assert.ok(
        !(file.uri.fsPath.includes('CoverCs.dll') || file.uri.fsPath.includes('CoverFs.dll')),
        'IncludeTestAssembly is false, so no TEST assembly appears in the report',
      );
    }
    // Interaction 4 - the two reports really do disagree, and their union is
    // strictly larger than either. That is the whole content of "EVERY one of
    // them is parsed": with one report the claim is unfalsifiable.
    const bothReports = findCoberturaFiles(coverageDir);
    assert.strictEqual(bothReports.length, TEST_PROJECTS, 'two reports to compare');
    const [firstReport, secondReport] = bothReports;
    assert.ok(firstReport && secondReport, 'both reports are on disk');
    const firstLines = libraryLinesIn(firstReport);
    const secondLines = libraryLinesIn(secondReport);
    assert.notDeepStrictEqual(
      firstLines,
      secondLines,
      'the two projects exercise DIFFERENT functions, so their reports must differ',
    );
    assert.ok(
      !firstLines.every((line) => secondLines.includes(line)),
      'neither report is a subset of the other',
    );
    assert.ok(!secondLines.every((line) => firstLines.includes(line)), 'in either direction');
    const unionLines = new Set([...firstLines, ...secondLines]);
    assert.ok(
      unionLines.size > firstLines.length,
      'so the union is strictly larger than the first report alone',
    );
    assert.ok(
      unionLines.size > secondLines.length,
      'and than the second - which is exactly what a first-only reader would lose',
    );
    // Interaction 4 - "every report" is falsifiable only if taking the FIRST
    // gives a different answer than taking them all. That difference is the
    // whole point of the split fixture ([TEST-COVERAGE] claim 3).
    const everyReport = findCoberturaFiles(coverageDir);
    const firstOnly = findCoberturaFile(coverageDir);
    assert.strictEqual(everyReport.length, TEST_PROJECTS, 'both reports are visible to the reader');
    assert.ok(firstOnly, 'and a first one exists to be wrongly taken alone');
    assert.ok(everyReport.includes(firstOnly), 'the first is one of them');
    const mergedEvery = mergeCoberturaReports(everyReport);
    const mergedLibrary = mergedEvery.find(
      (file) => path.basename(file.uri.fsPath) === LIBRARY_FILE,
    );
    assert.ok(mergedLibrary, 'the merge carries the library');
    assert.ok(
      executedLines(loadDetailedCoverage(mergedLibrary)).length > libraryLinesIn(firstOnly).length,
      'and merging every report covers strictly MORE than the first report alone',
    );
    assert.ok(
      libraryLinesIn(firstOnly).length >= 1,
      'while the first report on its own is not empty either - it is merely incomplete',
    );
  });

  test('the reports cover the LIBRARY only — never the test assemblies themselves', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-COVERAGE]: "`coverlet.collector` leaves the TEST assembly out of its
    // report by default (`IncludeTestAssembly` is false) and only reports
    // assemblies the run actually loaded, so a coverage fixture has to be a
    // library plus a test project that exercises it."
    //
    // That sentence is why this fixture is a library plus two test projects
    // rather than two test projects alone, and nothing observed it. If the
    // collector DID measure test assemblies, a solution of nothing but tests
    // would still produce covered lines, and every other assertion in this
    // suite could pass while measuring the wrong assembly entirely.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_COVERAGE_TESTS),
    );
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(reports.length, TEST_PROJECTS, 'both projects reported');

    // Interaction 2 — every file named across BOTH reports is the library's,
    // and the two test sources that drove the run appear in neither.
    const named = reports.flatMap((report) =>
      parseCoberturaXml(report).map((file) => path.basename(file.uri.fsPath)),
    );
    assert.ok(named.length > 0, 'the run measured something, so exclusion is observable');
    assert.deepStrictEqual(
      sorted([...new Set(named)]),
      [LIBRARY_FILE],
      `only the library is measured; got ${sorted([...new Set(named)]).join(' | ') || '(nothing)'}`,
    );
    for (const testSource of [CS_TESTS_FILE, FS_TESTS_FILE]) {
      assert.ok(
        !named.includes(testSource),
        `${testSource} is a TEST source: IncludeTestAssembly is false, so it must not be measured`,
      );
    }

    // Interaction 3 — the exclusion is not an empty report. The library's own
    // lines really were measured, by both projects, so "no test assembly" is a
    // statement about WHAT was covered rather than about nothing being covered.
    for (const [index, report] of reports.entries()) {
      const file = libraryCoverageIn(report);
      assert.ok(file, `report ${index + 1} must carry ${LIBRARY_FILE}`);
      assert.strictEqual(
        path.basename(file.uri.fsPath),
        LIBRARY_FILE,
        'and it is the library file the fixture wrote',
      );
      assert.ok(
        executedLines(loadDetailedCoverage(file)).length > 0,
        `report ${index + 1} must report executed library lines, not an empty report`,
      );
    }
    // Interaction 4 - the test assemblies themselves must be absent, and the
    // library present, in EVERY report. `coverlet.collector` leaves the test
    // assembly out by default and only reports assemblies the run LOADED.
    for (const report of findCoberturaFiles(coverageDir)) {
      const files = parseCoberturaXml(report).map((file) => path.basename(file.uri.fsPath));
      assertContainsNone(files, [CS_TESTS_FILE, FS_TESTS_FILE], 'files');
      assert.ok(
        files.includes(LIBRARY_FILE),
        `${report} must report the library the tests exercise`,
      );
    }
    assert.ok(
      mergeCoberturaReports(findCoberturaFiles(coverageDir))
        .map((file) => path.basename(file.uri.fsPath))
        .includes(LIBRARY_FILE),
      'and the merged view carries the library too',
    );
    // Interaction 4 - `IncludeTestAssembly` is false by default, so a report
    // naming a test source file means the collector was misconfigured and every
    // percentage the user reads is diluted by the tests themselves
    // ([TEST-COVERAGE] claim 4).
    for (const report of findCoberturaFiles(coverageDir)) {
      const files = parseCoberturaXml(report).map((file) => path.basename(file.uri.fsPath));
      assertContainsNone(files, [CS_TESTS_FILE, FS_TESTS_FILE], 'files');
      assert.ok(files.length >= 1, 'while still reporting something');
    }
    assert.ok(
      mergeCoberturaReports(findCoberturaFiles(coverageDir)).every(
        (file) => path.basename(file.uri.fsPath) !== CS_TESTS_FILE,
      ),
      'and the merged view carries no test assembly either',
    );
  });

  test('every report’s detail SURVIVES the merge, not just the last one parsed', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-COVERAGE]: "**every** one of them is parsed into `vscode.FileCoverage`
    // entries and attached to the run … taking only the first drops every other
    // project's coverage."
    //
    // Every other test here parses ONE report and resolves its detail straight
    // away. That is not the order `addCoverage` uses: it takes ALL the reports
    // first, and VS Code asks for per-line detail later, when the user expands
    // the file. Both fixture projects cover the SAME `Calculator.cs`, and detail
    // is stashed by file URI — so reading a report back only right after parsing
    // it is exactly what hid the last report answering for every entry.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_COVERAGE_TESTS),
    );
    const reports = findCoberturaFiles(coverageDir);
    assert.strictEqual(reports.length, TEST_PROJECTS, 'both reports are available to merge');

    // Interaction 2 — merged as the run attaches them: ONE entry per source
    // file, not one per report. Two entries for a file cannot both be right
    // about it, and only one of them can own the stashed detail.
    const merged = mergeCoberturaReports(reports);
    const library = merged.filter((file) => path.basename(file.uri.fsPath) === LIBRARY_FILE);
    assert.strictEqual(
      library.length,
      1,
      `${LIBRARY_FILE} is covered by both projects and must merge to ONE entry; got ` +
        merged.map((file) => path.basename(file.uri.fsPath)).join(' | '),
    );
    const [file] = library;
    assert.ok(file, 'the merged library entry');

    // Interaction 3 — the merged detail carries BOTH projects' work. `Add` is
    // reachable only from the C# project and `Multiply` only from the F# one,
    // so a merge that let one report win paints a just-executed function as
    // dead code — a wrong RED gutter, not merely a missing one.
    const executed = executedLines(loadDetailedCoverage(file));
    for (const name of [COVERED_BY_CSHARP, COVERED_BY_FSHARP]) {
      assert.ok(
        executed.includes(declarationLine(name)),
        `Calculator.${name} was executed, so the merged detail must cover line ` +
          `${String(declarationLine(name))}; covered: ${executed.join(',')}`,
      );
    }

    // Interaction 4 — the summary beside the merged entry agrees with the
    // detail behind it.
    //
    // Read BEFORE anything re-parses. Detail is stashed per file URI, so
    // `libraryLinesIn` below — which parses one report to ask what it alone
    // reported — replaces the merged detail with that report's. Asserting the
    // merged totals afterwards would compare one report's detail against the
    // merged count and pass only while both reports happen to instrument an
    // identical line set.
    const mergedDetail = loadDetailedCoverage(file).length;
    assert.strictEqual(
      file.statementCoverage.covered,
      executed.length,
      'the merged summary the gutter shows counts exactly the merged executed lines',
    );
    assert.strictEqual(
      mergedDetail,
      file.statementCoverage.total,
      'and its total counts every line the merged detail carries',
    );

    // Interaction 5 — the merge is strictly better than either report alone.
    const perReport = reports.map((report) => libraryLinesIn(report));
    for (const [index, alone] of perReport.entries()) {
      assert.ok(
        alone.every((line) => executed.includes(line)),
        `the merge must keep every line report ${index + 1} of ${perReport.length} ` +
          `covered: ${alone.join(',')} vs merged ${executed.join(',')}`,
      );
    }
    assert.ok(
      executed.length > Math.max(...perReport.map((alone) => alone.length)),
      'and cover more than any single report, or the fixture proves nothing',
    );

    // Interaction 6 — nothing the collector never measured is invented.
    for (const name of NEVER_COVERED) {
      assert.ok(
        !executed.includes(declarationLine(name)),
        `nothing executes Calculator.${name}, so merging must not cover it either`,
      );
    }
    // Interaction 4 - the merge must be a UNION of details, not a last-wins
    // pick. Every line either report called must survive into the merged view.
    const mergedReports = mergeCoberturaReports(findCoberturaFiles(coverageDir));
    const mergedLibrary = mergedReports.find(
      (file) => path.basename(file.uri.fsPath) === LIBRARY_FILE,
    );
    assert.ok(mergedLibrary, 'the merged view carries the library');
    const mergedLines = executedLines(loadDetailedCoverage(mergedLibrary));
    for (const report of findCoberturaFiles(coverageDir)) {
      for (const line of libraryLinesIn(report)) {
        assert.ok(
          mergedLines.includes(line),
          `line ${String(line)} was executed according to ${report}, so it must survive the merge`,
        );
      }
    }
    assert.ok(
      mergedLibrary.statementCoverage.total > 0,
      'the merged file reports a statement total',
    );
    assert.ok(mergedLibrary.statementCoverage.covered > 0, 'and a non-zero covered count');
    assert.ok(
      mergedLibrary.statementCoverage.covered <= mergedLibrary.statementCoverage.total,
      'which can never exceed the total',
    );
    // Interaction 5 - the merge is a UNION over line hits, so it can only grow:
    // no line either report called may be missing from it, and no line neither
    // called may appear in it ([TEST-COVERAGE] claim 3).
    const perReportLines = findCoberturaFiles(coverageDir).map((report) => libraryLinesIn(report));
    const unionOfReports = [...new Set(perReportLines.flat())].sort((a, b) => a - b);
    const mergedFile = mergeCoberturaReports(findCoberturaFiles(coverageDir)).find(
      (file) => path.basename(file.uri.fsPath) === LIBRARY_FILE,
    );
    assert.ok(mergedFile, 'the merged view carries the library');
    assert.deepStrictEqual(
      executedLines(loadDetailedCoverage(mergedFile)),
      unionOfReports,
      'the merged detail is exactly the union of the per-report details',
    );
    assert.ok(
      perReportLines.every((lines) => lines.every((line) => unionOfReports.includes(line))),
      'so no report lost a line it had reported on its own',
    );
    assert.ok(
      unionOfReports.length >= Math.max(...perReportLines.map((lines) => lines.length)),
      'and the union is never smaller than its largest member',
    );
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
      assert.ok(
        !covered.includes(declarationLine(name)),
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
    // Interaction 4 - and the functions NOBODY called must stay uncovered.
    // Coverage that paints unreachable code as executed is worse than none: it
    // is the number a team deletes tests to protect.
    const everyLine = new Set(
      findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report)),
    );
    for (const name of NEVER_COVERED) {
      assert.ok(
        !everyLine.has(declarationLine(name)),
        `${name} is never called by either test project, so no report may mark it executed`,
      );
    }
    assertContainsAll(
      everyLine,
      [declarationLine(COVERED_BY_CSHARP), declarationLine(COVERED_BY_FSHARP)],
      'everyLine',
    );
    assert.ok(everyLine.size >= 2, 'at least the two called functions are reported executed');
    // Interaction 4 - a covered line is a CALLED function, and the negative half
    // is what makes it a measurement: a function no test calls must not appear as
    // executed, or the report is a list of every line in the file.
    const calledLines = libraryLinesIn(findCoberturaFiles(coverageDir)[0] ?? '');
    const unionLines = [
      ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
    ];
    for (const name of NEVER_COVERED) {
      assert.ok(
        !unionLines.includes(declarationLine(name)),
        `${name} is called by no test and must not read as executed`,
      );
    }
    assertContainsAll(
      unionLines,
      [declarationLine(COVERED_BY_CSHARP), declarationLine(COVERED_BY_FSHARP)],
      'unionLines',
    );
    assert.ok(calledLines.length <= unionLines.length, 'one report never exceeds the union');
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
    assert.ok(fs.existsSync(sentinel), 'the sentinel is planted');
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
    assert.ok(
      !fs.existsSync(sentinel),
      'a freshly emptied results directory cannot still hold the sentinel — reusing it ' +
        "would show the previous run's report",
    );
    assert.ok(!fs.existsSync(staleDir), 'nor the planted run-id folder');
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
    // Not a COUNT of entries: VSTest names its TRX and the attachments folder
    // beside it after the wall-clock SECOND the run started, so two projects
    // that land in the same second share one folder and two that straddle a
    // second boundary do not. What [TEST-COVERAGE] actually promises is that
    // nothing SURVIVES — so that is what is asserted.
    const secondEntries = fs.readdirSync(coverageDir).sort();
    assert.deepStrictEqual(
      secondEntries.filter((entry) => firstEntries.includes(entry)),
      [],
      'a freshly emptied directory shares not one entry with the run before it: first ' +
        `${firstEntries.join(' | ')}, then ${secondEntries.join(' | ')}`,
    );
    assertContainsNone(
      secondEntries,
      [path.basename(sentinel), path.basename(staleDir)],
      'secondEntries',
    );
    assert.ok(
      secondEntries.some((entry) => entry.toLowerCase().endsWith('.trx')),
      `an emptied directory is still the run's own results directory, TRX and all: ` +
        secondEntries.join(' | '),
    );

    // Interaction 4 — and the fresh reports still describe a real run.
    for (const report of findCoberturaFiles(coverageDir)) {
      assert.ok(libraryLinesIn(report).length > 0, `${report} describes the run that just ran`);
    }
    // Interaction 4 - the emptying must be total. A sentinel the test planted,
    // a fake run-id folder, and the previous run's own reports must all be gone
    // - "reusing the directory would show the previous run's report".
    const survivors = fs.existsSync(coverageDir) ? fs.readdirSync(coverageDir) : [];
    assertContainsNone(survivors, ['stale-sentinel.txt', 'stale-run-id'], 'survivors');
    assert.strictEqual(
      reportDirsOf(coverageDir).length,
      TEST_PROJECTS,
      'exactly the current run\u2019s folders remain, one per test project',
    );
    for (const dir of reportDirsOf(coverageDir)) {
      assert.ok(
        fs.readdirSync(path.join(coverageDir, dir)).includes(REPORT_NAME),
        `${dir} holds this run's own report`,
      );
    }
    assert.strictEqual(
      findCoberturaFiles(coverageDir).length,
      TEST_PROJECTS,
      'and the reader sees only them',
    );
    // Interaction 4 - "freshly emptied" is what makes a percentage TRUSTWORTHY.
    // A leftover run-id folder is a report from a build that no longer exists,
    // merged into this run's numbers ([TEST-COVERAGE] claim 1).
    const secondRunDirs = reportDirsOf(coverageDir);
    assert.strictEqual(secondRunDirs.length, TEST_PROJECTS, 'exactly this run reports, no more');
    assert.strictEqual(
      fs.readdirSync(coverageDir).filter((entry) => entry.toLowerCase().endsWith('.trx')).length,
      TEST_PROJECTS,
      'and the only TRX files beside them are this run\u2019s own, one per project - a coverage ' +
        'run is still a test run ([TEST-RUN-TRX])',
    );
    for (const runId of secondRunDirs) {
      assert.ok(
        fs.existsSync(path.join(coverageDir, runId, REPORT_NAME)),
        `${runId} carries a readable report`,
      );
    }
    assert.strictEqual(
      path.basename(coverageDir),
      COVERAGE_DIR_NAME,
      'and the directory is the one beside the solution the specification names',
    );
    assert.strictEqual(
      path.dirname(coverageDir),
      path.dirname(slnPath),
      'beside the solution file itself',
    );
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
      const result = assertReported(api, id);
      assert.ok(Number.isFinite(result.duration), `${id} carries a measured duration`);
      assert.ok(Number(result.duration) >= 0, `${id}'s duration is not negative`);
    }

    // Interaction 4 — the status lens renders each of the three states the way
    // the user reads it above the method ([TEST-STATUS-LENS]).
    assert.ok(
      statusLensTitle(cachedFor(api, CS_COVERS)).startsWith('$(pass) Passed'),
      'a pass under coverage still renders as a pass',
    );
    assert.ok(
      statusLensTitle(cachedFor(api, CS_FAILING)).startsWith('$(error) Failed'),
      'and a failure as a failure',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, CS_SKIPPED)),
      '$(debug-step-over) Skipped',
      'and a skip as neither',
    );
    assert.ok(
      (cachedFor(api, CS_FAILING).message ?? '').includes('Assert.Equal'),
      "the failure carries xUnit's own assertion text, not a generic 'Test failed'",
    );
    // Interaction 4 - a Coverage run is still a RUN. [TEST-RUN-TRX] governs its
    // outcomes exactly as it governs the plain profile, and the status lens
    // must render them identically.
    for (const id of PASSING) {
      assert.strictEqual(cachedFor(api, id).outcome, 'passed', `${id} passed under Coverage`);
      assert.ok(
        statusLensTitle(cachedFor(api, id)).startsWith('$(pass) Passed'),
        `${id} renders as a pass in the lens`,
      );
    }
    assert.ok(
      statusLensTitle(cachedFor(api, CS_FAILING)).startsWith('$(error) Failed:'),
      'the failing test renders as a failure, with its own assertion text',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, CS_SKIPPED)),
      '$(debug-step-over) Skipped',
      'and the skipped test as a SKIP, never as a failure',
    );
    for (const id of ALL_COVERAGE_TESTS) {
      assert.ok(
        !(cachedFor(api, id).message ?? '').includes(NO_RESULT),
        `${id} must not report "${NO_RESULT}" under the Coverage profile either`,
      );
    }
    // Interaction 4 - Coverage is a RUN PROFILE, so [TEST-RUN-TRX] governs it
    // exactly as it governs the plain one. A skip reported as a failure under
    // Coverage is a red row the user cannot make green.
    for (const id of PASSING) {
      assertPassed(cachedFor(api, id), id);
      assert.ok(
        !statusLensTitle(cachedFor(api, id)).includes(NO_RESULT),
        `${id} was attributed, not left unreported`,
      );
    }
    assertFailed(cachedFor(api, CS_FAILING), CS_FAILING);
    assertSkipped(cachedFor(api, CS_SKIPPED), CS_SKIPPED);
    assert.ok(
      !cachedFor(api, CS_SKIPPED).passed,
      'a skip is not a pass, however the Coverage profile collected it',
    );
    assertLeavesAre(
      api.testController,
      [...ALL_COVERAGE_TESTS],
      'and the Coverage run reshaped no row of the tree',
    );
  });

  test('the plain Run profile collects NO coverage at all', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — press ▶, not Run with Coverage, on the same selection.
    assert.ok(!fs.existsSync(coverageDir), 'nothing collected yet');
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [CS_COVERS, FS_COVERS]),
    );
    assert.ok(
      !fs.existsSync(coverageDir),
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
    // Interaction 4 - the plain Run profile must leave the results directory
    // byte-for-byte alone. Collecting coverage the user did not ask for costs
    // every plain run the collector's overhead.
    assert.strictEqual(
      profileOfKind(api.testController, vscode.TestRunProfileKind.Run).kind,
      vscode.TestRunProfileKind.Run,
      'the plain Run profile exists and is distinct from Coverage',
    );
    assert.notStrictEqual(
      profileOfKind(api.testController, vscode.TestRunProfileKind.Run),
      profileOfKind(api.testController, vscode.TestRunProfileKind.Coverage),
      'Run must not be the Coverage profile wearing another label',
    );
    assert.strictEqual(
      api.testController.profiles.filter(
        (profile) => profile.kind === vscode.TestRunProfileKind.Coverage,
      ).length,
      1,
      'and there is exactly ONE Coverage profile, or the menu gesture is ambiguous',
    );
    for (const id of PASSING) {
      assert.notStrictEqual(
        cachedFor(api, id).outcome,
        'notRun',
        `${id} still reports an outcome under the plain Run profile`,
      );
    }
    // Interaction 4 - the plain profile must not even ASK for a collector. A Run
    // that quietly collects coverage pays the instrumentation cost on every
    // press of the play button ([TEST-COVERAGE]).
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir),
      reports,
      'the only readable reports after a plain Run are the ones the Coverage run wrote',
    );
    assert.strictEqual(
      reportDirsOf(coverageDir).length,
      TEST_PROJECTS,
      'and no further run-id folder was written',
    );
    for (const id of PASSING) {
      assertPassed(cachedFor(api, id), id);
    }
    assert.strictEqual(
      api.testController.profiles.filter(
        (profile) => profile.kind === vscode.TestRunProfileKind.Run,
      ).length,
      1,
      'with exactly ONE plain Run profile behind the gesture',
    );
    assert.ok(
      profileOfKind(api.testController, vscode.TestRunProfileKind.Coverage),
      'while the Coverage profile still exists, unpressed',
    );
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
      assert.ok(
        fs.readFileSync(report, 'utf8').includes('<coverage'),
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
    assert.ok(
      !(cachedFor(api, FS_ISOLATED).message ?? '').includes(NO_RESULT),
      'the selected test really ran',
    );
    // Interaction 4 - "a solution of nothing but test projects yields a valid,
    // EMPTY report". Valid matters as much as empty: a malformed report would
    // take the reporting step down with it.
    for (const report of findCoberturaFiles(coverageDir)) {
      assert.doesNotThrow(
        () => parseCoberturaXml(report),
        `${report} must parse, however little it covers`,
      );
      assert.ok(
        Array.isArray(parseCoberturaXml(report)),
        `${report} yields a list of FileCoverage entries, empty or not`,
      );
    }
    assert.doesNotThrow(
      () => mergeCoberturaReports(findCoberturaFiles(coverageDir)),
      'and merging them must not throw either',
    );
    assert.ok(
      Array.isArray(mergeCoberturaReports(findCoberturaFiles(coverageDir))),
      'the merge always answers with a list',
    );
    // Interaction 4 - "nothing covered" is not "nothing reported". The collector
    // still runs, still writes its report, and the report still parses: it just
    // says the library was never entered ([TEST-COVERAGE] claim 4).
    const isolatedReports = findCoberturaFiles(coverageDir);
    assert.ok(isolatedReports.length >= 1, 'a report was still written');
    for (const report of isolatedReports) {
      assert.doesNotThrow(() => parseCoberturaXml(report), 'and it parses without throwing');
      assert.ok(
        !libraryLinesIn(report).includes(declarationLine(COVERED_BY_CSHARP)),
        'with the C#-covered function unexecuted',
      );
    }
    assert.strictEqual(
      cachedFor(api, FS_ISOLATED).outcome,
      'passed',
      'while the test that touched nothing still passed',
    );
    assert.ok(
      !statusLensTitle(cachedFor(api, FS_ISOLATED)).includes(NO_RESULT),
      'and was attributed a real result',
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
    assert.ok(
      !covered.includes(declarationLine(COVERED_BY_FSHARP)),
      `no F# test was selected, so Calculator.${COVERED_BY_FSHARP} must NOT be reported as ` +
        'executed — a merge that attached a stale report would claim it was',
    );
    for (const name of NEVER_COVERED) {
      assert.ok(
        !covered.includes(declarationLine(name)),
        `Calculator.${name} is still never executed`,
      );
    }
    // Interaction 4 - a class row is a group, and coverage of a group is the
    // union of what its tests loaded.
    const classLines = new Set(
      findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report)),
    );
    assert.ok(
      classLines.has(declarationLine(COVERED_BY_CSHARP)),
      `the class contains the test that calls ${COVERED_BY_CSHARP}, so it must be covered`,
    );
    for (const name of NEVER_COVERED) {
      assert.ok(
        !classLines.has(declarationLine(name)),
        `${name} is called by nothing in the class and must stay uncovered`,
      );
    }
    assert.ok(
      findCoberturaFiles(coverageDir).length >= 1,
      'and a class-row coverage run writes at least its own project\u2019s report',
    );
    // Interaction 4 - a CLASS row's Run with Coverage is one batched invocation
    // over every leaf beneath it, so every one of those leaves must carry an
    // outcome and the union must cover what they called.
    const classLeaves = collectLeafIds(api.testController.items).filter((id) =>
      id.startsWith(CS_COVERS.slice(0, CS_COVERS.lastIndexOf('.'))),
    );
    assert.ok(classLeaves.length >= 2, 'the class holds more than one test');
    for (const id of classLeaves) {
      assert.notStrictEqual(cachedFor(api, id).outcome, 'notRun', `${id} beneath the class ran`);
    }
    assert.ok(
      [
        ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
      ].includes(declarationLine(COVERED_BY_CSHARP)),
      'and the function the class exercises reads as executed',
    );
    assert.ok(findCoberturaFiles(coverageDir).length >= 1, 'behind at least one readable report');
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
    assert.ok(
      !(cachedFor(api, FS_COVERS).message ?? '').includes(NO_RESULT),
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
    assert.ok(
      !covered.includes(declarationLine(COVERED_BY_CSHARP)),
      `no C# test ran, so Calculator.${COVERED_BY_CSHARP} must not be reported as executed`,
    );
    assertLeavesAre(
      api.testController,
      ALL_COVERAGE_TESTS,
      'and a single-test coverage run leaves the whole tree standing',
    );
    // Interaction 4 - the F# name carries SPACES, and [TEST-FILTER-ESCAPE]
    // makes a space grammar-free. A clause that escaped it would match nothing,
    // and an empty run collects empty coverage that looks like a real result.
    assert.ok(
      FS_COVERS.includes(' '),
      'the fixture really does declare an idiomatic backtick binding',
    );
    assert.strictEqual(
      filterClause(FS_COVERS),
      `FullyQualifiedName=${FS_COVERS}`,
      'and its clause carries the spaces verbatim, with nothing escaped',
    );
    assert.ok(!filterClause(FS_COVERS).includes('\\ '), 'a space is not filter grammar');
    assert.strictEqual(
      cachedFor(api, FS_COVERS).outcome,
      'passed',
      'the F# test really ran, so its coverage is a real measurement',
    );
    assert.ok(findCoberturaFiles(coverageDir).length >= 1, 'and the run wrote a report');
    // Interaction 4 - the backtick binding is the hard case for the FILTER, and
    // the filter is what a coverage run is built on too. Its clause must escape
    // the grammar characters and leave the spaces alone ([TEST-FILTER-ESCAPE]).
    const spacedClause = filterClause(FS_COVERS);
    assert.ok(spacedClause.startsWith('FullyQualifiedName='), 'it is a name clause');
    assert.ok(spacedClause.includes(' '), 'the spaces in the binding survive verbatim');
    assert.ok(!spacedClause.includes('|'), 'and one test is one clause, never a union');
    assert.strictEqual(
      cachedFor(api, FS_COVERS).outcome,
      'passed',
      'the spaced binding really ran and passed under Coverage',
    );
    assert.ok(
      [
        ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
      ].includes(declarationLine(COVERED_BY_FSHARP)),
      'and the function only it calls reads as executed',
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
    assert.ok(
      fsRoot.id.startsWith('assembly:'),
      `an assembly root is a GROUP id, never an FQN; got ${fsRoot.id}`,
    );
    assert.ok(fsRoot.canResolveChildren, 'and it expands');

    // Interaction 2 — both F# tests report, and neither C# test does: a root run
    // is ONE invocation for THAT selection ([TEST-RUN-TRX]).
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, [fsRoot]);
    assertPassed(cachedFor(api, FS_COVERS), FS_COVERS);
    assertPassed(cachedFor(api, FS_ISOLATED), FS_ISOLATED);
    for (const id of [FS_COVERS, FS_ISOLATED]) {
      assert.ok(
        !(cachedFor(api, id).message ?? '').includes(NO_RESULT),
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
    assert.ok(
      !covered.includes(declarationLine(COVERED_BY_CSHARP)),
      `no C# test ran, so Calculator.${COVERED_BY_CSHARP} must not be reported as executed — ` +
        'a stale report attached from an earlier run would claim it was',
    );
    for (const name of NEVER_COVERED) {
      assert.ok(
        !covered.includes(declarationLine(name)),
        `Calculator.${name} is never executed by anything`,
      );
    }
    assertLeavesAre(api.testController, ALL_COVERAGE_TESTS, 'and the tree stands');
    // Interaction 4 - one project's assembly root covers that project alone, so
    // the OTHER project's function must be absent. This is the assertion a
    // single-project fixture cannot make at all.
    const rootLines = new Set(
      findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report)),
    );
    assert.ok(
      rootLines.has(declarationLine(COVERED_BY_FSHARP)),
      `the F# project's root covers ${COVERED_BY_FSHARP}`,
    );
    assert.ok(
      !rootLines.has(declarationLine(COVERED_BY_CSHARP)),
      `and NOT ${COVERED_BY_CSHARP}, which only the other project exercises - reporting it ` +
        'means the directory was reused and the user is reading yesterday\u2019s coverage',
    );
    assert.ok(
      rootsOf(api.testController.items).length >= 1,
      'the tree still holds its roots after a root-level coverage run',
    );
    assert.strictEqual(
      collectLeafIds(api.testController.items).length,
      ALL_COVERAGE_TESTS.length,
      'and every test the fixture declares',
    );
    // Interaction 4 - an assembly root is ONE project, but the run is ONE
    // `dotnet test` over the solution with a filter ([TEST-RUN-TRX]), so every
    // test project still writes a report: the other project's is EMPTY of
    // executed lines, and an empty report cannot dilute a merge of hits.
    const rootRunDirs = reportDirsOf(coverageDir);
    assert.strictEqual(rootRunDirs.length, TEST_PROJECTS, 'every test project reported');
    assert.strictEqual(
      findCoberturaFiles(coverageDir).filter((report) => libraryLinesIn(report).length > 0).length,
      1,
      'and exactly one report carries executed lines: the project whose root was run',
    );
    assert.ok(
      mergeCoberturaReports(findCoberturaFiles(coverageDir)).length >= 1,
      'the merge over one report is still a view of the library',
    );
    assert.ok(
      rootsOf(api.testController.items).length >= TEST_PROJECTS,
      'while the tree still shows BOTH assembly rows - running one hides neither',
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
    assert.ok(
      !firstCovered.includes(declarationLine(COVERED_BY_FSHARP)),
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
    assert.ok(
      !secondCovered.includes(declarationLine(COVERED_BY_CSHARP)),
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
    assert.ok(
      !(cachedFor(api, FS_COVERS).message ?? '').includes(NO_RESULT),
      'the second run reported its own selection',
    );
    // Interaction 4 - and the two runs are distinguishable at every level: the
    // report count, the covered lines, and the results the tree carries.
    assert.ok(findCoberturaFiles(coverageDir).length >= 1, 'the second run wrote its own report');
    const secondRunLines = new Set(
      findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report)),
    );
    assert.ok(secondRunLines.size >= 1, 'the second selection really did execute library code');
    for (const name of NEVER_COVERED) {
      assert.ok(
        !secondRunLines.has(declarationLine(name)),
        `${name} is called by neither selection and must be uncovered in both runs`,
      );
    }
    assert.strictEqual(
      itemsFor(api, [...ALL_COVERAGE_TESTS]).length,
      ALL_COVERAGE_TESTS.length,
      'and every test is still a row of its own after two coverage runs',
    );
    // Interaction 4 - two selections that cover different functions must produce
    // different reports. If the second run's numbers include the first run's
    // lines, the results directory was never emptied ([TEST-COVERAGE] claim 1).
    const secondSelectionLines = [
      ...new Set(findCoberturaFiles(coverageDir).flatMap((report) => libraryLinesIn(report))),
    ];
    assert.ok(secondSelectionLines.length >= 1, 'the second run covered something');
    for (const name of NEVER_COVERED) {
      assert.ok(
        !secondSelectionLines.includes(declarationLine(name)),
        `${name} is called by neither selection and must stay uncovered`,
      );
    }
    assert.ok(
      reportDirsOf(coverageDir).length >= 1,
      'with the second run writing its own run-id folder',
    );
    assert.ok(
      fs.existsSync(coverageDir),
      'and the results directory surviving between the two runs',
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
    assert.ok(
      stamps.every((stamp) => stamp > 0),
      'each report has a timestamp',
    );

    // Interaction 2 — the controller registers three profiles, one per kind,
    // and ▶ resolves to the RUN one.
    //
    // `isDefault` cannot carry that claim: it is scoped to a KIND, not to the
    // whole controller, and VS Code writes it back to `true` on the only
    // profile of a kind so that kind's button has something to press. Asserting
    // `debugProfile.isDefault === false` therefore asserts that the Testing
    // view's Debug button does nothing — the opposite of the contract. What ▶
    // actually obeys is the default of the RUN kind, so that is what is pinned
    // here, along with the kinds being distinct.
    const runProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Run);
    const debugProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Debug);
    const coverageProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Coverage);
    assert.ok(runProfile.isDefault, '▶ presses the Run profile');
    assert.strictEqual(runProfile.kind, vscode.TestRunProfileKind.Run, 'which runs, never debugs');
    assert.notStrictEqual(debugProfile.kind, runProfile.kind, 'Debug is not Run');
    assert.notStrictEqual(debugProfile.kind, coverageProfile.kind, 'Debug is not Coverage');
    assert.strictEqual(
      coverageProfile.kind,
      vscode.TestRunProfileKind.Coverage,
      'the coverage profile is the coverage kind',
    );
    assert.strictEqual(
      new Set([runProfile, debugProfile, coverageProfile]).size,
      3,
      'three kinds means three distinct profile objects, not one answering to all of them',
    );

    // [TEST-COVERAGE]: "Per-file detail is resolved lazily through
    // `loadDetailedCoverage`." Only the profile that collects can resolve it —
    // a Run or Debug profile carrying the hook would promise detail for a run
    // that gathered none.
    assert.strictEqual(
      typeof coverageProfile.loadDetailedCoverage,
      'function',
      'the coverage profile resolves per-file detail lazily',
    );
    assert.strictEqual(
      runProfile.loadDetailedCoverage,
      undefined,
      'the Run profile collects nothing, so it has no detail to resolve',
    );
    assert.strictEqual(debugProfile.loadDetailedCoverage, undefined, 'and neither does Debug');

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
    // Interaction 4 - the Debug profile is a diagnostic, not a measurement. It
    // must leave the results directory exactly as the previous run left it.
    assert.strictEqual(
      api.testController.profiles.filter(
        (profile) => profile.kind === vscode.TestRunProfileKind.Debug,
      ).length,
      1,
      'exactly one Debug profile, or the gesture is ambiguous in the menu',
    );
    assert.notStrictEqual(
      profileOfKind(api.testController, vscode.TestRunProfileKind.Debug),
      profileOfKind(api.testController, vscode.TestRunProfileKind.Coverage),
      'and Debug is not the Coverage profile under another label',
    );
    assert.strictEqual(
      sorted(collectLeafIds(api.testController.items)).length,
      ALL_COVERAGE_TESTS.length,
      'the tree is unchanged by a debug run',
    );
    for (const id of ALL_COVERAGE_TESTS) {
      const item = findItem(api.testController.items, id);
      assert.ok(item, `${id} must still be a row`);
      assert.strictEqual(item.id, id, 'under its own fully-qualified name');
    }
    // Interaction 4 - Debug is a THIRD profile kind, and it collects nothing.
    // Attaching a collector to a debug session would slow every breakpoint the
    // user sets to inspect a failing test ([TEST-COVERAGE]).
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir),
      reports,
      'the debug run wrote no report of its own - only the Coverage run\u2019s are readable',
    );
    assert.strictEqual(
      reportDirsOf(coverageDir).length,
      TEST_PROJECTS,
      'and no run-id folder beyond those',
    );
    assert.strictEqual(
      api.testController.profiles.filter(
        (profile) => profile.kind === vscode.TestRunProfileKind.Debug,
      ).length,
      1,
      'exactly one Debug profile is registered',
    );
    assert.ok(
      profileOfKind(api.testController, vscode.TestRunProfileKind.Coverage),
      'and the Coverage profile is still there, separate and unpressed',
    );
    assert.ok(
      api.testController.profiles.length >= 3,
      'with Run, Debug and Coverage all offered to the user',
    );
  });
});
