// Namespaces in the Solution Explorer nest on `.` like folders, and the view
// carries a toggle back to the flat list. Implements [SE-TREE-NAMESPACE-NEST].
//
// The committed fixture solution holds every shape the rule names: C#
// `TestFixtures` with a child `TestFixtures.Nested`, a parent that declares no
// types of its own (`SharpLsp.TestFixtures`) over two children, and F#
// `FSharpFixtures` over `FSharpFixtures.CrossLanguage` and
// `FSharpFixtures.RenameNamespace`.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { copiedText, loadTreeUntil, requireNode, type TreeNode } from './context-menu-kit';
import { activeExplorerProvider, type ExplorerProvider } from './explorer-kit';
import { assertContributedSetting, assertReachableCommand } from './extension-manifest-kit';
import { useLspTestSuite } from './lsp-suite-kit';
import { contributes } from './run-debug-kit';
import { pollUntilResult } from './test-helpers';
import { ACTIVATION_MS, SETTINGS_WRITE_MS, SIDECAR_COLD_MS } from './test-timeouts';
import { nodeLabel } from './tree-node-kit';

const FIXTURE_DIR = path.resolve(__dirname, '../../../test-fixtures/workspace');
const NEST_KEY = 'solutionExplorer.nestNamespaces';
const NEST_COMMAND = 'sharplsp.nestNamespaces';
const FLATTEN_COMMAND = 'sharplsp.flattenNamespaces';
const NAMESPACE = 'symbol.namespace';

/** A tree row, with the parent link `TreeView.reveal` walks. */
interface Row extends TreeNode {
  readonly children?: Row[];
  readonly parent?: Row;
}

type Tree = ExplorerProvider<Row>;

/** The project row whose label starts `<name> (`. */
function project(tree: Tree, name: string): Row {
  return requireNode(tree.getChildren(), `${name} (`, 'project');
}

/** The namespace rows directly under `node`. */
function namespacesUnder(node: Row): Row[] {
  return (node.children ?? []).filter((child) => child.contextValue === NAMESPACE);
}

/** The labels of the namespace rows directly under `node`, sorted. */
function namespaceLabels(node: Row): string[] {
  return namespacesUnder(node).map(nodeLabel).sort();
}

/** The namespace row labelled exactly `label` directly under `node`. */
function namespaceRow(node: Row, label: string): Row {
  const row = namespacesUnder(node).find((child) => nodeLabel(child) === label);
  assert.ok(row, `'${label}' must be a namespace row under '${nodeLabel(node)}'`);
  return row;
}

/** Poll until the C# and F# projects both show `label` as a top-level namespace. */
async function settledWith(tree: Tree, csharp: string, fsharp: string): Promise<void> {
  await pollUntilResult(
    async () => [project(tree, 'TestFixtures'), project(tree, 'FSharpFixtures')] as const,
    ([cs, fs]) => namespaceLabels(cs).includes(csharp) && namespaceLabels(fs).includes(fsharp),
    SIDECAR_COLD_MS,
    250,
    `top-level namespaces '${csharp}' (C#) and '${fsharp}' (F#)`,
  );
}

/** The setting's value at user scope, where the toggle writes it. */
function userScopeNesting(): boolean | undefined {
  return vscode.workspace.getConfiguration('sharplsp').inspect<boolean>(NEST_KEY)?.globalValue;
}

/** Assert the nested shape: children under parents, never a dotted top-level row. */
function assertNested(tree: Tree): void {
  const cs = project(tree, 'TestFixtures');
  const csTop = namespaceLabels(cs);
  assert.ok(csTop.includes('TestFixtures'), `C# top level: ${csTop.join(', ')}`);
  for (const dotted of [
    'TestFixtures.Nested',
    'SharpLsp.TestFixtures.Refactors',
    'SharpLsp.TestFixtures.RenameCoverage',
  ]) {
    assert.ok(!csTop.includes(dotted), `'${dotted}' must nest, not sit at the top level`);
  }
  const root = namespaceRow(cs, 'TestFixtures');
  const nested = namespaceRow(root, 'Nested');
  assert.strictEqual(root.children?.[0], nested, 'child namespaces come before the types');
  assert.strictEqual(nested.parent, root, 'Nested links up to TestFixtures for reveal');
  assert.strictEqual(root.parent, cs, 'and TestFixtures to its project');
  assert.ok(requireNode(nested.children, 'Outer'), 'Outer lives under Nested');

  // A parent that declares no types of its own folds into one row.
  const shared = namespaceRow(cs, 'SharpLsp.TestFixtures');
  assert.deepStrictEqual(namespaceLabels(shared), ['Refactors', 'RenameCoverage']);
  assert.ok(!csTop.includes('SharpLsp'), 'an empty single-child parent is folded away');

  const fs = project(tree, 'FSharpFixtures');
  const fsRoot = namespaceRow(fs, 'FSharpFixtures');
  const fsChildren = namespaceLabels(fsRoot);
  for (const child of ['CrossLanguage', 'RenameNamespace']) {
    assert.ok(fsChildren.includes(child), `F# '${child}' nests: ${fsChildren.join(', ')}`);
  }
  assert.ok(!namespaceLabels(fs).includes('FSharpFixtures.CrossLanguage'), 'F# nests too');
}

/** Assert the flat shape: every namespace a top-level row under its full name. */
function assertFlat(tree: Tree): void {
  const cs = project(tree, 'TestFixtures');
  const csTop = namespaceLabels(cs);
  for (const full of [
    'TestFixtures',
    'TestFixtures.Nested',
    'SharpLsp.TestFixtures.Refactors',
    'SharpLsp.TestFixtures.RenameCoverage',
  ]) {
    assert.ok(csTop.includes(full), `flat C# '${full}' is top level: ${csTop.join(', ')}`);
  }
  assert.deepStrictEqual(namespaceLabels(namespaceRow(cs, 'TestFixtures')), []);
  const fsTop = namespaceLabels(project(tree, 'FSharpFixtures'));
  for (const full of ['FSharpFixtures', 'FSharpFixtures.CrossLanguage']) {
    assert.ok(fsTop.includes(full), `flat F# '${full}' is top level: ${fsTop.join(', ')}`);
  }
}

suite('Solution Explorer — nested namespaces', () => {
  let tree: Tree | undefined;
  suiteTeardown(() => {
    tree?.clear();
  });
  useLspTestSuite('se-namespaces-');

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + SIDECAR_COLD_MS);
    tree = activeExplorerProvider<Row>();
    await loadTreeUntil(
      tree,
      path.join(FIXTURE_DIR, 'TestFixtures.sln'),
      path.join(FIXTURE_DIR, 'Nested.cs'),
      (node) => nodeLabel(node) === 'Outer',
      SIDECAR_COLD_MS,
    );
  });

  test('namespaces nest on "." by default, and the view toggles them flat and back', async function () {
    this.timeout(SIDECAR_COLD_MS + 3 * SETTINGS_WRITE_MS);
    assert.ok(tree, 'the Solution Explorer is loaded');
    const loaded = tree;
    const original = userScopeNesting();
    try {
      // Interaction 1: a fresh install nests C# and F# namespaces.
      await settledWith(tree, 'TestFixtures', 'FSharpFixtures');
      assertNested(tree);
      assertContributedSetting(`sharplsp.${NEST_KEY}`, true);
      const outer = requireNode(tree.getChildren(), 'Outer');
      assert.strictEqual(
        await copiedText('sharplsp.copyQualifiedName', outer, '<unchanged>'),
        'TestFixtures.Nested.Outer',
        'a nested row still copies its full qualified name',
      );

      // Interaction 2: the view-title toggle flattens the tree, and remembers it.
      await vscode.commands.executeCommand(FLATTEN_COMMAND);
      await settledWith(tree, 'TestFixtures.Nested', 'FSharpFixtures.CrossLanguage');
      assertFlat(tree);
      assert.strictEqual(userScopeNesting(), false, 'flattening is stored as the user setting');

      // Interaction 3: the other toggle nests it again.
      await vscode.commands.executeCommand(NEST_COMMAND);
      await pollUntilResult(
        async () => namespaceLabels(project(loaded, 'TestFixtures')),
        (labels) => !labels.includes('TestFixtures.Nested'),
        SETTINGS_WRITE_MS,
      );
      assertNested(tree);
      assert.strictEqual(userScopeNesting(), true, 'nesting is stored as the user setting');
    } finally {
      await vscode.workspace
        .getConfiguration('sharplsp')
        .update(NEST_KEY, original, vscode.ConfigurationTarget.Global);
    }
  });

  test('the nest and flatten toggles sit on the Solution Explorer title bar', async () => {
    const palette = await vscode.commands.getCommands(true);
    const titles = (contributes().menus?.['view/title'] ?? []) as {
      command: string;
      when?: string;
    }[];
    // Only the toggle that CHANGES the layout shows: flatten while nested, nest while flat.
    for (const [command, shownWhen] of [
      [FLATTEN_COMMAND, `config.sharplsp.${NEST_KEY}`],
      [NEST_COMMAND, `!config.sharplsp.${NEST_KEY}`],
    ] as const) {
      assertReachableCommand(command, palette);
      const items = titles.filter((menu) => menu.command === command);
      assert.strictEqual(items.length, 1, `${command} must be on the view/title menu once`);
      assert.strictEqual(
        items[0]?.when,
        `view == sharplsp.solutionExplorer && ${shownWhen}`,
        `${command} shows on the Solution Explorer only while ${shownWhen}`,
      );
    }
  });
});
