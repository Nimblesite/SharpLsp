// An F# project whose sources live OUTSIDE its own folder (GitHub #493). The
// reporter's RimWorld mod template keeps `.vscode/mod.fsproj` and compiles
// `../Source/Template/Main.fs`, with `EnableDefaultCompileItems` off. The
// Solution Explorer showed that project empty, even after a refresh, and
// "Add F# Source File" wrote the new file into `.vscode/` beside the project
// file, out of compile order, even when run on `Main.fs` itself.
//
// The project's sources are its Compile items, wherever they are on disk, so
// the tree lists them and a new file lands among them. Each test builds the
// template's exact layout inside the workspace and drives the real command
// through real tree nodes; FCS supplies every symbol. [SE-FSHARP-SYMBOLS]
// [SE-ADD-FILE-COMMAND]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pollTreeFor, treeContains } from './explorer-kit';
import { explorer, owningProjectOf, projectNode, symbolNodeIn } from './fsharp-project-tree-kit';
import { useLspTestSuite } from './lsp-suite-kit';
import { compileIncludes } from './project-xml-kit';
import {
  closeAllEditors,
  pollUntilResult,
  removeDirRecursive,
  requireWorkspaceRoot,
} from './test-helpers';
import { LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

const CMD_ADD_FS_FILE = 'sharplsp.addFSharpSourceFile';
const CMD_REMOVE_FS_FILE = 'sharplsp.removeFSharpSourceFile';
const KEEP = 'Remove from Project';
const DELETE = 'Remove and Delete File';

/** One template-shaped project on disk. */
interface Template {
  readonly name: string;
  readonly root: string;
  readonly fsprojPath: string;
  readonly sources: string;
}

/** The template's project file: explicit Compile items, all outside its folder. */
function fsprojText(name: string): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <OutputType>Library</OutputType>',
    '    <TargetFramework>net10.0</TargetFramework>',
    '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
    '  </PropertyGroup>',
    '  <ItemGroup>',
    `    <Compile Include="../Source/${name}/${name}Domain.fs" />`,
    `    <Compile Include="../Source/${name}/${name}Main.fs" />`,
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n');
}

/** `<root>/.vscode/mod.fsproj`, `<root>/Source/<name>/*.fs` and `<root>/mod.slnx`. */
function writeTemplate(parent: string, name: string): Template {
  const root = path.join(parent, name);
  const sources = path.join(root, 'Source', name);
  fs.mkdirSync(sources, { recursive: true });
  fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(sources, `${name}Domain.fs`),
    `module ${name}Domain\n\nlet answer = 42\n`,
  );
  fs.writeFileSync(
    path.join(sources, `${name}Main.fs`),
    `module ${name}Main\n\nlet twice x = x * 2\n`,
  );
  const fsprojPath = path.join(root, '.vscode', 'mod.fsproj');
  fs.writeFileSync(fsprojPath, fsprojText(name));
  const slnx = '<Solution>\n  <Project Path=".vscode/mod.fsproj" />\n</Solution>\n';
  fs.writeFileSync(path.join(root, 'mod.slnx'), slnx);
  return { name, root, fsprojPath, sources };
}

suite('Solution Explorer — an F# project whose sources live outside its folder (#493)', () => {
  useLspTestSuite('linked-sources-');
  let stubs: UiStubs;
  let created: string[];

  setup(() => {
    stubs = installUiStubs();
    created = [];
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
    explorer().clear();
    for (const dir of created) removeDirRecursive(dir);
  });

  /** Write and load a fresh template; resolve once its Main.fs symbols are in the tree. */
  async function loadTemplate(): Promise<Template> {
    const template = writeTemplate(
      requireWorkspaceRoot(),
      `Mod${Math.random().toString(36).slice(2, 8)}`,
    );
    created.push(template.root);
    await explorer().loadSolution(path.join(template.root, 'mod.slnx'));
    return template;
  }

  test('the tree lists the Compile items outside the project folder, under that project', async function () {
    this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
    const { name, fsprojPath } = await loadTemplate();
    assert.ok(await pollTreeFor(explorer(), 'mod'), 'the project node appears');
    for (const file of ['Domain', 'Main']) {
      const node = await symbolNodeIn(fsprojPath, `${name}${file}.fs`);
      assert.ok(node, `${name}${file}.fs is listed although it is outside .vscode/`);
      assert.strictEqual(owningProjectOf(node), fsprojPath, `${file}: under mod.fsproj`);
    }
    assert.ok(await pollTreeFor(explorer(), `${name}Main`), 'its module is in the tree');
    const children = projectNode(fsprojPath).children ?? [];
    assert.ok(
      children.some((child) => child.nodeType !== 'dependencyFolder'),
      'the project is not empty',
    );
  });

  test('adding beside a linked file puts it next to that file, in compile order', async function () {
    this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
    const { name, fsprojPath, sources, root } = await loadTemplate();
    const anchor = await symbolNodeIn(fsprojPath, `${name}Domain.fs`);
    assert.ok(anchor, 'a symbol node in the linked Domain.fs appears');
    stubs.queueInput('Rules').queuePick('No').queuePick('Below');
    await vscode.commands.executeCommand(CMD_ADD_FS_FILE, anchor);

    assert.deepStrictEqual(stubs.log.errorMessages, [], 'no error is reported');
    assert.ok(fs.existsSync(path.join(sources, 'Rules.fs')), 'created beside Domain.fs');
    assert.ok(!fs.existsSync(path.join(root, '.vscode', 'Rules.fs')), 'never beside the fsproj');
    assert.deepStrictEqual(compileIncludes(fsprojPath), [
      `../Source/${name}/${name}Domain.fs`,
      `../Source/${name}/Rules.fs`,
      `../Source/${name}/${name}Main.fs`,
    ]);
    const positions = stubs.log.quickPickItems.at(-1) as { label: string }[] | undefined;
    assert.ok(
      positions?.some((item) => item.label === `Below ${name}Domain.fs`),
      'Below was offered',
    );
  });

  test('adding from the project node puts the file among its sources and says where', async function () {
    this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
    const { name, fsprojPath, sources, root } = await loadTemplate();
    assert.ok(await pollTreeFor(explorer(), 'mod'), 'the project node appears');
    stubs.queueInput('Patches').queuePick('No');
    await vscode.commands.executeCommand(CMD_ADD_FS_FILE, projectNode(fsprojPath));

    assert.ok(fs.existsSync(path.join(sources, 'Patches.fs')), 'created where the sources are');
    assert.ok(!fs.existsSync(path.join(root, '.vscode', 'Patches.fs')), 'never beside the fsproj');
    assert.deepStrictEqual(compileIncludes(fsprojPath), [
      `../Source/${name}/${name}Domain.fs`,
      `../Source/${name}/Patches.fs`,
      `../Source/${name}/${name}Main.fs`,
    ]);
    const prompt = stubs.log.inputBoxOptions[0]?.prompt ?? '';
    assert.ok(prompt.includes(`Source/${name}`), `the prompt names the folder: ${prompt}`);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      path.join(sources, 'Patches.fs'),
      'the new file is opened',
    );
  });

  /** Resolve once no tree label contains `module`. */
  async function pollTreeWithout(module: string): Promise<boolean> {
    return await pollUntilResult(
      async () => !treeContains(explorer().getChildren(), module),
      (gone) => gone,
      LSP_RESPONSE_MS,
      500,
    );
  }

  test('removing a linked file takes it out of compile order, keeping or deleting it as asked', async function () {
    this.timeout(SIDECAR_COLD_MS + 2 * LSP_RESPONSE_MS);
    const { name, fsprojPath, sources } = await loadTemplate();
    const domain = await symbolNodeIn(fsprojPath, `${name}Domain.fs`);
    assert.ok(domain, 'a symbol node in the linked Domain.fs appears');
    stubs.queueWarning(KEEP);
    await vscode.commands.executeCommand(CMD_REMOVE_FS_FILE, domain);

    assert.deepStrictEqual(stubs.log.errorMessages, [], 'no error is reported');
    assert.ok(
      stubs.log.warningMessages[0]?.includes(`${name}Domain.fs`),
      'the question names the file',
    );
    assert.ok(stubs.log.warningMessages[0]?.includes('mod.fsproj'), 'and the project');
    assert.deepStrictEqual(
      stubs.log.warningActions[0],
      [KEEP, DELETE],
      'keep or delete, never silently',
    );
    assert.strictEqual(stubs.log.warningOptions[0]?.modal, true, 'asked modally');
    assert.deepStrictEqual(compileIncludes(fsprojPath), [`../Source/${name}/${name}Main.fs`]);
    assert.ok(fs.existsSync(path.join(sources, `${name}Domain.fs`)), 'kept on disk');
    assert.ok(await pollTreeWithout(`${name}Domain`), 'the tree drops its module');

    const main = await symbolNodeIn(fsprojPath, `${name}Main.fs`);
    assert.ok(main, 'Main.fs is still listed');
    stubs.queueWarning(DELETE);
    await vscode.commands.executeCommand(CMD_REMOVE_FS_FILE, main);
    assert.deepStrictEqual(compileIncludes(fsprojPath), [], 'the project compiles nothing now');
    assert.ok(!fs.existsSync(path.join(sources, `${name}Main.fs`)), 'and Main.fs is deleted');
  });

  test('dismissing the question changes nothing', async function () {
    this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
    const { name, fsprojPath, sources } = await loadTemplate();
    const domain = await symbolNodeIn(fsprojPath, `${name}Domain.fs`);
    assert.ok(domain, 'a symbol node in the linked Domain.fs appears');
    const before = fs.readFileSync(fsprojPath, 'utf-8');
    stubs.queueWarning(undefined);
    await vscode.commands.executeCommand(CMD_REMOVE_FS_FILE, domain);

    assert.strictEqual(fs.readFileSync(fsprojPath, 'utf-8'), before, 'the project is untouched');
    assert.ok(fs.existsSync(path.join(sources, `${name}Domain.fs`)), 'the file is untouched');
    assert.strictEqual(stubs.log.warningMessages.length, 1, 'asked exactly once');
  });
});
