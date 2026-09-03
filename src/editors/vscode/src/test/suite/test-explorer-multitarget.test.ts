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
    // Interaction 3 - the two announced assemblies really are the SAME project
    // built twice. Same file name, different `bin/Debug/<tfm>/` segment: that
    // is precisely the shape discovery used to group apart.
    const announced = parseTestAssemblies(listing);
    assert.strictEqual(announced.length, frameworks.length, 'one assembly per target framework');
    assert.strictEqual(
      new Set(announced.map((assembly) => path.basename(assembly))).size,
      1,
      'both assemblies carry the SAME file name - which is why a path-keyed tree showed the ' +
        'project twice under two indistinguishable labels',
    );
    assert.strictEqual(
      new Set(announced.map((assembly) => path.dirname(assembly))).size,
      frameworks.length,
      'and sit in different directories, one per framework',
    );
    for (const framework of frameworks) {
      assert.ok(
        announced.some((assembly) => path.basename(path.dirname(assembly)) === framework),
        `${framework} must have contributed an announced assembly of its own`,
      );
      assert.ok(
        listing.includes(framework),
        `the raw listing must name ${framework}; without a runtime for it the fixture ` +
          'degrades to a single target and this whole suite passes vacuously',
      );
    }
    assert.strictEqual(
      new Set(frameworks).size,
      frameworks.length,
      'the two target frameworks are genuinely different',
    );
    assert.strictEqual(
      listing.includes('Test run for '),
      true,
      'the raw listing carries the banners this all rests on',
    );
    assert.strictEqual(
      perFramework.size,
      frameworks.length,
      'one per-framework listing per announced assembly',
    );
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
    // Interaction 3 - the two listings differ, and neither contains the other.
    // That is what makes "the UNION of the frameworks' listings" a claim a
    // first-wins implementation can fail.
    const listings = [...perFramework.values()];
    assert.strictEqual(listings.length, frameworks.length, 'one listing per framework');
    const [tfmOne, tfmTwo] = listings;
    assert.ok(tfmOne && tfmTwo, 'both frameworks produced a listing');
    assert.notDeepStrictEqual(
      sorted(tfmOne),
      sorted(tfmTwo),
      'the two assemblies must NOT contain the same tests, or union and first-wins are the ' +
        'same list and the rule is untestable',
    );
    assert.strictEqual(
      tfmOne.every((name) => tfmTwo.includes(name)),
      false,
      'neither listing is a subset of the other',
    );
    assert.strictEqual(
      tfmTwo.every((name) => tfmOne.includes(name)),
      false,
      'in either direction',
    );
    for (const shared of SHARED) {
      assert.ok(tfmOne.includes(shared), `${shared} is compiled into the first assembly`);
      assert.ok(tfmTwo.includes(shared), 'and into the second');
    }
    assert.strictEqual(
      new Set([...tfmOne, ...tfmTwo]).size,
      expected.length,
      'and the union of the two listings is exactly what the merged root must carry',
    );
    assert.strictEqual(
      conditional.length,
      frameworks.length,
      'one framework-exclusive test per framework',
    );
    assert.strictEqual(
      expected.length,
      SHARED.length + conditional.length,
      'and the union is the shared set plus them',
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
    // Interaction 3 - the single root is a GROUP, and what hangs off it is the
    // project's own tree, not two copies of it.
    const settled = rootsOf(api.testController.items);
    assert.strictEqual(settled.length, 1, 'exactly one root for the whole solution');
    const only = settled[0];
    assert.ok(only, 'and it exists');
    assert.strictEqual(only.canResolveChildren, true, 'a root declares children, so it expands');
    assert.strictEqual(only.children.size >= 1, true, 'and really holds some');
    assert.strictEqual(
      collectLeafIds(only.children).length,
      expected.length,
      'every test of BOTH frameworks hangs off the one root',
    );
    assert.strictEqual(
      rootsOf(only.children).some((child) => child.label === only.label),
      false,
      'and the root does not contain a second copy of itself',
    );
    for (const framework of frameworks) {
      assert.strictEqual(
        only.id.includes(framework),
        false,
        `the merged root id must not be keyed on ${framework}; a per-framework id is exactly ` +
          'what produced two indistinguishable roots',
      );
    }
    assert.strictEqual(
      collectItemIds(api.testController.items).length >= expected.length,
      true,
      'the tree holds at least one node per test',
    );
    assert.deepStrictEqual(
      duplicatesIn(rootsOf(api.testController.items).map((item) => item.label)),
      [],
      'and no two roots share a label',
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
    // Interaction 3 - and every id is BARE. A tree that de-duplicated by
    // appending a framework segment, or that kept an adapter decoration, has
    // ids no `--filter FullyQualifiedName=` will ever match.
    const mergedLeaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(duplicatesIn(mergedLeaves), [], 'no fully-qualified name appears twice');
    assert.deepStrictEqual(sorted(mergedLeaves), sorted(expected), 'the union, exactly');
    for (const id of mergedLeaves) {
      assert.strictEqual(withoutAdapterUniqueId(id), id, `${id} carries no adapter decoration`);
      assert.strictEqual(id.trim(), id, `${id} carries no padding`);
      for (const framework of frameworks) {
        assert.strictEqual(
          id.endsWith(framework),
          false,
          `${id} must not be suffixed with ${framework} - the id is the FQN and nothing else`,
        );
      }
    }
    assert.strictEqual(
      collectItemIds(api.testController.items).length > mergedLeaves.length,
      true,
      'and the group rows above them are ids of their own, so the tree really is a hierarchy',
    );
    assert.strictEqual(
      itemsFor(api, expected).length,
      expected.length,
      'every name resolves to a row of its own',
    );
    assert.deepStrictEqual(
      duplicatesIn(collectLeafIds(api.testController.items)),
      [],
      'with nothing listed twice',
    );
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
    // Interaction 4 - one cached result per test, and not one of them left
    // unreported. [TEST-RUN-TRX]: "A selected test with no TRX entry is
    // reported as errored... It is never silently reported as a pass."
    for (const id of expected) {
      const cached = cachedFor(api, id);
      assert.notStrictEqual(
        cached.outcome,
        'notRun',
        `${id} was in the selection, so the merged run must report an outcome for it`,
      );
      assert.strictEqual(
        ['passed', 'failed', 'skipped'].includes(cached.outcome),
        true,
        `${id} must carry one of the three Testing-API outcomes`,
      );
      assert.strictEqual(
        cached.passed === (cached.outcome === 'passed'),
        true,
        `${id}: the passed flag must agree with the outcome - a SKIP is not a pass`,
      );
    }
    assert.strictEqual(
      itemsFor(api, expected).length,
      expected.length,
      'and every one of them is still a row in the tree afterwards',
    );
    assert.strictEqual(rootsOf(api.testController.items).length, 1, 'the merged run left ONE root');
    assert.strictEqual(
      collectLeafIds(api.testController.items).length,
      expected.length,
      'holding the whole union',
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
    // Interaction 4 - the filter that reached the CLI. [TEST-FILTER-ESCAPE]
    // makes a single selection a single clause, and the framework-exclusive
    // name is an ordinary identifier that needs no escaping at all.
    const exclusive = conditional[0] ?? '';
    assert.notStrictEqual(exclusive, '', 'the fixture declares a framework-exclusive test');
    assert.strictEqual(
      filterClause(exclusive),
      `FullyQualifiedName=${exclusive}`,
      'one selected test is one clause, with nothing to escape in it',
    );
    assert.deepStrictEqual(
      buildFilterArgs([{ id: exclusive }]),
      ['--filter', `FullyQualifiedName=${exclusive}`],
      'and one --filter argument, never one per framework',
    );
    assert.strictEqual(
      exclusive.startsWith(`${NAMESPACE}.${CONDITIONAL_CLASS}.`),
      true,
      'the exclusive test lives in the conditional class',
    );
    assert.strictEqual(
      exclusive.includes(symbolFor(frameworks[0] ?? '')),
      true,
      'and its method name names the framework whose assembly compiled it',
    );
    assert.notStrictEqual(
      cachedFor(api, exclusive).outcome,
      'notRun',
      'a test that exists in only ONE of the two assemblies must still report a result',
    );
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'a single-test run leaves ONE root',
    );
    assert.strictEqual(
      itemsFor(api, expected).length,
      expected.length,
      'and every other test still a row',
    );
  });

  test('a SHARED test runs under BOTH frameworks and merges into ONE cached result', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-RUN-TRX]: "A data-driven test writes one TRX entry PER ROW under the
    // SAME fully-qualified name. The merged outcome is the WORST row's, and the
    // durations sum." A multi-targeted project produces the same shape for a
    // PLAIN test: one VSTest session per framework, so a test compiled into both
    // assemblies reports twice under one name. Keeping the last entry seen is
    // the same defect either way.
    //
    // Interaction 1 — select one test that both frameworks compiled.
    const item = findItem(api.testController.items, CS.passing);
    assert.ok(item, `${CS.passing} must be a row in the merged tree`);
    assert.strictEqual(item.id, CS.passing, 'under its bare fully-qualified name');
    assert.strictEqual(item.children.size, 0, 'and it is a leaf');
    for (const framework of frameworks) {
      assert.strictEqual(
        (perFramework.get(framework) ?? []).includes(CS.passing),
        true,
        `${framework} compiled ${CS.passing}, so this run reports it twice`,
      );
    }

    // Interaction 2 — running it caches exactly ONE result, not one per
    // framework, and the tree grows no second row for it.
    const idsBefore = sorted(collectLeafIds(api.testController.items));
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
    const result = cachedFor(api, CS.passing);
    assert.strictEqual(result.outcome, 'passed', 'it passes under every framework that built it');
    assert.strictEqual(result.passed, true, 'with the pass flag set');
    assert.strictEqual(result.message, undefined, 'a pass carries no failure text');
    assert.strictEqual(
      (result.duration ?? -1) >= 0,
      true,
      'and one duration summed across both sessions',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      idsBefore,
      'two sessions reporting one name must not split it into two rows',
    );

    // Interaction 3 — the same for a test that FAILS under both, whose two
    // reports must merge to the one failure with real assertion text.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [CS.failing]),
    );
    const failed = cachedFor(api, CS.failing);
    assert.strictEqual(failed.outcome, 'failed', 'a red test is red under both frameworks');
    assert.strictEqual(failed.passed, false, 'and never flips to a pass');
    assert.strictEqual(
      (failed.message ?? '').includes('Assert.Equal'),
      true,
      `the merged failure keeps the TRX ErrorInfo text; got ${failed.message ?? '(none)'}`,
    );
    assert.strictEqual(
      (failed.message ?? '').includes('No result'),
      false,
      'the second session did report it, so nothing is missing',
    );
    // Interaction 4 - a shared test is compiled into BOTH assemblies, so the
    // run produces TWO TRX entries under one name. [TEST-RUN-TRX] merges them
    // to the WORST outcome with the durations SUMMED; keeping the last row seen
    // would report a green tree for a test that failed under one framework.
    for (const shared of SHARED) {
      const both = [...perFramework.values()].filter((names) => names.includes(shared));
      assert.strictEqual(
        both.length,
        frameworks.length,
        `${shared} must be compiled into every framework's assembly`,
      );
      const cached = cachedFor(api, shared);
      assert.notStrictEqual(cached.outcome, 'notRun', `${shared} must carry a merged result`);
      assert.strictEqual(
        itemsFor(api, [shared]).length,
        1,
        `${shared} must be ONE row, however many assemblies ran it`,
      );
    }
    assert.strictEqual(
      collectLeafIds(api.testController.items).filter((id) => id === CS.passing).length,
      1,
      'the shared passing test appears exactly once in the whole tree',
    );
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'still ONE root after the shared-test run',
    );
    assert.strictEqual(
      collectLeafIds(api.testController.items).length,
      expected.length,
      'holding the whole union',
    );
  });

  test('the CLASS row of the conditional class runs BOTH framework-exclusive tests at once', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — reach the class the user right-clicks. Its children are
    // the UNION: one test per framework, neither of which exists in the other's
    // assembly ([TEST-EXPLORER]).
    const leaf = findItem(api.testController.items, conditional[0] ?? '');
    assert.ok(leaf, 'a conditional test must be a row in the tree');
    const classNode = leaf.parent;
    assert.ok(classNode, 'a leaf hangs off the class group it belongs to');
    assert.strictEqual(classNode.label, CONDITIONAL_CLASS, 'and that parent is the class node');
    assert.strictEqual(
      classNode.children.size,
      frameworks.length,
      'the class row holds one test per framework — the union, not the first listing',
    );
    assert.strictEqual(classNode.canResolveChildren, true, 'and it expands');
    assert.deepStrictEqual(
      sorted(rootsOf(classNode.children).map((child) => child.id)),
      sorted(conditional),
      'and its children are exactly the framework-exclusive tests',
    );

    // Interaction 2 — [TEST-RUN-TRX] makes a class ONE invocation for the whole
    // selection. Both exclusive tests report from it, each out of the session
    // for the framework that actually has it.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [classNode]);
    for (const fqn of conditional) {
      const result = cachedFor(api, fqn);
      assert.notStrictEqual(
        result.outcome,
        'notRun',
        `${fqn} must never be reported notRun — one session did run it`,
      );
      assert.strictEqual(
        (result.message ?? '').includes('No result'),
        false,
        `the framework that did NOT compile ${fqn} must not make it report a missing result`,
      );
      assert.strictEqual(result.outcome, 'passed', `${fqn} passes where it exists`);
      assert.strictEqual(result.passed, true, `${fqn} carries the pass flag`);
      assert.ok(Number(result.duration) >= 0, `${fqn} carries a measured duration`);
    }

    // Interaction 3 — running the class did not drag in the OTHER class, and
    // left the tree merged.
    assert.strictEqual(
      classNode.children.size,
      frameworks.length,
      'the class row keeps its children after running',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(expected),
      'and the merged tree is unchanged',
    );
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'still ONE assembly root after a class-level run',
    );
    // Interaction 4 - the conditional CLASS is one row holding one test per
    // framework, and running it reaches both. A class row that only ever ran
    // the first framework's test is the union bug wearing a group label.
    for (const fqn of conditional) {
      assert.notStrictEqual(
        cachedFor(api, fqn).outcome,
        'notRun',
        `${fqn} must report a result when its CLASS row is run`,
      );
      assert.strictEqual(
        fqn.startsWith(`${NAMESPACE}.${CONDITIONAL_CLASS}.`),
        true,
        `${fqn} belongs to the conditional class`,
      );
      assert.strictEqual(
        itemsFor(api, [fqn]).length,
        1,
        `${fqn} is one row, addressed by its own name`,
      );
    }
    assert.strictEqual(
      conditional.length,
      frameworks.length,
      'one framework-exclusive test per framework, and no more',
    );
    assert.strictEqual(
      new Set(conditional).size,
      conditional.length,
      'each of them under a DIFFERENT name, or the exclusivity is not observable',
    );
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'a class-row run leaves ONE root',
    );
    assert.strictEqual(
      itemsFor(api, conditional).length,
      conditional.length,
      'and both exclusive tests still rows',
    );
  });

  test('a multi-select spanning BOTH frameworks OR-s two unescaped clauses', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-FILTER-ESCAPE]: "Multiple selected tests are OR'd with an UNESCAPED
    // `|` between escaped clauses." Neither conditional name contains a
    // metacharacter, so neither clause may carry a backslash.
    //
    // Interaction 1 — the argument vector for the two exclusive tests.
    const items = itemsFor(api, conditional);
    assert.strictEqual(items.length, frameworks.length, 'one row selected per framework');
    const args = buildFilterArgs(items);
    assert.strictEqual(args.length, 2, '--filter and exactly one expression');
    assert.strictEqual(args[0], '--filter', 'a filtered run passes --filter first');
    const expression = args[1] ?? '';
    assert.strictEqual(
      expression.includes('\\'),
      false,
      `a bare C# FQN needs no escaping anywhere; got ${expression}`,
    );
    assert.deepStrictEqual(
      expression.split('|'),
      conditional.map((fqn) => `FullyQualifiedName=${fqn}`),
      'the clauses are OR-ed, one per selected test, in selection order',
    );
    for (const fqn of conditional) {
      assert.strictEqual(
        filterClause(fqn),
        `FullyQualifiedName=${fqn}`,
        `${fqn} needs no escaping — anything escaped here is not part of the name`,
      );
    }

    // Interaction 2 — running that selection reports BOTH, even though each
    // clause matches in only one of the two sessions.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    for (const fqn of conditional) {
      const result = cachedFor(api, fqn);
      assert.strictEqual(result.outcome, 'passed', `${fqn} reports a real outcome`);
      assert.strictEqual(
        (result.message ?? '').includes('No result'),
        false,
        `${fqn} matched in the session that has it, so nothing is missing`,
      );
      assert.ok(Number(result.duration) >= 0, `${fqn} carries a measured duration`);
    }

    // Interaction 3 — a clause matching NOTHING in one session is VSTest's
    // `outcome="Warning"` case, which [TEST-FILTER-ESCAPE] distinguishes from an
    // adapter REFUSING the filter. Neither test may be reported as an error.
    for (const fqn of conditional) {
      const result = cachedFor(api, fqn);
      assert.strictEqual(result.outcome === 'failed', false, `${fqn} did not fail`);
      assert.strictEqual(
        (result.message ?? '').includes('Unexpected Word'),
        false,
        'no adapter refused this filter — a space-free C# name is always parseable',
      );
    }
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(expected),
      'and the tree stands',
    );
    // Interaction 4 - the expression a cross-framework multi-select produces.
    // [TEST-FILTER-ESCAPE]: escaped clauses, OR-ed with an UNESCAPED pipe, in
    // ONE --filter argument for the whole selection.
    const both = conditional.map((id) => ({ id }));
    const orArgs = buildFilterArgs(both);
    assert.strictEqual(orArgs.length, 2, 'one --filter flag and one expression');
    assert.strictEqual(orArgs[0], '--filter', 'the flag comes first');
    assert.strictEqual(
      orArgs[1],
      conditional.map((id) => `FullyQualifiedName=${id}`).join('|'),
      'two selected tests are OR-ed with an unescaped pipe, in selection order',
    );
    assert.strictEqual(
      (orArgs[1] ?? '').split('FullyQualifiedName=').length - 1,
      conditional.length,
      'one clause per selected test',
    );
    for (const fqn of conditional) {
      assert.notStrictEqual(
        cachedFor(api, fqn).outcome,
        'notRun',
        `${fqn} was selected, so it must report a result`,
      );
    }
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'a cross-framework selection leaves ONE root',
    );
    assert.strictEqual(
      collectLeafIds(api.testController.items).length,
      expected.length,
      'holding the whole union',
    );
  });

  test('the NAMESPACE row runs every class under it, across both frameworks', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — the fixture declares ONE namespace holding TWO classes,
    // so the namespace row is a real superset of either class row.
    const roots = rootsOf(api.testController.items);
    const assemblyRoot = roots[0];
    assert.ok(assemblyRoot, 'the merged assembly root exists');
    const namespaces = rootsOf(assemblyRoot.children);
    assert.strictEqual(namespaces.length, 1, 'one namespace under the merged root');
    const namespaceNode = namespaces[0];
    assert.ok(namespaceNode, 'the namespace node is readable');
    assert.strictEqual(namespaceNode.label, NAMESPACE, 'labelled by the namespace');
    assert.strictEqual(
      rootsOf(namespaceNode.children).length,
      2,
      'holding both the shared class and the conditional one',
    );

    // Interaction 2 — running it reports every test in the merged group, shared
    // and exclusive alike.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [namespaceNode]);
    for (const fqn of expected) {
      const result = api.testController.getResult(fqn);
      assert.ok(result, `the namespace run must report ${fqn}`);
      assert.strictEqual(
        (result.message ?? '').includes('No result'),
        false,
        `${fqn} ran, so it must not report a missing result`,
      );
      assert.strictEqual(
        ['passed', 'failed', 'skipped'].includes(result.outcome),
        true,
        `${fqn} lands in one of the three Testing-API states; got ${result.outcome}`,
      );
    }

    // Interaction 3 — the three kinds are still told apart, and a skip is never
    // a failure ([TEST-RUN-TRX]).
    assert.strictEqual(cachedFor(api, CS.passing).outcome, 'passed', 'the green test is green');
    assert.strictEqual(cachedFor(api, CS.failing).outcome, 'failed', 'the red one is red');
    assert.strictEqual(cachedFor(api, CS.skipped).outcome, 'skipped', 'and the skip is a skip');
    assert.strictEqual(
      cachedFor(api, CS.skipped).passed,
      false,
      'a skipped test is certainly not a pass',
    );
    assert.strictEqual(
      (cachedFor(api, CS.skipped).message ?? '').includes('Assert'),
      false,
      'and carries no assertion text, because nothing was asserted',
    );
    // Interaction 4 - the namespace row spans BOTH classes and BOTH frameworks,
    // and is still ONE invocation ([TEST-RUN-TRX]).
    const namespaceLeaves = expected.filter((id) => id.startsWith(`${NAMESPACE}.`));
    assert.strictEqual(
      namespaceLeaves.length,
      expected.length,
      'every test the fixture declares lives under the one namespace',
    );
    for (const id of namespaceLeaves) {
      assert.notStrictEqual(
        cachedFor(api, id).outcome,
        'notRun',
        `${id} is under the namespace that was run and must report a result`,
      );
    }
    assert.strictEqual(
      new Set(namespaceLeaves.map((id) => id.slice(0, id.lastIndexOf('.')))).size >= 2,
      true,
      'and the namespace really holds more than one class, or the row proves nothing',
    );
    assert.strictEqual(rootsOf(api.testController.items).length, 1, 'still ONE assembly root');
    assert.strictEqual(
      itemsFor(api, expected).length,
      expected.length,
      'every test is still a row after the namespace run',
    );
    assert.deepStrictEqual(
      duplicatesIn(collectLeafIds(api.testController.items)),
      [],
      'with nothing duplicated',
    );
  });

  test('the [Theory] merges its rows across BOTH frameworks, and the skip stays a skip', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The worst case [TEST-RUN-TRX] describes, doubled: a two-row theory
    // compiled for two frameworks writes FOUR TRX entries under one name. The
    // merged outcome is the worst of the four and the durations sum; keeping the
    // last entry seen reports a green tree for a theory whose second row failed.
    //
    // Interaction 1 — select both theories and the skipped test together.
    const mixed = CS.mixedParameterized ?? '';
    assert.notStrictEqual(mixed, '', 'the xUnit fixture declares a mixed-row theory');
    const selection = [CS.parameterized, mixed, CS.skipped];
    const items = itemsFor(api, selection);
    assert.strictEqual(items.length, selection.length, 'three rows selected');
    assert.deepStrictEqual(
      items.map((item) => item.id),
      selection,
      'each under the one name its rows share',
    );

    // Interaction 2 — the all-passing theory merges to a pass, once.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    const allGreen = cachedFor(api, CS.parameterized);
    assert.strictEqual(allGreen.outcome, 'passed', 'every row passed, so the theory passed');
    assert.strictEqual(allGreen.passed, true, 'with the pass flag');
    assert.strictEqual(allGreen.message, undefined, 'and no failure text');
    assert.ok(Number(allGreen.duration) >= 0, 'carrying the summed duration of four entries');

    // Interaction 3 — the disagreeing theory merges to the WORST row.
    const worst = cachedFor(api, mixed);
    assert.strictEqual(worst.outcome, 'failed', 'one failing row makes the whole theory fail');
    assert.strictEqual(worst.passed, false, 'and the flag agrees');
    assert.strictEqual(
      (worst.message ?? '').includes('Assert.Equal'),
      true,
      "carrying the failing row's own assertion text",
    );
    assert.strictEqual(
      (worst.message ?? '').includes('No result'),
      false,
      'every session reported it, so nothing is missing',
    );

    // Interaction 4 — and the skip is still a skip, in both frameworks.
    const skipped = cachedFor(api, CS.skipped);
    assert.strictEqual(skipped.outcome, 'skipped', 'NotExecuted maps to skipped, not to failed');
    assert.strictEqual(skipped.passed, false, 'a skip is not a pass');
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(expected),
      'and the merged tree still holds one leaf per test',
    );
    // Interaction 4 - a data-driven test writes one TRX entry PER ROW under the
    // SAME name, in EVERY framework's session. [TEST-RUN-TRX] merges them all
    // to the worst row with the durations summed.
    const theory = CS.parameterized;
    assert.strictEqual(
      collectLeafIds(api.testController.items).filter((id) => id === theory).length,
      1,
      'the theory is ONE leaf, however many rows and frameworks ran it',
    );
    const theoryResult = cachedFor(api, theory);
    assert.notStrictEqual(theoryResult.outcome, 'notRun', 'and it reports a merged result');
    assert.strictEqual(
      theoryResult.outcome,
      'passed',
      'every row of this theory passes, so the merged outcome is a pass',
    );
    assert.strictEqual(theoryResult.passed, true, 'and the passed flag agrees');
    const mergedSkip = cachedFor(api, CS.skipped);
    assert.strictEqual(
      mergedSkip.outcome,
      'skipped',
      'a skipped test stays SKIPPED across the merge - [TEST-RUN-TRX] is explicit that it ' +
        'must not be reported as a failure',
    );
    assert.strictEqual(mergedSkip.passed, false, 'and a skip is not a pass either');
    assert.strictEqual(
      rootsOf(api.testController.items).length,
      1,
      'the theory run leaves ONE root',
    );
    assert.strictEqual(
      itemsFor(api, [CS.parameterized]).length,
      1,
      'and the theory is exactly one row',
    );
  });

  test('a REFRESH re-discovers ONE merged root, never a second copy of the project', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-REACTIVITY]: refresh re-runs the whole two-pass discovery, so both
    // frameworks announce their assembly again. A merge applied only on the
    // first sweep leaves the tree correct until the user presses refresh — and
    // duplicated from then on, which is the shape the original defect took.
    //
    // Interaction 1 — the merged tree as it stands.
    const before = sorted(collectLeafIds(api.testController.items));
    const nodesBefore = sorted(collectItemIds(api.testController.items));
    assert.deepStrictEqual(before, sorted(expected), 'the settled tree is the union');
    assert.strictEqual(rootsOf(api.testController.items).length, 1, 'under one root');

    // Interaction 2 — press refresh and let the sweep land.
    await drainDiscovery(() => {
      void api.testController.activateAndDiscover();
    }, api.testController);

    // Interaction 3 — one root, one namespace, two classes, one leaf per test.
    const roots = rootsOf(api.testController.items);
    assert.strictEqual(
      roots.length,
      1,
      `refresh must not add a second assembly root; saw ${roots.map((item) => item.label).join(' | ')}`,
    );
    assert.strictEqual(roots[0]?.label, CS.projectName, 'still labelled for the project');
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      before,
      'refresh re-discovers exactly the same tests',
    );
    assert.deepStrictEqual(
      sorted(collectItemIds(api.testController.items)),
      nodesBefore,
      'and exactly the same nodes — no second subtree under a second label',
    );
    assert.deepStrictEqual(
      duplicatesIn(collectItemIds(api.testController.items)),
      [],
      'with no id shadowing another',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).filter((id) => id.startsWith('assembly:')).length,
      1,
      'ONE assembly group survives a re-discovery',
    );
    for (const framework of frameworks) {
      assert.strictEqual(
        collectLeafIds(api.testController.items).includes(conditionalFqn(framework)),
        true,
        `${conditionalMethod(framework)} must survive the refresh — a second sweep that took ` +
          "the first framework's listing alone would drop it",
      );
    }
    // Interaction 4 - and a refresh leaves the ids themselves untouched. A
    // second sweep that re-derived the group key would produce a second root
    // the first sweep never showed.
    const afterRefresh = rootsOf(api.testController.items);
    assert.strictEqual(afterRefresh.length, 1, 'still exactly ONE root after a refresh');
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(expected),
      'carrying exactly the union it carried before',
    );
    assert.deepStrictEqual(
      duplicatesIn(collectLeafIds(api.testController.items)),
      [],
      'with nothing listed twice',
    );
    const refreshed = afterRefresh[0];
    assert.ok(refreshed, 'the root survived the refresh');
    assert.strictEqual(refreshed.canResolveChildren, true, 'and still declares its children');
    assert.strictEqual(
      collectLeafIds(refreshed.children).length,
      expected.length,
      'all of which are still beneath it',
    );
    assert.strictEqual(
      itemsFor(api, expected).length,
      expected.length,
      'every test resolves after the refresh',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length > expected.length,
      true,
      'and the group rows above them survived too',
    );
  });
});
