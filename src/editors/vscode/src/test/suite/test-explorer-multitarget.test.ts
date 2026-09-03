// A MULTI-TARGETED test project is ONE project, and the Testing view must show
// it as ONE assembly root.
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
// The fixture reads its `<TargetFrameworks>` off the agent's INSTALLED runtimes
// instead of pinning them: a second framework with no runtime never gets a test
// host, so its assembly is never announced and the fixture would quietly degrade
// to a single target — passing vacuously against the very bug this suite exists
// to catch. The first test asserts the announcement really happened twice, so
// that degradation fails as itself.
//
// Covers [TEST-DISCOVERY-FQN] and [TEST-EXPLORER].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { parseTestAssemblies, withoutAdapterUniqueId } from '../../test-discovery.js';
import {
  buildProjectXml,
  createSolution,
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

/** Every fully-qualified name the fixture's single test class exposes. */
const EXPECTED: readonly string[] = [
  CS.passing,
  CS.failing,
  CS.skipped,
  CS.parameterized,
  ...(CS.mixedParameterized === undefined ? [] : [CS.mixedParameterized]),
];

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

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-multitfm-'));
    frameworks = await installedFrameworkPair(root);
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
    const slnPath = await createSolution(root, 'MultiTfm', [projectDir]);

    // Warm the FULL discovery path once (both builds + the adapter JIT). The
    // output is KEPT: the announcement assertion below reads a REAL listing.
    listing = await warmDiscovery(slnPath, root);
    await discoverSolution(api, slnPath, EXPECTED);
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

    // Interaction 3 — beneath it, the namespace and class appear ONCE each: the
    // duplication the user saw was a whole subtree repeated, not just a label.
    const namespaces = rootsOf(assemblyRoot.children);
    assert.deepStrictEqual(
      namespaces.map((item) => item.label),
      ['Cs.Xunit.Fixtures'],
      'one namespace node, not one per target framework',
    );
    const namespaceNode = namespaces[0];
    assert.ok(namespaceNode, 'the namespace node must exist under the merged root');
    const classes = rootsOf(namespaceNode.children);
    assert.deepStrictEqual(
      classes.map((item) => item.label),
      ['CalculatorTests'],
      'one class node under it',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      3 + EXPECTED.length,
      'the whole tree is assembly + namespace + class + one row per test, nothing doubled',
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
      [...leaves].sort(),
      [...EXPECTED].sort(),
      'the merged root still carries every test the project exposes',
    );

    // Interaction 2 — the merged group's names are the UNION of the frameworks'
    // listings, and each name is the BARE id the filter and the TRX report key
    // on. Taking the first framework's listing alone would trade a duplicated
    // tree for a missing test.
    assert.strictEqual(
      leaves.length,
      EXPECTED.length,
      `${String(frameworks.length)} frameworks, one row per test: ${leaves.join(' | ')}`,
    );
    assert.deepStrictEqual(
      leaves.filter((id) => withoutAdapterUniqueId(id) !== id),
      [],
      'no id carries an adapter unique-ID decoration',
    );
    assert.deepStrictEqual(
      leaves.filter((id) => !id.startsWith('Cs.Xunit.Fixtures.CalculatorTests.')),
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

    // Interaction 3 — nothing was lost to the second framework's TRX file: the
    // auto-named reports are ALL read back, so no test reports "No result".
    const every = itemsFor(api, EXPECTED).map((item) => cachedFor(api, item.id));
    assert.strictEqual(
      every.length,
      EXPECTED.length,
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
      sorted(EXPECTED),
      'running the merged root must not re-split the tree or drop a test',
    );
  });
});
