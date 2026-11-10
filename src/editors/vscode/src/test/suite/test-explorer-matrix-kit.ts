// Assertion helpers shared by the Test Explorer MATRIX suites — the adapter-id,
// multi-target, outcome and framework suites that drive the same controller
// gestures (discovery, refresh, profile runs, lens reads) over different
// fixtures.
//
// Each helper carries the exact claim its call sites wrote out by hand, with
// every differing message passed in, so two suites asserting the same shape
// call one function instead of duplicating its body ([TEST-REACTIVITY],
// [TEST-RUN-TRX], [TEST-DISCOVERY-FQN]).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { buildFilterArgs } from '../../test-execution.js';
import { withoutAdapterUniqueId } from '../../test-discovery.js';
import { findTestByMethodName } from '../../test-lens.js';
import type { CachedTestResult } from '../../testing.js';
import { assertBareFilterClauses } from './test-explorer-assert-kit';
import {
  collectItemIds,
  collectLeafIds,
  drainDiscovery,
  findItem,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import { assertReported, cachedFor, itemsFor, sorted } from './test-explorer-outcome-assertions';

/** `ids` resolve to exactly one tree row each, named by `why`. */
export function assertRowsResolvable(
  api: SharpLspExtensionApi,
  ids: readonly string[],
  why: string,
): void {
  assert.strictEqual(itemsFor(api, ids).length, ids.length, why);
}

/** The tree holds exactly `count` leaf rows, named by `why`. */
export function assertLeafCount(
  items: vscode.TestItemCollection,
  count: number,
  why: string,
): void {
  assert.strictEqual(collectLeafIds(items).length, count, why);
}

/** `fqn` appears in the tree exactly once as a leaf id. */
export function assertLeafAppearsOnce(
  items: vscode.TestItemCollection,
  fqn: string,
  why: string,
): void {
  assert.strictEqual(collectLeafIds(items).filter((id) => id === fqn).length, 1, why);
}

/** No id in `ids` still carries the adapter's unique-ID decoration. */
export function assertNoDecoratedIds(ids: readonly string[], why: string): void {
  assert.deepStrictEqual(
    ids.filter((id) => withoutAdapterUniqueId(id) !== id),
    [],
    why,
  );
}

/** No id in `ids` carries a parenthesis — a filter-grammar metacharacter. */
export function assertNoParenthesisedIds(ids: readonly string[], why: string): void {
  assert.deepStrictEqual(
    ids.filter((id) => id.includes('(') || id.includes(')')),
    [],
    why,
  );
}

/** `root` is an expandable assembly GROUP row, never an FQN. */
export function assertAssemblyGroupRow(
  root: vscode.TestItem,
  idWhy: string,
  expandWhy: string,
): void {
  assert.ok(root.id.startsWith('assembly:'), idWhy);
  assert.ok(root.canResolveChildren, expandWhy);
}

/** `fqn` resolves to a LEAF row carrying exactly that id; returns the row. */
export function assertBareLeafRow(
  items: vscode.TestItemCollection,
  fqn: string,
  rowWhy: string,
  idWhy: string,
  leafWhy: string,
): vscode.TestItem {
  const item = findItem(items, fqn);
  assert.ok(item, rowWhy);
  assert.strictEqual(item.id, fqn, idWhy);
  assert.strictEqual(item.children.size, 0, leafWhy);
  return item;
}

/** The Run/Debug lens above `methodName` resolves to the row carrying `fqn`; returns the row. */
export function assertLensResolves(
  items: vscode.TestItemCollection,
  methodName: string,
  fqn: string,
  foundWhy: string,
  idWhy: string,
): vscode.TestItem {
  const found = findTestByMethodName(items, methodName);
  assert.ok(found, foundWhy);
  assert.strictEqual(found.id, fqn, idWhy);
  return found;
}

/** The selected rows ARE `ids` in order, then the `kind` profile runs exactly them. */
export async function runExactSelection(
  api: SharpLspExtensionApi,
  kind: vscode.TestRunProfileKind,
  items: readonly vscode.TestItem[],
  ids: readonly string[],
  why: string,
): Promise<void> {
  assert.deepStrictEqual(
    items.map((item) => item.id),
    ids,
    why,
  );
  await runViaProfile(api.testController, kind, items);
}

/** `id` reports a real outcome landing in one of the three Testing-API states. */
export function assertAttributedState(
  api: SharpLspExtensionApi,
  id: string,
  stateWhy: string,
): CachedTestResult {
  const result = assertReported(api, id);
  assert.ok(
    ['passed', 'failed', 'skipped'].includes(result.outcome),
    `${id} ${stateWhy}; got ${result.outcome}`,
  );
  return result;
}

/** The cached result for `id` did not come back notRun, named by `why`. */
export function assertNotRunOutcome(api: SharpLspExtensionApi, id: string, why: string): void {
  assert.notStrictEqual(cachedFor(api, id).outcome, 'notRun', why);
}

/** `result` carries a real, non-negative measured duration. */
export function assertMeasuredDuration(result: CachedTestResult, why: string): void {
  assert.ok((result.duration ?? -1) >= 0, why);
}

/** The run really timed: a numeric duration and a real, non-negative measurement. */
export function assertTimedResult(
  result: CachedTestResult,
  numberWhy: string,
  timedWhy: string,
): void {
  assert.strictEqual(typeof result.duration, 'number', numberWhy);
  assert.ok((result.duration ?? -1) >= 0, timedWhy);
}

/** `result.message` mentions `needle` (e.g. the runner's own assertion text). */
export function assertMessageMentions(result: CachedTestResult, needle: string, why: string): void {
  assert.ok((result.message ?? '').includes(needle), why);
}

/** `result.message` does NOT mention `needle` (e.g. the missing-result note). */
export function assertMessageOmits(result: CachedTestResult, needle: string, why: string): void {
  assert.ok(!(result.message ?? '').includes(needle), why);
}

/** `assembly` is an absolute path naming a file that really exists on disk. */
export function assertRealAssemblyPath(
  assembly: string,
  absoluteWhy: string,
  existsWhy: string,
): void {
  assert.ok(path.isAbsolute(assembly), absoluteWhy);
  assert.ok(fs.existsSync(assembly), existsWhy);
}

/** Every FQN a fixture record declares: the four roles plus the mixed theory when present. */
export function fixtureFqns(fixture: {
  readonly passing: string;
  readonly failing: string;
  readonly skipped: string;
  readonly parameterized: string;
  readonly mixedParameterized?: string;
}): string[] {
  return [
    fixture.passing,
    fixture.failing,
    fixture.skipped,
    fixture.parameterized,
    ...(fixture.mixedParameterized === undefined ? [] : [fixture.mixedParameterized]),
  ];
}

/** The rows for `ids` resolve one-to-one and in order; returns them. */
export function selectionFor(
  api: SharpLspExtensionApi,
  ids: readonly string[],
  countWhy: string,
  orderWhy: string,
): vscode.TestItem[] {
  const items = itemsFor(api, ids);
  assert.strictEqual(items.length, ids.length, countWhy);
  assert.deepStrictEqual(
    items.map((item) => item.id),
    ids,
    orderWhy,
  );
  return items;
}

/** The selection resolves one-to-one and builds ONE --filter batch of bare clauses; returns the rows. */
export function assertBareSelectionFilter(
  api: SharpLspExtensionApi,
  ids: readonly string[],
  countWhy: string,
  filterWhy: string,
  clauseWhy: string,
): vscode.TestItem[] {
  const items = itemsFor(api, ids);
  assert.strictEqual(items.length, ids.length, countWhy);
  assert.strictEqual(buildFilterArgs(items).length, 2, filterWhy);
  assertBareFilterClauses(items, ids, clauseWhy);
  return items;
}

/** `buildFilterArgs(ids)` is ONE flag+expression carrying exactly `count` FQN clauses. */
export function assertBatchedFilter(
  ids: readonly string[],
  count: number,
  lenWhy: string,
  clauseWhy: string,
): string[] {
  const args = buildFilterArgs(ids.map((id) => ({ id })));
  assert.strictEqual(args.length, 2, lenWhy);
  assert.strictEqual((args[1] ?? '').split('FullyQualifiedName=').length - 1, count, clauseWhy);
  return args;
}

/** The tree's single root row, failing with `why` when there is none. */
export function soleRoot(items: vscode.TestItemCollection, why: string): vscode.TestItem {
  const root = rootsOf(items)[0];
  assert.ok(root, why);
  return root;
}

/**
 * Snapshots leaf and node ids, asserts the tree equals `expected`, then presses
 * refresh and lets the sweep land; returns the snapshot to compare against.
 */
export async function refreshDiscovery(
  api: SharpLspExtensionApi,
  expected: readonly string[],
  why: string,
): Promise<{ leavesBefore: string[]; nodesBefore: string[] }> {
  const leavesBefore = sorted(collectLeafIds(api.testController.items));
  const nodesBefore = sorted(collectItemIds(api.testController.items));
  assert.deepStrictEqual(leavesBefore, sorted(expected), why);
  await drainDiscovery(() => {
    void api.testController.activateAndDiscover();
  }, api.testController);
  return { leavesBefore, nodesBefore };
}
