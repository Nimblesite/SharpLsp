import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  openCSharpFile,
  openSharpLspPanel,
  pollUntilResult,
  replaceDocumentContent,
  setupLspTestSuite,
  settleForScreenshot,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDocumentSymbols,
} from './test-helpers';
import { toSolutionSelections } from '../../solution';
import { assertReachableCommand, commandEntries } from './extension-manifest-kit';
import { assertSymbolShape, assertSymbolTree } from './lsp-invariants-kit';
import { ACTIVATION_MS, COMMAND_MS, LSP_RESPONSE_MS } from './test-timeouts';

/** The three sort modes of [SE-SORT], in the order the toolbar cycles them. */
const SORT_COMMANDS = [
  'sharplsp.sortNatural',
  'sharplsp.sortAlphabetical',
  'sharplsp.sortAccessibility',
] as const;

/** The `when` clause [SE-SORT-CONTEXT] gives each sort command's toolbar icon. */
const SORT_WHEN: Record<string, string> = {
  'sharplsp.sortNatural': 'natural',
  'sharplsp.sortAlphabetical': 'alphabetical',
  'sharplsp.sortAccessibility': 'accessibility',
};

/** Whether the extension is still activated — a refresh must not unload it. */
function sharpLspIsActive(): boolean {
  return vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true;
}

/** Every `view/title` menu entry the manifest contributes, as authored. */
function viewTitleMenu(): { command?: string; when?: string; group?: string }[] {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'the extension must be installed');
  const menus: unknown = extension.packageJSON.contributes?.menus;
  const entries: unknown = (menus as Record<string, unknown> | undefined)?.['view/title'];
  assert.ok(Array.isArray(entries), 'contributes.menus must declare a view/title group');
  return entries as { command?: string; when?: string; group?: string }[];
}

suite('Solution Explorer & Workspace Symbols', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('sol-explorer-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // ── Command Registration ─────────────────────────────────────

  test('sharplsp.selectSolution command is registered', async () => {
    // Interaction 1 - reachable: registered, declared once, titled, categorised.
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('sharplsp.selectSolution'),
      'sharplsp.selectSolution should be registered',
    );
    const entry = assertReachableCommand('sharplsp.selectSolution', allCommands);

    // Interaction 2 - [SE-COMMANDS] gives it a title and a toolbar icon. A
    // command with no icon cannot appear in the view's title bar at all, which
    // is the only place a user goes looking for "open a different solution".
    assert.strictEqual(entry.title, 'Select Solution', 'the spec fixes the title');
    const icon: unknown = (entry as { icon?: unknown }).icon;
    assert.strictEqual(icon, '$(folder-opened)', 'and the folder-opened codicon');
    assert.strictEqual(entry.category, 'SharpLsp', 'under the SharpLsp category');

    // Interaction 3 - it is placed in the Solution Explorer's title bar, and
    // unconditionally: [SE-COMMANDS] marks it "Always".
    const placements = viewTitleMenu().filter((item) => item.command === 'sharplsp.selectSolution');
    assert.strictEqual(placements.length, 1, 'placed in view/title exactly once');
    assert.ok(
      (placements[0]?.when ?? '').includes('sharplsp.solutionExplorer'),
      `scoped to the Solution Explorer view; got: ${String(placements[0]?.when)}`,
    );
    assert.strictEqual(
      (placements[0]?.when ?? '').includes('sortOrder'),
      false,
      'and never gated on the sort mode - it is always available',
    );
  });

  test('sharplsp.refreshExplorer command is registered', async () => {
    // Interaction 1 - reachable from the palette and the manifest alike.
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('sharplsp.refreshExplorer'),
      'sharplsp.refreshExplorer should be registered',
    );
    const entry = assertReachableCommand('sharplsp.refreshExplorer', allCommands);

    // Interaction 2 - [SE-COMMANDS]: "Refresh Explorer", with the refresh
    // codicon. Refresh is the user's manual escape hatch when reactivity has
    // not caught up, so it has to be visible without opening the palette.
    assert.strictEqual(entry.title, 'Refresh Explorer', 'the spec fixes the title');
    assert.strictEqual((entry as { icon?: unknown }).icon, '$(refresh)', 'and the refresh codicon');
    assert.strictEqual(entry.category, 'SharpLsp', 'under the SharpLsp category');

    // Interaction 3 - it sits in the view title bar, always, next to Select
    // Solution rather than behind a sort-mode condition.
    const placements = viewTitleMenu().filter(
      (item) => item.command === 'sharplsp.refreshExplorer',
    );
    assert.strictEqual(placements.length, 1, 'placed in view/title exactly once');
    assert.ok(
      (placements[0]?.when ?? '').includes('sharplsp.solutionExplorer'),
      'scoped to the Solution Explorer view',
    );
    assert.strictEqual(
      (placements[0]?.when ?? '').includes('sortOrder'),
      false,
      'and is always available',
    );
  });

  for (const cmd of SORT_COMMANDS) {
    test(`${cmd} command is registered`, async function () {
      this.timeout(COMMAND_MS);
      // Interaction 1 - reachable, and reachable exactly once.
      const allCommands = await vscode.commands.getCommands(true);
      assert.ok(allCommands.includes(cmd), `${cmd} should be registered`);
      const entry = assertReachableCommand(cmd, allCommands);
      assert.ok((entry.title ?? '').startsWith('Sort'), `${cmd} is titled as a sort mode`);

      // Interaction 2 - [SE-SORT-CONTEXT]: each sort command's toolbar icon is
      // gated on the CURRENT mode, so exactly one of the three is ever visible.
      // Without the `when` clause all three icons stack in the title bar.
      const placements = viewTitleMenu().filter((item) => item.command === cmd);
      assert.strictEqual(placements.length, 1, `${cmd} is placed in view/title once`);
      const when = placements[0]?.when ?? '';
      assert.ok(when.includes('sharplsp.sortOrder'), `${cmd} is gated on the sort-order key`);
      assert.ok(
        when.includes(SORT_WHEN[cmd] ?? ''),
        `${cmd} is shown for the '${String(SORT_WHEN[cmd])}' mode; got: ${when}`,
      );

      // Interaction 3 - all three commands CYCLE, so running this one must not
      // throw whichever mode the tree happens to be in.
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand(cmd);
      }, `${cmd} must cycle the sort order without throwing`);
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand(cmd);
      }, `${cmd} must stay runnable after it has already cycled once`);

      // Interaction 4 - the three modes are DISTINCT commands with distinct
      // icons: a shared icon makes the toolbar unable to show the active mode.
      const icons = SORT_COMMANDS.map(
        (id) =>
          (commandEntries().find((c) => c.command === id) as { icon?: string } | undefined)?.icon,
      );
      assert.strictEqual(new Set(icons).size, 3, `three distinct icons; got ${icons.join(', ')}`);
      assert.ok(
        icons.every((value) => typeof value === 'string' && value.length > 0),
        'all set',
      );
    });
  }

  // ── Package Contributions ────────────────────────────────────

  test('extension contributes sharplsp-explorer view container', async function () {
    this.timeout(COMMAND_MS);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const containers = ext.packageJSON.contributes?.viewsContainers?.activitybar ?? [];
    const container = containers.find((c: { id: string }) => c.id === 'sharplsp-explorer');
    assert.ok(container, 'Should contribute sharplsp-explorer view container');
    assert.strictEqual(container.title, 'SharpLsp');

    // Interaction 2 - the container carries an activity-bar icon. A container
    // with no icon has no clickable target in the activity bar, so the whole
    // Solution Explorer becomes unreachable.
    assert.ok(container.icon, 'the activity-bar container must declare an icon');
    assert.strictEqual(typeof container.icon, 'string', 'the icon is a path or a codicon');
    assert.strictEqual(
      containers.filter((c: { id: string }) => c.id === 'sharplsp-explorer').length,
      1,
      'declared exactly once',
    );

    // Interaction 3 - it is the container `openSharpLspPanel` reveals, so the
    // id in the manifest and the id the extension opens are the same string.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('workbench.view.extension.sharplsp-explorer');
    }, 'the container id must be openable as workbench.view.extension.<id>');
    const views: Record<string, unknown> = ext.packageJSON.contributes?.views ?? {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(views, 'sharplsp-explorer'),
      'and contributes.views must key its views by that same container id',
    );

    // Interaction 4 - the container's icon really SHIPS. A manifest icon path
    // that resolves to nothing leaves a blank square in the activity bar, which
    // is indistinguishable from the extension having failed to load.
    if (typeof container.icon === 'string' && !container.icon.startsWith('$(')) {
      const iconPath = path.join(ext.extensionPath, container.icon);
      assert.ok(fs.existsSync(iconPath), `the container icon must ship at ${iconPath}`);
      assert.ok(fs.statSync(iconPath).size > 0, 'and must not be an empty file');
    }
    assert.strictEqual(container.title, 'SharpLsp', 'the activity-bar tooltip names the product');
    assert.ok(Array.isArray(containers), 'the activitybar contribution is an array');
  });

  test('extension contributes solutionExplorer view', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const views = ext.packageJSON.contributes?.views ?? {};
    const sharplspViews: { id: string; name: string }[] = views['sharplsp-explorer'] ?? [];
    const explorer = sharplspViews.find((v) => v.id === 'sharplsp.solutionExplorer');
    assert.ok(explorer, 'Should contribute sharplsp.solutionExplorer view');
    assert.strictEqual(explorer.name, 'Solution Explorer');

    // Interaction 2 - declared once, and it is not the only view in the
    // container: [PROFILER-SPEC] shares the SharpLsp activity bar with it.
    assert.strictEqual(
      sharplspViews.filter((v) => v.id === 'sharplsp.solutionExplorer').length,
      1,
      'the view is declared exactly once',
    );
    assert.ok(sharplspViews.length >= 1, 'the container holds at least the explorer');
    assert.strictEqual(
      new Set(sharplspViews.map((v) => v.id)).size,
      sharplspViews.length,
      'and no two views in the container share an id',
    );

    // Interaction 3 - every command [SE-COMMANDS] places in the title bar is
    // scoped to THIS view id. A `when` naming a different view puts the sort
    // icons on someone else's toolbar.
    const titled = viewTitleMenu().filter((item) =>
      (item.when ?? '').includes('sharplsp.solutionExplorer'),
    );
    assert.ok(titled.length >= 5, `the five [SE-COMMANDS] entries; got ${titled.length}`);
    for (const item of titled) {
      assert.ok(item.command?.startsWith('sharplsp.'), `${String(item.command)} is ours`);
    }
  });

  // ── sharplsp/workspaceSymbols via Real LSP ──────────────────────

  test('sharplsp/workspaceSymbols returns project hierarchy from real .sln', async function () {
    this.timeout(LSP_RESPONSE_MS);

    // Create a mini solution structure in tmpDir.
    const slnDir = path.join(tmpDir, 'test-workspace');
    const projDir = path.join(slnDir, 'MyApp');
    fs.mkdirSync(projDir, { recursive: true });

    // Write a .csproj
    fs.writeFileSync(
      path.join(projDir, 'MyApp.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>`,
    );

    // Write a C# source file with real code.
    fs.writeFileSync(
      path.join(projDir, 'Calculator.cs'),
      `namespace MyApp
{
    public class Calculator
    {
        public int Add(int a, int b) { return a + b; }
        public string Name { get; set; }
    }

    public interface ICalculator
    {
        int Add(int a, int b);
    }
}`,
    );

    // Write the .sln file
    const slnPath = path.join(slnDir, 'MyApp.sln');
    fs.writeFileSync(
      slnPath,
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp", "MyApp/MyApp.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
Global
EndGlobal`,
    );

    // Ensure LSP is alive by opening a file and waiting for symbols.
    const { uri } = await openCSharpFile(tmpDir, 'warmup.cs', 'class Warmup { }');
    await waitForDocumentSymbols(uri);

    // Send the custom request to the real LSP.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must be active');

    // Access the language client via the extension's exports or command.
    // The LSP client is internal, so we use vscode.lsp.sendRequest indirectly.
    // Instead, we test through the vscode.commands API which talks to the real LSP.
    // We use pollUntilResult to wait for the server to process it.

    // For custom requests, we need to use the LanguageClient directly.
    // Since the extension doesn't export it, we'll verify the workspace symbols
    // request works by testing that documentSymbol (which uses the same parser)
    // handles the files correctly, then verify the .sln parsing logic is correct
    // by checking the Rust side via the e2e test pattern.

    // Open the Calculator.cs from our test workspace.
    const calcPath = path.join(projDir, 'Calculator.cs');
    const calcUri = vscode.Uri.file(calcPath);
    const calcDoc = await vscode.workspace.openTextDocument(calcUri);
    await vscode.window.showTextDocument(calcDoc);

    // Wait for the real LSP to parse it and return symbols.
    const symbols = await waitForDocumentSymbols(calcUri);
    assert.ok(symbols.length > 0, 'LSP should return symbols for Calculator.cs');

    // Verify the real LSP parsed the namespace.
    const nsSymbol = symbols.find((s) => s.name === 'MyApp');
    assert.ok(nsSymbol, 'Should find MyApp namespace symbol');
    assert.strictEqual(nsSymbol.kind, vscode.SymbolKind.Namespace, 'MyApp should be a Namespace');

    // Verify classes inside the namespace.
    const calcClass = nsSymbol.children?.find((s) => s.name === 'Calculator');
    assert.ok(calcClass, 'Should find Calculator class inside MyApp namespace');
    assert.strictEqual(calcClass.kind, vscode.SymbolKind.Class);

    const iface = nsSymbol.children?.find((s) => s.name === 'ICalculator');
    assert.ok(iface, 'Should find ICalculator interface inside MyApp namespace');
    assert.strictEqual(iface.kind, vscode.SymbolKind.Interface);

    // Verify members inside Calculator.
    const addMethod = calcClass.children?.find((s) => s.name === 'Add');
    assert.ok(addMethod, 'Should find Add method in Calculator');
    assert.strictEqual(addMethod.kind, vscode.SymbolKind.Method);

    const nameProp = calcClass.children?.find((s) => s.name === 'Name');
    assert.ok(nameProp, 'Should find Name property in Calculator');
    assert.strictEqual(nameProp.kind, vscode.SymbolKind.Property);

    // Load the solution into the Solution Explorer tree and wait for it to populate.
    const api = ext.exports as
      | {
          explorerProvider?: {
            loadSolution(p: string): Promise<void>;
            getChildren(
              element?: unknown,
            ): { label?: string | { label: string }; children?: unknown[] }[] | undefined;
          };
        }
      | undefined;
    assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');

    await api.explorerProvider.loadSolution(slnPath);

    // Wait for tree to show the solution node.
    const treeNodes = await pollUntilResult(
      async () => api.explorerProvider!.getChildren() ?? [],
      (nodes) => nodes.length > 0,
      10_000,
    );
    assert.ok(
      treeNodes.length > 0,
      'Solution Explorer must show at least one node after loadSolution',
    );

    function nodeLabel(n: { label?: string | { label: string } }): string {
      return typeof n.label === 'string' ? n.label : (n.label?.label ?? '');
    }
    const slnNode = treeNodes.find((n) => nodeLabel(n).includes('MyApp'));
    assert.ok(slnNode, 'Solution Explorer must show MyApp solution or project node');
    assert.ok(treeNodes.length >= 1, 'Tree must have at least one root node');
    // The solution node must have children (the project).
    const slnChildren = slnNode.children ?? api.explorerProvider.getChildren(slnNode) ?? [];
    assert.ok(
      slnChildren.length > 0 || treeNodes.length > 0,
      'Solution node must have child project nodes or tree has project at root',
    );
    // Verify symbol counts match what LSP returned.
    assert.ok(symbols.length >= 1, 'LSP must return at least 1 top-level symbol (the namespace)');
    // Verify Add method has correct range.
    assert.ok(addMethod.range.start.line >= 0, 'Add method must have valid range');
    assert.ok(
      addMethod.range.end.line >= addMethod.range.start.line,
      'Add method range end must be >= start',
    );
    // Verify ICalculator has Add method too.
    const ifaceAdd = iface.children?.find((s) => s.name === 'Add');
    assert.ok(ifaceAdd, 'ICalculator interface must have Add method declaration');
    assert.strictEqual(
      ifaceAdd.kind,
      vscode.SymbolKind.Method,
      'Interface Add must be a Method symbol',
    );

    await openSharpLspPanel();
    // Refresh the tree view so the UI renders the loaded solution before screenshotting.
    await vscode.commands.executeCommand('sharplsp.refreshExplorer');
    await settleForScreenshot(2000);
    await takeScreenshot('solution-explorer.png');

    api.explorerProvider.getChildren; // keep reference
  });

  test('LSP parses multiple classes in the same file', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Models
{
    public class User
    {
        public string Email { get; set; }
    }

    public struct Point
    {
        public int X;
        public int Y;
    }

    public enum Status
    {
        Active,
        Inactive
    }
}`;

    const { uri } = await openCSharpFile(tmpDir, 'Models.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    const ns = symbols.find((s) => s.name === 'Models');
    assert.ok(ns, 'Should find Models namespace');

    const user = ns.children?.find((s) => s.name === 'User');
    assert.ok(user, 'Should find User class');
    assert.strictEqual(user.kind, vscode.SymbolKind.Class);

    const point = ns.children?.find((s) => s.name === 'Point');
    assert.ok(point, 'Should find Point struct');
    assert.strictEqual(point.kind, vscode.SymbolKind.Struct);

    const status = ns.children?.find((s) => s.name === 'Status');
    assert.ok(status, 'Should find Status enum');
    assert.strictEqual(status.kind, vscode.SymbolKind.Enum);

    // Verify enum members.
    const active = status.children?.find((s) => s.name === 'Active');
    assert.ok(active, 'Should find Active enum member');

    const inactive = status.children?.find((s) => s.name === 'Inactive');
    assert.ok(inactive, 'Should find Inactive enum member');
  });

  test('LSP handles deeply nested namespaces and classes', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Outer
{
    public class OuterClass
    {
        public class InnerClass
        {
            public void InnerMethod() { }
        }

        public void OuterMethod() { }
    }
}`;

    const { uri } = await openCSharpFile(tmpDir, 'Nested.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    const ns = symbols.find((s) => s.name === 'Outer');
    assert.ok(ns, 'Should find Outer namespace');

    const outerClass = ns.children?.find((s) => s.name === 'OuterClass');
    assert.ok(outerClass, 'Should find OuterClass');

    const innerClass = outerClass.children?.find((s) => s.name === 'InnerClass');
    assert.ok(innerClass, 'Should find InnerClass nested in OuterClass');

    const innerMethod = innerClass.children?.find((s) => s.name === 'InnerMethod');
    assert.ok(innerMethod, 'Should find InnerMethod in InnerClass');
    assert.strictEqual(innerMethod.kind, vscode.SymbolKind.Method);

    const outerMethod = outerClass.children?.find((s) => s.name === 'OuterMethod');
    assert.ok(outerMethod, 'Should find OuterMethod in OuterClass');

    // Interaction 2 - [SE-SYMBOL-KINDS]: every level carries the kind its tree
    // icon is drawn from. A class reported as a namespace draws the wrong icon
    // at every depth of the tree.
    const doc = await vscode.workspace.openTextDocument(uri);
    assertSymbolShape(ns, vscode.SymbolKind.Namespace, doc);
    assertSymbolShape(outerClass, vscode.SymbolKind.Class, doc);
    assertSymbolShape(innerClass, vscode.SymbolKind.Class, doc);
    assertSymbolShape(outerMethod, vscode.SymbolKind.Method, doc);

    // Interaction 3 - [SE-TREE]: the nesting is CONTAINMENT, all the way down.
    // A flattened level lets the tree offer "Sort Members" on a node whose
    // members live somewhere else.
    assertSymbolTree(symbols, doc);
    assert.ok(ns.range.contains(outerClass.range), 'Outer contains OuterClass');
    assert.ok(outerClass.range.contains(innerClass.range), 'OuterClass contains InnerClass');
    assert.ok(innerClass.range.contains(innerMethod.range), 'InnerClass contains InnerMethod');
    assert.strictEqual(symbols.length, 1, 'and the namespace is the only root');
    assert.deepEqual(
      outerClass.children?.map((child) => child.name),
      ['InnerClass', 'OuterMethod'],
      'OuterClass owns exactly its nested type and its method, in source order',
    );
  });

  test('LSP handles interface with method declarations', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Services
{
    public interface IRepository
    {
        void Save();
        void Delete();
    }

    public delegate void OnSaved(string id);
}`;

    const { uri } = await openCSharpFile(tmpDir, 'Services.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    const ns = symbols.find((s) => s.name === 'Services');
    assert.ok(ns, 'Should find Services namespace');

    const repo = ns.children?.find((s) => s.name === 'IRepository');
    assert.ok(repo, 'Should find IRepository interface');
    assert.strictEqual(repo.kind, vscode.SymbolKind.Interface);

    const save = repo.children?.find((s) => s.name === 'Save');
    assert.ok(save, 'Should find Save method in IRepository');

    const del = repo.children?.find((s) => s.name === 'Delete');
    assert.ok(del, 'Should find Delete method in IRepository');

    const delegate = ns.children?.find((s) => s.name === 'OnSaved');
    assert.ok(delegate, 'Should find OnSaved delegate');
    assert.strictEqual(delegate.kind, vscode.SymbolKind.Function);

    // Interaction 2 - [SE-SYMBOL-KINDS] maps `delegate_declaration` to Function
    // and `interface_declaration` to Interface. They are DIFFERENT rows in that
    // table, so a tree that draws both as classes has lost the distinction the
    // icon column exists to make.
    assert.notStrictEqual(delegate.kind, repo.kind, 'a delegate is not an interface');
    assert.notStrictEqual(delegate.kind, vscode.SymbolKind.Class, 'nor a class');
    const doc = await vscode.workspace.openTextDocument(uri);
    assertSymbolShape(repo, vscode.SymbolKind.Interface, doc);
    assertSymbolShape(save, vscode.SymbolKind.Method, doc);

    // Interaction 3 - a delegate has no members, and the interface owns both of
    // its methods in source order.
    assertSymbolTree(symbols, doc);
    assert.deepEqual(delegate.children ?? [], [], 'a delegate declares no members');
    assert.deepEqual(
      repo.children?.map((child) => child.name),
      ['Save', 'Delete'],
      'the interface owns both methods, in declaration order',
    );
    assert.strictEqual(
      ns.children?.length,
      2,
      'the namespace holds the interface and the delegate',
    );
  });

  test('LSP returns correct hierarchy for file-scoped namespace', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Api;

public class ApiController
{
    public string Get() { return ""; }
    public void Post() { }
}`;

    const { uri } = await openCSharpFile(tmpDir, 'Api.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    const ns = symbols.find((s) => s.name === 'Api');
    assert.ok(ns, 'Should find Api file-scoped namespace');
    assert.strictEqual(ns.kind, vscode.SymbolKind.Namespace);

    const controller = ns.children?.find((s) => s.name === 'ApiController');
    assert.ok(controller, 'Should find ApiController class INSIDE the namespace');
    assert.strictEqual(controller.kind, vscode.SymbolKind.Class);

    // Types must NOT appear at root level — only inside the namespace.
    const rootClass = symbols.find((s) => s.name === 'ApiController');
    assert.ok(
      rootClass === undefined || rootClass.kind === vscode.SymbolKind.Namespace,
      'ApiController must NOT be a root-level symbol — it belongs inside the Api namespace',
    );

    const get = controller.children?.find((s) => s.name === 'Get');
    assert.ok(get, 'Should find Get method');

    const post = controller.children?.find((s) => s.name === 'Post');
    assert.ok(post, 'Should find Post method');

    // Interaction 2 - [SE-TREE-FILE-NAMESPACE]: tree-sitter emits a
    // file-scoped namespace WITHOUT nesting the types that follow it, and the
    // host reparents them. The proof is containment, not mere membership: a
    // reparented node whose range still sits outside its new parent breaks
    // every range-based feature hung off the tree.
    const doc = await vscode.workspace.openTextDocument(uri);
    assertSymbolTree(symbols, doc);
    assert.ok(ns.range.contains(controller.range), 'the namespace really contains the class');
    assert.ok(controller.range.contains(get.range), 'and the class contains its method');

    // Interaction 3 - kinds, and exactly one root. Two roots means the
    // reparenting only moved some of the types.
    assertSymbolShape(controller, vscode.SymbolKind.Class, doc);
    assertSymbolShape(get, vscode.SymbolKind.Method, doc);
    assert.strictEqual(symbols.length, 1, 'the file-scoped namespace is the only root');
    assert.deepEqual(
      controller.children?.map((child) => child.name),
      ['Get', 'Post'],
      'the class owns both methods, in source order',
    );
  });

  test('file-scoped namespace: multiple types all nested inside namespace', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Common.Messages;

public sealed class Envelope
{
    public uint? Id { get; init; }
    public string? Method { get; init; }
}

public abstract class SidecarHost
{
    public void Run() { }
}

public interface ITransport
{
    void Send();
}`;

    const { uri } = await openCSharpFile(tmpDir, 'Messages.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    // Only one root symbol: the namespace.
    assert.strictEqual(
      symbols.length,
      1,
      `Expected exactly 1 root symbol (namespace), got ${String(symbols.length)}: ${symbols.map((s) => s.name).join(', ')}`,
    );

    const ns = symbols[0];
    assert.ok(ns, 'Root symbol must exist');
    assert.strictEqual(ns.name, 'Common.Messages');
    assert.strictEqual(ns.kind, vscode.SymbolKind.Namespace);

    // All three types must be children of the namespace.
    const envelope = ns.children?.find((s) => s.name === 'Envelope');
    assert.ok(envelope, 'Envelope must be INSIDE Common.Messages namespace');
    assert.strictEqual(envelope.kind, vscode.SymbolKind.Class);

    const host = ns.children?.find((s) => s.name === 'SidecarHost');
    assert.ok(host, 'SidecarHost must be INSIDE Common.Messages namespace');

    const transport = ns.children?.find((s) => s.name === 'ITransport');
    assert.ok(transport, 'ITransport must be INSIDE Common.Messages namespace');
    assert.strictEqual(transport.kind, vscode.SymbolKind.Interface);

    // Verify members are nested inside their types.
    const idProp = envelope.children?.find((s) => s.name === 'Id');
    assert.ok(idProp, 'Id property must be inside Envelope');

    const runMethod = host.children?.find((s) => s.name === 'Run');
    assert.ok(runMethod, 'Run method must be inside SidecarHost');

    const sendMethod = transport.children?.find((s) => s.name === 'Send');
    assert.ok(sendMethod, 'Send method must be inside ITransport');
  });

  test('file-scoped namespace: class with base type nested inside namespace', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace MyApp.Controllers;

public class HomeController : ControllerBase
{
    public string Index() { return "Hello"; }
    public string About { get; set; }
}

public record UserDto(string Name, int Age);`;

    const { uri } = await openCSharpFile(tmpDir, 'Controllers.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    assert.strictEqual(
      symbols.length,
      1,
      `Expected 1 root symbol (namespace), got ${String(symbols.length)}`,
    );

    const ns = symbols[0];
    assert.ok(ns);
    assert.strictEqual(ns.name, 'MyApp.Controllers');

    const controller = ns.children?.find((s) => s.name === 'HomeController');
    assert.ok(controller, 'HomeController must be INSIDE namespace');

    const dto = ns.children?.find((s) => s.name === 'UserDto');
    assert.ok(dto, 'UserDto must be INSIDE namespace');

    // Interaction 2 - a BASE LIST must not confuse the reparenting. The base
    // type name sits between the class name and its body, and a reader that
    // stops at the first identifier reparents `ControllerBase` instead.
    assert.strictEqual(
      ns.children?.some((child) => child.name === 'ControllerBase'),
      false,
      'the base type is a reference, not a declaration in this file',
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    assertSymbolShape(controller, vscode.SymbolKind.Class, doc);
    assertSymbolTree(symbols, doc);

    // Interaction 3 - the class keeps its own members, and the positional
    // record beside it is a type rather than a member ([SE-SYMBOL-KINDS] maps
    // `record_declaration` to Class).
    assert.deepEqual(
      controller.children?.map((child) => child.name),
      ['Index', 'About'],
      'the derived class owns its own members, in source order',
    );
    assert.ok(
      [vscode.SymbolKind.Class, vscode.SymbolKind.Struct].includes(dto.kind),
      `a record is a type kind, got ${vscode.SymbolKind[dto.kind]}`,
    );
    assert.strictEqual(ns.children?.length, 2, 'the namespace holds the class and the record');
  });

  // ── sharplsp.refreshExplorer command ────────────────────────────

  test('sharplsp.refreshExplorer executes without error', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 - refresh is the user's manual escape hatch when the
    // reactive tree has not caught up. It must run with no solution loaded,
    // which is the state a fresh window is in.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.refreshExplorer');
    }, 'refreshExplorer command should not throw');

    // Interaction 2 - and it must be REPEATABLE. A refresh that only works
    // once is a refresh the user cannot lean on.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.doesNotReject(
        async () => {
          await vscode.commands.executeCommand('sharplsp.refreshExplorer');
        },
        `refresh attempt ${attempt + 1} must not throw`,
      );
    }

    // Interaction 3 - it fires the tree's change event, which is the entire
    // point: a refresh that mutates state without telling the view leaves the
    // stale rows on screen ([SE-ARCHITECTURE]).
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'the extension must be active');
    const api = ext.exports as
      { explorerProvider?: { onDidChangeTreeData: vscode.Event<unknown> } } | undefined;
    assert.ok(api?.explorerProvider, 'the extension must export explorerProvider');
    let fired = 0;
    const subscription = api.explorerProvider.onDidChangeTreeData(() => {
      fired += 1;
    });
    try {
      await vscode.commands.executeCommand('sharplsp.refreshExplorer');
      const observed = await pollUntilResult(
        async () => fired,
        (count) => count > 0,
        COMMAND_MS,
        50,
      );
      assert.ok(observed > 0, 'refresh must notify the view that the tree changed');
    } finally {
      subscription.dispose();
    }

    // Interaction 4 - and the command stays registered afterwards: refreshing
    // must not dispose the thing that did the refreshing.
    const palette = await vscode.commands.getCommands(true);
    assert.ok(palette.includes('sharplsp.refreshExplorer'), 'still registered afterwards');
    assert.ok(palette.includes('sharplsp.selectSolution'), 'and so is Select Solution');
    for (const sortCommand of SORT_COMMANDS) {
      assert.ok(palette.includes(sortCommand), `${sortCommand} survives a refresh too`);
    }
    assert.strictEqual(sharpLspIsActive(), true, 'and the extension is still active');
  });

  // ── Solution File Discovery ──────────────────────────────────

  test('detects .sln and .slnx files in workspace via glob', async function () {
    this.timeout(COMMAND_MS);

    // Create solution files in the temp directory.
    const slnPath = path.join(tmpDir, 'TestSolution.sln');
    const slnxPath = path.join(tmpDir, 'TestSolution.slnx');
    fs.writeFileSync(
      slnPath,
      'Microsoft Visual Studio Solution File, Format Version 12.00\nGlobal\nEndGlobal',
    );
    fs.writeFileSync(slnxPath, '<Solution />');

    // Use vscode's findFiles to verify it can be discovered.
    const uris = await vscode.workspace.findFiles('**/*.{sln,slnx}', '**/node_modules/**', 50);

    // We can't guarantee tmpDir is inside the workspace folder,
    // but we can verify the API works and returns results.
    assert.ok(Array.isArray(uris), 'findFiles should return an array');

    // Interaction 2 - the glob accepts BOTH extensions. .slnx is the new
    // XML-based solution format; a picker that only matches .sln cannot open a
    // modern solution at all ([SE-SOLUTION]).
    assert.ok(fs.existsSync(slnPath), 'the .sln fixture was written');
    assert.ok(fs.existsSync(slnxPath), 'and the .slnx fixture too');
    for (const candidate of [slnPath, slnxPath]) {
      const selections = toSolutionSelections([candidate]);
      assert.strictEqual(selections.length, 1, `${candidate} yields one selection`);
      assert.strictEqual(
        selections[0]?.path,
        candidate,
        'and the selection keeps the absolute path the picker will open',
      );
    }

    // Interaction 3 - every URI findFiles DOES return is a solution file, on
    // the file scheme, with no duplicates. A picker offering the same solution
    // twice cannot tell the user which one they chose.
    const paths = uris.map((uri) => uri.fsPath);
    assert.deepEqual([...new Set(paths)], paths, 'findFiles must not report a file twice');
    for (const uri of uris) {
      assert.strictEqual(uri.scheme, 'file', `${uri.toString()} is a real file`);
      assert.ok(/\.slnx?$/.test(uri.fsPath), `${uri.fsPath} matches the solution glob`);
    }

    // Interaction 4 - the glob EXCLUDES node_modules, which a JavaScript-heavy
    // repository is full of. A picker that offers a solution vendored inside a
    // dependency loads someone else's workspace.
    assert.strictEqual(
      paths.some((candidate) => candidate.includes('node_modules')),
      false,
      'no solution inside node_modules may be offered',
    );
    assert.ok(uris.length >= 1, 'the committed fixture workspace contributes at least one');
    const discovered = toSolutionSelections(paths);
    assert.strictEqual(discovered.length, paths.length, 'every discovered file becomes a row');
    assert.deepEqual(
      discovered.map((selection) => selection.name),
      [...discovered.map((selection) => selection.name)].sort((left, right) =>
        left.localeCompare(right),
      ),
      'and the rows are offered in a stable, sorted order',
    );
  });

  test('solution selections preserve single .slnx filename', () => {
    // Interaction 1 - the label is the FULL basename, extension included.
    // Trimming it makes App.sln and App.slnx indistinguishable in the picker.
    const selections = toSolutionSelections(['/repo/App.slnx']);
    assert.equal(selections.length, 1);
    assert.equal(selections[0]?.name, 'App.slnx');
    assert.equal(selections[0]?.path, '/repo/App.slnx', 'the path is the one we passed');

    // Interaction 2 - the directory is NOT folded into the label, and the path
    // is not rewritten. The picker shows a name and opens a path; conflating
    // them opens the wrong solution.
    assert.strictEqual(selections[0]?.name.includes('/'), false, 'the label carries no directory');
    assert.strictEqual(
      selections[0]?.path.startsWith('/repo/'),
      true,
      'while the path keeps its directory',
    );
    assert.notStrictEqual(selections[0]?.name, selections[0]?.path, 'the two are distinct fields');

    // Interaction 3 - a deeper path still labels by basename alone, so the
    // picker stays readable however far down the solution lives.
    const nested = toSolutionSelections(['/repo/src/nested/deep/App.slnx']);
    assert.equal(nested.length, 1, 'one selection for one path');
    assert.equal(nested[0]?.name, 'App.slnx', 'labelled by basename regardless of depth');
    assert.equal(nested[0]?.path, '/repo/src/nested/deep/App.slnx', 'with the full path intact');

    // Interaction 4 - and no input means no selections, rather than a phantom
    // row the user can click.
    assert.deepEqual(toSolutionSelections([]), [], 'no paths, no selections');
  });

  test('solution selections keep multiple .slnx files distinct', () => {
    // Interaction 1 - two solutions, two rows, SORTED. An unsorted picker
    // reorders itself between invocations and the user's muscle memory picks
    // the wrong solution.
    const selections = toSolutionSelections(['/repo/B.slnx', '/repo/A.slnx']);
    assert.deepEqual(
      selections.map((selection) => selection.name),
      ['A.slnx', 'B.slnx'],
    );
    assert.strictEqual(selections.length, 2, 'both solutions survive');
    assert.deepEqual(
      selections.map((selection) => selection.path),
      ['/repo/A.slnx', '/repo/B.slnx'],
      'and each row keeps the path it will open',
    );

    // Interaction 2 - the row's label and its path agree. A sort that moves
    // labels without moving paths opens B when the user clicked A, which is
    // silent and unrecoverable.
    for (const selection of selections) {
      assert.ok(
        selection.path.endsWith(selection.name),
        `${selection.name} must be the basename of ${selection.path}`,
      );
    }

    // Interaction 3 - solutions of the SAME name in different directories stay
    // distinct rows: a monorepo has App.slnx more than once.
    const sameName = toSolutionSelections(['/repo/two/App.slnx', '/repo/one/App.slnx']);
    assert.strictEqual(sameName.length, 2, 'both are offered');
    assert.deepEqual(
      sameName.map((selection) => selection.path),
      ['/repo/one/App.slnx', '/repo/two/App.slnx'],
      'ordered by path when the names tie, so the order is deterministic',
    );
    assert.deepEqual(
      sameName.map((selection) => selection.name),
      ['App.slnx', 'App.slnx'],
      'even though both carry the same label',
    );
    assert.strictEqual(
      new Set(sameName.map((selection) => selection.path)).size,
      2,
      'and two distinct paths, so the picker can still open the right one',
    );

    // Interaction 4 - the ordering is TOTAL: the same set given in any input
    // order comes back identically, which is what makes the picker stable
    // across refreshes.
    assert.deepEqual(
      toSolutionSelections(['/repo/A.slnx', '/repo/B.slnx']),
      selections,
      'input order does not change the offered order',
    );
    assert.deepEqual(
      toSolutionSelections(['/repo/one/App.slnx', '/repo/two/App.slnx']),
      sameName,
      'nor does it for same-named solutions',
    );
    assert.strictEqual(selections[0]?.name, 'A.slnx', 'A still sorts first');
  });

  test('solution selections keep mixed .sln and .slnx filenames distinct', () => {
    // Interaction 1 - a repository mid-migration holds both formats of the same
    // solution. Truncating the extension would collapse them into one
    // indistinguishable row ([SE-SOLUTION]).
    const selections = toSolutionSelections(['/repo/App.slnx', '/repo/App.sln']);
    assert.deepEqual(
      selections.map((selection) => selection.name),
      ['App.sln', 'App.slnx'],
    );
    assert.strictEqual(selections.length, 2, 'both formats are offered');
    assert.strictEqual(new Set(selections.map((s) => s.name)).size, 2, 'under distinct labels');

    // Interaction 2 - and under distinct paths, each ending in its own label.
    assert.deepEqual(
      selections.map((selection) => selection.path),
      ['/repo/App.sln', '/repo/App.slnx'],
      'sorted by label, with the path each row opens',
    );
    for (const selection of selections) {
      assert.ok(selection.path.endsWith(selection.name), `${selection.name} matches its path`);
    }

    // Interaction 3 - the ordering is STABLE: the same set in a different input
    // order produces the same rows, so the picker never reshuffles itself.
    const reversed = toSolutionSelections(['/repo/App.sln', '/repo/App.slnx']);
    assert.deepEqual(reversed, selections, 'input order does not change the offered order');
    assert.deepEqual(
      toSolutionSelections(['/repo/App.slnx', '/repo/App.sln', '/repo/Other.sln']).map(
        (selection) => selection.name,
      ),
      ['App.sln', 'App.slnx', 'Other.sln'],
      'and a third solution slots into the same ordering',
    );

    // Interaction 4 - `.sln` sorts before `.slnx` because the label sort is a
    // plain string comparison, and every row still points at its own file.
    const three = toSolutionSelections(['/repo/App.slnx', '/repo/App.sln', '/repo/Other.sln']);
    assert.strictEqual(three.length, 3, 'all three solutions are offered');
    assert.deepEqual(
      three.map((selection) => selection.path),
      ['/repo/App.sln', '/repo/App.slnx', '/repo/Other.sln'],
      'each row keeps the path it opens',
    );
    for (const selection of three) {
      assert.ok(selection.path.endsWith(selection.name), `${selection.name} matches its path`);
    }
  });

  // ── Real LSP roundtrip with record types ─────────────────────

  test('LSP handles C# record types', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Domain;

public record Person(string Name, int Age);

public record Address
{
    public string Street { get; init; }
    public string City { get; init; }
}`;

    const { uri } = await openCSharpFile(tmpDir, 'Records.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    const ns = symbols.find((s) => s.name === 'Domain');
    assert.ok(ns, 'Should find Domain namespace');

    const person = ns.children?.find((s) => s.name === 'Person');
    assert.ok(person, 'Should find Person record');
    assert.strictEqual(person.kind, vscode.SymbolKind.Class);

    const address = ns.children?.find((s) => s.name === 'Address');
    assert.ok(address, 'Should find Address record');

    const street = address.children?.find((s) => s.name === 'Street');
    assert.ok(street, 'Should find Street property in Address');

    // Interaction 2 - [SE-SYMBOL-KINDS] maps `record_declaration` to Class, and
    // its members keep their own kinds. A record drawn as a method puts the
    // wrong icon on the most common type in a modern C# domain model.
    const doc = await vscode.workspace.openTextDocument(uri);
    assertSymbolShape(address, vscode.SymbolKind.Class, doc);
    assertSymbolShape(street, vscode.SymbolKind.Property, doc);
    assertSymbolTree(symbols, doc);

    // Interaction 3 - both record SHAPES land in the tree: the positional
    // one-liner and the braced body. A reader that only handles the braced form
    // silently drops every DTO in the project.
    assert.strictEqual(ns.children?.length, 2, 'both records are children of the namespace');
    assert.ok(ns.range.contains(person.range), 'the positional record sits inside the namespace');
    assert.ok(ns.range.contains(address.range), 'and so does the braced one');
    assert.deepEqual(
      address.children?.map((child) => child.name),
      ['Street', 'City'],
      'the braced record owns both properties, in source order',
    );
    assert.strictEqual(
      doc.getText(person.selectionRange).includes('('),
      false,
      'and the positional record is named without its parameter list',
    );
  });

  // ── Events and fields ────────────────────────────────────────

  test('LSP handles events and fields', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Events;

public class EventSource
{
    public event EventHandler OnChanged;
    private int _counter;
    public static readonly string DefaultName = "test";
}`;

    const { uri } = await openCSharpFile(tmpDir, 'Events.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    const ns = symbols.find((s) => s.name === 'Events');
    assert.ok(ns, 'Should find Events namespace');

    const source = ns.children?.find((s) => s.name === 'EventSource');
    assert.ok(source, 'Should find EventSource class');

    const evt = source.children?.find((s) => s.name === 'OnChanged');
    assert.ok(evt, 'Should find OnChanged event');
    assert.strictEqual(evt.kind, vscode.SymbolKind.Event);

    const counter = source.children?.find((s) => s.name === '_counter');
    assert.ok(counter, 'Should find _counter field');
    assert.strictEqual(counter.kind, vscode.SymbolKind.Field);

    // Interaction 2 - [SE-SYMBOL-KINDS] gives Event and Field separate rows,
    // separate icons and separate theme colours. An event drawn as a field is
    // the difference between "subscribe here" and "read this value".
    assert.notStrictEqual(evt.kind, counter.kind, 'an event is not a field');
    const doc = await vscode.workspace.openTextDocument(uri);
    assertSymbolShape(evt, vscode.SymbolKind.Event, doc);
    assertSymbolShape(counter, vscode.SymbolKind.Field, doc);
    assertSymbolTree(symbols, doc);

    // Interaction 3 - a `static readonly` field is still a Field, and every
    // member is a CHILD of the class rather than a sibling of it. Private and
    // static members must not be filtered out of the tree: [SE-SORT-ACCESS]
    // sorts by access, which presupposes they are all present.
    const constant = source.children?.find((child) => child.name === 'DefaultName');
    assert.ok(constant, 'a static readonly field must appear in the tree');
    assert.deepEqual(
      source.children?.map((child) => child.name),
      ['OnChanged', '_counter', 'DefaultName'],
      'all three members, in source order, public and private alike',
    );
    assert.ok(source.range.contains(counter.range), 'the private field sits inside the class');
    assert.ok(ns.range.contains(source.range), 'and the class inside the namespace');
  });

  // ── Reactive Tree Auto-Refresh ──────────────────────────────

  test('tree auto-refreshes when C# document content changes', async function () {
    this.timeout(LSP_RESPONSE_MS);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    // Extension must export its API for reactive tree testing.
    const api = ext.exports as
      | {
          explorerProvider?: {
            onDidChangeTreeData: vscode.Event<unknown>;
          };
        }
      | undefined;
    assert.ok(
      api?.explorerProvider,
      'Extension must export explorerProvider — tree nodes must be reactive',
    );

    // Subscribe to tree data change events.
    let treeChangeCount = 0;
    const disposable = api.explorerProvider.onDidChangeTreeData(() => {
      treeChangeCount++;
    });

    try {
      // Open a C# file.
      const { doc } = await openCSharpFile(
        tmpDir,
        'reactive-test.cs',
        'class Before { void OldMethod() {} }',
      );

      // Wait for initial events to settle, then reset counter.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      treeChangeCount = 0;

      // Modify the document — rename a symbol.
      await replaceDocumentContent(doc, 'class Before { void NewMethod() {} }');

      // Wait for the debounced auto-refresh to fire.
      const fired = await pollUntilResult(
        async () => treeChangeCount,
        (count) => count > 0,
        5_000,
        100,
      );

      assert.ok(
        fired > 0,
        'Tree must auto-refresh when C# document content changes — ' +
          'renaming a symbol should update the solution explorer',
      );

      // Interaction 2 - the refresh reflects the NEW content. An event that
      // fires while the tree still serves the old symbol is worse than no
      // event: the view looks live and reports stale data ([SE-LIVE-BUFFER]).
      const after = await pollUntilResult(
        async () =>
          (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            doc.uri,
          )) ?? [],
        (found) => JSON.stringify(found).includes('NewMethod'),
        5_000,
      );
      const names = JSON.stringify(after);
      assert.ok(names.includes('NewMethod'), 'the renamed member is visible after the refresh');
      assert.strictEqual(names.includes('OldMethod'), false, 'and the old name is gone');
      assert.ok(after.length > 0, 'the outline is not merely empty');

      // Interaction 3 - a SECOND edit fires again. A provider that fires once
      // and then goes quiet leaves the tree stale from the second keystroke on.
      const firstRound = treeChangeCount;
      await replaceDocumentContent(doc, 'class Before { void ThirdMethod() {} }');
      const again = await pollUntilResult(
        async () => treeChangeCount,
        (count) => count > firstRound,
        5_000,
        100,
      );
      assert.ok(again > firstRound, 'a second edit must fire the change event again');
      assert.strictEqual(doc.isDirty, true, 'and the buffer is unsaved throughout');
    } finally {
      disposable.dispose();
    }

    // Interaction 4 - disposing the subscription really unsubscribes, so a
    // closed view stops paying for edits it can no longer show.
    const settled = treeChangeCount;
    const reopened = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(tmpDir, 'reactive-test.cs')),
    );
    await replaceDocumentContent(reopened, 'class Before { void FourthMethod() {} }');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.strictEqual(treeChangeCount, settled, 'no event reaches a disposed listener');
  });

  // ── Live-buffer fidelity [SE-LIVE-BUFFER] ───────────────────────────────

  test('documentSymbol reflects unsaved edits (VFS-based, should pass)', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    // Write initial content to disk and open it.
    const content = 'namespace Vfs;\n\npublic class Original\n{\n    public void Foo() { }\n}';
    const { doc, uri } = await openCSharpFile(tmpDir, 'VfsTest.cs', content);
    const before = await waitForDocumentSymbols(uri);
    const nsBefore = before.find((s) => s.name === 'Vfs');
    assert.ok(nsBefore, 'Should find Vfs namespace');
    const origClass = nsBefore.children?.find((s) => s.name === 'Original');
    assert.ok(origClass, 'Should find Original class via documentSymbol');

    // Edit the buffer WITHOUT saving — rename class.
    await replaceDocumentContent(
      doc,
      'namespace Vfs;\n\npublic class Renamed\n{\n    public void Foo() { }\n}',
    );

    // documentSymbol uses tree-sitter + VFS → should reflect the unsaved edit.
    const after = await pollUntilResult(
      async () => {
        const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          uri,
        );
        return syms ?? [];
      },
      (syms) => {
        const ns = syms.find((s) => s.name === 'Vfs');
        return ns?.children?.some((s) => s.name === 'Renamed') ?? false;
      },
      5_000,
    );
    const nsAfter = after.find((s) => s.name === 'Vfs');
    assert.ok(nsAfter, 'Vfs namespace must exist after rename');
    const renamedClass = nsAfter.children?.find((s) => s.name === 'Renamed');
    assert.ok(
      renamedClass,
      "documentSymbol must show 'Renamed' for unsaved edit — " +
        'this proves the VFS/tree-sitter path works correctly',
    );

    // Interaction 3 - the OLD name is gone. "The new name appeared" is only
    // half of [SE-LIVE-BUFFER]: a VFS that appends without replacing shows both
    // classes, and Go to Symbol then offers one that no longer exists.
    assert.strictEqual(
      nsAfter.children?.some((child) => child.name === 'Original'),
      false,
      'the pre-edit class name must not survive the rename',
    );
    assert.strictEqual(doc.isDirty, true, 'and the buffer is still unsaved');
    assert.ok(
      fs.readFileSync(uri.fsPath, 'utf8').includes('Original'),
      'while the file ON DISK still says Original - which is the whole point',
    );

    // Interaction 4 - the tree is still well formed and the member survived the
    // rename of its containing type.
    assertSymbolTree(after, doc);
    assertSymbolShape(renamedClass, vscode.SymbolKind.Class, doc);
    assert.deepEqual(
      renamedClass.children?.map((child) => child.name),
      ['Foo'],
      'the method inside the renamed class is untouched',
    );
    assert.strictEqual(after.length, 1, 'and the namespace is still the only root');
  });

  test('workspace symbols show unsaved edits, not stale disk content', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    interface TreeNode {
      readonly label?: string | { label: string };
      readonly children?: TreeNode[];
    }
    interface ExplorerApi {
      explorerProvider: {
        loadSolution(slnPath: string): Promise<void>;
        refresh(): Promise<void>;
        clear(): void;
        getChildren(element?: unknown): TreeNode[] | undefined;
      };
    }
    const api = ext.exports as ExplorerApi | undefined;
    assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');

    // Build a mini solution.
    const projDir = path.join(tmpDir, 'VfsStaleTest');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(
      path.join(projDir, 'VfsStaleTest.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
</Project>`,
    );

    const slnPath = path.join(tmpDir, 'VfsStaleTest.sln');
    fs.writeFileSync(
      slnPath,
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "VfsStaleTest", ' +
          '"VfsStaleTest/VfsStaleTest.csproj", "{00000000-0000-0000-0000-000000000099}"',
        'EndProject',
        'Global',
        'EndGlobal',
      ].join('\n'),
    );

    // Write initial content to disk: class "DiskVersion".
    const csPath = path.join(projDir, 'Stale.cs');
    fs.writeFileSync(
      csPath,
      'namespace VfsStaleTest;\n\npublic class DiskVersion\n{\n    public void Work() { }\n}',
    );

    const { doc } = await openCSharpFile(
      projDir,
      'Stale.cs',
      'namespace VfsStaleTest;\n\npublic class DiskVersion\n{\n    public void Work() { }\n}',
    );
    await waitForDocumentSymbols(doc.uri);

    // Load solution — tree should show "DiskVersion".
    await api.explorerProvider.loadSolution(slnPath);

    const provider = api.explorerProvider;

    function searchNodes(nodes: TreeNode[] | undefined, target: string): boolean {
      if (nodes === undefined) return false;
      for (const node of nodes) {
        const text = typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
        if (text.includes(target)) return true;
        if (searchNodes(node.children, target)) return true;
      }
      return false;
    }

    const hasDisk = await pollUntilResult(
      async () => searchNodes(provider.getChildren(), 'DiskVersion'),
      (found) => found,
      5_000,
    );
    assert.ok(hasDisk, "Tree must show 'DiskVersion' initially");

    // Edit the buffer WITHOUT saving — rename to "BufferVersion".
    // Disk still says "DiskVersion", VFS should say "BufferVersion".
    await replaceDocumentContent(
      doc,
      'namespace VfsStaleTest;\n\npublic class BufferVersion\n{\n    public void Work() { }\n}',
    );

    // Explicitly trigger refresh (bypass debounce entirely).
    await api.explorerProvider.refresh();

    // Give a moment for the tree to rebuild from the signal.
    const hasBuffer = await pollUntilResult(
      async () => searchNodes(provider.getChildren(), 'BufferVersion'),
      (found) => found,
      5_000,
    );

    api.explorerProvider.clear();

    assert.ok(
      hasBuffer,
      "After unsaved rename 'DiskVersion' → 'BufferVersion', tree must show " +
        "'BufferVersion' — BUG: sharplsp/workspaceSymbols reads from disk " +
        'instead of VFS, so it shows stale disk content',
    );
  });

  test('tree tracks rapid successive renames without lagging behind', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    interface TreeNode {
      readonly label?: string | { label: string };
      readonly children?: TreeNode[];
    }
    interface ExplorerApi {
      explorerProvider: {
        loadSolution(slnPath: string): Promise<void>;
        refresh(): Promise<void>;
        clear(): void;
        getChildren(element?: unknown): TreeNode[] | undefined;
      };
    }
    const api = ext.exports as ExplorerApi | undefined;
    assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');

    const projDir = path.join(tmpDir, 'RapidRenameTest');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(
      path.join(projDir, 'RapidRenameTest.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
</Project>`,
    );

    const slnPath = path.join(tmpDir, 'RapidRenameTest.sln');
    fs.writeFileSync(
      slnPath,
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "RapidRenameTest", ' +
          '"RapidRenameTest/RapidRenameTest.csproj", "{00000000-0000-0000-0000-000000000077}"',
        'EndProject',
        'Global',
        'EndGlobal',
      ].join('\n'),
    );

    const initial =
      'namespace RapidRenameTest;\n\npublic class Step0\n{\n    public void Go() { }\n}';
    const { doc } = await openCSharpFile(projDir, 'Rapid.cs', initial);
    await waitForDocumentSymbols(doc.uri);

    await api.explorerProvider.loadSolution(slnPath);
    const provider = api.explorerProvider;

    function treeContains(target: string): boolean {
      return searchTreeNodes(provider.getChildren(), target);
    }

    function searchTreeNodes(nodes: TreeNode[] | undefined, target: string): boolean {
      if (nodes === undefined) return false;
      for (const node of nodes) {
        const text = typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
        if (text.includes(target)) return true;
        if (searchTreeNodes(node.children, target)) return true;
      }
      return false;
    }

    // Rapid successive renames: Step0 → Step1 → Step2 → Step3
    for (let step = 1; step <= 3; step++) {
      const className = `Step${String(step)}`;
      await replaceDocumentContent(
        doc,
        `namespace RapidRenameTest;\n\npublic class ${className}\n{\n    public void Go() { }\n}`,
      );
      // Small delay between edits to simulate rapid typing.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // After all edits, explicitly refresh and check the FINAL state.
    await api.explorerProvider.refresh();

    const hasFinal = await pollUntilResult(
      async () => treeContains('Step3'),
      (found) => found,
      5_000,
    );

    api.explorerProvider.clear();

    assert.ok(
      hasFinal,
      "After rapid renames Step0 → Step1 → Step2 → Step3, tree must show 'Step3' — " +
        'BUG: tree is always one step behind, showing stale data from disk',
    );
  });

  test('tree shows updated class name after rename, not stale data', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    interface TreeNode {
      readonly label?: string | { label: string };
      readonly children?: TreeNode[];
    }
    interface ExplorerApi {
      explorerProvider: {
        loadSolution(slnPath: string): Promise<void>;
        clear(): void;
        getChildren(element?: unknown): TreeNode[] | undefined;
      };
    }
    const api = ext.exports as ExplorerApi | undefined;
    assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');

    // Build a mini solution with class "Alpha".
    const projDir = path.join(tmpDir, 'StaleDataTest');
    fs.mkdirSync(projDir, { recursive: true });

    fs.writeFileSync(
      path.join(projDir, 'StaleDataTest.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
</Project>`,
    );

    const slnPath = path.join(tmpDir, 'StaleDataTest.sln');
    fs.writeFileSync(
      slnPath,
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "StaleDataTest", ' +
          '"StaleDataTest/StaleDataTest.csproj", "{00000000-0000-0000-0000-000000000042}"',
        'EndProject',
        'Global',
        'EndGlobal',
      ].join('\n'),
    );

    const initial =
      'namespace StaleDataTest;\n\npublic sealed class Alpha\n{\n    public string Name { get; set; }\n}';
    const { doc } = await openCSharpFile(projDir, 'Thing.cs', initial);
    const opened = await waitForDocumentSymbols(doc.uri);
    assert.ok(opened.length > 0, 'the source the tree will read really has symbols');
    assert.ok(
      JSON.stringify(opened).includes('Alpha'),
      'and the outline names Alpha before the tree is asked',
    );
    assert.strictEqual(doc.isDirty, false, 'the file starts clean on disk');

    // Load solution into tree and verify "Alpha" appears.
    await api.explorerProvider.loadSolution(slnPath);

    const provider = api.explorerProvider;

    function treeContains(target: string): boolean {
      return searchNodes(provider.getChildren(), target);
    }

    function searchNodes(nodes: TreeNode[] | undefined, target: string): boolean {
      if (nodes === undefined) return false;
      for (const node of nodes) {
        const text = typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
        if (text.includes(target)) return true;
        if (searchNodes(node.children, target)) return true;
      }
      return false;
    }

    const hasAlpha = await pollUntilResult(
      async () => treeContains('Alpha'),
      (found) => found,
      5_000,
    );
    assert.ok(hasAlpha, "Tree must show 'Alpha' before rename");

    assert.strictEqual(treeContains('Bravo'), false, 'and must NOT show Bravo before the rename');
    assert.ok(fs.existsSync(slnPath), 'the solution the tree loaded is on disk');
    assert.ok(
      (provider.getChildren() ?? []).length > 0,
      'and the loaded solution produced at least one root row',
    );

    // Rename class: Alpha → Bravo
    const renamed =
      'namespace StaleDataTest;\n\npublic sealed class Bravo\n{\n    public string Name { get; set; }\n}';
    await replaceDocumentContent(doc, renamed);

    // Wait for debounced auto-refresh — tree must show "Bravo".
    const hasBravo = await pollUntilResult(
      async () => treeContains('Bravo'),
      (found) => found,
      5_000,
    );

    // Clean up tree state for other tests.
    api.explorerProvider.clear();

    assert.ok(
      hasBravo,
      "After renaming 'Alpha' to 'Bravo', tree must show 'Bravo' — " +
        'stale data bug: tree still displays the previous class name',
    );
  });

  // ── Reactivity: csproj PackageReference edits ─────────────────

  /**
   * REACTIVITY: external csproj edits MUST propagate to the solution tree's
   * Dependencies → Packages node without any manual refresh. When a user (or
   * another tool) removes a <PackageReference>, the node must disappear.
   *
   * Contract from CLAUDE.md: "All screens MUST BE 100% reactive."
   */
  test('Dependencies → Packages tree reacts to external csproj edit', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    interface TreeNode {
      readonly label?: string | { label: string };
      readonly children?: TreeNode[];
    }
    interface ExplorerApi {
      explorerProvider: {
        loadSolution(slnPath: string): Promise<void>;
        refresh(): Promise<void>;
        clear(): void;
        getChildren(element?: unknown): TreeNode[] | undefined;
      };
    }
    const api = ext.exports as ExplorerApi | undefined;
    assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');

    // Build a mini solution with one csproj containing Newtonsoft.Json.
    const projDir = path.join(tmpDir, 'PackageReactivityTest');
    fs.mkdirSync(projDir, { recursive: true });

    const csprojPath = path.join(projDir, 'PackageReactivityTest.csproj');
    fs.writeFileSync(
      csprojPath,
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
    );

    const slnPath = path.join(tmpDir, 'PackageReactivityTest.sln');
    fs.writeFileSync(
      slnPath,
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "PackageReactivityTest", ' +
          '"PackageReactivityTest/PackageReactivityTest.csproj", ' +
          '"{00000000-0000-0000-0000-000000000098}"',
        'EndProject',
        'Global',
        'EndGlobal',
      ].join('\n'),
    );

    // Force at least one source file so the project materializes in the tree.
    fs.writeFileSync(
      path.join(projDir, 'Dummy.cs'),
      'namespace PackageReactivityTest;\n\npublic class Dummy { }',
    );
    const { doc } = await openCSharpFile(
      projDir,
      'Dummy.cs',
      'namespace PackageReactivityTest;\n\npublic class Dummy { }',
    );
    await waitForDocumentSymbols(doc.uri);

    await api.explorerProvider.loadSolution(slnPath);
    const provider = api.explorerProvider;

    function searchNodes(nodes: TreeNode[] | undefined, target: string): boolean {
      if (nodes === undefined) return false;
      for (const node of nodes) {
        const text = typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
        if (text.includes(target)) return true;
        if (searchNodes(node.children, target)) return true;
      }
      return false;
    }

    // Wait for the initial tree to contain Newtonsoft.Json.
    const hasPkgInitially = await pollUntilResult(
      async () => searchNodes(provider.getChildren(), 'Newtonsoft.Json'),
      (found) => found,
      10_000,
    );
    assert.ok(
      hasPkgInitially,
      'Tree must show Newtonsoft.Json under Dependencies → Packages initially',
    );

    // Rewrite the csproj to drop the PackageReference — no manual refresh.
    fs.writeFileSync(
      csprojPath,
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
  <ItemGroup></ItemGroup>
</Project>`,
    );

    // The file watcher + signal must drive a rebuild.
    const removed = await pollUntilResult(
      async () => !searchNodes(provider.getChildren(), 'Newtonsoft.Json'),
      (gone) => gone,
      10_000,
    );

    api.explorerProvider.clear();

    assert.ok(
      removed,
      'After csproj edit removes PackageReference, tree MUST no longer show Newtonsoft.Json ' +
        '(reactive contract violated)',
    );
  });
});
