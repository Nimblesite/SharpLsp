// Coarse end-to-end coverage for the Test Explorer discovery pipeline
// (`src/testing.ts` + `src/test-discovery.ts`), driven against REAL on-disk C#
// and F# xUnit projects wired into a REAL solution built with the `dotnet` CLI.
//
// Regression suite for the "No tests have been found in this workspace yet"
// bug: nothing was ever discovered because the controller was wired to neither
// VS Code's refresh trigger nor the loaded solution. F# is first-class here —
// backtick names carry SPACES in their FQN (`Ns.Module.adds two numbers`),
// which the old `^[\w.]+$` filter dropped, so F# could never appear at all.
//
// It drives the SAME public surface the running extension does: the
// `state.solutionPath` signal behind `loadSolution`, the extension-owned
// `TestController`, `dotnet test --list-tests` + `dotnet vstest
// --ListFullyQualifiedTests`, and the parsers reading their output back. Both
// structured fixture files are asserted against a real parse, never a
// substring guess. Covers [TEST-DISCOVERY-FQN].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import type { SharpLspExtensionApi } from '../../extension.js';
import type { SharpLspTestController } from '../../testing.js';
import {
  batchAssemblies,
  isDiscoveredTestLine,
  listTests,
  parseAnnouncedAssemblies,
  parseFullyQualifiedTestList,
  parseTestAssemblies,
  parseTestList,
  withoutAdapterUniqueId,
} from '../../test-discovery.js';
import {
  createSolution,
  dotnet,
  projectXml,
  warmDiscovery,
  writeProject,
} from './dotnet-project-kit';
import { fixtureFor } from './test-explorer-fixtures';
import {
  assertDeclaredInside,
  assertLeafItem,
  collectItemIds,
  drainDiscovery,
  errorTextOf,
  findItem,
  pollForIds,
  pollUntilDiscovered,
  runViaProfile,
  snapshotItems,
  type TestItemSnapshot,
  activateWithScratch,
  teardownFixtureSolution,
  collectLeafIds,
  assertLeavesAre,
  assertPlainLeaf,
  announcedPair,
} from './test-explorer-kit';
import { findTestByMethodName } from '../../test-lens.js';
import {
  comparablePath,
  removeDirRecursive,
  sleep,
  assertContainsAll,
  assertContainsNone,
} from './test-helpers.js';
import { DOTNET_CLI_MS, FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { sorted } from './test-explorer-outcome-assertions';

const CS = fixtureFor('xunit-csharp');
const FS_FIXTURE = fixtureFor('xunit-fsharp');

/** The idiomatic F# backtick binding whose xUnit FQN literally contains spaces. */
const FS_FACT_SPACED = 'Fs.Xunit.Fixtures.adds two numbers with spaces';
/** The theories whose two rows DISAGREE — both report under this one FQN. */
const FS_MIXED_THEORY = 'Fs.Xunit.Fixtures.mixed theory';
const CS_MIXED_THEORY = 'Cs.Xunit.Fixtures.CalculatorTests.Mixed_Theory';

/** EXHAUSTIVELY every FQN the two xUnit fixtures expose: six F# (first), five C#. */
const EXPECTED = [
  FS_FIXTURE.passing,
  FS_FACT_SPACED,
  FS_FIXTURE.failing,
  FS_FIXTURE.skipped,
  FS_FIXTURE.parameterized,
  FS_MIXED_THEORY,
  CS.passing,
  CS.failing,
  CS.skipped,
  CS.parameterized,
  CS_MIXED_THEORY,
] as const;

/** The ONLY names `--list-tests` prints — it prints DISPLAY names, which for an
 * xUnit [Fact] equal the FQN, while a [Theory]'s carries row arguments whose
 * `:` `isDiscoveredTestLine` rejects. Seven facts, neither theory. */
const DISPLAY_NAMES: readonly string[] = [
  FS_FIXTURE.passing,
  FS_FACT_SPACED,
  FS_FIXTURE.failing,
  FS_FIXTURE.skipped,
  CS.passing,
  CS.failing,
  CS.skipped,
];

/** VSTest chatter that must never survive into the tree as a test id. */
const CHATTER = [
  'Passed!',
  'Failed!',
  'Skipped!',
  'Test run for',
  'The following',
  'Duration:',
  ' -> ',
  '(a: 2',
];

/** The exact head `projectXml` serializes, before any ItemGroup. */
const XML_HEAD = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup>',
  '    <TargetFramework>net10.0</TargetFramework>',
  '    <IsPackable>false</IsPackable>',
  '    <EnableMSTestRunner>false</EnableMSTestRunner>',
  '    <TestingPlatformDotnetTestSupport>false</TestingPlatformDotnetTestSupport>',
  '  </PropertyGroup>',
];
/** The exact package ItemGroup and tail `projectXml` serializes for xUnit. */
const XML_PACKAGES = [
  '  <ItemGroup>',
  '    <PackageReference Include="xunit" Version="2.9.2"/>',
  '    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2"/>',
  '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1"/>',
  '  </ItemGroup>',
  '</Project>',
  '',
];

/** The direct child labelled `label`, or `undefined` — one tree level down. */
function childByLabel(
  items: vscode.TestItemCollection,
  label: string,
): vscode.TestItem | undefined {
  let found: vscode.TestItem | undefined;
  items.forEach((item) => {
    if (found === undefined && item.label === label) found = item;
  });
  return found;
}

/**
 * The cached outcomes for `ids`, as one comparable string.
 *
 * [TEST-RUN-TRX] makes a run ONE `dotnet test` invocation for THE SELECTION, so
 * running one group must leave every other group's results exactly as they were
 * — a run that quietly widened to the whole solution reports the same green
 * outcomes and is invisible to any per-test assertion.
 */
function resultSnapshot(controller: SharpLspTestController, ids: readonly string[]): string {
  return JSON.stringify(ids.map((id) => [id, controller.getResult(id) ?? null]));
}

/**
 * Assert every leaf under `group` is a TEST row: a bare fully-qualified id, the
 * method name as its label, the id again as its description, and no children.
 */
function assertLeavesAreTests(group: vscode.TestItem, prefix: string): void {
  const leaves: vscode.TestItem[] = [];
  const walk = (items: vscode.TestItemCollection): void => {
    items.forEach((item) => {
      if (item.children.size === 0) leaves.push(item);
      else walk(item.children);
    });
  };
  walk(group.children);
  assert.notStrictEqual(leaves.length, 0, `${group.label} must hold tests to run`);
  for (const leaf of leaves) {
    assert.ok(
      leaf.id.startsWith(prefix),
      `${leaf.id} sits under ${group.label}, so its FQN must begin with ${prefix}`,
    );
    assert.strictEqual(
      withoutAdapterUniqueId(leaf.id),
      leaf.id,
      `${leaf.id} must be the BARE FullyQualifiedName — an adapter's unique-ID decoration ` +
        'makes the filter match nothing and the TRX report unreconcilable',
    );
    assert.strictEqual(
      leaf.label,
      leaf.id.slice(leaf.id.lastIndexOf('.') + 1),
      `${leaf.id} must be labelled with its method name alone`,
    );
    assert.strictEqual(leaf.description, leaf.id, `${leaf.id} describes itself with its own FQN`);
  }
}

/** The fixture's eleven FQNs as a set, for membership assertions. */
const EXPECTED_SET = new Set<string>(EXPECTED);

/**
 * Assert the settled tree is EXACTLY the fixture's documented hierarchy —
 * Assembly → Namespace → Class → Test — and return the leaf ids. Called by
 * EVERY tree-touching test in this suite, so no regression can localize the
 * hierarchy to a single test's assertions.
 */
function assertHierarchyTree(items: vscode.TestItemCollection): string[] {
  const roots: vscode.TestItem[] = [];
  items.forEach((item) => roots.push(item));
  assert.strictEqual(
    roots.length,
    2,
    `two ASSEMBLY roots — one per test project — got: ${
      roots.map((rootNode) => rootNode.label).join(' | ') || '(nothing)'
    }`,
  );
  assert.deepStrictEqual(
    sorted(roots.map((rootNode) => rootNode.label)),
    sorted([CS.projectName, FS_FIXTURE.projectName]),
    'the roots are the assembly names (XunitCs, XunitFs)',
  );
  const namespaces: string[] = [];
  const classes: string[] = [];
  const leaves: string[] = [];
  for (const rootNode of roots) {
    assert.ok(!EXPECTED_SET.has(rootNode.id), `a root is a group, never an FQN: ${rootNode.id}`);
    assert.ok(
      rootNode.canResolveChildren,
      `an assembly root declares children so the view offers the expander: ${rootNode.label}`,
    );
    rootNode.children.forEach((nsNode) => {
      namespaces.push(nsNode.label);
      assert.ok(nsNode.children.size > 0, `a namespace group is never empty: ${nsNode.label}`);
      assert.ok(nsNode.canResolveChildren, `a namespace node declares children: ${nsNode.label}`);
      assert.ok(
        !EXPECTED_SET.has(nsNode.id),
        `a namespace id is a group id, never an FQN: ${nsNode.id}`,
      );
      nsNode.children.forEach((classNode) => {
        classes.push(classNode.label);
        assert.ok(classNode.children.size > 0, `a class group is never empty: ${classNode.label}`);
        assert.ok(
          classNode.canResolveChildren,
          `a class node declares children: ${classNode.label}`,
        );
        assert.ok(
          !EXPECTED_SET.has(classNode.id),
          `a class id is a group id, never an FQN: ${classNode.id}`,
        );
        classNode.children.forEach((leaf) => {
          leaves.push(leaf.id);
          assert.strictEqual(
            leaf.children.size,
            0,
            `nothing may nest DEEPER than a test: ${leaf.id}`,
          );
          assert.ok(
            EXPECTED_SET.has(leaf.id),
            `a depth-4 node must be a discovered test: ${leaf.id}`,
          );
        });
      });
    });
  }
  assert.deepStrictEqual(
    sorted(namespaces),
    ['Cs.Xunit.Fixtures', 'Fs.Xunit'],
    'exactly the two split-derived namespaces, each once',
  );
  assert.deepStrictEqual(
    sorted(classes),
    ['CalculatorTests', 'Fixtures'],
    'exactly the two split-derived classes, each once',
  );
  assert.deepStrictEqual(
    sorted(leaves),
    sorted(EXPECTED),
    'the leaves are EXACTLY the fixtures’ eleven FQNs',
  );
  assert.strictEqual(
    roots.length + namespaces.length + classes.length + leaves.length,
    17,
    'the tree is 2 assemblies + 2 namespaces + 2 classes + 11 tests',
  );
  assert.strictEqual(items.size, 2, 'the controller collection holds the two assembly roots');
  return leaves;
}

/** Every property a GROUP node's snapshot hands the Testing view. */
function assertGroupSnapshot(snapshot: TestItemSnapshot, anchor: string): void {
  assert.ok(
    snapshot.childCount > 0,
    `a group carries its children — it is never an empty row: ${snapshot.id}`,
  );
  assert.ok(!EXPECTED_SET.has(snapshot.id), `a group id is never an FQN: ${snapshot.id}`);
  assert.strictEqual(
    snapshot.description,
    undefined,
    `a group row stays clean — the description is the test leaves’ FQN slot: ${snapshot.id}`,
  );
  assert.deepStrictEqual(snapshot.tags, [], `a group carries no framework tag: ${snapshot.id}`);
  assert.strictEqual(
    comparablePath(snapshot.uriPath ?? ''),
    comparablePath(anchor),
    `a group is anchored at the discovery target's directory: ${snapshot.id}`,
  );
}

/** Every line the kit must have serialized into a project file, in order. */
function expectedXmlLines(compile?: string): string[] {
  const compiles =
    compile === undefined
      ? []
      : ['  <ItemGroup>', `    <Compile Include="${compile}"/>`, '  </ItemGroup>'];
  return [...XML_HEAD, ...compiles, ...XML_PACKAGES];
}

/** No banner, summary line or theory row may be mistaken for a test. */
function assertNoChatter(ids: readonly string[]): void {
  for (const id of ids) {
    assert.strictEqual(id.trim(), id, `a tree id never keeps the listing's indentation: '${id}'`);
    assert.ok(id.length > 0, 'an empty id would render as a blank row in the Testing view');
    for (const noise of CHATTER)
      assert.ok(
        !id.includes(noise),
        `VSTest chatter '${noise}' must never become a test item: '${id}'`,
      );
  }
}

/** The settled tree is EXACTLY the fixtures' eleven names, each exactly once. */
function assertExactTree(ids: readonly string[], where: string): void {
  for (const name of EXPECTED) {
    assert.ok(ids.includes(name), `${where}: must be discovered — ${name}\ngot: ${ids.join(', ')}`);
    assert.strictEqual(
      ids.filter((id) => id === name).length,
      1,
      `${where}: ${name} must reach the tree EXACTLY once, not once per theory row`,
    );
  }
  assert.deepStrictEqual(
    sorted(ids),
    sorted(EXPECTED),
    `${where}: the tree must be exactly the fixtures' eleven names — nothing extra, nothing missing`,
  );
  assert.strictEqual(
    ids.length,
    11,
    `${where}: exactly eleven tests must be discovered: ${ids.join(', ')}`,
  );
  assert.strictEqual(
    new Set(ids).size,
    ids.length,
    `${where}: the tree must carry no duplicate ids: ${ids.join(', ')}`,
  );
  assert.strictEqual(
    ids.filter((id) => id.startsWith('Fs.Xunit.Fixtures.')).length,
    6,
    `${where}: all six F# tests are discovered — F# is never the afterthought`,
  );
  assert.strictEqual(
    ids.filter((id) => id.startsWith('Cs.Xunit.Fixtures.CalculatorTests.')).length,
    5,
    `${where}: all five C# tests are discovered`,
  );
  assert.strictEqual(
    ids.filter((id) => id.includes(' ')).length,
    5,
    `${where}: five F# backtick names carry spaces the old ^[\\w.]+$ filter dropped`,
  );
  assertNoChatter(ids);
}

/** One `Test run for <dll>` banner, asserted to name a real built assembly. */
function assertAnnouncedAssembly(assembly: string, anchor: string): void {
  assert.ok(path.isAbsolute(assembly), `${assembly} must be an absolute path`);
  assert.ok(fs.existsSync(assembly), `${assembly} must exist on disk — the project really built`);
  assert.strictEqual(
    path.extname(assembly),
    '.dll',
    `${assembly} must name a managed assembly, not a truncated prefix`,
  );
  assertContainsNone(assembly, ['(.NETCoreApp', 'Version=v'], 'assembly');
  assert.strictEqual(assembly.trim(), assembly, `${assembly} must not carry banner padding`);
  assert.strictEqual(
    path.basename(path.dirname(assembly)),
    'net10.0',
    `${assembly} must sit in its target-framework output directory`,
  );
  assert.ok(
    comparablePath(assembly).startsWith(comparablePath(anchor)),
    `${assembly} must be rooted in the fixture directory ${anchor}`,
  );
}

/** The `Path` of every `<Project>` the CLI wrote into the .slnx, `/`-separated. */
function solutionProjectPaths(solutionText: string): string[] {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(
    solutionText,
  );
  const projects = parsed?.Solution?.Project;
  const entries = Array.isArray(projects) ? projects : [projects];
  return entries.map((entry) => String(entry?.['@_Path']).replace(/\\/g, '/'));
}

/**
 * The rendered census of the settled tree: seventeen rows — eleven TEST leaves
 * and six GROUP rows — each carrying what the Testing view draws, with the
 * hierarchy's shape visible in the groups' child counts.
 */
function assertRenderedRows(items: vscode.TestItemCollection, anchor: string): void {
  const snapshots = snapshotItems(items);
  const leaves = snapshots.filter((snapshot) => snapshot.childCount === 0);
  const groups = snapshots.filter((snapshot) => snapshot.childCount > 0);
  assert.strictEqual(
    snapshots.length,
    17,
    `eleven test rows plus six group rows, got ${snapshots.length}`,
  );
  assert.strictEqual(groups.length, 6, 'six group rows carry the hierarchy');
  assert.deepStrictEqual(
    sorted(leaves.map((snapshot) => snapshot.id)),
    sorted(EXPECTED),
    'the rendered TEST rows are exactly the fixtures’ eleven names',
  );
  for (const snapshot of leaves) assertPlainLeaf(snapshot, anchor);
  for (const snapshot of groups) assertGroupSnapshot(snapshot, anchor);
  assert.deepStrictEqual(
    snapshots.flatMap((snapshot) => snapshot.tags),
    [],
    'plain xUnit tests AND their groups carry no framework tag anywhere — that tag is reserved for Expecto/FsCheck naming',
  );
  assert.strictEqual(
    new Set(groups.map((snapshot) => snapshot.uriPath)).size,
    1,
    'every group shares the one discovery-target uri',
  );
  assert.strictEqual(
    new Set(leaves.map((snapshot) => snapshot.uriPath)).size,
    2,
    'every test points at its declaring file: one per fixture project',
  );
  assert.strictEqual(
    new Set(leaves.map((snapshot) => snapshot.description)).size,
    11,
    'leaf descriptions stay unique — that is WHY the description carries the whole FQN',
  );
  assert.deepStrictEqual(
    groups.map((snapshot) => snapshot.childCount).sort((a, b) => a - b),
    [1, 1, 1, 1, 5, 6],
    'the groups’ child counts are the hierarchy’s census: assemblies 1+1 namespace, namespaces 1+1 class, classes 5+6 tests',
  );
  const labels = leaves.map((snapshot) => snapshot.label);
  assert.deepStrictEqual(
    sorted(labels),
    sorted(EXPECTED.map((name) => name.split('.').at(-1) ?? '')),
    'the rendered TEST labels are exactly the last dotted segment of each name',
  );
  for (const theory of ['mixed theory', 'Mixed_Theory']) {
    assert.strictEqual(
      labels.filter((label) => label === theory).length,
      1,
      `the ${theory} renders one row, not one per disagreeing row`,
    );
  }
}

suite('Test Explorer e2e — real C#/F# discovery', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let csProjDir: string;
  let fsProjDir: string;
  let listing: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    ({ api, root } = await activateWithScratch('sharplsp-testexplorer-'));
    csProjDir = writeProject(
      path.join(root, CS.projectName),
      CS.projectFileName,
      projectXml(CS.packages),
      CS.sourceFileName,
      CS.source,
    );
    fsProjDir = writeProject(
      path.join(root, FS_FIXTURE.projectName),
      FS_FIXTURE.projectFileName,
      projectXml(FS_FIXTURE.packages, FS_FIXTURE.sourceFileName),
      FS_FIXTURE.sourceFileName,
      FS_FIXTURE.source,
    );

    slnPath = await createSolution(root, 'Mixed', [csProjDir, fsProjDir]);

    // Warm the FULL VSTest discovery path once (both builds + adapter JIT) so the
    // reactive discovery below runs warm. The output is KEPT: the parser
    // assertions read a REAL listing, never a hand-written imitation of one.
    listing = await warmDiscovery(slnPath, root);
  });

  teardown(async () => {
    // Reset the loaded solution so each test's load is a real transition that
    // re-fires reactive discovery, and let the debounced sweep settle first.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
    }, api.testController);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  /** Load the fixture solution and run the activating sweep, as opening the Testing view does. */
  async function activateOnFixture(): Promise<string[]> {
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    // Loading also schedules a DEBOUNCED sweep that supersedes the explicit one
    // (`discoverGeneration`), so assert on the SETTLED tree, not the first read.
    return pollUntilDiscovered(api.testController, EXPECTED);
  }

  /** The tree is empty, so whatever refills it next is what is under test. */
  function assertTreeEmpty(why: string): void {
    assert.deepStrictEqual(
      collectItemIds(api.testController.items),
      [],
      `the tree is empty ${why}`,
    );
    assert.strictEqual(api.testController.items.size, 0, `and so is the collection ${why}`);
  }

  /** The documented hierarchy, EXACTLY the eleven names, and every row rendered right. */
  function assertSettledTree(why: string): string[] {
    const leaves = assertHierarchyTree(api.testController.items);
    assertExactTree(leaves, why);
    assertRenderedRows(api.testController.items, root);
    return leaves;
  }

  test('activating the Test Explorer discovers every C# AND F# test in the loaded solution', async function () {
    this.timeout(DOTNET_CLI_MS);
    assert.strictEqual(
      EXPECTED.length,
      11,
      'the two xUnit fixtures expose eleven fully-qualified names — four facts and two theories each in F#, three and two in C#',
    );
    assert.strictEqual(new Set(EXPECTED).size, 11, 'no fixture may claim a name the other owns');
    api.testController.items.replace([]);
    assertTreeEmpty('at the start, so everything below was discovered HERE');
    // The bug scenario: a solution is loaded and the user opens the Testing view.
    // That is the recovery from "No tests have been found in this workspace yet".
    const ids = await activateOnFixture();
    assertSettledTree('activateAndDiscover');
    assertContainsAll(ids, [FS_FACT_SPACED, FS_MIXED_THEORY, CS_MIXED_THEORY], 'ids');
    assert.strictEqual(
      ids.filter((id) => id.includes('theory') || id.includes('Theory')).length,
      4,
      'both fixtures contribute exactly two theories — the agreeing one and the mixed one',
    );
    assert.strictEqual(
      ids.filter((id) => id.includes('(')).length,
      0,
      'an xUnit [Theory] FQN carries NO row data — parentheses are an NUnit [TestCase] shape',
    );
    assertLeavesAre(
      api.testController,
      EXPECTED,
      'every discovered FQN is a LEAF under its Assembly → Namespace → Class path',
    );
  });

  test('every discovered item carries the label, description, uri and tags the tree renders', async function () {
    this.timeout(DOTNET_CLI_MS);
    await activateOnFixture();
    assertSettledTree('item-shape discovery');
    // The spaced F# name keeps its spaces all the way into the rendered label.
    const spaced = assertLeafItem(api.testController.items, FS_FACT_SPACED);
    assert.strictEqual(
      spaced.label,
      'adds two numbers with spaces',
      'the F# label is the backtick binding, spaces and all',
    );
    assert.strictEqual(
      spaced.label.split(' ').length,
      5,
      'the spaced label really carries four spaces, not one',
    );
    assert.ok(!spaced.id.includes('`'), 'F# backticks are source syntax, never part of the FQN');
    assertDeclaredInside(spaced.uri?.fsPath, root, 'the spaced F# test');
    assert.strictEqual(
      path.basename(spaced.uri?.fsPath ?? ''),
      'Tests.fs',
      'the spaced F# test is revealed at the .fs file that declares it',
    );
    for (const expected of EXPECTED) assertLeafItem(api.testController.items, expected);
    assert.strictEqual(
      findItem(api.testController.items, 'Cs.Xunit.Fixtures.CalculatorTests.Nope'),
      undefined,
      'findItem must never invent an item for an unknown id',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      17,
      'a lookup that matched nothing must not disturb the discovered tree’s 17 nodes',
    );
  });

  test('once active, loading a solution reactively re-populates the tree with no manual refresh', async function () {
    this.timeout(DOTNET_CLI_MS);
    // Activate the Test Explorer as opening the Testing view would.
    await activateOnFixture();
    assertSettledTree('the activating sweep');
    // The reactive contract: clear + reload with NO manual discovery call.
    api.testController.items.replace([]);
    api.explorerProvider.clear();
    assertTreeEmpty('before the reactive reload');
    assert.strictEqual(
      findItem(api.testController.items, FS_FIXTURE.passing),
      undefined,
      'no item survives the clear, not even by id lookup',
    );
    await api.explorerProvider.loadSolution(slnPath);
    const discovered = await pollForIds(api.testController, (ids) =>
      EXPECTED.every((name) => ids.includes(name)),
    );
    // The same whole tree, with no refresh press anywhere: a reload REPLACES the
    // tree, never appends a second copy of every id.
    assertSettledTree('the reactive reload');
    assertContainsAll(
      discovered,
      [FS_FIXTURE.passing, CS.passing, FS_FACT_SPACED, FS_MIXED_THEORY, CS_MIXED_THEORY],
      'discovered',
    );
    assertLeafItem(api.testController.items, FS_MIXED_THEORY);
    assertLeafItem(api.testController.items, CS_MIXED_THEORY);
  });

  test('VS Code’s own refresh affordance re-runs discovery through the controller', async function () {
    this.timeout(DOTNET_CLI_MS);
    await activateOnFixture();
    assertSettledTree('the pre-refresh sweep');
    api.testController.items.replace([]);
    assertTreeEmpty('so the refresh below is what refills it');
    // `testing.refreshTests` is the command bound to the ⟳ button in the Testing
    // view; it reaches the controller's refreshHandler.
    const commands = await vscode.commands.getCommands(true);
    assert.strictEqual(
      commands.filter((command) => command === 'testing.refreshTests').length,
      1,
      'the workbench exposes testing.refreshTests — the ⟳ button’s command — exactly once',
    );
    await vscode.commands.executeCommand('testing.refreshTests');
    const refreshed = await pollUntilDiscovered(api.testController, EXPECTED);
    // The ⟳ button restores EXACTLY the eleven names, each rendering its own
    // row again: the refresh replaces the tree, never collapses or appends.
    assertSettledTree('testing.refreshTests');
    assertContainsAll(refreshed, [FS_FACT_SPACED, FS_MIXED_THEORY, CS_MIXED_THEORY], 'refreshed');
    assertLeafItem(api.testController.items, FS_FACT_SPACED);
    assertLeafItem(api.testController.items, CS.parameterized);
  });

  test('the discovery parsers read a REAL multi-project listing, banners included', function () {
    this.timeout(FAST_MS);
    // `listing` is the real `dotnet test --list-tests` output captured in
    // suiteSetup: two projects, two banners, and the chatter between them.
    assert.ok(listing.length > 0, 'suiteSetup must have captured a real listing to parse');
    const announced = announcedPair(listing);
    assert.deepStrictEqual(
      sorted(announced.map((assembly) => path.basename(assembly))),
      ['XunitCs.dll', 'XunitFs.dll'],
      'exactly the two fixture assemblies are announced, by name',
    );
    for (const assembly of announced) assertAnnouncedAssembly(assembly, root);
    // parseTestAssemblies is parseAnnouncedAssemblies filtered by existence, so
    // for a solution that built cleanly the two agree exactly.
    assert.deepStrictEqual(
      parseTestAssemblies(listing),
      announced,
      'every announced assembly of a solution that built cleanly also exists on disk',
    );
    assert.strictEqual(
      parseTestAssemblies(listing).length,
      2,
      'both projects survive the on-disk existence filter',
    );
    // The DisplayName listing is the FALLBACK path: xUnit's facts appear because
    // their display name equals the FQN, but a theory's carries its row args.
    const displayNames = parseTestList(listing);
    assert.deepStrictEqual(
      sorted(displayNames),
      sorted(DISPLAY_NAMES),
      'ONLY the seven xUnit facts have a DisplayName equal to their FQN',
    );
    assert.strictEqual(
      displayNames.length,
      7,
      `seven of the eleven tests reach the display listing: ${displayNames.join(', ')}`,
    );
    assert.strictEqual(
      new Set(displayNames).size,
      displayNames.length,
      'the display listing is de-duplicated',
    );
    assertContainsAll(displayNames, [CS.passing, FS_FACT_SPACED], 'displayNames');
    for (const theory of [
      FS_FIXTURE.parameterized,
      FS_MIXED_THEORY,
      CS.parameterized,
      CS_MIXED_THEORY,
    ]) {
      assert.ok(
        !displayNames.includes(theory),
        `a theory's display name carries ROW ARGUMENTS, so the bare ${theory} is absent from the listing`,
      );
    }
    assert.ok(
      displayNames.length < EXPECTED.length,
      `the display listing (${displayNames.length}) must be strictly WEAKER than the FQN tree (${EXPECTED.length})`,
    );
    assert.ok(
      !displayNames.some((name) => name.includes('Test run for')),
      'banners are never test names',
    );
    assert.ok(
      !displayNames.some((name) => name.includes('The following')),
      'the "The following Tests are available:" header is never a test name',
    );
    assert.ok(
      !displayNames.some((name) => name.includes(':')),
      "no display name may carry a `:` — that is what excludes a theory's row arguments",
    );
    assertNoChatter(displayNames);
  });

  test('the line classifier and the FQN-file parser handle the Windows shapes as well', function () {
    this.timeout(FAST_MS);
    // A faithful Windows listing: drive letters, CRLF, ' (' in a directory NAME.
    const windowsListing = [
      'Test run for C:\\Program Files (x86)\\repo\\FsTests\\bin\\Debug\\net10.0\\FsTests.dll (.NETCoreApp,Version=v10.0)',
      'The following Tests are available:',
      '    Fs.Sample.Tests.addsTwoNumbers',
      '    Fs.Sample.Tests.adds two numbers with spaces',
      'Test run for C:\\repo\\CsTests\\bin\\Debug\\net10.0\\CsTests.dll (.NETCoreApp,Version=v10.0)',
      'The following Tests are available:',
      '    Cs.Sample.Tests.CalculatorTests.Adds_TwoNumbers',
    ].join('\r\n');
    assert.deepStrictEqual(
      parseTestList(windowsListing),
      [
        'Fs.Sample.Tests.addsTwoNumbers',
        'Fs.Sample.Tests.adds two numbers with spaces',
        'Cs.Sample.Tests.CalculatorTests.Adds_TwoNumbers',
      ],
      'CRLF lines are trimmed, banners and headers dropped, and the names keep their listing ORDER',
    );
    assert.deepStrictEqual(
      parseAnnouncedAssemblies(windowsListing),
      [
        'C:\\Program Files (x86)\\repo\\FsTests\\bin\\Debug\\net10.0\\FsTests.dll',
        'C:\\repo\\CsTests\\bin\\Debug\\net10.0\\CsTests.dll',
      ],
      "the framework suffix is stripped from the RIGHT, so the path's OWN ' (' survives",
    );
    assert.deepStrictEqual(
      parseTestAssemblies(windowsListing),
      [],
      'assemblies that are not on THIS disk are filtered out',
    );
    assert.deepStrictEqual(parseAnnouncedAssemblies(''), [], 'empty output announces no assembly');
    assert.deepStrictEqual(
      parseAnnouncedAssemblies('Build succeeded.\nDetermining projects to restore...'),
      [],
      'build chatter announces no assembly',
    );
    assert.deepStrictEqual(parseTestList(''), [], 'empty output yields no test names');
    // The classifier: dotted identifiers yes, anything path-shaped or noisy no.
    assert.ok(isDiscoveredTestLine('Ns.Class.Method'), 'a dotted identifier is a display name');
    assert.ok(
      isDiscoveredTestLine('Ns.Module.adds two numbers'),
      'an F# backtick name carries SPACES and is still a display name',
    );
    assert.ok(
      !isDiscoveredTestLine('NoDotHere'),
      'a bare member name has no namespace and could never be filtered on',
    );
    assert.ok(!isDiscoveredTestLine('C:\\repo\\a.dll'), 'a Windows path is not a test name');
    assert.ok(!isDiscoveredTestLine('/repo/a.dll'), 'a POSIX path is not a test name');
    assert.ok(
      !isDiscoveredTestLine('Proj -> C:\\out\\a.dll'),
      'the MSBuild output mapping is not a test name',
    );
    assert.ok(
      !isDiscoveredTestLine('Ns.Class.Method(a: 1)'),
      "a theory's row arguments carry `(` and `:`, so the row is not a name",
    );
    assert.ok(
      !isDiscoveredTestLine('Test run for x.dll'),
      'the assembly banner is not a test name',
    );
    assert.ok(!isDiscoveredTestLine('Passed!  - Failed: 0'), 'the run summary is not a test name');
    assert.ok(!isDiscoveredTestLine('Build succeeded.'), 'build chatter is not a test name');
    assert.ok(
      !isDiscoveredTestLine('Determining projects to restore...'),
      'restore chatter is not a test name',
    );
    assert.ok(
      !isDiscoveredTestLine('at System.Reflection.MethodBaseInvoker.Invoke'),
      'a managed STACK FRAME is dotted-identifier shaped and must still be rejected, or a crash looks like an enumeration',
    );
    for (const name of DISPLAY_NAMES)
      assert.ok(
        isDiscoveredTestLine(name),
        `every real xUnit display name must classify as a test line: ${name}`,
      );
    // The FQN file VSTest writes: no shape filter at all, CRLF and a BOM
    // tolerated, blank lines dropped, order and duplicates handled.
    const fqnFile =
      '\uFEFFNs.Class.Method\r\nNs.Module.adds two numbers\r\nNs.C.Case(2,2,4)\r\n\r\nNs.Class.Method\r\n';
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(fqnFile),
      ['Ns.Class.Method', 'Ns.Module.adds two numbers', 'Ns.C.Case(2,2,4)'],
      'the BOM is stripped, blanks dropped, the repeat de-duplicated, and the order preserved',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(''),
      [],
      'an empty listing file yields no names rather than throwing',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList('\uFEFF'),
      [],
      'a listing file that is nothing but a BOM yields no names',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList('Bare\n'),
      ['Bare'],
      'the FQN file applies NO shape filter — no dot required',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(EXPECTED.join('\n')),
      [...EXPECTED],
      'every one of the fixtures’ eleven names round-trips through the FQN file parser, in order',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(`\uFEFF${EXPECTED.join('\r\n')}\r\n`),
      [...EXPECTED],
      'and identically when VSTest writes it Windows-style, with a BOM and CRLF',
    );
  });

  test('assembly batching keeps a many-project solution inside the Windows command-line limit', function () {
    this.timeout(FAST_MS);
    // Windows caps a command line at 32 767 characters, so `batchAssemblies`
    // keeps each `dotnet vstest` invocation under a 24 000-character budget —
    // over it, the spawn FAILS rather than enumerating.
    const long = Array.from(
      { length: 200 },
      (_unused, index) =>
        `C:\\agent\\_work\\1\\s\\src\\Project${index}\\bin\\Debug\\net10.0\\Project${index}.dll`,
    );
    assert.strictEqual(long.length, 200, 'two hundred synthetic CI output paths');
    assert.strictEqual(
      long[0]?.length,
      62,
      'each path is a realistic Azure-Pipelines-length output path',
    );
    assert.strictEqual(
      long.reduce((sum, assembly) => sum + assembly.length + 3, 0),
      13_580,
      'two hundred of them cost 13 580 characters — under budget, so they go out as ONE command line',
    );
    const batches = batchAssemblies(long);
    assert.strictEqual(
      batches.length,
      1,
      'a solution that fits must NOT be split — an extra invocation is an extra VSTest start-up',
    );
    assert.deepStrictEqual(
      batches.flat(),
      long,
      'batching must preserve every assembly, in order, exactly once',
    );
    // Long enough to actually split: 300 paths of 200 characters each.
    const uniform = Array.from({ length: 300 }, () => 'C:\\'.padEnd(200, 'x'));
    const uniformBatches = batchAssemblies(uniform);
    assert.strictEqual(
      uniformBatches.length,
      3,
      '300 × 203 characters is 60 900 — nearly twice the Windows ceiling, so it must split three ways',
    );
    assert.deepStrictEqual(
      uniformBatches.map((batch) => batch.length),
      [118, 118, 64],
      'each batch is packed as full as the budget allows, and the remainder is the last one',
    );
    assert.deepStrictEqual(
      uniformBatches.flat(),
      uniform,
      'splitting must lose nothing and reorder nothing',
    );
    for (const batch of [...batches, ...uniformBatches]) {
      const width = batch.reduce((sum, assembly) => sum + assembly.length + 3, 0);
      assert.ok(
        width <= 24_000,
        `a batch of ${batch.length} assemblies is ${width} characters — over the command-line budget`,
      );
      assert.ok(
        batch.length > 0,
        'an empty batch would spawn a `dotnet vstest` with no assembly at all',
      );
    }
    // The real fixture solution is small enough for a single invocation.
    const real = parseTestAssemblies(listing);
    assert.deepStrictEqual(
      batchAssemblies(real),
      [real],
      'the two-project fixture goes out as exactly one batch holding both assemblies',
    );
    assert.deepStrictEqual(
      batchAssemblies([]),
      [],
      'nothing in, nothing out — never a batch of zero assemblies',
    );
    assert.deepStrictEqual(
      batchAssemblies(['a', 'b', 'c'], 10),
      [['a', 'b'], ['c']],
      'the budget is honoured exactly: two 4-character costs fit in 10, a third does not',
    );
    assert.deepStrictEqual(
      batchAssemblies(['a'], 1),
      [['a']],
      'a single over-budget assembly still gets its own batch rather than being dropped',
    );
    // An over-long path keeps its own batch: dropping it loses a whole project.
    const huge = 'C:\\'.padEnd(30_000, 'x');
    assert.deepStrictEqual(
      batchAssemblies([huge]),
      [[huge]],
      'one over-long path is one batch, not zero',
    );
    assert.strictEqual(
      batchAssemblies([huge, huge]).length,
      2,
      'two over-long paths get one batch each',
    );
    assert.deepStrictEqual(
      batchAssemblies([huge, huge]).flat(),
      [huge, huge],
      'and neither is dropped on the way',
    );
  });

  test('a discovery target that is not on disk surfaces a USEFUL error instead of silent emptiness', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ghost = path.join(root, 'NoSuchSolution.slnx');
    assert.ok(!fs.existsSync(ghost), 'the fixture must not accidentally exist');
    // The enumerator itself: never an exception, and an EMPTY result it marks
    // untrustworthy so the caller keeps whatever tree it already had.
    const listed = await listTests(ghost);
    assert.deepStrictEqual(listed.names, [], 'a missing target enumerates no names');
    assert.ok(
      !listed.ok,
      'and says so — an empty listing that is NOT ok must never blank a populated Testing view',
    );
    assert.deepStrictEqual(
      listed.warnings,
      [`Discovery target does not exist: ${ghost}`],
      'the warning must NAME the target, so the extension log says which path was wrong',
    );
    api.testController.items.replace([]);
    await api.explorerProvider.loadSolution(ghost);
    await assert.doesNotReject(async () => {
      await api.testController.activateAndDiscover();
    }, 'discovery against a missing target must not reject');
    // The bug this guards: a failed sweep used to leave the view BLANK — no
    // tests, no reason, nothing to act on. It must instead surface an error
    // item carrying the real diagnostic AND a remedy.
    const failure = await awaitSingleErrorRow();
    const failureRoots: vscode.TestItem[] = [];
    api.testController.items.forEach((item) => failureRoots.push(item));
    assert.strictEqual(
      failureRoots.length,
      1,
      `exactly one row stands after the failed sweep, got: ${failureRoots
        .map((item) => item.label)
        .join(' | ')}`,
    );
    assert.notStrictEqual(
      failure.error,
      undefined,
      'the failure row carries an error — that is what the Testing view renders',
    );
    const message = errorTextOf(failure);
    assert.ok(
      message.includes(ghost),
      `the error must NAME the missing target so the user knows what to fix: ${message}`,
    );
    assert.ok(
      /does not exist/i.test(message),
      `the error must carry the real diagnostic, not a generic shrug: ${message}`,
    );
    assert.ok(
      /select solution/i.test(message),
      `the error must offer a remedy the user can act on: ${message}`,
    );
    assert.ok(!EXPECTED_SET.has(failure.id), 'the failure row is not a test');
    assert.strictEqual(failure.children.size, 0, 'the failure row is a leaf');
    assert.deepStrictEqual(
      collectLeafIds(api.testController.items).filter((id) => EXPECTED_SET.has(id)),
      [],
      'a missing target contributes NO test items — none are invented',
    );
    assert.strictEqual(
      findItem(api.testController.items, CS.passing),
      undefined,
      'no stale item survives a failed sweep over an empty tree',
    );
    // And the extension recovers: pointing back at the real solution refills it.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await pollUntilDiscovered(api.testController, EXPECTED);
    const recoveredLeaves = assertHierarchyTree(api.testController.items);
    assertExactTree(recoveredLeaves, 'recovery after a missing target');
    assert.strictEqual(
      api.testController.items.size,
      2,
      'recovery rebuilds the two assembly roots and their whole hierarchy',
    );
    const errorsAfter: string[] = [];
    api.testController.items.forEach(function collect(item) {
      if (item.error !== undefined) errorsAfter.push(item.id);
      item.children.forEach(collect);
    });
    assert.deepStrictEqual(
      errorsAfter,
      [],
      'the stale error row is gone once discovery succeeds again',
    );
    assertContainsAll(recoveredLeaves, [FS_FIXTURE.passing, CS.passing], 'recoveredLeaves');
    for (const snapshot of snapshotItems(api.testController.items).filter(
      (s) => s.childCount === 0,
    )) {
      assertPlainLeaf(snapshot, root);
    }
    assertLeafItem(api.testController.items, FS_FACT_SPACED);
  });

  test('the solution the fixture builds is the shape the CLI produces, not a hand-written one', async function () {
    this.timeout(FAST_MS);
    // Structured files are never authored by hand ([CLAUDE.md]): the solution is
    // `dotnet new sln` + `dotnet sln add` and the projects come out of an XML
    // serializer, so both are asserted against a real parse.
    assert.ok(fs.existsSync(slnPath), `${slnPath} must exist`);
    assert.strictEqual(
      path.dirname(slnPath),
      root,
      'the solution must live directly in the fixture root',
    );
    assert.strictEqual(
      path.basename(slnPath),
      'Mixed.slnx',
      'dotnet new sln on .NET 10 emits the XML .slnx format, named after --name',
    );
    const solutionText = fs.readFileSync(slnPath, 'utf8');
    assert.ok(
      solutionText.startsWith('<Solution>'),
      `a .slnx is an XML document rooted at <Solution>: ${solutionText}`,
    );
    assert.ok(
      solutionText.trimEnd().endsWith('</Solution>'),
      'and it is closed — not a truncated write',
    );
    const projectPaths = solutionProjectPaths(solutionText);
    assert.strictEqual(
      projectPaths.length,
      2,
      `the solution must hold exactly the two fixture projects: ${projectPaths.join(', ')}`,
    );
    assert.deepStrictEqual(
      sorted(projectPaths.map((entry) => path.posix.basename(entry))),
      ['XunitCs.csproj', 'XunitFs.fsproj'],
      'each <Project Path=".."> names one fixture project file',
    );
    assert.ok(
      projectPaths.every((entry) => entry.endsWith(`/${path.posix.basename(entry)}`)),
      'every project is referenced through its own directory, not from the solution root',
    );
    assert.ok(
      projectPaths.some((entry) => entry.includes(`${CS.projectName}/${CS.projectFileName}`)),
      `the C# project is wired in as ${CS.projectName}/${CS.projectFileName}`,
    );
    assert.ok(
      projectPaths.some((entry) =>
        entry.includes(`${FS_FIXTURE.projectName}/${FS_FIXTURE.projectFileName}`),
      ),
      `the F# project is wired in as ${FS_FIXTURE.projectName}/${FS_FIXTURE.projectFileName}`,
    );
    // And the CLI agrees with the file on disk.
    const cliList = await dotnet(['sln', slnPath, 'list'], root);
    const cliProjects = cliList
      .split('\n')
      .map((line) => line.trim().replace(/\\/g, '/'))
      .filter((line) => line.endsWith('proj'));
    assert.strictEqual(
      cliProjects.length,
      2,
      `dotnet sln list must report exactly two projects: ${cliList}`,
    );
    assert.deepStrictEqual(
      sorted(cliProjects.map((entry) => path.posix.basename(entry))),
      ['XunitCs.csproj', 'XunitFs.fsproj'],
      'dotnet sln list agrees with the .slnx, project for project',
    );
    // The project XML was serialized from an object model, so it round-trips.
    const csprojText = fs.readFileSync(path.join(csProjDir, CS.projectFileName), 'utf8');
    assert.strictEqual(
      csprojText,
      projectXml(CS.packages),
      'the C# project on disk is EXACTLY what the kit serialized — no line splicing anywhere',
    );
    assert.deepStrictEqual(
      csprojText.split('\n'),
      expectedXmlLines(),
      'and that serialization is exactly these lines, in this order',
    );
    const fsprojText = fs.readFileSync(path.join(fsProjDir, FS_FIXTURE.projectFileName), 'utf8');
    assert.strictEqual(
      fsprojText,
      projectXml(FS_FIXTURE.packages, FS_FIXTURE.sourceFileName),
      'the F# project on disk is EXACTLY what the kit serialized',
    );
    assert.deepStrictEqual(
      fsprojText.split('\n'),
      expectedXmlLines(FS_FIXTURE.sourceFileName),
      'the F# project adds a Compile ItemGroup and nothing else — F# compile ORDER is significant',
    );
    assert.ok(
      fsprojText.indexOf('<Compile') < fsprojText.indexOf('<PackageReference'),
      'the Compile ItemGroup precedes the packages, as MSBuild reads it',
    );
    assert.ok(
      !csprojText.includes('<Compile'),
      'a C# project must NOT declare compile order — the SDK globs it',
    );
    for (const pkg of CS.packages) {
      assert.ok(
        csprojText.includes(`<PackageReference Include="${pkg.id}" Version="${pkg.version}"/>`),
        `${pkg.id} must be a pinned PackageReference in the C# project`,
      );
      assert.ok(
        fsprojText.includes(`<PackageReference Include="${pkg.id}" Version="${pkg.version}"/>`),
        `${pkg.id} must be a pinned PackageReference in the F# project too`,
      );
    }
    assert.strictEqual(
      fs.readFileSync(path.join(csProjDir, CS.sourceFileName), 'utf8'),
      CS.source,
      'the built C# source is the fixture’s source, verbatim',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(fsProjDir, FS_FIXTURE.sourceFileName), 'utf8'),
      FS_FIXTURE.source,
      'the built F# source is the fixture’s source, verbatim',
    );
  });

  /** Load the fixture solution, discover, and return the settled ROOT items. */
  async function discoveredTree(): Promise<vscode.TestItem[]> {
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await pollUntilDiscovered(api.testController, EXPECTED);
    const roots: vscode.TestItem[] = [];
    api.testController.items.forEach((item) => roots.push(item));
    return roots;
  }

  /**
   * Poll until the tree settles on EXACTLY one discovery-error row and return
   * it. The debounced reactive sweep supersedes the explicit one, so the error
   * row lands asynchronously — asserting immediately races it.
   */
  async function awaitSingleErrorRow(): Promise<vscode.TestItem> {
    const deadline = Date.now() + FIXTURE_BUILD_MS;
    for (;;) {
      const roots: vscode.TestItem[] = [];
      api.testController.items.forEach((item) => roots.push(item));
      const failure = roots.find((item) => item.error !== undefined);
      if (roots.length === 1 && failure !== undefined) return failure;
      if (Date.now() > deadline) {
        assert.fail(
          `timed out waiting for the discovery-error row; roots: ${
            roots.map((rootNode) => rootNode.label).join(' | ') || '(none)'
          }`,
        );
      }
      await sleep(500);
    }
  }

  /** The FQNs whose dotted split places them in `namespaceLabel`. */
  function fqnsOfNamespace(namespaceLabel: string): string[] {
    return EXPECTED.filter((fqn) => fqn.split('.').slice(0, -2).join('.') === namespaceLabel);
  }

  /** The FQNs whose dotted split places them in `classLabel` under `namespaceLabel`. */
  function fqnsOfClass(namespaceLabel: string, classLabel: string): string[] {
    return EXPECTED.filter((fqn) => {
      const parts = fqn.split('.');
      return parts.slice(0, -2).join('.') === namespaceLabel && (parts.at(-2) ?? '') === classLabel;
    });
  }

  test('tree roots are the test ASSEMBLIES — never a flat dump of test names', async function () {
    this.timeout(DOTNET_CLI_MS);
    // The reported bug: a real solution's 816 tests landed as ONE flat list at
    // the bottom of the Testing view. The roots must instead be the assemblies.
    const roots = await discoveredTree();
    assert.strictEqual(
      roots.length,
      2,
      `one root per test project, got: ${roots.map((item) => item.label).join(' | ')}`,
    );
    assert.deepStrictEqual(
      sorted(roots.map((root) => root.label)),
      [CS.projectName, FS_FIXTURE.projectName],
      'the roots are the ASSEMBLY names (XunitCs, XunitFs)',
    );
    // The label is grounded in the assembly the discovery pass really built.
    for (const project of [CS, FS_FIXTURE]) {
      const dll = path.join(
        root,
        project.projectName,
        'bin',
        'Debug',
        'net10.0',
        `${project.projectName}.dll`,
      );
      assert.ok(
        fs.existsSync(dll),
        `premise: the assembly the root is named after was really built: ${dll}`,
      );
      assert.ok(
        roots.some((candidate) => candidate.label === path.basename(dll, '.dll')),
        `a root must carry the built assembly's name: ${path.basename(dll, '.dll')}`,
      );
    }
    const fqnSet = new Set<string>(EXPECTED);
    for (const rootNode of roots) {
      assert.ok(
        !fqnSet.has(rootNode.id),
        `a root group must not carry a test's FQN as its id: ${rootNode.id}`,
      );
      assert.ok(
        rootNode.canResolveChildren,
        `an assembly root declares children so the view offers the expander: ${rootNode.label}`,
      );
      assert.strictEqual(
        rootNode.error,
        undefined,
        `an assembly root carries no discovery error: ${rootNode.label}`,
      );
      assert.deepStrictEqual(
        [...rootNode.tags].map((tag) => tag.id),
        [],
        `an assembly root carries no framework tag: ${rootNode.label}`,
      );
      assert.strictEqual(
        comparablePath(rootNode.uri?.fsPath ?? ''),
        comparablePath(root),
        `an assembly root is anchored at the discovery target's directory: ${rootNode.label}`,
      );
      // Subtree ownership: each assembly root contains EXACTLY its own tests,
      // and NO test sits at root level — every root child is a group.
      const subtree = collectItemIds(rootNode.children).concat(rootNode.id);
      const own = EXPECTED.filter((fqn) =>
        fqn.startsWith(rootNode.label === CS.projectName ? 'Cs.' : 'Fs.'),
      );
      assert.deepStrictEqual(
        sorted(subtree.filter((id) => fqnSet.has(id))),
        sorted(own),
        `the ${rootNode.label} subtree owns exactly its ${String(own.length)} tests`,
      );
      rootNode.children.forEach((child) => {
        assert.ok(
          child.children.size > 0,
          `no test may sit DIRECTLY under its assembly root: ${child.label}`,
        );
        assert.ok(
          !fqnSet.has(child.id),
          `a direct root child is a namespace group, not a test: ${child.id}`,
        );
      });
    }
  });

  test('a Run/Debug lens resolves a test NESTED under its assembly, namespace and class', async function () {
    this.timeout(DOTNET_CLI_MS);
    // Regression: `findTestByMethodName` backs the "Run Test" / "Debug Test"
    // code lenses, and it walked only the TOP level of the tree. Once discovery
    // grouped tests as Assembly → Namespace → Class → Test that level held
    // ASSEMBLIES, so every lens matched nothing and reported a perfectly
    // discovered test as "No discovered test matching …", running nothing.
    const roots = await discoveredTree();
    const fqnSet = new Set<string>(EXPECTED);
    assert.deepStrictEqual(
      roots.filter((node) => fqnSet.has(node.id)),
      [],
      'premise: no test sits at the top level — the lens MUST descend to find one',
    );
    for (const fqn of EXPECTED) {
      const methodName = fqn.split('.').at(-1) ?? '';
      const matched = findTestByMethodName(api.testController.items, methodName);
      assert.notStrictEqual(
        matched,
        undefined,
        `the lens for "${methodName}" must resolve the nested test ${fqn}`,
      );
      assert.strictEqual(
        matched?.id,
        fqn,
        `the lens must resolve the LEAF carrying the FQN, not a group: ${String(matched?.id)}`,
      );
      assert.strictEqual(
        matched?.children.size,
        0,
        `a lens must never resolve a group node: ${matched.label}`,
      );
    }
    // A group node's own label must never satisfy a lens: groups are not
    // runnable, and matching one would run a whole class from a method lens.
    for (const groupLabel of [CS.projectName, FS_FIXTURE.projectName, 'CalculatorTests']) {
      const matched = findTestByMethodName(api.testController.items, groupLabel);
      assert.strictEqual(
        matched,
        undefined,
        `a group label must resolve to no test: ${groupLabel}`,
      );
    }
  });

  test('under each assembly, tests group into NAMESPACE nodes split from their FQNs', async function () {
    this.timeout(DOTNET_CLI_MS);
    const roots = await discoveredTree();
    const fqnSet = new Set<string>(EXPECTED);
    // The expected namespace labels, derived from the FQNs themselves.
    const expectedNamespaces = sorted([
      ...new Set(EXPECTED.map((fqn) => fqn.split('.').slice(0, -2).join('.'))),
    ]);
    assert.deepStrictEqual(
      expectedNamespaces,
      ['Cs.Xunit.Fixtures', 'Fs.Xunit'],
      'premise: the fixtures declare exactly these two namespaces in their FQNs',
    );
    const seenNamespaces: string[] = [];
    for (const rootNode of roots) {
      rootNode.children.forEach((nsNode) => {
        seenNamespaces.push(nsNode.label);
        assert.ok(nsNode.children.size > 0, `a namespace node is never empty: ${nsNode.label}`);
        assert.ok(nsNode.canResolveChildren, `a namespace node declares children: ${nsNode.label}`);
        assert.ok(
          !fqnSet.has(nsNode.id),
          `a namespace id is a group id, never an FQN: ${nsNode.id}`,
        );
        assert.strictEqual(
          nsNode.error,
          undefined,
          `a namespace node carries no discovery error: ${nsNode.label}`,
        );
        // Membership: the namespace subtree holds EXACTLY the FQNs whose split
        // names this namespace — computed from EXPECTED, not hand-listed.
        assert.deepStrictEqual(
          sorted(collectItemIds(nsNode.children).filter((id) => fqnSet.has(id))),
          sorted(fqnsOfNamespace(nsNode.label)),
          `the ${nsNode.label} subtree owns exactly its split-matched tests`,
        );
        // And no test hangs DIRECTLY off the namespace: its children are classes.
        nsNode.children.forEach((child) => {
          assert.ok(
            child.children.size > 0,
            `no test may sit DIRECTLY under a namespace node: ${child.label}`,
          );
          assert.ok(
            !fqnSet.has(child.id),
            `a namespace child is a class group, not a test: ${child.id}`,
          );
        });
      });
    }
    assert.deepStrictEqual(
      sorted(seenNamespaces),
      expectedNamespaces,
      'exactly the split-derived namespaces exist under the assemblies, each once',
    );
  });

  test('under each namespace, tests group into CLASS nodes holding exactly their tests', async function () {
    this.timeout(DOTNET_CLI_MS);
    const roots = await discoveredTree();
    const fqnSet = new Set<string>(EXPECTED);
    const seenClasses: string[] = [];
    for (const rootNode of roots) {
      rootNode.children.forEach((nsNode) => {
        nsNode.children.forEach((classNode) => {
          seenClasses.push(classNode.label);
          assert.ok(classNode.children.size > 0, `a class node is never empty: ${classNode.label}`);
          assert.ok(
            classNode.canResolveChildren,
            `a class node declares children: ${classNode.label}`,
          );
          assert.ok(
            !fqnSet.has(classNode.id),
            `a class id is a group id, never an FQN: ${classNode.id}`,
          );
          const members: string[] = [];
          classNode.children.forEach((leaf) => members.push(leaf.id));
          // Membership derived from the FQN split: parts[-2] is the class.
          assert.deepStrictEqual(
            sorted(members),
            sorted(fqnsOfClass(nsNode.label, classNode.label)),
            `the ${nsNode.label}.${classNode.label} group holds exactly its split-matched tests`,
          );
          assert.strictEqual(
            members.length,
            fqnsOfClass(nsNode.label, classNode.label).length,
            `the ${classNode.label} membership count matches the split (${String(
              fqnsOfClass(nsNode.label, classNode.label).length,
            )})`,
          );
          for (const member of members) {
            assert.strictEqual(
              member.split('.').at(-2) ?? '',
              classNode.label,
              `every member's second-to-last segment names the class: ${member}`,
            );
          }
        });
      });
    }
    assert.deepStrictEqual(
      sorted(seenClasses),
      ['CalculatorTests', 'Fixtures'],
      'exactly the split-derived classes exist, each once',
    );
    assert.strictEqual(seenClasses.length, 2, 'two class groups across the whole tree');

    // Interaction 2 — a class group is a GROUP, never a test. Its id must not
    // be an FQN and it must not be runnable as a leaf, or the play button on
    // the row runs one thing and reports another ([TEST-EXPLORER]).
    assert.ok(
      !seenClasses.some((label) => fqnSet.has(label)),
      'no class label collides with a test FQN',
    );
    assert.deepStrictEqual(
      [...new Set(seenClasses)],
      seenClasses,
      'no class group is materialised twice',
    );

    // Interaction 3 — every leaf in the tree belongs to exactly one class
    // group. A test reachable from two groups is a test that runs twice and
    // reports its result to whichever row asked last.
    const owners = new Map<string, string[]>();
    for (const rootNode of roots) {
      rootNode.children.forEach((nsNode) => {
        nsNode.children.forEach((classNode) => {
          classNode.children.forEach((leaf) => {
            owners.set(leaf.id, [...(owners.get(leaf.id) ?? []), classNode.label]);
          });
        });
      });
    }
    assert.strictEqual(owners.size, fqnSet.size, `every discovered test is grouped once`);
    for (const [id, groups] of owners) {
      assert.strictEqual(
        groups.length,
        1,
        `${id} belongs to one class group, not ${groups.length}`,
      );
      assert.ok(fqnSet.has(id), `${id} is a discovered FQN`);
    }
  });

  test('every TEST is a leaf at depth 4 carrying its FQN as id and its method as label', async function () {
    this.timeout(DOTNET_CLI_MS);
    const roots = await discoveredTree();
    for (const fqn of EXPECTED) {
      const parts = fqn.split('.');
      const assemblyLabel = fqn.startsWith('Cs.') ? CS.projectName : FS_FIXTURE.projectName;
      const namespaceLabel = parts.slice(0, -2).join('.');
      const classLabel = parts.at(-2) ?? '';
      const testLabel = parts.at(-1) ?? '';
      const rootNode = roots.find((candidate) => candidate.label === assemblyLabel);
      assert.ok(rootNode, `depth 1 — the assembly root ${assemblyLabel} for ${fqn}`);
      const nsNode = childByLabel(rootNode.children, namespaceLabel);
      assert.ok(
        nsNode,
        `depth 2 — the namespace node ${namespaceLabel} under ${assemblyLabel}; saw: ${
          [...rootNode.children].map(([, item]) => item.label).join(' | ') || '(nothing)'
        }`,
      );
      const classNode = childByLabel(nsNode.children, classLabel);
      assert.ok(
        classNode,
        `depth 3 — the class node ${classLabel} under ${namespaceLabel}; saw: ${
          [...nsNode.children].map(([, item]) => item.label).join(' | ') || '(nothing)'
        }`,
      );
      const leaf = childByLabel(classNode.children, testLabel);
      assert.ok(
        leaf,
        `depth 4 — the test node ${testLabel} under ${namespaceLabel}.${classLabel}; saw: ${
          [...classNode.children].map(([, item]) => item.label).join(' | ') || '(nothing)'
        }`,
      );
      assert.strictEqual(leaf.id, fqn, `the leaf id is the FQN verbatim: ${fqn}`);
      assert.strictEqual(leaf.label, testLabel, `the leaf label is the method name: ${fqn}`);
      assert.strictEqual(
        leaf.description,
        fqn,
        `the leaf description carries the whole FQN: ${fqn}`,
      );
      assert.strictEqual(
        leaf.children.size,
        0,
        `a test is a LEAF — nothing nests under it: ${fqn}`,
      );
      assert.ok(
        !leaf.canResolveChildren,
        `a leaf resolves no children: ${fqn}`,
        [...leaf.tags].map((tag) => tag.id),
        [],
        `a plain xUnit test carries no framework tag: ${fqn}`,
      );
      assertDeclaredInside(leaf.uri?.fsPath, root, `leaf ${fqn}`);
    }
    // The spaced F# backtick binding is ONE leaf whose label keeps its spaces.
    const spaced = findItem(api.testController.items, FS_FACT_SPACED);
    assert.ok(spaced, 'the spaced F# backtick test is in the tree');
    assert.strictEqual(
      spaced.label,
      'adds two numbers with spaces',
      'a leaf label is the binding name, spaces and all',
    );
    assert.ok(!spaced.label.includes('.'), "a leaf label never keeps the FQN's dots");
    assertLeafItem(api.testController.items, CS.passing);
    assertLeafItem(api.testController.items, FS_FIXTURE.passing);
  });

  test('the tree is structurally pure: 4 levels, nothing deeper, nothing misplaced', async function () {
    this.timeout(DOTNET_CLI_MS);
    const roots = await discoveredTree();
    const fqnSet = new Set<string>(EXPECTED);
    let namespaceCount = 0;
    let classCount = 0;
    const leafIdsFound: string[] = [];
    for (const rootNode of roots) {
      rootNode.children.forEach((nsNode) => {
        namespaceCount += 1;
        assert.ok(nsNode.children.size > 0, `every namespace group is non-empty: ${nsNode.label}`);
        nsNode.children.forEach((classNode) => {
          classCount += 1;
          assert.ok(
            classNode.children.size > 0,
            `every class group is non-empty: ${classNode.label}`,
          );
          classNode.children.forEach((leaf) => {
            leafIdsFound.push(leaf.id);
            assert.strictEqual(
              leaf.children.size,
              0,
              `nothing may nest DEEPER than a test — depth 5 found at: ${leaf.id}`,
            );
            assert.ok(
              fqnSet.has(leaf.id),
              `a depth-4 node must be a discovered test, not a stray group: ${leaf.id}`,
            );
          });
        });
      });
    }
    assert.strictEqual(roots.length, 2, 'depth 1: exactly two assemblies');
    assert.strictEqual(namespaceCount, 2, 'depth 2: exactly two namespaces');
    assert.strictEqual(classCount, 2, 'depth 3: exactly two classes');
    assert.strictEqual(leafIdsFound.length, 11, 'depth 4: exactly eleven tests');
    assert.strictEqual(
      roots.length + namespaceCount + classCount + leafIdsFound.length,
      17,
      'the whole tree is 2 assemblies + 2 namespaces + 2 classes + 11 tests = 17 nodes',
    );
    assert.deepStrictEqual(
      sorted(leafIdsFound),
      sorted(EXPECTED),
      'every test appears as a leaf EXACTLY once — no losses, no duplicates',
    );
    for (const fqn of EXPECTED) {
      assert.strictEqual(
        leafIdsFound.filter((id) => id === fqn).length,
        1,
        `${fqn} is a leaf exactly once`,
      );
    }
  });

  test('▶ on a CLASS group runs exactly the tests it contains', async function () {
    this.timeout(DOTNET_CLI_MS);
    const roots = await discoveredTree();
    const csRoot = roots.find((rootNode) => rootNode.label === CS.projectName);
    assert.ok(csRoot, 'the C# assembly root exists');
    const csNamespace = childByLabel(csRoot.children, 'Cs.Xunit.Fixtures');
    assert.ok(csNamespace, 'the C# namespace node exists');
    const csClass = childByLabel(csNamespace.children, 'CalculatorTests');
    assert.ok(csClass, 'the C# class node exists');
    const csLeaves: string[] = [];
    csClass.children.forEach((leaf) => csLeaves.push(leaf.id));
    assert.strictEqual(
      csLeaves.length,
      5,
      `the class group holds the five C# tests, got: ${csLeaves.join(' | ')}`,
    );

    // Interaction 2 — the row being pressed is a GROUP, and everything under it
    // is a test row shaped the way [TEST-DISCOVERY-FQN] requires.
    assert.ok(
      csClass.canResolveChildren,
      'a class node must declare children, or the Testing view offers no expander to open',
    );
    assert.notStrictEqual(
      csClass.id,
      csClass.label,
      'a GROUP id is qualified by the assembly it belongs to — a bare label collides across ' +
        'projects that share a class name',
    );
    assertLeavesAreTests(csClass, 'Cs.Xunit.Fixtures.CalculatorTests.');
    assert.deepStrictEqual(
      sorted(csLeaves),
      sorted(EXPECTED.filter((fqn) => fqn.startsWith('Cs.Xunit.Fixtures.CalculatorTests.'))),
      'the class group holds EXACTLY its own tests — no neighbour, no theory row',
    );
    assert.deepStrictEqual(
      csLeaves.filter((id) => id.includes('(')),
      [],
      'a C# xUnit id carries no row data, so no parenthesis reaches the filter grammar',
    );

    // Interaction 3 — press the class group's run button, having recorded what
    // the OTHER assembly's results were, so a run that silently widened to the
    // whole solution is visible.
    const fsWatched = [FS_FIXTURE.passing, FS_FACT_SPACED, FS_FIXTURE.failing, FS_FIXTURE.skipped];
    const fsBefore = resultSnapshot(api.testController, fsWatched);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [csClass]);
    assert.strictEqual(
      resultSnapshot(api.testController, fsWatched),
      fsBefore,
      'running a C# class must run THAT selection: the F# results may not move',
    );
    for (const id of csLeaves) {
      const result = api.testController.getResult(id);
      assert.ok(
        result !== undefined && result.outcome !== 'notRun',
        `▶ on the class node must produce a real outcome for ${id}: ${JSON.stringify(result)}`,
      );
    }
    assert.strictEqual(
      api.testController.getResult(CS.passing)?.outcome,
      'passed',
      'the class run reports the passing fact as passed',
    );
    assert.strictEqual(
      api.testController.getResult(CS.failing)?.outcome,
      'failed',
      'the class run reports the failing fact as failed',
    );
    assert.strictEqual(
      api.testController.getResult(CS.skipped)?.outcome,
      'skipped',
      'the class run reports the skipped fact as skipped',
    );

    // Interaction 4 — the outcomes carry what [TEST-RUN-TRX] says they carry:
    // the adapter's OWN assertion text, a measured duration, and nothing that
    // reads like a test the filter never matched.
    const failureMessage = api.testController.getResult(CS.failing)?.message ?? '';
    assert.ok(
      failureMessage.includes('Assert.Equal'),
      `a failure shows the TRX ErrorInfo, not a generic sentence; got '${failureMessage}'`,
    );
    assert.notStrictEqual(failureMessage, 'Test failed', 'never the generic fallback');
    assert.deepStrictEqual(
      csLeaves
        .map((id) => api.testController.getResult(id)?.message ?? '')
        .filter((message) => message.includes('No result reported')),
      [],
      'every test in the class was matched by the filter and attributed from the TRX report',
    );
    assert.strictEqual(
      api.testController.getResult(CS.skipped)?.passed,
      false,
      'a skip is not a pass — and its outcome above proves it is not a failure either',
    );
    assert.ok(
      (api.testController.getResult(CS.passing)?.duration ?? -1) >= 0,
      'a pass carries the duration TRX recorded for it',
    );
    // Running must not mutate the tree's shape.
    const rootsAfter: vscode.TestItem[] = [];
    api.testController.items.forEach((item) => rootsAfter.push(item));
    assert.strictEqual(
      rootsAfter.length,
      2,
      'running a class group leaves the two assembly roots standing',
    );
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(EXPECTED),
      'running a class group does not add, drop or duplicate any test',
    );
  });

  test('▶ on a NAMESPACE group runs every test beneath it', async function () {
    this.timeout(DOTNET_CLI_MS);
    const roots = await discoveredTree();
    const fsRoot = roots.find((rootNode) => rootNode.label === FS_FIXTURE.projectName);
    assert.ok(fsRoot, 'the F# assembly root exists');
    const fsNamespace = childByLabel(fsRoot.children, 'Fs.Xunit');
    assert.ok(fsNamespace, 'the F# namespace node exists');
    const fsLeaves = collectItemIds(fsNamespace.children).filter((id) =>
      new Set<string>(EXPECTED).has(id),
    );
    assert.strictEqual(
      fsLeaves.length,
      6,
      `the namespace subtree holds the six F# tests, got: ${fsLeaves.join(' | ')}`,
    );

    // Interaction 2 — F# FIRST: the namespace subtree must carry the awkward
    // names [TEST-DISCOVERY-FQN] tabulates, verbatim.
    assert.ok(
      fsNamespace.canResolveChildren,
      'a namespace node must declare children so the view can expand it',
    );
    assert.ok(
      fsLeaves.includes(FS_FACT_SPACED),
      'an idiomatic F# backtick binding keeps the SPACES in its FQN all the way into the tree',
    );
    assert.ok(
      FS_FACT_SPACED.includes(' '),
      'and that name really does contain spaces — otherwise this asserts nothing',
    );
    assert.deepStrictEqual(
      fsLeaves.filter((id) => withoutAdapterUniqueId(id) !== id),
      [],
      'no F# id carries an adapter unique-ID decoration either',
    );
    assert.deepStrictEqual(
      sorted(fsLeaves),
      sorted(EXPECTED.filter((fqn) => fqn.startsWith('Fs.Xunit.'))),
      'the namespace subtree is EXACTLY the F# fixture tests',
    );

    // Interaction 3 — run the namespace, having recorded the C# assembly's
    // results so a run that widened to the solution is visible.
    const csWatched = [CS.passing, CS.failing, CS.skipped];
    const csBefore = resultSnapshot(api.testController, csWatched);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [fsNamespace]);
    assert.strictEqual(
      resultSnapshot(api.testController, csWatched),
      csBefore,
      'running the F# namespace runs THAT selection — the C# results may not move',
    );
    for (const id of fsLeaves) {
      const result = api.testController.getResult(id);
      assert.ok(
        result !== undefined && result.outcome !== 'notRun',
        `▶ on the namespace node must produce a real outcome for ${id}: ${JSON.stringify(result)}`,
      );
    }
    assert.strictEqual(
      api.testController.getResult(FS_FIXTURE.passing)?.outcome,
      'passed',
      'the namespace run reports the passing F# fact as passed',
    );
    assert.strictEqual(
      api.testController.getResult(FS_FACT_SPACED)?.outcome,
      'passed',
      'the spaced backtick F# test survives the run under its spaced name',
    );
    assert.strictEqual(
      api.testController.getResult(FS_FIXTURE.failing)?.outcome,
      'failed',
      'the namespace run reports the failing F# fact as failed',
    );
    assert.strictEqual(
      api.testController.getResult(FS_FIXTURE.skipped)?.outcome,
      'skipped',
      'the namespace run reports the skipped F# fact as skipped',
    );

    // Interaction 4 — the F# theory whose rows DISAGREE reports ONCE, as its
    // worst row: [TEST-RUN-TRX] merges the per-row TRX entries sharing an FQN.
    const mixed = api.testController.getResult(FS_MIXED_THEORY);
    assert.ok(mixed, `the F# mixed-row theory must report an outcome under ${FS_MIXED_THEORY}`);
    assert.strictEqual(
      mixed.outcome,
      'failed',
      'a theory with one failing row is a FAILING test, however many rows passed',
    );
    assert.strictEqual(
      fsLeaves.filter((id) => id === FS_MIXED_THEORY).length,
      1,
      'and it occupies ONE row in the tree, not one per row of data',
    );
    assert.deepStrictEqual(
      fsLeaves
        .map((id) => api.testController.getResult(id)?.message ?? '')
        .filter((message) => message.includes('No result reported')),
      [],
      'a SPACE in a fully-qualified name must not cost the test its result',
    );
    assert.ok(
      (api.testController.getResult(FS_FACT_SPACED)?.duration ?? -1) >= 0,
      'the spaced F# test carries its own measured duration',
    );
  });

  test('a folder with several projects and NO loaded solution explains itself instead of going blank', async function () {
    this.timeout(DOTNET_CLI_MS);
    // The exact case from the extension log: with no solution loaded, discovery
    // targets the workspace folder, `dotnet test` answers MSB1011 (“this folder
    // contains more than one project or solution file”), and the user got a
    // silent empty view. The tree must carry a USEFUL error instead.
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(folder, 'the test host must open a workspace folder for this case');
    await drainDiscovery(() => {
      api.explorerProvider.clear();
    }, api.testController);
    api.testController.items.replace([]);
    await assert.doesNotReject(async () => {
      await api.testController.activateAndDiscover();
    }, 'ambiguous-folder discovery must not reject');
    const failure = await awaitSingleErrorRow();
    const failureRoots: vscode.TestItem[] = [];
    api.testController.items.forEach((item) => failureRoots.push(item));
    assert.strictEqual(
      failureRoots.length,
      1,
      `one error row for the ambiguous folder, got: ${failureRoots
        .map((item) => item.label)
        .join(' | ')}`,
    );
    assert.notStrictEqual(
      failure.error,
      undefined,
      'the row carries an error for the view to render',
    );
    const message = errorTextOf(failure);
    assert.ok(
      message.includes('MSB1011'),
      `the error must carry the REAL dotnet diagnostic, not a shrug: ${message.slice(0, 400)}`,
    );
    assert.ok(
      /more than one project/i.test(message),
      `and say what is actually wrong with the folder: ${message.slice(0, 400)}`,
    );
    assert.ok(
      /select solution/i.test(message),
      `and offer the remedy — load one solution: ${message.slice(0, 400)}`,
    );
    assert.strictEqual(failure.children.size, 0, 'the error row is a leaf');
    assert.deepStrictEqual(
      collectLeafIds(api.testController.items).filter((id) => EXPECTED_SET.has(id)),
      [],
      'no tests are invented for a folder that could not be enumerated',
    );
    // Recovery: loading a solution makes the error row vanish and the full
    // hierarchy appear — the user's exact escape route from the message.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await pollUntilDiscovered(api.testController, EXPECTED);
    const leaves = assertHierarchyTree(api.testController.items);
    assertExactTree(leaves, 'recovery from the ambiguous folder');
    const errorsAfter: string[] = [];
    api.testController.items.forEach(function collect(item) {
      if (item.error !== undefined) errorsAfter.push(item.id);
      item.children.forEach(collect);
    });
    assert.deepStrictEqual(errorsAfter, [], 'the MSB1011 error row is gone after recovery');
  });

  test('a project that fails to BUILD surfaces the compiler error in the tree, and ▶ fabricates nothing', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    // The other real failure shape: `dotnet test --list-tests` dies on a compile
    // error. The tree must show the compiler diagnostic itself, so the user
    // fixes the build instead of wondering where the tests went.
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-broken-'));
    let brokenSln: string;
    try {
      const brokenDir = writeProject(
        path.join(brokenRoot, 'Broken'),
        'Broken.csproj',
        projectXml(CS.packages),
        'Broken.cs',
        'namespace Cs.Broken { class CalculatorTests { void } }',
      );
      brokenSln = await createSolution(brokenRoot, 'Broken', [brokenDir]);
      api.testController.items.replace([]);
      await api.explorerProvider.loadSolution(brokenSln);
      await api.testController.activateAndDiscover();
      const failure = await awaitSingleErrorRow();
      const failureRoots: vscode.TestItem[] = [];
      api.testController.items.forEach((item) => failureRoots.push(item));
      assert.strictEqual(
        failureRoots.length,
        1,
        `one error row for the broken build, got: ${failureRoots
          .map((item) => item.label)
          .join(' | ')}`,
      );
      assert.notStrictEqual(failure.error, undefined, 'the row carries an error');
      const message =
        failure.error instanceof vscode.MarkdownString
          ? failure.error.value
          : String(failure.error);
      assert.ok(
        /error CS\d+/.test(message),
        `the error must carry the COMPILER diagnostic (error CS…), not a generic failure: ${message.slice(
          0,
          400,
        )}`,
      );
      assert.strictEqual(failure.children.size, 0, 'the error row is a leaf');
      assert.deepStrictEqual(
        collectLeafIds(api.testController.items).filter((id) => EXPECTED_SET.has(id)),
        [],
        'no tests are invented for a project that cannot build',
      );
      // ▶ gestures on an error-only tree must neither crash nor fabricate
      // results: there is nothing runnable to report.
      await assert.doesNotReject(async () => {
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, []);
      }, 'run-all on an error-only tree must not reject');
      await assert.doesNotReject(async () => {
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [failure]);
      }, '▶ on the error row itself must not reject');
      assert.strictEqual(
        api.testController.getResult(failure.id),
        undefined,
        'no cached result is fabricated for an error row',
      );
      assert.strictEqual(
        api.testController.items.size,
        1,
        'the tree still holds the error row — runs neither consumed nor mutated it',
      );
    } finally {
      await teardownFixtureSolution(api, brokenRoot, removeDirRecursive);
    }
    // Recovery: the real solution refills the full hierarchy afterwards.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await pollUntilDiscovered(api.testController, EXPECTED);
    assertExactTree(
      assertHierarchyTree(api.testController.items),
      'recovery from the broken build',
    );
  });
});
