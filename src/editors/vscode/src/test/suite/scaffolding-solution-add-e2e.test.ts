// End-to-end coverage for the Solution Explorer "Add Project to Solution"
// context-menu path, issue #576.
//
// Three things are proven against the REAL extension, never hand-built stubs:
//   1. The manifest's view/item/context entries for sharplsp.addProjectToSolution
//      target the exact contextValues the live tree rows carry — the regression
//      that shipped in 0.33.0, where the command existed but no menu entry did.
//   2. Running the command from a REAL solution row wires a picked project into
//      an empty .slnx (`<Solution></Solution>`), verified by file contents.
//   3. Running it from a REAL project row lets the user pick a workspace
//      solution — or create a brand-new one right from the picker — so a
//      project with no solution above it never dead-ends.
//
// Implements [SE-SOLUTION-ADD-CONTEXT]. The `dotnet` CLI really runs, so
// timeouts follow the test-timeouts tiers. Artifacts written into the committed
// workspace folder are tracked and removed in teardown.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD_ADD_PROJECT_TO_SOLUTION } from '../../constants.js';
import { NodeType } from '../../tree-nodes';
import { addProjectToSolutionFile, createProject, findProjectFile } from '../../scaffolding.js';
import { activeExplorerProvider } from './explorer-kit';
import { sharpLspExtension } from './extension-manifest-kit';
import {
  createSolutionProjectPair,
  scaffoldName,
  trackSlnCandidates,
  waitForWorkspaceSolution,
  workspaceFolder,
} from './scaffolding-kit';
import {
  closeAllEditors,
  pollUntilResult,
  removeDirRecursive,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { ACTIVATION_MS, DOTNET_CLI_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

/** A Solution Explorer row, viewed through the fields the context menus key on. */
interface Row {
  readonly label?: string | { label: string };
  readonly contextValue?: string;
  readonly nodeType?: NodeType;
  readonly projectFilePath?: string;
  readonly children?: Row[];
}

/** The LIVE extension's exported Solution Explorer provider, as this suite drives it. */
interface LiveProvider {
  loadSolution(slnPath: string): Promise<void>;
  refresh(): Promise<void>;
  clear(): void;
  getChildren(element?: unknown): Row[] | undefined;
}

/** One entry of `contributes.menus.view/item/context` in the live manifest. */
interface MenuEntry {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

/** The live manifest's view/item/context entries for `command`. */
function contextMenuEntries(command: string): MenuEntry[] {
  const menus = (sharpLspExtension().packageJSON.contributes?.menus ?? {}) as Record<
    string,
    MenuEntry[]
  >;
  return (menus['view/item/context'] ?? []).filter((entry) => entry.command === command);
}

/** The text a tree row shows. */
function rowLabel(row: Row): string {
  return typeof row.label === 'string' ? row.label : (row.label?.label ?? '');
}

/** Load `slnPath` into the LIVE provider and wait until `ready` accepts its rows. */
async function loadRowsUntil(
  slnPath: string,
  ready: (rows: readonly Row[]) => boolean,
  what: string,
): Promise<Row[]> {
  const provider = activeExplorerProvider<Row>() as LiveProvider;
  await provider.loadSolution(slnPath);
  return await pollUntilResult(
    async () => provider.getChildren() ?? [],
    (rows) => ready(rows),
    LSP_RESPONSE_MS,
    100,
    what,
  );
}

/** The labels of the most recent QuickPick the stub harness recorded. */
function lastPickLabels(stubs: UiStubs): string[] {
  const items = stubs.log.quickPickItems[stubs.log.quickPickItems.length - 1] as
    { label: string }[] | undefined;
  return (items ?? []).map((item) => item.label);
}

/** The empty .slnx exactly as `dotnet new sln` leaves it — the #576 repro. */
const EMPTY_SLNX = '<Solution>\n</Solution>\n';

suite('Add Project to Solution — context rows (#576)', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  // Absolute paths created INSIDE the committed workspace folder — must be removed.
  let created: string[];

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    ({ tmpDir } = await setupLspTestSuite('sln-add-e2e'));
  });

  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  setup(async () => {
    await closeAllEditors();
    stubs = installUiStubs();
    created = [];
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
    // Clear the LIVE active solution so nothing leaks into other suites.
    try {
      (activeExplorerProvider<Row>() as LiveProvider).clear();
    } catch {
      // If the extension export is unavailable, there is nothing to reset.
    }
    for (const artifact of created) {
      try {
        removeDirRecursive(artifact);
      } catch {
        // Best-effort: never fail teardown over a stray temp file.
      }
    }
  });

  /** Register an artifact for guaranteed cleanup and return it. */
  function track(absPath: string): string {
    created.push(absPath);
    return absPath;
  }

  test('menu contributions target the contextValues live tree rows carry', async function () {
    this.timeout(ACTIVATION_MS);
    const fixtureSln = path.join(workspaceFolder(), 'TestFixtures.sln');

    // REAL rows from the REAL provider — the values VS Code matches `when`
    // clauses against when it decides what the context menu shows.
    const rows = await loadRowsUntil(
      fixtureSln,
      (roots) =>
        roots[0]?.contextValue === 'solution' &&
        (roots[0]?.children?.some((child) => child.contextValue === 'project') ?? false),
      'the fixture solution and project rows to load',
    );
    const solutionRow = rows[0];
    const projectRow = solutionRow?.children?.find(
      (child) => child.contextValue === 'project' && child.nodeType === NodeType.Project,
    );
    assert.ok(solutionRow, 'a solution row must exist');
    assert.strictEqual(solutionRow.nodeType, NodeType.Solution, 'the root row is the solution');
    assert.ok(projectRow, 'a project row must exist under the solution');

    // 0.33.0 shipped the command with NO menu entry: right-clicking either row
    // offered nothing. Each row's real contextValue must have its own entry.
    for (const row of [solutionRow, projectRow]) {
      const contextValue = row.contextValue ?? '';
      const matching = contextMenuEntries(CMD_ADD_PROJECT_TO_SOLUTION).filter((entry) =>
        entry.when?.includes(`viewItem == ${contextValue}`),
      );
      assert.strictEqual(
        matching.length,
        1,
        `exactly one ${CMD_ADD_PROJECT_TO_SOLUTION} entry for viewItem == ${contextValue}`,
      );
      assert.ok(
        matching[0]?.when?.includes('view == sharplsp.solutionExplorer'),
        'the entry must be scoped to the Solution Explorer view',
      );
      assert.strictEqual(matching[0]?.group, '2_solution@1', 'the entry keeps its group');
    }
  });

  test('a real solution row wires the picked project into an empty .slnx', async function () {
    this.timeout(DOTNET_CLI_MS);
    const folder = workspaceFolder();
    const projName = scaffoldName('EmptySlnProj');
    const projDir = track(path.join(folder, projName));
    await createProject(folder, projName, 'classlib');
    const projFile = findProjectFile(projDir, projName);
    assert.ok(projFile, 'the scaffolded .csproj must be locatable');

    const slnxName = scaffoldName('EmptySlnx');
    const slnxPath = track(path.join(folder, `${slnxName}.slnx`));
    fs.writeFileSync(slnxPath, EMPTY_SLNX);

    // The empty solution renders a solution row with no project rows under it —
    // the exact tree the #576 user right-clicks.
    const rows = await loadRowsUntil(
      slnxPath,
      (roots) => roots[0]?.contextValue === 'solution' && roots[0]?.projectFilePath === slnxPath,
      'the empty solution row to load',
    );
    const solutionRow = rows[0];
    assert.strictEqual(
      solutionRow?.children?.length ?? 0,
      0,
      'the empty solution starts with no project rows',
    );

    // Run the command FROM THE REAL ROW: the .csproj picker returns our project.
    stubs.queueOpenDialog([vscode.Uri.file(projFile)]).queueInfo(undefined);
    await vscode.commands.executeCommand(CMD_ADD_PROJECT_TO_SOLUTION, solutionRow);

    const slnxText = fs.readFileSync(slnxPath, 'utf-8');
    assert.ok(slnxText.includes('<Solution'), `still a .slnx document: ${slnxText}`);
    assert.ok(slnxText.includes('<Project'), `a Project element must land: ${slnxText}`);
    assert.ok(
      slnxText.includes(`${projName}.csproj`),
      `the empty .slnx must now reference the project: ${slnxText}`,
    );
    // A solution row fixes the target: one file dialog, no solution QuickPick.
    assert.strictEqual(
      stubs.log.quickPickItems.length,
      0,
      'no solution picker from a solution row',
    );
    const dialog = stubs.log.openDialogOptions[0];
    assert.ok(dialog, 'the project file picker must be shown');
    assert.strictEqual(dialog.openLabel, 'Add Existing Project');
    assert.ok(
      stubs.log.infoMessages.some((message) => message.includes('to solution')),
      'a success toast confirms the add ran',
    );

    // The command's refresh makes the live tree catch up: the once-empty
    // solution row now carries the added project row.
    await pollUntilResult(
      async () => (activeExplorerProvider<Row>() as LiveProvider).getChildren() ?? [],
      (roots) =>
        (roots[0]?.children ?? []).some(
          (child) =>
            child.contextValue === 'project' &&
            child.projectFilePath?.endsWith(`${projName}.csproj`),
        ),
      LSP_RESPONSE_MS,
      100,
      'the refreshed tree to show the added project row',
    );
  });

  test('a real project row adds to a picked solution or creates one', async function () {
    this.timeout(DOTNET_CLI_MS);
    const folder = workspaceFolder();
    const projName = scaffoldName('RowProj');
    const { slnPath, projFile } = await createSolutionProjectPair(
      folder,
      scaffoldName('RowSln'),
      projName,
    );
    track(slnPath);
    track(path.join(folder, projName));
    assert.ok(projFile, 'the scaffolded project must be locatable');
    // The project joins its own solution so it renders as a tree row.
    await addProjectToSolutionFile(slnPath, projFile);

    const rows = await loadRowsUntil(
      slnPath,
      (roots) =>
        (roots[0]?.children ?? []).some(
          (child) =>
            child.contextValue === 'project' &&
            child.projectFilePath?.endsWith(`${projName}.csproj`),
        ),
      'the project row of its own solution to load',
    );
    const projectRow = (rows[0]?.children ?? []).find((child) =>
      child.projectFilePath?.endsWith(`${projName}.csproj`),
    );
    assert.ok(projectRow, 'the project row must exist');
    assert.strictEqual(projectRow.contextValue, 'project');
    assert.strictEqual(projectRow.nodeType, NodeType.Project);

    // ── Interaction 1: pick an existing (empty) workspace solution ──
    const targetName = scaffoldName('PickTarget');
    const slnxPath = track(path.join(folder, `${targetName}.slnx`));
    fs.writeFileSync(slnxPath, EMPTY_SLNX);
    // Picker parity: the discovery glob must index the new .slnx first.
    await waitForWorkspaceSolution(`${targetName}.slnx`);

    stubs
      .queuePick((items) => (items as { path?: string }[]).find((item) => item.path === slnxPath))
      .queueInfo(undefined);
    await vscode.commands.executeCommand(CMD_ADD_PROJECT_TO_SOLUTION, projectRow);

    assert.ok(
      fs.readFileSync(slnxPath, 'utf-8').includes(`${projName}.csproj`),
      'the picked solution must gain the project',
    );
    assert.strictEqual(
      stubs.log.openDialogOptions.length,
      0,
      'a project row keeps its project: no file dialog',
    );
    const offered = lastPickLabels(stubs);
    assert.ok(
      offered.some((label) => label.includes(targetName)),
      `the picker must list the workspace solution: ${offered.join(', ')}`,
    );
    assert.ok(
      offered.some((label) => label.includes('Create New Solution')),
      `the picker must offer the create escape hatch (#576): ${offered.join(', ')}`,
    );

    // ── Interaction 2: create a brand-new solution from the picker ──
    const createdName = scaffoldName('CreatedSln');
    const { slnPath: createdSln, slnxPath: createdSlnx } = trackSlnCandidates(
      track,
      folder,
      createdName,
    );
    stubs
      .queuePick((items) =>
        (items as { label: string }[]).find((item) => item.label.includes('Create New Solution')),
      )
      .queueInput(createdName)
      .queueInfo(undefined);
    await vscode.commands.executeCommand(CMD_ADD_PROJECT_TO_SOLUTION, projectRow);

    const produced = [createdSlnx, createdSln].find((candidate) => fs.existsSync(candidate));
    assert.ok(produced, 'a brand-new solution must be created from the picker');
    assert.ok(
      fs.readFileSync(produced, 'utf-8').includes(`${projName}.csproj`),
      'the created solution must reference the project',
    );
    // The created solution becomes the loaded one: its rows appear, carrying
    // the project — the explorer never leaves the user on the old tree.
    const live = activeExplorerProvider<Row>() as LiveProvider;
    const freshRows = await pollUntilResult(
      async () => live.getChildren() ?? [],
      (roots) =>
        rowLabel(roots[0] ?? {}).includes(createdName) &&
        (roots[0]?.children ?? []).some(
          (child) =>
            child.contextValue === 'project' &&
            child.projectFilePath?.endsWith(`${projName}.csproj`),
        ),
      SIDECAR_COLD_MS,
      100,
      'the freshly created solution to load with its project row',
    );
    assert.strictEqual(freshRows[0]?.contextValue, 'solution', 'the new root is the solution row');
    assert.ok(
      stubs.log.infoMessages.some((message) => message.includes('to solution')),
      'a success toast confirms each add ran',
    );
  });
});
