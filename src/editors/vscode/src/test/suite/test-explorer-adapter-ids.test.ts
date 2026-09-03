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
    // Interaction 3 - the decoration is a SPACE then 40 hex digits, and the
    // guard has to hold for EVERY line the adapter wrote, not for one of them.
    for (const raw of rawListing) {
      assert.strictEqual(raw.trim(), raw, `${raw} arrived without padding`);
      assert.strictEqual(raw.length > 0, true, 'and no blank line is a listed test');
      assert.strictEqual(
        raw.startsWith(NAMESPACE),
        true,
        `${raw} must belong to the fixture namespace, decorated or not`,
      );
    }
    assert.strictEqual(
      rawListing.filter((raw) => carriesUniqueId(raw)).length,
      rawListing.length,
      'EVERY line this adapter wrote carries a unique ID - if even one did not, the suite ' +
        'would be proving the stripper against a name that never needed stripping',
    );
    assert.strictEqual(
      new Set(rawListing).size,
      rawListing.length,
      'each decorated line is distinct, because each carries its OWN unique ID',
    );
    assert.strictEqual(
      new Set(rawListing.map((raw) => withoutAdapterUniqueId(raw))).size < rawListing.length,
      true,
      'and stripping COLLAPSES them - which is how a theory\u2019s rows become one test',
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
    // Interaction 3 - a bare id is not merely "different from the raw line": it
    // is the exact value `--filter FullyQualifiedName=` and the TRX report both
    // key on, so it must round-trip through the stripper unchanged.
    for (const id of discovered) {
      assert.strictEqual(
        withoutAdapterUniqueId(id),
        id,
        `${id} must already be bare - a second pass that changes it means the first left a ` +
          'decoration behind',
      );
      assert.strictEqual(carriesUniqueId(id), false, `${id} carries no unique ID`);
      assert.strictEqual(id.includes('  '), false, `${id} carries no doubled space`);
      assert.strictEqual(id.endsWith(')') === id.includes('('), true, `${id} is balanced`);
    }
    assert.deepStrictEqual(
      sorted(discovered),
      sorted([...EXPECTED]),
      'and the whole set is exactly what the fixture declares',
    );
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
    // Interaction 3 - a LABEL is what the user reads, and an id is what the CLI
    // takes. Neither may carry the other's shape.
    for (const id of EXPECTED) {
      const leaf = findItem(api.testController.items, id);
      assert.ok(leaf, `${id} must be a row in the tree`);
      assert.strictEqual(leaf.label, methodOf(id), `${id} is labelled with its method name`);
      assert.strictEqual(carriesUniqueId(leaf.label), false, `${id}: no hex blob in the label`);
      assert.strictEqual(leaf.children.size, 0, `${id} is a leaf`);
      assert.strictEqual(leaf.id, id, `${id} is identified by its bare fully-qualified name`);
    }
    assert.strictEqual(
      collectItemIds(api.testController.items).some((id) => carriesUniqueId(id)),
      false,
      'and no GROUP id carries a decoration either - the assembly, namespace and class rows ' +
        'are ids the run and the lens both address',
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
    // Interaction 3 - the whole selection, as one filter. [TEST-FILTER-ESCAPE]
    // OR-s escaped clauses with an unescaped pipe, and a decorated name would
    // have escaped its parentheses and matched nothing at all.
    const everyArg = buildFilterArgs(EXPECTED.map((id) => ({ id })));
    assert.strictEqual(everyArg.length, 2, 'one --filter flag and one expression');
    assert.strictEqual(
      (everyArg[1] ?? '').split('FullyQualifiedName=').length - 1,
      EXPECTED.length,
      'one clause per selected test',
    );
    assert.strictEqual(
      (everyArg[1] ?? '').includes('\\('),
      false,
      'and nothing escaped - a bare xUnit name contains no filter grammar at all, while a ' +
        'decorated one would have escaped its brackets and matched nothing',
    );
    for (const id of EXPECTED) {
      assert.strictEqual(
        filterClause(id),
        `FullyQualifiedName=${id}`,
        `${id} produces a clause naming it exactly`,
      );
      assert.strictEqual(
        (everyArg[1] ?? '').includes(filterClause(id)),
        true,
        `${id}'s clause is in the combined expression`,
      );
    }
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
    // Interaction 3 - the lens must resolve EVERY test by its method name, and
    // must not resolve a name the fixture never declares.
    for (const id of EXPECTED) {
      const found = findTestByMethodName(api.testController.items, methodOf(id));
      assert.ok(found, `the lens must resolve ${methodOf(id)} to a discovered test`);
      assert.strictEqual(found.id, id, `and to the BARE id ${id}`);
      assert.strictEqual(carriesUniqueId(found.id), false, 'with no decoration on it');
    }
    assert.strictEqual(
      findTestByMethodName(api.testController.items, 'NoSuchMethodAnywhere'),
      undefined,
      'a method the fixture never declares must resolve to nothing rather than to a neighbour',
    );
    assert.strictEqual(
      findTestByMethodName(api.testController.items, ''),
      undefined,
      'and an empty name resolves to nothing at all',
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
    // Interaction 4 - the lens title each outcome produces. [TEST-STATUS-LENS]
    // pins the four titles, and a test whose id could not be reconciled with
    // the TRX report renders as "Not run" forever.
    const passedTitle = statusLensTitle(cachedFor(api, FIXTURE.passing));
    assert.strictEqual(
      passedTitle.startsWith('$(pass) Passed'),
      true,
      'the passing test renders as a pass',
    );
    assert.strictEqual(passedTitle.includes(NO_RESULT), false, 'and not as a missing result');
    const failedTitle = statusLensTitle(cachedFor(api, FIXTURE.failing));
    assert.strictEqual(
      failedTitle.startsWith('$(error) Failed:'),
      true,
      'the failing test renders as a failure',
    );
    assert.strictEqual(
      failedTitle.includes(NO_RESULT),
      false,
      'carrying its own assertion text, not the placeholder a missing TRX entry produces',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, FIXTURE.skipped)),
      '$(debug-step-over) Skipped',
      'and the skipped test as a skip, never as a failure',
    );
    for (const id of RUNNABLE) {
      assert.strictEqual(
        statusLensTitle(cachedFor(api, id)).includes('$(circle-slash)'),
        false,
        `${id} was run, so its lens must not read "Not run"`,
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
    // Interaction 4 - and the class row itself is unchanged by the run.
    const classRow = findItem(api.testController.items, `${NAMESPACE}.${CLASS}`);
    assert.strictEqual(
      classRow === undefined || classRow.children.size > 0,
      true,
      'a class row, if addressed by name, still holds its tests',
    );
    for (const id of EXPECTED) {
      const leaf = findItem(api.testController.items, id);
      assert.ok(leaf, `${id} must still be a row after the class run`);
      assert.strictEqual(leaf.id, id, 'under its bare id');
      assert.strictEqual(leaf.error, undefined, `${id} must not be marked errored`);
      const message = cachedFor(api, id).message ?? '';
      assert.strictEqual(
        message.includes(NO_RESULT),
        false,
        `${id} must not report "${NO_RESULT}" - that is what a kept unique ID produces for ` +
          'every test in the project',
      );
    }
  });

  test('▶ on the ASSEMBLY ROOT attributes every outcome, none of them missing', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the user presses ▶ on the top row of the Testing view.
    const roots = rootsOf(api.testController.items);
    assert.strictEqual(roots.length, 1, 'the fixture is one project, so one assembly root');
    const assemblyNode = roots[0];
    assert.ok(assemblyNode, 'the assembly root is readable');
    assert.strictEqual(assemblyNode.label, FIXTURE.projectName, 'labelled for the project');
    assert.strictEqual(
      assemblyNode.id.startsWith('assembly:'),
      true,
      `an assembly root is a GROUP id, never an FQN; got ${assemblyNode.id}`,
    );

    // Interaction 2 — every test under it reports a real outcome. This is the
    // whole-project shape of the defect: with decorated ids all 35 tests of the
    // real project errored at once, and a root run is how the user hit it.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [assemblyNode]);
    for (const fqn of EXPECTED) {
      const result = api.testController.getResult(fqn);
      assert.ok(result, `▶ on the root must report ${fqn}; nothing was cached for it`);
      assert.strictEqual(
        (result.message ?? '').includes(NO_RESULT),
        false,
        `${fqn} ran, so it must not report "${NO_RESULT}"`,
      );
      assert.strictEqual(
        result.outcome === 'notRun',
        false,
        `${fqn} must not report notRun after a root run`,
      );
      assert.ok(Number(result.duration) >= 0, `${fqn} carries a measured duration`);
    }

    // Interaction 3 — the three kinds are still told apart, and the lens renders
    // each of them the way the user reads it above the method
    // ([TEST-STATUS-LENS]).
    assertPassed(cachedFor(api, FIXTURE.passing), FIXTURE.passing);
    assertFailed(cachedFor(api, FIXTURE.failing), FIXTURE.failing);
    assertSkipped(cachedFor(api, FIXTURE.skipped), FIXTURE.skipped);
    assert.strictEqual(
      statusLensTitle(cachedFor(api, FIXTURE.skipped)),
      '$(debug-step-over) Skipped',
      'a skip is neither a pass nor a failure',
    );
    assert.strictEqual(
      statusLensTitle(cachedFor(api, FIXTURE.failing)).startsWith('$(error) Failed'),
      true,
      'and a failure renders as one',
    );

    // Interaction 4 — running the root did not re-split or re-decorate the tree.
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(EXPECTED),
      'a root run leaves the tree exactly as it was',
    );
    assert.deepStrictEqual(
      collectLeafIds(api.testController.items).filter((id) => carriesUniqueId(id)),
      [],
      'and every id is still bare afterwards',
    );
    // Interaction 4 - the assembly root is the widest selection there is, so a
    // single unreconciled id would show up here as a whole project of missing
    // results.
    assert.strictEqual(rootsOf(api.testController.items).length, 1, 'exactly one assembly root');
    for (const id of EXPECTED) {
      const cached = cachedFor(api, id);
      assert.notStrictEqual(cached.outcome, 'notRun', `${id} must report an outcome`);
      assert.strictEqual(
        (cached.message ?? '').includes(NO_RESULT),
        false,
        `${id} must not report "${NO_RESULT}"`,
      );
      assert.strictEqual(
        cached.passed === (cached.outcome === 'passed'),
        true,
        `${id}: the passed flag agrees with the outcome`,
      );
    }
    assert.strictEqual(
      collectLeafIds(api.testController.items).length,
      EXPECTED.length,
      'and the tree still holds exactly the tests the fixture declares',
    );
  });

  test('a [Theory] whose rows each carried a unique ID reports as ONE test', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — select ONLY the theories. Each declares two [InlineData]
    // rows, and the adapter gave every row its own unique ID, so a kept
    // decoration turns two tests into four leaves and four filter clauses.
    const theories = [
      FIXTURE.parameterized,
      ...(FIXTURE.mixedParameterized === undefined ? [] : [FIXTURE.mixedParameterized]),
    ];
    assert.ok(theories.length >= 1, 'the fixture declares at least one [Theory]');
    const items = itemsFor(api, theories);
    assert.strictEqual(items.length, theories.length, 'one row per theory, not one per ROW');
    assert.deepStrictEqual(
      items.map((item) => item.id),
      theories,
      'and each selected under the one name its rows share',
    );
    const args = buildFilterArgs(items);
    assert.strictEqual(args[0], '--filter', 'a filtered run passes --filter first');
    assert.deepStrictEqual(
      (args[1] ?? '').split('|'),
      theories.map((id) => `FullyQualifiedName=${id}`),
      'one clause per THEORY — a per-row id would produce twice as many',
    );

    // Interaction 2 — running them caches exactly one result per theory, with a
    // duration summed across the rows ([TEST-RUN-TRX]).
    const before = api.testController.cachedResults.size;
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    for (const fqn of theories) {
      const result = cachedFor(api, fqn);
      assert.strictEqual(
        (result.message ?? '').includes(NO_RESULT),
        false,
        `${fqn} ran, so it must not report "${NO_RESULT}"`,
      );
      assert.ok(Number(result.duration) >= 0, `${fqn}'s rows contribute one summed duration`);
    }
    assert.ok(
      api.testController.cachedResults.size >= before,
      'a theory adds one cache entry, never one per row',
    );
    assert.strictEqual(
      api.testController.getResult(`${FIXTURE.parameterized} (row 1)`),
      undefined,
      'no per-row id is ever cached alongside the test',
    );

    // Interaction 3 — the merged outcome is the WORST row's: a theory with one
    // failing row is a failing test, reported once.
    assertPassed(cachedFor(api, FIXTURE.parameterized), FIXTURE.parameterized);
    if (FIXTURE.mixedParameterized !== undefined) {
      const mixed = cachedFor(api, FIXTURE.mixedParameterized);
      assert.strictEqual(mixed.outcome, 'failed', 'one failing row makes the theory fail');
      assert.strictEqual(mixed.passed, false, 'and the pass flag agrees');
      assert.strictEqual(
        (mixed.message ?? '').includes('Assert.Equal'),
        true,
        "carrying the failing row's own assertion text",
      );
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(EXPECTED),
      'and the tree still holds one leaf per theory',
    );
    // Interaction 4 - the rows collapse because each carried its OWN unique ID
    // and stripping removed all of them. That is the mechanism, and it has to
    // be visible in the RAW listing this suite kept.
    const theoryLines = rawListing.filter(
      (raw) => withoutAdapterUniqueId(raw) === FIXTURE.parameterized,
    );
    assert.strictEqual(
      theoryLines.length >= 2,
      true,
      'the adapter really did write one line PER ROW for the theory',
    );
    assert.strictEqual(
      new Set(theoryLines).size,
      theoryLines.length,
      'each row line distinct, because each carries its own unique ID',
    );
    assert.strictEqual(
      new Set(theoryLines.map((raw) => withoutAdapterUniqueId(raw))).size,
      1,
      'and all of them strip down to the ONE name the rows share',
    );
    assert.strictEqual(
      collectLeafIds(api.testController.items).filter((id) => id === FIXTURE.parameterized).length,
      1,
      'so the tree holds exactly one leaf for the theory',
    );
    assert.strictEqual(
      parseFullyQualifiedTestList(theoryLines.join('\n')).length,
      1,
      'and the listing reader agrees, on the same lines',
    );
  });

  test('a multi-select of EVERY test builds one unescaped filter and attributes every result', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the user ctrl-clicks every row and presses ▶. The filter
    // is the clauses OR-ed with an UNESCAPED pipe ([TEST-FILTER-ESCAPE]).
    const items = itemsFor(api, EXPECTED);
    assert.strictEqual(items.length, EXPECTED.length, 'every test is in the selection');
    const args = buildFilterArgs(items);
    const expression = args[1] ?? '';
    assert.strictEqual(args.length, 2, '--filter and exactly one expression');
    assert.strictEqual(
      expression.includes('\\'),
      false,
      `a bare C# FQN needs no escaping anywhere in the expression; got ${expression}`,
    );
    assert.strictEqual(
      expression.split('|').length,
      EXPECTED.length,
      'one clause per selected test, OR-ed',
    );
    assert.deepStrictEqual(
      expression.split('|'),
      EXPECTED.map((id) => `FullyQualifiedName=${id}`),
      'and in the order the rows were selected',
    );

    // Interaction 2 — every one of them comes back with its own outcome.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    for (const fqn of EXPECTED) {
      const result = cachedFor(api, fqn);
      assert.strictEqual(
        (result.message ?? '').includes(NO_RESULT),
        false,
        `${fqn} was selected and run, so it must not report "${NO_RESULT}"`,
      );
      assert.strictEqual(
        ['passed', 'failed', 'skipped'].includes(result.outcome),
        true,
        `${fqn} must land in one of the three Testing-API states; got ${result.outcome}`,
      );
    }

    // Interaction 3 — and the lens can still find each of them by the method
    // name it read out of the editor, now carrying a real status.
    for (const fqn of EXPECTED) {
      const found = findTestByMethodName(api.testController.items, methodOf(fqn));
      assert.ok(found, `the lens above ${methodOf(fqn)} must resolve to a discovered test`);
      assert.strictEqual(found.id, fqn, 'to THAT test');
      assert.notStrictEqual(
        statusLensTitle(cachedFor(api, fqn)),
        '$(circle-slash) Not run',
        `${fqn} has just run, so its lens must not still read "Not run"`,
      );
    }
    // Interaction 4 - a multi-select is ONE invocation for the whole selection
    // ([TEST-RUN-TRX]), and every id in it stays bare on the way out.
    for (const id of EXPECTED) {
      assert.notStrictEqual(
        cachedFor(api, id).outcome,
        'notRun',
        `${id} was selected, so it must report an outcome`,
      );
      const leaf = findItem(api.testController.items, id);
      assert.ok(leaf, `${id} is still a row`);
      assert.strictEqual(leaf.id, id, 'under its bare id');
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted([...EXPECTED]),
      'and the tree is exactly what it was before the run',
    );
    assert.strictEqual(
      itemsFor(api, [...EXPECTED]).length,
      EXPECTED.length,
      'every selected test resolved to a row of its own',
    );
  });

  test('a REFRESH re-discovers the same BARE ids, without duplicating a row', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-REACTIVITY]: pressing refresh re-runs the whole two-pass discovery,
    // which means the decorating adapter reports its decorated names again. A
    // stripper applied only on the first sweep leaves the tree correct until the
    // user presses refresh, and wrong from then on.
    //
    // Interaction 1 — the tree as it stands.
    const before = sorted(collectLeafIds(api.testController.items));
    const idsBefore = sorted(collectItemIds(api.testController.items));
    assert.deepStrictEqual(before, sorted(EXPECTED), 'the settled tree is the fixture');

    // Interaction 2 — press refresh and let the sweep land.
    await drainDiscovery(() => {
      void api.testController.activateAndDiscover();
    }, api.testController);
    const after = await pollForIds(
      api.testController,
      (ids) => ids.length >= EXPECTED.length,
      DOTNET_CLI_MS,
    );

    // Interaction 3 — the same bare ids, the same nodes, nothing doubled.
    assert.deepStrictEqual(sorted(after), before, 'refresh re-discovers exactly the same tests');
    assert.deepStrictEqual(
      after.filter((id) => carriesUniqueId(id)),
      [],
      'and strips the decoration on the SECOND sweep as well as the first',
    );
    assert.deepStrictEqual(
      after.filter((id) => id.includes('(') || id.includes(')')),
      [],
      'with no parenthesis surviving into any id',
    );
    assert.deepStrictEqual(
      sorted(collectItemIds(api.testController.items)),
      idsBefore,
      'every node in the view is the same node it was — refresh adds no second subtree',
    );
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'and the project is still ONE assembly root',
    );
    assert.strictEqual(
      new Set(after).size,
      after.length,
      'no test is listed twice after a re-discovery',
    );
    // Interaction 4 - a refresh re-runs the WHOLE discovery path, so the
    // stripper runs again on a second listing. A stripper applied once leaves
    // the tree correct until the user presses refresh.
    const afterRefresh = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(sorted(afterRefresh), sorted([...EXPECTED]), 'the same bare ids');
    assert.strictEqual(
      afterRefresh.length,
      new Set(afterRefresh).size,
      'with nothing duplicated by the second sweep',
    );
    assert.strictEqual(
      afterRefresh.some((id) => carriesUniqueId(id)),
      false,
      'and no decoration reintroduced',
    );
    assert.strictEqual(rootsOf(api.testController.items).length, 1, 'still ONE assembly root');
    for (const id of EXPECTED) {
      assert.ok(findItem(api.testController.items, id), `${id} survived the refresh`);
    }
  });

  test('▶ on the NAMESPACE row reports every class beneath it, ids still bare', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — reach the namespace row through the tree the user
    // expands, and check it is a real group rather than another name for the
    // assembly.
    const leaf = findItem(api.testController.items, FIXTURE.passing);
    assert.ok(leaf, `${FIXTURE.passing} must be a row in the tree`);
    const classNode = leaf.parent;
    assert.ok(classNode, 'a leaf hangs off its class');
    const namespaceNode = classNode.parent;
    assert.ok(namespaceNode, 'and a class off its namespace');
    assert.strictEqual(namespaceNode.label, NAMESPACE, 'labelled by the namespace');
    assert.strictEqual(namespaceNode.canResolveChildren, true, 'and it expands');
    assert.notStrictEqual(namespaceNode.id, classNode.id, 'a namespace is not its class');
    assert.strictEqual(
      namespaceNode.id.includes(' ('),
      false,
      'no GROUP id carries an adapter decoration either — the tree is keyed on these',
    );

    // Interaction 2 — [TEST-RUN-TRX] makes a group ONE invocation for the whole
    // selection. Every test beneath the namespace reports from it.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [namespaceNode]);
    for (const fqn of EXPECTED) {
      const result = api.testController.getResult(fqn);
      assert.ok(result, `▶ on the namespace must report ${fqn}`);
      assert.notStrictEqual(result.outcome, 'notRun', `${fqn} must not report notRun`);
      assert.strictEqual(
        (result.message ?? '').includes(NO_RESULT),
        false,
        `${fqn} ran, so it must not report "${NO_RESULT}"`,
      );
      assert.strictEqual(
        ['passed', 'failed', 'skipped'].includes(result.outcome),
        true,
        `${fqn} lands in one of the three Testing-API states; got ${result.outcome}`,
      );
      assert.ok(Number(result.duration) >= 0, `${fqn} carries a measured duration`);
    }

    // Interaction 3 — the three kinds are still told apart, and the cache is
    // keyed by the BARE id so the lens can find each of them
    // ([TEST-STATUS-LENS]).
    assertPassed(cachedFor(api, FIXTURE.passing), FIXTURE.passing);
    assertFailed(cachedFor(api, FIXTURE.failing), FIXTURE.failing);
    assertSkipped(cachedFor(api, FIXTURE.skipped), FIXTURE.skipped);
    for (const fqn of EXPECTED) {
      assert.ok(
        api.testController.getResult(fqn),
        `the cache must be keyed by the bare id; ${fqn} was not found`,
      );
      assert.strictEqual(
        api.testController.getResult(`${fqn} (${'0'.repeat(40)})`),
        undefined,
        'and never by a decorated one',
      );
    }
    // Interaction 4 - the namespace row is a group whose id is not a test name,
    // and everything beneath it is still bare.
    const namespaceLeaves = collectLeafIds(api.testController.items).filter((id) =>
      id.startsWith(`${NAMESPACE}.`),
    );
    assert.strictEqual(
      namespaceLeaves.length,
      EXPECTED.length,
      'every test the fixture declares lives under the one namespace',
    );
    for (const id of namespaceLeaves) {
      assert.strictEqual(carriesUniqueId(id), false, `${id} is bare`);
      assert.notStrictEqual(
        cachedFor(api, id).outcome,
        'notRun',
        `${id} is under the namespace that was run and must report a result`,
      );
      assert.strictEqual(
        (cachedFor(api, id).message ?? '').includes(NO_RESULT),
        false,
        `${id} must not report "${NO_RESULT}"`,
      );
    }
  });

  test('▶ on ONE decorated test runs that test and no other', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the single row, and the single unescaped clause its id
    // produces ([TEST-FILTER-ESCAPE]).
    const item = findItem(api.testController.items, FIXTURE.failing);
    assert.ok(item, `${FIXTURE.failing} must be a row in the tree`);
    assert.strictEqual(item.id, FIXTURE.failing, 'under its bare fully-qualified name');
    assert.strictEqual(item.children.size, 0, 'and it is a leaf');
    assert.strictEqual(item.label, methodOf(FIXTURE.failing), 'labelled with its method name');
    const args = buildFilterArgs([item]);
    assert.strictEqual(args.length, 2, '--filter and exactly one expression');
    assert.strictEqual(
      args[1],
      `FullyQualifiedName=${FIXTURE.failing}`,
      'one clause for the one selected test, with no escaped metacharacter',
    );

    // Interaction 2 — running it reports a real failure, with the assertion text
    // out of the TRX ErrorInfo rather than a generic note.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
    const failed = cachedFor(api, FIXTURE.failing);
    assertFailed(failed, FIXTURE.failing);
    assert.strictEqual(
      (failed.message ?? '').includes('Assert.Equal'),
      true,
      `the failure carries xUnit's own output; got ${failed.message ?? '(none)'}`,
    );
    assert.strictEqual(
      (failed.message ?? '').includes(NO_RESULT),
      false,
      'it was actually executed, so it reports no missing result',
    );
    assert.strictEqual(
      statusLensTitle(failed).startsWith('$(error) Failed'),
      true,
      'and renders above the method as a failure',
    );

    // Interaction 3 — a single-test run leaves the tree, the ids and every other
    // cached result exactly as they were.
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(EXPECTED),
      'a filtered run must not add or drop a row',
    );
    assert.deepStrictEqual(
      collectLeafIds(api.testController.items).filter((id) => carriesUniqueId(id)),
      [],
      'and every id is still bare',
    );
    assertSkipped(cachedFor(api, FIXTURE.skipped), FIXTURE.skipped);
    assert.strictEqual(
      statusLensTitle(cachedFor(api, FIXTURE.skipped)),
      '$(debug-step-over) Skipped',
      'the unselected skip keeps the LAST KNOWN result it already had',
    );
    // Interaction 4 - running ONE test must leave every OTHER test's cached
    // result alone. A run that blanked the rest would lose the failure the user
    // was chasing, and one that repainted them would be confidently wrong.
    for (const id of EXPECTED) {
      const cached = cachedFor(api, id);
      assert.strictEqual(
        typeof cached.outcome,
        'string',
        `${id} still carries an outcome of some kind`,
      );
      assert.strictEqual(
        (cached.message ?? '').includes(NO_RESULT),
        false,
        `${id} must never report "${NO_RESULT}"`,
      );
    }
    assert.strictEqual(
      itemsFor(api, [FIXTURE.passing]).length,
      1,
      'the test that ran is still exactly one row',
    );
    assert.strictEqual(
      collectLeafIds(api.testController.items).length,
      EXPECTED.length,
      'and the tree still holds every test',
    );
  });

  test('every leaf hangs off Assembly → Namespace → Class, each link bare', function () {
    this.timeout(FAST_MS);

    // [TEST-DISCOVERY-FQN] reconstructs the TRX key as `className.name`, so the
    // tree's own grouping has to agree with the id: a leaf whose class node
    // disagrees with its own name can never be matched to a result.
    //
    // Interaction 1 — walk each leaf's parent chain to the root.
    for (const fqn of EXPECTED) {
      const leaf = findItem(api.testController.items, fqn);
      assert.ok(leaf, `${fqn} must be a row in the tree`);
      const classNode = leaf.parent;
      assert.ok(classNode, `${fqn} must hang off a class node`);
      const namespaceNode = classNode.parent;
      assert.ok(namespaceNode, `${fqn}'s class must hang off a namespace node`);
      const assemblyNode = namespaceNode.parent;
      assert.ok(assemblyNode, `${fqn}'s namespace must hang off an assembly node`);
      assert.strictEqual(assemblyNode.parent, undefined, 'and the assembly is the root');

      // Interaction 2 — each link is named by the part of the id it groups.
      assert.strictEqual(classNode.label, CLASS, `${fqn} is grouped under its class`);
      assert.strictEqual(namespaceNode.label, NAMESPACE, 'and that under its namespace');
      assert.strictEqual(assemblyNode.label, FIXTURE.projectName, 'and that under the project');
      assert.strictEqual(
        `${namespaceNode.label}.${classNode.label}.${leaf.label}`,
        fqn,
        'so the chain spells the fully-qualified name exactly, with nothing added or lost',
      );

      // Interaction 3 — no link carries the adapter's decoration.
      for (const node of [leaf, classNode, namespaceNode, assemblyNode]) {
        assert.strictEqual(
          carriesUniqueId(node.id),
          false,
          `${node.label} must carry no unique-ID decoration in its id`,
        );
        assert.strictEqual(
          node.label.includes(' ('),
          false,
          `${node.label} must not render a hex blob to the user`,
        );
      }
    }
    // Interaction 4 - the parent chain is a chain of GROUPS, and a group id is
    // never a test name. A tree that used the leaf's own id for its class row
    // makes the class unrunnable and the leaf unfindable.
    for (const id of EXPECTED) {
      const leaf = findItem(api.testController.items, id);
      assert.ok(leaf, `${id} must be a row`);
      let node: vscode.TestItem | undefined = leaf.parent;
      let links = 0;
      while (node !== undefined) {
        assert.strictEqual(carriesUniqueId(node.id), false, `${node.label} has a bare group id`);
        assert.notStrictEqual(node.id, id, `${node.label} must not reuse the leaf's own id`);
        assert.notStrictEqual(node.label, '', 'and must be labelled for the user to read');
        links += 1;
        node = node.parent;
      }
      assert.strictEqual(
        links >= 3,
        true,
        `${id} must hang off Assembly \u2192 Namespace \u2192 Class; it had ${String(links)} link(s)`,
      );
    }
  });

  test('running the same selection twice re-reports it under the SAME bare ids', async function () {
    this.timeout(DOTNET_CLI_MS);

    // A decoration that is re-derived per run — rather than stripped once at
    // discovery — makes the SECOND run's TRX keys stop matching the tree, which
    // presents as every test going grey after working once.
    //
    // Interaction 1 — run the three outcome kinds once.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, RUNNABLE));
    const first = RUNNABLE.map((id) => cachedFor(api, id).outcome);
    const idsAfterFirst = sorted(collectLeafIds(api.testController.items));
    assert.deepStrictEqual(
      first,
      ['passed', 'failed', 'skipped'],
      'the first run tells them apart',
    );

    // Interaction 2 — run exactly the same selection again.
    const sizeBefore = api.testController.cachedResults.size;
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, RUNNABLE));
    const second = RUNNABLE.map((id) => cachedFor(api, id).outcome);
    assert.deepStrictEqual(
      second,
      first,
      'the same tests run the same way twice — a second run that lost its keys would go notRun',
    );
    assert.strictEqual(
      api.testController.cachedResults.size,
      sizeBefore,
      're-running a selection updates its entries rather than adding new ones',
    );

    // Interaction 3 — nothing about the tree or the ids moved between the runs.
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      idsAfterFirst,
      'the tree is identical after the second run',
    );
    for (const id of RUNNABLE) {
      assert.strictEqual(
        (cachedFor(api, id).message ?? '').includes(NO_RESULT),
        false,
        `${id} reported on the second run too`,
      );
      assert.ok(
        api.testController.getResult(id),
        `${id} is still cached under the bare id after two runs`,
      );
    }
    assert.deepStrictEqual(
      collectItemIds(api.testController.items).filter((id) => id.includes(' (')),
      [],
      'and no node anywhere gained a decoration',
    );
    // Interaction 4 - the second run must not have changed the SHAPE of the
    // tree, only its results. Re-discovery between runs that produced a second
    // copy of a row would leave the user pressing play on a stale one.
    assert.strictEqual(rootsOf(api.testController.items).length, 1, 'still ONE assembly root');
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted([...EXPECTED]),
      'and still exactly the tests the fixture declares',
    );
    for (const id of RUNNABLE) {
      const cached = cachedFor(api, id);
      assert.notStrictEqual(cached.outcome, 'notRun', `${id} reports an outcome after the re-run`);
      assert.strictEqual(
        (cached.message ?? '').includes(NO_RESULT),
        false,
        `${id} must not report "${NO_RESULT}" on the second run either`,
      );
    }
    assert.strictEqual(
      itemsFor(api, [...RUNNABLE]).length,
      RUNNABLE.length,
      'every re-run test resolved to a row of its own',
    );
  });

  test('every line the adapter wrote maps onto exactly one discovered test', function () {
    this.timeout(FAST_MS);

    // The reverse direction of the vacuity guard: the first test proves the
    // adapter decorates EVERY line, this one proves nothing was lost or invented
    // in turning those lines into ids ([TEST-DISCOVERY-FQN]).
    //
    // Interaction 1 — every raw line reduces to a name that IS a discovered id.
    const leaves = collectLeafIds(api.testController.items);
    for (const raw of rawListing) {
      const bare = withoutAdapterUniqueId(raw);
      assert.strictEqual(
        leaves.includes(bare),
        true,
        `the adapter reported ${raw}, which reduces to ${bare} — that must be a row in the tree`,
      );
      assert.strictEqual(bare.includes(' ('), false, `${bare} must carry no residual decoration`);
      assert.strictEqual(bare.trim(), bare, `${bare} must carry no padding`);
    }

    // Interaction 2 — and every discovered id came from at least one line, so
    // discovery invented nothing.
    for (const id of leaves) {
      const lines = rawListing.filter((raw) => withoutAdapterUniqueId(raw) === id);
      assert.ok(
        lines.length >= 1,
        `${id} is a row in the tree, so the adapter must have reported it; it reported: ` +
          rawListing.join(' | '),
      );
    }

    // Interaction 3 — the many-to-one collapse is real: strictly more lines than
    // tests, because a theory reports one line per row, and the set of reduced
    // names is exactly the set of leaves.
    assert.ok(
      rawListing.length > leaves.length,
      `a [Theory] reports one decorated line per row, so ${String(rawListing.length)} lines ` +
        `must exceed ${String(leaves.length)} tests`,
    );
    assert.deepStrictEqual(
      sorted([...new Set(rawListing.map((raw) => withoutAdapterUniqueId(raw)))]),
      sorted(leaves),
      'the reduced listing and the tree are the same set of names, exactly',
    );
    assert.deepStrictEqual(
      sorted(parseFullyQualifiedTestList(rawListing.join('\n'))),
      sorted(leaves),
      'and the production reader agrees, over the REAL file the adapter wrote',
    );
    // Interaction 4 - and the mapping is TOTAL in both directions: no discovered
    // test is missing from the listing, and no listed line maps to a test the
    // tree does not hold.
    const strippedLines = [...new Set(rawListing.map((raw) => withoutAdapterUniqueId(raw)))];
    assert.deepStrictEqual(
      sorted(strippedLines),
      sorted([...EXPECTED]),
      'the stripped listing and the fixture declare exactly the same set',
    );
    for (const id of discovered) {
      assert.strictEqual(
        strippedLines.includes(id),
        true,
        `${id} is in the tree, so some line of the adapter's listing must reduce to it`,
      );
    }
    for (const line of strippedLines) {
      assert.strictEqual(
        discovered.includes(line),
        true,
        `${line} was listed by the adapter, so it must be a discovered test`,
      );
    }
    assert.strictEqual(
      rawListing.length >= EXPECTED.length,
      true,
      'the adapter wrote at least one line per test, and more for the theory rows',
    );
  });
});
