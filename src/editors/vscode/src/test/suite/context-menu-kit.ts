// The Solution Explorer tree as the context-menu suites see it: the node fields
// the menus key on, searches over the tree, the clipboard the copy commands
// write, and the one-project solution each suite loads and waits for.
//
// Covers [SE-TREE]: every node a menu can target is reached through the real
// exported provider, never a hand-built tree.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activeExplorerProvider,
  type ExplorerProvider,
  writeOneProjectSolution,
} from './explorer-kit';
import { useLspTestSuite } from './lsp-suite-kit';
import { pollUntilResult, waitForDocumentSymbols } from './test-helpers';
import { ACTIVATION_MS, FAST_MS } from './test-timeouts';

/** A Solution Explorer node, viewed through the fields the menus key on. */
export interface TreeNode {
  readonly label?: string | { label: string };
  readonly contextValue?: string;
  readonly children?: TreeNode[];
  readonly symbolUri?: string;
  readonly sortName?: string;
  readonly projectFilePath?: string;
}

export type SymbolTree = ExplorerProvider<TreeNode>;

export function nodeLabel(node: TreeNode): string {
  if (typeof node.label === 'string') return node.label;
  return node.label?.label ?? '';
}

/** The first node, depth-first, that `predicate` accepts. */
export function findNode(
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

export function findByLabel(nodes: TreeNode[] | undefined, label: string): TreeNode | undefined {
  return findNode(nodes, (n) => nodeLabel(n).includes(label));
}

export function findByContext(
  nodes: TreeNode[] | undefined,
  contextValue: string,
): TreeNode | undefined {
  return findNode(nodes, (n) => n.contextValue === contextValue);
}

/** The node labelled `label` (with `contextValue`, when given), asserted present. */
export function requireNode(
  nodes: TreeNode[] | undefined,
  label: string,
  contextValue?: string,
): TreeNode {
  const node = findNode(
    nodes,
    (n) =>
      nodeLabel(n).includes(label) &&
      (contextValue === undefined || n.contextValue === contextValue),
  );
  assert.ok(node, `${label} (${contextValue ?? 'any contextValue'}) must be in the tree`);
  return node;
}

/** The tree's root, asserted to be the solution node. */
export function requireSolutionNode(tree: SymbolTree): TreeNode {
  const root = tree.getChildren()?.[0];
  assert.ok(root, 'Solution node must exist');
  assert.strictEqual(root.contextValue, 'solution', 'Root node must be the solution');
  return root;
}

/**
 * Run a copy command on `node` and return what it put on the clipboard.
 *
 * The clipboard is primed with `sentinel` first, then polled until it holds
 * something else: a command that copied nothing leaves the sentinel there and
 * fails as itself, and a wait on the clipboard's STATE replaces the fixed sleep
 * that used to guess how long the write took ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 * The budget sits under the `COMMAND_MS` ceiling of the tests that call this.
 */
export async function copiedText(
  command: string,
  node: TreeNode,
  sentinel: string,
): Promise<string> {
  await vscode.env.clipboard.writeText(sentinel);
  await vscode.commands.executeCommand(command, node);
  return pollUntilResult(
    async () => vscode.env.clipboard.readText(),
    (text) => text !== sentinel,
    FAST_MS,
    50,
    `'${command}' to replace the clipboard sentinel '${sentinel}'`,
  );
}

/** A one-project solution whose only source is `<project>/Source.cs` = `source`. */
function writeSourceSolution(
  root: string,
  project: string,
  source: string,
): { slnPath: string; sourcePath: string } {
  const { slnPath, projDir } = writeOneProjectSolution(root, project);
  const sourcePath = path.join(projDir, 'Source.cs');
  fs.writeFileSync(sourcePath, source);
  return { slnPath, sourcePath };
}

/** Load `slnPath`, open `sourcePath`, and poll until the tree holds a node `ready` accepts. */
export async function loadTreeUntil(
  tree: SymbolTree,
  slnPath: string,
  sourcePath: string,
  ready: (node: TreeNode) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  await tree.loadSolution(slnPath);
  const uri = vscode.Uri.file(sourcePath);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await waitForDocumentSymbols(uri);
  await tree.refresh();
  await pollUntilResult(
    async () => findNode(tree.getChildren(), ready),
    (node) => node !== undefined,
    timeoutMs,
  );
}

/**
 * One activated server and a Solution Explorer loaded with a single project
 * whose `Source.cs` is `source`, settled until a node `ready` accepts appears.
 * The tree is cleared when the suite ends. Returns the provider.
 */
export function useSymbolTree(
  prefix: string,
  project: string,
  source: string,
  ready: (node: TreeNode) => boolean,
): () => SymbolTree {
  let tree: SymbolTree | undefined;
  // Registered BEFORE the LSP suite hooks, so the tree lets go of the solution
  // before its scratch directory is deleted: Mocha runs these in order.
  suiteTeardown(() => {
    tree?.clear();
  });
  const tmpDir = useLspTestSuite(prefix);
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    tree = activeExplorerProvider<TreeNode>();
    const { slnPath, sourcePath } = writeSourceSolution(tmpDir(), project, source);
    await loadTreeUntil(tree, slnPath, sourcePath, ready);
  });
  return () => {
    assert.ok(tree, 'the Solution Explorer must be loaded in suiteSetup');
    return tree;
  };
}

/** A node labelled `label`, for `useSymbolTree`'s `ready`. */
export function labelled(label: string): (node: TreeNode) => boolean {
  return (node) => nodeLabel(node).includes(label);
}

/** Run `command` with `args` and assert it does not reject. */
export async function assertRuns(command: string, ...args: unknown[]): Promise<void> {
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(command, ...args);
  }, `${command} must not throw`);
}
