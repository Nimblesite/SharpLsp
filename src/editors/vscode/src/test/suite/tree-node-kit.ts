// Walking an extension tree (Solution Explorer, profiler) the way a user reads
// it: by the label a row shows, or by the context value its menus key on.
// Implements [SHARPLSP-FEATURES-NAVIGATION] test support.
import * as assert from 'node:assert/strict';

/** What a row shows: a plain label, or a `TreeItemLabel`. */
export interface Labelled {
  readonly label?: string | { readonly label: string };
}

/** Whatever the finders read from a node whose children are nodes of its own kind. */
export interface TreeShape<N> extends Labelled {
  readonly contextValue?: string;
  readonly children?: readonly N[];
}

/** The text a row shows. */
export function nodeLabel(node: Labelled): string {
  return typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
}

/** The first node, depth-first, that `predicate` accepts. */
export function findNode<N extends TreeShape<N>>(
  nodes: readonly N[] | undefined,
  predicate: (node: N) => boolean,
): N | undefined {
  if (nodes === undefined) return undefined;
  for (const node of nodes) {
    if (predicate(node)) return node;
    const found = findNode(node.children, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The first node, depth-first, whose label contains `label`. */
export function findByLabel<N extends TreeShape<N>>(
  nodes: readonly N[] | undefined,
  label: string,
): N | undefined {
  return findNode(nodes, (node) => nodeLabel(node).includes(label));
}

/** The first node, depth-first, carrying `contextValue`. */
export function findByContext<N extends TreeShape<N>>(
  nodes: readonly N[] | undefined,
  contextValue: string,
): N | undefined {
  return findNode(nodes, (node) => node.contextValue === contextValue);
}

/** Visit every node, roots before their children. */
export function walkTree<N extends TreeShape<N>>(
  nodes: readonly N[] | undefined,
  visit: (node: N) => void,
): void {
  for (const node of nodes ?? []) {
    visit(node);
    walkTree(node.children, visit);
  }
}

/** Every node at or below `nodes`, roots before their children. */
export function collectNodes<N extends TreeShape<N>>(nodes: readonly N[] | undefined): N[] {
  const collected: N[] = [];
  walkTree(nodes, (node) => collected.push(node));
  return collected;
}

/** A predicate accepting a node labelled with `label` that also carries `contextValue`. */
export function labelledSymbol<N extends TreeShape<N>>(
  label: string,
  contextValue: string,
): (node: N) => boolean {
  return (node) => nodeLabel(node).includes(label) && node.contextValue === contextValue;
}

/** The first node `predicate` accepts, asserted present so callers hold a non-optional node. */
export function requireNodeWhere<N extends TreeShape<N>>(
  nodes: readonly N[] | undefined,
  predicate: (node: N) => boolean,
  why: string,
): N {
  const node = findNode(nodes, predicate);
  assert.ok(node, why);
  return node;
}

/**
 * Assert `nodes` was selected non-empty and that `check` rejects NONE of them,
 * naming every offender `check` describes and the contract it breaks, `why`.
 */
export function assertAllNodes<N>(
  nodes: readonly N[],
  check: (node: N) => string | undefined,
  why: string,
): void {
  assert.ok(nodes.length > 0, `${why}: the tree must hold at least one of these nodes`);
  const offenders = nodes
    .map((node) => check(node))
    .filter((text): text is string => text !== undefined);
  assert.deepEqual(offenders, [], `${why}: ${offenders.join(', ')}`);
}
