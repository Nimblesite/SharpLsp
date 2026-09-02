// A test's id is the BARE fully-qualified name, whatever the VSTest adapter
// decorated it with — asserted through every user-facing surface that consumes
// that id.
//
// `dotnet vstest … --ListFullyQualifiedTests` does not always write a bare
// `TestCase.FullyQualifiedName`. On `xunit.runner.visualstudio` 2.2.0 — still
// pinned by real-world projects, FluentValidation among them — it appends the
// test case's 40-hex unique ID:
//
//   Cs.XunitDecorated.Fixtures.CalculatorTests.Adds_TwoNumbers (d87517d9ff1844…)
//
// Taken verbatim as the id, that one suffix breaks FOUR surfaces at once, and
// this suite drives each of them as a user does:
//
//   • the TREE labels the test with a hex blob instead of a method name,
//   • `--filter FullyQualifiedName=…\(d87517d9…\)` escapes the parentheses and
//     then matches NO test, so ▶ runs nothing,
//   • the TRX report keys on `className.name` — the bare name — so no outcome
//     can be attributed back and every test errors "No result reported",
//   • the Run/Debug LENS looks a test up by method name and finds nothing.
//
// Every other Test Explorer fixture pins a modern adapter that emits bare names,
// which is exactly why the suite was blind to all four (issue #232). Names that
// legitimately end in parentheses MUST survive untouched — [TEST-DISCOVERY-FQN]
// requires the NUnit `Adds_Case(2,2,4)` shape to round-trip.
//
// Covers [TEST-DISCOVERY-FQN], [TEST-FILTER-ESCAPE], [TEST-RUN-TRX] and
// [TEST-STATUS-LENS].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  parseFullyQualifiedTestList,
  parseTestAssemblies,
  withoutAdapterUniqueId,
} from '../../test-discovery.js';
import { buildFilterArgs } from '../../test-execution.js';
import { filterClause } from '../../test-filter.js';
import { findTestByMethodName, statusLensTitle } from '../../test-lens.js';
import {
  createSolution,
  dotnet,
  projectXml,
  warmDiscovery,
  writeProject,
} from './dotnet-project-kit';
import { DECORATING_ADAPTER_FIXTURE as FIXTURE } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectItemIds,
  collectLeafIds,
  drainDiscovery,
  findItem,
  pollForIds,
  profileOfKind,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  assertSkipped,
  cachedFor,
  itemsFor,
  sorted,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers.js';
import { DOTNET_CLI_MS, FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** Every fully-qualified name the name-decorating adapter fixture exposes. */
const EXPECTED: readonly string[] = [
  FIXTURE.passing,
  FIXTURE.failing,
  FIXTURE.skipped,
  FIXTURE.parameterized,
  ...(FIXTURE.mixedParameterized === undefined ? [] : [FIXTURE.mixedParameterized]),
];

/** The three outcomes a run must attribute, one per kind. */
const RUNNABLE = [FIXTURE.passing, FIXTURE.failing, FIXTURE.skipped] as const;

/** The namespace and class the fixture's tests group under. */
const NAMESPACE = 'Cs.XunitDecorated.Fixtures';
const CLASS = 'CalculatorTests';

/** The user-visible text a broken id produces. Must never appear. */
const NO_RESULT = 'No result reported';

/**
 * True when `name` still carries the adapter's unique-ID decoration.
 *
 * Asked of the production classifier rather than re-implementing its rule here:
 * a second copy of "what a decorated name looks like" is exactly the duplication
 * that lets the two drift apart. A stripper broken to strip nothing makes the
 * vacuity guard below FAIL — it would report the raw listing as undecorated —
 * and one broken to strip everything is caught by the bare-id assertion, so
 * neither failure mode can hide behind this.
 */
function carriesUniqueId(name: string): boolean {
  return withoutAdapterUniqueId(name) !== name;
}

/** The method name a leaf's label must equal. */
function methodOf(fqn: string): string {
  return fqn.split('.').at(-1) ?? fqn;
}

/** The single child of a group node, asserted to be the only one. */
function onlyChild(item: vscode.TestItem, why: string): vscode.TestItem {
  const children = rootsOf(item.children);
  assert.strictEqual(
    children.length,
    1,
    `${why}; got: ${children.map((child) => child.label).join(' | ') || '(nothing)'}`,
  );
  return children[0]!;
}

/** Every leaf beneath `item`, with the depth it sits at. */
function leavesWithDepth(
  item: vscode.TestItem,
  depth: number,
): { item: vscode.TestItem; depth: number }[] {
  if (item.children.size === 0) return [{ item, depth }];
  return rootsOf(item.children).flatMap((child) => leavesWithDepth(child, depth + 1));
}

suite('Test Explorer — adapter-decorated names become BARE test ids', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let announced: string;
  let discovered: string[];
  let rawListing: string[];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-adapterids-'));
    const projectDir = writeProject(
      path.join(root, FIXTURE.projectName),
      FIXTURE.projectFileName,
      projectXml(FIXTURE.packages),
      FIXTURE.sourceFileName,
      FIXTURE.source,
    );
    const slnPath = await createSolution(root, 'DecoratedNames', [projectDir]);

    // Warm the FULL discovery path once, and keep the assembly it announced:
    // the vacuity guard re-runs the listing pass against it directly.
    const listing = await warmDiscovery(slnPath, root);
    announced = parseTestAssemblies(listing)[0] ?? '';
    assert.notStrictEqual(announced, '', 'the fixture must have announced a built test assembly');

    const listPath = path.join(root, 'raw-fqns.txt');
    await dotnet(
      ['vstest', announced, '--ListFullyQualifiedTests', `--ListTestsTargetPath:${listPath}`],
      root,
    );
    rawListing = fs
      .readFileSync(listPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Settle the tree by COUNT, never by the names this suite is asserting.
    // Waiting here for the bare names would make the defect present as a hook
    // that ran out its own ceiling — the failure every assertion below exists to
    // describe, reported as an opaque timeout instead
    // ([DIST-CI-VSIX-SHARDS-TIMEOUTS]). The poll budget sits strictly under the
    // hook's for the same reason.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    discovered = await pollForIds(
      api.testController,
      (ids) => ids.length >= EXPECTED.length,
      DOTNET_CLI_MS,
    );
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Drain reactive re-discovery BEFORE deleting the fixture: a `dotnet test`
    // pointed at a removed directory hangs forever and poisons later runs.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('the adapter really does decorate its names, so this suite cannot pass vacuously', function () {
    this.timeout(FAST_MS);

    // Interaction 1 — the raw listing VSTest wrote must carry the decoration on
    // EVERY line. Without that, this whole suite is asserting nothing.
    assert.ok(rawListing.length > 0, 'the listing pass must have written some names');
    assert.deepStrictEqual(
      rawListing.filter((name) => !carriesUniqueId(name)),
      [],
      'xunit.runner.visualstudio 2.2.0 appends a unique ID to EVERY name it reports; ' +
        'without that, this suite proves nothing',
    );

    // Interaction 2 — the decoration is what made the names non-unique-per-test:
    // a theory reports one line PER ROW, each with its own unique ID, so the raw
    // listing is strictly longer than the set of tests.
    assert.ok(
      rawListing.length > EXPECTED.length,
      `a [Theory] reports one decorated line per row, so the raw listing (${String(
        rawListing.length,
      )}) must exceed the ${String(EXPECTED.length)} tests it describes`,
    );
    for (const theory of [FIXTURE.parameterized, FIXTURE.mixedParameterized ?? '']) {
      if (theory === '') continue;
      const rows = rawListing.filter((name) => withoutAdapterUniqueId(name) === theory);
      assert.ok(
        rows.length >= 2,
        `${theory} declares two [InlineData] rows, so the adapter must report two decorated ` +
          `lines for it; got ${String(rows.length)}`,
      );
    }

    // Interaction 3 — the production reader turns that exact file into exactly
    // the tests, collapsing the rows. This is the parser under real input, not a
    // hand-written imitation of it.
    assert.deepStrictEqual(
      sorted(parseFullyQualifiedTestList(rawListing.join('\n'))),
      sorted(EXPECTED),
      'reading the REAL listing file must yield one bare id per test, rows collapsed',
    );
  });

  test('discovered ids are the BARE fully-qualified names, with no adapter suffix', function () {
    this.timeout(FAST_MS);

    // Interaction 1 — the tree settled, and has not moved since.
    const leaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      leaves,
      discovered,
      'the tree must not have moved between the settled read and this assertion',
    );

    // Interaction 2 — no id carries the decoration, by the production rule…
    assert.deepStrictEqual(
      leaves.filter((id) => carriesUniqueId(id)),
      [],
      "a test id is the name `--filter` and the TRX report use — never the adapter's decoration",
    );

    // Interaction 3 — …nor by the blunter one. This fixture is C#, so no id has
    // any business containing a parenthesis at all; a stripper that trimmed the
    // hex but left the brackets would satisfy Interaction 2 and still break the
    // filter grammar.
    assert.deepStrictEqual(
      leaves.filter((id) => id.includes('(') || id.includes(')')),
      [],
      'no C# xUnit id contains parentheses — those are filter-grammar metacharacters',
    );

    // Interaction 4 — the set is exactly the fixture's tests, each once.
    assert.deepStrictEqual(
      sorted(leaves),
      sorted(EXPECTED),
      'every test in the project is discovered, exactly once, under its bare name',
    );
    assert.strictEqual(
      new Set(leaves).size,
      leaves.length,
      'a theory whose rows each kept their own unique ID would appear as several leaves',
    );

    // Interaction 5 — every id is `<namespace>.<class>.<method>`, the shape the
    // TRX report reconstructs as `className.name`. An id that does not have this
    // shape can never be matched to a result.
    for (const id of leaves) {
      assert.strictEqual(
        id.startsWith(`${NAMESPACE}.${CLASS}.`),
        true,
        `${id} must be <namespace>.<class>.<method> so the TRX key can be reconstructed`,
      );
    }
  });

  test('the tree renders Assembly → Namespace → Class → Test with readable labels', function () {
    this.timeout(FAST_MS);

    // Interaction 1 — one assembly root, named for the project.
    const roots = rootsOf(api.testController.items);
    assert.deepStrictEqual(
      roots.map((item) => item.label),
      [FIXTURE.projectName],
      'the fixture is one project, so the Testing view shows one assembly root',
    );
    const assemblyNode = roots[0]!;
    assert.strictEqual(
      assemblyNode.id.startsWith('assembly:'),
      true,
      `an assembly root is a GROUP id, never an FQN; got ${assemblyNode.id}`,
    );
    assert.strictEqual(
      assemblyNode.canResolveChildren,
      true,
      'the root must declare children so the view offers an expander',
    );

    // Interaction 2 — expanding it reaches the namespace, then the class.
    const namespaceNode = onlyChild(assemblyNode, 'the fixture declares ONE namespace');
    assert.strictEqual(namespaceNode.label, NAMESPACE, 'the namespace node is labelled by it');
    assert.strictEqual(namespaceNode.canResolveChildren, true, 'a namespace group expands');
    const classNode = onlyChild(namespaceNode, 'the fixture declares ONE class');
    assert.strictEqual(classNode.label, CLASS, 'the class node is labelled by the class name');
    assert.strictEqual(classNode.canResolveChildren, true, 'a class group expands');

    // Interaction 3 — every test is a LEAF at depth 4, labelled with its method
    // name alone. This is the assertion the hex blob failed: the label was
    // `Adds_TwoNumbers (d87517d9…)`.
    const leaves = leavesWithDepth(assemblyNode, 1);
    assert.deepStrictEqual(
      sorted(leaves.map((leaf) => leaf.item.label)),
      sorted(EXPECTED.map(methodOf)),
      'each leaf is labelled with its method name alone — never a hex blob',
    );
    assert.deepStrictEqual(
      [...new Set(leaves.map((leaf) => leaf.depth))],
      [4],
      'every test sits at exactly Assembly → Namespace → Class → Test',
    );

    // Interaction 4 — the hover/description carries the full name, and the id
    // and description agree. A user reading the row sees the real FQN.
    for (const leaf of leaves) {
      assert.strictEqual(
        leaf.item.description,
        leaf.item.id,
        `${leaf.item.label} must describe itself with its own fully-qualified name`,
      );
      assert.strictEqual(
        `${NAMESPACE}.${CLASS}.${leaf.item.label}`,
        leaf.item.id,
        'the label must be the id with the namespace and class removed, nothing else',
      );
    }

    // Interaction 5 — no two nodes anywhere in the tree share an id. VS Code
    // keys the view on ids; duplicates make rows shadow one another.
    const everyId = collectItemIds(api.testController.items);
    assert.strictEqual(
      new Set(everyId).size,
      everyId.length,
      `every node in the Testing view needs its own id; got ${everyId.join(' | ')}`,
    );
  });

  test('the --filter a run builds is the bare name, matching a real test', function () {
    this.timeout(FAST_MS);

    // Interaction 1 — the clause for each discovered id is the plain name. A
    // decorated id produced `FullyQualifiedName=…\(d87517d9…\)`, which is
    // syntactically valid and matches nothing, so the run reported no results at
    // all rather than failing ([TEST-FILTER-ESCAPE]).
    for (const id of collectLeafIds(api.testController.items)) {
      assert.strictEqual(
        filterClause(id),
        `FullyQualifiedName=${id}`,
        `${id} must need NO escaping — anything escaped here is adapter decoration`,
      );
    }

    // Interaction 2 — the argument vector a run actually spawns carries no
    // escaped metacharacter either.
    const items = itemsFor(api, RUNNABLE);
    const args = buildFilterArgs(items);
    assert.strictEqual(args[0], '--filter', 'a filtered run passes --filter first');
    const expression = args[1] ?? '';
    assert.strictEqual(
      expression.includes('\\'),
      false,
      `a bare C# FQN filter contains no escapes; got ${expression}`,
    );
    assert.deepStrictEqual(
      expression.split('|'),
      RUNNABLE.map((id) => `FullyQualifiedName=${id}`),
      'the selection is OR-ed clause by clause, one per selected test',
    );
  });

  test('the Run/Debug lens resolves a test by its method name', function () {
    this.timeout(FAST_MS);

    // The lens carries only the method name it read out of the editor. With a
    // decorated id the short name was `Adds_TwoNumbers (d87517d9…)`, so the lens
    // matched nothing and every test looked undiscovered ([TEST-STATUS-LENS]).
    for (const fqn of EXPECTED) {
      const found = findTestByMethodName(api.testController.items, methodOf(fqn));
      assert.ok(found, `the lens above ${methodOf(fqn)} must resolve to a discovered test`);
      assert.strictEqual(found.id, fqn, 'and to THAT test — the lens runs whatever it resolved to');
    }

    // A method that does not exist must still resolve to nothing, so the lens
    // above an ordinary method offers no Run button.
    assert.strictEqual(
      findTestByMethodName(api.testController.items, 'Add'),
      undefined,
      'the private helper is not a test and must not carry a Run lens',
    );
  });

  test('▶ reports a REAL outcome per test — never "No result reported"', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — press ▶ on a selection of three tests, one per outcome.
    const runProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Run);
    assert.strictEqual(
      runProfile.isDefault,
      true,
      'Run is the default profile — it is the ▶ the user actually presses',
    );
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, RUNNABLE));

    // Interaction 2 — each outcome is attributed from the TRX report, in full:
    // the outcome, the passed flag, a measured duration, and the message.
    const passed = cachedFor(api, FIXTURE.passing);
    const failed = cachedFor(api, FIXTURE.failing);
    const skipped = cachedFor(api, FIXTURE.skipped);
    assertPassed(passed, FIXTURE.passing);
    assertFailed(failed, FIXTURE.failing);
    assertSkipped(skipped, FIXTURE.skipped);

    // Interaction 3 — none of them carries the "the filter matched no test"
    // message. This is the literal string the user saw on all 35 tests.
    for (const [id, result] of [
      [FIXTURE.passing, passed],
      [FIXTURE.failing, failed],
      [FIXTURE.skipped, skipped],
    ] as const) {
      assert.strictEqual(
        (result.message ?? '').includes(NO_RESULT),
        false,
        `${id} was actually run, so its message must not be "${NO_RESULT}"; got ${
          result.message ?? '(none)'
        }`,
      );
    }

    // Interaction 4 — the failure carries the REAL assertion text out of the
    // TRX report. A fabricated "Test failed" would satisfy `assertFailed` while
    // proving nothing was ever executed.
    assert.strictEqual(
      (failed.message ?? '').includes('Assert.Equal'),
      true,
      `the failing test's message must be xUnit's own assertion output; got ${
        failed.message ?? '(none)'
      }`,
    );

    // Interaction 5 — the status lens renders each outcome the way the user
    // reads it above the method ([TEST-STATUS-LENS]).
    assert.strictEqual(
      statusLensTitle(passed).startsWith('$(pass) Passed'),
      true,
      `a pass renders as a pass; got ${statusLensTitle(passed)}`,
    );
    assert.strictEqual(
      statusLensTitle(failed).startsWith('$(error) Failed'),
      true,
      `a failure renders as a failure; got ${statusLensTitle(failed)}`,
    );
    assert.strictEqual(
      statusLensTitle(skipped),
      '$(debug-step-over) Skipped',
      'a SKIP is neither a pass nor a failure',
    );

    // Interaction 6 — the cache is keyed by the bare id, so a second lens read
    // finds the same result.
    for (const id of RUNNABLE) {
      assert.ok(
        api.testController.getResult(id),
        `the status-lens cache must be keyed by the bare id; ${id} was not found`,
      );
    }
  });

  test('▶ on the CLASS group runs every test it contains, theories included', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the user presses ▶ on the class row, not on a leaf.
    const classId = findItem(
      api.testController.items,
      `${NAMESPACE}.${CLASS}.${methodOf(FIXTURE.passing)}`,
    )?.parent;
    assert.ok(classId, 'a leaf must hang off the class group it belongs to');
    assert.strictEqual(classId.label, CLASS, 'and that parent is the class node');

    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [classId]);

    // Interaction 2 — every test under it now has a cached outcome, including
    // both theories, whose rows report under one name each.
    for (const fqn of EXPECTED) {
      const result = api.testController.getResult(fqn);
      assert.ok(result, `▶ on the class must report ${fqn}; nothing was cached for it`);
      assert.strictEqual(
        (result.message ?? '').includes(NO_RESULT),
        false,
        `${fqn} ran, so it must not report "${NO_RESULT}"`,
      );
    }

    // Interaction 3 — a theory whose rows DISAGREE reports as a failure. Its two
    // rows carried different unique IDs, so a decorated id also split it into
    // two independently-reported leaves.
    if (FIXTURE.mixedParameterized !== undefined) {
      const mixed = cachedFor(api, FIXTURE.mixedParameterized);
      assert.strictEqual(
        mixed.passed,
        false,
        'a [Theory] with one failing row is a failing test, reported once',
      );
    }
    assertPassed(cachedFor(api, FIXTURE.parameterized), FIXTURE.parameterized);
  });
});
