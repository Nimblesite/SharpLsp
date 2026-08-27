// Assertions about ONE cached Test Explorer result, shared by the run-profile
// suites.
//
// Each helper asserts the WHOLE contract of an outcome, not just its label: the
// outcome string, the `passed` flag, the duration, the message, and what the
// status CodeLens renders from all of it. A pass that carried a failure message,
// or a skip that rendered as a failure, would slip past a bare
// `assert.strictEqual(result.outcome, …)` — and "a skip reported as a failure"
// is precisely the regression these suites exist to prevent.
//
// Covers [TEST-RUN-TRX] and [TEST-STATUS-LENS].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { formatDuration, statusLensTitle } from '../../test-lens.js';
import type { CachedTestResult } from '../../testing.js';
import { collectItemIds, findItem } from './test-explorer-kit';

/** Sorted copy, so set-equality assertions do not depend on discovery order. */
export function sorted(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** The cached result for `id`, failing with what WAS cached when absent. */
export function cachedFor(api: SharpLspExtensionApi, id: string): CachedTestResult {
  const result = api.testController.getResult(id);
  const keys = [...api.testController.cachedResults.keys()].join(' | ');
  assert.ok(result, `a result must be cached for ${id}; cached instead: ${keys}`);
  return result;
}

/** The tree items for `ids`, asserted discovered so no run can be vacuous. */
export function itemsFor(api: SharpLspExtensionApi, ids: readonly string[]): vscode.TestItem[] {
  return ids.map((id) => {
    const item = findItem(api.testController.items, id);
    const tree = collectItemIds(api.testController.items).join(' | ');
    assert.ok(item, `${id} must be in the tree before it can be run; tree: ${tree}`);
    assert.strictEqual(item.id, id, 'findItem must return the item asked for, not a near miss');
    return item;
  });
}

/** Cached ids belonging to THIS suite's fixtures (the cache outlives a suite). */
export function fixtureKeys(api: SharpLspExtensionApi, known: readonly string[]): string[] {
  // Intersect with the caller's OWN expected ids rather than matching a
  // namespace prefix. Every suite in the run shares one controller and one
  // result cache, so a prefix filter picks up whatever a neighbouring suite
  // happened to run — including the deliberately-missing ids those suites use
  // to prove the notRun path.
  const wanted = new Set(known);
  return [...api.testController.cachedResults.keys()].filter((id) => wanted.has(id));
}

/** A genuine pass: outcome, flag, a real measured duration AND its rendering. */
export function assertPassed(result: CachedTestResult, id: string): void {
  const detail = `got '${result.outcome}': ${result.message ?? 'no message'}`;
  assert.strictEqual(
    result.outcome,
    'passed',
    `${id} passes in the fixture, so TRX must say so (${detail})`,
  );
  assert.strictEqual(result.passed, true, `${id} passed, so the pass flag must be true`);
  assert.strictEqual(
    typeof result.duration,
    'number',
    `${id} must carry the duration TRX recorded`,
  );
  assert.strictEqual(
    (result.duration ?? -1) >= 0,
    true,
    `${id} duration must be non-negative, got ${String(result.duration)}`,
  );
  assert.strictEqual(
    result.message,
    undefined,
    `${id} passed, so no failure text may attach: ${result.message ?? 'none'}`,
  );
  assert.strictEqual(
    statusLensTitle(result),
    `$(pass) Passed${formatDuration(result.duration)}`,
    `${id} renders as a pass carrying its own duration`,
  );
}

/** A real failure carrying the REAL assertion text, not "Test failed". */
export function assertFailed(result: CachedTestResult, id: string): void {
  assert.strictEqual(
    result.outcome,
    'failed',
    `${id} fails in the fixture, got '${result.outcome}'`,
  );
  assert.strictEqual(result.passed, false, `${id} failed, so the pass flag must be false`);
  assert.notStrictEqual(
    result.message,
    undefined,
    `${id} must carry the failure message TRX recorded`,
  );
  const message = result.message ?? '';
  assert.strictEqual(
    message.includes('Assert.Equal() Failure'),
    true,
    `${id} must surface xUnit's own text: ${message}`,
  );
  assert.strictEqual(
    message.includes('Expected'),
    true,
    `${id} must surface the Expected/Actual detail: ${message}`,
  );
  assert.notStrictEqual(message, 'Test failed', `${id} must not fall back to the generic message`);
  assert.strictEqual(
    statusLensTitle(result),
    `$(error) Failed: ${message}`,
    `${id} renders its cached message verbatim`,
  );
}

/** A skip is neither a pass nor a failure. THE headline regression. */
export function assertSkipped(result: CachedTestResult, id: string): void {
  assert.strictEqual(
    result.outcome,
    'skipped',
    `${id} is [Fact(Skip=…)]: NotExecuted maps to 'skipped', got '${result.outcome}'`,
  );
  assert.notStrictEqual(
    result.outcome,
    'failed',
    `${id} is skipped and must NEVER be a failure — the original bug`,
  );
  assert.strictEqual(result.passed, false, `${id} was not executed, so it is not a pass either`);
  const message = result.message ?? 'none';
  assert.strictEqual(
    message.includes('Assert'),
    false,
    `${id} is skipped, so no assertion text may attach: ${message}`,
  );
  assert.strictEqual(
    statusLensTitle(result),
    '$(debug-step-over) Skipped',
    `${id} renders as a skip, never as a failure`,
  );
}

/** The three groups a fixture solution partitions its tests into. */
export interface OutcomeGroups {
  readonly passing: readonly string[];
  readonly failing: readonly string[];
  readonly skipped: readonly string[];
}

/** Assert the whole fixture selection was attributed correctly, test by test. */
export function assertEveryOutcome(api: SharpLspExtensionApi, groups: OutcomeGroups): void {
  for (const id of groups.passing) assertPassed(cachedFor(api, id), id);
  for (const id of groups.failing) assertFailed(cachedFor(api, id), id);
  for (const id of groups.skipped) assertSkipped(cachedFor(api, id), id);
}
