// Data-driven Microsoft.Testing.Platform tests whose ROWS change between
// discovery and ▶, end to end, on C# `xunit.v3` and MSTest.
//
// A data-driven test is ONE id in the tree but one `--filter-uid` value per row,
// and the uids are the module's own keys, not the tree's: `xunit.v3` hashes a
// row's DATA into its uid, MSTest numbers its rows. So an edit that ADDS a row
// gives it a uid discovery never saw in both frameworks, and an edit that
// CHANGES a row's data does the same in xUnit. A run filtering the rebuilt
// module by discovery's uids skips exactly the rows the user just wrote, and a
// row the edit made red reports green.
//
// Each module also carries a plain test the edits never touch, so a run that
// re-read the rows is seen to leave everything else alone.
//
// Covers [TEST-MTP-RUN] and [TEST-MTP-DISCOVERY].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { formatDuration, statusLensTitle } from '../../test-lens.js';
import { listMtpTests } from '../../test-mtp-discovery.js';
import {
  createSolution,
  mtpProjectXml,
  MTP_MSTEST_PACKAGES,
  MTP_XUNIT_PACKAGES,
  writeMtpGlobalJson,
  writeProject,
} from './dotnet-project-kit';
import {
  activateTestExplorer,
  collectLeafIds,
  discoverSolution,
  runViaProfile,
  teardownFixtureSolution,
} from './test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  cachedFor,
  itemsFor,
  sorted,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** One data row: `a + b` must equal `sum`. */
type Row = readonly [a: number, b: number, sum: number];

/** The row the edits never touch. */
const FIRST_ROW: Row = [1, 2, 3];

/** The rows every case starts from and returns to: both green. */
const GREEN_ROWS: readonly Row[] = [FIRST_ROW, [2, 2, 4]];

/** The failure text MSTest writes for `Assert.AreEqual`. */
const MSTEST_FAILURE = 'Assertion failed. Expected values to be equal.';

/** One framework's module: how its rows and its untouched test are written. */
interface RowsModule {
  readonly project: string;
  readonly namespace: string;
  readonly packages: typeof MTP_XUNIT_PACKAGES;
  /** The framework's namespace, and the attribute its test class needs, if any. */
  readonly using: string;
  readonly classAttributes: readonly string[];
  /** The attribute one row is written with. */
  readonly rowAttribute: string;
  /** The lines that declare the untouched test and open the data-driven one. */
  readonly header: readonly string[];
  readonly assertion: string;
  readonly failureText: string | undefined;
}

const XUNIT: RowsModule = {
  project: 'RowsMtpCs',
  namespace: 'Cs.RowsMtp.Fixtures',
  packages: MTP_XUNIT_PACKAGES,
  using: 'Xunit',
  classAttributes: [],
  rowAttribute: 'InlineData',
  header: [
    '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, 1 + 2);',
    '        [Theory]',
  ],
  assertion: 'Assert.Equal(expected, a + b)',
  failureText: undefined,
};

const MSTEST: RowsModule = {
  project: 'RowsMsTestCs',
  namespace: 'Cs.RowsMsTest.Fixtures',
  packages: MTP_MSTEST_PACKAGES,
  using: 'Microsoft.VisualStudio.TestTools.UnitTesting',
  classAttributes: ['    [TestClass]'],
  rowAttribute: 'DataRow',
  header: [
    '        [TestMethod] public void Adds_TwoNumbers() => Assert.AreEqual(3, 1 + 2);',
    '        [TestMethod]',
  ],
  assertion: 'Assert.AreEqual(expected, a + b)',
  failureText: MSTEST_FAILURE,
};

const MODULES: readonly RowsModule[] = [XUNIT, MSTEST];

/** The data-driven test's id. */
function rowsId(module: RowsModule): string {
  return `${module.namespace}.CalculatorTests.Adds_Rows`;
}

/** The untouched test's id. */
function plainId(module: RowsModule): string {
  return `${module.namespace}.CalculatorTests.Adds_TwoNumbers`;
}

/** Every data-driven id, one per framework. */
const ROWS_IDS = MODULES.map(rowsId);
/** Every untouched id, one per framework. */
const PLAIN_IDS = MODULES.map(plainId);

/** The module's source with `rows` as its data. */
function sourceOf(module: RowsModule, rows: readonly Row[]): string {
  const attributes = rows.map(
    ([a, b, sum]) => `        [${module.rowAttribute}(${String(a)}, ${String(b)}, ${String(sum)})]`,
  );
  return [
    `using ${module.using};`,
    '',
    `namespace ${module.namespace}`,
    '{',
    ...module.classAttributes,
    '    public class CalculatorTests',
    '    {',
    ...module.header,
    ...attributes,
    `        public void Adds_Rows(int a, int b, int expected) => ${module.assertion};`,
    '    }',
    '}',
    '',
  ].join('\n');
}

/** Where the module's source lives under `root`. */
function sourceFile(root: string, module: RowsModule): string {
  return path.join(root, module.project, 'CalculatorTests.cs');
}

/** Rewrite every module's rows; nothing re-discovers, only a run can see it. */
function writeRows(root: string, rows: readonly Row[]): void {
  for (const module of MODULES) fs.writeFileSync(sourceFile(root, module), sourceOf(module, rows));
}

/** Press ▶ on `ids` and wait for the run to finish. */
async function run(api: SharpLspExtensionApi, ids: readonly string[]): Promise<void> {
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, ids));
  await api.testController.whenIdle();
}

/** Each data-driven test is red, in its own framework's words. */
function assertRowsFailed(api: SharpLspExtensionApi): void {
  for (const module of MODULES) {
    assertFailed(cachedFor(api, rowsId(module)), rowsId(module), module.failureText);
  }
}

/** The uid count each data-driven id owns in a fresh listing of `sln`. */
async function uidCounts(sln: string, root: string): Promise<number[]> {
  const plan = (await listMtpTests(sln, root)).mtp;
  assert.ok(plan, 'an MTP solution lists with a run plan');
  return ROWS_IDS.map((id) =>
    plan.modules.reduce((sum, module) => sum + (module.uidsById.get(id)?.length ?? 0), 0),
  );
}

suite('Test Explorer e2e — MTP data rows edited between discovery and ▶', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  const allIds = [...ROWS_IDS, ...PLAIN_IDS];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-rows-'));
    writeMtpGlobalJson(root);
    const dirs = MODULES.map((module) =>
      writeProject(
        path.join(root, module.project),
        `${module.project}.csproj`,
        mtpProjectXml(module.packages),
        'CalculatorTests.cs',
        sourceOf(module, GREEN_ROWS),
      ),
    );
    slnPath = await createSolution(root, 'RowsMtp', dirs);
    await discoverSolution(api, slnPath, allIds);
  });

  teardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    writeRows(root, GREEN_ROWS);
    await api.testController.whenIdle();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('a row ADDED after discovery runs, and a red one turns its test red', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    // 1. As discovered: one uid per row, one leaf per test, all green.
    assert.deepStrictEqual(await uidCounts(slnPath, root), [2, 2], 'two rows each');
    assert.deepStrictEqual(sorted(collectLeafIds(api.testController.items)), sorted(allIds));
    await run(api, allIds);
    for (const id of allIds) assertPassed(cachedFor(api, id), id);

    // 2. ADD a red row to each and press ▶ on the data-driven tests only. The
    //    new row's uid is one discovery never saw — in BOTH frameworks — and the
    //    run must still run it: the test is as bad as its worst row.
    writeRows(root, [...GREEN_ROWS, [2, 2, 5]]);
    await run(api, ROWS_IDS);
    assertRowsFailed(api);
    const lens = await api.testController.runSingle(rowsId(MSTEST));
    assert.equal(lens.outcome, 'failed', `the lens runs the new row: ${lens.message ?? ''}`);
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(allIds),
      'a row is never a leaf of its own: the tree is unchanged',
    );
    await run(api, PLAIN_IDS);
    for (const id of PLAIN_IDS) assertPassed(cachedFor(api, id), id);

    // 3. Make the added row green: all three rows run and all pass.
    writeRows(root, [...GREEN_ROWS, [3, 3, 6]]);
    await run(api, ROWS_IDS);
    for (const id of ROWS_IDS) assertPassed(cachedFor(api, id), id);
    assert.deepStrictEqual(await uidCounts(slnPath, root), [3, 3], 'three rows each now');
    const green = await api.testController.runSingle(rowsId(XUNIT));
    assert.equal(statusLensTitle(green), `$(pass) Passed${formatDuration(green.duration)}`);
  });

  test('a row whose DATA is edited after discovery runs with the new data', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    // 1. Edit the second row of each to expect 5 from 2 + 2. xUnit hashes the
    //    data into the uid, so only a re-read uid reaches the edited row.
    writeRows(root, [FIRST_ROW, [2, 2, 5]]);
    await run(api, ROWS_IDS);
    assertRowsFailed(api);
    const xunit = cachedFor(api, rowsId(XUNIT)).message ?? '';
    assert.ok(xunit.includes('Expected: 5'), `the EDITED row failed, with its data: ${xunit}`);
    assert.deepStrictEqual(await uidCounts(slnPath, root), [2, 2], 'still two rows each');

    // 2. Put it back: green again, both ways.
    writeRows(root, GREEN_ROWS);
    await run(api, ROWS_IDS);
    for (const id of ROWS_IDS) assertPassed(cachedFor(api, id), id);
    const lens = await api.testController.runSingle(rowsId(XUNIT));
    assert.equal(lens.outcome, 'passed', `the lens run: ${lens.message ?? '(none)'}`);

    // 3. ▶ on the whole tree sends no filter at all, and agrees.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, []);
    await api.testController.whenIdle();
    for (const id of allIds) assertPassed(cachedFor(api, id), id);
  });
});
