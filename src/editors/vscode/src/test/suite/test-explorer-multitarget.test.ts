// A MULTI-TARGETED test project is ONE project, and the Testing view must show
// it as ONE assembly root — carrying the UNION of what every framework built.
//
// `dotnet test --list-tests` prints one `Test run for <dll> (<framework>)`
// banner per TARGET FRAMEWORK, so a project declaring two of them announces two
// assembly paths that differ only in their `bin/Debug/<tfm>/` segment, carry the
// same file name, and contribute the same fully-qualified test names. Discovery
// grouped the tree by that PATH, so the same project — same namespaces, same
// classes, same tests — appeared TWICE at the root of the Testing view under two
// indistinguishable labels. FluentValidation's `net8.0;net9.0` test project is
// the shape that surfaced it.
//
// Collapsing them is only half the contract. [TEST-EXPLORER] also requires the
// collapsed group's names to be the UNION of the frameworks' listings, "never
// the first framework's alone — a test compiled behind `#if NET8_0` exists in
// only one assembly, and dropping it would trade a duplicated tree for a missing
// test." A fixture whose frameworks compile IDENTICAL sources cannot tell a
// union from a first-wins pick, so this one compiles a test that exists in each
// framework's assembly and NOT in the other's, and asserts both of them survive
// discovery, filtering and result attribution.
//
// The fixture reads its `<TargetFrameworks>` off the agent's INSTALLED runtimes
// instead of pinning them: a second framework with no runtime never gets a test
// host, so its assembly is never announced and the fixture would quietly degrade
// to a single target — passing vacuously against the very bug this suite exists
// to catch. The first test asserts the announcement really happened twice, and
// the per-assembly listings assert the conditional tests really are exclusive,
// so that degradation fails as itself.
//
// Covers [TEST-DISCOVERY-FQN], [TEST-RUN-TRX] and [TEST-EXPLORER].
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
import {
  buildProjectXml,
  createSolution,
  dotnet,
  installedFrameworkPair,
  warmDiscovery,
  writeProject,
} from './dotnet-project-kit';
import { fixtureFor } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectItemIds,
  collectLeafIds,
  discoverSolution,
  drainDiscovery,
  findItem,
  profileOfKind,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import { removeDirRecursive } from './test-helpers.js';
import { cachedFor, itemsFor, sorted } from './test-explorer-outcome-assertions';
import { DOTNET_CLI_MS, FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The C# xUnit fixture, rebuilt here for TWO target frameworks. */
const CS = fixtureFor('xunit-csharp');

/** The namespace both classes are declared in. */
const NAMESPACE = 'Cs.Xunit.Fixtures';

/** The class holding the tests every framework compiles. */
const SHARED_CLASS = 'CalculatorTests';

/** The class holding the tests only ONE framework compiles. */
const CONDITIONAL_CLASS = 'ConditionalTests';

/** The second source file, holding the `#if`-guarded tests. */
const CONDITIONAL_FILE = 'ConditionalTests.cs';

/** Fully-qualified names EVERY target framework's assembly contains. */
const SHARED: readonly string[] = [
  CS.passing,
  CS.failing,
  CS.skipped,
  CS.parameterized,
  ...(CS.mixedParameterized === undefined ? [] : [CS.mixedParameterized]),
];

/**
 * The compilation symbol the SDK defines implicitly for a target framework.
 *
 * `net10.0` → `NET10_0`. Derived rather than pinned, because the frameworks
 * themselves are read off the agent.
 */
function symbolFor(framework: string): string {
  return framework.toUpperCase().replace(/[.-]/gu, '_');
}

/** The method name of the test only `framework`'s assembly carries. */
function conditionalMethod(framework: string): string {
  return `Only_On_${symbolFor(framework)}`;
}

/** Its fully-qualified name, as the filter and the TRX report key on it. */
function conditionalFqn(framework: string): string {
  return `${NAMESPACE}.${CONDITIONAL_CLASS}.${conditionalMethod(framework)}`;
}

/**
 * A class whose every test is compiled into exactly ONE framework's assembly.
 *
 * This is the shape [TEST-EXPLORER] names: without it, "the union of the
 * frameworks' listings" and "the first framework's listing" are the same list
 * and the rule is untestable.
 */
function conditionalSource(frameworks: readonly string[]): string {
  const guarded = frameworks.flatMap((framework) => [
    `#if ${symbolFor(framework)}`,
    `        [Fact] public void ${conditionalMethod(framework)}() => Assert.Equal(2, 1 + 1);`,
    '#endif',
  ]);
  return [
    'using Xunit;',
    '',
    `namespace ${NAMESPACE}`,
    '{',
    `    public class ${CONDITIONAL_CLASS}`,
    '    {',
    ...guarded,
    '    }',
    '}',
    '',
  ].join('\n');
}

/** The values appearing more than once in `values`, each named once. */
function duplicatesIn(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

suite('Test Explorer — a multi-targeted project is ONE assembly root', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let frameworks: string[];
  let listing: string;
  /** The names each announced assembly reports, keyed by its target framework. */
  let perFramework: Map<string, string[]>;
  /** One conditional test per framework, in the same order as `frameworks`. */
  let conditional: string[];
  /** Every name the merged group must carry: the UNION. */
  let expected: string[];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-multitfm-'));
    frameworks = await installedFrameworkPair(root);
    conditional = frameworks.map((framework) => conditionalFqn(framework));
    expected = [...SHARED, ...conditional];
    const projectDir = writeProject(
      path.join(root, CS.projectName),
      CS.projectFileName,
      buildProjectXml({
        packages: CS.packages,
        properties: { TargetFrameworks: frameworks.join(';') },
      }),
      CS.sourceFileName,
      CS.source,
    );
    // C# globs its sources, so the conditional class needs no project edit.
    fs.writeFileSync(
      path.join(projectDir, CONDITIONAL_FILE),
      conditionalSource(frameworks),
      'utf8',
    );
    const slnPath = await createSolution(root, 'MultiTfm', [projectDir]);

    // Warm the FULL discovery path once (both builds + the adapter JIT). The
    // output is KEPT: the announcement assertion below reads a REAL listing.
    listing = await warmDiscovery(slnPath, root);

    // Ask VSTest what EACH built assembly contains, separately. This is the only
    // way to prove the two listings really differ — and therefore that a merged
    // tree carrying both names is a union rather than a coincidence.
    perFramework = new Map<string, string[]>();
    for (const assembly of parseTestAssemblies(listing)) {
      const framework = path.basename(path.dirname(assembly));
      const listPath = path.join(root, `fqns-${framework}.txt`);
      await dotnet(
        ['vstest', assembly, '--ListFullyQualifiedTests', `--ListTestsTargetPath:${listPath}`],
        root,
      );
      perFramework.set(framework, parseFullyQualifiedTestList(fs.readFileSync(listPath, 'utf8')));
    }

    await discoverSolution(api, slnPath, expected);
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

  test('the fixture really is multi-targeted: one built assembly announced PER framework', function () {
    this.timeout(FAST_MS);
    const assemblies = parseTestAssemblies(listing);
    assert.deepStrictEqual(
      assemblies.map((assembly) => path.basename(path.dirname(assembly))).sort(),
      [...frameworks].sort(),
      `VSTest must announce ${CS.projectFileName} once per target framework, ` +
        `got: ${assemblies.join(' | ') || '(nothing)'}`,
    );
    assert.deepStrictEqual(
      [...new Set(assemblies.map((assembly) => path.basename(assembly)))],
      [`${CS.projectName}.dll`],
      'the announced assemblies differ ONLY in their target-framework directory',
    );

    // Interaction 2 — the fixture is genuinely two-framework, and both really
    // built. A second target with no installed runtime is never announced, and
    // this suite would then assert nothing at all.
    assert.strictEqual(frameworks.length, 2, 'the fixture pins TWO target frameworks');
    assert.strictEqual(
      new Set(frameworks).size,
      2,
      `and two DIFFERENT ones; got ${frameworks.join(';')}`,
    );
    assert.strictEqual(
      assemblies.length,
      2,
      `one banner per target framework: ${assemblies.join(' | ') || '(nothing)'}`,
    );
    assert.strictEqual(
      new Set(assemblies).size,
      2,
      'and they are two DISTINCT paths — the same path twice is one framework announced twice',
    );

    // Interaction 3 — every announced path is a real file [TEST-DISCOVERY-FQN]
    // can hand to `dotnet vstest`. A path that does not resolve silently drops
    // the fully-qualified pass and degrades discovery to DisplayName scraping.
    for (const assembly of assemblies) {
      assert.strictEqual(
        path.isAbsolute(assembly),
        true,
        `${assembly} must be an absolute path, not a banner fragment`,
      );
      assert.strictEqual(fs.existsSync(assembly), true, `${assembly} must exist on disk`);
      assert.strictEqual(
        assembly.includes('%'),
        false,
        `${assembly} must be MSBuild-DECODED before the existence check`,
      );
      assert.strictEqual(assembly.trim(), assembly, `${assembly} must carry no banner padding`);
    }
  });

  test('a test compiled behind #if exists in ONE framework’s assembly and not the other’s', function () {
    this.timeout(FAST_MS);

    // The vacuity guard for the UNION rule. If both assemblies listed the same
    // names, every assertion about "the union, never the first alone" would hold
    // for a first-wins implementation too.
    //
    // Interaction 1 — both assemblies were listed, and both list the SHARED
    // tests. A framework whose listing came back empty proves nothing.
    assert.strictEqual(perFramework.size, 2, 'both built assemblies were listed separately');
    for (const framework of frameworks) {
      const names = perFramework.get(framework);
      assert.ok(names, `${framework}'s assembly must have been listed`);
      assert.deepStrictEqual(
        sorted(names.filter((name) => SHARED.includes(name))),
        sorted(SHARED),
        `${framework} compiles every unconditional test`,
      );
    }

    // Interaction 2 — each framework carries its OWN conditional test…
    for (const framework of frameworks) {
      const names = perFramework.get(framework) ?? [];
      assert.strictEqual(
        names.includes(conditionalFqn(framework)),
        true,
        `${framework} defines ${symbolFor(framework)}, so it compiles ` +
          `${conditionalMethod(framework)}; it listed: ${names.join(' | ')}`,
      );
    }

    // Interaction 3 — …and NOT the other's. This is the asymmetry the union rule
    // exists for.
    for (const framework of frameworks) {
      const names = perFramework.get(framework) ?? [];
      for (const other of frameworks) {
        if (other === framework) continue;
        assert.strictEqual(
          names.includes(conditionalFqn(other)),
          false,
          `${framework} must NOT compile ${conditionalMethod(other)} — it is guarded by ` +
            `#if ${symbolFor(other)}`,
        );
      }
    }

    // Interaction 4 — so neither listing is the whole truth, and neither is a
    // superset of the other.
    const [first, second] = frameworks.map((framework) => perFramework.get(framework) ?? []);
    assert.ok(first !== undefined && second !== undefined, 'two listings to compare');
    assert.notDeepStrictEqual(sorted(first), sorted(second), 'the two listings really differ');
    assert.strictEqual(
      first.length,
      second.length,
      'each framework compiles exactly one conditional test, so the listings are the same SIZE ' +
        'while differing in content — a length check alone would never have caught this',
    );
    assert.deepStrictEqual(
      sorted([...new Set([...first, ...second])]),
      sorted(expected),
      'their union is exactly what the merged tree must carry',
    );
  });

  test('the tree carries ONE root for the project, never one per target framework', function () {
    this.timeout(FAST_MS);
    const roots = rootsOf(api.testController.items);
    const labels = roots.map((item) => item.label);
    assert.deepStrictEqual(
      labels,
      [CS.projectName],
      `a multi-targeted project is ONE assembly root; the Testing view showed: ${
        labels.join(' | ') || '(nothing)'
      }`,
    );

    // Interaction 2 — the single root is an ASSEMBLY group, expandable, and
    // there is exactly one of them anywhere in the tree.
    const assemblyRoot = roots[0];
    assert.ok(assemblyRoot, 'the merged assembly root must exist');
    assert.strictEqual(
      assemblyRoot.id.startsWith('assembly:'),
      true,
      `an assembly root is a GROUP id, never an FQN; got ${assemblyRoot.id}`,
    );
    assert.strictEqual(
      assemblyRoot.canResolveChildren,
      true,
      'the root must declare children so the Testing view offers an expander',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).filter((id) => id.startsWith('assembly:')).length,
      1,
      'ONE assembly group for the project, whatever it is compiled for',
    );
    assert.strictEqual(
      assemblyRoot.id.includes(`${CS.projectName}.dll`),
      true,
      'and it is identified by the project assembly the frameworks share',
    );

    // Interaction 3 — beneath it, the namespace appears ONCE and each class
    // once: the duplication the user saw was a whole subtree repeated, not just
    // a label. The conditional class is there too, merged from both frameworks.
    const namespaces = rootsOf(assemblyRoot.children);
    assert.deepStrictEqual(
      namespaces.map((item) => item.label),
      [NAMESPACE],
      'one namespace node, not one per target framework',
    );
    const namespaceNode = namespaces[0];
    assert.ok(namespaceNode, 'the namespace node must exist under the merged root');
    const classes = rootsOf(namespaceNode.children);
    assert.deepStrictEqual(
      sorted(classes.map((item) => item.label)),
      sorted([SHARED_CLASS, CONDITIONAL_CLASS]),
      'both classes appear under it, each exactly once',
    );
    const conditionalNode = classes.find((item) => item.label === CONDITIONAL_CLASS);
    assert.ok(conditionalNode, 'the conditionally-compiled class is a row in the tree');
    assert.strictEqual(
      conditionalNode.children.size,
      frameworks.length,
      "the conditional class holds ONE test per framework — the union of both assemblies' " +
        "listings, not the first assembly's single test",
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      4 + expected.length,
      'the whole tree is assembly + namespace + two classes + one row per test, nothing doubled',
    );
  });

  test('no test is listed twice — one leaf per fully-qualified name', function () {
    this.timeout(FAST_MS);
    const leaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      duplicatesIn(leaves),
      [],
      `each test appears once whatever it is compiled for; duplicated leaves in: ${leaves.join(', ')}`,
    );
    assert.deepStrictEqual(
      sorted(leaves),
      sorted(expected),
      'the merged root still carries every test the project exposes',
    );

    // Interaction 2 — the merged group's names are the UNION of the frameworks'
    // listings, and each name is the BARE id the filter and the TRX report key
    // on. Taking the first framework's listing alone trades a duplicated tree
    // for a MISSING test, and this is where that shows.
    for (const framework of frameworks) {
      const only = perFramework.get(framework) ?? [];
      assert.notDeepStrictEqual(
        sorted(leaves),
        sorted(only),
        `the tree must not be ${framework}'s listing alone — that drops ` +
          conditionalMethod(frameworks.find((each) => each !== framework) ?? ''),
      );
      for (const name of only) {
        assert.strictEqual(
          leaves.includes(name),
          true,
          `${name} was compiled for ${framework}, so the merged tree must carry it`,
        );
      }
    }
    assert.strictEqual(
      leaves.length,
      expected.length,
      `${String(frameworks.length)} frameworks, one row per test: ${leaves.join(' | ')}`,
    );
    assert.deepStrictEqual(
      leaves.filter((id) => withoutAdapterUniqueId(id) !== id),
      [],
      'no id carries an adapter unique-ID decoration',
    );
    assert.deepStrictEqual(
      leaves.filter((id) => !id.startsWith(`${NAMESPACE}.`)),
      [],
      'every test is fully qualified by the namespace and class it was declared in',
    );

    // Interaction 3 — every node in the view is uniquely addressable, and every
    // test row is labelled with its method name alone.
    const everyId = collectItemIds(api.testController.items);
    assert.deepStrictEqual(
      duplicatesIn(everyId),
      [],
      `VS Code keys the Testing view on ids; duplicates shadow each other: ${everyId.join(' | ')}`,
    );
    for (const id of leaves) {
      const item = findItem(api.testController.items, id);
      assert.ok(item, `${id} must resolve to a row in the tree`);
      assert.strictEqual(item.children.size, 0, `${id} is a test, so it is a LEAF`);
      assert.strictEqual(
        item.label,
        id.slice(id.lastIndexOf('.') + 1),
        `${id} is labelled with its method name alone`,
      );
      assert.strictEqual(item.description, id, `${id} describes itself with its own FQN`);
    }
  });

  test('the merged root RUNS: one outcome per test, however many frameworks built it', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — press the run button on the merged assembly root, exactly
    // as the user does on the top row of the Testing view.
    const roots = rootsOf(api.testController.items);
    const assemblyRoot = roots[0];
    assert.ok(assemblyRoot, 'the merged assembly root must exist to be run');
    assert.strictEqual(roots.length, 1, 'and it is the only root there is');
    const runProfile = profileOfKind(api.testController, vscode.TestRunProfileKind.Run);
    assert.strictEqual(runProfile.isDefault, true, 'Run is the default profile the button uses');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [assemblyRoot]);

    // Interaction 2 — [TEST-RUN-TRX]: every selected test gets a real outcome,
    // reconstructed from `className.name`. A multi-targeted project runs one
    // VSTest session PER FRAMEWORK, so the same fully-qualified name reports
    // twice — and, like a theory's rows, must merge into ONE cached result.
    const passing = cachedFor(api, CS.passing);
    assert.strictEqual(passing.outcome, 'passed', `${CS.passing} passes in the fixture`);
    assert.strictEqual(passing.passed, true, 'and its pass flag agrees');
    assert.strictEqual(passing.message, undefined, 'a pass carries no failure text');
    assert.strictEqual(
      (passing.duration ?? -1) >= 0,
      true,
      'both frameworks contributed to one summed duration',
    );

    const failing = cachedFor(api, CS.failing);
    assert.strictEqual(failing.outcome, 'failed', `${CS.failing} fails in the fixture`);
    assert.strictEqual(
      (failing.message ?? '').includes('Assert.Equal'),
      true,
      `a failure carries the TRX ErrorInfo text; got ${failing.message ?? '(none)'}`,
    );

    const skipped = cachedFor(api, CS.skipped);
    assert.strictEqual(skipped.outcome, 'skipped', 'a skip is neither a pass nor a failure');
    assert.strictEqual(skipped.passed, false, 'and it is certainly not a pass');

    // Interaction 3 — the framework-exclusive tests report too. Each exists in
    // only ONE session's assembly, so the OTHER session's TRX has no entry for
    // it: a reader that demanded an entry in every report would call both of
    // them "No result reported", and one that read only the first report would
    // say it of the second framework's test.
    for (const framework of frameworks) {
      const fqn = conditionalFqn(framework);
      const result = cachedFor(api, fqn);
      assert.strictEqual(
        result.outcome,
        'passed',
        `${fqn} is compiled for ${framework} and passes there`,
      );
      assert.strictEqual(result.passed, true, `${fqn} carries the pass flag`);
      assert.strictEqual(
        (result.message ?? '').includes('No result'),
        false,
        `${fqn} ran under ${framework}, so the framework that did NOT compile it must not ` +
          `make it report a missing result; got ${result.message ?? '(none)'}`,
      );
    }

    // Interaction 4 — nothing was lost to the second framework's TRX file: the
    // auto-named reports are ALL read back, so no test reports "No result".
    const every = itemsFor(api, expected).map((item) => cachedFor(api, item.id));
    assert.strictEqual(
      every.length,
      expected.length,
      'one cached result per test in the merged group',
    );
    assert.deepStrictEqual(
      every.map((result) => result.message ?? '').filter((text) => text.includes('No result')),
      [],
      'a second framework overwriting the first TRX would leave tests with no result at all',
    );
    assert.deepStrictEqual(
      every.filter((result) => result.outcome === 'notRun'),
      [],
      'and none of them may report notRun',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(expected),
      'running the merged root must not re-split the tree or drop a test',
    );
  });

  test('running ONE framework-exclusive test filters to it alone and reports it', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the user presses ▶ on the row for a test that only one of
    // the two assemblies contains. Its id is a bare FQN needing no escaping, so
    // the filter is the plain clause ([TEST-FILTER-ESCAPE]).
    const framework = frameworks[0];
    assert.ok(framework, 'the fixture declares a first framework');
    const other = frameworks[1];
    assert.ok(other, 'and a second');
    const fqn = conditionalFqn(framework);
    const item = findItem(api.testController.items, fqn);
    assert.ok(item, `${fqn} must be a row in the tree even though only ${framework} built it`);
    assert.strictEqual(item.id, fqn, 'under its bare fully-qualified name');
    assert.strictEqual(
      filterClause(fqn),
      `FullyQualifiedName=${fqn}`,
      'the clause is the plain name — nothing about a conditional test needs escaping',
    );
    const args = buildFilterArgs([item]);
    assert.strictEqual(args[0], '--filter', 'a filtered run passes --filter first');
    assert.strictEqual(
      args[1],
      `FullyQualifiedName=${fqn}`,
      'and exactly one clause for the one selected test',
    );

    // Interaction 2 — it runs, under the framework that has it, and reports a
    // real outcome. The session for the OTHER framework matches nothing at all:
    // [TEST-FILTER-ESCAPE] calls that VSTest's `outcome="Warning"` case, and it
    // must not be mistaken for the adapter refusing the filter.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
    const result = cachedFor(api, fqn);
    assert.strictEqual(result.outcome, 'passed', `${fqn} passes under ${framework}`);
    assert.strictEqual(result.passed, true, 'with the pass flag set');
    assert.strictEqual(
      (result.message ?? '').includes('No result'),
      false,
      `${other} matched no test for this filter, which is not the same as ${fqn} having no ` +
        `result; got ${result.message ?? '(none)'}`,
    );
    assert.strictEqual((result.duration ?? -1) >= 0, true, 'and a measured duration');

    // Interaction 3 — the selection really was one test: the tree stands, and
    // the other framework's exclusive test is still a row of its own.
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(expected),
      'a single-test run leaves the merged tree exactly as it was',
    );
    const sibling = findItem(api.testController.items, conditionalFqn(other));
    assert.ok(sibling, `${conditionalFqn(other)} is still a row after running its counterpart`);
    assert.strictEqual(sibling.children.size, 0, 'and still a leaf');
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'and the project is still ONE assembly root',
    );
  });
});
