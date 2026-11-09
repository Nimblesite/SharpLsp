// Assertion bundles shared by the Test Explorer run-profile suites.
//
// Each helper carries the WHOLE claim a suite would otherwise write out by
// hand — tree set checks, row-survival loops, sole-assembly-root reads, bare
// `--filter` argument shapes, green-outcome loops and discovery preconditions —
// so a suite asserts more by calling one function than by duplicating its body
// ([TEST-REACTIVITY], [TEST-RUN-TRX], [TEST-FILTER-ESCAPE]).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { buildFilterArgs } from '../../test-execution.js';
import { filterClause } from '../../test-filter.js';
import { statusLensTitle } from '../../test-lens.js';
import type { CachedTestResult, SharpLspTestController } from '../../testing.js';
import { NO_RESULT, sorted } from './test-explorer-outcome-assertions';
import {
  assertFailed,
  assertPassed,
  assertSkipped,
  cachedFor,
} from './test-explorer-outcome-assertions';
import {
  collectLeafIds,
  discoverSolution,
  findItem,
  rootsOf,
  type TestItemSnapshot,
} from './test-explorer-kit';

/** How {@link assertRowsRemain} should stress each row beyond its bare presence. */
export interface RowsRemainOptions {
  /** What just happened to the tree — prepended to every row's failure text. */
  readonly why: string;
  /** The row must still be a LEAF: no children may hang off it. */
  readonly asLeaf?: boolean;
  /** The row must carry no discovery error. */
  readonly unerrored?: boolean;
}

/** Every id still resolves to a row under the fully-qualified name it was discovered under. */
export function assertRowsRemain(
  items: vscode.TestItemCollection,
  ids: readonly string[],
  options: RowsRemainOptions,
): void {
  for (const id of ids) {
    const item = findItem(items, id);
    assert.ok(item, `${id} ${options.why}`);
    assert.strictEqual(item.id, id, `${id} sits under its own fully-qualified name`);
    if (options.asLeaf === true) {
      assert.strictEqual(item.children.size, 0, `${id} is still a leaf`);
    }
    if (options.unerrored === true) {
      assert.strictEqual(item.error, undefined, `${id} is not marked errored`);
    }
  }
}

/** `actual` is EXACTLY `expected`: complete, each id once, the same set regardless of order. */
export function assertExactIdSet(
  actual: readonly string[],
  expected: readonly string[],
  why: string,
): void {
  assert.strictEqual(new Set(actual).size, actual.length, `${why}: no duplicates`);
  assert.strictEqual(actual.length, expected.length, `${why}: complete, nothing extra`);
  assert.deepStrictEqual(sorted(actual), sorted(expected), `${why}: exactly the expected ids`);
}

/** The settled tree's leaves are exactly `expected`, read straight off the controller. */
export function assertExactLeafSet(
  controller: SharpLspTestController,
  expected: readonly string[],
  why: string,
): string[] {
  const leaves = collectLeafIds(controller.items);
  assertExactIdSet(leaves, expected, why);
  return leaves;
}

/** Discover the fixture solution and assert it came back exactly as `expected`. */
export async function discoverExactly(
  api: SharpLspExtensionApi,
  solutionPath: string,
  expected: readonly string[],
  why: string,
): Promise<string[]> {
  const discovered = await discoverSolution(api, solutionPath, expected);
  assertExactIdSet(discovered, expected, why);
  return discovered;
}

/** The one assembly root of a single-project fixture: present, group-shaped, project-labelled. */
export function assertSoleAssemblyRoot(
  controller: SharpLspTestController,
  label: string,
  why: string,
): vscode.TestItem {
  const roots = rootsOf(controller.items);
  assert.strictEqual(roots.length, 1, `${why}: exactly one assembly root`);
  const root = roots[0];
  assert.ok(root, `${why}: the assembly root is readable`);
  assert.strictEqual(root.label, label, `${why}: labelled for the project`);
  assert.ok(
    root.id.startsWith('assembly:'),
    `${why}: an assembly root is a GROUP id, never an FQN; got ${root.id}`,
  );
  return root;
}

/** What {@link assertGreenResult} checks beyond the outcome itself. */
export interface GreenOptions {
  /** The `passed` flag agrees with the outcome. */
  readonly passFlag?: boolean;
  /** A real, non-negative measured duration came back. */
  readonly duration?: boolean;
  /** The missing-result note to ban — defaults to the TRX reconciliation note. */
  readonly noNote?: string;
}

/** A run REALLY reported `id` green: present, outcome `passed`, and no missing-result note. */
export function assertGreenResult(
  result: CachedTestResult | undefined,
  id: string,
  why: string,
  options: GreenOptions = {},
): CachedTestResult {
  assert.ok(result, `${id} ${why}`);
  assert.strictEqual(result.outcome, 'passed', `${id} passes when left alone`);
  if (options.passFlag === true) {
    assert.ok(result.passed, `${id} carries the pass flag`);
  }
  assert.ok(
    !(result.message ?? '').includes(options.noNote ?? NO_RESULT),
    `${id} really ran, so it reports no missing-result note`,
  );
  if (options.duration === true) {
    assert.ok(Number(result.duration) >= 0, `${id} carries a measured duration`);
  }
  return result;
}

/** The fixture's three outcome kinds report IN FULL as a pass, a failure and a skip. */
export function assertAllThreeOutcomes(
  api: SharpLspExtensionApi,
  fixture: { readonly passing: string; readonly failing: string; readonly skipped: string },
): void {
  assertPassed(cachedFor(api, fixture.passing), fixture.passing);
  assertFailed(cachedFor(api, fixture.failing), fixture.failing);
  assertSkipped(cachedFor(api, fixture.skipped), fixture.skipped);
}

/** Every selected id reports a real green result, each rendering as a pass. */
export function assertAllResultsGreen(
  controller: SharpLspTestController,
  ids: readonly string[],
  why: string,
  options: GreenOptions = {},
): void {
  for (const id of ids) {
    const result = assertGreenResult(controller.getResult(id), id, why, options);
    assert.ok(
      statusLensTitle(result).startsWith('$(pass) Passed'),
      `${id} renders above its binding as a pass`,
    );
  }
}

/** A theory whose rows disagree merges to the WORST row: a real failure carrying its own text. */
export function assertMergedTheoryFails(result: CachedTestResult, id: string, why: string): void {
  assert.strictEqual(result.outcome, 'failed', `${id}: one failing row makes the theory fail`);
  assert.ok(!result.passed, `${id}: the pass flag agrees`);
  assert.ok(
    (result.message ?? '').includes('Assert.Equal'),
    `${id}: carrying the failing row's own assertion text (${why})`,
  );
}

/** `buildFilterArgs(tests)` passes `--filter` first and OR-s one bare FQN clause per test. */
export function assertBareFilterClauses(
  tests: readonly { readonly id: string }[],
  ids: readonly string[],
  why: string,
): void {
  const args = buildFilterArgs(tests);
  assert.strictEqual(args[0], '--filter', `${why}: --filter comes first`);
  const expression = args[1] ?? '';
  assert.ok(
    !expression.includes('\\'),
    `${why}: a bare FQN needs no escaping anywhere; got ${expression}`,
  );
  assert.deepStrictEqual(
    expression.split('|'),
    ids.map((id) => `FullyQualifiedName=${id}`),
    `${why}: one clause per selected test, OR-ed with a bare pipe in selection order`,
  );
}

/** This FQN carries SPACES, which are not filter grammar: its clause is the bare name. */
export function assertBareSpacedClause(
  fqn: string,
  why: { readonly spaced: string; readonly clause: string },
): void {
  assert.ok(fqn.includes(' '), why.spaced);
  assert.strictEqual(filterClause(fqn), `FullyQualifiedName=${fqn}`, why.clause);
}

/** `actual` and `expected` hold the same ids, whatever order they arrived in. */
export function assertSameSet(
  actual: readonly string[],
  expected: readonly string[],
  why: string,
): void {
  assert.deepStrictEqual(sorted(actual), sorted(expected), why);
}

/** The controller's tree stands on exactly `count` roots. */
export function assertRootCount(
  controller: SharpLspTestController,
  count: number,
  why: string,
): void {
  assert.strictEqual(rootsOf(controller.items).length, count, why);
}

/** `id` still reports exactly what `baseline` cached for it, named by `why`. */
export function assertResultUnchanged(
  controller: SharpLspTestController,
  id: string,
  baseline: ReadonlyMap<string, CachedTestResult>,
  why: string,
): void {
  assert.deepStrictEqual(controller.getResult(id), baseline.get(id), why);
}

/** Every id still reports exactly what `baseline` cached for it, named by `why`. */
export function assertResultsKept(
  controller: SharpLspTestController,
  ids: readonly string[],
  baseline: ReadonlyMap<string, CachedTestResult>,
  why: (id: string) => string,
): void {
  for (const id of ids) {
    assertResultUnchanged(controller, id, baseline, why(id));
  }
}

/** `id`'s cached result carries no "missing result" note — the test really ran. */
export function assertResultReported(
  api: SharpLspExtensionApi,
  id: string,
  why: string,
): CachedTestResult {
  const result = cachedFor(api, id);
  assert.ok(!(result.message ?? '').includes(NO_RESULT), `${id}: ${why}`);
  return result;
}

/** Not one of `ids` carries a "missing result" note. */
export function assertNoMissingResults(
  controller: SharpLspTestController,
  ids: readonly string[],
  why: string,
): void {
  assert.deepStrictEqual(
    ids
      .map((id) => controller.getResult(id)?.message ?? '')
      .filter((message) => message.includes(NO_RESULT)),
    [],
    why,
  );
}

/** One test's cached outcome, named on failure by the site's own text. */
export function assertOutcome(
  controller: SharpLspTestController,
  id: string,
  outcome: string,
  why: string,
): void {
  assert.strictEqual(controller.getResult(id)?.outcome, outcome, why);
}

/** The status lens above `id` renders exactly `title`. */
export function assertLensTitle(
  api: SharpLspExtensionApi,
  id: string,
  title: string,
  why: string,
): void {
  assert.strictEqual(statusLensTitle(cachedFor(api, id)), title, why);
}

/** The status lens above `id` renders a title beginning with `prefix`. */
export function assertLensStarts(
  api: SharpLspExtensionApi,
  id: string,
  prefix: string,
  why: string,
): void {
  assert.ok(statusLensTitle(cachedFor(api, id)).startsWith(prefix), why);
}

/** The status lens above `id` reads NO "missing result" note. */
export function assertLensReported(api: SharpLspExtensionApi, id: string, why: string): void {
  assert.ok(!statusLensTitle(cachedFor(api, id)).includes(NO_RESULT), why);
}

/**
 * A settled tree's row census: groups share ONE discovery-target uri, tests
 * point at `fileCount` declaring files with unique descriptions, and no row
 * carries a framework tag.
 */
export function assertSnapshotUriShape(
  groups: readonly TestItemSnapshot[],
  tests: readonly TestItemSnapshot[],
  options: { readonly fileCount: number; readonly why: string },
): void {
  assert.deepStrictEqual(
    [...groups, ...tests].flatMap((row) => row.tags),
    [],
    `${options.why}: no row carries a framework tag — that tag is reserved for Expecto/FsCheck naming`,
  );
  assert.strictEqual(
    new Set(groups.map((row) => row.uriPath)).size,
    1,
    `${options.why}: every group shares the one discovery-target uri`,
  );
  assert.strictEqual(
    new Set(tests.map((row) => row.uriPath)).size,
    options.fileCount,
    `${options.why}: every test points at its declaring file, one per fixture project`,
  );
  assert.strictEqual(
    new Set(tests.map((row) => row.description)).size,
    tests.length,
    `${options.why}: descriptions stay unique — that is WHY the description carries the whole FQN`,
  );
}
