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
import { EXTENSION_ID } from './test-helpers';

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
