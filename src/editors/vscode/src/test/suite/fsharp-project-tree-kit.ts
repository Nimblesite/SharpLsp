// The Solution Explorer's F# project as the Add F# Source File suites see it:
// the live tree viewed structurally, the project node a file belongs to, and a
// file's symbol node once FCS has answered for it. [SE-ADD-FILE-COMMAND]
import * as assert from 'node:assert/strict';
import { activeExplorerProvider, type ExplorerProvider } from './explorer-kit';
import { pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { findNode } from './tree-node-kit';

/** The slice of a live ExplorerNode these suites navigate. */
export interface LiveNode {
  readonly label?: string | { label: string };
  readonly nodeType?: string;
  readonly contextValue?: string;
  readonly projectFilePath?: string;
  readonly symbolUri?: string;
  readonly children?: LiveNode[];
  readonly parent?: LiveNode;
}

/** The live Solution Explorer provider, viewed as `LiveNode`s. */
export function explorer(): ExplorerProvider<LiveNode> {
  return activeExplorerProvider<LiveNode>();
}

/** The loaded tree's project node for `projectFilePath`. */
export function projectNode(projectFilePath: string): LiveNode {
  const node = findNode(explorer().getChildren(), (n) => n.projectFilePath === projectFilePath);
  assert.ok(node, 'the project node must be reachable from the tree roots');
  return node;
}

/** The project node a symbol node belongs to, via the parent chain. */
export function owningProjectOf(node: LiveNode): string | undefined {
  let current: LiveNode | undefined = node;
  while (current !== undefined) {
    if (current.nodeType === 'project') return current.projectFilePath;
    current = current.parent;
  }
  return undefined;
}

/** A symbol node of file `basename` under `projectFilePath`, once FCS symbols land. */
export function symbolNodeIn(
  projectFilePath: string,
  basename: string,
): Promise<LiveNode | undefined> {
  return pollUntilResult(
    async () => findNode(explorer().getChildren(), (n) => n.symbolUri?.includes(basename) === true),
    (node) => node !== undefined && owningProjectOf(node) === projectFilePath,
    LSP_RESPONSE_MS,
    500,
  );
}
