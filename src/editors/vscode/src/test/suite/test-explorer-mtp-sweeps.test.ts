// What ONE discovery sweep costs, what it may enumerate, and what a sweep that
// fails leaves behind — for the Microsoft.Testing.Platform probe.
//
// The probe runs whenever the VSTest passes attribute no assembly. Four ways
// a sweep can hurt a user:
//
//   • COST. "This order costs a VSTest solution nothing" ([TEST-MTP-DETECT]).
//     A solution with no MTP project must not be built a second time by the
//     probe — a library solution with the Testing view open, and a VSTest
//     solution that fails to build, would otherwise pay twice per sweep. The
//     builds are COUNTED, by a real `Directory.Build.props`, never timed.
//   • REACH. A folder or a project file is enumerated the way `dotnet` itself
//     resolves it. `dotnet` refuses a folder holding several projects, so the
//     probe must not walk the folder and list modules an EARLIER build left on
//     disk; and a project file is that project, not its neighbours.
//   • MEMORY. A sweep whose modules all fail to list keeps the tree standing,
//     so it must keep the plan that RUNS that tree too. Replacing the plan and
//     keeping the tree left every test "No result reported".
//   • AGE. A module on a platform too old to list as JSON must say so — the
//     only remedy is updating its test framework package.
//
// Covers [TEST-MTP-DETECT], [TEST-MTP-MODULES], [TEST-MTP-DISCOVERY] and [TEST-MTP-RUN].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { listTests } from '../../test-discovery.js';
import type { TestListing } from '../../test-listing-model.js';
import { formatDuration, statusLensTitle } from '../../test-lens.js';
import { usesMtpRunner } from '../../test-mtp.js';
import { listMtpTests } from '../../test-mtp-discovery.js';
import {
  buildsLogged,
  createSolution,
  dotnet,
  libraryProjectXml,
  mtpProjectXml,
  MTP_XUNIT_PACKAGES,
  projectXml,
  warmDiscovery,
  writeBuildCounter,
  writeMtpGlobalJson,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  activateTestExplorer,
  collectLeafIds,
  discoverSolution,
  drainDiscovery,
  errorTextOf,
  findItem,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import { assertPassed, cachedFor, itemsFor } from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';

/** An F# library: something to build, and no test anywhere. */
const LIBRARY_SOURCE = 'module Sweep.Library\n\nlet add a b = a + b\n';

/** A VSTest project that does not compile. */
const BROKEN_SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.SweepBroken.Fixtures',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, NotDefinedAnywhere);',
  '    }',
  '}',
  '',
].join('\n');

/** An MSTest class, for a module on a platform too old to list as JSON. */
const OLD_MSTEST_SOURCE = [
  'using Microsoft.VisualStudio.TestTools.UnitTesting;',
  '',
  'namespace Cs.SweepOld.Fixtures',
  '{',
  '    [TestClass]',
  '    public class CalculatorTests',
  '    {',
  '        [TestMethod] public void Adds_TwoNumbers() => Assert.AreEqual(3, 1 + 2);',
  '    }',
  '}',
  '',
].join('\n');

/** An MTP test class; `extra` goes into the namespace beside it. */
function mtpSource(namespace: string, extra: readonly string[] = []): string {
  return [
    'using Xunit;',
    '',
    `namespace ${namespace}`,
    '{',
    ...extra,
    '    public class CalculatorTests',
    '    {',
    '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, 1 + 2);',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * A module initializer that ends the module before any test code runs while
 * `marker` exists — so a sweep can be made to fail to LIST the module, on
 * demand, while its build keeps succeeding.
 */
function exitWhileMarked(marker: string): string[] {
  return [
    '    internal static class ListingSwitch',
    '    {',
    '        [System.Runtime.CompilerServices.ModuleInitializer]',
    '        internal static void ExitWhileMarked()',
    '        {',
    `            if (System.IO.File.Exists(@"${marker}")) System.Environment.Exit(42);`,
    '        }',
    '    }',
  ];
}

/** Write an MTP xunit.v3 project and BUILD it, so its module is on disk. */
async function builtMtpProject(dir: string, name: string, namespace: string): Promise<string> {
  const file = `${name}.csproj`;
  const xml = mtpProjectXml(MTP_XUNIT_PACKAGES);
  writeProject(dir, file, xml, `${name}.cs`, mtpSource(namespace));
  await dotnet(['build', file, '--nologo'], dir);
  return path.join(dir, file);
}

/** Write an F# library project; `Library.fs` is its only source. */
function writeLibrary(dir: string, name: string): string {
  writeProject(
    dir,
    `${name}.fsproj`,
    libraryProjectXml('Library.fs'),
    'Library.fs',
    LIBRARY_SOURCE,
  );
  return dir;
}

/** The test ids a listing attributed, whatever runner produced it. */
function namesOf(listing: TestListing): string[] {
  return [...listing.names];
}

/** True when a build of `name` left its module in `dir`'s `bin/Debug/<tfm>/`. */
function leftOnDisk(dir: string, name: string): boolean {
  const debug = path.join(dir, 'bin', 'Debug');
  return (
    fs.existsSync(debug) &&
    fs.readdirSync(debug).some((tfm) => fs.existsSync(path.join(debug, tfm, `${name}.dll`)))
  );
}

/** The modules a listing would RUN — none, when it planned nothing. */
function modulesPlanned(listing: TestListing): string[] {
  return (listing.mtp?.modules ?? []).map((module) => module.modulePath);
}

/** The builds `run` cost, counted afresh from an empty log. */
async function buildsDuring(log: string, run: () => Promise<unknown>): Promise<string[]> {
  fs.rmSync(log, { force: true });
  await run();
  return buildsLogged(log);
}

/** The VSTest passes alone: what a sweep costs BEFORE any MTP probe. */
async function vstestBaseline(log: string, sln: string, root: string): Promise<string[]> {
  return buildsDuring(log, async () => {
    // A solution that does not compile makes the helper reject; its builds
    // still happened, and they are the baseline.
    await warmDiscovery(sln, root).catch(() => undefined);
  });
}

suite('Test Explorer e2e — what an MTP probe sweep costs, reaches and keeps', () => {
  let api: SharpLspExtensionApi;
  let parent: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-sweeps-'));
  });

  teardown(async () => {
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
  });

  suiteTeardown(() => {
    removeDirRecursive(parent);
  });

  test('a solution with no MTP project is built no more often than VSTest builds it', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    // 1. A library solution — the Testing view open over code with no tests.
    const lib = path.join(parent, 'lib');
    fs.mkdirSync(lib, { recursive: true });
    const libLog = writeBuildCounter(lib);
    const core = writeLibrary(path.join(lib, 'Core'), 'SweepCore');
    const libSln = await createSolution(lib, 'SweepLib', [core]);
    const libBaseline = await vstestBaseline(libLog, libSln, lib);
    const listed: TestListing[] = [];
    const libBuilds = await buildsDuring(libLog, async () => listed.push(await listTests(libSln)));
    assert.deepStrictEqual(libBuilds, libBaseline, 'the probe must add no build of its own');
    // [TEST-MTP-DETECT] the counter sees THIS solution's builds, so an equal
    // count above is a count of builds, not a counter that saw nothing.
    const direct = await buildsDuring(libLog, async () => dotnet(['build', libSln], lib));
    assert.deepStrictEqual(direct, ['SweepCore'], 'a real build of the library is counted');
    const [listing] = listed;
    assert.ok(listing, 'the sweep produced a listing');
    assert.equal(listing.ok, true, `no test is a truthful answer: ${listing.warnings.join('\n')}`);
    assert.deepStrictEqual(namesOf(listing), [], 'and it lists nothing');
    assert.equal(listing.mtp, undefined, 'and has no MTP module to run');

    // 2. The same solution through the controller: the sweep the user triggers.
    //    Loading may start a reactive sweep of its own, so it settles first and
    //    exactly ONE sweep is counted.
    await api.explorerProvider.loadSolution(libSln);
    await drainDiscovery(() => undefined, api.testController);
    const viewBuilds = await buildsDuring(libLog, async () => {
      await api.testController.activateAndDiscover();
      await api.testController.whenIdle();
    });
    assert.deepStrictEqual(viewBuilds, libBaseline, 'a Testing-view sweep costs what VSTest costs');
    assert.equal(api.testController.items.size, 0, 'and shows no row for a solution with no test');

    // 3. A VSTest solution that FAILS to build: the error row must not wait for
    //    a second failing build, and must carry the compiler's own words.
    const broken = path.join(parent, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    const brokenLog = writeBuildCounter(broken);
    const project = writeProject(
      path.join(broken, 'SweepBrokenCs'),
      'SweepBrokenCs.csproj',
      projectXml(XUNIT_PACKAGES),
      'CalculatorTests.cs',
      BROKEN_SOURCE,
    );
    const brokenSln = await createSolution(broken, 'SweepBroken', [project]);
    const brokenBaseline = await vstestBaseline(brokenLog, brokenSln, broken);
    assert.ok(brokenBaseline.length > 0, 'VSTest really did try to build the broken project');
    const sweeps: TestListing[] = [];
    const brokenBuilds = await buildsDuring(brokenLog, async () =>
      sweeps.push(await listTests(brokenSln)),
    );
    assert.deepStrictEqual(brokenBuilds, brokenBaseline, 'one failing build per sweep, not two');
    const [failed] = sweeps;
    assert.ok(failed, 'the sweep produced a listing');
    const warnings = failed.warnings.join('\n');
    assert.equal(failed.ok, false, 'a build failure is not an empty solution');
    assert.ok(
      warnings.includes('NotDefinedAnywhere'),
      `the compiler's error is surfaced: ${warnings}`,
    );
    assert.ok(!warnings.includes('dotnet build reported a failure'), `no probe build: ${warnings}`);
    assert.equal(failed.mtp, undefined, 'a VSTest solution that failed to build plans no MTP run');

    // 4. The same broken solution in the Testing view: ONE failing build, then
    //    ONE error row carrying the compiler's words ([TEST-MTP-MODULES]).
    await api.explorerProvider.loadSolution(brokenSln);
    await drainDiscovery(() => {
      api.testController.items.replace([]);
    }, api.testController);
    const viewBroken = await buildsDuring(brokenLog, async () => {
      await api.testController.activateAndDiscover();
      await api.testController.whenIdle();
    });
    assert.deepStrictEqual(
      viewBroken,
      brokenBaseline,
      'the view waits for no second failing build',
    );
    const rows = rootsOf(api.testController.items);
    assert.equal(rows.length, 1, 'one row: the error');
    assert.ok(errorTextOf(rows[0]).includes('NotDefinedAnywhere'), errorTextOf(rows[0]));
  });

  test('a folder or a project file is enumerated the way dotnet resolves it, never walked', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    // 1. TWO project files in one folder: `dotnet` answers MSB1011. A module an
    //    earlier build left beside them must not be listed as if it were live.
    const two = path.join(parent, 'two');
    await builtMtpProject(two, 'SweepTwoMtpCs', 'Cs.SweepTwo.Fixtures');
    writeLibrary(two, 'SweepTwoLib');
    assert.ok(leftOnDisk(two, 'SweepTwoMtpCs'), 'an earlier build left the module on disk');
    const ambiguous = await listTests(two);
    assert.deepStrictEqual(namesOf(ambiguous), [], 'an ambiguous folder lists nothing');
    assert.equal(ambiguous.ok, false, 'and says the enumeration failed');
    assert.ok(ambiguous.warnings.join('\n').includes('MSB1011'), ambiguous.warnings.join('\n'));
    assert.deepStrictEqual(modulesPlanned(ambiguous), [], 'and plans no module to run');

    // 2. Projects in SUBFOLDERS and none at the top: `dotnet` answers MSB1003,
    //    and the probe must not dig the MTP one out from below.
    const nested = path.join(parent, 'nested');
    await builtMtpProject(path.join(nested, 'Mtp'), 'SweepNestedMtpCs', 'Cs.SweepNested.Fixtures');
    writeLibrary(path.join(nested, 'Lib'), 'SweepNestedLib');
    assert.ok(leftOnDisk(path.join(nested, 'Mtp'), 'SweepNestedMtpCs'), 'a module sits below');
    const unresolved = await listTests(nested);
    assert.deepStrictEqual(namesOf(unresolved), [], 'a folder dotnet cannot resolve lists nothing');
    assert.equal(unresolved.ok, false);
    assert.ok(unresolved.warnings.join('\n').includes('MSB1003'), unresolved.warnings.join('\n'));
    assert.deepStrictEqual(modulesPlanned(unresolved), [], 'and plans nothing from below');

    // 3. A PROJECT FILE is that project: an MTP project nested in its folder is
    //    a neighbour, not part of it.
    const app = path.join(parent, 'app', 'App');
    writeLibrary(app, 'SweepApp');
    await builtMtpProject(path.join(app, 'Tests'), 'SweepAppTestsCs', 'Cs.SweepApp.Fixtures');
    const single = await listTests(path.join(app, 'SweepApp.fsproj'));
    assert.deepStrictEqual(
      namesOf(single),
      [],
      'a library project has no test, whatever sits below it',
    );
    assert.equal(single.ok, true, `and that is a truthful answer: ${single.warnings.join('\n')}`);
    assert.deepStrictEqual(modulesPlanned(single), [], 'the neighbour module is never planned');

    // 4. The same ambiguous folder OPTED IN to MTP skips the VSTest passes, so
    //    the MTP path alone must refuse it — loudly, never as an empty tree.
    const optedIn = path.join(parent, 'opted-in');
    fs.mkdirSync(optedIn, { recursive: true });
    writeMtpGlobalJson(optedIn);
    await builtMtpProject(optedIn, 'SweepOptedMtpCs', 'Cs.SweepOpted.Fixtures');
    writeLibrary(optedIn, 'SweepOptedLib');
    const refused = await listTests(optedIn);
    assert.deepStrictEqual(namesOf(refused), [], 'an ambiguous opted-in folder lists nothing');
    assert.equal(refused.ok, false, 'and is not mistaken for a folder with no test');
    assert.ok(refused.warnings.join('\n').includes('MSB1011'), refused.warnings.join('\n'));
    assert.deepStrictEqual(modulesPlanned(refused), [], 'no module left on disk is run');
  });

  test('a sweep that fails to LIST keeps the plan that runs the tree it keeps', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const root = path.join(parent, 'switch');
    const marker = path.join(root, 'fail-listing');
    const id = 'Cs.SweepSwitch.Fixtures.CalculatorTests.Adds_TwoNumbers';
    fs.mkdirSync(root, { recursive: true });
    writeMtpGlobalJson(root);
    const dir = writeProject(
      path.join(root, 'SweepSwitchCs'),
      'SweepSwitchCs.csproj',
      mtpProjectXml(MTP_XUNIT_PACKAGES),
      'CalculatorTests.cs',
      mtpSource('Cs.SweepSwitch.Fixtures', exitWhileMarked(marker)),
    );
    const sln = await createSolution(root, 'SweepSwitch', [dir]);

    // 1. Discovered and green.
    await discoverSolution(api, sln, [id]);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, [id]));
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, id), id);

    // 2. The module now dies before it can list. The sweep fails, and the tree
    //    it cannot rebuild stays standing.
    fs.writeFileSync(marker, 'listing fails while this file exists\n', 'utf8');
    const failed = await listMtpTests(sln, root);
    assert.equal(failed.ok, false, 'a module that lists nothing is not an empty module');
    // [TEST-MTP-DISCOVERY] the failure names its module, and lists no test …
    assert.deepStrictEqual(namesOf(failed), [], 'nothing listed');
    assert.ok(failed.warnings.join('\n').includes('SweepSwitchCs.dll'), failed.warnings.join('\n'));
    // … so the plan it carries could run nothing: exactly why it must not be kept.
    assert.deepStrictEqual(
      (failed.mtp?.modules ?? []).flatMap((module) => [...module.uidsById.keys()]),
      [],
      'the failed plan owns no id',
    );
    await api.testController.activateAndDiscover();
    await api.testController.whenIdle();
    assert.ok(findItem(api.testController.items, id), 'the failed sweep keeps the tree');
    assert.deepStrictEqual(collectLeafIds(api.testController.items), [id], 'the whole tree');

    // 3. The module lists again. ▶ on the KEPT tree must run it — through the
    //    Run profile and through the status CodeLens alike.
    fs.rmSync(marker, { force: true });
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, [id]));
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, id), id);
    const lens = await api.testController.runSingle(id);
    assert.equal(lens.outcome, 'passed', `the lens runs the kept tree too: ${lens.message ?? ''}`);
    // [TEST-STATUS-LENS] a real pass, painted as one, and cached as the lens shows it.
    assert.equal(lens.passed, true, 'the pass flag is set');
    assert.equal(statusLensTitle(lens), `$(pass) Passed${formatDuration(lens.duration)}`);
    assert.deepStrictEqual(cachedFor(api, id), lens, 'the cache holds what the lens ran');
  });

  test('a module on a platform older than 2.3 says to update it, in the log and in the tree', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    // MSTest 3.11 carries MTP 1.9, whose `--list-tests` takes no argument and
    // refuses `json` with exit code 5. That refusal is the ONLY sign the module
    // is too old to be listed; unread, it "listed no test" for no stated reason.
    const root = path.join(parent, 'old');
    fs.mkdirSync(root, { recursive: true });
    writeMtpGlobalJson(root);
    const dir = writeProject(
      path.join(root, 'SweepOldMtpCs'),
      'SweepOldMtpCs.csproj',
      mtpProjectXml([{ id: 'MSTest', version: '3.11.0' }]),
      'CalculatorTests.cs',
      OLD_MSTEST_SOURCE,
    );
    const sln = await createSolution(root, 'SweepOld', [dir]);

    // 1. The listing names the cause, the option and the module.
    const listing = await listMtpTests(sln, root);
    const warnings = listing.warnings.join('\n');
    assert.deepStrictEqual(namesOf(listing), [], 'a module that cannot list shows no test');
    assert.equal(listing.ok, false, 'and that is not an empty module');
    assert.ok(warnings.includes('older than 2.3'), `the cause is named: ${warnings}`);
    assert.ok(warnings.includes('SweepOldMtpCs.dll rejected --list-tests'), warnings);
    // [TEST-MTP-DETECT] the opt-in chose MTP, and [TEST-MTP-MODULES] the build came
    // first: the module that refused is on disk, so the refusal is not a build error.
    assert.equal(usesMtpRunner(root), true, 'global.json opts the solution in');
    assert.ok(leftOnDisk(dir, 'SweepOldMtpCs'), 'the module was built before it was asked');

    // 2. The Testing view, over an empty tree, shows ONE error row saying so.
    await api.explorerProvider.loadSolution(sln);
    await drainDiscovery(() => {
      api.testController.items.replace([]);
    }, api.testController);
    await api.testController.activateAndDiscover();
    await api.testController.whenIdle();
    const errors = rootsOf(api.testController.items).filter((item) => item.error !== undefined);
    assert.equal(errors.length, 1, 'one error row for the solution');
    const [row] = errors;
    const text = errorTextOf(row);
    assert.ok(text.includes('Update the test framework package'), `the remedy is shown: ${text}`);
    // The row says it all: the cause, the module, and nothing else stands beside it.
    assert.ok(text.includes('older than 2.3'), `the cause, in the tree too: ${text}`);
    assert.ok(text.includes('SweepOldMtpCs.dll'), `and the module: ${text}`);
    assert.equal(rootsOf(api.testController.items).length, 1, 'the error row is the whole tree');
  });
});
