/** Sorting of Solution Explorer rows. Implements [SE-SORT], [SE-SORT-ACCESS] and [SE-SORT-SCOPE]. */
import { SortOrder } from './state.js';
import type { ExplorerNode } from './tree.js';

const ACCESS_PRIORITY: Record<string, number> = {
  public: 0,
  'internal protected': 1,
  'protected internal': 1,
  internal: 2,
  protected: 3,
  'private protected': 4,
  'protected private': 4,
  private: 5,
};

function accessPriority(access: string | undefined): number {
  if (access === undefined) return 6;
  return ACCESS_PRIORITY[access] ?? 6;
}

/** Namespace rows sort before every other row, like folders before files ([SE-SORT-SCOPE]). */
function namespaceRank(node: ExplorerNode): number {
  return node.symbolKind === 'Namespace' ? 0 : 1;
}

/** Sort `nodes` and every level below them in place by `order` ([SE-SORT]). */
export function applySortOrder(nodes: ExplorerNode[], order: SortOrder): void {
  if (order === SortOrder.Natural) return;

  if (order === SortOrder.Alphabetical) {
    nodes.sort(
      (a, b) => namespaceRank(a) - namespaceRank(b) || a.sortName.localeCompare(b.sortName),
    );
  } else {
    nodes.sort(
      (a, b) =>
        namespaceRank(a) - namespaceRank(b) ||
        accessPriority(a.access) - accessPriority(b.access) ||
        a.sortName.localeCompare(b.sortName),
    );
  }

  for (const node of nodes) {
    if (node.children.length > 0) {
      applySortOrder(node.children, order);
    }
  }
}
