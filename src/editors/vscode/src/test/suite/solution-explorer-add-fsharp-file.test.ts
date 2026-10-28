// E2E for "Add F# Source File" (GitHub #493) — [SE-ADD-FILE-COMMAND].
//
// F# compile ORDER matters, so this suite asserts the FULL loop, not just file
// creation: the command creates the .fs (and optionally the .fsi first),
// the host inserts the <Compile> item at the requested position through the C#
// sidecar's MSBuild DOM ([SE-ADD-FILE-REQUEST]), and the F# compiler then OWNS
// the new file after the project reloads — proven with real FCS hover and
// document symbols, never mocks.
//
// Each test builds a real F# project (fsproj + sources + sln) INSIDE the
// committed workspace folder so the host's watchers and sidecars see it, loads
// it into the Solution Explorer, and drives the real command through the tree
// nodes with UI stubs. F# first: this capability has no C# counterpart yet.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  pollProvider,
  removeDirRecursive,
  requireWorkspaceRoot,
} from './test-helpers';
import { hoverText, pollHover } from './fsharp-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { pollTreeFor } from './explorer-kit';
import { explorer, projectNode, symbolNodeIn } from './fsharp-project-tree-kit';
import { compileIncludes } from './project-xml-kit';
import { useLspTestSuite } from './lsp-suite-kit';
import { COMMAND_MS, FAST_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';
import {
  compileIncludeOf,
  fsharpFileContent,
  fsharpProjectOfNode,
  pairInsertOrder,
} from '../../add-source-file.js';

const CMD_ADD_FS_FILE = 'sharplsp.addFSharpSourceFile';

function uniqueToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** The fsproj text exactly as `dotnet new console --language F#` shapes it. */
function fsprojText(project: string): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '',
    '  <PropertyGroup>',
    '    <OutputType>Library</OutputType>',
    '    <TargetFramework>net10.0</TargetFramework>',
    '  </PropertyGroup>',
    '',
    '  <ItemGroup>',
    `    <Compile Include="${project}Domain.fs" />`,
    `    <Compile Include="${project}Main.fs" />`,
    '  </ItemGroup>',
    '',
    '</Project>',
    '',
  ].join('\n');
}

/**
 * Write a real F# project (explicit Compile order, entry-ish file last) plus a
 * solution naming it, inside the workspace so host watchers and sidecars see it.
 */
function writeFSharpProject(
  root: string,
  project: string,
): {
  slnPath: string;
  projDir: string;
  fsprojPath: string;
} {
  const projDir = path.join(root, project);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, `${project}Domain.fs`),
    `module ${project}Domain\n\nlet answer = 42\n`,
  );
  fs.writeFileSync(
    path.join(projDir, `${project}Main.fs`),
    `module ${project}Main\n\nlet double x = x * 2\n`,
  );
  const fsprojPath = path.join(projDir, `${project}.fsproj`);
  fs.writeFileSync(fsprojPath, fsprojText(project));
  const slnPath = path.join(root, `${project}.sln`);
  const entry =
    'Project("{F184B08F-C81C-45F6-A57F-5ABD9991F28F}") = ' +
    `"${project}", "${project}/${project}.fsproj", "{00000000-0000-0000-0000-000000000001}"`;
  fs.writeFileSync(
    slnPath,
    [
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      entry,
      'EndProject',
      'Global',
      'EndGlobal',
    ].join('\n'),
  );
  return { slnPath, projDir, fsprojPath };
}

suite('Solution Explorer — Add F# Source File (#493, [SE-ADD-FILE])', () => {
  useLspTestSuite('add-fs-file-');
  let stubs: UiStubs;
  let created: string[];

  setup(() => {
    stubs = installUiStubs();
    created = [];
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
    try {
      explorer().clear();
    } catch {
      /* best-effort reset of the live solution state */
    }
    for (const artifact of created) {
      try {
        removeDirRecursive(artifact);
      } catch {
        /* never fail teardown over a stray temp dir */
      }
    }
  });

  /** Create + load a fresh F# project and wait for its node in the tree. */
  async function loadProject(): Promise<{ project: string; fsprojPath: string; projDir: string }> {
    const project = `AddFs${uniqueToken()}`;
    const root = requireWorkspaceRoot();
    const { slnPath, projDir, fsprojPath } = writeFSharpProject(root, project);
    created.push(projDir, slnPath);
    const tree = explorer();
    await tree.loadSolution(slnPath);
    assert.ok(await pollTreeFor(tree, project), 'the project node must appear in the tree');
    return { project, fsprojPath, projDir };
  }

  /**
   * Add `name` beside the anchor file `<project><file>` at `position`, through
   * a symbol node of that file, on a freshly loaded project.
   */
  async function insertBeside(
    file: string,
    name: string,
    position: 'Above' | 'Below',
  ): Promise<{ project: string; fsprojPath: string; projDir: string }> {
    const loaded = await loadProject();
    const anchor = await symbolNodeIn(loaded.fsprojPath, `${loaded.project}${file}`);
    assert.ok(anchor, 'a symbol node in the anchor file must appear');
    stubs.queueInput(name).queuePick('No').queuePick(position);
    await vscode.commands.executeCommand(CMD_ADD_FS_FILE, anchor);
    return loaded;
  }

  // ── Interaction 1: project node → default position, file analysed ──

  test('project node: adds .fs before the last Compile item and FCS owns it', async function () {
    this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
    const { project, fsprojPath, projDir } = await loadProject();

    stubs.queueInput('NewLogic').queuePick('No');
    await vscode.commands.executeCommand(CMD_ADD_FS_FILE, projectNode(fsprojPath));

    // File created on disk with the module stub, and opened in the editor.
    if (stubs.log.errorMessages.length > 0) {
      assert.fail(`command reported errors: ${stubs.log.errorMessages.join(' | ')}`);
    }
    const fsPath = path.join(projDir, 'NewLogic.fs');
    assert.ok(fs.existsSync(fsPath), 'NewLogic.fs must exist on disk');
    assert.ok(fs.readFileSync(fsPath, 'utf-8').startsWith('module NewLogic'), 'stub content');
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      fsPath,
      'the new file must be opened',
    );

    // [SE-ADD-FILE-ORDER]: default position = before the LAST Compile item, so
    // the entry-ish Main.fs stays last.
    assert.deepStrictEqual(compileIncludes(fsprojPath), [
      `${project}Domain.fs`,
      'NewLogic.fs',
      `${project}Main.fs`,
    ]);
    // The prompts: one name input, one signature quickpick — no position pick.
    assert.strictEqual(stubs.log.inputBoxOptions.length, 1, 'exactly one name prompt');
    assert.ok(stubs.log.quickPickItems.length >= 1, 'the signature quickpick was shown');

    // Reactivity: the tree picks the new module up after the refresh.
    assert.ok(
      await pollTreeFor(explorer(), 'NewLogic'),
      'the new module must appear in the Solution Explorer',
    );

    // Ownership: FCS type-checks the new file after the project reloads.
    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc, 'the new document is open');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(1, 0), 'let theExtra = 21\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'buffer edit applies');
    const uri = doc.uri;
    const offset = doc.getText().indexOf('theExtra');
    assert.ok(offset >= 0, 'the edited buffer contains the probe symbol');
    const hovers = await pollHover(uri, doc.positionAt(offset + 2));
    const text = hoverText(hovers);
    assert.match(text, /theExtra/, 'hover names the symbol');
    assert.match(text, /int/, 'FCS types it — the checker owns the file');

    // Document symbols come from the FCS sidecar too.
    const symbols = await pollProvider<vscode.DocumentSymbol>(
      'vscode.executeDocumentSymbolProvider',
      [uri],
      (reply) => reply.some((s) => s.name.includes('NewLogic')),
      LSP_RESPONSE_MS,
      500,
      'F# document symbols for the new file',
    );
    assert.ok(symbols.length > 0, 'symbols are non-empty');
    // Leave no dirty buffer behind: closing one asks to save, a dialog the test
    // host refuses, so the editor would outlive the suite and take a later
    // suite's `undo`.
    assert.ok(await doc.save(), 'the probe edit is saved, so the editor closes cleanly');
  });

  // ── Interaction 2: file node → above/below that file ──────────────

  test('file node: inserts Below the anchor file next to it', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { project, fsprojPath, projDir } = await insertBeside('Domain.fs', 'BelowFile', 'Below');

    assert.deepStrictEqual(compileIncludes(fsprojPath), [
      `${project}Domain.fs`,
      'BelowFile.fs',
      `${project}Main.fs`,
    ]);
    // The file lands in the anchor file's directory (the project dir here).
    assert.ok(fs.existsSync(path.join(projDir, 'BelowFile.fs')), 'created beside the anchor');
    // The position pick offered Above and Below of the anchor file.
    const positionPick = stubs.log.quickPickItems.at(-1) as { label: string }[] | undefined;
    assert.ok(
      positionPick?.some((i) => i.label.includes('Above')),
      'Above offered',
    );
    assert.ok(
      positionPick?.some((i) => i.label.includes('Below')),
      'Below offered',
    );
  });

  test('file node: inserts Above the anchor file', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { project, fsprojPath } = await insertBeside('Main.fs', 'AboveFile', 'Above');

    assert.deepStrictEqual(compileIncludes(fsprojPath), [
      `${project}Domain.fs`,
      'AboveFile.fs',
      `${project}Main.fs`,
    ]);
  });

  // ── Interaction 3: signature pair, .fsi first ─────────────────────

  test('signature choice creates .fsi before .fs in compile order', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { project, fsprojPath, projDir } = await loadProject();

    stubs.queueInput('Math').queuePick('Yes');
    await vscode.commands.executeCommand(CMD_ADD_FS_FILE, projectNode(fsprojPath));

    assert.ok(fs.existsSync(path.join(projDir, 'Math.fsi')), 'the .fsi is created');
    assert.ok(fs.existsSync(path.join(projDir, 'Math.fs')), 'the .fs is created');
    assert.deepStrictEqual(compileIncludes(fsprojPath), [
      `${project}Domain.fs`,
      'Math.fsi',
      'Math.fs',
      `${project}Main.fs`,
    ]);
  });

  // ── Interaction 4: command palette (no node) ──────────────────────

  test('command palette: picks the project, default position', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { project, fsprojPath, projDir } = await loadProject();

    stubs.queuePick(project).queueInput('PaletteFile').queuePick('No');
    await vscode.commands.executeCommand(CMD_ADD_FS_FILE);

    assert.ok(fs.existsSync(path.join(projDir, 'PaletteFile.fs')), 'created in the project root');
    assert.deepStrictEqual(compileIncludes(fsprojPath), [
      `${project}Domain.fs`,
      'PaletteFile.fs',
      `${project}Main.fs`,
    ]);
  });

  // ── Cancel path ───────────────────────────────────────────────────

  test('cancelling at the signature prompt writes nothing', async function () {
    this.timeout(COMMAND_MS);
    const { fsprojPath } = await loadProject();
    const before = fs.readFileSync(fsprojPath, 'utf-8');

    stubs.queueInput('Cancelled').queuePick(undefined);
    await vscode.commands.executeCommand(CMD_ADD_FS_FILE, projectNode(fsprojPath));

    assert.strictEqual(
      fs.readFileSync(fsprojPath, 'utf-8'),
      before,
      'the fsproj must be untouched on cancel',
    );
    assert.ok(
      !vscode.workspace.textDocuments.some((d) => d.uri.fsPath.includes('Cancelled')),
      'no document may be opened for a cancelled add',
    );
  });

  // ── Pure helpers ──────────────────────────────────────────────────

  test('pure helpers: include path, pair order, stub, project walk', function () {
    this.timeout(FAST_MS);
    assert.strictEqual(compileIncludeOf('/work/P/P.fsproj', '/work/P/Sub/A.fs'), 'Sub/A.fs');
    assert.strictEqual(compileIncludeOf('/work/P.fsproj', '/work/A.fs'), 'A.fs');

    // [SE-ADD-FILE-ORDER]: .fsi first, except after an anchor the .fs leads.
    assert.deepStrictEqual(pairInsertOrder(['M.fsi', 'M.fs'], 'default'), ['M.fsi', 'M.fs']);
    assert.deepStrictEqual(pairInsertOrder(['M.fsi', 'M.fs'], 'before'), ['M.fsi', 'M.fs']);
    assert.deepStrictEqual(pairInsertOrder(['M.fsi', 'M.fs'], 'after'), ['M.fs', 'M.fsi']);

    assert.ok(fsharpFileContent('my-file').startsWith('module MyFile'));
    assert.ok(fsharpFileContent('NewLogic').startsWith('module NewLogic'));

    const project = { projectFilePath: '/w/A.fsproj' };
    const symbol = { parent: { parent: project } };
    assert.strictEqual(fsharpProjectOfNode(symbol), '/w/A.fsproj');
    assert.strictEqual(
      fsharpProjectOfNode({ parent: { projectFilePath: '/w/A.csproj' } }),
      undefined,
      'a C# project is not a target',
    );
  });

  // ── Manifest: menus gate on the F#-project context key ────────────

  test('manifest: command + context-menu entries gated on F# projects', function () {
    this.timeout(COMMAND_MS);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension installed');
    const contributes = (ext.packageJSON.contributes ?? {}) as {
      commands?: { command: string; title: string; category?: string }[];
      menus?: Record<string, { command: string; when?: string; group?: string }[]>;
      submenus?: unknown[];
    };
    const command = contributes.commands?.find((c) => c.command === CMD_ADD_FS_FILE);
    assert.ok(command, 'the command is contributed');
    assert.strictEqual(command.title, 'Add F# Source File');
    assert.strictEqual(command.category, 'SharpLsp');

    const entries = (contributes.menus?.['view/item/context'] ?? []).filter(
      (m) => m.command === CMD_ADD_FS_FILE,
    );
    assert.ok(entries.length >= 2, 'project + symbol node menu entries exist');
    for (const entry of entries) {
      assert.ok(entry.when?.includes('sharplsp.solutionExplorer'), 'scoped to the view');
      assert.ok(entry.when?.includes('sharplsp.fsProjectSelected'), 'gated on F# projects');
      assert.strictEqual(entry.group, '1_add@1', 'in the add group');
    }
    // Available from the command palette (not disabled there).
    const palette = (contributes.menus?.commandPalette ?? []).find(
      (m) => m.command === CMD_ADD_FS_FILE,
    );
    assert.strictEqual(palette, undefined, 'palette entry not disabled');
  });
});
