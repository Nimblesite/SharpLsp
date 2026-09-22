// A run pressed while a discovery sweep is still in the `dotnet` queue, end to
// end.
//
// Every `dotnet` invocation goes through one queue ([TEST-REACTIVITY]), so a ▶
// pressed while a sweep is listing waits behind it — and must then run with
// what THAT sweep found ([TEST-MTP-ROUTING]). The sweep applied its runners
// only after the queue had already moved on, so the run went out with the
// runners of the sweep BEFORE it: a project just moved onto
// Microsoft.Testing.Platform was sent to `dotnet test --filter … --logger trx`,
// which MTP refuses, and a Debug press sent it there with the module waiting
// for a debugger that never came.
//
// The fixture is one C# project that starts on VSTest and is then moved onto
// MTP in place — a `global.json` opt-in and the `xunit.v3` packages — keeping
// its solution, its folder and its test id, exactly as a user migrates.
//
// Covers [TEST-REACTIVITY], [TEST-MTP-DETECT] and [TEST-MTP-ROUTING].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { formatDuration, statusLensTitle } from '../../test-lens.js';
import { usesMtpRunner } from '../../test-mtp.js';
import {
  createSolution,
  mtpProjectXml,
  MTP_XUNIT_PACKAGES,
  projectXml,
  writeMtpGlobalJson,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  activateTestExplorer,
  collectLeafIds,
  discoverSolution,
  findItem,
  rootsOf,
  runViaProfile,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { assertPassed, cachedFor, itemsFor } from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

const PROJECT = 'QueueCs';
const ID = 'Cs.Queue.Fixtures.CalculatorTests.Adds_TwoNumbers';
const SOURCE_FILE = 'CalculatorTests.cs';

/** A second VSTest solution, loaded while a sweep of the first is queued. */
const OTHER_PROJECT = 'QueueOtherFs';
const OTHER_ID = 'Fs.QueueOther.Fixtures.CalculatorTests.Adds_TwoNumbers';
const OTHER_SOURCE = [
  'module Fs.QueueOther.Fixtures.CalculatorTests',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let Adds_TwoNumbers () = Assert.Equal(3, 1 + 2)',
  '',
].join('\n');

/** One passing test; xUnit v2 and `xunit.v3` compile the same source. */
const SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.Queue.Fixtures',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, 1 + 2);',
  '    }',
  '}',
  '',
].join('\n');

/** ▶ on `ID` exactly as the Testing view's Run button does. */
async function runTheTest(api: SharpLspExtensionApi): Promise<void> {
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, [ID]));
}

suite('Test Explorer e2e — a run queued behind a discovery sweep', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let projectDir: string;
  let slnPath: string;
  let otherRoot: string;
  let otherSln: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-queue-'));
    const xml = projectXml(XUNIT_PACKAGES);
    projectDir = writeProject(
      path.join(root, PROJECT),
      `${PROJECT}.csproj`,
      xml,
      SOURCE_FILE,
      SOURCE,
    );
    slnPath = await createSolution(root, 'Queue', [projectDir]);
    // Its own folder: test 1 opts `root` into MTP, and a `global.json` opt-in
    // governs every solution below it ([TEST-MTP-DETECT]).
    otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-queue-other-'));
    const otherDir = writeProject(
      path.join(otherRoot, OTHER_PROJECT),
      `${OTHER_PROJECT}.fsproj`,
      projectXml(XUNIT_PACKAGES, 'CalculatorTests.fs'),
      'CalculatorTests.fs',
      OTHER_SOURCE,
    );
    otherSln = await createSolution(otherRoot, 'QueueOther', [otherDir]);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
    removeDirRecursive(otherRoot);
  });

  test('a ▶ queued behind a sweep runs with the runner that sweep found', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    // 1. On VSTest: discovered, run, green.
    await discoverSolution(api, slnPath, [ID]);
    assert.equal(usesMtpRunner(root), false, 'no opt-in yet: VSTest');
    await runTheTest(api);
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, ID), ID);
    const onVsTest = cachedFor(api, ID);

    // 2. Move the project onto MTP in place, press refresh, and press ▶ while
    //    that sweep is still in the queue. The run waits behind the sweep, so it
    //    must run with the sweep's runner: MTP, not the VSTest one before it.
    writeMtpGlobalJson(root);
    const mtpXml = mtpProjectXml(MTP_XUNIT_PACKAGES);
    writeProject(projectDir, `${PROJECT}.csproj`, mtpXml, SOURCE_FILE, SOURCE);
    assert.equal(usesMtpRunner(root), true, '[TEST-MTP-DETECT]: the opt-in selects MTP');
    const sweeping = api.testController.activateAndDiscover();
    await runTheTest(api);
    await sweeping;
    await api.testController.whenIdle();
    const queued = cachedFor(api, ID);
    assertPassed(queued, ID);
    assert.notStrictEqual(queued, onVsTest, 'a fresh result, from the run behind the sweep');
    assert.deepStrictEqual(collectLeafIds(api.testController.items), [ID], 'the one test');
    assert.deepStrictEqual(
      rootsOf(api.testController.items).map((row) => row.label),
      [PROJECT],
      'under its module, the same project',
    );

    // 3. Idle again: ▶ and the status CodeLens both still reach the module.
    await runTheTest(api);
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, ID), ID);
    const lens = await api.testController.runSingle(ID);
    assert.equal(lens.outcome, 'passed', `the lens run: ${lens.message ?? '(none)'}`);
    assert.equal(statusLensTitle(lens), `$(pass) Passed${formatDuration(lens.duration)}`);
    assert.deepStrictEqual(cachedFor(api, ID), lens, 'the cache holds what the lens ran');
  });

  test('a refresh superseded by a newer sweep resolves over the solution now loaded', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    // 1. The first solution is on view.
    await discoverSolution(api, slnPath, [ID]);
    assert.deepStrictEqual(collectLeafIds(api.testController.items), [ID], 'the first tree');

    // 2. Load the second solution and press refresh; a newer sweep — the one a
    //    solution change schedules — supersedes it before it can apply. The
    //    refresh must still resolve over the SECOND solution's tree, never the
    //    first's ([TEST-REACTIVITY]): a superseded sweep applies nothing, so it
    //    waits for the one that superseded it.
    assert.equal(usesMtpRunner(otherRoot), false, '[TEST-MTP-DETECT]: no opt-in over it: VSTest');
    await api.explorerProvider.loadSolution(otherSln);
    const refresh = api.testController.activateAndDiscover();
    const newer = api.testController.discover();
    await refresh;
    assert.deepStrictEqual(collectLeafIds(api.testController.items), [OTHER_ID], 'the new tree');
    assert.deepStrictEqual(
      rootsOf(api.testController.items).map((row) => row.label),
      [OTHER_PROJECT],
      'under the new solution’s one project',
    );
    assert.equal(findItem(api.testController.items, ID), undefined, 'none of the old tree');

    // 3. The newer sweep settles on the same tree, and runs with its runner:
    //    the F# VSTest project, green, through ▶ and the status CodeLens.
    await newer;
    await api.testController.whenIdle();
    assert.deepStrictEqual(collectLeafIds(api.testController.items), [OTHER_ID], 'it stands');
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [OTHER_ID]),
    );
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, OTHER_ID), OTHER_ID);
    const lens = await api.testController.runSingle(OTHER_ID);
    assert.equal(lens.outcome, 'passed', `the lens run: ${lens.message ?? '(none)'}`);
  });
});
