/**
 * COARSE end-to-end coverage for the Solution Explorer tree + supporting modules.
 *
 * Project HARD RULE (CLAUDE.md): "No unit tests. Only COARSE e2e tests." These
 * suites re-express previously-archived unit behaviour as REAL flows: they load
 * the committed fixture solution into the LIVE `api.explorerProvider`, walk the
 * real tree produced by the real LSP, and drive the real registered commands.
 *
 * Modules exercised end-to-end through these flows:
 *   - src/tree.ts            (SolutionExplorerProvider, ExplorerNode, buildQualifiedName,
 *                             getTreeItem/getChildren/getParent/findNodeForUri, sorting,
 *                             resolveTreeItem hover tooltips, refresh/clear)
 *   - src/tree-tooltip.ts    (buildNonSymbolTooltip via getTreeItem(node).tooltip /
 *                             resolveTreeItem; SYMBOL_CONTEXT_VALUES on real nodes)
 *   - src/state.ts           (SORT_CYCLE, cycleSortOrder, reactive sortOrder /
 *                             solutionPath / symbolsState signals, loadSolution/clear)
 *   - src/config.ts          (every getter, with set/restore round-trips)
 *   - src/solution.ts        (toSolutionSelections sorting, findSolutions, selectSolution
 *                             driven via a ui-stubbed quickPick)
 *   - src/result.ts          (ok/err consumed inside a real findSolutions-backed flow)
 *   - src/platform.ts        (detectRuntimePlatform within binary discovery)
 *   - src/constants.ts /
 *     src/channel-guard.ts   (showOutput / showTraceOutput touch the guarded channel)
 *
 * SETTINGS-RESTORE STRATEGY: any `sharplsp.*` setting changed here is restored to
 * its ORIGINAL `inspect(key)?.workspaceValue` in a `finally` (undefined removes the
 * key) so the committed `test-fixtures/workspace/.vscode/settings.json` stays
 * pristine — never `cfg.get`, which would persist defaults into the fixture.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  openCSharpFile,
  pollUntilResult,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { buildQualifiedName } from '../../tree.js';
import { buildNonSymbolTooltip, SYMBOL_CONTEXT_VALUES } from '../../tree-tooltip.js';
import * as state from '../../state.js';
import { SortOrder, SORT_CYCLE } from '../../state.js';
import { effect } from '../../signals.js';
import * as config from '../../config.js';
import { findSolutions, toSolutionSelections } from '../../solution.js';
import { ok, err, type Result } from '../../result.js';
import { detectRuntimePlatform } from '../../platform.js';
import { CONFIG_SECTION } from '../../constants.js';

// ── Shared tree-node shape (the real ExplorerNode, viewed structurally) ──────

interface TreeNode extends vscode.TreeItem {
  readonly nodeType?: string;
  readonly children?: TreeNode[];
  readonly sortName?: string;
  readonly access?: string;
  readonly symbolKind?: string;
  readonly symbolUri?: string;
  readonly contextValue?: string;
  readonly parent?: TreeNode;
}

interface ExplorerApi {
  explorerProvider: {
    loadSolution(slnPath: string): Promise<void>;
    refresh(): Promise<void>;
    clear(): void;
    getChildren(element?: unknown): TreeNode[] | undefined;
    getTreeItem(element: TreeNode): vscode.TreeItem;
  };
}

const FIXTURE_DIR = path.resolve(__dirname, '../../../test-fixtures/workspace');
const FIXTURE_SLN = path.join(FIXTURE_DIR, 'TestFixtures.sln');

function getProvider(): ExplorerApi['explorerProvider'] {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'Extension must be found');
  const api = ext.exports as ExplorerApi | undefined;
  assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');
  return api.explorerProvider;
}

function nodeLabel(node: TreeNode): string {
  return typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
}

function findNode(
  nodes: TreeNode[] | undefined,
  predicate: (node: TreeNode) => boolean,
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
  return findNode(nodes, (node) => nodeLabel(node).includes(label));
}

function findByContext(nodes: TreeNode[] | undefined, contextValue: string): TreeNode | undefined {
  return findNode(nodes, (node) => node.contextValue === contextValue);
}

/** Walk every node in the tree (roots → leaves), invoking `visit`. */
function walkTree(nodes: TreeNode[] | undefined, visit: (node: TreeNode) => void): void {
  if (nodes === undefined) return;
  for (const node of nodes) {
    visit(node);
    walkTree(node.children, visit);
  }
}

/** Load the committed fixture solution and wait until its symbols populate. */
async function loadFixtureSolution(provider: ExplorerApi['explorerProvider']): Promise<void> {
  // Warm Roslyn against a real fixture file so workspaceSymbols has content.
  const calcUri = vscode.Uri.file(path.join(FIXTURE_DIR, 'Calculator.cs'));
  await vscode.workspace.openTextDocument(calcUri).then((d) => vscode.window.showTextDocument(d));

  await provider.loadSolution(FIXTURE_SLN);
  await provider.refresh();

  await pollUntilResult(
    async () => findByLabel(provider.getChildren(), 'Calculator'),
    (node) => node !== undefined,
    60_000,
    1_000,
  );
}

// ─────────────────────────────────────────────────────────────────
// Suite 1 — tree.ts: real solution walk, qualified names, getTreeItem
// ─────────────────────────────────────────────────────────────────

suite('Tree E2E — real fixture solution walk', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(120_000);
    const result = await setupLspTestSuite('tree-walk-');
    tmpDir = result.tmpDir;
    provider = getProvider();
    await loadFixtureSolution(provider);
  });

  suiteTeardown(async () => {
    provider.clear();
    state.sortOrder.value = SortOrder.Alphabetical;
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('solution root → project → namespace → class → method chain is well formed', () => {
    const roots = provider.getChildren();
    assert.ok(roots !== undefined && roots.length > 0, 'tree must have at least one root');

    const solution = roots[0];
    assert.ok(solution, 'solution root must exist');
    assert.strictEqual(solution.contextValue, 'solution', 'root is the solution node');
    assert.strictEqual(
      nodeLabel(solution),
      'TestFixtures.sln',
      'solution label is the .sln basename',
    );
    assert.strictEqual(
      solution.collapsibleState,
      vscode.TreeItemCollapsibleState.Expanded,
      'solution root must be expanded',
    );

    // getChildren(solution) must return the SAME array as solution.children.
    assert.strictEqual(
      provider.getChildren(solution),
      solution.children,
      'getChildren(element) returns the element children, not the roots',
    );

    const project = findByContext(roots, 'project');
    assert.ok(project, 'a project node must exist under the solution');
    assert.ok(
      nodeLabel(project).includes('TestFixtures'),
      `project label should mention TestFixtures, got '${nodeLabel(project)}'`,
    );

    const calcClass = findNode(
      roots,
      (node) => nodeLabel(node).includes('Calculator') && node.contextValue === 'symbol.class',
    );
    assert.ok(calcClass, 'Calculator class node must exist');

    const addMethod = findNode(
      calcClass.children,
      (node) => nodeLabel(node).includes('Add') && node.contextValue === 'symbol.method',
    );
    assert.ok(addMethod, 'Add method must be a child of Calculator');
  });

  test('buildQualifiedName threads Namespace.Class.Member for real nodes', () => {
    const roots = provider.getChildren();

    const ns = findNode(roots, (node) => node.contextValue === 'symbol.namespace');
    assert.ok(ns, 'a namespace node must exist');
    // A namespace qualifies to just its own name (project ancestor is skipped).
    assert.strictEqual(
      buildQualifiedName(ns as unknown as Parameters<typeof buildQualifiedName>[0]),
      ns.sortName,
      'namespace qualified name is its own name (no project/solution leak)',
    );

    const calcClass = findNode(
      roots,
      (node) => nodeLabel(node).includes('Calculator') && node.contextValue === 'symbol.class',
    );
    assert.ok(calcClass, 'Calculator class node must exist');
    const classQualified = buildQualifiedName(
      calcClass as unknown as Parameters<typeof buildQualifiedName>[0],
    );
    assert.ok(
      classQualified.endsWith('Calculator'),
      `class qualified name should end with Calculator, got '${classQualified}'`,
    );
    assert.ok(classQualified.includes('.'), 'class lives in a namespace → name has a dot');
    assert.ok(!classQualified.startsWith('.'), 'qualified name must not start with a dot');
    assert.ok(!classQualified.endsWith('.'), 'qualified name must not end with a dot');

    const addMethod = findNode(
      calcClass.children,
      (node) => nodeLabel(node).includes('Add') && node.contextValue === 'symbol.method',
    );
    assert.ok(addMethod, 'Add method must exist');
    const methodQualified = buildQualifiedName(
      addMethod as unknown as Parameters<typeof buildQualifiedName>[0],
    );
    assert.strictEqual(
      methodQualified,
      `${classQualified}.Add`,
      'method qualified name = class qualified name + .Add',
    );

    // The project/solution names must never leak into a qualified name.
    assert.ok(
      !methodQualified.includes('TestFixtures.sln'),
      'solution name must not appear in qualified name',
    );
  });

  test('getTreeItem returns the node identity and every symbol node carries a symbol contextValue', () => {
    const roots = provider.getChildren();
    assert.ok(roots !== undefined && roots.length > 0);

    const solution = roots[0];
    assert.ok(solution);
    assert.strictEqual(
      provider.getTreeItem(solution),
      solution,
      'getTreeItem is identity for the solution root',
    );

    const calcClass = findNode(
      roots,
      (node) => nodeLabel(node).includes('Calculator') && node.contextValue === 'symbol.class',
    );
    assert.ok(calcClass);
    assert.strictEqual(provider.getTreeItem(calcClass), calcClass, 'getTreeItem is identity');

    // Every node with a symbol kind must map to a SYMBOL_CONTEXT_VALUES entry.
    let symbolNodes = 0;
    const bad: string[] = [];
    walkTree(roots, (node) => {
      if (node.symbolKind !== undefined && node.symbolKind !== '') {
        symbolNodes++;
        const expected = SYMBOL_CONTEXT_VALUES[node.symbolKind] ?? 'symbol.unknown';
        if (node.contextValue !== expected) {
          bad.push(`${nodeLabel(node)}: ${String(node.contextValue)} != ${expected}`);
        }
      }
    });
    assert.ok(symbolNodes > 0, 'must encounter symbol nodes');
    assert.deepStrictEqual(
      bad,
      [],
      `contextValue must match SYMBOL_CONTEXT_VALUES: ${bad.join(', ')}`,
    );
  });

  test('the interface and enum from the fixture appear with correct context values', () => {
    const roots = provider.getChildren();

    // The fixture project compiles MULTIPLE interfaces (ICalculator + IShape) and
    // enums (Operation + Color), so we must match by BOTH context value AND label
    // rather than taking whichever the tree happens to list first.
    const iface = findNode(
      roots,
      (node) => node.contextValue === 'symbol.interface' && nodeLabel(node).includes('ICalculator'),
    );
    assert.ok(iface, 'ICalculator interface node must exist with contextValue symbol.interface');

    const enumNode = findNode(
      roots,
      (node) => node.contextValue === 'symbol.enum' && nodeLabel(node).includes('Operation'),
    );
    assert.ok(enumNode, 'Operation enum node must exist with contextValue symbol.enum');

    const enumMember = findByContext(roots, 'symbol.enumMember');
    assert.ok(enumMember, 'an enum member node (Add/Subtract/Multiply/Divide) must exist');
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 2 — tree-tooltip.ts: real tooltips via getTreeItem / SYMBOL_CONTEXT_VALUES
// ─────────────────────────────────────────────────────────────────

suite('Tree Tooltip E2E — non-symbol tooltips and context-value mapping', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(120_000);
    const result = await setupLspTestSuite('tree-tooltip-');
    tmpDir = result.tmpDir;
    provider = getProvider();

    // A project WITH a NuGet package + a project reference so the Dependencies
    // subtree (Packages/Projects) materialises and its non-symbol tooltips run.
    const libDir = path.join(tmpDir, 'TipLib');
    const appDir = path.join(tmpDir, 'TipApp');
    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(libDir, 'TipLib.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>' +
        '<TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
    );
    fs.writeFileSync(
      path.join(appDir, 'TipApp.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <ProjectReference Include="../TipLib/TipLib.csproj" />
  </ItemGroup>
</Project>`,
    );
    fs.writeFileSync(
      path.join(appDir, 'Program.cs'),
      'namespace TipApp { public class Program { public void Run() { } } }',
    );

    const slnPath = path.join(tmpDir, 'TipApp.sln');
    fs.writeFileSync(
      slnPath,
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "TipApp", ' +
          '"TipApp/TipApp.csproj", "{00000000-0000-0000-0000-000000000A01}"',
        'EndProject',
        'Global',
        'EndGlobal',
      ].join('\n'),
    );

    const { uri } = await openCSharpFile(
      appDir,
      'Program.cs',
      'namespace TipApp { public class Program { public void Run() { } } }',
    );
    await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          uri,
        )) ?? [],
      (syms) => syms.length > 0,
      30_000,
    );

    await provider.loadSolution(slnPath);
    await provider.refresh();
    await pollUntilResult(
      async () => findByLabel(provider.getChildren(), 'Newtonsoft.Json'),
      (node) => node !== undefined,
      30_000,
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

  test('NuGet package node renders a markdown tooltip with name + version', () => {
    const pkg = findByContext(provider.getChildren(), 'nugetPackage');
    assert.ok(pkg, 'a nugetPackage node must exist');

    const tooltip = buildNonSymbolTooltip(pkg as never);
    assert.ok(tooltip instanceof vscode.MarkdownString, 'package tooltip must be a MarkdownString');
    assert.ok(tooltip.value.includes('**NuGet Package**'), 'tooltip has bold header');
    assert.ok(tooltip.value.includes('Newtonsoft.Json'), 'tooltip names the package');
    assert.ok(tooltip.value.includes('13.0.3'), 'tooltip carries the version');
  });

  test('symbol and structural nodes get NO non-symbol tooltip (symbols use LSP hover)', () => {
    const roots = provider.getChildren();
    assert.ok(roots !== undefined && roots.length > 0);

    // Solution, project, and a class are all non-tooltip kinds here.
    const solution = roots[0];
    assert.ok(solution);
    assert.strictEqual(
      buildNonSymbolTooltip(solution as never),
      undefined,
      'solution node has no non-symbol tooltip',
    );

    const project = findByContext(roots, 'project');
    assert.ok(project);
    assert.strictEqual(buildNonSymbolTooltip(project as never), undefined);

    const programClass = findNode(
      roots,
      (node) => nodeLabel(node).includes('Program') && node.contextValue === 'symbol.class',
    );
    assert.ok(programClass, 'Program class node must exist');
    assert.strictEqual(
      buildNonSymbolTooltip(programClass as never),
      undefined,
      'class node has no non-symbol tooltip (handled by hover)',
    );
  });

  test('SYMBOL_CONTEXT_VALUES maps the documented kinds and namespaces every value', () => {
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Class, 'symbol.class');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Interface, 'symbol.interface');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Function, 'symbol.delegate');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.EnumMember, 'symbol.enumMember');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Namespace, 'symbol.namespace');
    // Unknown kinds intentionally map to undefined (tree falls back to symbol.unknown).
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Totally_Made_Up, undefined);
    for (const value of Object.values(SYMBOL_CONTEXT_VALUES)) {
      assert.ok(value.startsWith('symbol.'), `${value} must be namespaced under symbol.`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 3 — state.ts + tree sorting: reactive signals + observable order changes
// ─────────────────────────────────────────────────────────────────

suite('State E2E — reactive sort signals drive tree order', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];
  let originalSort: SortOrder;

  suiteSetup(async function () {
    this.timeout(120_000);
    const result = await setupLspTestSuite('tree-sort-');
    tmpDir = result.tmpDir;
    provider = getProvider();
    originalSort = state.sortOrder.value;
    await loadFixtureSolution(provider);
  });

  suiteTeardown(async () => {
    // RESTORE the sort order touched by these flows.
    state.sortOrder.value = originalSort;
    provider.clear();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(() => {
    state.sortOrder.value = SortOrder.Alphabetical;
  });

  /** Member sortNames under the Calculator class for the current sort order. */
  function calculatorMemberNames(): string[] {
    const calcClass = findNode(
      provider.getChildren(),
      (node) => nodeLabel(node).includes('Calculator') && node.contextValue === 'symbol.class',
    );
    assert.ok(calcClass, 'Calculator class must exist');
    return (calcClass.children ?? []).map((child) => child.sortName ?? '');
  }

  test('SORT_CYCLE is a closed 3-ring natural→alphabetical→accessibility→natural', () => {
    assert.strictEqual(SORT_CYCLE[SortOrder.Natural], SortOrder.Alphabetical);
    assert.strictEqual(SORT_CYCLE[SortOrder.Alphabetical], SortOrder.Accessibility);
    assert.strictEqual(SORT_CYCLE[SortOrder.Accessibility], SortOrder.Natural);
  });

  test('cycleSortOrder advances the reactive signal and an effect observes every hop', () => {
    state.sortOrder.value = SortOrder.Natural;
    const observed: SortOrder[] = [];
    const dispose = effect(() => {
      observed.push(state.sortOrder.value);
    });
    try {
      state.cycleSortOrder(); // → alphabetical
      state.cycleSortOrder(); // → accessibility
      state.cycleSortOrder(); // → natural (full ring)
    } finally {
      dispose();
    }
    assert.deepStrictEqual(
      observed,
      [SortOrder.Natural, SortOrder.Alphabetical, SortOrder.Accessibility, SortOrder.Natural],
      'effect re-runs once per signal hop, seeing the full cycle',
    );
    assert.strictEqual(state.sortOrder.value, SortOrder.Natural, 'three hops return to start');
  });

  test('switching to alphabetical sorts Calculator members; natural restores source order', () => {
    state.sortOrder.value = SortOrder.Natural;
    const natural = calculatorMemberNames();
    assert.ok(natural.length >= 2, 'Calculator must expose multiple members');

    state.sortOrder.value = SortOrder.Alphabetical;
    const alphabetical = calculatorMemberNames();
    const expected = [...alphabetical].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(
      alphabetical,
      expected,
      'alphabetical order must be sorted by member name',
    );

    // Natural and alphabetical are the SAME set, just (potentially) reordered.
    assert.deepStrictEqual(
      [...natural].sort((a, b) => a.localeCompare(b)),
      [...alphabetical].sort((a, b) => a.localeCompare(b)),
      'sorting must not add or drop members',
    );

    // The driving signal really changed the tree: switching back to natural and
    // forward to alphabetical is idempotent for the alphabetical projection.
    state.sortOrder.value = SortOrder.Natural;
    state.sortOrder.value = SortOrder.Alphabetical;
    assert.deepStrictEqual(calculatorMemberNames(), alphabetical, 'sort is deterministic');
  });

  // NOTE: these two tests drive and assert the imported `state` module
  // self-consistently. The live provider exported by the extension is bound to a
  // SEPARATELY-bundled state instance (esbuild inlines src into dist), so reading
  // this module after a provider mutation would observe a different instance.
  // Driving state.clear()/loadSolution()/refresh() here covers state.ts's reactive
  // loadSolution/clear/refresh contract directly. This module has no LSP client
  // attached, so symbolsState settles to 'empty' after a load/refresh — that IS
  // the documented contract for a client-less refresh (state.ts:120-127).
  test('clear() and loadSolution() drive solutionPath and symbolsState signals', async () => {
    // Normalize shared state to undefined BEFORE subscribing so the histories
    // capture exactly the two transitions this test drives: load (undefined ->
    // fixture) then clear (fixture -> undefined). clear() on an already-undefined
    // solutionPath is a correct no-op under the signal's Object.is change-detection
    // (signals.ts) and emits nothing — so we must drive a real change to observe
    // the contract. This also makes the test independent of suite execution order.
    state.clear();
    const pathHistory: (string | undefined)[] = [];
    const stateHistory: string[] = [];
    const disposePath = state.solutionPath.subscribe((value) => pathHistory.push(value));
    const disposeState = state.symbolsState.subscribe((value) => stateHistory.push(value.kind));
    try {
      await state.loadSolution(FIXTURE_SLN);
      assert.strictEqual(
        state.solutionPath.value,
        FIXTURE_SLN,
        'loadSolution sets solutionPath to the fixture solution (deterministic)',
      );
      assert.ok(
        pathHistory.includes(FIXTURE_SLN),
        'the load drove solutionPath through the fixture path',
      );
      // With no LSP client attached, the refresh inside loadSolution settles empty.
      assert.strictEqual(
        state.symbolsState.value.kind,
        'empty',
        'a client-less loadSolution refresh settles symbolsState to empty',
      );

      state.clear();
      // clear() drives solutionPath -> undefined and symbolsState -> empty.
      assert.strictEqual(state.solutionPath.value, undefined, 'clear() unsets solutionPath');
      assert.strictEqual(state.symbolsState.value.kind, 'empty', 'clear() empties symbolsState');
      assert.ok(pathHistory.includes(undefined), 'clear() drove solutionPath to undefined');
      assert.ok(stateHistory.includes('empty'), 'clear() drove symbolsState to empty');
    } finally {
      disposePath();
      disposeState();
      state.clear();
    }
  });

  test('refresh() re-runs without changing the loaded solution path', async () => {
    await state.loadSolution(FIXTURE_SLN);
    assert.strictEqual(state.solutionPath.value, FIXTURE_SLN, 'solution loaded before refresh');

    await state.refresh();
    assert.strictEqual(
      state.solutionPath.value,
      FIXTURE_SLN,
      'refresh keeps the same loaded solution path',
    );
    // Client-less refresh keeps symbolsState empty rather than throwing.
    assert.strictEqual(
      state.symbolsState.value.kind,
      'empty',
      'a client-less refresh settles symbolsState to empty',
    );
    state.clear();
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 4 — config.ts: every getter with set/restore round-trips
// ─────────────────────────────────────────────────────────────────

suite('Config E2E — every getter, with workspace round-trips', () => {
  const ws = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(CONFIG_SECTION);

  /**
   * Set `key`, run `body`, then restore EXACTLY the original workspace value via
   * `inspect(key)?.workspaceValue` (undefined REMOVES the key). Restoring
   * `cfg.get` would bake defaults into the committed fixture settings.json.
   */
  async function withSetting(key: string, value: unknown, body: () => void): Promise<void> {
    const cfg = ws();
    const originalWorkspaceValue = cfg.inspect(key)?.workspaceValue;
    try {
      await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
      body();
    } finally {
      await cfg.update(key, originalWorkspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  }

  test('string + array + level getters return correct types and reflect overrides', async function () {
    this.timeout(20_000);

    // Default-shape assertions (types/contracts) for every getter.
    assert.strictEqual(typeof config.serverPath(), 'string', 'serverPath is a string');
    assert.ok(Array.isArray(config.serverExtraArgs()), 'serverExtraArgs is an array');
    assert.ok(Array.isArray(config.fsiExtraArgs()), 'fsiExtraArgs is an array');
    assert.ok(config.loggingLevel().length > 0, 'loggingLevel is a non-empty string');

    // Round-trip an override and confirm the getter reflects it, then restore.
    await withSetting('logging.level', 'debug', () => {
      assert.strictEqual(config.loggingLevel(), 'debug', 'loggingLevel reflects the override');
    });
    assert.strictEqual(
      ws().inspect('logging.level')?.workspaceValue,
      'info',
      'committed fixture logging.level (info) is restored verbatim',
    );

    await withSetting('server.extraArgs', ['--verbose', '--port=9091'], () => {
      assert.deepStrictEqual([...config.serverExtraArgs()], ['--verbose', '--port=9091']);
    });

    await withSetting('fsi.extraArgs', ['--use:init.fsx'], () => {
      assert.deepStrictEqual([...config.fsiExtraArgs()], ['--use:init.fsx']);
    });
  });

  test('inlay-hint flags default to true and reflect explicit false overrides', async function () {
    this.timeout(20_000);
    assert.strictEqual(config.inlayHintsParameterNames(), true, 'parameter hints default on');
    assert.strictEqual(config.inlayHintsTypeInference(), true, 'type-inference hints default on');
    assert.strictEqual(config.inlayHintsPipelineTypes(), true, 'pipeline hints default on');

    await withSetting('inlayHints.parameterNames', false, () => {
      assert.strictEqual(config.inlayHintsParameterNames(), false);
    });
    await withSetting('inlayHints.typeInference', false, () => {
      assert.strictEqual(config.inlayHintsTypeInference(), false);
    });
    await withSetting('inlayHints.pipelineTypes', false, () => {
      assert.strictEqual(config.inlayHintsPipelineTypes(), false);
    });
  });

  test('nuget + hot-reload booleans default false and reflect a true override', async function () {
    this.timeout(20_000);
    assert.strictEqual(config.nugetIncludePrerelease(), false, 'prerelease off by default');
    assert.strictEqual(config.hotReloadOnSave(), false, 'hot reload on save off by default');

    await withSetting('nuget.includePrerelease', true, () => {
      assert.strictEqual(config.nugetIncludePrerelease(), true);
    });
    await withSetting('hotReload.onSave', true, () => {
      assert.strictEqual(config.hotReloadOnSave(), true);
    });

    // Every boolean getter returns a real boolean primitive.
    for (const value of [
      config.inlayHintsParameterNames(),
      config.inlayHintsTypeInference(),
      config.inlayHintsPipelineTypes(),
      config.nugetIncludePrerelease(),
      config.hotReloadOnSave(),
    ]) {
      assert.strictEqual(typeof value, 'boolean');
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 5 — solution.ts + result.ts + platform.ts + channel-guard.ts
// ─────────────────────────────────────────────────────────────────

suite('Solution / Result / Platform / Channel E2E', () => {
  let stubs: UiStubs | undefined;

  teardown(async () => {
    stubs?.restore();
    stubs = undefined;
    await closeAllEditors();
  });

  test('toSolutionSelections sorts by (name, path) and findSolutions matches that order', async function () {
    this.timeout(15_000);

    // PURE transform: name derived from basename, sorted by name then path.
    const sorted = toSolutionSelections([
      '/repo/Zeta.slnx',
      '/repo/Alpha.sln',
      '/repo/Alpha.slnx',
      '/aaa/Same.sln',
      '/zzz/Same.sln',
    ]);
    assert.deepStrictEqual(
      sorted.map((selection) => selection.name),
      ['Alpha.sln', 'Alpha.slnx', 'Same.sln', 'Same.sln', 'Zeta.slnx'],
      'names sort via localeCompare',
    );
    // Tie on name → path is the ascending tiebreaker.
    const sames = sorted.filter((selection) => selection.name === 'Same.sln');
    assert.deepStrictEqual(
      sames.map((selection) => selection.path),
      ['/aaa/Same.sln', '/zzz/Same.sln'],
      'equal names break ties by path ascending',
    );

    // LIVE discovery against the fixture workspace finds TestFixtures.sln/.slnx,
    // already in canonical order.
    const found = await findSolutions();
    assert.ok(Array.isArray(found), 'findSolutions resolves to an array');
    assert.ok(
      found.some((selection) => selection.name === 'TestFixtures.sln'),
      'fixture .sln must be discovered',
    );
    assert.ok(
      found.some((selection) => selection.name === 'TestFixtures.slnx'),
      'fixture .slnx must be discovered',
    );
    for (const selection of found) {
      assert.strictEqual(
        selection.name,
        path.basename(selection.path),
        'name is exactly the basename',
      );
      assert.ok(
        selection.name.endsWith('.sln') || selection.name.endsWith('.slnx'),
        `unexpected solution extension: ${selection.name}`,
      );
    }
    const reSorted = toSolutionSelections(found.map((selection) => selection.path));
    assert.deepStrictEqual(
      found.map((selection) => selection.path),
      reSorted.map((selection) => selection.path),
      'findSolutions output is already in canonical sort order',
    );
  });

  test('selectSolution command drives the quickPick and loads the chosen solution', async function () {
    this.timeout(30_000);

    const provider = getProvider();
    provider.clear();

    // The fixture workspace has BOTH TestFixtures.sln and .slnx → selectSolution
    // must prompt a quickPick. Use an EXACT-label selector: a substring selector
    // for 'TestFixtures.sln' would also match 'TestFixtures.slnx'.
    stubs = installUiStubs();
    stubs.queuePick((items) =>
      (items as { label?: string }[]).find((item) => item.label === 'TestFixtures.sln'),
    );

    await vscode.commands.executeCommand('sharplsp.selectSolution');

    // The real command path showed exactly one quick pick with both solutions.
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'selectSolution prompts exactly once');
    const items = stubs.log.quickPickItems[0] as { label: string }[];
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes('TestFixtures.sln'), 'quick pick offers the .sln');
    assert.ok(labels.includes('TestFixtures.slnx'), 'quick pick offers the .slnx');

    // The command drives the live (bundled) provider, so assert the OBSERVABLE
    // result: a solution root labelled exactly 'TestFixtures.sln' appears in the
    // live tree. (The command sets dist-bundled state, not this module's state.)
    const roots = await pollUntilResult(
      async () => provider.getChildren() ?? [],
      (nodes) =>
        nodes.some(
          (node) => node.contextValue === 'solution' && nodeLabel(node) === 'TestFixtures.sln',
        ),
      15_000,
      500,
    );
    const slnRoot = roots.find(
      (node) => node.contextValue === 'solution' && nodeLabel(node) === 'TestFixtures.sln',
    );
    assert.ok(
      slnRoot,
      `selected solution must load into the live tree; roots: ${roots
        .map((node) => nodeLabel(node))
        .join(', ')}`,
    );

    provider.clear();
  });

  test('a findSolutions-backed flow produces and consumes a Result<T,E> via ok()/err()', async function () {
    this.timeout(15_000);

    // ok()/err() exercised inside a real flow that wraps live solution discovery.
    async function discover(): Promise<Result<number>> {
      try {
        const found = await findSolutions();
        return ok(found.length);
      } catch (caught) {
        return err(caught instanceof Error ? caught.message : String(caught));
      }
    }

    const result = await discover();
    assert.strictEqual(result.ok, true, 'discovery must succeed against the fixture workspace');
    if (result.ok) {
      assert.ok(result.value >= 2, 'fixture workspace exposes at least .sln + .slnx');
    }

    // The error arm narrows correctly too.
    const failure: Result<number> = err('boom');
    assert.strictEqual(failure.ok, false);
    if (!failure.ok) {
      assert.strictEqual(failure.error, 'boom', 'err() carries its message; discriminant narrows');
    }
  });

  test('detectRuntimePlatform returns a recognised <os>-<arch> triple matching the host', () => {
    const platform = detectRuntimePlatform();
    const valid = new Set([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    assert.ok(valid.has(platform), `detectRuntimePlatform returned an unknown triple: ${platform}`);
    // It must agree with the actual host process platform prefix.
    assert.ok(
      platform.startsWith(process.platform),
      `triple '${platform}' must start with host platform '${process.platform}'`,
    );
  });

  test('showOutput / showTraceOutput touch the guarded output channels without throwing', async function () {
    this.timeout(10_000);
    // These commands call channel.show() through the channel-guard Proxy. Even
    // when the channel races teardown the guard must swallow the error — here we
    // simply assert the registered commands never reject.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.showOutput');
    }, 'sharplsp.showOutput must not throw');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.showTraceOutput');
    }, 'sharplsp.showTraceOutput must not throw');
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 6 — tree.ts findNodeForUri / getParent reveal chain (issue #118)
// ─────────────────────────────────────────────────────────────────

suite('Tree Reveal E2E — active-editor parent chain', () => {
  let tmpDir: string;
  let provider: ExplorerApi['explorerProvider'];

  suiteSetup(async function () {
    this.timeout(120_000);
    const result = await setupLspTestSuite('tree-reveal-');
    tmpDir = result.tmpDir;
    provider = getProvider();
    await loadFixtureSolution(provider);
  });

  suiteTeardown(async () => {
    provider.clear();
    state.sortOrder.value = SortOrder.Alphabetical;
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  test('findNodeForUri resolves a Calculator node and getParent walks up to the solution root', () => {
    const calcUri = vscode.Uri.file(path.join(FIXTURE_DIR, 'Calculator.cs')).toString();
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const live = ext.exports as {
      explorerProvider: {
        findNodeForUri(uri: string): TreeNode | undefined;
        getParent(node: TreeNode): TreeNode | undefined;
        getChildren(element?: unknown): TreeNode[] | undefined;
      };
    };

    const node = live.explorerProvider.findNodeForUri(calcUri);
    assert.ok(node, 'a tree node living in Calculator.cs must resolve for active-editor sync');
    assert.strictEqual(node.symbolUri, calcUri, 'resolved node belongs to Calculator.cs');

    // Walk getParent() to the top; the chain must terminate at the solution root.
    const chain: TreeNode[] = [];
    let current: TreeNode | undefined = node;
    while (current !== undefined) {
      chain.push(current);
      assert.ok(chain.length < 50, 'parent chain must terminate (no cycle)');
      current = live.explorerProvider.getParent(current);
    }
    const top = chain[chain.length - 1];
    assert.ok(top, 'chain has a top');
    assert.strictEqual(
      top.contextValue,
      'solution',
      'reveal chain terminates at the solution root',
    );
    assert.ok(
      chain.some((entry) => entry.contextValue === 'project'),
      'chain passes through the project node so reveal can expand it',
    );

    const roots = live.explorerProvider.getChildren();
    assert.ok(roots?.[0]);
    assert.strictEqual(live.explorerProvider.getParent(roots[0]), undefined, 'root has no parent');
  });

  test('findNodeForUri returns undefined for a file that contributes no tree symbols', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const live = ext.exports as {
      explorerProvider: { findNodeForUri(uri: string): TreeNode | undefined };
    };
    const unrelated = vscode.Uri.file(path.join(os.tmpdir(), 'no-such-symbols.cs')).toString();
    assert.strictEqual(
      live.explorerProvider.findNodeForUri(unrelated),
      undefined,
      'an unrelated file uri resolves to no tree node',
    );
  });
});
