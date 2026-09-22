// Run with Coverage on a Microsoft.Testing.Platform module that CAN collect it,
// end to end.
//
// MTP has no `--collect:"XPlat Code Coverage"`. It takes `--coverage
// --coverage-output-format cobertura` from `Microsoft.Testing.Extensions
// .CodeCoverage`, and it writes `<guid>.cobertura.xml` DIRECTLY into the
// results directory — not one run-id folder down, where `coverlet.collector`
// puts `coverage.cobertura.xml` and where the VSTest path has always looked.
// A reader that looked only one level down would attach nothing and the run
// would look like it collected no coverage at all.
//
// So the fixture is an F# library with TWO functions and a C# `xunit.v3`
// module that calls ONE of them: the report must exist at the top of the
// results directory, and it must say the called function ran and the other
// did not.
//
// Covers [TEST-MTP-RUN] and [TEST-COVERAGE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  findCoberturaFiles,
  loadDetailedCoverage,
  parseCoberturaXml,
} from '../../test-coverage.js';
import { trxFiles } from '../../test-trx-collect.js';
import {
  buildProjectXml,
  createSolution,
  libraryProjectXml,
  MTP_PROPERTIES,
  MTP_XUNIT_PACKAGES,
  writeMtpGlobalJson,
  writeProject,
} from './dotnet-project-kit';
import { COVERAGE_DIR_NAME } from './test-coverage-fixtures';
import {
  activateTestExplorer,
  discoverSolution,
  runViaProfile,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { assertPassed, cachedFor, itemsFor } from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The collector MTP's `--coverage` needs, on the platform the fixtures pin. */
const CODE_COVERAGE = { id: 'Microsoft.Testing.Extensions.CodeCoverage', version: '18.11.0' };

const LIBRARY = 'CovLibFs';
const LIBRARY_FILE = 'Calc.fs';
const TESTS = 'CovMtpCs';

/** The one test: it calls `add`, and never `sub`. */
const COVERS_ADD = 'Cs.CovMtp.Fixtures.CalculatorTests.Adds_Through_The_Library';

/** Two functions, so "covered" and "not covered" are both observable. */
const LIBRARY_SOURCE = [
  'module Cov.Calc',
  '',
  'let add (a: int) (b: int) =',
  '    let sum = a + b',
  '    sum',
  '',
  'let sub (a: int) (b: int) =',
  '    let difference = a - b',
  '    difference',
  '',
].join('\n');

const TESTS_SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.CovMtp.Fixtures',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact] public void Adds_Through_The_Library() => Assert.Equal(3, Cov.Calc.add(1, 2));',
  '    }',
  '}',
  '',
].join('\n');

/** The library, and the MTP module that references it plus the collector. */
async function writeCoverageFixture(root: string): Promise<string> {
  writeMtpGlobalJson(root);
  const library = writeProject(
    path.join(root, LIBRARY),
    `${LIBRARY}.fsproj`,
    libraryProjectXml(LIBRARY_FILE),
    LIBRARY_FILE,
    LIBRARY_SOURCE,
  );
  const tests = writeProject(
    path.join(root, TESTS),
    `${TESTS}.csproj`,
    buildProjectXml({
      packages: [...MTP_XUNIT_PACKAGES, CODE_COVERAGE],
      projectReferences: [path.join('..', LIBRARY, `${LIBRARY}.fsproj`)],
      properties: MTP_PROPERTIES,
    }),
    'CalculatorTests.cs',
    TESTS_SOURCE,
  );
  return await createSolution(root, 'CovMtp', [library, tests]);
}

/** The name MTP's collector gives its report: a guid, then `.cobertura.xml`. */
const GUID_REPORT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.cobertura\.xml$/i;

/** Every Cobertura report in a folder directly below `dir`. */
function reportsOneLevelDown(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(dir, entry.name)))
    .filter((name) => name.toLowerCase().endsWith('.cobertura.xml'));
}

/** Statements covered and in total, summed over every class of `file`. */
function statementsOf(report: string, file: string): { covered: number; total: number } {
  const entries = parseCoberturaXml(report).filter(
    (entry) => path.basename(entry.uri.fsPath) === file,
  );
  return entries.reduce(
    (sum, entry) => ({
      covered: sum.covered + entry.statementCoverage.covered,
      total: sum.total + entry.statementCoverage.total,
    }),
    { covered: 0, total: 0 },
  );
}

suite('Test Explorer e2e — Run with Coverage on a Microsoft.Testing.Platform module', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-coverage-'));
    slnPath = await writeCoverageFixture(root);
    await discoverSolution(api, slnPath, [COVERS_ADD]);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('the report MTP writes at the top of the results directory is read and attached', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const coverageDir = path.join(root, COVERAGE_DIR_NAME);

    // 1. Run with Coverage on the one test: it still reports its real verdict.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [COVERS_ADD]),
    );
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, COVERS_ADD), COVERS_ADD);

    // 2. MTP's report sits DIRECTLY in the results directory, named by a guid,
    //    and it is the one the reader finds.
    const topLevel = fs
      .readdirSync(coverageDir)
      .filter((entry) => entry.toLowerCase().endsWith('.cobertura.xml'));
    assert.equal(
      topLevel.length,
      1,
      `one MTP report at the top: ${fs.readdirSync(coverageDir).join(' | ')}`,
    );
    const [report] = topLevel.map((entry) => path.join(coverageDir, entry));
    assert.ok(report);
    assert.deepStrictEqual(
      findCoberturaFiles(coverageDir),
      [report],
      'the reader finds exactly it',
    );

    // 3. The report says what ran: `add` was called and `sub` never was, so the
    //    library is PARTLY covered — neither a blank nor a blanket green.
    const library = statementsOf(report, LIBRARY_FILE);
    assert.ok(library.total > 0, `${LIBRARY_FILE} is in the report: ${JSON.stringify(library)}`);
    assert.ok(library.covered > 0, `the called function is covered: ${JSON.stringify(library)}`);
    assert.ok(library.covered < library.total, `the other is not: ${JSON.stringify(library)}`);

    // 4. [TEST-MTP-RUN] the report is `<guid>.cobertura.xml`, and nothing sits one
    //    level down — MTP never writes coverlet's run-id folder.
    assert.match(path.basename(report), GUID_REPORT, 'named by a guid');
    assert.deepStrictEqual(reportsOneLevelDown(coverageDir), [], 'nothing one level down');
    // The run's TRX is in the same directory, under its per-invocation name.
    assert.deepStrictEqual(
      trxFiles(coverageDir).map((file) => path.basename(file)),
      [`${TESTS}.0.trx`],
      'one invocation, one numbered report',
    );
    // [TEST-COVERAGE] the entry is the user's own source file, and its detail —
    // resolved lazily — says line by line what ran and what did not.
    const entry = parseCoberturaXml(report).find(
      (candidate) => path.basename(candidate.uri.fsPath) === LIBRARY_FILE,
    );
    assert.ok(entry && fs.existsSync(entry.uri.fsPath), `the real ${LIBRARY_FILE} on disk`);
    assert.equal(path.basename(path.dirname(entry.uri.fsPath)), LIBRARY, 'in the library');
    const executed = loadDetailedCoverage(entry).map((detail) => Number(detail.executed));
    assert.ok(
      executed.some((hits) => hits > 0),
      `a line of add ran: ${executed.join(',')}`,
    );
    assert.ok(
      executed.some((hits) => hits === 0),
      `a line of sub did not: ${executed.join(',')}`,
    );

    // 5. Run with Coverage AGAIN: the directory is emptied first, so the one report
    //    there is the new run's, never the first run's beside it.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, [COVERS_ADD]),
    );
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, COVERS_ADD), COVERS_ADD);
    const again = findCoberturaFiles(coverageDir);
    assert.equal(again.length, 1, `one report after the second run: ${again.join(' | ')}`);
    assert.notEqual(again[0], report, 'and it is not the first run’s');
  });
});
