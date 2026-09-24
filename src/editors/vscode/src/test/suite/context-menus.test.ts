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
  type SymbolTree,
  type TreeNode,
  assertRuns,
  copiedText,
  findNode,
  labelled,
  loadTreeUntil,
  nodeLabel,
  requireNode,
  requireSolutionNode,
  useSymbolTree,
} from './context-menu-kit';
import { activeExplorerProvider } from './explorer-kit';
import { useLspTestSuite } from './lsp-suite-kit';
import {
  EXTENSION_ID,
  openSharpLspPanel,
  pollUntilResult,
  takeScreenshot,
  assertContainsAll,
  assertContainsNone,
} from './test-helpers';
import { installUiStubs } from './ui-stubs';
import { ACTIVATION_MS, COMMAND_MS, LSP_RESPONSE_MS } from './test-timeouts';

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

interface MenuEntry {
  readonly command: string;
  readonly when: string;
  readonly group: string;
}

interface Contributes {
  readonly menus?: Readonly<Record<string, MenuEntry[]>>;
  readonly commands?: { command: string }[];
}

/** The extension manifest's `contributes` block. */
function contributes(): Contributes {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'Extension must be found');
  return (ext.packageJSON.contributes ?? {}) as Contributes;
}

/** Every entry the manifest contributes to `menu`. */
function menuEntries(menu = 'view/item/context'): MenuEntry[] {
  return contributes().menus?.[menu] ?? [];
}

/** `command`'s view/item/context entry, asserted present. */
function menuEntry(command: string): MenuEntry {
  const entry = menuEntries().find((m) => m.command === command);
  assert.ok(entry, `${command} must have a view/item/context menu entry`);
  return entry;
}

const BUILD_COMMANDS = ['sharplsp.build', 'sharplsp.rebuild', 'sharplsp.clean'];

suite('Context Menu — Package.json Contributions', () => {
  // ── Command registration ──────────────────────────────────────

  for (const cmd of [
    'sharplsp.copyQualifiedName',
    'sharplsp.copyName',
    'sharplsp.revealInExplorer',
    'sharplsp.sortMembers',
    'sharplsp.openProjectFile',
    ...BUILD_COMMANDS,
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

  for (const cmd of BUILD_COMMANDS) {
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

  // ── sortMembers when clause and group ─────────────────────────

  test('sortMembers is offered on type nodes of the solutionExplorer view only', () => {
    const { when } = menuEntry('sharplsp.sortMembers');
    for (const scope of ['class', 'interface', 'enum', 'record', 'sharplsp.solutionExplorer']) {
      assert.ok(when.includes(scope), `sortMembers when clause must include '${scope}': ${when}`);
    }
    // The pattern should only match type-level nodes (class, struct, etc.)
    // It must NOT be a catch-all for all symbol nodes.
    for (const member of ['symbol.method', 'symbol.property', 'symbol.field']) {
      assert.ok(!when.includes(member), `sortMembers must NOT show for ${member} nodes`);
    }
  });

  test('sortMembers is in a modification group', () => {
    const { group } = menuEntry('sharplsp.sortMembers');
    assert.ok(
      group.includes('modification') || group.startsWith('1'),
      `sortMembers group '${group}' should be a modification group`,
    );
  });

  // ── copy / reveal when clauses and groups ─────────────────────

  for (const cmd of [
    'sharplsp.copyQualifiedName',
    'sharplsp.copyName',
    'sharplsp.revealInExplorer',
  ]) {
    test(`${cmd} when clause scopes to symbol nodes of the solutionExplorer view`, () => {
      const { when } = menuEntry(cmd);
      assertContainsAll(when, ['symbol', 'sharplsp.solutionExplorer'], 'when');
    });
  }

  for (const cmd of ['sharplsp.copyQualifiedName', 'sharplsp.copyName']) {
    test(`${cmd} is in a copy/paste group`, () => {
      const { group } = menuEntry(cmd);
      assert.ok(
        group.includes('cutcopypaste') || group.includes('copy') || group.startsWith('9'),
        `${cmd} group '${group}' should be a copy/paste group`,
      );
    });
  }

  test('copyName when clause covers solution and project nodes', () => {
    const { when } = menuEntry('sharplsp.copyName');
    assert.ok(
      when.includes('solution') || when.includes('project'),
      `copyName when clause '${when}' should cover solution or project nodes`,
    );
  });
});

// ── Suite 2: Context Values ───────────────────────────────────────

/** Every non-namespace node type the AllTypes source declares, by the label it carries. */
const CONTEXT_VALUES: readonly (readonly [contextValue: string, label: string])[] = [
  ['project', ''],
  ['symbol.namespace', 'AllTypesNS'],
  ['symbol.class', 'AllTypesClass'],
  ['symbol.interface', 'IRunner'],
  ['symbol.struct', 'MyPoint'],
  ['symbol.enum', 'MyEnum'],
  ['symbol.enumMember', 'Alpha'],
  ['symbol.field', '_count'],
  ['symbol.event', 'Changed'],
  ['symbol.constructor', ''],
  ['symbol.delegate', 'MyDelegate'],
];

/** Every node at or below `nodes` a menu keys on, depth-first. */
function everyNode(nodes: TreeNode[] | undefined): TreeNode[] {
  return (nodes ?? []).flatMap((node) => [node, ...everyNode(node.children)]);
}

suite('Context Menu — Context Values on Tree Nodes', () => {
  // Use the fixture workspace — it already has TestFixtures.sln loaded and
  // Roslyn is guaranteed to be warm after setupLspTestSuite completes.
  const fixtureDir = path.resolve(__dirname, '../../../test-fixtures/workspace');
  const allTypesPath = path.join(fixtureDir, 'AllTypesCtx.cs');
  let tree: SymbolTree;

  // Registered before the LSP suite hooks, so it runs before their teardown.
  suiteTeardown(() => {
    // Remove the temp file added to the fixture workspace.
    fs.rmSync(allTypesPath, { force: true });
    tree.clear();
  });
  useLspTestSuite('ctx-val-');
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    tree = activeExplorerProvider<TreeNode>();
    // Write AllTypesCtx source INTO the fixture project so Roslyn can analyze it.
    fs.writeFileSync(allTypesPath, ALL_TYPES_CS, 'utf8');
    const slnPath = path.join(fixtureDir, 'TestFixtures.sln');
    await loadTreeUntil(tree, slnPath, allTypesPath, labelled('AllTypesClass'), 60_000);
  });

  test("solution node has contextValue 'solution'", async function () {
    this.timeout(COMMAND_MS);
    requireSolutionNode(tree);
    await openSharpLspPanel();
    await takeScreenshot('vscode-solution-explorer-context-menu.png');
  });

  for (const [contextValue, label] of CONTEXT_VALUES) {
    test(`${label || 'a'} node has contextValue '${contextValue}'`, () => {
      requireNode(tree.getChildren(), label, contextValue);
    });
  }

  for (const [contextValue, label] of [
    ['symbol.method', 'Execute'],
    ['symbol.property', 'Label'],
  ] as const) {
    test(`${label} under AllTypesClass has contextValue '${contextValue}'`, () => {
      const owner = requireNode(tree.getChildren(), 'AllTypesClass', 'symbol.class');
      requireNode(owner.children, label, contextValue);
    });
  }

  test("record node has contextValue 'symbol.class' or 'symbol.record'", () => {
    // Records can be mapped to class or record depending on the grammar.
    const node = findNode(
      tree.getChildren(),
      (n) =>
        nodeLabel(n).includes('MyRecord') &&
        (n.contextValue === 'symbol.class' || n.contextValue === 'symbol.record'),
    );
    assert.ok(node, "MyRecord must have contextValue 'symbol.class' or 'symbol.record'");
  });

  test("all symbol nodes have a contextValue starting with 'symbol.'", () => {
    // Non-symbol nodes (solution, project, dependencyFolder, etc.) are OK without symbol prefix.
    const structural = [
      'solution',
      'project',
      'dependencyFolder',
      'nugetPackage',
      'projectReference',
    ];
    const symbols = everyNode(tree.getChildren()).filter(
      (node) => (node.contextValue ?? '') !== '' && !structural.includes(node.contextValue ?? ''),
    );
    const badNodes = symbols
      .filter((node) => !(node.contextValue ?? '').startsWith('symbol.'))
      .map((node) => `${nodeLabel(node)} (contextValue=${node.contextValue ?? ''})`);
    assert.ok(symbols.length > 0, 'Must find at least some symbol nodes in the tree');
    assert.deepEqual(
      badNodes,
      [],
      `These nodes have unexpected contextValues: ${badNodes.join(', ')}`,
    );
  });
});

// ── Suite 3: Copy Qualified Name ─────────────────────────────────

const QUALIFIED_CS = `namespace OuterNS
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
}`;

/** `[label, contextValue, parts the qualified name must carry]`. */
const QUALIFIED: readonly (readonly [string, string | undefined, readonly string[]])[] = [
  ['OuterClass', undefined, ['OuterNS', 'OuterClass']],
  ['OuterMethod', 'symbol.method', ['OuterNS', 'OuterClass', 'OuterMethod']],
  ['OuterProp', 'symbol.property', ['OuterNS', 'OuterClass', 'OuterProp']],
  ['IService', undefined, ['OuterNS', 'IService']],
  ['InnerClass', 'symbol.class', ['InnerClass']],
  ['InnerMethod', 'symbol.method', ['InnerMethod']],
];

suite('Context Menu — Copy Qualified Name', () => {
  const tree = useSymbolTree('ctx-qual-', 'QualNS', QUALIFIED_CS, labelled('OuterClass'));

  for (const [label, contextValue, parts] of QUALIFIED) {
    test(`copyQualifiedName for ${label} produces a dotted path through ${parts.join(', ')}`, async function () {
      this.timeout(COMMAND_MS);
      const node = requireNode(tree().getChildren(), label, contextValue);
      const text = await copiedText('sharplsp.copyQualifiedName', node, '');
      for (const part of parts) {
        assert.ok(text.includes(part), `Expected '${part}' in the qualified name, got '${text}'`);
      }
      assert.ok(text.includes('.'), 'Qualified name must contain a dot separator');
      assert.ok(!text.startsWith('.'), 'Qualified name must not start with a dot');
      assert.ok(!text.endsWith('.'), 'Qualified name must not end with a dot');
    });
  }
});

// ── Suite 4: Copy Name ────────────────────────────────────────────

suite('Context Menu — Copy Name', () => {
  const tree = useSymbolTree('ctx-name-', 'CopyNameTest', ALL_TYPES_CS, labelled('AllTypesClass'));

  for (const [label, contextValue] of [
    ['AllTypesClass'],
    ['Execute', 'symbol.method'],
    ['IRunner'],
    ['Label', 'symbol.property'],
    ['MyEnum'],
    ['MyPoint'],
  ] as const) {
    test(`copyName for ${label} copies just its unqualified name`, async function () {
      this.timeout(COMMAND_MS);
      const node = requireNode(tree().getChildren(), label, contextValue);
      const text = await copiedText('sharplsp.copyName', node, 'BEFORE');
      assert.strictEqual(text, label, `Expected '${label}', got '${text}'`);
      assert.ok(!text.includes('.'), `copyName must return unqualified name, got '${text}'`);
    });
  }

  test('copyName for solution node copies solution filename', async function () {
    this.timeout(COMMAND_MS);
    const text = await copiedText('sharplsp.copyName', requireSolutionNode(tree()), 'BEFORE');
    assert.ok(
      text.length > 0 && text !== 'BEFORE',
      `copyName for solution must write something to clipboard, got '${text}'`,
    );
  });
});

// ── Suite 5: Reveal in File Explorer ─────────────────────────────

const REVEAL_CS = `namespace RevealNS
{
    public class RevealClass
    {
        public void RevealMethod() { }
        public string RevealProp { get; set; }
        private int _revealField;
    }
}`;

const REVEALED = [
  ['RevealClass', 'symbol.class'],
  ['RevealMethod', 'symbol.method'],
  ['RevealProp', 'symbol.property'],
  ['_revealField', 'symbol.field'],
] as const;

suite('Context Menu — Reveal in File Explorer', () => {
  const tree = useSymbolTree('ctx-reveal-', 'RevealTest', REVEAL_CS, labelled('RevealClass'));

  for (const [label, contextValue] of REVEALED) {
    test(`${label} carries a symbolUri pointing at the source file`, () => {
      const { symbolUri } = requireNode(tree().getChildren(), label, contextValue);
      assert.ok(symbolUri !== undefined, `${label} must have symbolUri set for Reveal in Explorer`);
      assert.ok(
        symbolUri.includes('Source.cs'),
        `symbolUri '${symbolUri}' must reference Source.cs`,
      );
    });
  }

  for (const [label, contextValue] of REVEALED.slice(0, 2)) {
    test(`revealInExplorer executes without error for ${label}`, async function () {
      this.timeout(COMMAND_MS);
      await assertRuns(
        'sharplsp.revealInExplorer',
        requireNode(tree().getChildren(), label, contextValue),
      );
    });
  }

  test('revealInExplorer handles node without symbolUri gracefully', async function () {
    this.timeout(COMMAND_MS);
    // Node without symbolUri — revealInExplorer must silently return.
    await assertRuns('sharplsp.revealInExplorer', {
      symbolUri: undefined,
      sortName: 'NoUri',
      contextValue: 'symbol.class',
    });
  });

  test('symbolUri on all symbol nodes is a valid file URI', () => {
    const symbols = everyNode(tree().getChildren()).filter((node) => {
      const cv = node.contextValue ?? '';
      return cv.startsWith('symbol.') && cv !== 'symbol.namespace';
    });
    const badNodes = symbols
      .filter((node) => !(node.symbolUri ?? '').startsWith('file://'))
      .map((node) => `${nodeLabel(node)} (${node.contextValue ?? ''}): ${node.symbolUri ?? ''}`);
    assert.ok(symbols.length > 0, 'Must find at least some non-namespace symbol nodes');
    assert.deepEqual(
      badNodes,
      [],
      `These symbol nodes are missing a valid symbolUri: ${badNodes.join(', ')}`,
    );
  });
});

// ── Suite 6: Context Menu Only Appears on Correct Node Types ──────

/** Each menu's `when` clause, simulated, with the context values it must and must not take. */
const SCOPES: readonly {
  readonly command: string;
  readonly matches: (contextValue: string) => boolean;
  readonly mustMatch: readonly string[];
  readonly mustNotMatch: readonly string[];
}[] = [
  {
    command: 'sortMembers',
    // Simulate the VS Code 'when' clause regex.
    matches: (cv) => /^symbol\.(class|struct|interface|enum|record)$/.test(cv),
    mustMatch: [
      'symbol.class',
      'symbol.struct',
      'symbol.interface',
      'symbol.enum',
      'symbol.record',
    ],
    mustNotMatch: [
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
    ],
  },
  {
    command: 'revealInExplorer',
    matches: (cv) => cv.startsWith('symbol.'),
    mustMatch: [
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
    ],
    mustNotMatch: ['solution', 'project', 'nugetPackage', 'projectReference', 'dependencyFolder'],
  },
  {
    command: 'copyQualifiedName',
    matches: (cv) => cv.startsWith('symbol.'),
    mustMatch: ['symbol.class', 'symbol.method', 'symbol.property', 'symbol.namespace'],
    mustNotMatch: ['solution', 'project'],
  },
  {
    command: 'copyName',
    // Pattern from package.json.
    matches: (cv) => /^(symbol\.|solution$|project$)/.test(cv),
    mustMatch: ['symbol.class', 'symbol.method', 'solution', 'project'],
    mustNotMatch: ['nugetPackage', 'projectReference', 'dependencyFolder'],
  },
];

suite('Context Menu — Correct Node Type Scoping', () => {
  for (const { command, matches, mustMatch, mustNotMatch } of SCOPES) {
    test(`${command} contextValue pattern matches exactly its node types`, () => {
      for (const cv of mustMatch) {
        assert.ok(matches(cv), `${command} pattern must match '${cv}'`);
      }
      for (const cv of mustNotMatch) {
        assert.ok(!matches(cv), `${command} pattern must NOT match '${cv}'`);
      }
    });
  }

  test('SYMBOL_CONTEXT_VALUES covers all expected symbol kinds', () => {
    // The extension's menus use 'symbol.' prefix — every kind the tree emits
    // must satisfy the copyQualifiedName and revealInExplorer patterns.
    const symbolKinds = [...CONTEXT_VALUES.map(([cv]) => cv), 'symbol.method', 'symbol.property'];
    const badKinds = symbolKinds.filter((k) => k !== 'project' && !k.startsWith('symbol.'));
    assert.deepEqual(badKinds, [], "All symbol context values must start with 'symbol.'");
  });
});

// ── Suite 7: Every Context Menu Command is Registered ──────────────

suite('Context Menu — All view/item/context Commands Registered', () => {
  for (const [where, declared] of [
    ['view/item/context menus', () => menuEntries('view/item/context')],
    ['view/title menus', () => menuEntries('view/title')],
    ['package.json commands', () => contributes().commands ?? []],
  ] as const) {
    test(`every command in ${where} is a registered VS Code command`, async () => {
      const commands = declared().map((entry) => entry.command);
      assert.ok(commands.length > 0, `Must have ${where} entries`);
      const registered = await vscode.commands.getCommands(true);
      const missing = commands.filter((command) => !registered.includes(command));
      assert.deepEqual(
        missing,
        [],
        `These ${where} entries are declared in package.json but NOT registered: ${missing.join(', ')}`,
      );
    });
  }
});

// ── Suite 8: Project Context Menu Execution ─────────────────────────

suite('Context Menu — Project Node Commands Execute', () => {
  const tree = useSymbolTree(
    'ctx-proj-',
    'ProjMenuTest',
    'namespace ProjMenuNS { public class Foo { } }',
    (node) => node.contextValue === 'project',
  );

  test('sharplsp.openProjectFile opens the .csproj file in the editor', async function () {
    this.timeout(COMMAND_MS);
    const projectNode = requireNode(tree().getChildren(), '', 'project');
    await assertRuns('sharplsp.openProjectFile', projectNode);

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
    assertContainsAll(text, ['<Project', 'TargetFramework'], 'csproj must contain');
    assert.ok(
      csprojEditor.document.languageId === 'xml' || csprojEditor.document.languageId === 'msbuild',
      `csproj languageId should be xml or msbuild, got '${csprojEditor.document.languageId}'`,
    );
    // Assert solution explorer tree still has project node visible.
    requireNode(tree().getChildren(), '', 'project');
    await openSharpLspPanel();
    await takeScreenshot('vscode-context-menu-open-project.png');
  });

  for (const cmd of BUILD_COMMANDS) {
    test(`${cmd} executes without error`, async function () {
      this.timeout(COMMAND_MS);
      await assertRuns(cmd);
    });
  }

  test('solution node carries projectFilePath pointing at the .sln', () => {
    const slnNode = requireSolutionNode(tree());
    assert.ok(
      slnNode.projectFilePath?.endsWith('.sln'),
      `Solution node projectFilePath must point at the .sln, got '${String(slnNode.projectFilePath)}'`,
    );
  });

  for (const cmd of BUILD_COMMANDS) {
    test(`${cmd} executes without error on the solution node`, async function () {
      this.timeout(COMMAND_MS);
      await assertRuns(cmd, requireSolutionNode(tree()));
    });
  }

  for (const [cmd, contextValue] of [
    ['sharplsp.openProjectFile', 'project'],
    ['sharplsp.addProjectReference', 'dependencyFolder'],
    ['sharplsp.nuget.addFromExplorer', 'dependencyFolder'],
  ] as const) {
    test(`${cmd} handles node without projectFilePath gracefully`, async function () {
      this.timeout(COMMAND_MS);
      await assertRuns(cmd, { projectFilePath: undefined, sortName: 'NoPath', contextValue });
    });
  }
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
    assertContainsAll(result, ['/repo/A/A.csproj', '/repo/B/B.fsproj'], 'includes the');
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
    assertContainsAll(result, ['/repo/A/A.csproj', '/repo/B/B.csproj'], 'result');
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

/** Two projects sharing one Serilog version: the canonical consolidation input. */
const SERILOG_PAIR: readonly ProjectSpec[] = [
  { name: 'A', refs: [['Serilog', '3.1.0']] },
  { name: 'B', refs: [['Serilog', '3.1.0']] },
];

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
  const tmpDir = useLspTestSuite('pkg-consol-');

  test('dry-run reports the shared package with full detail and touches no files', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir(), 'DryDetail', [
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
    assertContainsAll(serilog.fromProjects, ['A.csproj', 'B.csproj'], 'names project');
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
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir(), 'MixedShare', [
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
    assertContainsNone(ids, ['OnlyA', 'OnlyB'], 'ids');
    const serilog = resp.moved.find((m) => m.id === 'Serilog');
    assert.ok(serilog, 'Serilog entry present');
    assert.strictEqual(serilog.fromProjects.length, 2, 'shared across both');
  });

  test('dry-run selects the highest version across three projects', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir(), 'ThreeWay', [
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
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir(), 'FSharpShare', [
      { name: 'A', refs: [['FSharp.Data', '6.3.0']], ext: 'fsproj' },
      { name: 'B', refs: [['FSharp.Data', '6.3.0']], ext: 'fsproj' },
    ]);

    const resp = await consolidate(lsp, sln, true);
    assert.strictEqual(resp.moved.length, 1, 'F# projects are scanned');
    const pkg = resp.moved[0];
    assert.ok(pkg, 'moved entry present');
    assert.strictEqual(pkg.id, 'FSharp.Data');
    assert.strictEqual(pkg.fromProjects.length, 2);
    assertContainsAll(pkg.fromProjects, ['A.fsproj', 'B.fsproj'], 'pkg.fromProjects');
  });

  test('apply hoists shared package into Directory.Build.props and strips projects', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir(), 'Apply', SERILOG_PAIR);

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
    assertContainsAll(props, ['<PackageReference', 'Serilog', 'Version="3.1.0"'], 'props');
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
    assertContainsAll(aText, ['<Project', 'TargetFramework'], 'aText');
    assert.ok(resp.message.includes('Serilog'), 'message names the moved package');
  });

  test('apply preserves existing Directory.Build.props content', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir(), 'PreserveProps', SERILOG_PAIR);
    const propsPath = path.join(dir, 'Directory.Build.props');
    fs.writeFileSync(propsPath, '<Project>\n  <!-- sentinel comment -->\n</Project>\n');

    const resp = await consolidate(lsp, sln, false);
    assert.strictEqual(resp.moved.length, 1, 'one package moved');
    const props = fs.readFileSync(propsPath, 'utf8');
    assertContainsAll(props, ['<!-- sentinel comment -->', 'Serilog', 'Version="3.1.0"'], 'props');
  });

  test('apply is idempotent — a second scan finds nothing shared', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir(), 'Idempotent', SERILOG_PAIR);

    const applied = await consolidate(lsp, sln, false);
    assert.strictEqual(applied.moved.length, 1, 'first apply moves Serilog');
    assert.ok(applied.modifiedFiles.length >= 3, 'first apply modified files');

    const rescan = await consolidate(lsp, sln, true);
    assert.deepEqual(rescan.moved, [], 'nothing shared remains after the move');
    assert.strictEqual(rescan.modifiedFiles.length, 0, 'rescan modifies nothing');
    assert.strictEqual(rescan.propsFile, undefined, 'rescan reports no further props work');
  });

  test('reports nothing when no package is shared', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln, dir } = makeSolution(tmpDir(), 'NoShare', [
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
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const { sln } = makeSolution(tmpDir(), 'Single', [{ name: 'A', refs: [['Serilog', '3.1.0']] }]);
    const resp = await consolidate(lsp, sln, true);
    assert.deepEqual(resp.moved, [], 'one project cannot share with itself');
    assert.strictEqual(resp.moved.length, 0);
    assert.deepEqual(resp.modifiedFiles, []);
  });
});

// ── Suite 11: Package Maintenance — Unused (LSP e2e) ──────────────

suite('Package Maintenance — Unused (LSP e2e)', () => {
  const tmpDir = useLspTestSuite('pkg-unused-');

  test('unused request resolves against the loaded fixture project via Roslyn', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
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
      LSP_RESPONSE_MS,
      1_000,
    );

    assert.ok(resp, 'unused must resolve — the Roslyn GetUsedAssemblyReferences pipeline ran');
    assert.strictEqual(resp.projectPath, projectPath, 'projectPath is echoed back exactly');
    assert.ok(Array.isArray(resp.unused), 'unused is an array');
    // TestFixtures declares exactly one direct <PackageReference> — Serilog — and
    // no source compiled into the project references it, so detection must flag
    // precisely that package. Asserting the identity (not just a count) is what
    // proves GetUsedAssemblyReferences actually ran: an empty result would also
    // be produced by a pipeline that silently returned nothing.
    assert.deepEqual(
      resp.unused.map((pkg) => ({ id: pkg.id, version: pkg.version })),
      [{ id: 'Serilog', version: '4.4.0' }],
      'the declared-but-unreferenced package is flagged, with its declared version',
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
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const bogus = path.join(tmpDir(), 'Nope', 'Nope.csproj');
    await assert.rejects(async () => {
      await lsp.sendRequest<UnusedResp>('sharplsp/nuget/unused', { projectPath: bogus });
    }, 'unused must reject when the project file does not exist');
  });

  test('removeUnusedPackages command runs end-to-end through the real LSP', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    const projectPath = fixtureProjectPath();
    const projectNode = { contextValue: 'project', projectFilePath: projectPath, children: [] };
    const before = fs.readFileSync(projectPath, 'utf8');

    // The fixture has a genuinely unused package, so the command reaches its
    // modal confirmation. Dismiss it (the stub cancels by default) and assert the
    // destructive path stayed shut — a checked-in fixture must survive the run.
    const ui = installUiStubs();
    try {
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand('sharplsp.removeUnusedPackages', projectNode);
      }, 'the command must complete against the real LSP');

      assert.strictEqual(ui.log.warningMessages.length, 1, 'exactly one confirmation was shown');
      const prompt = ui.log.warningMessages[0] ?? '';
      assertContainsAll(
        prompt,
        ['Remove 1 unused package', 'Serilog', 'TestFixtures.csproj'],
        'the prompt',
      );
    } finally {
      ui.restore();
    }

    assert.strictEqual(
      fs.readFileSync(projectPath, 'utf8'),
      before,
      'cancelling the confirmation must leave the project file byte-identical',
    );

    // The detection truth the command relied on, asserted directly over the LSP.
    const resp = await lsp.sendRequest<UnusedResp>('sharplsp/nuget/unused', { projectPath });
    assert.strictEqual(resp.projectPath, projectPath, 'projectPath echoed');
    assert.deepEqual(
      resp.unused.map((pkg) => pkg.id),
      ['Serilog'],
      'the package the command offered to remove is still declared after cancelling',
    );
  });

  test('consolidatePackages command runs end-to-end through the real LSP', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const lsp = getPkgLspClient();
    // No shared packages → the command takes the non-modal "nothing to do" path,
    // exercising the real LSP scan without a confirmation dialog.
    const { sln, dir } = makeSolution(tmpDir(), 'CmdConsolidate', [
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
