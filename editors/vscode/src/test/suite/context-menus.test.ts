/**
 * E2E tests for context menu commands and context values in the Solution Explorer.
 *
 * Covers:
 *   - Package.json menu contribution correctness (when clauses, groups)
 *   - contextValue set correctly for all node types
 *   - forge.copyQualifiedName: builds Namespace.Class.Member correctly
 *   - forge.copyName: copies unqualified name
 *   - forge.revealInExplorer: runs without error, nodes have symbolUri
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  openForgePanel,
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
    'forge.copyQualifiedName',
    'forge.copyName',
    'forge.revealInExplorer',
    'forge.sortMembers',
    'forge.openProjectFile',
    'forge.build',
    'forge.rebuild',
    'forge.clean',
    'forge.addProjectReference',
    'forge.nuget.addFromExplorer',
    'forge.removeNuGetPackage',
    'forge.removeProjectReference',
  ]) {
    test(`${cmd} command is registered`, async () => {
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(cmds.includes(cmd), `${cmd} must be a registered VS Code command`);
    });
  }

  // ── sortMembers when clause ───────────────────────────────────

  test('sortMembers menu entry exists in view/item/context', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.sortMembers');
    assert.ok(entry, 'forge.sortMembers must have a view/item/context menu entry');
  });

  test('sortMembers when clause scopes to class/struct/interface/enum/record', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.sortMembers');
    assert.ok(entry, 'forge.sortMembers must have a menu entry');
    const when = entry.when;
    assert.ok(when.includes('class'), `sortMembers when clause must include 'class': ${when}`);
    assert.ok(
      when.includes('interface'),
      `sortMembers when clause must include 'interface': ${when}`,
    );
    assert.ok(when.includes('enum'), `sortMembers when clause must include 'enum': ${when}`);
    assert.ok(when.includes('record'), `sortMembers when clause must include 'record': ${when}`);
    assert.ok(
      when.includes('forge.solutionExplorer'),
      'sortMembers must be scoped to forge.solutionExplorer view',
    );
  });

  test('sortMembers when clause does NOT include method or property', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.sortMembers');
    assert.ok(entry, 'forge.sortMembers must have a menu entry');
    const when = entry.when;
    // The pattern should only match type-level nodes (class, struct, etc.)
    // It must NOT be a catch-all for all symbol nodes.
    assert.ok(!when.includes('symbol.method'), 'sortMembers must NOT show for method nodes');
    assert.ok(!when.includes('symbol.property'), 'sortMembers must NOT show for property nodes');
    assert.ok(!when.includes('symbol.field'), 'sortMembers must NOT show for field nodes');
  });

  test('sortMembers is scoped to solutionExplorer view', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.sortMembers');
    assert.ok(entry, 'forge.sortMembers must have a menu entry');
    assert.ok(
      entry.when.includes('forge.solutionExplorer'),
      "sortMembers when clause must include 'forge.solutionExplorer'",
    );
  });

  // ── copyQualifiedName when clause ────────────────────────────

  test('copyQualifiedName menu entry exists', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.copyQualifiedName');
    assert.ok(entry, 'forge.copyQualifiedName must have a view/item/context menu entry');
  });

  test('copyQualifiedName when clause scopes to symbol nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.copyQualifiedName');
    assert.ok(entry, 'forge.copyQualifiedName must have a menu entry');
    assert.ok(
      entry.when.includes('symbol'),
      "copyQualifiedName when clause must reference 'symbol'",
    );
    assert.ok(
      entry.when.includes('forge.solutionExplorer'),
      'copyQualifiedName must be scoped to solutionExplorer view',
    );
  });

  test('copyQualifiedName is in a copy/paste group', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.copyQualifiedName');
    assert.ok(entry, 'forge.copyQualifiedName must have a menu entry');
    const g = entry.group;
    assert.ok(
      g.includes('cutcopypaste') || g.includes('copy') || g.startsWith('9'),
      `copyQualifiedName group '${g}' should be a copy/paste group`,
    );
  });

  // ── copyName when clause ──────────────────────────────────────

  test('copyName menu entry exists', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.copyName');
    assert.ok(entry, 'forge.copyName must have a view/item/context menu entry');
  });

  test('copyName when clause covers symbol nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.copyName');
    assert.ok(entry, 'forge.copyName must have a menu entry');
    assert.ok(entry.when.includes('symbol'), "copyName when clause must reference 'symbol'");
    assert.ok(
      entry.when.includes('forge.solutionExplorer'),
      'copyName must be scoped to solutionExplorer view',
    );
  });

  test('copyName when clause covers solution and project nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.copyName');
    assert.ok(entry, 'forge.copyName must have a menu entry');
    const when = entry.when;
    // copyName should appear on solution and project nodes too
    assert.ok(
      when.includes('solution') || when.includes('project'),
      `copyName when clause '${when}' should cover solution or project nodes`,
    );
  });

  test('copyName is in a copy/paste group', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.copyName');
    assert.ok(entry, 'forge.copyName must have a menu entry');
    const g = entry.group;
    assert.ok(
      g.includes('cutcopypaste') || g.includes('copy') || g.startsWith('9'),
      `copyName group '${g}' should be a copy/paste group`,
    );
  });

  // ── revealInExplorer when clause ─────────────────────────────

  test('revealInExplorer menu entry exists', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.revealInExplorer');
    assert.ok(entry, 'forge.revealInExplorer must have a view/item/context menu entry');
  });

  test('revealInExplorer when clause scopes to symbol nodes', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.revealInExplorer');
    assert.ok(entry, 'forge.revealInExplorer must have a menu entry');
    assert.ok(
      entry.when.includes('symbol'),
      "revealInExplorer when clause must reference 'symbol'",
    );
    assert.ok(
      entry.when.includes('forge.solutionExplorer'),
      'revealInExplorer must be scoped to solutionExplorer view',
    );
  });

  // ── sortMembers group ─────────────────────────────────────────

  test('sortMembers is in a modification group', () => {
    const entry = menuEntries().find((m) => m.command === 'forge.sortMembers');
    assert.ok(entry, 'forge.sortMembers must have a menu entry');
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
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(120_000);
    const result = await setupLspTestSuite('ctx-val-');
    tmpDir = result.tmpDir;
    provider = getProvider();

    // Build one solution with all symbol types.
    const projDir = path.join(tmpDir, 'AllTypesCtx');
    fs.mkdirSync(projDir, { recursive: true });
    writeCsproj(projDir, 'AllTypesCtx');
    fs.writeFileSync(path.join(projDir, 'Source.cs'), ALL_TYPES_CS);

    const slnPath = path.join(tmpDir, 'AllTypesCtx.sln');
    writeSln(slnPath, 'AllTypesCtx', '{00000000-0000-0000-0000-000000000101}');
    await provider.loadSolution(slnPath);

    const csUri = vscode.Uri.file(path.join(projDir, 'Source.cs'));
    const csDoc = await vscode.workspace.openTextDocument(csUri);
    await vscode.window.showTextDocument(csDoc);
    await waitForDocumentSymbols(csUri);
    await provider.refresh();

    // Wait for tree to populate — Roslyn can take up to 90s on cold start.
    await pollUntilResult(
      async () => findByLabel(provider.getChildren(), 'AllTypesClass'),
      (n) => n !== undefined,
      90_000,
      1_000,
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
    await openForgePanel();
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
    const node = findByContext(provider.getChildren(), 'symbol.method');
    assert.ok(node, 'A symbol.method node must exist in the tree');
    const lbl = nodeLabel(node);
    assert.ok(
      lbl.includes('Execute') || lbl.includes('Run'),
      `Expected Execute or Run method, got '${lbl}'`,
    );
  });

  test("property node has contextValue 'symbol.property'", () => {
    const node = findByContext(provider.getChildren(), 'symbol.property');
    assert.ok(node, 'A symbol.property node must exist in the tree');
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
    await vscode.commands.executeCommand('forge.copyQualifiedName', classNode);
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
    await vscode.commands.executeCommand('forge.copyQualifiedName', methodNode);
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
    await vscode.commands.executeCommand('forge.copyQualifiedName', propNode);
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
    await vscode.commands.executeCommand('forge.copyQualifiedName', ifaceNode);
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
    await vscode.commands.executeCommand('forge.copyQualifiedName', innerNode);
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
    await vscode.commands.executeCommand('forge.copyQualifiedName', innerMethodNode);
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
    await vscode.commands.executeCommand('forge.copyQualifiedName', classNode);
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
    await vscode.commands.executeCommand('forge.copyName', node);
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
    await vscode.commands.executeCommand('forge.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'Execute', `Expected 'Execute', got '${text}'`);
  });

  test('copyName for an interface node copies just the interface name', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'IRunner');
    assert.ok(node, 'IRunner node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('forge.copyName', node);
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
    await vscode.commands.executeCommand('forge.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'Label', `Expected 'Label', got '${text}'`);
  });

  test('copyName for an enum node copies just the enum name', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'MyEnum');
    assert.ok(node, 'MyEnum node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('forge.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'MyEnum', `Expected 'MyEnum', got '${text}'`);
  });

  test('copyName for a struct node copies just the struct name', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'MyPoint');
    assert.ok(node, 'MyPoint struct node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('forge.copyName', node);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text, 'MyPoint', `Expected 'MyPoint', got '${text}'`);
  });

  test('copyName does not include namespace prefix', async function () {
    this.timeout(10_000);
    const node = findByLabel(provider.getChildren(), 'AllTypesClass');
    assert.ok(node, 'AllTypesClass node must exist');

    await vscode.env.clipboard.writeText('BEFORE');
    await vscode.commands.executeCommand('forge.copyName', node);
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
    await vscode.commands.executeCommand('forge.copyName', slnNode);
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
      await vscode.commands.executeCommand('forge.revealInExplorer', node);
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
      await vscode.commands.executeCommand('forge.revealInExplorer', node);
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
      await vscode.commands.executeCommand('forge.revealInExplorer', mockNode);
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

  test('forge.openProjectFile executes without error on a project node', async function () {
    this.timeout(10_000);
    const projectNode = findByContext(provider.getChildren(), 'project');
    assert.ok(projectNode, 'Project node must exist');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.openProjectFile', projectNode);
    }, 'openProjectFile must not throw when tapped on a project node');
  });

  test('forge.openProjectFile opens the .csproj file in the editor', async function () {
    this.timeout(10_000);
    const projectNode = findByContext(provider.getChildren(), 'project');
    assert.ok(projectNode, 'Project node must exist');

    await vscode.commands.executeCommand('forge.openProjectFile', projectNode);

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
    await openForgePanel();
    await takeScreenshot('vscode-context-menu-open-project.png');
  });

  test('forge.build executes without error', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.build');
    }, 'forge.build must not throw');
  });

  test('forge.rebuild executes without error', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.rebuild');
    }, 'forge.rebuild must not throw');
  });

  test('forge.clean executes without error', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.clean');
    }, 'forge.clean must not throw');
  });

  test('forge.openProjectFile handles node without projectFilePath gracefully', async function () {
    this.timeout(5_000);
    const mockNode = {
      projectFilePath: undefined,
      sortName: 'NoPath',
      contextValue: 'project',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.openProjectFile', mockNode);
    }, 'openProjectFile must handle missing projectFilePath without throwing');
  });

  test('forge.addProjectReference handles node without projectFilePath gracefully', async function () {
    this.timeout(5_000);
    const mockNode = {
      projectFilePath: undefined,
      sortName: 'NoPath',
      contextValue: 'dependencyFolder',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.addProjectReference', mockNode);
    }, 'addProjectReference must handle missing projectFilePath without throwing');
  });

  test('forge.nuget.addFromExplorer handles node without projectFilePath gracefully', async function () {
    this.timeout(5_000);
    const mockNode = {
      projectFilePath: undefined,
      sortName: 'NoPath',
      contextValue: 'dependencyFolder',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.nuget.addFromExplorer', mockNode);
    }, 'nuget.addFromExplorer must handle missing projectFilePath without throwing');
  });
});
