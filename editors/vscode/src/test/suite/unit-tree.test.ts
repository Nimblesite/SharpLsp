import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MarkdownString, ThemeColor, ThemeIcon, TreeItemCollapsibleState, Uri } from 'vscode';
import { ExplorerNode, SolutionExplorerProvider, buildQualifiedName } from '../../tree.js';
import { buildNonSymbolTooltip, SYMBOL_CONTEXT_VALUES } from '../../tree-tooltip.js';
import * as state from '../../state.js';
import {
  SortOrder,
  type ProjectNode,
  type SymbolNode,
  type LspRange,
  type WorkspaceSymbolsResponse,
} from '../../state.js';
import * as projectDeps from '../../project-deps-store.js';

// ── Test helpers ─────────────────────────────────────────────────

/** Build a fully-specified LspRange so symbol nodes wire commands/positions. */
function range(line: number, character: number): LspRange {
  return {
    start: { line, character },
    end: { line, character: character + 1 },
  };
}

/** Build a SymbolNode with sensible defaults. */
function symbol(partial: Partial<SymbolNode> & { name: string; kind: string }): SymbolNode {
  return {
    name: partial.name,
    kind: partial.kind,
    detail: partial.detail ?? null,
    access: partial.access ?? null,
    range: partial.range ?? range(0, 0),
    children: partial.children ?? [],
  };
}

/** Build a WorkspaceSymbolsResponse from project tuples. */
function response(projects: ProjectNode[]): WorkspaceSymbolsResponse {
  return { projects };
}

/** Build a ProjectNode pointing at a real path with top-level symbols in one file. */
function project(name: string, projectPath: string, symbols: SymbolNode[]): ProjectNode {
  return {
    name,
    path: projectPath,
    symbols: [{ file: `${projectPath}.cs`, symbols }],
  };
}

/** Reset every reactive signal touched by the tree to a pristine state. */
function resetTreeState(): void {
  state.symbolsState.value = { kind: 'empty' };
  state.solutionPath.value = undefined;
  state.sortOrder.value = SortOrder.Alphabetical;
  projectDeps.resetForTests();
}

/** Read a node's nodeType as a plain string (the enum itself is not exported). */
function nt(node: ExplorerNode): string {
  const value: string = node.nodeType;
  return value;
}

/** Narrow a node's iconPath to a ThemeIcon, asserting it is one. */
function themeIcon(node: ExplorerNode): ThemeIcon {
  assert.ok(node.iconPath instanceof ThemeIcon, 'iconPath must be a ThemeIcon');
  return node.iconPath;
}

/** Drive the provider into the loaded state for a single project, returning the solution root. */
function loadInto(
  provider: SolutionExplorerProvider,
  solutionPath: string,
  projects: ProjectNode[],
  order: SortOrder = SortOrder.Natural,
): ExplorerNode {
  state.sortOrder.value = order;
  state.solutionPath.value = solutionPath;
  state.symbolsState.value = { kind: 'loaded', response: response(projects) };
  const roots = provider.getChildren() as ExplorerNode[];
  const root = roots[0];
  assert.ok(root !== undefined, 'expected a solution root node');
  return root;
}

// ─────────────────────────────────────────────────────────────────
// SYMBOL_CONTEXT_VALUES
// ─────────────────────────────────────────────────────────────────

suite('tree-tooltip — SYMBOL_CONTEXT_VALUES', () => {
  test('maps every documented symbol kind to a stable contextValue', () => {
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Class, 'symbol.class');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Struct, 'symbol.struct');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Interface, 'symbol.interface');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Enum, 'symbol.enum');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Record, 'symbol.record');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Method, 'symbol.method');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Constructor, 'symbol.constructor');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Property, 'symbol.property');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Field, 'symbol.field');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Event, 'symbol.event');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Constant, 'symbol.constant');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.EnumMember, 'symbol.enumMember');
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Namespace, 'symbol.namespace');
  });

  test('maps Function kind to the delegate contextValue', () => {
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Function, 'symbol.delegate');
  });

  test('every value is namespaced under "symbol."', () => {
    const values = Object.values(SYMBOL_CONTEXT_VALUES);
    assert.ok(values.length >= 14, 'expected at least 14 mapped kinds');
    for (const value of values) {
      assert.ok(value.startsWith('symbol.'), `${value} must start with symbol.`);
    }
  });

  test('returns undefined for unknown kinds (no default)', () => {
    assert.strictEqual(SYMBOL_CONTEXT_VALUES.Totally_Made_Up, undefined);
    assert.strictEqual(SYMBOL_CONTEXT_VALUES[''], undefined);
  });
});

// ─────────────────────────────────────────────────────────────────
// buildNonSymbolTooltip
// ─────────────────────────────────────────────────────────────────

suite('tree-tooltip — buildNonSymbolTooltip', () => {
  teardown(() => {
    resetTreeState();
  });

  test('NuGet package node produces a MarkdownString with name and version', () => {
    const provider = new SolutionExplorerProvider();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-tooltip-nuget-'));
    try {
      const projPath = path.join(tmpDir, 'App.csproj');
      fs.writeFileSync(
        projPath,
        `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>` +
          `<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />` +
          `</ItemGroup></Project>`,
        'utf-8',
      );
      const root = loadInto(provider, path.join(tmpDir, 'App.sln'), [
        project('App', projPath, [symbol({ name: 'C', kind: 'Class' })]),
      ]);
      const projectNode = root.children[0];
      assert.ok(projectNode !== undefined);
      const depFolder = projectNode.children.find((c) => nt(c) === 'dependencyFolder');
      assert.ok(depFolder !== undefined, 'Dependencies folder must exist');
      const packagesFolder = depFolder.children.find((c) => c.label === 'Packages');
      assert.ok(packagesFolder !== undefined, 'Packages folder must exist');
      const pkg = packagesFolder.children[0];
      assert.ok(pkg !== undefined, 'package node must exist');

      const tooltip = buildNonSymbolTooltip(pkg);
      assert.ok(tooltip instanceof MarkdownString, 'tooltip must be a MarkdownString');
      assert.ok(tooltip.value.includes('**NuGet Package**'), 'has bold header');
      assert.ok(tooltip.value.includes('`Newtonsoft.Json`'), 'has code-fenced name');
      assert.ok(tooltip.value.includes('13.0.3'), 'has version');
      assert.ok(tooltip.value.includes('\n\n'), 'separates header from body');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns undefined for nodes that are not nugetPackage or projectRef', () => {
    const provider = new SolutionExplorerProvider();
    const root = loadInto(provider, '/x/Solution.sln', [
      project('P', '/x/P.csproj', [symbol({ name: 'Service', kind: 'Class' })]),
    ]);
    // Solution root, project node, and the symbol node are all non-tooltip kinds.
    assert.strictEqual(buildNonSymbolTooltip(root), undefined);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    assert.strictEqual(buildNonSymbolTooltip(projectNode), undefined);
    const symbolNode = projectNode.children.find((c) => nt(c) === 'symbol');
    assert.ok(symbolNode !== undefined);
    assert.strictEqual(buildNonSymbolTooltip(symbolNode), undefined);
  });

  test('returns undefined for a namespace node (LSP hover handles symbols)', () => {
    const provider = new SolutionExplorerProvider();
    const root = loadInto(provider, '/y/Sln.sln', [
      project('Ns', '/y/Ns.csproj', [
        symbol({
          name: 'My.Space',
          kind: 'Namespace',
          children: [symbol({ name: 'Widget', kind: 'Class' })],
        }),
      ]),
    ]);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    const ns = projectNode.children.find((c) => nt(c) === 'namespace');
    assert.ok(ns !== undefined, 'namespace node must exist');
    assert.strictEqual(buildNonSymbolTooltip(ns), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────
// SolutionExplorerProvider — empty / loading / error states
// ─────────────────────────────────────────────────────────────────

suite('SolutionExplorerProvider — top-level states', () => {
  let provider: SolutionExplorerProvider;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
  });

  teardown(() => {
    resetTreeState();
  });

  test('empty state with no solution yields no root nodes', () => {
    // The provider starts with roots = [] and rebuilds on signal change.
    state.symbolsState.value = { kind: 'loaded', response: response([]) };
    state.symbolsState.value = { kind: 'empty' };
    const roots = provider.getChildren() as ExplorerNode[];
    assert.deepStrictEqual(roots, []);
  });

  test('loaded response but undefined solution path yields no roots', () => {
    state.solutionPath.value = undefined;
    state.symbolsState.value = {
      kind: 'loaded',
      response: response([project('P', '/p/P.csproj', [])]),
    };
    const roots = provider.getChildren() as ExplorerNode[];
    assert.deepStrictEqual(roots, [], 'no solution path means no tree');
  });

  test('error state yields a single error node with error icon', () => {
    state.symbolsState.value = { kind: 'error', message: 'boom: disk on fire' };
    const roots = provider.getChildren() as ExplorerNode[];
    assert.strictEqual(roots.length, 1, 'error produces exactly one node');
    const errorNode = roots[0];
    assert.ok(errorNode !== undefined);
    assert.strictEqual(errorNode.label, 'Error: boom: disk on fire');
    assert.strictEqual(errorNode.collapsibleState, TreeItemCollapsibleState.None);
    assert.strictEqual(themeIcon(errorNode).id, 'error');
    assert.deepStrictEqual(errorNode.children, [], 'error node has no children');
  });

  test('error message is embedded verbatim including special characters', () => {
    state.symbolsState.value = { kind: 'error', message: 'a<b>&"c' };
    const roots = provider.getChildren() as ExplorerNode[];
    assert.strictEqual(roots[0]?.label, 'Error: a<b>&"c');
  });

  test('transitioning error -> empty clears the error node', () => {
    state.symbolsState.value = { kind: 'error', message: 'first' };
    assert.strictEqual((provider.getChildren() as ExplorerNode[]).length, 1);
    state.symbolsState.value = { kind: 'empty' };
    assert.deepStrictEqual(provider.getChildren(), []);
  });

  test('getChildren(element) returns the element children, not roots', () => {
    const root = loadInto(provider, '/g/Sol.sln', [
      project('P', '/g/P.csproj', [symbol({ name: 'A', kind: 'Class' })]),
    ]);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    const fromGetChildren = provider.getChildren(projectNode);
    assert.strictEqual(fromGetChildren, projectNode.children, 'returns the node.children array');
  });

  test('getTreeItem returns the node unchanged (identity)', () => {
    const root = loadInto(provider, '/h/Sol.sln', [project('P', '/h/P.csproj', [])]);
    assert.strictEqual(provider.getTreeItem(root), root);
  });
});

// ─────────────────────────────────────────────────────────────────
// SolutionExplorerProvider — loaded tree shape
// ─────────────────────────────────────────────────────────────────

suite('SolutionExplorerProvider — loaded solution tree', () => {
  let provider: SolutionExplorerProvider;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
  });

  teardown(() => {
    resetTreeState();
  });

  test('solution root carries label/icon/contextValue/path and is Expanded', () => {
    const root = loadInto(provider, '/repo/MyApp.sln', [project('Core', '/repo/Core.csproj', [])]);
    assert.strictEqual(root.label, 'MyApp.sln', 'label is the basename of the solution path');
    assert.strictEqual(nt(root), 'solution');
    assert.strictEqual(root.contextValue, 'solution');
    assert.strictEqual(root.sortName, 'MyApp.sln');
    assert.strictEqual(root.projectFilePath, '/repo/MyApp.sln');
    assert.strictEqual(root.collapsibleState, TreeItemCollapsibleState.Expanded);
    const icon = themeIcon(root);
    assert.strictEqual(icon.id, 'package');
    assert.ok(icon.color instanceof ThemeColor);
    assert.strictEqual(icon.color.id, 'terminal.ansiGreen');
  });

  test('project node label combines name and basename of project path', () => {
    const root = loadInto(provider, '/repo/Sln.sln', [
      project('MyLib', '/repo/src/MyLib.csproj', []),
    ]);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    assert.strictEqual(projectNode.label, 'MyLib (MyLib.csproj)');
    assert.strictEqual(nt(projectNode), 'project');
    assert.strictEqual(projectNode.contextValue, 'project');
    assert.strictEqual(projectNode.sortName, 'MyLib');
    assert.strictEqual(projectNode.projectFilePath, '/repo/src/MyLib.csproj');
    assert.strictEqual(projectNode.collapsibleState, TreeItemCollapsibleState.Expanded);
    const icon = themeIcon(projectNode);
    assert.strictEqual(icon.id, 'project');
    assert.ok(icon.color instanceof ThemeColor);
    assert.strictEqual(icon.color.id, 'terminal.ansiCyan');
  });

  test('multiple projects appear as siblings under the solution root', () => {
    const root = loadInto(provider, '/r/Big.sln', [
      project('Alpha', '/r/Alpha.csproj', []),
      project('Beta', '/r/Beta.csproj', []),
      project('Gamma', '/r/Gamma.csproj', []),
    ]);
    assert.strictEqual(root.children.length, 3);
    const labels = root.children.map((c) => c.label);
    assert.deepStrictEqual(labels, [
      'Alpha (Alpha.csproj)',
      'Beta (Beta.csproj)',
      'Gamma (Gamma.csproj)',
    ]);
  });

  test('a top-level class symbol wires icon, range, command and uri', () => {
    const root = loadInto(provider, '/s/Sol.sln', [
      project('P', '/s/P.csproj', [
        symbol({ name: 'Calculator', kind: 'Class', range: range(7, 4) }),
      ]),
    ]);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    const sym = projectNode.children.find((c) => nt(c) === 'symbol');
    assert.ok(sym !== undefined, 'class symbol must be present');
    assert.strictEqual(sym.label, 'Calculator');
    assert.strictEqual(sym.contextValue, 'symbol.class');
    assert.strictEqual(sym.symbolKind, 'Class');
    assert.strictEqual(sym.sortName, 'Calculator');
    assert.deepStrictEqual(sym.symbolRange, range(7, 4));
    assert.strictEqual(sym.collapsibleState, TreeItemCollapsibleState.None);
    assert.strictEqual(themeIcon(sym).id, 'symbol-class');
    // The file path is non-empty so a go-to command and symbolUri/Position attach.
    assert.ok(sym.command !== undefined, 'go-to command must be attached');
    assert.strictEqual(sym.command.command, 'vscode.open');
    assert.strictEqual(sym.command.title, 'Go to Symbol');
    assert.ok(Array.isArray(sym.command.arguments));
    assert.strictEqual(sym.command.arguments.length, 2);
    assert.ok(typeof sym.symbolUri === 'string' && sym.symbolUri.startsWith('file:'));
    assert.deepStrictEqual(sym.symbolPosition, { line: 7, character: 4 });
  });

  test('symbol with detail renders "name : detail" label', () => {
    const root = loadInto(provider, '/d/Sol.sln', [
      project('P', '/d/P.csproj', [symbol({ name: 'Count', kind: 'Property', detail: 'int' })]),
    ]);
    const sym = root.children[0]?.children.find((c) => nt(c) === 'symbol');
    assert.ok(sym !== undefined);
    assert.strictEqual(sym.label, 'Count : int');
    assert.strictEqual(themeIcon(sym).id, 'symbol-property');
  });

  test('symbol with null detail renders just the name', () => {
    const root = loadInto(provider, '/d2/Sol.sln', [
      project('P', '/d2/P.csproj', [symbol({ name: 'Count', kind: 'Field', detail: null })]),
    ]);
    const sym = root.children[0]?.children.find((c) => nt(c) === 'symbol');
    assert.ok(sym !== undefined);
    assert.strictEqual(sym.label, 'Count');
    assert.strictEqual(themeIcon(sym).id, 'symbol-field');
  });

  test('symbol with children is Collapsed and wires parent links', () => {
    const root = loadInto(provider, '/c/Sol.sln', [
      project('P', '/c/P.csproj', [
        symbol({
          name: 'Outer',
          kind: 'Class',
          children: [symbol({ name: 'Inner', kind: 'Method' })],
        }),
      ]),
    ]);
    const outer = root.children[0]?.children.find((c) => nt(c) === 'symbol');
    assert.ok(outer !== undefined);
    assert.strictEqual(outer.collapsibleState, TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(outer.children.length, 1);
    const inner = outer.children[0];
    assert.ok(inner !== undefined);
    assert.strictEqual(inner.label, 'Inner');
    assert.strictEqual(inner.parent, outer, 'child.parent points back to its parent');
    assert.strictEqual(themeIcon(inner).id, 'symbol-method');
  });

  test('access modifier is captured onto the node when present', () => {
    const root = loadInto(provider, '/a/Sol.sln', [
      project('P', '/a/P.csproj', [
        symbol({ name: 'Pub', kind: 'Method', access: 'public' }),
        symbol({ name: 'Priv', kind: 'Method', access: null }),
      ]),
    ]);
    const syms = root.children[0]?.children.filter((c) => nt(c) === 'symbol') ?? [];
    const pub = syms.find((s) => s.sortName === 'Pub');
    const priv = syms.find((s) => s.sortName === 'Priv');
    assert.strictEqual(pub?.access, 'public');
    assert.strictEqual(priv?.access, undefined, 'null access leaves access unset');
  });

  test('unknown symbol kind falls back to symbol-misc icon and symbol.unknown contextValue', () => {
    const root = loadInto(provider, '/u/Sol.sln', [
      project('P', '/u/P.csproj', [symbol({ name: 'Mystery', kind: 'Quark' })]),
    ]);
    const sym = root.children[0]?.children.find((c) => nt(c) === 'symbol');
    assert.ok(sym !== undefined);
    assert.strictEqual(themeIcon(sym).id, 'symbol-misc');
    assert.strictEqual(sym.contextValue, 'symbol.unknown');
  });

  test('each known symbol kind maps to its icon and contextValue', () => {
    const kinds: [kind: string, icon: string, context: string][] = [
      ['Class', 'symbol-class', 'symbol.class'],
      ['Struct', 'symbol-struct', 'symbol.struct'],
      ['Interface', 'symbol-interface', 'symbol.interface'],
      ['Enum', 'symbol-enum', 'symbol.enum'],
      ['EnumMember', 'symbol-enum-member', 'symbol.enumMember'],
      ['Method', 'symbol-method', 'symbol.method'],
      ['Constructor', 'symbol-constructor', 'symbol.constructor'],
      ['Property', 'symbol-property', 'symbol.property'],
      ['Field', 'symbol-field', 'symbol.field'],
      ['Event', 'symbol-event', 'symbol.event'],
      ['Constant', 'symbol-constant', 'symbol.constant'],
      ['Function', 'symbol-method', 'symbol.delegate'],
    ];
    const root = loadInto(provider, '/k/Sol.sln', [
      project(
        'P',
        '/k/P.csproj',
        kinds.map(([kind], i) => symbol({ name: `S${String(i)}`, kind })),
      ),
    ]);
    const syms = root.children[0]?.children.filter((c) => nt(c) === 'symbol') ?? [];
    for (const [kind, iconId, context] of kinds) {
      const node = syms.find((s) => s.symbolKind === kind);
      assert.ok(node !== undefined, `node for ${kind} must exist`);
      assert.strictEqual(themeIcon(node).id, iconId, `${kind} icon`);
      assert.strictEqual(node.contextValue, context, `${kind} contextValue`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// SolutionExplorerProvider — namespace grouping
// ─────────────────────────────────────────────────────────────────

suite('SolutionExplorerProvider — namespace grouping', () => {
  let provider: SolutionExplorerProvider;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
  });

  teardown(() => {
    resetTreeState();
  });

  test('a Namespace symbol becomes a collapsible namespace node holding its children', () => {
    const root = loadInto(provider, '/n/Sol.sln', [
      project('P', '/n/P.csproj', [
        symbol({
          name: 'Acme.Core',
          kind: 'Namespace',
          children: [
            symbol({ name: 'Widget', kind: 'Class' }),
            symbol({ name: 'Gadget', kind: 'Class' }),
          ],
        }),
      ]),
    ]);
    const ns = root.children[0]?.children.find((c) => nt(c) === 'namespace');
    assert.ok(ns !== undefined, 'namespace node present');
    assert.strictEqual(ns.label, 'Acme.Core');
    assert.strictEqual(ns.contextValue, 'symbol.namespace');
    assert.strictEqual(ns.symbolKind, 'Namespace');
    assert.strictEqual(ns.sortName, 'Acme.Core');
    assert.strictEqual(ns.collapsibleState, TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(themeIcon(ns).id, 'symbol-namespace');
    assert.strictEqual(ns.children.length, 2);
    for (const child of ns.children) {
      assert.strictEqual(child.parent, ns, 'namespace child parent wired');
    }
  });

  test('two files sharing a namespace name merge into one namespace node', () => {
    state.sortOrder.value = SortOrder.Natural;
    state.solutionPath.value = '/m/Sol.sln';
    state.symbolsState.value = {
      kind: 'loaded',
      response: {
        projects: [
          {
            name: 'P',
            path: '/m/P.csproj',
            symbols: [
              {
                file: '/m/A.cs',
                symbols: [
                  symbol({
                    name: 'Shared',
                    kind: 'Namespace',
                    children: [symbol({ name: 'First', kind: 'Class' })],
                  }),
                ],
              },
              {
                file: '/m/B.cs',
                symbols: [
                  symbol({
                    name: 'Shared',
                    kind: 'Namespace',
                    children: [symbol({ name: 'Second', kind: 'Class' })],
                  }),
                ],
              },
            ],
          },
        ],
      },
    };
    const roots = provider.getChildren() as ExplorerNode[];
    const projectNode = roots[0]?.children[0];
    assert.ok(projectNode !== undefined);
    const namespaces = projectNode.children.filter((c) => nt(c) === 'namespace');
    assert.strictEqual(namespaces.length, 1, 'same namespace name collapses into one node');
    const merged = namespaces[0];
    assert.ok(merged !== undefined);
    const childNames = merged.children.map((c) => c.sortName).sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(childNames, ['First', 'Second']);
  });

  test('non-namespace top-level symbols stay alongside namespace nodes', () => {
    const root = loadInto(provider, '/x/Sol.sln', [
      project('P', '/x/P.csproj', [
        symbol({
          name: 'Ns',
          kind: 'Namespace',
          children: [symbol({ name: 'InNs', kind: 'Class' })],
        }),
        symbol({ name: 'TopLevel', kind: 'Class' }),
      ]),
    ]);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    const ns = projectNode.children.find((c) => nt(c) === 'namespace');
    const top = projectNode.children.find((c) => nt(c) === 'symbol');
    assert.ok(ns !== undefined, 'namespace node present');
    assert.ok(top !== undefined, 'top-level symbol present');
    assert.strictEqual(top.label, 'TopLevel');
  });
});

// ─────────────────────────────────────────────────────────────────
// SolutionExplorerProvider — sort orders
// ─────────────────────────────────────────────────────────────────

suite('SolutionExplorerProvider — sort orders', () => {
  let provider: SolutionExplorerProvider;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
  });

  teardown(() => {
    resetTreeState();
  });

  function symbolNames(order: SortOrder): string[] {
    const root = loadInto(
      provider,
      '/sort/Sol.sln',
      [
        project('P', '/sort/P.csproj', [
          symbol({ name: 'Zebra', kind: 'Method', access: 'private' }),
          symbol({ name: 'Apple', kind: 'Method', access: 'public' }),
          symbol({ name: 'Mango', kind: 'Method', access: 'internal' }),
        ]),
      ],
      order,
    );
    return (root.children[0]?.children ?? []).map((c) => c.sortName);
  }

  test('Natural order preserves the original symbol sequence', () => {
    assert.deepStrictEqual(symbolNames(SortOrder.Natural), ['Zebra', 'Apple', 'Mango']);
  });

  test('Alphabetical order sorts symbols by name', () => {
    assert.deepStrictEqual(symbolNames(SortOrder.Alphabetical), ['Apple', 'Mango', 'Zebra']);
  });

  test('Accessibility order sorts by access priority then name', () => {
    // public(0) < internal(2) < private(5)
    assert.deepStrictEqual(symbolNames(SortOrder.Accessibility), ['Apple', 'Mango', 'Zebra']);
  });

  test('Accessibility order tie-breaks equal access by name', () => {
    const root = loadInto(
      provider,
      '/sort2/Sol.sln',
      [
        project('P', '/sort2/P.csproj', [
          symbol({ name: 'Charlie', kind: 'Method', access: 'public' }),
          symbol({ name: 'Alpha', kind: 'Method', access: 'public' }),
          symbol({ name: 'Bravo', kind: 'Method', access: 'public' }),
        ]),
      ],
      SortOrder.Accessibility,
    );
    const names = (root.children[0]?.children ?? []).map((c) => c.sortName);
    assert.deepStrictEqual(names, ['Alpha', 'Bravo', 'Charlie']);
  });

  test('Accessibility order ranks the full modifier ladder', () => {
    const ladder: [name: string, access: string][] = [
      ['EPrivate', 'private'],
      ['DProtected', 'protected'],
      ['CInternal', 'internal'],
      ['BProtInt', 'protected internal'],
      ['APublic', 'public'],
    ];
    const root = loadInto(
      provider,
      '/sort3/Sol.sln',
      [
        project(
          'P',
          '/sort3/P.csproj',
          ladder.map(([name, access]) => symbol({ name, kind: 'Method', access })),
        ),
      ],
      SortOrder.Accessibility,
    );
    const names = (root.children[0]?.children ?? []).map((c) => c.sortName);
    assert.deepStrictEqual(names, ['APublic', 'BProtInt', 'CInternal', 'DProtected', 'EPrivate']);
  });

  test('symbols without access modifier sort last under Accessibility', () => {
    const root = loadInto(
      provider,
      '/sort4/Sol.sln',
      [
        project('P', '/sort4/P.csproj', [
          symbol({ name: 'NoAccess', kind: 'Method', access: null }),
          symbol({ name: 'Public', kind: 'Method', access: 'public' }),
        ]),
      ],
      SortOrder.Accessibility,
    );
    const names = (root.children[0]?.children ?? []).map((c) => c.sortName);
    assert.deepStrictEqual(names, ['Public', 'NoAccess']);
  });

  test('Alphabetical order recurses into nested children', () => {
    const root = loadInto(
      provider,
      '/sort5/Sol.sln',
      [
        project('P', '/sort5/P.csproj', [
          symbol({
            name: 'Container',
            kind: 'Class',
            children: [
              symbol({ name: 'zMethod', kind: 'Method' }),
              symbol({ name: 'aMethod', kind: 'Method' }),
            ],
          }),
        ]),
      ],
      SortOrder.Alphabetical,
    );
    const container = root.children[0]?.children.find((c) => nt(c) === 'symbol');
    assert.ok(container !== undefined);
    const childNames = container.children.map((c) => c.sortName);
    assert.deepStrictEqual(childNames, ['aMethod', 'zMethod']);
  });
});

// ─────────────────────────────────────────────────────────────────
// SolutionExplorerProvider — dependency folders (real csproj on disk)
// ─────────────────────────────────────────────────────────────────

suite('SolutionExplorerProvider — dependency folders', () => {
  let provider: SolutionExplorerProvider;
  let tmpDir: string;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-deps-'));
  });

  teardown(() => {
    resetTreeState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('project with no dependencies has no Dependencies folder', () => {
    const projPath = path.join(tmpDir, 'Bare.csproj');
    fs.writeFileSync(projPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>', 'utf-8');
    const root = loadInto(provider, path.join(tmpDir, 'Bare.sln'), [
      project('Bare', projPath, [symbol({ name: 'X', kind: 'Class' })]),
    ]);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    const dep = projectNode.children.find((c) => nt(c) === 'dependencyFolder');
    assert.strictEqual(dep, undefined, 'no Dependencies folder when there are no deps');
  });

  test('project with packages and project refs builds the full Dependencies subtree', () => {
    const refPath = path.join(tmpDir, 'Lib.csproj');
    fs.writeFileSync(refPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>', 'utf-8');
    const projPath = path.join(tmpDir, 'App.csproj');
    fs.writeFileSync(
      projPath,
      `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>` +
        `<PackageReference Include="Serilog" Version="3.0.0" />` +
        `<ProjectReference Include="Lib.csproj" />` +
        `</ItemGroup></Project>`,
      'utf-8',
    );
    const root = loadInto(provider, path.join(tmpDir, 'App.sln'), [
      project('App', projPath, [symbol({ name: 'Program', kind: 'Class' })]),
    ]);
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);

    const dep = projectNode.children.find((c) => nt(c) === 'dependencyFolder');
    assert.ok(dep !== undefined, 'Dependencies folder must exist');
    assert.strictEqual(dep.label, 'Dependencies');
    assert.strictEqual(dep.contextValue, 'dependencyFolder');
    assert.strictEqual(dep.collapsibleState, TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(themeIcon(dep).id, 'extensions');

    const packages = dep.children.find((c) => c.label === 'Packages');
    const projects = dep.children.find((c) => c.label === 'Projects');
    assert.ok(packages !== undefined, 'Packages subfolder present');
    assert.ok(projects !== undefined, 'Projects subfolder present');

    const pkg = packages.children[0];
    assert.ok(pkg !== undefined);
    assert.strictEqual(pkg.label, 'Serilog');
    assert.strictEqual(pkg.description, '3.0.0');
    assert.strictEqual(pkg.contextValue, 'nugetPackage');
    assert.strictEqual(pkg.referenceName, 'Serilog');
    // buildNuGetNode stores the original (unresolved) project.path verbatim.
    assert.strictEqual(pkg.projectFilePath, projPath);
    assert.strictEqual(themeIcon(pkg).id, 'package');

    const ref = projects.children[0];
    assert.ok(ref !== undefined);
    assert.strictEqual(ref.label, 'Lib');
    assert.strictEqual(ref.contextValue, 'projectReference');
    assert.strictEqual(ref.referenceName, 'Lib.csproj');
    assert.strictEqual(ref.projectFilePath, projPath);
    assert.strictEqual(themeIcon(ref).id, 'project');
  });

  test('Dependencies folder is pinned first even after alphabetical sort', () => {
    const projPath = path.join(tmpDir, 'Pinned.csproj');
    fs.writeFileSync(
      projPath,
      `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>` +
        `<PackageReference Include="AAA" Version="1.0.0" />` +
        `</ItemGroup></Project>`,
      'utf-8',
    );
    const root = loadInto(
      provider,
      path.join(tmpDir, 'Pinned.sln'),
      [
        project('Pinned', projPath, [
          symbol({ name: 'Zeta', kind: 'Class' }),
          symbol({ name: 'aardvark', kind: 'Class' }),
        ]),
      ],
      SortOrder.Alphabetical,
    );
    const projectNode = root.children[0];
    assert.ok(projectNode !== undefined);
    const first = projectNode.children[0];
    assert.ok(first !== undefined);
    assert.strictEqual(nt(first), 'dependencyFolder', 'Dependencies must stay at index 0');
    // The remaining symbol nodes are alphabetised after the pinned folder.
    const rest = projectNode.children.slice(1).map((c) => c.sortName);
    assert.deepStrictEqual(rest, ['aardvark', 'Zeta']);
  });

  test('packages-only project omits the Projects subfolder', () => {
    const projPath = path.join(tmpDir, 'PkgOnly.csproj');
    fs.writeFileSync(
      projPath,
      `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>` +
        `<PackageReference Include="Solo" Version="2.0.0" />` +
        `</ItemGroup></Project>`,
      'utf-8',
    );
    const root = loadInto(provider, path.join(tmpDir, 'PkgOnly.sln'), [
      project('PkgOnly', projPath, []),
    ]);
    const dep = root.children[0]?.children.find((c) => nt(c) === 'dependencyFolder');
    assert.ok(dep !== undefined);
    assert.strictEqual(dep.children.length, 1, 'only Packages subfolder');
    assert.strictEqual(dep.children[0]?.label, 'Packages');
  });
});

// ─────────────────────────────────────────────────────────────────
// SolutionExplorerProvider — solution picker
// ─────────────────────────────────────────────────────────────────

suite('SolutionExplorerProvider — solution picker', () => {
  let provider: SolutionExplorerProvider;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
  });

  teardown(() => {
    resetTreeState();
  });

  test('showSolutionPicker builds one clickable choice node per discovered solution', () => {
    provider.showSolutionPicker([
      { name: 'First.sln', path: '/repo/First.sln' },
      { name: 'Second.slnx', path: '/repo/nested/Second.slnx' },
    ]);
    const roots = provider.getChildren() as ExplorerNode[];
    assert.strictEqual(roots.length, 2);

    const first = roots[0];
    assert.ok(first !== undefined);
    assert.strictEqual(first.label, 'First.sln');
    assert.strictEqual(first.description, '/repo/First.sln');
    assert.strictEqual(first.contextValue, 'solutionChoice');
    assert.strictEqual(first.collapsibleState, TreeItemCollapsibleState.None);
    assert.strictEqual(themeIcon(first).id, 'file-symlink-directory');
    assert.ok(first.command !== undefined, 'choice node must have an open command');
    assert.strictEqual(first.command.command, 'sharplsp.openSolution');
    assert.strictEqual(first.command.title, 'Open Solution');
    assert.deepStrictEqual(first.command.arguments, ['/repo/First.sln']);

    const second = roots[1];
    assert.ok(second !== undefined);
    assert.strictEqual(second.label, 'Second.slnx');
    assert.deepStrictEqual(second.command?.arguments, ['/repo/nested/Second.slnx']);
  });

  test('showSolutionPicker with empty list yields no nodes', () => {
    provider.showSolutionPicker([]);
    assert.deepStrictEqual(provider.getChildren(), []);
  });

  test('a subsequent loaded-symbols signal replaces picker nodes', () => {
    provider.showSolutionPicker([{ name: 'Pick.sln', path: '/p/Pick.sln' }]);
    assert.strictEqual((provider.getChildren() as ExplorerNode[]).length, 1);
    const root = loadInto(provider, '/p/Real.sln', [project('P', '/p/P.csproj', [])]);
    assert.strictEqual(root.label, 'Real.sln', 'loaded solution overrides picker');
  });
});

// ─────────────────────────────────────────────────────────────────
// SolutionExplorerProvider — active editor reveal (issue #118)
// ─────────────────────────────────────────────────────────────────

suite('SolutionExplorerProvider — active editor reveal', () => {
  let provider: SolutionExplorerProvider;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
  });

  teardown(() => {
    resetTreeState();
  });

  test('findNodeForUri resolves a tree node living in the given file', () => {
    loadInto(provider, '/ar/Sol.sln', [
      project('P', '/ar/P.csproj', [symbol({ name: 'Service', kind: 'Class' })]),
    ]);
    // project() places symbols in `${projectPath}.cs`.
    const fileUri = Uri.file('/ar/P.csproj.cs').toString();

    const node = provider.findNodeForUri(fileUri);
    assert.ok(node !== undefined, 'must find a node whose file is the active editor');
    assert.strictEqual(node.symbolUri, fileUri, 'resolved node must belong to the file');
    assert.strictEqual(node.label, 'Service');
  });

  test('findNodeForUri returns undefined for a file with no symbols in the tree', () => {
    loadInto(provider, '/ar0/Sol.sln', [
      project('P', '/ar0/P.csproj', [symbol({ name: 'Only', kind: 'Class' })]),
    ]);
    const node = provider.findNodeForUri(Uri.file('/ar0/Unrelated.cs').toString());
    assert.strictEqual(node, undefined, 'no node matches an unrelated file uri');
  });

  test('getParent yields a complete chain from a file node up to the solution root', () => {
    const root = loadInto(provider, '/ar2/Sol.sln', [
      project('P', '/ar2/P.csproj', [
        symbol({
          name: 'Ns',
          kind: 'Namespace',
          children: [symbol({ name: 'Widget', kind: 'Class' })],
        }),
      ]),
    ]);
    const fileUri = Uri.file('/ar2/P.csproj.cs').toString();
    const node = provider.findNodeForUri(fileUri);
    assert.ok(node !== undefined, 'symbol node must resolve');

    // TreeView.reveal walks getParent() to the root; every ancestor must be
    // returned or the reveal silently no-ops (the #118 symptom).
    const chain: ExplorerNode[] = [];
    let current: ExplorerNode | undefined = node;
    while (current !== undefined) {
      chain.push(current);
      current = provider.getParent(current) as ExplorerNode | undefined;
      assert.ok(chain.length < 50, 'parent chain must terminate (no cycle)');
    }

    const top = chain[chain.length - 1];
    assert.ok(top !== undefined);
    assert.strictEqual(nt(top), 'solution', 'chain must terminate at the solution root');
    assert.strictEqual(top, root, 'chain must reach the exact solution root instance');
    assert.ok(
      chain.some((n) => nt(n) === 'project'),
      'chain must pass through the project node so reveal expands it',
    );
    assert.ok(
      chain.some((n) => nt(n) === 'namespace'),
      'chain must pass through the namespace node',
    );
  });

  test('getParent returns undefined for a solution root (top of the tree)', () => {
    const root = loadInto(provider, '/ar3/Sol.sln', [project('P', '/ar3/P.csproj', [])]);
    assert.strictEqual(provider.getParent(root), undefined, 'the root has no parent');
  });
});

// ─────────────────────────────────────────────────────────────────
// buildQualifiedName
// ─────────────────────────────────────────────────────────────────

suite('tree — buildQualifiedName', () => {
  let provider: SolutionExplorerProvider;

  setup(() => {
    resetTreeState();
    provider = new SolutionExplorerProvider();
  });

  teardown(() => {
    resetTreeState();
  });

  test('a top-level symbol (no parent) qualifies to just its own name', () => {
    const root = loadInto(provider, '/q/Sol.sln', [
      project('P', '/q/P.csproj', [symbol({ name: 'Solo', kind: 'Class' })]),
    ]);
    const sym = root.children[0]?.children.find((c) => nt(c) === 'symbol');
    assert.ok(sym !== undefined);
    assert.strictEqual(buildQualifiedName(sym), 'Solo');
  });

  test('a namespace node qualifies to its own name (project ancestor is skipped)', () => {
    const root = loadInto(provider, '/q2/Sol.sln', [
      project('P', '/q2/P.csproj', [
        symbol({
          name: 'My.Ns',
          kind: 'Namespace',
          children: [symbol({ name: 'Thing', kind: 'Class' })],
        }),
      ]),
    ]);
    const ns = root.children[0]?.children.find((c) => nt(c) === 'namespace');
    assert.ok(ns !== undefined);
    assert.strictEqual(buildQualifiedName(ns), 'My.Ns');
  });

  test('a class inside a namespace qualifies as Namespace.Class', () => {
    const root = loadInto(provider, '/q3/Sol.sln', [
      project('P', '/q3/P.csproj', [
        symbol({
          name: 'Acme',
          kind: 'Namespace',
          children: [symbol({ name: 'Widget', kind: 'Class' })],
        }),
      ]),
    ]);
    const ns = root.children[0]?.children.find((c) => nt(c) === 'namespace');
    assert.ok(ns !== undefined);
    const widget = ns.children[0];
    assert.ok(widget !== undefined);
    assert.strictEqual(buildQualifiedName(widget), 'Acme.Widget');
  });

  test('a method nested in a class nested in a namespace qualifies through all three', () => {
    const root = loadInto(provider, '/q4/Sol.sln', [
      project('P', '/q4/P.csproj', [
        symbol({
          name: 'Acme',
          kind: 'Namespace',
          children: [
            symbol({
              name: 'Widget',
              kind: 'Class',
              children: [symbol({ name: 'Spin', kind: 'Method' })],
            }),
          ],
        }),
      ]),
    ]);
    const ns = root.children[0]?.children.find((c) => nt(c) === 'namespace');
    assert.ok(ns !== undefined);
    const widget = ns.children[0];
    assert.ok(widget !== undefined);
    const spin = widget.children[0];
    assert.ok(spin !== undefined);
    assert.strictEqual(buildQualifiedName(spin), 'Acme.Widget.Spin');
  });

  test('walking upward skips non-symbol/non-namespace ancestors', () => {
    // A symbol directly under the project: buildQualifiedName walks the parent
    // chain but contributes only Namespace/Symbol ancestors, so the wired
    // project and solution ancestors never leak into the qualified name.
    const root = loadInto(provider, '/q5/Sol.sln', [
      project('MyProj', '/q5/P.csproj', [symbol({ name: 'Direct', kind: 'Class' })]),
    ]);
    const sym = root.children[0]?.children.find((c) => nt(c) === 'symbol');
    assert.ok(sym !== undefined);
    const qualified = buildQualifiedName(sym);
    assert.strictEqual(qualified, 'Direct');
    assert.ok(!qualified.includes('MyProj'), 'project name must not leak into qualified name');
    assert.ok(!qualified.includes('Sol'), 'solution name must not leak into qualified name');
  });
});
