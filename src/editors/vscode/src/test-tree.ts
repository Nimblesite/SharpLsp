/**
 * Walking the **Assembly → Namespace → Class → Test** tree the Testing view
 * renders (see `testing.ts`).
 *
 * Only the LEAVES are tests. The levels above them are group nodes: they carry
 * no cached result, they are not runnable on their own, and their ids are not
 * fully-qualified names. So every consumer that means "the discovered tests"
 * has to descend — and a consumer that iterates only the top level now sees
 * assemblies, not tests.
 */

import type * as vscode from 'vscode';

/**
 * Visit every LEAF beneath `roots`, depth first, in tree order.
 *
 * A node with no children IS the leaf, whatever depth it sits at: the
 * display-name discovery fallback cannot attribute names to assemblies and
 * renders flat rows, and a discovery-error row is a childless node too.
 */
export function forEachLeafIn(
  roots: Iterable<vscode.TestItem>,
  visit: (item: vscode.TestItem) => void,
): void {
  for (const item of roots) {
    if (item.children.size === 0) {
      visit(item);
      continue;
    }
    forEachLeaf(item.children, visit);
  }
}

/**
 * The tests a request selects: its `include` set (or the whole tree when it has
 * none), minus everything the user explicitly EXCLUDED. Ignoring `exclude` runs
 * tests the user just deselected. Group nodes expand to their leaf tests — a
 * class or namespace ▶ runs its members — and discovery-error rows are never
 * selectable as tests.
 */
export function collectRequestedTests(
  request: vscode.TestRunRequest,
  items: vscode.TestItemCollection,
): vscode.TestItem[] {
  const excluded = new Set((request.exclude ?? []).map((item) => item.id));
  const tests: vscode.TestItem[] = [];
  const walk = (item: vscode.TestItem): void => {
    if (excluded.has(item.id) || item.error !== undefined) return;
    if (item.children.size === 0) {
      tests.push(item);
      return;
    }
    item.children.forEach(walk);
  };
  if (request.include === undefined) items.forEach(walk);
  else for (const item of request.include) walk(item);
  return tests;
}

/** {@link forEachLeafIn} over a live {@link vscode.TestItemCollection}. */
export function forEachLeaf(
  items: vscode.TestItemCollection,
  visit: (item: vscode.TestItem) => void,
): void {
  const roots: vscode.TestItem[] = [];
  items.forEach((item) => roots.push(item));
  forEachLeafIn(roots, visit);
}
