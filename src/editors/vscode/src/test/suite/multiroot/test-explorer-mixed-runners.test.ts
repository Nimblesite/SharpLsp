// A VSTest folder BESIDE a Microsoft.Testing.Platform folder, in ONE window.
//
// With no solution loaded, discovery enumerates every workspace folder, and one
// ▶ can select tests from several of them. Each test must still go to the
// runner that DISCOVERED it: a VSTest id through `dotnet test`, an MTP id
// through its own module. Sending every run to MTP as soon as ANY folder was
// MTP left the VSTest folder's tests reporting "No result reported" — on the
// root, on a selection, and from the status CodeLens alike.
//
// The MTP folder carries NO `global.json` opt-in, so it is found the way issue
// #249 was reported: the VSTest passes list nothing for it, and MSBuild's
// `IsTestingPlatformApplication` probe rescues the sweep through the controller
// itself, not through a direct call.
//
// The MTP folder is the SECOND one, so the working directory every run starts
// from belongs to the VSTest folder: an MTP rebuild that built "the run's
// directory" would build the wrong project and run a stale module.
//
// Covers [TEST-MTP-DETECT], [TEST-MTP-RUN] and [TEST-MTP-ROUTING].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../../extension.js';
import { statusLensTitle } from '../../../test-lens.js';
import { usesMtpRunner } from '../../../test-mtp.js';
import { discoveryTargets, runCwd } from '../../../test-targets.js';
import {
  mtpProjectXml,
  MTP_XUNIT_PACKAGES,
  projectXml,
  writeProject,
  XUNIT_PACKAGES,
} from '../dotnet-project-kit';
import {
  activateTestExplorer,
  collectLeafIds,
  drainDiscovery,
  pollUntilDiscovered,
  rootsOf,
  runViaProfile,
} from '../test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  cachedFor,
  itemsFor,
  sorted,
  XUNIT_FAILURE_TEXT,
} from '../test-explorer-outcome-assertions';
import { comparablePath } from '../test-helpers';
import { FIXTURE_BUILD_MS } from '../test-timeouts';

/** The F# VSTest project, alone in the FIRST workspace folder. */
const VSTEST_PROJECT = 'MixedVsTestFs';
const VSTEST_MODULE = 'Fs.MixedVsTest.Fixtures.CalculatorTests';
const VSTEST_PASS = `${VSTEST_MODULE}.Adds_TwoNumbers`;
const VSTEST_FAIL = `${VSTEST_MODULE}.Fails_OnPurpose`;

/** The C# xunit.v3 project, alone in the SECOND workspace folder. */
const MTP_PROJECT = 'MixedMtpCs';
const MTP_CLASS = 'Cs.MixedMtp.Fixtures.CalculatorTests';
const MTP_PASS = `${MTP_CLASS}.Adds_TwoNumbers`;
const MTP_FAIL = `${MTP_CLASS}.Fails_OnPurpose`;
const MTP_SOURCE_FILE = 'CalculatorTests.cs';

/** Every id the two folders expose, one pass and one failure per runner. */
const EXPECTED = [VSTEST_PASS, VSTEST_FAIL, MTP_PASS, MTP_FAIL];

/** The F# module: VSTest names it by its compiled type, the module path. */
const VSTEST_SOURCE = [
  `module ${VSTEST_MODULE}`,
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let Adds_TwoNumbers () = Assert.Equal(3, 1 + 2)',
  '',
  '[<Fact>]',
  'let Fails_OnPurpose () = Assert.Equal(4, 1 + 2)',
  '',
].join('\n');

/** The C# class; `expected` decides whether `Adds_TwoNumbers` passes. */
function mtpSource(expected: number): string {
  return [
    'using Xunit;',
    '',
    'namespace Cs.MixedMtp.Fixtures',
    '{',
    '    public class CalculatorTests',
    '    {',
    `        [Fact] public void Adds_TwoNumbers() => Assert.Equal(${String(expected)}, 1 + 2);`,
    '        [Fact] public void Fails_OnPurpose() => Assert.Equal(4, 1 + 2);',
    '    }',
    '}',
    '',
  ].join('\n');
}

/** The 1-based line `Adds_TwoNumbers` is declared on in {@link mtpSource}. */
const MTP_PASS_LINE = 7;

/** The module an assembly root stands for: its id is `assembly:<module path>`. */
function modulePathOf(root: vscode.TestItem | undefined): string {
  assert.ok(root, 'the assembly root must exist');
  return root.id.slice('assembly:'.length);
}

/** Last-modified time of `file`, in milliseconds. */
function mtimeOf(file: string): number {
  return fs.statSync(file).mtimeMs;
}

/** The workspace folder `.vscode-test.mjs` opened under `name`. */
function folderNamed(name: string): string {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === name);
  assert.ok(folder, `the multi-root workspace must open a '${name}' folder`);
  return folder.uri.fsPath;
}

/** Empty a workspace folder without removing the folder VS Code has open. */
function emptyFolder(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/** ▶ on `ids` exactly as the Testing view's Run button does, then settle. */
async function run(api: SharpLspExtensionApi, ids: readonly string[]): Promise<void> {
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, ids));
  await api.testController.whenIdle();
}

/** Every fixture test carries its true verdict in the result cache. */
function assertEveryVerdict(api: SharpLspExtensionApi): void {
  assertPassed(cachedFor(api, VSTEST_PASS), VSTEST_PASS);
  assertFailed(cachedFor(api, VSTEST_FAIL), VSTEST_FAIL);
  assertPassed(cachedFor(api, MTP_PASS), MTP_PASS);
  assertFailed(cachedFor(api, MTP_FAIL), MTP_FAIL);
}

suite('Test Explorer e2e — a VSTest folder and an MTP folder in one workspace', () => {
  let api: SharpLspExtensionApi;
  let vstestDir: string;
  let mtpDir: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    vstestDir = folderNamed('vstest');
    mtpDir = folderNamed('mtp');
    const vstestXml = projectXml(XUNIT_PACKAGES, 'CalculatorTests.fs');
    writeProject(
      vstestDir,
      `${VSTEST_PROJECT}.fsproj`,
      vstestXml,
      'CalculatorTests.fs',
      VSTEST_SOURCE,
    );
    const mtpXml = mtpProjectXml(MTP_XUNIT_PACKAGES);
    writeProject(mtpDir, `${MTP_PROJECT}.csproj`, mtpXml, MTP_SOURCE_FILE, mtpSource(3));
    // No solution: discovery must enumerate each FOLDER.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
    }, api.testController);
    await api.testController.activateAndDiscover();
    await pollUntilDiscovered(api.testController, EXPECTED);
  });

  teardown(async () => {
    await api.testController.whenIdle();
  });

  suiteTeardown(async () => {
    await drainDiscovery(() => {
      api.testController.items.replace([]);
    }, api.testController);
    emptyFolder(vstestDir);
    emptyFolder(mtpDir);
  });

  test('each folder is discovered by its own runner, under its own assembly root', function () {
    // 1. Both folders are enumerated; the order of the folders is the order
    //    of the roots, and neither runner's tests leak under the other's root.
    const roots = rootsOf(api.testController.items);
    assert.deepStrictEqual(
      roots.map((root) => root.label),
      [VSTEST_PROJECT, MTP_PROJECT],
      'one assembly root per folder, in folder order',
    );

    // 2. The MTP folder has no opt-in, so only the MSBuild probe can have found
    //    it — and it found exactly its own tests.
    assert.deepStrictEqual(
      sorted(itemsFor(api, EXPECTED).map((item) => item.id)),
      sorted(EXPECTED),
      'all four tests are in the tree',
    );
    assert.deepStrictEqual(
      roots.map((root) => sorted(collectLeafIds(root.children))),
      [sorted([VSTEST_PASS, VSTEST_FAIL]), sorted([MTP_PASS, MTP_FAIL])],
      'each root holds exactly the tests of its own folder',
    );

    // 3. Nothing failed to enumerate, so no error row stands in the tree.
    assert.deepStrictEqual(
      roots.filter((root) => root.error !== undefined).map((root) => root.label),
      [],
      'no folder produced an error row',
    );

    // 4. [TEST-MTP-ROUTING] one target per folder, and [TEST-MTP-DETECT] no
    //    opt-in anywhere: the MTP folder was found by the probe alone.
    assert.deepStrictEqual(discoveryTargets(), [vstestDir, mtpDir], 'one target per folder');
    assert.equal(usesMtpRunner(mtpDir), false, 'the MTP folder carries no global.json opt-in');

    // 5. [TEST-MTP-MODULES] the MTP root is the module MSBuild named: built, on
    //    disk, inside its own folder.
    const module = modulePathOf(roots[1]);
    assert.equal(path.basename(module), `${MTP_PROJECT}.dll`, 'the TargetPath module');
    assert.ok(fs.existsSync(module), `only modules on disk are kept: ${module}`);
    assert.ok(!path.relative(mtpDir, module).startsWith('..'), `under its folder: ${module}`);

    // 6. [TEST-MTP-DISCOVERY] `location` gives each MTP row its file and line.
    const [pass, fail] = itemsFor(api, [MTP_PASS, MTP_FAIL]);
    const sourceFile = comparablePath(path.join(mtpDir, MTP_SOURCE_FILE));
    assert.equal(comparablePath(pass?.uri?.fsPath ?? ''), sourceFile, 'the row opens its source');
    assert.deepStrictEqual(
      [pass?.range?.start.line, fail?.range?.start.line],
      [MTP_PASS_LINE - 1, MTP_PASS_LINE],
      'each row selects the line its test is declared on',
    );
  });

  test('▶ on tests of EACH runner reports their real outcomes, apart and together', async function () {
    this.timeout(FIXTURE_BUILD_MS);

    // 1. A selection from the VSTest folder only: `dotnet test` must run it.
    const untouchedMtp = api.testController.getResult(MTP_PASS);
    const untouchedMtpFail = api.testController.getResult(MTP_FAIL);
    await run(api, [VSTEST_PASS, VSTEST_FAIL]);
    assertPassed(cachedFor(api, VSTEST_PASS), VSTEST_PASS);
    assertFailed(cachedFor(api, VSTEST_FAIL), VSTEST_FAIL);
    // [TEST-MTP-ROUTING] a runner left with no id is not started: neither MTP
    // test was run or re-cached.
    assert.equal(api.testController.getResult(MTP_PASS), untouchedMtp, 'MTP was not started');
    assert.equal(api.testController.getResult(MTP_FAIL), untouchedMtpFail, 'for either test');

    // 2. A selection from the MTP folder only: its module must run it.
    const vstestAfterOne = api.testController.getResult(VSTEST_PASS);
    await run(api, [MTP_PASS, MTP_FAIL]);
    assertPassed(cachedFor(api, MTP_PASS), MTP_PASS);
    assertFailed(cachedFor(api, MTP_FAIL), MTP_FAIL);
    assert.equal(api.testController.getResult(VSTEST_PASS), vstestAfterOne, 'VSTest not started');

    // 3. ONE selection spanning both runners: each half reaches its runner.
    const unselected = [VSTEST_PASS, MTP_FAIL].map((id) => api.testController.getResult(id));
    await run(api, [VSTEST_FAIL, MTP_PASS]);
    assertFailed(cachedFor(api, VSTEST_FAIL), VSTEST_FAIL);
    assertPassed(cachedFor(api, MTP_PASS), MTP_PASS);
    // A selection is split by ownership: what was not selected was not run …
    assert.deepStrictEqual(
      [VSTEST_PASS, MTP_FAIL].map((id) => api.testController.getResult(id)),
      unselected,
      'the unselected test of each runner stands',
    );
    // … and the VSTest half is never the "No result reported" the defect left.
    const vstestFailure = cachedFor(api, VSTEST_FAIL).message ?? '';
    assert.ok(!vstestFailure.includes('No result reported'), `a real failure: ${vstestFailure}`);
  });

  test('▶ on the whole tree and the status CodeLens both reach both runners', async function () {
    this.timeout(FIXTURE_BUILD_MS);

    // 1. ▶ on the root sends no filter at all, and still runs BOTH folders.
    const beforeRoot = EXPECTED.map((id) => api.testController.getResult(id));
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, []);
    await api.testController.whenIdle();
    assertEveryVerdict(api);
    // [TEST-MTP-ROUTING] the whole tree starts BOTH runners over everything:
    // every test of each folder carries a fresh result.
    assert.deepStrictEqual(
      EXPECTED.filter((id, index) => api.testController.getResult(id) === beforeRoot[index]),
      [],
      'no test of either runner was left out of ▶ on the root',
    );

    // 2. The status CodeLens runs one test through `runSingle`, per runner.
    const mtpBeforeLens = api.testController.getResult(MTP_PASS);
    const vstest = await api.testController.runSingle(VSTEST_PASS);
    assert.equal(vstest.outcome, 'passed', `VSTest lens run: ${vstest.message ?? '(none)'}`);
    // [TEST-STATUS-LENS] what the lens ran is what the cache — and so the lens — now shows …
    assert.deepStrictEqual(api.testController.getResult(VSTEST_PASS), vstest, 'the lens paints it');
    assert.equal(api.testController.getResult(MTP_PASS), mtpBeforeLens, 'MTP was not started');
    const mtp = await api.testController.runSingle(MTP_FAIL);
    assert.equal(mtp.outcome, 'failed', `MTP lens run: ${mtp.message ?? '(none)'}`);
    // … with the framework's own words behind "Failed", never a generic stand-in.
    assert.ok(
      (mtp.message ?? '').includes(XUNIT_FAILURE_TEXT),
      `xUnit's text: ${mtp.message ?? ''}`,
    );
    assert.equal(
      statusLensTitle(mtp),
      `$(error) Failed: ${mtp.message ?? ''}`,
      'as the lens shows',
    );

    // 3. The lens runs changed nothing they did not run.
    assertEveryVerdict(api);
  });

  test('an edited test in the SECOND folder is rebuilt from that folder before it runs', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const source = path.join(mtpDir, MTP_SOURCE_FILE);
    try {
      // [TEST-MTP-RUN] the run's working directory is the FIRST folder, never
      // the MTP one — the condition this test exists for.
      assert.equal(runCwd(), vstestDir, 'runs start in the first folder');
      const module = modulePathOf(rootsOf(api.testController.items)[1]);

      // 1. Break the MTP test and save. The run starts in the FIRST folder, so
      //    only a rebuild of the MTP folder itself can pick the edit up.
      fs.writeFileSync(source, mtpSource(4), 'utf8');
      const untouched = api.testController.getResult(MTP_FAIL);
      await run(api, [MTP_PASS]);
      assertFailed(cachedFor(api, MTP_PASS), MTP_PASS);
      // The module was BUILT after the edit, and the failure is the edit's own.
      assert.ok(mtimeOf(module) >= mtimeOf(source), 'the module was rebuilt after the edit');
      assert.ok((cachedFor(api, MTP_PASS).message ?? '').includes('4'), 'expected 4, as edited');
      // `--filter-uid` ran the one selected test of the module, and no other.
      assert.equal(api.testController.getResult(MTP_FAIL), untouched, 'the other test stands');

      // 2. A selection spanning both folders sees the edit too, and the VSTest
      //    half is unaffected by it.
      const vstestFail = api.testController.getResult(VSTEST_FAIL);
      await run(api, [VSTEST_PASS, MTP_PASS]);
      assertPassed(cachedFor(api, VSTEST_PASS), VSTEST_PASS);
      assertFailed(cachedFor(api, MTP_PASS), MTP_PASS);
      assert.equal(api.testController.getResult(VSTEST_FAIL), vstestFail, 'VSTest ran its one');

      // 3. Put it back: green again, so the rebuild tracks the source both ways.
      fs.writeFileSync(source, mtpSource(3), 'utf8');
      await run(api, [MTP_PASS]);
      assertPassed(cachedFor(api, MTP_PASS), MTP_PASS);
      assert.ok(mtimeOf(module) >= mtimeOf(source), 'rebuilt after the second edit too');
    } finally {
      fs.writeFileSync(source, mtpSource(3), 'utf8');
    }
  });
});
