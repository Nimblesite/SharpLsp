// Coarse end-to-end tests for the scaffolding commands.
//
// These drive the REAL `sharplsp.newFile` / `sharplsp.newProject` /
// `sharplsp.newSolution` / `sharplsp.addProjectToSolution` commands through the
// UI-stub harness (queueing the same QuickPick / InputBox / message-box answers a
// user would click), then assert on the real side effects: files and directories
// created on disk by `dotnet new`, documents opened in the editor, and projects
// wired into solution files. The `dotnet` CLI really runs, so timeouts are
// generous. Pure helpers (newSolutionArgs / newProjectArgs / findProjectFile /
// generateFileContent) are asserted inside the same flows that exercise the
// commands, so the contract and the live behaviour stay in lock-step.
//
// CLEANUP CONTRACT: the scaffolding commands write into the *committed* workspace
// folder (test-fixtures/workspace). Every artifact created in that folder is
// tracked in `created` and removed in teardown, so the fixture is never polluted.
// Unique `ScaffTmp_<random>` names guarantee we never collide with committed files.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  setupLspTestSuite,
  teardownLspTestSuite,
  closeAllEditors,
  EXTENSION_ID,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';
import {
  newSolutionArgs,
  newProjectArgs,
  createSolution,
  createProject,
  addProjectToSolutionFile,
  findProjectFile,
  generateFileContent,
} from '../../scaffolding.js';

const CMD_NEW_FILE = 'sharplsp.newFile';
const CMD_NEW_PROJECT = 'sharplsp.newProject';
const CMD_NEW_SOLUTION = 'sharplsp.newSolution';
const CMD_ADD_PROJECT_TO_SOLUTION = 'sharplsp.addProjectToSolution';
const CMD_OPEN_SOLUTION = 'sharplsp.openSolution';

/**
 * Handle to the LIVE Solution Explorer provider exported by the bundled extension.
 *
 * CRITICAL: test files import `../../*.js` which resolve to `out/*.js`, but the
 * RUNNING extension is bundled into `dist/extension.js` (esbuild inlines local
 * `src/`). A test-side `import * as state` is therefore a DIFFERENT module instance
 * than the one the live commands read — writing to it has NO effect on command
 * behaviour. To control/observe the live solution selection we must go through the
 * exported provider (`clear()` / `loadSolution()`) and the registered
 * `sharplsp.openSolution` command, which mutate the bundled state that the dist
 * `pickSolutionFile` actually consults.
 */
interface ExplorerApi {
  explorerProvider: {
    loadSolution(slnPath: string): Promise<void>;
    refresh(): Promise<void>;
    clear(): void;
  };
}

function getProvider(): ExplorerApi['explorerProvider'] {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (ext === undefined) throw new Error('Extension not found');
  const api = ext.exports as ExplorerApi | undefined;
  if (api?.explorerProvider === undefined) {
    throw new Error('Extension does not export explorerProvider');
  }
  return api.explorerProvider;
}

/** Resolve the committed workspace folder the scaffolding commands write into. */
function workspaceFolder(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder !== undefined && folder !== '', 'a workspace folder must be open');
  return folder;
}

/** A short, collision-proof token for temp scaffolding names. */
function uniqueToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Wait until `vscode.workspace.findFiles` indexes a project file written to disk
 * outside the workspace edit API (e.g. by `dotnet new`). The file watcher may lag
 * a beat behind the disk write, so we poll briefly before driving a command that
 * relies on workspace discovery.
 */
async function waitForWorkspaceProject(basename: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const uris = await vscode.workspace.findFiles('**/*.{csproj,fsproj}', '**/node_modules/**');
    if (uris.some((uri) => uri.fsPath.endsWith(basename))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

suite('Scaffolding E2E (drive real commands)', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  // Absolute paths created INSIDE the committed workspace folder — must be removed.
  let created: string[];

  suiteSetup(async function () {
    this.timeout(60_000);
    ({ tmpDir } = await setupLspTestSuite('scaffold-e2e'));
  });

  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  setup(async () => {
    // Start from a clean UI: close editors and dismiss any Output/Trace panel a
    // prior suite left focused, so window.activeTextEditor reflects the file each
    // newFile test opens (prevents the cross-test focus-race flakiness).
    await closeAllEditors();
    stubs = installUiStubs();
    created = [];
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
    // Clear the LIVE active solution so a solution we loaded/created here never
    // leaks into other suites. clear() drives the bundled state.solutionPath to
    // undefined — the test-side `state` import cannot.
    try {
      getProvider().clear();
    } catch {
      // If the extension export is unavailable, there is nothing to reset.
    }
    // Remove every artifact we wrote into the committed workspace folder.
    for (const artifact of created) {
      try {
        fs.rmSync(artifact, { recursive: true, force: true });
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

  // ── sharplsp.newFile ──────────────────────────────────────────────
  //
  // Cover EVERY FILE_TEMPLATE so each branch of generateFileContent runs, and
  // assert the on-disk content matches the pure generator exactly. Also drive the
  // cancel path (no template picked → no file written, no editor opened).

  const FILE_CASES: { template: string; snippet: string }[] = [
    { template: 'Class', snippet: 'class' },
    { template: 'Interface', snippet: 'interface' },
    { template: 'Enum', snippet: 'enum' },
    { template: 'Struct', snippet: 'struct' },
    { template: 'Record', snippet: 'record' },
  ];

  for (const { template, snippet } of FILE_CASES) {
    test(`newFile creates a ${template} matching generateFileContent and opens it`, async function () {
      this.timeout(30_000);
      const folder = workspaceFolder();
      const name = `ScaffTmp_${template}_${uniqueToken()}`;
      const filePath = track(path.join(folder, `${name}.cs`));

      // The command shows a FILE_TEMPLATES QuickPick, then a name InputBox.
      stubs.queuePick(template).queueInput(name);
      await vscode.commands.executeCommand(CMD_NEW_FILE);

      // newFile uses WorkspaceEdit.createFile + insert: the new file is opened as
      // the active editor and the generated content lives in the UNSAVED buffer
      // (the on-disk file is still empty until saved). Assert the live document
      // text first, then persist and re-read disk.
      const expected = generateFileContent(snippet, name);
      const active = vscode.window.activeTextEditor;
      assert.ok(active, 'an editor must be active after newFile');
      assert.strictEqual(active.document.uri.fsPath, filePath, 'the new file must be opened');
      assert.strictEqual(
        active.document.getText(),
        expected,
        'editor buffer must match generateFileContent',
      );

      // Persist the buffer, then the on-disk content must equal the generated body.
      const saved = await active.document.save();
      assert.ok(saved, 'the new document must save successfully');
      assert.ok(fs.existsSync(filePath), `${name}.cs should exist on disk after save`);
      const onDisk = fs.readFileSync(filePath, 'utf-8');
      assert.strictEqual(onDisk, expected, 'saved file content must match generateFileContent');

      // Pin the per-snippet keyword so each switch branch is asserted distinctly.
      if (snippet === 'record') {
        assert.ok(onDisk.includes(`public record ${name};`));
        assert.ok(onDisk.endsWith(';\n'), 'record has no brace body');
      } else {
        assert.ok(onDisk.includes(`public ${snippet} ${name}`));
        assert.ok(onDisk.includes('{\n}\n'), `${snippet} must have a brace body`);
      }
      assert.ok(onDisk.startsWith('namespace MyNamespace;\n\n'));

      // The QuickPick was shown and offered the five built-in templates.
      assert.ok(stubs.log.quickPickItems.length >= 1, 'a file-type QuickPick was shown');
      const labels = (stubs.log.quickPickItems[0] as { label: string }[]).map((i) => i.label);
      assert.deepStrictEqual(labels, ['Class', 'Interface', 'Enum', 'Struct', 'Record']);
      // The name prompt was shown exactly once.
      assert.strictEqual(stubs.log.inputBoxOptions.length, 1, 'one name prompt was shown');
    });
  }

  test('newFile cancelled at the template picker writes no file and opens nothing', async function () {
    this.timeout(20_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_Cancelled_${uniqueToken()}`;
    const filePath = track(path.join(folder, `${name}.cs`));
    const before = vscode.window.activeTextEditor?.document.uri.fsPath;

    // queuePick with no selector → QuickPick returns undefined → command bails.
    stubs.queueInput(name); // queued but never consumed because the pick cancels first.
    await vscode.commands.executeCommand(CMD_NEW_FILE);

    assert.ok(!fs.existsSync(filePath), 'no file may be created when the picker is cancelled');
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      before,
      'no new editor may be opened on cancel',
    );
    // The picker was shown but the name prompt was never reached.
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'the template picker was shown');
    assert.strictEqual(stubs.log.inputBoxOptions.length, 0, 'the name prompt was NOT reached');
  });

  test('newFile cancelled at the name prompt (empty name) writes no file', async function () {
    this.timeout(20_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_Empty_${uniqueToken()}`;
    // An empty string name is the documented cancel condition (`name === ''`).
    const filePath = track(path.join(folder, `${name}.cs`));

    stubs.queuePick('Class').queueInput('');
    await vscode.commands.executeCommand(CMD_NEW_FILE);

    assert.ok(!fs.existsSync(filePath), 'empty name must abort file creation');
    // Empty-name path is reached: both prompts ran.
    assert.strictEqual(stubs.log.quickPickItems.length, 1);
    assert.strictEqual(stubs.log.inputBoxOptions.length, 1);
  });

  // ── newSolutionArgs / newProjectArgs pure vectors (asserted alongside flows) ──

  test('newSolutionArgs and newProjectArgs build the dotnet vectors the commands rely on', () => {
    assert.deepStrictEqual(newSolutionArgs('Sln', '/work'), [
      'new',
      'sln',
      '--name',
      'Sln',
      '--output',
      '/work',
    ]);

    const csharp = newProjectArgs('console', 'Api', '/work');
    assert.deepStrictEqual(csharp, [
      'new',
      'console',
      '--name',
      'Api',
      '--output',
      path.join('/work', 'Api'),
    ]);
    assert.ok(!csharp.includes('--language'), 'C# must not pass --language');

    const fsharp = newProjectArgs('classlib', 'Core', '/work', 'F#');
    assert.strictEqual(fsharp.length, 8);
    assert.deepStrictEqual(fsharp.slice(-2), ['--language', 'F#']);

    // generateFileContent default branch (class) is the fallback for unknown snippets.
    assert.strictEqual(
      generateFileContent('totally-unknown', 'Fallback'),
      'namespace MyNamespace;\n\npublic class Fallback\n{\n}\n',
    );
  });

  // ── sharplsp.newProject ───────────────────────────────────────────
  //
  // Drive a real `dotnet new` for a C# template AND an F# template, asserting the
  // project directory and .csproj/.fsproj exist (findProjectFile locates them).
  // The workspace already contains TWO solutions (TestFixtures.sln + .slnx), so
  // resolveTargetSolution returns undefined and the project is NOT auto-added —
  // exactly the behaviour we assert (no throw, project stands alone).

  test('newProject scaffolds a real C# console project the workspace folder', async function () {
    this.timeout(60_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_Cs_${uniqueToken()}`;
    const projDir = track(path.join(folder, name));

    // PROJECT_TEMPLATES QuickPick → 'Console App', then a project-name InputBox.
    stubs.queuePick('Console App').queueInput(name).queueInfo(undefined);
    await vscode.commands.executeCommand(CMD_NEW_PROJECT);

    assert.ok(fs.existsSync(projDir), 'the project directory must be created');
    const projFile = findProjectFile(projDir, name);
    assert.ok(projFile, 'a C# project file must be found');
    assert.ok(projFile.endsWith(`${name}.csproj`), 'the project file must be a .csproj');
    assert.ok(fs.existsSync(projFile), 'the located project file must exist on disk');
    // No F# project file should appear for a C# template.
    assert.strictEqual(fs.existsSync(path.join(projDir, `${name}.fsproj`)), false);

    // The template QuickPick was offered with both C# and F# entries.
    const labels = (stubs.log.quickPickItems[0] as { label: string }[]).map((i) => i.label);
    assert.ok(labels.includes('Console App'));
    assert.ok(
      labels.some((l) => l.startsWith('F#')),
      'F# templates must be offered',
    );
  });

  test('newProject scaffolds a real F# class library (--language branch)', async function () {
    this.timeout(60_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_Fs_${uniqueToken()}`;
    const projDir = track(path.join(folder, name));

    stubs.queuePick('F# Class Library').queueInput(name).queueInfo(undefined);
    await vscode.commands.executeCommand(CMD_NEW_PROJECT);

    assert.ok(fs.existsSync(projDir), 'the F# project directory must be created');
    const projFile = findProjectFile(projDir, name);
    assert.ok(projFile?.endsWith(`${name}.fsproj`), 'an F# .fsproj must be found');
    assert.strictEqual(fs.existsSync(path.join(projDir, `${name}.csproj`)), false);
  });

  test('newProject cancels cleanly when no template is picked', async function () {
    this.timeout(20_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_NoTpl_${uniqueToken()}`;
    const projDir = track(path.join(folder, name));

    // No queuePick → the template QuickPick returns undefined → command bails.
    stubs.queueInput(name);
    await vscode.commands.executeCommand(CMD_NEW_PROJECT);

    assert.strictEqual(fs.existsSync(projDir), false, 'no project dir on template cancel');
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'the template picker was shown');
    assert.strictEqual(stubs.log.inputBoxOptions.length, 0, 'the name prompt was NOT reached');
  });

  test('newProject cancels when the project name is empty', async function () {
    this.timeout(20_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_EmptyName_${uniqueToken()}`;
    const projDir = track(path.join(folder, name));

    stubs.queuePick('Class Library').queueInput('');
    await vscode.commands.executeCommand(CMD_NEW_PROJECT);

    assert.strictEqual(fs.existsSync(projDir), false, 'no project dir when name is empty');
    assert.strictEqual(stubs.log.inputBoxOptions.length, 1, 'the name prompt WAS reached');
  });

  // ── sharplsp.newSolution ──────────────────────────────────────────

  test('newSolution creates a real solution and declines the first-project offer', async function () {
    this.timeout(60_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_Sln_${uniqueToken()}`;
    // The SDK chooses .sln or .slnx — track both candidates so cleanup is total.
    track(path.join(folder, `${name}.sln`));
    track(path.join(folder, `${name}.slnx`));

    // newSolution opens the new solution (CMD_OPEN_SOLUTION → loadSolution sets the
    // bundled solutionPath); teardown's getProvider().clear() resets it afterwards.

    // Solution-name InputBox, then "Add a project now?" → click 'Later' to decline.
    stubs.queueInput(name).queueInfo('Later');
    await vscode.commands.executeCommand(CMD_NEW_SOLUTION);

    // Exactly one of the two candidate solution files must now exist.
    const slnxPath = path.join(folder, `${name}.slnx`);
    const slnPath = path.join(folder, `${name}.sln`);
    const producedPath = fs.existsSync(slnxPath)
      ? slnxPath
      : fs.existsSync(slnPath)
        ? slnPath
        : undefined;
    assert.ok(producedPath, 'a .sln or .slnx solution file must be created');
    assert.match(path.basename(producedPath), new RegExp(`^${name}\\.slnx?$`));

    // The "Add a project now?" prompt was shown.
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('Add a project now?')),
      'the first-project offer must be shown',
    );
  });

  test('newSolution accepts the first-project offer and wires the project into the solution', async function () {
    this.timeout(90_000);
    const folder = workspaceFolder();
    const slnName = `ScaffTmp_SlnAdd_${uniqueToken()}`;
    const projName = `ScaffTmp_FirstProj_${uniqueToken()}`;
    track(path.join(folder, `${slnName}.sln`));
    track(path.join(folder, `${slnName}.slnx`));
    track(path.join(folder, projName));

    // newSolution opens the new solution (sets the bundled solutionPath);
    // teardown's getProvider().clear() resets it afterwards.

    // Solution name → 'Add Project' → project template → project name → final toast.
    stubs
      .queueInput(slnName, projName)
      .queueInfo('Add Project', undefined)
      .queuePick('Class Library');
    await vscode.commands.executeCommand(CMD_NEW_SOLUTION);

    const slnxPath = path.join(folder, `${slnName}.slnx`);
    const slnPath = path.join(folder, `${slnName}.sln`);
    const producedSln = fs.existsSync(slnxPath) ? slnxPath : slnPath;
    assert.ok(fs.existsSync(producedSln), 'the solution file must exist');

    // The project was created and added to the brand-new solution (explicit-solution path).
    const projDir = path.join(folder, projName);
    const projFile = findProjectFile(projDir, projName);
    assert.ok(projFile?.endsWith(`${projName}.csproj`), 'the first project must be created');

    const slnText = fs.readFileSync(producedSln, 'utf-8');
    assert.ok(
      slnText.includes(`${projName}.csproj`),
      'the new solution must reference the first project',
    );
  });

  test('newSolution is cancelled by an empty solution name (no solution created)', async function () {
    this.timeout(20_000);
    const folder = workspaceFolder();
    const name = `ScaffTmp_SlnCancel_${uniqueToken()}`;
    track(path.join(folder, `${name}.sln`));
    track(path.join(folder, `${name}.slnx`));

    stubs.queueInput('');
    await vscode.commands.executeCommand(CMD_NEW_SOLUTION);

    assert.strictEqual(fs.existsSync(path.join(folder, `${name}.sln`)), false);
    assert.strictEqual(fs.existsSync(path.join(folder, `${name}.slnx`)), false);
    // The name prompt was shown but the first-project offer was never reached.
    assert.strictEqual(stubs.log.inputBoxOptions.length, 1, 'name prompt was shown');
    assert.ok(
      !stubs.log.infoMessages.some((m) => m.includes('Add a project now?')),
      'the first-project offer must NOT appear when cancelled',
    );
  });

  // ── sharplsp.addProjectToSolution ─────────────────────────────────
  //
  // Build a throwaway solution + project in a temp dir (so addProjectToSolutionFile
  // can be asserted in isolation), then drive the command: it discovers project
  // files across the workspace, we pick ours, and pick the target solution. The
  // workspace has multiple solutions, so a solution QuickPick is shown too.

  test('addProjectToSolution wires the picked project into the picked solution', async function () {
    this.timeout(90_000);
    const folder = workspaceFolder();
    const projName = `ScaffTmp_AddProj_${uniqueToken()}`;
    const slnName = `ScaffTmp_AddSln_${uniqueToken()}`;

    // Create a real solution + project inside the workspace via the pure helpers.
    const slnPath = await createSolution(folder, slnName);
    track(slnPath);
    const projDir = await createProject(folder, projName, 'classlib');
    track(projDir);
    const projFile = findProjectFile(projDir, projName);
    assert.ok(projFile, 'the project file must be locatable before adding it');

    // Ensure NO active solution is pinned so the dist pickSolutionFile shows the
    // solution QuickPick (the workspace has multiple solutions). Driving the LIVE
    // provider's clear() resets the bundled state.solutionPath — a test-side
    // `state` import cannot. Reset again in teardown.
    getProvider().clear();

    // The workspace index must see the freshly-written project before the command runs.
    await waitForWorkspaceProject(`${projName}.csproj`);

    // The command finds *.csproj/*.fsproj across the workspace → pick ours by name;
    // then pickSolutionFile shows a QuickPick (multiple solutions) → pick ours.
    stubs
      .queuePick(
        (items) =>
          (items as { label: string; uri: vscode.Uri }[]).find((i) =>
            i.uri.fsPath.endsWith(`${projName}.csproj`),
          ),
        (items) => (items as { label: string; path: string }[]).find((i) => i.path === slnPath),
      )
      .queueInfo(undefined);
    await vscode.commands.executeCommand(CMD_ADD_PROJECT_TO_SOLUTION);

    // addProjectToSolutionFile ran: the solution now references the project (no throw).
    const slnText = fs.readFileSync(slnPath, 'utf-8');
    assert.ok(
      slnText.includes(`${projName}.csproj`),
      'the solution must reference the added project',
    );
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('to solution')),
      'a success toast confirms the add ran',
    );
  });

  test('addProjectToSolution uses the active solution selection without a second pick', async function () {
    this.timeout(90_000);
    const folder = workspaceFolder();
    const projName = `ScaffTmp_AddProj2_${uniqueToken()}`;
    const slnName = `ScaffTmp_AddSln2_${uniqueToken()}`;

    const slnPath = await createSolution(folder, slnName);
    track(slnPath);
    const projDir = await createProject(folder, projName, 'classlib');
    track(projDir);

    // Pin the active solution via the LIVE command so the dist pickSolutionFile
    // short-circuits to it (no solution QuickPick). This drives the bundled
    // state.solutionPath — the only instance the dist command reads. Reset in
    // teardown via getProvider().clear().
    await vscode.commands.executeCommand(CMD_OPEN_SOLUTION, slnPath);

    // The workspace index must see the freshly-written project before the command runs.
    await waitForWorkspaceProject(`${projName}.csproj`);

    stubs
      .queuePick((items) =>
        (items as { label: string; uri: vscode.Uri }[]).find((i) =>
          i.uri.fsPath.endsWith(`${projName}.csproj`),
        ),
      )
      .queueInfo(undefined);
    await vscode.commands.executeCommand(CMD_ADD_PROJECT_TO_SOLUTION);

    const slnText = fs.readFileSync(slnPath, 'utf-8');
    assert.ok(slnText.includes(`${projName}.csproj`), 'the active solution must gain the project');
    // Only ONE QuickPick (the project picker) — the active solution was taken from
    // the bundled state, so pickSolutionFile never prompted for a solution.
    assert.strictEqual(
      stubs.log.quickPickItems.length,
      1,
      'no solution QuickPick when a solution is already active',
    );
  });

  // ── findProjectFile present/absent (asserted directly) ────────────

  test('findProjectFile locates a real project and returns undefined when absent', async function () {
    this.timeout(60_000);
    // Use an isolated temp dir so this assertion never touches the workspace fixture.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-scaffold-find-'));
    try {
      assert.strictEqual(findProjectFile(isolated, 'Nope'), undefined, 'absent → undefined');

      const projDir = await createProject(isolated, 'Found', 'classlib');
      const located = findProjectFile(projDir, 'Found');
      assert.ok(located, 'present → a project path is returned');
      assert.ok(located.endsWith('Found.csproj'), 'present → the .csproj path');
      assert.ok(fs.existsSync(located), 'the located path must exist on disk');

      // A throwaway solution wires the project — exercises addProjectToSolutionFile too.
      const slnPath = await createSolution(isolated, 'FindSln');
      await addProjectToSolutionFile(slnPath, located);
      assert.ok(fs.readFileSync(slnPath, 'utf-8').includes('Found.csproj'));
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});
