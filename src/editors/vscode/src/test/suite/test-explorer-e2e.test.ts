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
import {
  batchAssemblies,
  isDiscoveredTestLine,
  listTests,
  parseAnnouncedAssemblies,
  parseFullyQualifiedTestList,
  parseTestAssemblies,
  parseTestList,
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
  activateTestExplorer,
  collectItemIds,
  drainDiscovery,
  findItem,
  pollForIds,
  pollUntilDiscovered,
  runViaProfile,
  snapshotItems,
  type TestItemSnapshot,
} from './test-explorer-kit';
import { comparablePath, removeDirRecursive } from './test-helpers.js';
import { DOTNET_CLI_MS, FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';

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

/** Ordinal sort with an explicit comparator, for set-equality assertions. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

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

/** Every leaf id anywhere under `items` — tests only, no group nodes. */
function leafIds(items: vscode.TestItemCollection): string[] {
  const ids: string[] = [];
  items.forEach((item) => {
    if (item.children.size === 0) ids.push(item.id);
    else ids.push(...leafIds(item.children));
  });
  return ids;
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
    assert.strictEqual(
      id.length > 0,
      true,
      'an empty id would render as a blank row in the Testing view',
    );
    for (const noise of CHATTER)
      assert.strictEqual(
        id.includes(noise),
        false,
        `VSTest chatter '${noise}' must never become a test item: '${id}'`,
      );
  }
}

/** The settled tree is EXACTLY the fixtures' eleven names, each exactly once. */
function assertExactTree(ids: readonly string[], where: string): void {
  for (const name of EXPECTED) {
    assert.strictEqual(
      ids.includes(name),
      true,
      `${where}: must be discovered — ${name}\ngot: ${ids.join(', ')}`,
    );
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

/** Every property one leaf item exposes, asserted against its own FQN. */
function assertLeafItem(items: vscode.TestItemCollection, id: string): vscode.TestItem {
  const item = findItem(items, id);
  assert.ok(item, `findItem must resolve ${id}`);
  assert.strictEqual(item.id, id, `the id is the fully-qualified name, verbatim: ${id}`);
  assert.strictEqual(
    item.label,
    id.split('.').at(-1),
    `the label is the last dotted segment of ${id}`,
  );
  assert.strictEqual(item.description, id, `the description is the whole FQN for ${id}`);
  assert.strictEqual(item.canResolveChildren, false, `a leaf test resolves no children: ${id}`);
  assert.strictEqual(item.children.size, 0, `${id} must have no children`);
  assert.strictEqual(item.error, undefined, `${id} must not carry a discovery error`);
  assert.strictEqual(item.tags.length, 0, `${id} carries no framework tag`);
  return item;
}

/** Every property a discovered item hands the Testing view. */
function assertSnapshot(snapshot: TestItemSnapshot, anchor: string): void {
  assert.strictEqual(
    snapshot.description,
    snapshot.id,
    `the description must carry the whole FQN so same-named methods stay distinct: ${snapshot.id}`,
  );
  assert.strictEqual(
    snapshot.label,
    snapshot.id.split('.').at(-1),
    `the label must be the last dotted segment of ${snapshot.id}`,
  );
  assert.strictEqual(snapshot.label.length > 0, true, `${snapshot.id} must have a non-empty label`);
  assert.strictEqual(
    snapshot.id.endsWith(snapshot.label),
    true,
    `${snapshot.id} must end with the label the tree renders`,
  );
  assert.strictEqual(snapshot.childCount, 0, `discovery produces a flat tree: ${snapshot.id}`);
  assert.deepStrictEqual(
    snapshot.tags,
    [],
    `a plain xUnit test carries no framework tag: ${snapshot.id}`,
  );
  assert.strictEqual(
    typeof snapshot.uriPath,
    'string',
    `${snapshot.id} must carry a uri for the editor to reveal`,
  );
  assert.strictEqual(
    comparablePath(snapshot.uriPath ?? ''),
    comparablePath(anchor),
    `${snapshot.id} must be anchored at the discovery target's directory`,
  );
}

/** One `Test run for <dll>` banner, asserted to name a real built assembly. */
function assertAnnouncedAssembly(assembly: string, anchor: string): void {
  assert.strictEqual(path.isAbsolute(assembly), true, `${assembly} must be an absolute path`);
  assert.strictEqual(
    fs.existsSync(assembly),
    true,
    `${assembly} must exist on disk — the project really built`,
  );
  assert.strictEqual(
    path.extname(assembly),
    '.dll',
    `${assembly} must name a managed assembly, not a truncated prefix`,
  );
  assert.strictEqual(
    assembly.includes('(.NETCoreApp'),
    false,
    `the framework suffix must be stripped from ${assembly}`,
  );
  assert.strictEqual(
    assembly.includes('Version=v'),
    false,
    `no part of the framework moniker may survive: ${assembly}`,
  );
  assert.strictEqual(assembly.trim(), assembly, `${assembly} must not carry banner padding`);
  assert.strictEqual(
    path.basename(path.dirname(assembly)),
    'net10.0',
    `${assembly} must sit in its target-framework output directory`,
  );
  assert.strictEqual(
    comparablePath(assembly).startsWith(comparablePath(anchor)),
    true,
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

suite('Test Explorer e2e — real C#/F# discovery', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let csProjDir: string;
  let fsProjDir: string;
  let listing: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testexplorer-'));
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
    // Drain reactive re-discovery BEFORE deleting the fixture: a `dotnet test`
    // pointed at a removed directory hangs forever and poisons later runs.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('activating the Test Explorer discovers every C# AND F# test in the loaded solution', async function () {
    this.timeout(DOTNET_CLI_MS);
    assert.strictEqual(
      EXPECTED.length,
      11,
      'the two xUnit fixtures expose eleven fully-qualified names — four facts and two theories each in F#, three and two in C#',
    );
    assert.strictEqual(
      new Set(EXPECTED).size,
      11,
      'no fixture may claim a name the other already owns',
    );
    api.testController.items.replace([]);
    assert.deepStrictEqual(
      collectItemIds(api.testController.items),
      [],
      'the tree starts empty, so everything below was discovered HERE',
    );
    assert.strictEqual(
      api.testController.items.size,
      0,
      'clearing the tree empties the controller collection itself',
    );
    // The bug scenario: a solution is loaded and the user opens the Testing view.
    // That is the recovery from "No tests have been found in this workspace yet".
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    // Loading also schedules a DEBOUNCED sweep that supersedes the explicit one
    // (`discoverGeneration`), so assert on the SETTLED tree, not the first read.
    const ids = await pollUntilDiscovered(api.testController, EXPECTED);
    assertExactTree(ids, 'activateAndDiscover');
    assert.strictEqual(
      ids.includes(FS_FACT_SPACED),
      true,
      `the idiomatic F# backtick test (spaces in its FQN) must be discovered: ${FS_FACT_SPACED}`,
    );
    assert.strictEqual(
      ids.includes(FS_MIXED_THEORY),
      true,
      `an F# theory whose rows DISAGREE is still one discovered name: ${FS_MIXED_THEORY}`,
    );
    assert.strictEqual(
      ids.includes(CS_MIXED_THEORY),
      true,
      `a C# theory whose rows DISAGREE is still one discovered name: ${CS_MIXED_THEORY}`,
    );
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
    assert.strictEqual(
      api.testController.items.size,
      11,
      'the flat tree has eleven ROOT items, so nothing was nested under a phantom parent',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      api.testController.items.size,
      'a flat tree collects exactly as many ids as it has roots',
    );
  });

  test('every discovered item carries the label, description, uri and tags the tree renders', async function () {
    this.timeout(DOTNET_CLI_MS);
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    assertExactTree(
      await pollUntilDiscovered(api.testController, EXPECTED),
      'item-shape discovery',
    );
    const snapshots = snapshotItems(api.testController.items);
    const labels = snapshots.map((snapshot) => snapshot.label);
    assert.strictEqual(
      snapshots.length,
      11,
      `one snapshot per discovered test, got ${snapshots.length}`,
    );
    assert.deepStrictEqual(
      sorted(snapshots.map((snapshot) => snapshot.id)),
      sorted(EXPECTED),
      'the rendered rows are exactly the fixtures’ eleven names',
    );
    for (const snapshot of snapshots) assertSnapshot(snapshot, root);
    assert.deepStrictEqual(
      snapshots.flatMap((snapshot) => snapshot.tags),
      [],
      'plain xUnit tests carry no framework tag anywhere in the tree — that tag is reserved for Expecto/FsCheck naming',
    );
    assert.strictEqual(
      new Set(snapshots.map((snapshot) => snapshot.uriPath)).size,
      1,
      'every item shares the one discovery-target uri',
    );
    assert.strictEqual(
      new Set(snapshots.map((snapshot) => snapshot.description)).size,
      11,
      'descriptions stay unique — that is WHY the description carries the whole FQN',
    );
    assert.strictEqual(
      snapshots.reduce((sum, snapshot) => sum + snapshot.childCount, 0),
      0,
      'a flat tree has no children at all',
    );
    assert.deepStrictEqual(
      sorted(labels),
      sorted(EXPECTED.map((name) => name.split('.').at(-1) ?? '')),
      'the rendered labels are exactly the last dotted segment of each name',
    );
    assert.strictEqual(
      labels.filter((label) => label === 'mixed theory').length,
      1,
      'the F# mixed theory renders one row, not one per disagreeing row',
    );
    assert.strictEqual(
      labels.filter((label) => label === 'Mixed_Theory').length,
      1,
      'the C# mixed theory likewise renders exactly one row',
    );
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
    assert.strictEqual(
      spaced.id.includes('`'),
      false,
      'F# backticks are source syntax, never part of the FQN',
    );
    assert.strictEqual(
      comparablePath(spaced.uri?.fsPath ?? ''),
      comparablePath(root),
      'the spaced F# test is revealed inside the solution directory',
    );
    for (const expected of EXPECTED) assertLeafItem(api.testController.items, expected);
    assert.strictEqual(
      findItem(api.testController.items, 'Cs.Xunit.Fixtures.CalculatorTests.Nope'),
      undefined,
      'findItem must never invent an item for an unknown id',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      11,
      'a lookup that matched nothing must not disturb the discovered tree',
    );
  });

  test('once active, loading a solution reactively re-populates the tree with no manual refresh', async function () {
    this.timeout(DOTNET_CLI_MS);
    // Activate the Test Explorer as opening the Testing view would.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    assertExactTree(
      await pollUntilDiscovered(api.testController, EXPECTED),
      'the activating sweep',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      11,
      'the activating sweep left eleven items standing to be cleared',
    );
    // The reactive contract: clear + reload with NO manual discovery call.
    api.testController.items.replace([]);
    api.explorerProvider.clear();
    assert.deepStrictEqual(
      collectItemIds(api.testController.items),
      [],
      'the tree really is empty before the reactive reload',
    );
    assert.strictEqual(
      api.testController.items.size,
      0,
      'clearing empties the controller collection itself',
    );
    assert.strictEqual(
      findItem(api.testController.items, FS_FIXTURE.passing),
      undefined,
      'no item survives the clear, not even by id lookup',
    );
    await api.explorerProvider.loadSolution(slnPath);
    const discovered = await pollForIds(api.testController, (ids) =>
      EXPECTED.every((name) => ids.includes(name)),
    );
    assertExactTree(discovered, 'the reactive reload');
    assert.strictEqual(
      discovered.includes(FS_FIXTURE.passing),
      true,
      'F# must be re-discovered reactively after a load, with no refresh press',
    );
    assert.strictEqual(
      discovered.includes(CS.passing),
      true,
      'C# must be re-discovered reactively after a load, with no refresh press',
    );
    assert.strictEqual(
      discovered.includes(FS_FACT_SPACED),
      true,
      'the spaced F# name survives the reactive path too',
    );
    assert.strictEqual(
      api.testController.items.size,
      11,
      'the reactively rebuilt tree has the same eleven roots',
    );
    assert.deepStrictEqual(
      sorted(discovered),
      sorted(EXPECTED),
      'the reactively rebuilt tree is EXACTLY the fixtures’ eleven names — with no refresh press anywhere',
    );
    assert.strictEqual(
      discovered.length,
      11,
      `the reactive sweep must not lose a name: ${discovered.join(', ')}`,
    );
    assert.strictEqual(
      new Set(discovered).size,
      11,
      'a reload must REPLACE the tree, never append a second copy of every id',
    );
    assert.strictEqual(
      discovered.includes(FS_MIXED_THEORY),
      true,
      `the F# mixed theory comes back too: ${FS_MIXED_THEORY}`,
    );
    assert.strictEqual(
      discovered.includes(CS_MIXED_THEORY),
      true,
      `and the C# mixed theory: ${CS_MIXED_THEORY}`,
    );
    assert.strictEqual(
      discovered.filter((id) => id.startsWith('Fs.')).length,
      6,
      'F# leads the reactive tree with six of the eleven names',
    );
    assert.strictEqual(
      discovered.filter((id) => id.startsWith('Cs.')).length,
      5,
      'C# contributes the remaining five',
    );
    const reloaded = snapshotItems(api.testController.items);
    assert.deepStrictEqual(
      sorted(reloaded.map((snapshot) => snapshot.id)),
      sorted(EXPECTED),
      'the rendered rows match the reactively rebuilt tree, one for one',
    );
    assert.strictEqual(
      new Set(reloaded.map((snapshot) => snapshot.uriPath)).size,
      1,
      'every reactively rebuilt item is re-anchored at the one discovery target',
    );
    assertLeafItem(api.testController.items, FS_MIXED_THEORY);
    assertLeafItem(api.testController.items, CS_MIXED_THEORY);
    for (const snapshot of reloaded) assertSnapshot(snapshot, root);
  });

  test('VS Code’s own refresh affordance re-runs discovery through the controller', async function () {
    this.timeout(DOTNET_CLI_MS);
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    assertExactTree(
      await pollUntilDiscovered(api.testController, EXPECTED),
      'the pre-refresh sweep',
    );
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      11,
      'the pre-refresh sweep left eleven items standing to be cleared',
    );
    api.testController.items.replace([]);
    assert.deepStrictEqual(
      collectItemIds(api.testController.items),
      [],
      'the tree is empty, so the refresh below is what refills it',
    );
    assert.strictEqual(api.testController.items.size, 0, 'the controller collection is empty too');
    // `testing.refreshTests` is the command bound to the ⟳ button in the Testing
    // view; it reaches the controller's refreshHandler.
    const commands = await vscode.commands.getCommands(true);
    assert.strictEqual(
      commands.includes('testing.refreshTests'),
      true,
      'the workbench must expose testing.refreshTests — the ⟳ button’s command',
    );
    assert.strictEqual(
      commands.filter((command) => command === 'testing.refreshTests').length,
      1,
      'the refresh command is registered exactly once',
    );
    await vscode.commands.executeCommand('testing.refreshTests');
    const refreshed = await pollUntilDiscovered(api.testController, EXPECTED);
    assertExactTree(refreshed, 'testing.refreshTests');
    assert.strictEqual(api.testController.items.size, 11, 'the refresh rebuilt all eleven roots');
    assert.deepStrictEqual(
      sorted(refreshed),
      sorted(EXPECTED),
      'the ⟳ button restores EXACTLY the fixtures’ eleven names',
    );
    assert.strictEqual(
      refreshed.length,
      11,
      `the refresh must restore every name: ${refreshed.join(', ')}`,
    );
    assert.strictEqual(
      new Set(refreshed).size,
      11,
      'a refresh REPLACES the tree — it must never append a second copy of every id',
    );
    assert.strictEqual(
      refreshed.includes(FS_FACT_SPACED),
      true,
      `the spaced F# name comes back through the refresh handler: ${FS_FACT_SPACED}`,
    );
    assert.strictEqual(
      refreshed.includes(FS_MIXED_THEORY),
      true,
      `so does the F# mixed theory: ${FS_MIXED_THEORY}`,
    );
    assert.strictEqual(
      refreshed.includes(CS_MIXED_THEORY),
      true,
      `and the C# mixed theory: ${CS_MIXED_THEORY}`,
    );
    assert.strictEqual(
      refreshed.filter((id) => id.startsWith('Fs.')).length,
      6,
      'F# keeps its six names across a refresh',
    );
    assert.strictEqual(
      refreshed.filter((id) => id.startsWith('Cs.')).length,
      5,
      'C# keeps its five',
    );
    const restored = snapshotItems(api.testController.items);
    assert.deepStrictEqual(
      sorted(restored.map((snapshot) => snapshot.label)),
      sorted(EXPECTED.map((name) => name.split('.').at(-1) ?? '')),
      'every restored row renders its own label again',
    );
    assert.strictEqual(
      new Set(restored.map((snapshot) => snapshot.description)).size,
      11,
      'and its own description — the refresh did not collapse two rows into one',
    );
    for (const snapshot of restored) assertSnapshot(snapshot, root);
    assertLeafItem(api.testController.items, FS_FACT_SPACED);
    assertLeafItem(api.testController.items, CS.parameterized);
  });

  test('the discovery parsers read a REAL multi-project listing, banners included', function () {
    this.timeout(FAST_MS);
    // `listing` is the real `dotnet test --list-tests` output captured in
    // suiteSetup: two projects, two banners, and the chatter between them.
    assert.strictEqual(
      listing.length > 0,
      true,
      'suiteSetup must have captured a real listing to parse',
    );
    assert.strictEqual(
      listing.includes('Test run for '),
      true,
      'the captured listing must carry the banners this parser reads',
    );
    assert.strictEqual(
      listing.includes('(.NETCoreApp,Version=v10.0)'),
      true,
      'the captured banners must carry the framework moniker that has to be stripped',
    );
    const announced = parseAnnouncedAssemblies(listing);
    assert.strictEqual(announced.length, 2, `one banner per project: ${announced.join(', ')}`);
    assert.strictEqual(
      new Set(announced).size,
      2,
      'a repeated banner is de-duplicated, never double-counted',
    );
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
    assert.strictEqual(
      displayNames.includes(CS.passing),
      true,
      'an xUnit C# display name equals its FQN',
    );
    assert.strictEqual(
      displayNames.includes(FS_FACT_SPACED),
      true,
      'the spaced F# name survives the filter — spaces are legal in an FQN',
    );
    for (const theory of [
      FS_FIXTURE.parameterized,
      FS_MIXED_THEORY,
      CS.parameterized,
      CS_MIXED_THEORY,
    ]) {
      assert.strictEqual(
        displayNames.includes(theory),
        false,
        `a theory's display name carries ROW ARGUMENTS, so the bare ${theory} is absent from the listing`,
      );
    }
    assert.strictEqual(
      displayNames.length < EXPECTED.length,
      true,
      `the display listing (${displayNames.length}) must be strictly WEAKER than the FQN tree (${EXPECTED.length})`,
    );
    assert.strictEqual(
      displayNames.some((name) => name.includes('Test run for')),
      false,
      'banners are never test names',
    );
    assert.strictEqual(
      displayNames.some((name) => name.includes('The following')),
      false,
      'the "The following Tests are available:" header is never a test name',
    );
    assert.strictEqual(
      displayNames.some((name) => name.includes(':')),
      false,
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
    assert.strictEqual(
      isDiscoveredTestLine('Ns.Class.Method'),
      true,
      'a dotted identifier is a display name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Ns.Module.adds two numbers'),
      true,
      'an F# backtick name carries SPACES and is still a display name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('NoDotHere'),
      false,
      'a bare member name has no namespace and could never be filtered on',
    );
    assert.strictEqual(
      isDiscoveredTestLine('C:\\repo\\a.dll'),
      false,
      'a Windows path is not a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('/repo/a.dll'),
      false,
      'a POSIX path is not a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Proj -> C:\\out\\a.dll'),
      false,
      'the MSBuild output mapping is not a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Ns.Class.Method(a: 1)'),
      false,
      "a theory's row arguments carry `(` and `:`, so the row is not a name",
    );
    assert.strictEqual(
      isDiscoveredTestLine('Test run for x.dll'),
      false,
      'the assembly banner is not a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Passed!  - Failed: 0'),
      false,
      'the run summary is not a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Build succeeded.'),
      false,
      'build chatter is not a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Determining projects to restore...'),
      false,
      'restore chatter is not a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('at System.Reflection.MethodBaseInvoker.Invoke'),
      false,
      'a managed STACK FRAME is dotted-identifier shaped and must still be rejected, or a crash looks like an enumeration',
    );
    for (const name of DISPLAY_NAMES)
      assert.strictEqual(
        isDiscoveredTestLine(name),
        true,
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
      assert.strictEqual(
        width <= 24_000,
        true,
        `a batch of ${batch.length} assemblies is ${width} characters — over the command-line budget`,
      );
      assert.strictEqual(
        batch.length > 0,
        true,
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

  test('a discovery target that is not on disk yields no items and never throws', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ghost = path.join(root, 'NoSuchSolution.slnx');
    assert.strictEqual(fs.existsSync(ghost), false, 'the fixture must not accidentally exist');
    // The enumerator itself: never an exception, and an EMPTY result it marks
    // untrustworthy so the caller keeps whatever tree it already had.
    const listed = await listTests(ghost);
    assert.deepStrictEqual(listed.names, [], 'a missing target enumerates no names');
    assert.strictEqual(
      listed.ok,
      false,
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
    assert.deepStrictEqual(
      collectItemIds(api.testController.items),
      [],
      'a missing target contributes no test items',
    );
    assert.strictEqual(
      api.testController.items.size,
      0,
      'and leaves the controller collection empty',
    );
    assert.strictEqual(
      findItem(api.testController.items, CS.passing),
      undefined,
      'no stale item survives a failed sweep over an empty tree',
    );
    // And the extension recovers: pointing back at the real solution refills it.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    const recovered = await pollUntilDiscovered(api.testController, EXPECTED);
    assertExactTree(recovered, 'recovery after a missing target');
    assert.strictEqual(api.testController.items.size, 11, 'recovery rebuilds all eleven roots');
    assert.strictEqual(
      recovered.includes(FS_FIXTURE.passing),
      true,
      'F# is rediscovered after the failed sweep',
    );
    assert.strictEqual(
      recovered.includes(CS.passing),
      true,
      'C# is rediscovered after the failed sweep',
    );
    for (const snapshot of snapshotItems(api.testController.items)) assertSnapshot(snapshot, root);
    assertLeafItem(api.testController.items, FS_FACT_SPACED);
  });

  test('the solution the fixture builds is the shape the CLI produces, not a hand-written one', async function () {
    this.timeout(FAST_MS);
    // Structured files are never authored by hand ([CLAUDE.md]): the solution is
    // `dotnet new sln` + `dotnet sln add` and the projects come out of an XML
    // serializer, so both are asserted against a real parse.
    assert.strictEqual(fs.existsSync(slnPath), true, `${slnPath} must exist`);
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
    assert.strictEqual(
      solutionText.startsWith('<Solution>'),
      true,
      `a .slnx is an XML document rooted at <Solution>: ${solutionText}`,
    );
    assert.strictEqual(
      solutionText.trimEnd().endsWith('</Solution>'),
      true,
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
    assert.strictEqual(
      projectPaths.every((entry) => entry.endsWith(`/${path.posix.basename(entry)}`)),
      true,
      'every project is referenced through its own directory, not from the solution root',
    );
    assert.strictEqual(
      projectPaths.some((entry) => entry.includes(`${CS.projectName}/${CS.projectFileName}`)),
      true,
      `the C# project is wired in as ${CS.projectName}/${CS.projectFileName}`,
    );
    assert.strictEqual(
      projectPaths.some((entry) =>
        entry.includes(`${FS_FIXTURE.projectName}/${FS_FIXTURE.projectFileName}`),
      ),
      true,
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
    assert.strictEqual(
      fsprojText.indexOf('<Compile') < fsprojText.indexOf('<PackageReference'),
      true,
      'the Compile ItemGroup precedes the packages, as MSBuild reads it',
    );
    assert.strictEqual(
      csprojText.includes('<Compile'),
      false,
      'a C# project must NOT declare compile order — the SDK globs it',
    );
    for (const pkg of CS.packages) {
      assert.strictEqual(
        csprojText.includes(`<PackageReference Include="${pkg.id}" Version="${pkg.version}"/>`),
        true,
        `${pkg.id} must be a pinned PackageReference in the C# project`,
      );
      assert.strictEqual(
        fsprojText.includes(`<PackageReference Include="${pkg.id}" Version="${pkg.version}"/>`),
        true,
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

  test('every test sits exactly at Assembly → Namespace → Class → Test in the tree', async function () {
    this.timeout(DOTNET_CLI_MS);
    // The reported bug: after discovery the Testing view dumps every test as a
    // FLAT list — a real solution's 816 tests land as one unscrollable wall at
    // the bottom of the view. The tree must group them per the documented
    // hierarchy: Assembly Name → Namespace → Test Class → Test Name.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await pollUntilDiscovered(api.testController, EXPECTED);

    // Exactly two ROOT items — one per test ASSEMBLY the solution built — and
    // neither is a test: a group id handed to a --filter would match nothing.
    const roots: vscode.TestItem[] = [];
    api.testController.items.forEach((item) => roots.push(item));
    assert.strictEqual(
      roots.length,
      2,
      `one root per test project, got: ${roots.map((item) => item.label).join(' | ')}`,
    );
    assert.deepStrictEqual(
      sorted(roots.map((root) => root.label)),
      [CS.projectName, FS_FIXTURE.projectName],
      'the roots are the ASSEMBLY names (XunitCs, XunitFs), not a flat dump of every FQN',
    );
    const fqnSet = new Set<string>(EXPECTED);
    for (const root of roots) {
      assert.strictEqual(
        fqnSet.has(root.id),
        false,
        `a root group must not carry a test's FQN as its id: ${root.id}`,
      );
      assert.strictEqual(
        root.canResolveChildren,
        true,
        `an assembly root declares its children so the view offers the expander: ${root.label}`,
      );
    }

    // EVERY FQN must resolve to a node at EXACTLY depth 4, along the path its
    // own dotted segments prescribe: Assembly → Namespace → Class → Test.
    // parts[-1] is the test, parts[-2] the class, the rest the namespace — the
    // same split for a dotted F# module (`Fs.Xunit.Fixtures` → `Fs.Xunit` +
    // `Fixtures`) as for a C# namespace, and the backtick test stays ONE leaf.
    for (const fqn of EXPECTED) {
      const parts = fqn.split('.');
      const assemblyLabel = fqn.startsWith('Cs.') ? CS.projectName : FS_FIXTURE.projectName;
      const namespaceLabel = parts.slice(0, -2).join('.');
      const classLabel = parts.at(-2) ?? '';
      const testLabel = parts.at(-1) ?? '';

      const root = roots.find((candidate) => candidate.label === assemblyLabel);
      assert.ok(root, `depth 1 — the assembly root ${assemblyLabel} for ${fqn}`);
      const nsNode = childByLabel(root.children, namespaceLabel);
      assert.ok(
        nsNode,
        `depth 2 — the namespace node ${namespaceLabel} under ${assemblyLabel}; saw: ${
          [...root.children].map(([, item]) => item.label).join(' | ') || '(nothing)'
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
      assert.strictEqual(
        leaf.id,
        fqn,
        `the leaf's id is the fully-qualified name, verbatim: expected ${fqn}`,
      );
      assert.strictEqual(
        leaf.children.size,
        0,
        `a test is a LEAF — nothing nests under it: ${fqn}`,
      );
      for (const group of [root, nsNode, classNode]) {
        assert.strictEqual(
          group.children.size > 0,
          true,
          `a group node is never empty: ${group.label}`,
        );
        assert.strictEqual(
          group.canResolveChildren,
          true,
          `a group declares its children so the view offers the expander: ${group.label}`,
        );
      }
    }

    // Level purity, across the WHOLE tree — not just the walked paths: roots
    // hold only namespaces, namespaces only classes, classes only tests.
    const namespaceLabels: string[] = [];
    const classLabels: string[] = [];
    const leafLabels: string[] = [];
    for (const root of roots) {
      root.children.forEach((nsNode) => {
        assert.strictEqual(
          nsNode.children.size > 0,
          true,
          `a test must never sit DIRECTLY under its assembly root: ${nsNode.label}`,
        );
        namespaceLabels.push(nsNode.label);
        nsNode.children.forEach((classNode) => {
          assert.strictEqual(
            classNode.children.size > 0,
            true,
            `a test must never sit DIRECTLY under a namespace node: ${classNode.label}`,
          );
          classLabels.push(classNode.label);
          classNode.children.forEach((leaf) => {
            assert.strictEqual(
              leaf.children.size,
              0,
              `nothing may nest DEEPER than a test: ${leaf.id}`,
            );
            leafLabels.push(leaf.id);
          });
        });
      });
    }
    // The leaves are EXACTLY the eleven FQNs — grouping added structure
    // without losing, duplicating or renaming a single test.
    assert.deepStrictEqual(
      sorted(leafLabels),
      sorted(EXPECTED),
      'every test is a leaf exactly once, at depth 4 and nowhere else',
    );
    assert.deepStrictEqual(
      sorted(namespaceLabels),
      ['Cs.Xunit.Fixtures', 'Fs.Xunit'],
      'one namespace group per assembly, split from the FQNs themselves',
    );
    assert.deepStrictEqual(
      sorted(classLabels),
      ['CalculatorTests', 'Fixtures'],
      'one class group per namespace, split from the FQNs themselves',
    );
    assertLeafItem(api.testController.items, CS.passing);
    assertLeafItem(api.testController.items, FS_FIXTURE.passing);

    // The ▶ gesture on a CLASS group: the run must expand to the class's leaf
    // tests, not filter on the group's own id (which matches no test).
    const csRoot = roots.find((root) => root.label === CS.projectName);
    const csClass = childByLabel(childByLabel(csRoot?.children ?? api.testController.items, 'Cs.Xunit.Fixtures')?.children ?? api.testController.items, 'CalculatorTests');
    assert.ok(csClass, 'the C# class group resolves for the ▶ gesture');
    const csLeaves: string[] = [];
    csClass.children.forEach((leaf) => csLeaves.push(leaf.id));
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [csClass]);
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
  });
});
