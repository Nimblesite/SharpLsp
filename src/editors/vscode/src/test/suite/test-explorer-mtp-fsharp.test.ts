// Microsoft.Testing.Platform on F#, end to end — the F# half of every case the
// C# suites prove on one module.
//
// [TEST-OVERVIEW] makes F# the first language, not the second, and an F# module
// is not a C# class with different syntax: its tests are module-level `let`
// bindings whose names carry SPACES, a module compiles to a CLR type the tree
// splits into Namespace → Class, every source file is ordered by hand in the
// `.fsproj`, and `#if` is resolved by the F# compiler against the framework
// symbols the SDK defines. So each case runs on real F# projects:
//
//   • one F# `xunit.v3` module MULTI-TARGETED at the two newest runtimes on the
//     machine, carrying one binding per framework that fails in THAT
//     framework's module only — two modules, one file name, one tree root;
//   • the same module EDITED between discovery and ▶, so only a rebuild can
//     pick the edit up, with an F# `[<Theory>]` whose rows disagree after it;
//   • an F# project that starts on VSTest and moves onto MTP in place — a
//     `global.json` opt-in and the `xunit.v3` packages — as a user migrates.
//
// Covers [TEST-MTP-DETECT], [TEST-MTP-DISCOVERY], [TEST-MTP-RUN] and
// [TEST-MTP-MODULES].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { formatDuration, statusLensTitle } from '../../test-lens.js';
import { usesMtpRunner } from '../../test-mtp.js';
import { listMtpTests } from '../../test-mtp-discovery.js';
import { runMtpTests } from '../../test-mtp-run.js';
import { trxFiles } from '../../test-trx-collect.js';
import { AnchoredSource } from './debug-anchors';
import {
  buildProjectXml,
  createSolution,
  installedFrameworkPair,
  mtpProjectXml,
  MTP_PROPERTIES,
  MTP_XUNIT_PACKAGES,
  projectXml,
  symbolFor,
  writeMtpGlobalJson,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  collectLeafIds,
  discoverSolution,
  findItem,
  rootsOf,
  runViaProfile,
  teardownFixtureSolution,
  activateWithScratch,
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

/** The multi-targeted F# module: TWO builds sharing one file name. */
const PROJECT = 'ModulesMtpFs';
const NAMESPACE = 'Fs.ModulesMtp.Fixtures';
const CALCULATOR = `${NAMESPACE}.Calculator`;
const PER_FRAMEWORK = `${NAMESPACE}.PerFramework`;
const CALCULATOR_FILE = 'Calculator.fs';
const FRAMEWORK_FILE = 'PerFramework.fs';

/** The `[<Fact>]` the user edits between discovery and ▶. */
const ADDS = `${CALCULATOR}.adds two numbers`;
/** The `[<Theory>]` whose last row the edit breaks. */
const ROWS = `${CALCULATOR}.adds rows`;

/** The F# project that moves from VSTest onto MTP in place. */
const MIGRATED = 'MigrateMtpFs';
const MIGRATED_MODULE = 'Fs.MigrateMtp.Fixtures.Calculator';
const MIGRATED_ADDS = `${MIGRATED_MODULE}.adds two numbers`;
const MIGRATED_ROWS = `${MIGRATED_MODULE}.adds rows`;
const MIGRATED_IDS = [MIGRATED_ADDS, MIGRATED_ROWS];

/**
 * An F# `[<Fact>]` asserting `1 + 2` equals `sum`, and a `[<Theory>]` whose
 * second row expects `lastRow` from `2 + 2` — green at 3 and 4, red otherwise.
 * The same source compiles on xUnit v2 and on `xunit.v3`.
 */
function calculatorSource(module: string, sum: number, lastRow: number): AnchoredSource {
  return new AnchoredSource([
    `module ${module}`,
    '',
    'open Xunit',
    '',
    '[<Fact>] // @anchor:adds-fact',
    `let \`\`adds two numbers\`\` () = Assert.Equal(${String(sum)}, 1 + 2)`,
    '',
    '[<Theory>] // @anchor:rows-theory',
    '[<InlineData(1, 2, 3)>]',
    `[<InlineData(2, 2, ${String(lastRow)})>]`,
    'let ``adds rows`` (a: int) (b: int) (expected: int) = Assert.Equal(expected, a + b)',
  ]);
}

/** The green calculator every case starts from and returns to. */
const GREEN = calculatorSource(CALCULATOR, 3, 4);

/** The binding that fails when compiled for `framework`, and passes otherwise. */
function failsOnlyOn(framework: string): string {
  return `fails only on ${symbolFor(framework)}`;
}

/** Its id, which EVERY module of the project reports. */
function frameworkId(framework: string): string {
  return `${PER_FRAMEWORK}.${failsOnlyOn(framework)}`;
}

/** One `#if` per framework: red under that framework's symbol, green otherwise. */
function frameworkSource(frameworks: readonly string[]): string {
  const bindings = frameworks.flatMap((framework) => [
    `#if ${symbolFor(framework)}`,
    '[<Fact>]',
    `let \`\`${failsOnlyOn(framework)}\`\` () = Assert.Equal(4, 1 + 2)`,
    '#else',
    '[<Fact>]',
    `let \`\`${failsOnlyOn(framework)}\`\` () = Assert.Equal(3, 1 + 2)`,
    '#endif',
  ]);
  return [`module ${PER_FRAMEWORK}`, '', 'open Xunit', '', ...bindings, ''].join('\n');
}

/** The multi-targeted module plus the opt-in; returns the solution the CLI made. */
async function createModulesFixture(root: string, frameworks: readonly string[]): Promise<string> {
  writeMtpGlobalJson(root);
  const dir = writeProject(
    path.join(root, PROJECT),
    `${PROJECT}.fsproj`,
    buildProjectXml({
      packages: MTP_XUNIT_PACKAGES,
      compileIncludes: [CALCULATOR_FILE, FRAMEWORK_FILE],
      properties: { ...MTP_PROPERTIES, TargetFrameworks: frameworks.join(';') },
    }),
    CALCULATOR_FILE,
    GREEN.text,
  );
  // F# compiles only what the project lists, in order: the second file is in
  // `compileIncludes` above, so writing it is all that is left.
  fs.writeFileSync(path.join(dir, FRAMEWORK_FILE), frameworkSource(frameworks), 'utf8');
  return await createSolution(root, 'ModulesMtpFs', [dir]);
}

/** The migrating project's calculator, green on either runner. */
const MIGRATED_SOURCE = calculatorSource(MIGRATED_MODULE, 3, 4);

/** Write the migrating project's source and project file for one runner. */
function writeMigrated(dir: string, mtp: boolean): void {
  const xml = mtp
    ? mtpProjectXml(MTP_XUNIT_PACKAGES, CALCULATOR_FILE)
    : projectXml(XUNIT_PACKAGES, CALCULATOR_FILE);
  writeProject(dir, `${MIGRATED}.fsproj`, xml, CALCULATOR_FILE, MIGRATED_SOURCE.text);
}

/** Press ▶ on `ids` and wait for the run to finish. */
async function run(api: SharpLspExtensionApi, ids: readonly string[]): Promise<void> {
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, ids));
  await api.testController.whenIdle();
}

/** The 0-based line the tree row for `id` starts on, asserted present. */
function rowLine(api: SharpLspExtensionApi, id: string): number {
  const item = findItem(api.testController.items, id);
  assert.ok(item?.range, `${id}: a reported location gives the row a range`);
  return item.range.start.line;
}

suite('Test Explorer e2e — Microsoft.Testing.Platform on F# modules', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let migrateRoot: string;
  let slnPath: string;
  let frameworks: string[];
  let expected: string[];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    ({ api, root } = await activateWithScratch('sharplsp-mtp-fsharp-'));
    migrateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-fsharp-migrate-'));
    frameworks = await installedFrameworkPair(root);
    slnPath = await createModulesFixture(root, frameworks);
    expected = [ADDS, ROWS, ...frameworks.map(frameworkId)];
    await discoverSolution(api, slnPath, expected);
  });

  teardown(async () => {
    await api.testController.whenIdle();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
    removeDirRecursive(migrateRoot);
  });

  test('an F# multi-targeted module reports EVERY framework under ONE root', async function () {
    this.timeout(FIXTURE_BUILD_MS);

    // 1. [TEST-MTP-MODULES] one module per target framework, sharing ONE file
    //    name; [TEST-MTP-DISCOVERY] each theory ROW is its own uid under the one
    //    id; and the tree shows ONE root, split Namespace → module-as-Class.
    const listing = await listMtpTests(slnPath, root);
    assert.ok(listing.mtp, 'an MTP solution must come back with a run plan');
    const modules = listing.mtp.modules;
    assert.deepStrictEqual(
      sorted(modules.map((module) => path.basename(path.dirname(module.modulePath)))),
      sorted(frameworks),
      'one module per target framework',
    );
    assert.deepStrictEqual(
      [...new Set(modules.map((module) => path.basename(module.modulePath)))],
      [`${PROJECT}.dll`],
      'all under one file name — the shape whose reports can collide',
    );
    for (const module of modules) {
      assert.equal(module.uidsById.get(ROWS)?.length, 2, 'one uid per [<InlineData>] row');
      assert.equal(module.uidsById.get(ADDS)?.length, 1, 'one uid for the [<Fact>]');
    }
    assert.deepStrictEqual(
      rootsOf(api.testController.items).map((row) => row.label),
      [PROJECT],
      'the two modules are ONE assembly root',
    );
    assert.deepStrictEqual(sorted(collectLeafIds(api.testController.items)), sorted(expected));
    const calculator = findItem(api.testController.items, ADDS)?.parent;
    assert.equal(calculator?.label, 'Calculator', 'an F# module is the CLASS row, by its type');
    assert.equal(calculator?.parent?.label, NAMESPACE, 'under the rest of its path');

    // 2. ▶ on the whole tree sends no filter, so no retry can hide a lost
    //    report: each framework binding fails in ONE module only, and is red.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, []);
    await api.testController.whenIdle();
    for (const framework of frameworks) {
      assertFailed(cachedFor(api, frameworkId(framework)), frameworkId(framework));
    }
    assertPassed(cachedFor(api, ADDS), ADDS);
    assertPassed(cachedFor(api, ROWS), ROWS);

    // 3. [TEST-MTP-RUN] each module writes its OWN numbered report into the
    //    shared directory, and every one of them is read.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-fsharp-trx-'));
    try {
      const outcome = await runMtpTests(listing.mtp, [], root, { resultsDirectory: dir });
      assert.deepStrictEqual(
        sorted(trxFiles(dir).map((file) => path.basename(file))),
        sorted(modules.map((_, index) => `${PROJECT}.${String(index)}.trx`)),
        'one report per module, numbered so neither overwrites the other',
      );
      for (const framework of frameworks) {
        const result = outcome.results.get(frameworkId(framework));
        assert.equal(result?.outcome, 'failed', `${framework}'s module must report its failure`);
        assert.ok(result?.message?.includes('Assert.Equal() Failure'), 'in xUnit’s own words');
      }
      assert.equal(outcome.results.get(ADDS)?.outcome, 'passed');
      assert.equal(outcome.results.get(ROWS)?.outcome, 'passed', 'both rows, in both modules');
      assert.equal(outcome.failure, undefined, 'and no module failed as a whole');
    } finally {
      removeDirRecursive(dir);
    }
  });

  test('an edited F# binding is REBUILT before it runs, rows and all', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const source = path.join(root, PROJECT, CALCULATOR_FILE);
    try {
      // 1. As discovered: green, and each row points at the F# attribute the
      //    listing reported — 1-based there, 0-based in the tree.
      await run(api, [ADDS, ROWS]);
      assertPassed(cachedFor(api, ADDS), ADDS);
      assertPassed(cachedFor(api, ROWS), ROWS);
      assert.equal(rowLine(api, ADDS), GREEN.line('adds-fact'), 'the [<Fact>] line');
      assert.equal(rowLine(api, ROWS), GREEN.line('rows-theory'), 'the [<Theory>] line');
      const file = findItem(api.testController.items, ADDS)?.uri?.fsPath ?? '';
      assert.equal(path.basename(file), CALCULATOR_FILE, 'in the .fs file it is written in');

      // 2. Break the fact AND one theory row, and save. Nothing re-discovers,
      //    so only the RUN can see the edit; the theory is judged by its worst
      //    row, and the status CodeLens run sees the same.
      fs.writeFileSync(source, calculatorSource(CALCULATOR, 4, 5).text, 'utf8');
      await run(api, [ADDS, ROWS]);
      assertFailed(cachedFor(api, ADDS), ADDS);
      assertFailed(cachedFor(api, ROWS), ROWS);
      const lens = await api.testController.runSingle(ROWS);
      assert.equal(lens.outcome, 'failed', `the lens sees the edit: ${lens.message ?? '(none)'}`);
      assert.ok(lens.message?.includes('Expected'), 'with the Expected/Actual detail');
      for (const framework of frameworks) {
        assert.equal(cachedFor(api, frameworkId(framework)).outcome, 'failed', 'untouched');
      }

      // 3. Put it back: the next ▶ is green again, so the rebuild tracks the
      //    source both ways rather than latching the first change.
      fs.writeFileSync(source, GREEN.text, 'utf8');
      await run(api, [ADDS, ROWS]);
      assertPassed(cachedFor(api, ADDS), ADDS);
      assertPassed(cachedFor(api, ROWS), ROWS);
      const again = await api.testController.runSingle(ADDS);
      assert.equal(statusLensTitle(again), `$(pass) Passed${formatDuration(again.duration)}`);
    } finally {
      fs.writeFileSync(source, GREEN.text, 'utf8');
    }
  });

  test('an F# project moved from VSTest onto MTP in place keeps its tree and runs on MTP', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const dir = path.join(migrateRoot, MIGRATED);
    writeMigrated(dir, false);
    const sln = await createSolution(migrateRoot, 'MigrateMtpFs', [dir]);

    // 1. On VSTest: no opt-in, discovered by name, run green.
    assert.equal(usesMtpRunner(migrateRoot), false, '[TEST-MTP-DETECT]: no opt-in yet');
    assert.deepStrictEqual(
      sorted(await discoverSolution(api, sln, MIGRATED_IDS)),
      sorted(MIGRATED_IDS),
    );
    await run(api, MIGRATED_IDS);
    for (const id of MIGRATED_IDS) assertPassed(cachedFor(api, id), id);
    const onVsTest = MIGRATED_IDS.map((id) => cachedFor(api, id));
    assert.deepStrictEqual(
      rootsOf(api.testController.items).map((row) => row.label),
      [MIGRATED],
    );

    // 2. Opt in and swap the packages; refresh. The SAME ids come back under the
    //    same root, now from the module's own listing — with the locations the
    //    VSTest listing never carried, and one uid per theory row.
    writeMtpGlobalJson(migrateRoot);
    writeMigrated(dir, true);
    assert.equal(usesMtpRunner(migrateRoot), true, '[TEST-MTP-DETECT]: the opt-in selects MTP');
    assert.deepStrictEqual(
      sorted(await discoverSolution(api, sln, MIGRATED_IDS)),
      sorted(MIGRATED_IDS),
    );
    assert.deepStrictEqual(
      rootsOf(api.testController.items).map((row) => row.label),
      [MIGRATED],
    );
    assert.equal(rowLine(api, MIGRATED_ADDS), MIGRATED_SOURCE.line('adds-fact'));
    const plan = (await listMtpTests(sln, migrateRoot)).mtp;
    assert.ok(plan, 'the migrated solution now lists with a run plan');
    assert.deepStrictEqual(
      plan.modules.map((module) => path.basename(module.modulePath)),
      [`${MIGRATED}.dll`],
      'one MTP module, the migrated project',
    );
    assert.equal(plan.modules[0]?.uidsById.get(MIGRATED_ROWS)?.length, 2, 'one uid per row');

    // 3. ▶ runs on MTP: fresh green results, and the status CodeLens agrees.
    await run(api, MIGRATED_IDS);
    MIGRATED_IDS.forEach((id, index) => {
      assertPassed(cachedFor(api, id), id);
      assert.notStrictEqual(cachedFor(api, id), onVsTest[index], `${id}: a fresh result`);
    });
    const lens = await api.testController.runSingle(MIGRATED_ROWS);
    assert.equal(lens.outcome, 'passed', `the lens run: ${lens.message ?? '(none)'}`);
    assert.deepStrictEqual(cachedFor(api, MIGRATED_ROWS), lens, 'the cache holds what it ran');
  });
});
