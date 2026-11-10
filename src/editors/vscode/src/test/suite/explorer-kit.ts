// The Solution Explorer as the reactivity suites see it: the provider the
// extension exports, viewed structurally, and the recursive label search each
// of them polls on until the tree catches up with an edit.
//
// Covers [SE-TREE] and [SE-LIVE-BUFFER] — the tree must reflect the live buffer,
// and the only observable proof of that is a node label appearing or vanishing.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  openCSharpFile,
  openCSharpOutline,
  pollUntilResult,
  waitForDocumentSymbols,
} from './test-helpers';
import { assertSymbolShapesAndTree, assertSymbolTree, childNamed } from './lsp-invariants-kit';
import { assertReachableCommand, requireExtensionExports } from './extension-manifest-kit';

/** One node of the tree, viewed only through the fields the searches read. */
export interface ExplorerNode {
  readonly label?: string | { label: string };
  readonly children?: ExplorerNode[];
}

/** The slice of the exported `explorerProvider` the suites drive, viewed as `Node`s. */
export interface ExplorerProvider<Node extends ExplorerNode = ExplorerNode> {
  loadSolution(slnPath: string): Promise<void>;
  refresh(): Promise<void>;
  clear(): void;
  getChildren(element?: unknown): Node[] | undefined;
}

/** The ACTIVE extension's exported Solution Explorer provider. */
export function activeExplorerProvider<
  Node extends ExplorerNode = ExplorerNode,
>(): ExplorerProvider<Node> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext?.isActive, 'Extension must be active');
  const api = ext.exports as { explorerProvider?: ExplorerProvider<Node> } | undefined;
  assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');
  return api.explorerProvider;
}

/** Whether any node at or below `nodes` has a label containing `target`. */
export function treeContains(nodes: readonly ExplorerNode[] | undefined, target: string): boolean {
  return (nodes ?? []).some((node) => {
    const text = typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
    return text.includes(target) || treeContains(node.children, target);
  });
}

/** A minimal SDK-style .csproj, with `itemGroup` (already indented) before its close. */
export function csprojText(itemGroup = ''): string {
  return (
    '<Project Sdk="Microsoft.NET.Sdk">\n' +
    '  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>\n' +
    `${itemGroup}</Project>`
  );
}

/**
 * Write `<root>/<project>/<project>.csproj` and a `<root>/<project>.sln` naming
 * it: the smallest solution the tree loads. Returns the paths a test edits.
 */
export function writeOneProjectSolution(
  root: string,
  project: string,
  itemGroup = '',
): { slnPath: string; projDir: string; csprojPath: string } {
  const projDir = path.join(root, project);
  fs.mkdirSync(projDir, { recursive: true });
  const csprojPath = path.join(projDir, `${project}.csproj`);
  fs.writeFileSync(csprojPath, csprojText(itemGroup));
  const slnPath = path.join(root, `${project}.sln`);
  const entry =
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = ' +
    `"${project}", "${project}/${project}.csproj", "{00000000-0000-0000-0000-000000000001}"`;
  const header = 'Microsoft Visual Studio Solution File, Format Version 12.00';
  fs.writeFileSync(slnPath, [header, entry, 'EndProject', 'Global', 'EndGlobal'].join('\n'));
  return { slnPath, projDir, csprojPath };
}

/** Poll `provider`'s tree for up to 5 s until a node's label contains `target`. */
export async function pollTreeFor(provider: ExplorerProvider, target: string): Promise<boolean> {
  return await pollUntilResult(
    async () => treeContains(provider.getChildren(), target),
    (found) => found,
    5_000,
  );
}

/** Asserts `command` is registered and passes the manifest reachability checks; returns its manifest entry. */
export async function assertRegisteredCommand(
  command: string,
): Promise<ReturnType<typeof assertReachableCommand>> {
  const allCommands = await vscode.commands.getCommands(true);
  assert.ok(allCommands.includes(command), `${command} should be registered`);
  return assertReachableCommand(command, allCommands);
}

/** Opens `uri` and asserts each `[symbol, kind]` pair's shape against the live tree; returns the document. */
export async function assertShapesAndTreeFor(
  uri: vscode.Uri,
  symbols: readonly vscode.DocumentSymbol[],
  pairs: readonly (readonly [vscode.DocumentSymbol, vscode.SymbolKind])[],
): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  assertSymbolShapesAndTree(symbols, doc, pairs);
  return doc;
}

/** Opens `uri` and asserts `symbols` form a well-formed tree for it; returns the document. */
export async function assertTreeFor(
  uri: vscode.Uri,
  symbols: readonly vscode.DocumentSymbol[],
): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  assertSymbolTree(symbols, doc);
  return doc;
}

/** Asserts `symbol`'s children are named exactly `names`, in source order. */
export function assertChildNames(
  symbol: vscode.DocumentSymbol,
  names: readonly string[],
  message: string,
): void {
  assert.deepEqual(
    symbol.children?.map((child) => child.name),
    names,
    message,
  );
}

/** Asserts no child of `parent` is named `name`. */
export function assertLacksChild(
  parent: { readonly children?: readonly { readonly name: string }[] },
  name: string,
  message: string,
): void {
  assert.ok(!parent.children?.some((child) => child.name === name), message);
}

/** Subscribes to the live Solution Explorer's change events through the extension exports. */
export function subscribeToTreeChanges(
  exportMessage: string,
  onEvent: () => void,
): vscode.Disposable {
  const api = requireExtensionExports('explorerProvider') as {
    explorerProvider?: { onDidChangeTreeData: vscode.Event<unknown> };
  };
  assert.ok(api.explorerProvider, exportMessage);
  return api.explorerProvider.onDidChangeTreeData(() => {
    onEvent();
  });
}

/**
 * Writes a one-project solution named `project`, opens `file` in it with
 * `source`, waits for its symbols, and returns the live provider, paths,
 * document and symbols.
 */
export async function openSolutionFile(
  tmpDir: string,
  project: string,
  file: string,
  source: string,
): Promise<{
  provider: ExplorerProvider;
  projDir: string;
  slnPath: string;
  doc: vscode.TextDocument;
  symbols: vscode.DocumentSymbol[];
}> {
  const provider = activeExplorerProvider();
  const { projDir, slnPath } = writeOneProjectSolution(tmpDir, project);
  const { doc } = await openCSharpFile(projDir, file, source);
  const symbols = await waitForDocumentSymbols(doc.uri);
  return { provider, projDir, slnPath, doc, symbols };
}

/** Opens a C# scratch file via the outline helper and resolves its namespace child. */
export async function openOutlineNs(
  dir: string,
  file: string,
  source: string,
  nsName: string,
  nsKind?: vscode.SymbolKind,
): Promise<{
  uri: vscode.Uri;
  doc: vscode.TextDocument;
  symbols: vscode.DocumentSymbol[];
  ns: vscode.DocumentSymbol;
}> {
  const opened = await openCSharpOutline(dir, file, source);
  return { ...opened, ns: childNamed(opened.symbols, nsName, nsKind) };
}
