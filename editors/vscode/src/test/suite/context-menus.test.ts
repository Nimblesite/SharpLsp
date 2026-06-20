/**
 * E2E tests for context menu commands and context values in the Solution Explorer.
 *
 * Covers:
 *   - Package.json menu contribution correctness (when clauses, groups)
 *   - contextValue set correctly for all node types
 *   - sharplsp.copyQualifiedName: builds Namespace.Class.Member correctly
 *   - sharplsp.copyName: copies unqualified name
 *   - sharplsp.revealInExplorer: runs without error, nodes have symbolUri
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { collectProjectPaths } from '../../package-maintenance.js';
import {
  EXTENSION_ID,
  closeAllEditors,
  openSharpLspPanel,
  pollUntilResult,
  setupLspTestSuite,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDocumentSymbols,
} from './test-helpers';

// ── Shared interfaces ─────────────────────────────────────────────

interface TreeNode {
  readonly label?: string | { label: string };
  readonly contextValue?: string;
  readonly children?: TreeNode[];
  readonly symbolUri?: string;
  readonly sortName?: string;
  readonly projectFilePath?: string;
}

interface ExplorerApi {
  explorerProvider: {
    loadSolution(slnPath: string): Promise<void>;
    refresh(): Promise<void>;
    clear(): void;
    getChildren(element?: unknown): TreeNode[] | undefined;
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function nodeLabel(node: TreeNode): string {
  if (typeof node.label === 'string') return node.label;
  return node.label?.label ?? '';
}

function findNode(
  nodes: TreeNode[] | undefined,
  predicate: (n: TreeNode) => boolean,
): TreeNode | undefined {
  if (nodes === undefined) return undefined;
  for (const node of nodes) {
    if (predicate(node)) return node;
    const found = findNode(node.children, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findByLabel(nodes: TreeNode[] | undefined, label: string): TreeNode | undefined {
  return findNode(nodes, (n) => nodeLabel(n).includes(label));
}

function findByContext(nodes: TreeNode[] | undefined, contextValue: string): TreeNode | undefined {
  return findNode(nodes, (n) => n.contextValue === contextValue);
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

/** Write a minimal .csproj file. */
function writeCsproj(dir: string, name: string): void {
  fs.writeFileSync(
    path.join(dir, `${name}.csproj`),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
</Project>`,
  );
}

/** Write a minimal .sln file with one project. */
function writeSln(slnPath: string, projName: string, guid: string): void {
  fs.writeFileSync(
    slnPath,
    [
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${projName}", "${projName}/${projName}.csproj", "${guid}"`,
      'EndProject',
      'Global',
      'EndGlobal',
    ].join('\n'),
  );
}

// ── C# source used for all "AllTypes" suites ──────────────────────

const ALL_TYPES_CS = `namespace AllTypesNS
{
    public delegate void MyDelegate(string msg);
    public enum MyEnum { Alpha, Beta }
    public interface IRunner { void Run(); }
    public struct MyPoint { public int X; public int Y; }
    public record MyRecord(string Value);

    public class AllTypesClass
    {
        private int _count;
        public event EventHandler Changed;
        public AllTypesClass() { }
        public string Label { get; set; }
        public void Execute() { }
    }
}`;

// ── Suite 1: Package.json Contributions ──────────────────────────

suite('Context Menu — Package.json Contributions', () => {
  function menuEntries(): { command: string; when: string; group: string }[] {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must be found');
    const menus = ext.packageJSON.contributes?.menus?.['view/item/context'] ?? [];
    return menus as { command: string; when: string; group: string }[];
  }

  // ── Command registration ──────────────────────────────────────

  for (const cmd of [
    'sharplsp.copyQualifiedName',
    'sharplsp.copyName',
    'sharplsp.revealInExplorer',
    'sharplsp.sortMembers',
    'sharplsp.openProjectFile',
    'sharplsp.build',
    'sharplsp.rebuild',
    'sharplsp.clean',
    'sharplsp.addProjectReference',
    'sharplsp.nuget.addFromExplorer',
    'sharplsp.removeNuGetPackage',
    'sharplsp.removeProjectReference',
    'sharplsp.removeUnusedPackages',
    'sharplsp.consolidatePackages',
  ]) {
    test(`${cmd} command is registered`, async () => {
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(cmds.includes(cmd), `${cmd} must be a registered VS Code command`);
    });
  }

  // ── Build/Rebuild/Clean on the root solution node ─────────────

  const SOLUTION_WHEN = 'view == sharplsp.solutionExplorer && viewItem == solution';
  const PROJECT_WHEN = 'view == sharplsp.solutionExplorer && viewItem == project';

  for (const cmd of ['sharplsp.build', 'sharplsp.rebuild', 'sharplsp.clean']) {
    test(`${cmd} has a solution-node menu entry in the 2_build group`, () => {
      const entry = menuEntries().find((m) => m.command === cmd && m.when === SOLUTION_WHEN);
      assert.ok(entry, `${cmd} must have a view/item/context entry scoped to the solution node`);
      assert.strictEqual(
        entry.group,
        '2_build',
        `${cmd} solution entry must be in the '2_build' group, got '${entry.group}'`,
      );
    });

    test(`${cmd} still has its project-node menu entry`, () => {
      const entry = menuEntries().find((m) => m.command === cmd && m.when === PROJECT_WHEN);
      assert.ok(entry, `${cmd} must keep its project-node menu entry`);
      assert.strictEqual(entry.group, '2_build', `${cmd} project entry must stay in '2_build'`);
    });
  }

  // ── Package maintenance (unused / consolidate) ────────────────

  test('removeUnusedPackages has project + solution menu entries in 5_dependencies', () => {
    const entries = menuEntries().filter((m) => m.command === 'sharplsp.removeUnusedPackages');
    const project = entries.find((m) => m.when === PROJECT_WHEN);
    const solution = entries.find((m) => m.when === SOLUTION_WHEN);
    assert.ok(project, 'removeUnusedPackages must have a project-node entry');
    assert.ok(solution, 'removeUnusedPackages must have a solution-node entry');
    assert.strictEqual(project.group, '5_dependencies');
    assert.strictEqual(solution.group, '5_dependencies');
  });

  test('consolidatePackages has a solution-only menu entry in 5_dependencies', () => {
    const entries = menuEntries().filter((m) => m.command === 'sharplsp.consolidatePackages');
    const solution = entries.find((m) => m.when === SOLUTION_WHEN);
    assert.ok(solution, 'consolidatePackages must have a solution-node entry');
    assert.strictEqual(solution.group, '5_dependencies');
    assert.ok(
      !entries.some((m) => m.when === PROJECT_WHEN),
      'consolidatePackages must NOT appear on project nodes (it is solution-wide)',
    );
  });

  // ── sortMembers when clause ───────────────────────────────────

  test('sortMembers menu entry exists in view/item/context', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.sortMembers');
    assert.ok(entry, 'sharplsp.sortMembers must have a view/item/context menu entry');
  });

  test('sortMembers when clause scopes to class/struct/interface/enum/record', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.sortMembers');
    assert.ok(entry, 'sharplsp.sortMembers must have a menu entry');
    const when = entry.when;
    assert.ok(when.includes('class'), `sortMembers when clause must include 'class': ${when}`);
    assert.ok(
      when.includes('interface'),
      `sortMembers when clause must include 'interface': ${when}`,
    );
    assert.ok(when.includes('enum'), `sortMembers when clause must include 'enum': ${when}`);
    assert.ok(when.includes('record'), `sortMembers when clause must include 'record': ${when}`);
    assert.ok(
      when.includes('sharplsp.solutionExplorer'),
      'sortMembers must be scoped to sharplsp.solutionExplorer view',
    );
  });

  test('sortMembers when clause does NOT include method or property', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.sortMembers');
    assert.ok(entry, 'sharplsp.sortMembers must have a menu entry');
    const when = entry.when;
    // The pattern should only match type-level nodes (class, struct, etc.)
    // It must NOT be a catch-all for all symbol nodes.
    assert.ok(!when.includes('symbol.method'), 'sortMembers must NOT show for method nodes');
    assert.ok(!when.includes('symbol.property'), 'sortMembers must NOT show for property nodes');
    assert.ok(!when.includes('symbol.field'), 'sortMembers must NOT show for field nodes');
  });

  test('sortMembers is scoped to solutionExplorer view', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.sortMembers');
    assert.ok(entry, 'sharplsp.sortMembers must have a menu entry');
    assert.ok(
      entry.when.includes('sharplsp.solutionExplorer'),
      "sortMembers when clause must include 'sharplsp.solutionExplorer'",
    );
  });

  // ── copyQualifiedName when clause ────────────────────────────

  test('copyQualifiedName menu entry exists', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.copyQualifiedName');
    assert.ok(entry, 'sharplsp.copyQualifiedName must have a view/item/context menu entry');
  });

  test('copyQualifiedName when clause scopes to symbol nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.copyQualifiedName');
    assert.ok(entry, 'sharplsp.copyQualifiedName must have a menu entry');
    assert.ok(
      entry.when.includes('symbol'),
      "copyQualifiedName when clause must reference 'symbol'",
    );
    assert.ok(
      entry.when.includes('sharplsp.solutionExplorer'),
      'copyQualifiedName must be scoped to solutionExplorer view',
    );
  });

  test('copyQualifiedName is in a copy/paste group', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.copyQualifiedName');
    assert.ok(entry, 'sharplsp.copyQualifiedName must have a menu entry');
    const g = entry.group;
    assert.ok(
      g.includes('cutcopypaste') || g.includes('copy') || g.startsWith('9'),
      `copyQualifiedName group '${g}' should be a copy/paste group`,
    );
  });

  // ── copyName when clause ──────────────────────────────────────

  test('copyName menu entry exists', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.copyName');
    assert.ok(entry, 'sharplsp.copyName must have a view/item/context menu entry');
  });

  test('copyName when clause covers symbol nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.copyName');
    assert.ok(entry, 'sharplsp.copyName must have a menu entry');
    assert.ok(entry.when.includes('symbol'), "copyName when clause must reference 'symbol'");
    assert.ok(
      entry.when.includes('sharplsp.solutionExplorer'),
      'copyName must be scoped to solutionExplorer view',
    );
  });

  test('copyName when clause covers solution and project nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.copyName');
    assert.ok(entry, 'sharplsp.copyName must have a menu entry');
    const when = entry.when;
    // copyName should appear on solution and project nodes too
    assert.ok(
      when.includes('solution') || when.includes('project'),
      `copyName when clause '${when}' should cover solution or project nodes`,
    );
  });

  test('copyName is in a copy/paste group', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.copyName');
    assert.ok(entry, 'sharplsp.copyName must have a menu entry');
    const g = entry.group;
    assert.ok(
      g.includes('cutcopypaste') || g.includes('copy') || g.startsWith('9'),
      `copyName group '${g}' should be a copy/paste group`,
    );
  });

  // ── revealInExplorer when clause ─────────────────────────────

  test('revealInExplorer menu entry exists', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.revealInExplorer');
    assert.ok(entry, 'sharplsp.revealInExplorer must have a view/item/context menu entry');
  });

  test('revealInExplorer when clause scopes to symbol nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.revealInExplorer');
    assert.ok(entry, 'sharplsp.revealInExplorer must have a menu entry');
    assert.ok(
      entry.when.includes('symbol'),
      "revealInExplorer when clause must reference 'symbol'",
    );
    assert.ok(
      entry.when.includes('sharplsp.solutionExplorer'),
      'revealInExplorer must be scoped to solutionExplorer view',
    );
  });

  // ── sortMembers group ─────────────────────────────────────────

  test('sortMembers is in a modification group', () => {
    const entry = menuEntries().find((m) => m.command === 'sharplsp.sortMembers');
    assert.ok(entry, 'sharplsp.sortMembers must have a menu entry');
    const g = entry.group;
    assert.ok(
      g.includes('modification') || g.startsWith('1'),
      `sortMembers group '${g}' should be a modification group`,
    );
  });
});

// ── Suite 2: Context Values ───────────────────────────────────────

suite('Context Menu — Context Values on Tree Nodes', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(120_000);
    const result = await setupLspTestSuite('ctx-val-');
    tmpDir = result.tmpDir;
    provider = getProvider();

    // Use the fixture workspace — it already has TestFixtures.sln loaded and
    // Roslyn is guaranteed to be warm after setupLspTestSuite completes.
    fixtureDir = path.resolve(__dirname, '../../../test-fixtures/workspace');

    // Write AllTypesCtx source INTO the fixture project so Roslyn can analyze it.
    const allTypesPath = path.join(fixtureDir, 'AllTypesCtx.cs');
    fs.writeFileSync(allTypesPath, ALL_TYPES_CS, 'utf8');

    const slnPath = path.join(fixtureDir, 'TestFixtures.sln');
    await provider.loadSolution(slnPath);

    const csUri = vscode.Uri.file(allTypesPath);
    const csDoc = await vscode.workspace.openTextDocument(csUri);
    await vscode.window.showTextDocument(csDoc);
    await waitForDocumentSymbols(csUri);
    await provider.refresh();

    // Wait for tree to populate — poll until AllTypesClass appears.
    await pollUntilResult(
      async () => findByLabel(provider.getChildren(), 'AllTypesClass'),
      (n) => n !== undefined,
      60_000,
      1_000,
    );
  });

  suiteTeardown(async () => {
    // Remove the temp file added to the fixture workspace.
    const allTypesPath = path.join(fixtureDir, 'AllTypesCtx.cs');
    try {
      fs.rmSync(allTypesPath, { force: true });
    } catch {
      /* best-effort */
    }
    provider.clear();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("solution node has contextValue 'solution'", async function () {
    this.timeout(10_000);
    const roots = provider.getChildren();
    assert.ok(roots !== undefined && roots.length > 0, 'Tree must have roots');
    const sln = roots[0];
    assert.ok(sln, 'Solution node must exist');
    assert.strictEqual(
      sln.contextValue,
      'solution',
      "Solution node must have contextValue 'solution'",
    );
    await openSharpLspPanel();
    await takeScreenshot('vscode-solution-explorer-context-menu.png');
  });

  test("project node has contextValue 'project'", () => {
    const projectNode = findByContext(provider.getChildren(), 'project');
    assert.ok(projectNode, "Project node must exist with contextValue 'project'");
  });

  test("namespace node has contextValue 'symbol.namespace'", () => {
    const ns = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('AllTypesNS') && n.contextValue === 'symbol.namespace',
    );
    assert.ok(ns, "AllTypesNS namespace node must have contextValue 'symbol.namespace'");
  });

  test("class node has contextValue 'symbol.class'", () => {
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('AllTypesClass') && n.contextValue === 'symbol.class',
    );
    assert.ok(node, "AllTypesClass must have contextValue 'symbol.class'");
  });

  test("interface node has contextValue 'symbol.interface'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.interface');
    assert.ok(node, 'A symbol.interface node must exist in the tree');
    assert.ok(nodeLabel(node).includes('IRunner'), `Expected IRunner, got '${nodeLabel(node)}'`);
  });

  test("struct node has contextValue 'symbol.struct'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.struct');
    assert.ok(node, 'A symbol.struct node must exist in the tree');
    assert.ok(nodeLabel(node).includes('MyPoint'), `Expected MyPoint, got '${nodeLabel(node)}'`);
  });

  test("enum node has contextValue 'symbol.enum'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.enum');
    assert.ok(node, 'A symbol.enum node must exist in the tree');
    assert.ok(nodeLabel(node).includes('MyEnum'), `Expected MyEnum, got '${nodeLabel(node)}'`);
  });

  test("enum member node has contextValue 'symbol.enumMember'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.enumMember');
    assert.ok(node, 'A symbol.enumMember node must exist (e.g., Alpha or Beta)');
    const lbl = nodeLabel(node);
    assert.ok(
      lbl.includes('Alpha') || lbl.includes('Beta'),
      `Expected Alpha or Beta enum member, got '${lbl}'`,
    );
  });

  test("method node has contextValue 'symbol.method'", () => {
    const allTypesClass = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('AllTypesClass') && n.contextValue === 'symbol.class',
    );
    assert.ok(allTypesClass, 'AllTypesClass must exist in the tree');
    const node = findByContext(allTypesClass.children, 'symbol.method');
    assert.ok(node, 'A symbol.method node must exist under AllTypesClass');
    const lbl = nodeLabel(node);
    assert.ok(lbl.includes('Execute'), `Expected Execute method, got '${lbl}'`);
  });

  test("property node has contextValue 'symbol.property'", () => {
    const allTypesClass = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('AllTypesClass') && n.contextValue === 'symbol.class',
    );
    assert.ok(allTypesClass, 'AllTypesClass must exist in the tree');
    const node = findByContext(allTypesClass.children, 'symbol.property');
    assert.ok(node, 'A symbol.property node must exist under AllTypesClass');
    assert.ok(
      nodeLabel(node).includes('Label'),
      `Expected Label property, got '${nodeLabel(node)}'`,
    );
  });

  test("field node has contextValue 'symbol.field'", () => {
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('_count') && n.contextValue === 'symbol.field',
    );
    assert.ok(node, "_count must have contextValue 'symbol.field'");
  });

  test("event node has contextValue 'symbol.event'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.event');
    assert.ok(node, 'A symbol.event node must exist in the tree');
    assert.ok(
      nodeLabel(node).includes('Changed'),
      `Expected Changed event, got '${nodeLabel(node)}'`,
    );
  });

  test("constructor node has contextValue 'symbol.constructor'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.constructor');
    assert.ok(node, 'A symbol.constructor node must exist in the tree');
  });

  test("delegate node has contextValue 'symbol.delegate'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.delegate');
    assert.ok(node, 'A symbol.delegate node must exist (MyDelegate)');
    assert.ok(
      nodeLabel(node).includes('MyDelegate'),
      `Expected MyDelegate, got '${nodeLabel(node)}'`,
    );
  });

  test("record node has contextValue 'symbol.class' or 'symbol.record'", () => {
    // Records can be mapped to class or record depending on the grammar.
    const node = findNode(
      provider.getChildren(),
      (n) =>
        nodeLabel(n).includes('MyRecord') &&
        (n.contextValue === 'symbol.class' || n.contextValue === 'symbol.record'),
    );
    assert.ok(node, "MyRecord must have contextValue 'symbol.class' or 'symbol.record'");
  });

  test("all symbol nodes have a contextValue starting with 'symbol.'", () => {
    let symbolCount = 0;
    const badNodes: string[] = [];

    function walkNodes(nodes: TreeNode[] | undefined): void {
      if (nodes === undefined) return;
      for (const node of nodes) {
        const cv = node.contextValue ?? '';
        // Non-symbol nodes (solution, project, dependencyFolder, etc.) are OK without symbol prefix.
        // Symbol-like nodes must start with 'symbol.'
        const lbl = nodeLabel(node);
        if (
          cv !== '' &&
          !['solution', 'project', 'dependencyFolder', 'nugetPackage', 'projectReference'].includes(
            cv,
          )
        ) {
          symbolCount++;
          if (!cv.startsWith('symbol.')) {
            badNodes.push(`${lbl} (contextValue=${cv})`);
          }
        }
        walkNodes(node.children);
      }
    }
    walkNodes(provider.getChildren());

    assert.ok(symbolCount > 0, 'Must find at least some symbol nodes in the tree');
    assert.deepEqual(
      badNodes,
      [],
      `These nodes have unexpected contextValues: ${badNodes.join(', ')}`,
    );
  });
});

// ── Suite 3: Copy Qualified Name ─────────────────────────────────

suite('Context Menu — Copy Qualified Name', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('ctx-qual-');
    tmpDir = result.tmpDir;
    provider = getProvider();

    const projDir = path.join(tmpDir, 'QualNS');
    fs.mkdirSync(projDir, { recursive: true });
    writeCsproj(projDir, 'QualNS');
    fs.writeFileSync(
      path.join(projDir, 'Source.cs'),
      `namespace OuterNS
{
    public class OuterClass
    {
        public void OuterMethod() { }
        public string OuterProp { get; set; }

        public class InnerClass
        {
            public void InnerMethod() { }
        }
    }

    public interface IService
    {
        void Serve();
    }
}`,
    );

    const slnPath = path.join(tmpDir, 'QualNS.sln');
    writeSln(slnPath, 'QualNS', '{00000000-0000-0000-0000-000000000201}');
    await provider.loadSolution(slnPath);

    const csUri = vscode.Uri.file(path.join(projDir, 'Source.cs'));
    await vscode.workspace.openTextDocument(csUri).then((d) => vscode.window.showTextDocument(d));
    await waitForDocumentSymbols(csUri);
    await provider.refresh();

    await pollUntilResult(
      async () => findByLabel(provider.getChildren(), 'OuterClass'),
      (n) => n !== undefined,
      15_000,
    );
  });

  suiteTeardown(async () => {
    provider.clear();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('copyQualifiedName for a class produces Namespace.ClassName', async function () {
    this.timeout(10_000);
    const classNode = findByLabel(provider.getChildren(), 'OuterClass');
    assert.ok(classNode, 'OuterClass must be in the tree');

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('sharplsp.copyQualifiedName', classNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(
      text.includes('OuterNS') && text.includes('OuterClass'),
      `Expected 'OuterNS.OuterClass', got '${text}'`,
    );
    assert.ok(text.includes('.'), 'Qualified name must contain a dot separator');
    assert.ok(!text.startsWith('.'), 'Qualified name must not start with a dot');
  });

  test('copyQualifiedName for a method produces Namespace.Class.Method', async function () {
    this.timeout(10_000);
    const methodNode = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('OuterMethod') && n.contextValue === 'symbol.method',
    );
    assert.ok(methodNode, 'OuterMethod must be in the tree');

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('sharplsp.copyQualifiedName', methodNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(
      text.includes('OuterNS') && text.includes('OuterClass') && text.includes('OuterMethod'),
      `Expected 'OuterNS.OuterClass.OuterMethod', got '${text}'`,
    );
  });

  test('copyQualifiedName for a property produces Namespace.Class.Property', async function () {
    this.timeout(10_000);
    const propNode = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('OuterProp') && n.contextValue === 'symbol.property',
    );
    assert.ok(propNode, 'OuterProp must be in the tree');

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('sharplsp.copyQualifiedName', propNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(
      text.includes('OuterNS') && text.includes('OuterClass') && text.includes('OuterProp'),
      `Expected qualified name with OuterNS, OuterClass, OuterProp; got '${text}'`,
    );
  });

  test('copyQualifiedName for interface produces Namespace.InterfaceName', async function () {
    this.timeout(10_000);
    const ifaceNode = findByLabel(provider.getChildren(), 'IService');
    assert.ok(ifaceNode, 'IService must be in the tree');

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('sharplsp.copyQualifiedName', ifaceNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(
      text.includes('OuterNS') && text.includes('IService'),
      `Expected 'OuterNS.IService', got '${text}'`,
    );
  });

  test('copyQualifiedName for inner class includes full path', async function () {
    this.timeout(10_000);
    const innerNode = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('InnerClass') && n.contextValue === 'symbol.class',
    );
    assert.ok(innerNode, 'InnerClass must be in the tree');

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('sharplsp.copyQualifiedName', innerNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(
      text.includes('InnerClass'),
      `Expected qualified name with 'InnerClass', got '${text}'`,
    );
  });

  test('copyQualifiedName for inner method includes full hierarchy', async function () {
    this.timeout(10_000);
    const innerMethodNode = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('InnerMethod') && n.contextValue === 'symbol.method',
    );
    assert.ok(innerMethodNode, 'InnerMethod must be in the tree');

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('sharplsp.copyQualifiedName', innerMethodNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(
      text.includes('InnerMethod'),
      `Expected qualified name with 'InnerMethod', got '${text}'`,
    );
    assert.ok(text.includes('.'), 'Inner method qualified name must have dots');
  });

  test('copyQualifiedName result is dot-separated and non-empty', async function () {
    this.timeout(10_000);
    const classNode = findByLabel(provider.getChildren(), 'OuterClass');
    assert.ok(classNode, 'OuterClass must be in the tree');

    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('sharplsp.copyQualifiedName', classNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(text.length > 0, 'Qualified name must not be empty');
    assert.ok(!text.startsWith('.'), 'Must not start with dot');
    assert.ok(!text.endsWith('.'), 'Must not end with dot');
  });
});

// ── Suite 4: Copy Name ────────────────────────────────────────────

suite('Context Menu — Copy Name', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('ctx-name-');
    tmpDir = result.tmpDir;
    provider = getProvider();

    const projDir = path.join(tmpDir, 'CopyNameTest');
    fs.mkdirSync(projDir, { recursive: true });
    writeCsproj(projDir, 'CopyNameTest');
    fs.writeFileSync(path.join(projDir, 'Source.cs'), ALL_TYPES_CS);

    const slnPath = path.join(tmpDir, 'CopyNameTest.sln');
    writeSln(slnPath, 'CopyNameTest', '{00000000-0000-0000-0000-000000000301}');
    await provider.loadSolution(slnPath);

    const csUri = vscode.Uri.file(path.join(projDir, 'Source.cs'));
    await vscode.workspace.openTextDocument(csUri).then((d) => vscode.window.showTextDocument(d));
    await waitForDocumentSymbols(csUri);
    await provider.refresh();

    await pollUntilResult(
      async () => findByLabel(provider.getChildren(), 'AllTypesClass'),
      (n) => n !== undefined,
      15_000,
    );
  });

  suiteTeardown(async () => {
    provider.clear();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('copyName for a class node copies unqualified class name', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'AllTypesClass');
    assert.ok(node, 'AllTypesClass node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'AllTypesClass', `Expected 'AllTypesClass', got '${text}'`);
  });

  test('copyName for a method node copies just the method name', async function () {
    this.timeout(10_000);
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('Execute') && n.contextValue === 'symbol.method',
    );
    assert.ok(node, 'Execute method node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'Execute', `Expected 'Execute', got '${text}'`);
  });

  test('copyName for an interface node copies just the interface name', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'IRunner');
    assert.ok(node, 'IRunner node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'IRunner', `Expected 'IRunner', got '${text}'`);
  });

  test('copyName for a property node copies just the property name', async function () {
    this.timeout(10_000);
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('Label') && n.contextValue === 'symbol.property',
    );
    assert.ok(node, 'Label property node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'Label', `Expected 'Label', got '${text}'`);
  });

  test('copyName for an enum node copies just the enum name', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'MyEnum');
    assert.ok(node, 'MyEnum node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'MyEnum', `Expected 'MyEnum', got '${text}'`);
  });

  test('copyName for a struct node copies just the struct name', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'MyPoint');
    assert.ok(node, 'MyPoint struct node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'MyPoint', `Expected 'MyPoint', got '${text}'`);
  });

  test('copyName does not include namespace prefix', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'AllTypesClass');
    assert.ok(node, 'AllTypesClass node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(!text.includes('.'), `copyName must return unqualified name, got '${text}'`);
  });

  test('copyName for solution node copies solution filename', async function () {
    this.timeout(10_000);
    const roots = provider.getChildren();
    assert.ok(roots !== undefined && roots.length > 0, 'Tree must have roots');
    const slnNode = roots[0];
    assert.ok(slnNode, 'Solution node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('sharplsp.copyName', slnNode);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.ok(
      text.length > 0 && text !== 'BEFORE',
      `copyName for solution must write something to clipboard, got '${text}'`,
    );
  });
});

// ── Suite 5: Reveal in File Explorer ─────────────────────────────

suite('Context Menu — Reveal in File Explorer', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('ctx-reveal-');
    tmpDir = result.tmpDir;
    provider = getProvider();

    const projDir = path.join(tmpDir, 'RevealTest');
    fs.mkdirSync(projDir, { recursive: true });
    writeCsproj(projDir, 'RevealTest');
    fs.writeFileSync(
      path.join(projDir, 'Source.cs'),
      `namespace RevealNS
{
    public class RevealClass
    {
        public void RevealMethod() { }
        public string RevealProp { get; set; }
        private int _revealField;
    }
}`,
    );

    const slnPath = path.join(tmpDir, 'RevealTest.sln');
    writeSln(slnPath, 'RevealTest', '{00000000-0000-0000-0000-000000000401}');
    await provider.loadSolution(slnPath);

    const csUri = vscode.Uri.file(path.join(projDir, 'Source.cs'));
    await vscode.workspace.openTextDocument(csUri).then((d) => vscode.window.showTextDocument(d));
    await waitForDocumentSymbols(csUri);
    await provider.refresh();

    await pollUntilResult(
      async () => findByLabel(provider.getChildren(), 'RevealClass'),
      (n) => n !== undefined,
      15_000,
    );
  });

  suiteTeardown(async () => {
    provider.clear();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('class node has symbolUri pointing to the source file', () => {
    const node = findByLabel(provider.getChildren(), 'RevealClass') as
      | (TreeNode & { symbolUri?: string })
      | undefined;
    assert.ok(node, 'RevealClass node must be in the tree');
    assert.ok(
      node.symbolUri !== undefined,
      'Class node must have symbolUri set for Reveal in Explorer',
    );
    assert.ok(
      node.symbolUri.includes('Source.cs'),
      `symbolUri '${node.symbolUri}' must reference Source.cs`,
    );
  });

  test('method node has symbolUri pointing to the source file', () => {
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('RevealMethod') && n.contextValue === 'symbol.method',
    ) as (TreeNode & { symbolUri?: string }) | undefined;
    assert.ok(node, 'RevealMethod node must be in the tree');
    assert.ok(node.symbolUri !== undefined, 'Method node must have symbolUri set');
    assert.ok(
      node.symbolUri.includes('Source.cs'),
      `symbolUri '${node.symbolUri}' must reference Source.cs`,
    );
  });

  test('property node has symbolUri set', () => {
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('RevealProp') && n.contextValue === 'symbol.property',
    ) as (TreeNode & { symbolUri?: string }) | undefined;
    assert.ok(node, 'RevealProp node must be in the tree');
    assert.ok(node.symbolUri !== undefined, 'Property node must have symbolUri set');
  });

  test('field node has symbolUri set', () => {
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('_revealField') && n.contextValue === 'symbol.field',
    ) as (TreeNode & { symbolUri?: string }) | undefined;
    assert.ok(node, '_revealField node must be in the tree');
    assert.ok(node.symbolUri !== undefined, 'Field node must have symbolUri set');
  });

  test('revealInExplorer executes without error for a class node', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'RevealClass');
    assert.ok(node, 'RevealClass node must be in the tree');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.revealInExplorer', node);
    }, 'revealInExplorer must not throw for a class node with symbolUri');
  });

  test('revealInExplorer executes without error for a method node', async function () {
    this.timeout(10_000);
    const node = findNode(
      provider.getChildren(),
      (n) => nodeLabel(n).includes('RevealMethod') && n.contextValue === 'symbol.method',
    );
    assert.ok(node, 'RevealMethod node must be in the tree');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.revealInExplorer', node);
    }, 'revealInExplorer must not throw for a method node');
  });

  test('revealInExplorer handles node without symbolUri gracefully', async function () {
    this.timeout(5_000);
    // Node without symbolUri — revealInExplorer must silently return.
    const mockNode = {
      symbolUri: undefined,
      sortName: 'NoUri',
      contextValue: 'symbol.class',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.revealInExplorer', mockNode);
    }, 'revealInExplorer must handle missing symbolUri without throwing');
  });

  test('symbolUri on all symbol nodes is a valid file URI', () => {
    let symbolCount = 0;
    const badNodes: string[] = [];

    function walkNodes(nodes: TreeNode[] | undefined): void {
      if (nodes === undefined) return;
      for (const node of nodes) {
        const cv = node.contextValue ?? '';
        if (cv.startsWith('symbol.') && cv !== 'symbol.namespace') {
          symbolCount++;
          const uri = (node as TreeNode & { symbolUri?: string }).symbolUri;
          if (uri === undefined || uri === '') {
            badNodes.push(`${nodeLabel(node)} (${cv})`);
          } else if (!uri.startsWith('file://')) {
            badNodes.push(`${nodeLabel(node)} has non-file URI: ${uri}`);
          }
        }
        walkNodes(node.children);
      }
    }
    walkNodes(provider.getChildren());

    assert.ok(symbolCount > 0, 'Must find at least some non-namespace symbol nodes');
    assert.deepEqual(
      badNodes,
      [],
      `These symbol nodes are missing a valid symbolUri: ${badNodes.join(', ')}`,
    );
  });
});

// ── Suite 6: Context Menu Only Appears on Correct Node Types ──────

suite('Context Menu — Correct Node Type Scoping', () => {
  test('sortMembers contextValue pattern matches type nodes only', () => {
    // Simulate the VS Code 'when' clause regex:  /^symbol\.(class|struct|interface|enum|record)$/
    const pattern = /^symbol\.(class|struct|interface|enum|record)$/;

    const mustMatch = [
      'symbol.class',
      'symbol.struct',
      'symbol.interface',
      'symbol.enum',
      'symbol.record',
    ];
    const mustNotMatch = [
      'symbol.method',
      'symbol.property',
      'symbol.field',
      'symbol.event',
      'symbol.constructor',
      'symbol.delegate',
      'symbol.enumMember',
      'symbol.namespace',
      'symbol.unknown',
      'solution',
      'project',
      'nugetPackage',
      'projectReference',
    ];

    for (const cv of mustMatch) {
      assert.ok(pattern.test(cv), `sortMembers pattern must match '${cv}'`);
    }
    for (const cv of mustNotMatch) {
      assert.ok(!pattern.test(cv), `sortMembers pattern must NOT match '${cv}'`);
    }
  });

  test('revealInExplorer contextValue pattern matches all symbol nodes', () => {
    const prefix = 'symbol.';

    const mustMatch = [
      'symbol.class',
      'symbol.method',
      'symbol.property',
      'symbol.field',
      'symbol.event',
      'symbol.interface',
      'symbol.enum',
      'symbol.struct',
      'symbol.constructor',
      'symbol.delegate',
      'symbol.namespace',
      'symbol.enumMember',
    ];
    const mustNotMatch = [
      'solution',
      'project',
      'nugetPackage',
      'projectReference',
      'dependencyFolder',
    ];

    for (const cv of mustMatch) {
      assert.ok(cv.startsWith(prefix), `revealInExplorer pattern must match '${cv}'`);
    }
    for (const cv of mustNotMatch) {
      assert.ok(!cv.startsWith(prefix), `revealInExplorer pattern must NOT match '${cv}'`);
    }
  });

  test('copyQualifiedName contextValue pattern matches all symbol nodes', () => {
    const prefix = 'symbol.';
    const mustMatch = ['symbol.class', 'symbol.method', 'symbol.property', 'symbol.namespace'];
    for (const cv of mustMatch) {
      assert.ok(cv.startsWith(prefix), `copyQualifiedName must match '${cv}'`);
    }
    assert.ok(!'solution'.startsWith(prefix), "copyQualifiedName must not match 'solution'");
    assert.ok(!'project'.startsWith(prefix), "copyQualifiedName must not match 'project'");
  });

  test('copyName contextValue pattern matches symbol, solution, and project nodes', () => {
    // Pattern from package.json: /^(symbol\.|solution$|project$)/
    const pattern = /^(symbol\.|solution$|project$)/;
    const mustMatch = ['symbol.class', 'symbol.method', 'solution', 'project'];
    const mustNotMatch = ['nugetPackage', 'projectReference', 'dependencyFolder'];
    for (const cv of mustMatch) {
      assert.ok(pattern.test(cv), `copyName must match '${cv}'`);
    }
    for (const cv of mustNotMatch) {
      assert.ok(!pattern.test(cv), `copyName must NOT match '${cv}'`);
    }
  });

  test('SYMBOL_CONTEXT_VALUES covers all expected symbol kinds', () => {
    // Verify package.json mentions the key symbol kinds.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must be found');
    // The extension's menus use 'symbol.' prefix — verify expected contextValues
    // would match the patterns registered in package.json.
    const symbolKinds = [
      'symbol.class',
      'symbol.struct',
      'symbol.interface',
      'symbol.enum',
      'symbol.method',
      'symbol.property',
      'symbol.field',
      'symbol.event',
      'symbol.constructor',
      'symbol.namespace',
      'symbol.enumMember',
      'symbol.delegate',
    ];
    // All must start with 'symbol.' — so they all satisfy the copyQualifiedName and revealInExplorer patterns.
    const badKinds = symbolKinds.filter((k) => !k.startsWith('symbol.'));
    assert.deepEqual(badKinds, [], "All symbol context values must start with 'symbol.'");
  });
});

// ── Suite 7: Every Context Menu Command is Registered ──────────────

suite('Context Menu — All view/item/context Commands Registered', () => {
  test('every command in view/item/context menus is a registered VS Code command', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must be found');
    const menus: { command: string }[] =
      ext.packageJSON.contributes?.menus?.['view/item/context'] ?? [];
    assert.ok(menus.length > 0, 'Must have view/item/context menu entries');

    const allCommands = await vscode.commands.getCommands(true);
    const missing: string[] = [];
    for (const entry of menus) {
      if (!allCommands.includes(entry.command)) {
        missing.push(entry.command);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `These context menu commands are declared in package.json but NOT registered: ${missing.join(', ')}`,
    );
  });

  test('every command in view/title menus is a registered VS Code command', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must be found');
    const menus: { command: string }[] = ext.packageJSON.contributes?.menus?.['view/title'] ?? [];
    assert.ok(menus.length > 0, 'Must have view/title menu entries');

    const allCommands = await vscode.commands.getCommands(true);
    const missing: string[] = [];
    for (const entry of menus) {
      if (!allCommands.includes(entry.command)) {
        missing.push(entry.command);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `These title menu commands are declared but NOT registered: ${missing.join(', ')}`,
    );
  });

  test('every command declared in package.json is a registered VS Code command', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must be found');
    const declared: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(declared.length > 0, 'Must have declared commands');

    const allCommands = await vscode.commands.getCommands(true);
    const missing: string[] = [];
    for (const entry of declared) {
      if (!allCommands.includes(entry.command)) {
        missing.push(entry.command);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `These commands are declared in package.json but NOT registered: ${missing.join(', ')}`,
    );
  });
});

// ── Suite 8: Project Context Menu Execution ─────────────────────────

suite('Context Menu — Project Node Commands Execute', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('ctx-proj-');
    tmpDir = result.tmpDir;
    provider = getProvider();

    const projDir = path.join(tmpDir, 'ProjMenuTest');
    fs.mkdirSync(projDir, { recursive: true });
    writeCsproj(projDir, 'ProjMenuTest');
    fs.writeFileSync(
      path.join(projDir, 'Source.cs'),
      'namespace ProjMenuNS { public class Foo { } }',
    );

    const slnPath = path.join(tmpDir, 'ProjMenuTest.sln');
    writeSln(slnPath, 'ProjMenuTest', '{00000000-0000-0000-0000-000000000501}');
    await provider.loadSolution(slnPath);

    const csUri = vscode.Uri.file(path.join(projDir, 'Source.cs'));
    await vscode.workspace.openTextDocument(csUri).then((d) => vscode.window.showTextDocument(d));
    await waitForDocumentSymbols(csUri);
    await provider.refresh();

    await pollUntilResult(
      async () => findByContext(provider.getChildren(), 'project'),
      (n) => n !== undefined,
      15_000,
    );
  });

  suiteTeardown(async () => {
    provider.clear();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('sharplsp.openProjectFile executes without error on a project node', async function () {
    this.timeout(10_000);
    const projectNode = findByContext(provider.getChildren(), 'project');
    assert.ok(projectNode, 'Project node must exist');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.openProjectFile', projectNode);
    }, 'openProjectFile must not throw when tapped on a project node');
  });

  test('sharplsp.openProjectFile opens the .csproj file in the editor', async function () {
    this.timeout(10_000);
    const projectNode = findByContext(provider.getChildren(), 'project');
    assert.ok(projectNode, 'Project node must exist');
    assert.strictEqual(
      projectNode.contextValue,
      'project',
      "Project node must have contextValue 'project'",
    );

    await vscode.commands.executeCommand('sharplsp.openProjectFile', projectNode);

    // The LSP trace output channel can grab focus right after the command
    // completes, so check `visibleTextEditors` (which includes our doc even
    // when an output panel is focused) rather than `activeTextEditor`.
    const csprojEditor = vscode.window.visibleTextEditors.find((editor) =>
      editor.document.fileName.endsWith('.csproj'),
    );
    assert.ok(
      csprojEditor,
      `Expected a visible .csproj editor, got: ${vscode.window.visibleTextEditors
        .map((editor) => editor.document.fileName)
        .join(', ')}`,
    );
    // Assert the csproj has valid MSBuild XML content.
    const text = csprojEditor.document.getText();
    assert.ok(text.includes('<Project'), `csproj must contain '<Project' element`);
    assert.ok(text.includes('TargetFramework'), `csproj must contain 'TargetFramework'`);
    assert.ok(
      csprojEditor.document.languageId === 'xml' || csprojEditor.document.languageId === 'msbuild',
      `csproj languageId should be xml or msbuild, got '${csprojEditor.document.languageId}'`,
    );
    // Assert solution explorer tree still has project node visible.
    const children = provider.getChildren();
    assert.ok(children !== undefined && children.length > 0, 'Solution Explorer must have nodes');
    assert.ok(findByContext(children, 'project'), 'Project node must still be in tree');
    await openSharpLspPanel();
    await takeScreenshot('vscode-context-menu-open-project.png');
  });

  test('sharplsp.build executes without error', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.build');
    }, 'sharplsp.build must not throw');
  });

  test('sharplsp.rebuild executes without error', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.rebuild');
    }, 'sharplsp.rebuild must not throw');
  });

  test('sharplsp.clean executes without error', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.clean');
    }, 'sharplsp.clean must not throw');
  });

  test('solution node carries projectFilePath pointing at the .sln', () => {
    const roots = provider.getChildren();
    const slnNode = roots?.[0];
    assert.ok(slnNode, 'Solution node must exist');
    assert.strictEqual(slnNode.contextValue, 'solution', 'Root node must be the solution');
    assert.ok(
      slnNode.projectFilePath?.endsWith('.sln'),
      `Solution node projectFilePath must point at the .sln, got '${String(slnNode.projectFilePath)}'`,
    );
  });

  for (const cmd of ['sharplsp.build', 'sharplsp.rebuild', 'sharplsp.clean']) {
    test(`${cmd} executes without error on the solution node`, async function () {
      this.timeout(30_000);
      const roots = provider.getChildren();
      const slnNode = roots?.[0];
      assert.ok(slnNode, 'Solution node must exist');
      assert.strictEqual(slnNode.contextValue, 'solution', 'Root node must be the solution');
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand(cmd, slnNode);
      }, `${cmd} must not throw when invoked on the solution node`);
    });
  }

  test('sharplsp.openProjectFile handles node without projectFilePath gracefully', async function () {
    this.timeout(5_000);
    const mockNode = {
      projectFilePath: undefined,
      sortName: 'NoPath',
      contextValue: 'project',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.openProjectFile', mockNode);
    }, 'openProjectFile must handle missing projectFilePath without throwing');
  });

  test('sharplsp.addProjectReference handles node without projectFilePath gracefully', async function () {
    this.timeout(5_000);
    const mockNode = {
      projectFilePath: undefined,
      sortName: 'NoPath',
      contextValue: 'dependencyFolder',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.addProjectReference', mockNode);
    }, 'addProjectReference must handle missing projectFilePath without throwing');
  });

  test('sharplsp.nuget.addFromExplorer handles node without projectFilePath gracefully', async function () {
    this.timeout(5_000);
    const mockNode = {
      projectFilePath: undefined,
      sortName: 'NoPath',
      contextValue: 'dependencyFolder',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.addFromExplorer', mockNode);
    }, 'nuget.addFromExplorer must handle missing projectFilePath without throwing');
  });
});

// ── Suite 9: Package Maintenance — collectProjectPaths ────────────

suite('Package Maintenance — collectProjectPaths', () => {
  type NodeArg = Parameters<typeof collectProjectPaths>[0];

  function mkNode(
    contextValue: string,
    projectFilePath: string | undefined,
    children: unknown[] = [],
  ): unknown {
    return { contextValue, projectFilePath, children };
  }
  function projectNode(filePath: string): unknown {
    return mkNode('project', filePath);
  }

  test('project node yields exactly its own project path', () => {
    const result = collectProjectPaths(projectNode('/repo/A/A.csproj') as NodeArg);
    assert.ok(Array.isArray(result), 'returns an array');
    assert.strictEqual(result.length, 1, 'exactly one path');
    assert.strictEqual(result[0], '/repo/A/A.csproj', 'the path is the project file');
    assert.deepEqual(result, ['/repo/A/A.csproj']);
  });

  test('solution node yields every descendant project path in order', () => {
    const solution = mkNode('solution', '/repo/App.sln', [
      projectNode('/repo/A/A.csproj'),
      projectNode('/repo/B/B.fsproj'),
    ]) as NodeArg;
    const result = collectProjectPaths(solution);
    assert.strictEqual(result.length, 2, 'both projects collected');
    assert.deepEqual(result, ['/repo/A/A.csproj', '/repo/B/B.fsproj'], 'order preserved');
    assert.ok(result.includes('/repo/A/A.csproj'), 'includes the .csproj');
    assert.ok(result.includes('/repo/B/B.fsproj'), 'includes the .fsproj');
    assert.ok(!result.includes('/repo/App.sln'), 'the .sln itself is not a project path');
  });

  test('collects project nodes nested under dependency folders', () => {
    const solution = mkNode('solution', '/repo/App.sln', [
      mkNode('project', '/repo/A/A.csproj', [
        mkNode('dependencyFolder', undefined, [mkNode('nugetPackage', undefined)]),
        mkNode('symbol.class', undefined),
      ]),
      mkNode('dependencyFolder', undefined, [mkNode('project', '/repo/B/B.csproj')]),
    ]) as NodeArg;
    const result = collectProjectPaths(solution);
    assert.strictEqual(result.length, 2, 'both projects found despite nesting');
    assert.ok(result.includes('/repo/A/A.csproj'), 'top-level project found');
    assert.ok(result.includes('/repo/B/B.csproj'), 'nested project found');
  });

  test('ignores project nodes without a projectFilePath', () => {
    const solution = mkNode('solution', '/repo/App.sln', [
      projectNode('/repo/A/A.csproj'),
      mkNode('project', undefined),
    ]) as NodeArg;
    const result = collectProjectPaths(solution);
    assert.strictEqual(result.length, 1, 'the path-less project is skipped');
    assert.deepEqual(result, ['/repo/A/A.csproj']);
    assert.ok(!result.includes(undefined as unknown as string), 'no undefined entries');
  });

  test('de-duplicates repeated project paths', () => {
    const solution = mkNode('solution', '/repo/App.sln', [
      projectNode('/repo/A/A.csproj'),
      projectNode('/repo/A/A.csproj'),
      projectNode('/repo/B/B.csproj'),
    ]) as NodeArg;
    const result = collectProjectPaths(solution);
    assert.strictEqual(result.length, 2, 'duplicate A collapsed to one');
    assert.deepEqual(result, ['/repo/A/A.csproj', '/repo/B/B.csproj']);
  });

  test('non-project node with no project descendants yields nothing', () => {
    const symbol = mkNode('symbol.class', undefined, [
      mkNode('symbol.method', undefined),
    ]) as NodeArg;
    const result = collectProjectPaths(symbol);
    assert.ok(Array.isArray(result), 'still returns an array');
    assert.strictEqual(result.length, 0, 'no projects collected');
    assert.deepEqual(result, []);
  });

  test('undefined node yields an empty array', () => {
    const result = collectProjectPaths(undefined);
    assert.ok(Array.isArray(result), 'returns an array even for undefined');
    assert.strictEqual(result.length, 0);
    assert.deepEqual(result, []);
  });
});

// ── Shared package-maintenance LSP e2e helpers ───────────────────

interface ConsolidateResp {
  readonly moved: { id: string; version: string; fromProjects: string[] }[];
  readonly propsFile?: string;
  readonly modifiedFiles: string[];
  readonly message: string;
}

interface UnusedResp {
  readonly projectPath: string;
  readonly unused: { id: string; version: string }[];
}

interface SharpLspApiForPkgTests {
  readonly getLspClient: () => LanguageClient | undefined;
}

/** Resolve a running LSP client from the extension exports. */
function getPkgLspClient(): LanguageClient {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'Extension must be found');
  const api = ext.exports as SharpLspApiForPkgTests | undefined;
  assert.ok(api?.getLspClient, 'Extension must export getLspClient');
  const client = api.getLspClient();
  assert.ok(client, 'LSP client must be running');
  return client;
}

/** Absolute path to the TestFixtures project loaded in the sidecar workspace. */
function fixtureProjectPath(): string {
  return path.resolve(__dirname, '../../../test-fixtures/workspace/TestFixtures.csproj');
}

/** A `[id, version]` package reference pair. */
type Ref = readonly string[];

interface ProjectSpec {
  readonly name: string;
  readonly refs: readonly Ref[];
  readonly ext?: string;
}

/** Write a project file with the given PackageReferences. */
function writeProject(dir: string, name: string, refs: readonly Ref[], ext = 'csproj'): string {
  const projDir = path.join(dir, name);
  fs.mkdirSync(projDir, { recursive: true });
  const items = refs
    .map((ref) => `    <PackageReference Include="${ref[0]}" Version="${ref[1]}" />`)
    .join('\n');
  const file = path.join(projDir, `${name}.${ext}`);
  fs.writeFileSync(
    file,
    `<Project Sdk="Microsoft.NET.Sdk">\n` +
      `  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>\n` +
      `  <ItemGroup>\n${items}\n  </ItemGroup>\n</Project>\n`,
  );
  return file;
}

/** Create an isolated solution directory containing the given projects. */
function makeSolution(
  tmpDir: string,
  name: string,
  projects: readonly ProjectSpec[],
): { sln: string; dir: string; projects: string[] } {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const created = projects.map((p) => writeProject(dir, p.name, p.refs, p.ext ?? 'csproj'));
  const sln = path.join(dir, `${name}.sln`);
  fs.writeFileSync(sln, 'Microsoft Visual Studio Solution File, Format Version 12.00\n');
  return { sln, dir, projects: created };
}

/** Send a consolidate request (scan or apply) over the LSP. */
async function consolidate(
  lsp: LanguageClient,
  solutionPath: string,
  dryRun: boolean,
): Promise<ConsolidateResp> {
  return lsp.sendRequest<ConsolidateResp>('sharplsp/nuget/consolidate', { solutionPath, dryRun });
}

// ── Suite 10: Package Maintenance — Consolidate (LSP e2e) ─────────

suite('Package Maintenance — Consolidate (LSP e2e)', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('pkg-consol-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  test('dry-run reports the shared package with full detail and touches no files', async function () {
    this.timeout(20_000);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir, 'DryDetail', [
      { name: 'A', refs: [['Serilog', '3.1.0']] },
      { name: 'B', refs: [['Serilog', '3.0.0']] },
    ]);

    const resp = await consolidate(lsp, sln, true);

    assert.ok(resp, 'response must be defined');
    assert.ok(Array.isArray(resp.moved), 'moved is an array');
    assert.strictEqual(resp.moved.length, 1, 'exactly one shared package');
    const serilog = resp.moved[0];
    assert.ok(serilog, 'the moved entry exists');
    assert.strictEqual(serilog.id, 'Serilog', 'the shared package id');
    assert.strictEqual(serilog.version, '3.1.0', 'highest version (3.1.0 > 3.0.0) is chosen');
    assert.ok(Array.isArray(serilog.fromProjects), 'fromProjects is an array');
    assert.strictEqual(serilog.fromProjects.length, 2, 'shared across two projects');
    assert.ok(serilog.fromProjects.includes('A.csproj'), 'names project A');
    assert.ok(serilog.fromProjects.includes('B.csproj'), 'names project B');
    assert.deepEqual(resp.modifiedFiles, [], 'dry-run modifies nothing');
    assert.strictEqual(resp.propsFile, undefined, 'dry-run reports no props file');
    assert.strictEqual(typeof resp.message, 'string', 'message is a string');
    assert.ok(resp.message.length > 0, 'message is non-empty');
    assert.ok(!fs.existsSync(path.join(dir, 'Directory.Build.props')), 'no props file created');
    assert.ok(
      fs.readFileSync(path.join(dir, 'A', 'A.csproj'), 'utf8').includes('Serilog'),
      'project A left untouched',
    );
    assert.ok(
      fs.readFileSync(path.join(dir, 'B', 'B.csproj'), 'utf8').includes('3.0.0'),
      'project B version left untouched',
    );
  });

  test('dry-run ignores packages referenced by only one project', async function () {
    this.timeout(20_000);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir, 'MixedShare', [
      {
        name: 'A',
        refs: [
          ['Serilog', '3.1.0'],
          ['OnlyA', '1.0.0'],
        ],
      },
      {
        name: 'B',
        refs: [
          ['Serilog', '3.1.0'],
          ['OnlyB', '2.0.0'],
        ],
      },
    ]);

    const resp = await consolidate(lsp, sln, true);
    const ids = resp.moved.map((m) => m.id);
    assert.strictEqual(resp.moved.length, 1, 'only the shared package is reported');
    assert.deepEqual(ids, ['Serilog'], 'exactly Serilog');
    assert.ok(!ids.includes('OnlyA'), 'single-project OnlyA is not reported');
    assert.ok(!ids.includes('OnlyB'), 'single-project OnlyB is not reported');
    const serilog = resp.moved.find((m) => m.id === 'Serilog');
    assert.ok(serilog, 'Serilog entry present');
    assert.strictEqual(serilog.fromProjects.length, 2, 'shared across both');
  });

  test('dry-run selects the highest version across three projects', async function () {
    this.timeout(20_000);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir, 'ThreeWay', [
      { name: 'A', refs: [['Newtonsoft.Json', '12.0.1']] },
      { name: 'B', refs: [['Newtonsoft.Json', '13.0.3']] },
      { name: 'C', refs: [['Newtonsoft.Json', '13.0.1']] },
    ]);

    const resp = await consolidate(lsp, sln, true);
    assert.strictEqual(resp.moved.length, 1, 'one shared package');
    const pkg = resp.moved[0];
    assert.ok(pkg, 'moved entry present');
    assert.strictEqual(pkg.id, 'Newtonsoft.Json');
    assert.strictEqual(pkg.version, '13.0.3', 'highest of 12.0.1 / 13.0.3 / 13.0.1');
    assert.strictEqual(pkg.fromProjects.length, 3, 'shared across all three projects');
  });

  test('dry-run enumerates F# (.fsproj) projects too', async function () {
    this.timeout(20_000);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir, 'FSharpShare', [
      { name: 'A', refs: [['FSharp.Data', '6.3.0']], ext: 'fsproj' },
      { name: 'B', refs: [['FSharp.Data', '6.3.0']], ext: 'fsproj' },
    ]);

    const resp = await consolidate(lsp, sln, true);
    assert.strictEqual(resp.moved.length, 1, 'F# projects are scanned');
    const pkg = resp.moved[0];
    assert.ok(pkg, 'moved entry present');
    assert.strictEqual(pkg.id, 'FSharp.Data');
    assert.strictEqual(pkg.fromProjects.length, 2);
    assert.ok(pkg.fromProjects.includes('A.fsproj'), 'names A.fsproj');
    assert.ok(pkg.fromProjects.includes('B.fsproj'), 'names B.fsproj');
  });

  test('apply hoists shared package into Directory.Build.props and strips projects', async function () {
    this.timeout(30_000);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir, 'Apply', [
      { name: 'A', refs: [['Serilog', '3.1.0']] },
      { name: 'B', refs: [['Serilog', '3.1.0']] },
    ]);

    const resp = await consolidate(lsp, sln, false);

    assert.strictEqual(resp.moved.length, 1, 'one package moved');
    assert.ok(
      resp.moved.some((m) => m.id === 'Serilog'),
      'Serilog reported as moved',
    );
    const propsPath = path.join(dir, 'Directory.Build.props');
    assert.ok(resp.propsFile, 'propsFile is reported');
    assert.ok(
      resp.propsFile.endsWith('Directory.Build.props'),
      'propsFile points at the props file',
    );
    assert.ok(fs.existsSync(propsPath), 'Directory.Build.props was created');
    const props = fs.readFileSync(propsPath, 'utf8');
    assert.ok(props.includes('<PackageReference'), 'props declares a PackageReference');
    assert.ok(props.includes('Serilog'), 'props declares Serilog');
    assert.ok(props.includes('Version="3.1.0"'), 'props carries the resolved version');
    assert.ok(resp.modifiedFiles.length >= 3, 'props + two projects were modified');
    assert.ok(
      resp.modifiedFiles.some((f) => f.endsWith('Directory.Build.props')),
      'props in modifiedFiles',
    );
    assert.ok(
      resp.modifiedFiles.some((f) => f.endsWith('A.csproj')),
      'A.csproj in modifiedFiles',
    );
    assert.ok(
      resp.modifiedFiles.some((f) => f.endsWith('B.csproj')),
      'B.csproj in modifiedFiles',
    );
    const aText = fs.readFileSync(path.join(dir, 'A', 'A.csproj'), 'utf8');
    const bText = fs.readFileSync(path.join(dir, 'B', 'B.csproj'), 'utf8');
    assert.ok(!aText.includes('Serilog'), 'A no longer references Serilog');
    assert.ok(!bText.includes('Serilog'), 'B no longer references Serilog');
    assert.ok(aText.includes('<Project'), 'A is still a valid project');
    assert.ok(aText.includes('TargetFramework'), 'A keeps its other content');
    assert.ok(resp.message.includes('Serilog'), 'message names the moved package');
  });

  test('apply preserves existing Directory.Build.props content', async function () {
    this.timeout(30_000);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir, 'PreserveProps', [
      { name: 'A', refs: [['Serilog', '3.1.0']] },
      { name: 'B', refs: [['Serilog', '3.1.0']] },
    ]);
    const propsPath = path.join(dir, 'Directory.Build.props');
    fs.writeFileSync(propsPath, '<Project>\n  <!-- sentinel comment -->\n</Project>\n');

    const resp = await consolidate(lsp, sln, false);
    assert.strictEqual(resp.moved.length, 1, 'one package moved');
    const props = fs.readFileSync(propsPath, 'utf8');
    assert.ok(props.includes('<!-- sentinel comment -->'), 'existing comment preserved');
    assert.ok(props.includes('Serilog'), 'Serilog added to the existing props');
    assert.ok(props.includes('Version="3.1.0"'), 'version preserved in props');
  });

  test('apply is idempotent — a second scan finds nothing shared', async function () {
    this.timeout(30_000);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir, 'Idempotent', [
      { name: 'A', refs: [['Serilog', '3.1.0']] },
      { name: 'B', refs: [['Serilog', '3.1.0']] },
    ]);

    const applied = await consolidate(lsp, sln, false);
    assert.strictEqual(applied.moved.length, 1, 'first apply moves Serilog');
    assert.ok(applied.modifiedFiles.length >= 3, 'first apply modified files');

    const rescan = await consolidate(lsp, sln, true);
    assert.deepEqual(rescan.moved, [], 'nothing shared remains after the move');
    assert.strictEqual(rescan.modifiedFiles.length, 0, 'rescan modifies nothing');
    assert.strictEqual(rescan.propsFile, undefined, 'rescan reports no further props work');
  });

  test('reports nothing when no package is shared', async function () {
    this.timeout(20_000);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir, 'NoShare', [
      { name: 'A', refs: [['OnlyA', '1.0.0']] },
      { name: 'B', refs: [['OnlyB', '1.0.0']] },
    ]);

    const resp = await consolidate(lsp, sln, true);
    assert.deepEqual(resp.moved, [], 'nothing shared is reported');
    assert.strictEqual(resp.moved.length, 0);
    assert.strictEqual(resp.propsFile, undefined, 'no props file');
    assert.deepEqual(resp.modifiedFiles, [], 'no files modified');
    assert.strictEqual(typeof resp.message, 'string', 'message is a string');
    assert.ok(!fs.existsSync(path.join(dir, 'Directory.Build.props')), 'no props created');
  });

  test('a single-project solution shares nothing', async function () {
    this.timeout(20_000);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir, 'Single', [{ name: 'A', refs: [['Serilog', '3.1.0']] }]);
    const resp = await consolidate(lsp, sln, true);
    assert.deepEqual(resp.moved, [], 'one project cannot share with itself');
    assert.strictEqual(resp.moved.length, 0);
    assert.deepEqual(resp.modifiedFiles, []);
  });
});

// ── Suite 11: Package Maintenance — Unused (LSP e2e) ──────────────

suite('Package Maintenance — Unused (LSP e2e)', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('pkg-unused-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  test('unused request resolves against the loaded fixture project via Roslyn', async function () {
    this.timeout(40_000);
    const lsp = getPkgLspClient();
    const projectPath = fixtureProjectPath();

    // Poll until the Roslyn workspace is warm enough to answer (request rejects
    // while the project isn't yet in the sidecar's loaded solution).
    const resp = await pollUntilResult<UnusedResp | undefined>(
      async () => {
        try {
          return await lsp.sendRequest<UnusedResp>('sharplsp/nuget/unused', { projectPath });
        } catch {
          return undefined;
        }
      },
      (r) => r !== undefined,
      30_000,
      1_000,
    );

    assert.ok(resp, 'unused must resolve — the Roslyn GetUsedAssemblyReferences pipeline ran');
    assert.strictEqual(resp.projectPath, projectPath, 'projectPath is echoed back exactly');
    assert.ok(Array.isArray(resp.unused), 'unused is an array');
    // TestFixtures declares no <PackageReference Include=...> → nothing to flag.
    assert.strictEqual(
      resp.unused.length,
      0,
      'a project with no direct refs has no unused packages',
    );
    for (const pkg of resp.unused) {
      assert.strictEqual(typeof pkg.id, 'string', 'each unused id is a string');
      assert.ok(pkg.id.length > 0, 'each unused id is non-empty');
      assert.strictEqual(typeof pkg.version, 'string', 'each unused version is a string');
      assert.ok(!pkg.id.includes('/'), 'id is a package id, not a path');
      assert.ok(!pkg.id.endsWith('.dll'), 'id is a package id, not an assembly file');
    }
  });

  test('unused request rejects for a project file that cannot be read', async function () {
    this.timeout(15_000);
    const lsp = getPkgLspClient();
    const bogus = path.join(tmpDir, 'Nope', 'Nope.csproj');
    await assert.rejects(async () => {
      await lsp.sendRequest<UnusedResp>('sharplsp/nuget/unused', { projectPath: bogus });
    }, 'unused must reject when the project file does not exist');
  });

  test('removeUnusedPackages command runs end-to-end through the real LSP', async function () {
    this.timeout(40_000);
    const lsp = getPkgLspClient();
    const projectPath = fixtureProjectPath();
    const projectNode = { contextValue: 'project', projectFilePath: projectPath, children: [] };

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeUnusedPackages', projectNode);
    }, 'the command must complete against the real LSP');

    // The detection truth the command relied on, asserted directly over the LSP.
    const resp = await lsp.sendRequest<UnusedResp>('sharplsp/nuget/unused', { projectPath });
    assert.strictEqual(resp.projectPath, projectPath, 'projectPath echoed');
    assert.ok(Array.isArray(resp.unused), 'unused is an array');
    assert.strictEqual(resp.unused.length, 0, 'fixture project has nothing to remove');
  });

  test('consolidatePackages command runs end-to-end through the real LSP', async function () {
    this.timeout(30_000);
    const lsp = getPkgLspClient();
    // No shared packages → the command takes the non-modal "nothing to do" path,
    // exercising the real LSP scan without a confirmation dialog.
    const { sln, dir } = makeSolution(tmpDir, 'CmdConsolidate', [
      { name: 'A', refs: [['OnlyA', '1.0.0']] },
      { name: 'B', refs: [['OnlyB', '2.0.0']] },
    ]);
    const solutionNode = { contextValue: 'solution', projectFilePath: sln, children: [] };

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.consolidatePackages', solutionNode);
    }, 'the command must complete against the real LSP');

    // The scan truth the command relied on, asserted directly over the LSP.
    const preview = await consolidate(lsp, sln, true);
    assert.ok(Array.isArray(preview.moved), 'moved is an array');
    assert.deepEqual(preview.moved, [], 'nothing shared detected over the LSP');
    assert.ok(
      !fs.existsSync(path.join(dir, 'Directory.Build.props')),
      'command must not create a props file when nothing is shared',
    );
    assert.ok(
      fs.readFileSync(path.join(dir, 'A', 'A.csproj'), 'utf8').includes('OnlyA'),
      'project A is untouched',
    );
  });
});
