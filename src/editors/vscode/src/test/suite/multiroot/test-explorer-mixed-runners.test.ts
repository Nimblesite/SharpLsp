// A VSTest folder BESIDE a Microsoft.Testing.Platform folder, in ONE window.
//
// With no solution loaded, discovery enumerates every workspace folder holding a
// project or solution at its top level, and one
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
// Covers [TEST-MTP-DETECT], [TEST-MTP-RUN], [TEST-MTP-ROUTING] and [TEST-DISCOVERY-TARGETS].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../../extension.js';
import type { CachedTestResult } from '../../../testing.js';
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
  runAndSettle,
} from '../test-explorer-outcome-assertions';
import { comparablePath } from '../test-helpers';
import { FIXTURE_BUILD_MS } from '../test-timeouts';
import { spyOnDiscover } from '../test-discovery-spy';
import * as state from '../../../state.js';

/** A project with no test framework: it builds and lists nothing. */
const EMPTY_PROJECT_XML =
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';
const WATCHER_MS = 30_000;
const WATCHER_SETTLE_MS = 3_000;

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

/** True when `dir` can be listed: chmod refuses nothing to root or on Windows. */
function isReadable(dir: string): boolean {
  try {
    fs.readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a reactive effect the editor drives from its file watcher. */
async function pollUntil(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WATCHER_MS;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Empty a workspace folder without removing the folder VS Code has open. */
function emptyFolder(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/** Every fixture test carries its true verdict in the result cache. */
function assertEveryVerdict(api: SharpLspExtensionApi): void {
  assertPassed(cachedFor(api, VSTEST_PASS), VSTEST_PASS);
  assertFailed(cachedFor(api, VSTEST_FAIL), VSTEST_FAIL);
  assertPassed(cachedFor(api, MTP_PASS), MTP_PASS);
  assertFailed(cachedFor(api, MTP_FAIL), MTP_FAIL);
}

/** One expected post-run verdict: the id and the outcome it must carry. */
interface ExpectedVerdict {
  readonly id: string;
  readonly passed: boolean;
}

/** The verdict pair for one runner's green and red test, pass asserted first. */
function pairVerdicts(pass: string, fail: string): readonly ExpectedVerdict[] {
  return [
    { id: pass, passed: true },
    { id: fail, passed: false },
  ];
}

/** One status-lens `runSingle`: `id` reports `outcome`, its message shown as `why`. */
async function runSingleAsserting(
  api: SharpLspExtensionApi,
  id: string,
  outcome: string,
  why: string,
): Promise<CachedTestResult> {
  const result = await api.testController.runSingle(id);
  assert.equal(result.outcome, outcome, `${why}: ${result.message ?? '(none)'}`);
  return result;
}

/** An id the run must leave untouched, and the message saying why it stands. */
interface UntouchedId {
  readonly id: string;
  readonly why: string;
}

/**
 * ▶ `ids`, then assert every expected verdict in the result cache and that each
 * untouched id still carries the very result object it had before the run.
 */
async function runAndAssertVerdicts(
  api: SharpLspExtensionApi,
  ids: readonly string[],
  verdicts: readonly ExpectedVerdict[],
  untouched: readonly UntouchedId[] = [],
): Promise<void> {
  const before = untouched.map((entry) => api.testController.getResult(entry.id));
  await runAndSettle(api, ids);
  for (const { id, passed } of verdicts) {
    if (passed) assertPassed(cachedFor(api, id), id);
    else assertFailed(cachedFor(api, id), id);
  }
  untouched.forEach((entry, index) => {
    assert.equal(api.testController.getResult(entry.id), before[index], entry.why);
  });
}

suite('Test Explorer e2e — a VSTest folder and an MTP folder in one workspace', () => {
  let api: SharpLspExtensionApi;
  let vstestDir: string;
  let mtpDir: string;
  let noProjectDir: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    vstestDir = folderNamed('vstest');
    mtpDir = folderNamed('mtp');
    noProjectDir = folderNamed('no-project');
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
    // [TEST-REACTIVITY-BUILD]: the first folder's real build must not supersede
    // discovery before the second folder's MTP module has ever been built.
    const spy = spyOnDiscover(api.testController);
    try {
      await api.testController.activateAndDiscover();
      await api.testController.whenIdle();
      assert.ok(spy.modes.includes(true), 'native build completions refresh initial discovery');
      assert.deepStrictEqual(
        sorted(collectLeafIds(api.testController.items)),
        sorted(EXPECTED),
        'a build completion cannot skip the never-built second workspace folder',
      );
    } finally {
      spy.restore();
    }
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
    emptyFolder(noProjectDir);
  });

  test('a folder is a discovery target only while dotnet test can resolve it', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const both = [vstestDir, mtpDir];
    const withProject = [vstestDir, mtpDir, noProjectDir];
    const errorRows = (): string[] =>
      rootsOf(api.testController.items)
        .filter((root) => root.error !== undefined)
        .map((root) => root.label);

    // 1. Nothing buildable: no target, no false "Test discovery failed" row.
    assert.deepStrictEqual(discoveryTargets(), both, 'an empty folder is no target');
    assert.deepStrictEqual(errorRows(), [], 'and it paints no error row');
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(EXPECTED),
      'the real folders are still discovered beside it',
    );

    // 2. A directory that merely carries a project suffix is not a project.
    const lookalike = path.join(noProjectDir, 'Fixture.csproj');
    fs.mkdirSync(lookalike);
    fs.writeFileSync(path.join(noProjectDir, 'notes.txt'), 'nothing to build', 'utf8');
    assert.deepStrictEqual(discoveryTargets(), both, 'a .csproj directory is no target');
    emptyFolder(noProjectDir);

    // 3. Every extension `dotnet` resolves counts, in any case.
    for (const name of ['A.sln', 'A.slnx', 'A.slnf', 'A.csproj', 'A.FSPROJ', 'A.vbproj']) {
      const file = path.join(noProjectDir, name);
      fs.writeFileSync(file, '', 'utf8');
      assert.deepStrictEqual(discoveryTargets(), withProject, `${name} makes a target`);
      fs.rmSync(file);
    }
    assert.deepStrictEqual(discoveryTargets(), both, 'and removing it takes the target away');

    // 4. A folder that could not be read is not an empty answer: `dotnet` must
    //    get to refuse it, so the failure reaches the user as an error row.
    fs.chmodSync(noProjectDir, 0o000);
    try {
      const refused = !isReadable(noProjectDir);
      assert.deepStrictEqual(discoveryTargets(), refused ? withProject : both, 'unreadable stays');
    } finally {
      fs.chmodSync(noProjectDir, 0o755);
    }

    // 5. A loaded solution takes over from every folder.
    const solution = path.join(vstestDir, 'Loaded.sln');
    state.solutionPath.value = solution;
    assert.deepStrictEqual(discoveryTargets(), [solution], 'the solution is the one target');
    state.solutionPath.value = undefined;
    assert.deepStrictEqual(discoveryTargets(), both, 'and the folders return without it');

    // 6. Creating and deleting a project rediscovers with no manual refresh. The
    //    watcher echoes of the files above settle first, so only these count.
    await new Promise((resolve) => setTimeout(resolve, WATCHER_SETTLE_MS));
    await api.testController.whenIdle();
    const spy = spyOnDiscover(api.testController);
    try {
      const project = path.join(noProjectDir, 'Empty.csproj');
      fs.writeFileSync(project, EMPTY_PROJECT_XML, 'utf8');
      await pollUntil(() => spy.modes.length > 0, 'a new project rediscovers');
      await api.testController.whenIdle();
      assert.deepStrictEqual(discoveryTargets(), withProject, 'the new project is a target');
      assert.deepStrictEqual(errorRows(), [], 'and it lists its no tests without an error');

      const seen = spy.modes.length;
      fs.rmSync(project);
      await pollUntil(() => spy.modes.length > seen, 'a deleted project rediscovers');
      await api.testController.whenIdle();
      assert.deepStrictEqual(discoveryTargets(), both, 'the target goes with its project');
    } finally {
      spy.restore();
      emptyFolder(noProjectDir);
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(EXPECTED),
      'none of that disturbed the real folders',
    );
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
    // [TEST-MTP-ROUTING] a runner left with no id is not started: neither MTP
    // test was run or re-cached.
    await runAndAssertVerdicts(
      api,
      [VSTEST_PASS, VSTEST_FAIL],
      pairVerdicts(VSTEST_PASS, VSTEST_FAIL),
      [
        { id: MTP_PASS, why: 'MTP was not started' },
        { id: MTP_FAIL, why: 'for either test' },
      ],
    );

    // 2. A selection from the MTP folder only: its module must run it.
    await runAndAssertVerdicts(api, [MTP_PASS, MTP_FAIL], pairVerdicts(MTP_PASS, MTP_FAIL), [
      { id: VSTEST_PASS, why: 'VSTest not started' },
    ]);

    // 3. ONE selection spanning both runners: each half reaches its runner.
    const unselected = [VSTEST_PASS, MTP_FAIL].map((id) => api.testController.getResult(id));
    await runAndSettle(api, [VSTEST_FAIL, MTP_PASS]);
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
    const vstest = await runSingleAsserting(api, VSTEST_PASS, 'passed', 'VSTest lens run');
    // [TEST-STATUS-LENS] what the lens ran is what the cache — and so the lens — now shows …
    assert.deepStrictEqual(api.testController.getResult(VSTEST_PASS), vstest, 'the lens paints it');
    assert.equal(api.testController.getResult(MTP_PASS), mtpBeforeLens, 'MTP was not started');
    const mtp = await runSingleAsserting(api, MTP_FAIL, 'failed', 'MTP lens run');
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
      /** Run `Adds_TwoNumbers` alone, and assert the module is at least as new as the edit. */
      const runAloneAndAssertRebuilt = async (passed: boolean, why: string): Promise<void> => {
        await runAndAssertVerdicts(api, [MTP_PASS], [{ id: MTP_PASS, passed }]);
        assert.ok(mtimeOf(module) >= mtimeOf(source), why);
      };
      await runAloneAndAssertRebuilt(false, 'the module was rebuilt after the edit');
      assert.ok((cachedFor(api, MTP_PASS).message ?? '').includes('4'), 'expected 4, as edited');
      // `--filter-uid` ran the one selected test of the module, and no other.
      assert.equal(api.testController.getResult(MTP_FAIL), untouched, 'the other test stands');

      // 2. A selection spanning both folders sees the edit too, and the VSTest
      //    half is unaffected by it.
      await runAndAssertVerdicts(
        api,
        [VSTEST_PASS, MTP_PASS],
        pairVerdicts(VSTEST_PASS, MTP_PASS),
        [{ id: VSTEST_FAIL, why: 'VSTest ran its one' }],
      );

      // 3. Put it back: green again, so the rebuild tracks the source both ways.
      fs.writeFileSync(source, mtpSource(3), 'utf8');
      await runAloneAndAssertRebuilt(true, 'rebuilt after the second edit too');
    } finally {
      fs.writeFileSync(source, mtpSource(3), 'utf8');
    }
  });
});
