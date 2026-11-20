/**
 * The Testing view shows the tests of the solution the loader CHOSE — never a
 * stale one, never nothing. One user journey over two real solutions (an F#
 * xUnit one and a C# xUnit one) drives the REAL solution loader into the REAL
 * Solution Explorer and Test Explorer: a pick, a window reload, a configured
 * `csharp.solution_path`, a stale one, a deliberate switch and a dismissed pick.
 * After each, the tree holds EXACTLY that solution's tests, under its assembly.
 * Implements [SE-SOLUTION], [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH],
 * [TEST-DISCOVERY-FQN].
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { type SolutionLoader, solutionLoader } from '../../solution-load.js';
import type { SharpLspClient } from '../../client';
import { createSolution, projectXml, warmDiscovery, writeProject } from './dotnet-project-kit';
import { configurationClient, NO_COMPILERS, WorkspaceMemory } from './solution-loader-kit';
import {
  activateTestExplorer,
  clearTestTree,
  collectLeafIds,
  DISCOVERY_SETTLE_MS,
  pollForIds,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { assertExactLeafSet, assertSoleAssemblyRoot } from './test-explorer-assert-kit';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { CS, FS_FIXTURE, XUNIT_PAIR_IDS } from './test-explorer-xunit-pair';
import { installUiStubs, type UiStubs } from './ui-stubs';
import type { FixtureProject } from './test-explorer-fixtures';

/** The F# solution's tests (listed first: F# leads) and the C# solution's. */
const FS_TESTS = XUNIT_PAIR_IDS.filter((id) => id.startsWith('Fs.'));
const CS_TESTS = XUNIT_PAIR_IDS.filter((id) => id.startsWith('Cs.'));
/** The workspace-storage key the loader remembers the solution under. */
const REMEMBERED = 'sharplsp.solution';

/** One fixture solution: its file, its single test project and its tests. */
interface Fixture {
  readonly sln: string;
  readonly project: string;
  readonly tests: readonly string[];
}

async function fixtureSolution(
  root: string,
  name: string,
  fixture: FixtureProject,
  tests: readonly string[],
): Promise<Fixture> {
  const dir = path.join(root, name, fixture.projectName);
  const projectDir = writeProject(
    dir,
    fixture.projectFileName,
    // F# compiles in declared order, so its one source is listed; C# globs its own.
    projectXml(
      fixture.packages,
      ...(fixture.language === 'fsharp' ? [fixture.sourceFileName] : []),
    ),
    fixture.sourceFileName,
    fixture.source,
  );
  const sln = await createSolution(path.join(root, name), name, [projectDir]);
  await warmDiscovery(sln, root);
  return { sln, project: fixture.projectName, tests };
}

/** The QuickPick item a user clicks for `sln`, shaped as the picker offers it. */
function pickOf(sln: string): () => unknown {
  return () => ({
    label: path.basename(sln),
    description: sln,
    solution: { path: sln, name: path.basename(sln) },
  });
}

suite('Test Explorer follows the solution the loader chooses [SE-SOLUTION]', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let fsharp: Fixture, csharp: Fixture;
  let stubs: UiStubs;
  let client: SharpLspClient;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-choice-'));
    fs.writeFileSync(path.join(root, 'sharplsp.toml'), NO_COMPILERS);
    fsharp = await fixtureSolution(root, 'FsSuite', FS_FIXTURE, FS_TESTS);
    csharp = await fixtureSolution(root, 'CsSuite', CS, CS_TESTS);
    client = configurationClient(root);
    await client.start();
    // The user opens the Testing view: that, not a load, engages discovery.
    await vscode.commands.executeCommand('workbench.view.testing.focus');
    await api.testController.activateAndDiscover();
    await api.testController.whenIdle();
  });

  setup(() => {
    stubs = installUiStubs();
  });

  teardown(() => {
    stubs.restore();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    if (client.isRunning()) await client.stop();
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  /** A fresh activation over `memory`, driving the live explorer and Test Explorer. */
  const activation = (memory: WorkspaceMemory, withClient = false): SolutionLoader =>
    solutionLoader({
      client: () => (withClient ? client : undefined),
      explorer: () => api.explorerProvider,
      memory,
    });

  /** Settle discovery, then assert the tree is EXACTLY `shown` with none of `hidden`. */
  async function assertShows(shown: Fixture, hidden: Fixture, why: string): Promise<void> {
    const ids = await pollForIds(
      api.testController,
      (seen) =>
        shown.tests.every((id) => seen.includes(id)) &&
        !hidden.tests.some((id) => seen.includes(id)),
    );
    await api.testController.whenIdle();
    assert.ok(ids.length > 0, `${why}: the Testing view is never left empty`);
    assertExactLeafSet(api.testController, shown.tests, why);
    assertSoleAssemblyRoot(api.testController, shown.project, why);
    for (const stale of hidden.tests) {
      assert.ok(
        !collectLeafIds(api.testController.items).includes(stale),
        `${why}: no stale ${stale}`,
      );
    }
  }

  /**
   * The window reloads: nothing is loaded, so the Testing view holds no test of
   * either solution — at most the row explaining the folder's several projects.
   */
  async function reloadWindow(): Promise<void> {
    await clearTestTree(api);
    const leaves = collectLeafIds(api.testController.items);
    for (const id of [...fsharp.tests, ...csharp.tests]) {
      assert.ok(!leaves.includes(id), `a reload starts with no ${id}`);
    }
    assert.deepStrictEqual(
      leaves.filter((id) => !id.startsWith('discovery-error:')),
      [],
      'a reload starts with explanation rows only, never a test',
    );
  }

  function setConfigured(entry: string): void {
    fs.writeFileSync(
      path.join(root, 'sharplsp.toml'),
      `${NO_COMPILERS}solution_path = ${JSON.stringify(entry)}\n`,
    );
  }

  test('pick, reload, configure, go stale, switch and dismiss: the tree is always the chosen solution', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const memory = new WorkspaceMemory();
    await reloadWindow();

    // 1 — first open: the user picks the F# solution; its tests, and only those, appear.
    stubs.queuePick(pickOf(fsharp.sln));
    await activation(memory).pickAndLoad();
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'the first open asks once');
    assert.strictEqual(memory.get(REMEMBERED), fsharp.sln, 'the pick is remembered');
    await assertShows(fsharp, csharp, 'the picked F# solution');

    // 2 — the window reloads: the remembered F# solution comes back without asking.
    await reloadWindow();
    await activation(memory).selectAndLoad();
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'a reload never asks');
    await assertShows(fsharp, csharp, 'the remembered F# solution after a reload');

    // 3 — sharplsp.toml names the C# solution: it beats the remembered F# one, unasked.
    setConfigured(path.relative(root, csharp.sln));
    await reloadWindow();
    await activation(memory, true).selectAndLoad();
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'a configured solution never asks');
    assert.strictEqual(memory.get(REMEMBERED), csharp.sln, 'and becomes the remembered one');
    await assertShows(csharp, fsharp, 'the configured C# solution');

    // 4 — the configured file is gone: the remembered C# solution stands in, unasked.
    setConfigured('Gone/Gone.sln');
    await reloadWindow();
    await activation(memory, true).selectAndLoad();
    assert.strictEqual(
      stubs.log.quickPickItems.length,
      1,
      'a stale setting with a memory never asks',
    );
    await assertShows(csharp, fsharp, 'the remembered C# solution behind a stale setting');

    // 5 — Select Solution switches to F# on purpose: C#'s tests leave, F#'s arrive.
    stubs.queuePick(pickOf(fsharp.sln));
    await activation(memory, true).pickAndLoad();
    assert.strictEqual(stubs.log.quickPickItems.length, 2, 'Select Solution always asks');
    assert.strictEqual(memory.get(REMEMBERED), fsharp.sln, 'the switch is remembered');
    await assertShows(fsharp, csharp, 'a deliberate switch from C# to F#');

    // 6 — Select Solution again, dismissed: the F# tests stay; the view never empties.
    stubs.queuePick(undefined);
    await activation(memory, true).pickAndLoad();
    assert.strictEqual(stubs.log.quickPickItems.length, 3, 'the dismissed picker was shown');
    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_SETTLE_MS));
    assert.strictEqual(memory.get(REMEMBERED), fsharp.sln, 'a dismissal forgets nothing');
    await assertShows(fsharp, csharp, 'a dismissed pick keeps the loaded solution');
  });
});
