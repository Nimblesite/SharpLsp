// The Test Explorer's REACTIVITY: the tree must follow the world without the user
// ever pressing refresh. A stale tree still renders — it just shows yesterday's
// tests — so this suite asserts what a stale tree gets wrong: the solution CHANGES,
// a BURST arrives (one sweep only), a SOURCE FILE gains or loses a test, a PROJECT
// joins or leaves, a `dotnet` failure must NOT blank a populated tree, racing sweeps
// must not double-insert. Real xUnit C# built by the real `dotnet` CLI, driven
// through the ALREADY-ACTIVATED controller. Covers [TEST-DISCOVERY-FQN].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import type { SharpLspTestController } from '../../testing.js';
import {
  XUNIT_PACKAGES,
  createSolution,
  dotnet,
  projectXml,
  warmDiscovery,
  writeProject,
} from './dotnet-project-kit';
import { fixtureFor } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  discoverSolution,
  drainDiscovery,
  findItem,
  pollForIds,
  pollUntilDiscovered,
  snapshotItems,
} from './test-explorer-kit';
import { comparablePath, removeDirRecursive } from './test-helpers.js';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

const CS = fixtureFor('xunit-csharp');
/** The xUnit C# mixed theory, literal so `suiteSetup` can prove the fixture agrees. */
const CS_MIXED_THEORY = 'Cs.Xunit.Fixtures.CalculatorTests.Mixed_Theory';

/** Exactly the FQNs the xUnit C# fixture exposes — theory rows collapse to one. */
const EXPECTED = [CS.passing, CS.failing, CS.skipped, CS.parameterized, CS_MIXED_THEORY] as const;

const labelOf = (fqn: string): string => fqn.split('.').at(-1) ?? fqn;

const EXTRA_PROJECT = 'ExtraCs';
const EXTRA_SOURCE = `using Xunit;

namespace Cs.Extra.Fixtures
{
    public class ExtraTests
    {
        [Fact] public void Multiplies_TwoNumbers() => Assert.Equal(6, 2 * 3);
        [Fact] public void Divides_TwoNumbers() => Assert.Equal(2, 6 / 3);
    }
}
`;
const EXTRA = 'Cs.Extra.Fixtures.ExtraTests';
const EXTRA_TESTS = [`${EXTRA}.Multiplies_TwoNumbers`, `${EXTRA}.Divides_TwoNumbers`] as const;

/** The [Fact] the source-edit test adds, and the FQN it must produce. */
const ADDED_FACT = '        [Fact] public void Adds_Reactively() => Assert.Equal(5, 2 + 3);';
const ADDED_FQN = 'Cs.Xunit.Fixtures.CalculatorTests.Adds_Reactively';

const CLASS_CLOSING_BRACE = '    }';
/** This file's basename, used to prove a `discover()` call came from elsewhere. */
const THIS_FILE = 'test-explorer-reactive';
/** True when a `discover()` stack came from the extension bundle, not this file. */
function fromController(stack: string): boolean {
  return (
    !stack.includes(THIS_FILE) && (stack.includes('extension.js') || stack.includes('testing'))
  );
}

interface DiscoverSpy {
  readonly stacks: string[];
  restore: () => void;
}

/** Record every `discover()` call and WHERE from — reactivity is a claim about who called. */
function spyOnDiscover(controller: SharpLspTestController): DiscoverSpy {
  const stacks: string[] = [];
  const original = controller.discover.bind(controller);
  controller.discover = async (): Promise<void> => {
    // Drop the `Error:` line and the spy's own frame: the caller is frame zero.
    const trace = (new Error('discover').stack ?? '<no stack>').split('\n');
    stacks.push(trace.slice(2).join('\n'));
    await original();
  };
  return {
    stacks,
    restore: (): void => {
      Reflect.deleteProperty(controller, 'discover');
    },
  };
}

function insertMethod(sourcePath: string, method: string): void {
  const lines = fs.readFileSync(sourcePath, 'utf8').split('\n');
  const closing = lines.lastIndexOf(CLASS_CLOSING_BRACE);
  if (closing < 0) throw new Error(`no '${CLASS_CLOSING_BRACE}' line in ${sourcePath}`);
  lines.splice(closing, 0, method);
  fs.writeFileSync(sourcePath, lines.join('\n'), 'utf8');
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** EXACTLY `expected`: each name once, nothing else, stable between reads. Duplicates mean a racing sweep. */
function assertTree(
  ctl: SharpLspTestController,
  expected: readonly string[],
  why: string,
): string[] {
  const ids = collectLeafIds(ctl.items);
  for (const name of expected) {
    assert.strictEqual(ids.includes(name), true, `${why}: missing ${name}\ngot: ${ids.join(', ')}`);
  }
  assert.strictEqual(new Set(ids).size, ids.length, `${why}: duplicate ids: ${ids.join(', ')}`);
  assert.strictEqual(ids.length, expected.length, `${why}: wrong size: ${ids.join(', ')}`);
  assert.deepStrictEqual(sorted(ids), sorted(expected), `${why}: the set must match exactly`);
  // Every root is an assembly GROUP — a test never sits at the tree's root.
  const roots: vscode.TestItem[] = [];
  ctl.items.forEach((item) => roots.push(item));
  assert.strictEqual(roots.length > 0, true, `${why}: the tree must have roots`);
  for (const root of roots) {
    assert.strictEqual(
      root.children.size > 0,
      true,
      `${why}: a root is an assembly group, never a bare test: ${root.label}`,
    );
    assert.strictEqual(
      expected.includes(root.id),
      false,
      `${why}: a root id is a group id, never an FQN: ${root.id}`,
    );
  }
  assert.deepStrictEqual(
    collectLeafIds(ctl.items),
    ids,
    `${why}: two reads of a settled tree must agree`,
  );
  return ids;
}

function assertRows(controller: SharpLspTestController, solutionDir: string, why: string): void {
  const snapshots = snapshotItems(controller.items);
  assert.notStrictEqual(snapshots.length, 0, `${why}: there must be rows to assert on`);
  // Groups and tests have different row shapes — the hierarchy renders BOTH.
  const groups = snapshots.filter((row) => row.childCount > 0);
  const tests = snapshots.filter((row) => row.childCount === 0);
  assert.strictEqual(
    groups.length > 0,
    true,
    `${why}: the Assembly → Namespace → Class groups must render as rows`,
  );
  for (const row of groups) {
    assert.strictEqual(
      row.description,
      undefined,
      `${why}: a group row carries no FQN description: ${row.id}`,
    );
    assert.deepStrictEqual(row.tags, [], `${why}: a group row carries no tag: ${row.id}`);
    assert.strictEqual(
      comparablePath(row.uriPath ?? ''),
      comparablePath(solutionDir),
      `${why}: group row anchored: ${row.id}`,
    );
  }
  for (const row of tests) {
    assert.strictEqual(row.description, row.id, `${why}: ${row.id} must show its full FQN`);
    assert.strictEqual(row.label, labelOf(row.id), `${why}: ${row.id} label is the leaf segment`);
    assert.notStrictEqual(row.label, '', `${why}: ${row.id} must render a non-empty label`);
    assert.strictEqual(row.uriPath !== undefined, true, `${why}: ${row.id} must carry a uri`);
    // Anchored at the discovery TARGET — the loaded solution — not the project.
    assert.strictEqual(
      comparablePath(row.uriPath ?? ''),
      comparablePath(solutionDir),
      `${why}: ${row.id} anchored`,
    );
    assert.strictEqual(row.childCount, 0, `${why}: a TEST row is a leaf; groups carry children`);
    assert.deepStrictEqual(
      row.tags,
      [],
      `${why}: ${row.id} — a plain xUnit test carries no framework tag`,
    );
  }
}

/** Banner chatter and xUnit's parenthesised THEORY ROW display names must never become items. */
function assertFqnShape(ids: readonly string[], why: string): void {
  for (const id of ids) {
    assert.strictEqual(id.trim(), id, `${why}: '${id}' carries stray whitespace`);
    assert.strictEqual(
      id.includes('.'),
      true,
      `${why}: '${id}' is not a dotted fully-qualified name`,
    );
    assert.strictEqual(
      id.includes('('),
      false,
      `${why}: '${id}' — an xUnit theory FQN carries no row data`,
    );
    assert.strictEqual(
      id.startsWith('Cs.'),
      true,
      `${why}: '${id}' is outside the fixture's namespaces`,
    );
  }
  const noise = ids.some((id) => id.includes('Test run for') || id.includes('Passed!'));
  assert.strictEqual(noise, false, `${why}: VSTest banner chatter must never become a test item`);
}

function assertLeaf(ctl: SharpLspTestController, id: string, why: string): vscode.TestItem {
  const item = findItem(ctl.items, id);
  assert.ok(item, `${why}: ${id} must resolve by id`);
  assert.strictEqual(item.id, id, `${why}: the id is the fully-qualified name`);
  assert.strictEqual(item.label, labelOf(id), `${why}: the label is the last dotted segment`);
  assert.strictEqual(item.description, id, `${why}: the description carries the whole FQN`);
  assert.strictEqual(item.children.size, 0, `${why}: discovery produces leaves, not a hierarchy`);
  assert.strictEqual(item.canResolveChildren, false, `${why}: a leaf test resolves no children`);
  assert.deepStrictEqual(
    item.tags.map((tag) => tag.id),
    [],
    `${why}: xUnit C# earns no 'fsharp' tag`,
  );
  return item;
}

function assertCacheUntouched(ctl: SharpLspTestController, before: number, why: string): void {
  assert.strictEqual(
    ctl.cachedResults.size,
    before,
    `${why}: a sweep must not fabricate run results`,
  );
  assert.strictEqual(
    ctl.getResult(ADDED_FQN),
    undefined,
    `${why}: a test that never ran has no outcome`,
  );
}

suite('Test Explorer e2e — reactive discovery, refresh and tree lifecycle', () => {
  let api: SharpLspExtensionApi;
  let root: string, slnPath: string, solutionDir: string;
  let csProjDir: string, extraProjDir: string, csSourcePath: string;

  suiteSetup(async function () {
    // Cold restore + build + adapter JIT for both fixture projects.
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    assert.strictEqual(
      CS.mixedParameterized,
      CS_MIXED_THEORY,
      'the fixture still exposes the mixed theory',
    );
    assert.strictEqual(
      new Set(EXPECTED).size,
      EXPECTED.length,
      'EXPECTED itself must be a set, not a bag',
    );
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-reactive-'));
    const csDir = path.join(root, CS.projectName);
    csProjDir = writeProject(
      csDir,
      CS.projectFileName,
      projectXml(CS.packages),
      CS.sourceFileName,
      CS.source,
    );
    csSourcePath = path.join(csProjDir, CS.sourceFileName);
    // In the SAME root but deliberately NOT in the solution yet.
    const extraDir = path.join(root, EXTRA_PROJECT);
    const extraXml = projectXml(XUNIT_PACKAGES);
    extraProjDir = writeProject(
      extraDir,
      `${EXTRA_PROJECT}.csproj`,
      extraXml,
      'ExtraTests.cs',
      EXTRA_SOURCE,
    );
    slnPath = await createSolution(root, 'Reactive', [csProjDir]);
    solutionDir = path.dirname(slnPath);
    // Pay the cold restore/build/JIT cost for BOTH projects once, so sweeps run warm.
    await warmDiscovery(slnPath, root);
    await warmDiscovery(extraProjDir, root);
  });

  teardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Reset the signal so the next load is a REAL transition, and let it settle.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
    }, api.testController);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Drain first: `dotnet test` pointed at a removed directory hangs forever.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('loading a solution repopulates the tree with no discover() call from this test', async function () {
    this.timeout(DOTNET_CLI_MS);
    const baseline = await discoverSolution(api, slnPath, EXPECTED);
    assert.strictEqual(baseline.length, EXPECTED.length, 'baseline is exactly the fixture');
    assert.deepStrictEqual(sorted(baseline), sorted(EXPECTED), 'baseline is the fixture project');
    assert.strictEqual(
      new Set(baseline).size,
      baseline.length,
      'the baseline itself carries no duplicates',
    );
    assert.strictEqual(
      baseline.includes(CS_MIXED_THEORY),
      true,
      'including the theory whose rows disagree',
    );
    const cached = api.testController.cachedResults.size;
    // From here the body touches ONLY the solution signal; the spy records who swept.
    const spy = spyOnDiscover(api.testController);
    try {
      api.testController.items.replace([]);
      api.explorerProvider.clear();
      assert.deepStrictEqual(
        collectLeafIds(api.testController.items),
        [],
        'empty before the reactive load',
      );
      assert.strictEqual(api.testController.items.size, 0, 'and the root collection is empty too');
      assert.strictEqual(spy.stacks.length, 0, 'clearing the tree must not itself sweep');
      await api.explorerProvider.loadSolution(slnPath);
      const ids = await pollForIds(api.testController, (s) => EXPECTED.every((n) => s.includes(n)));
      assert.deepStrictEqual(
        sorted(ids),
        sorted(EXPECTED),
        'the poll observed the whole fixture, reactively',
      );
      assertTree(api.testController, EXPECTED, 'reactive reload with no manual refresh');
      assertRows(api.testController, solutionDir, 'reactive reload');
      assertFqnShape(ids, 'reactive reload');
      assertLeaf(api.testController, CS.passing, 'reactive reload');
      assertLeaf(api.testController, CS_MIXED_THEORY, 'reactive reload');
      assert.strictEqual(
        findItem(api.testController.items, CS.failing)?.id,
        CS.failing,
        'every FQN resolves to its leaf anywhere in the tree',
      );
      assert.strictEqual(
        api.testController.items.get(CS.failing),
        undefined,
        'a test never sits at the ROOT level — only assembly groups do',
      );
      assert.strictEqual(
        spy.stacks.length >= 1,
        true,
        'the subscription must have run at least one sweep',
      );
      assert.strictEqual(
        typeof spy.stacks[0],
        'string',
        "and the spy recorded that sweep's call site",
      );
      assert.strictEqual(
        spy.stacks.every(fromController),
        true,
        `not the controller's own:\n${spy.stacks.join('\n')}`,
      );
      assert.strictEqual(
        spy.stacks.join('\n').includes(THIS_FILE),
        false,
        'no sweep was requested by this test',
      );
      assertCacheUntouched(api.testController, cached, 'reactive reload');
    } finally {
      spy.restore();
    }
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(api.testController, 'discover'),
      undefined,
      'spy restored',
    );
    assert.strictEqual(
      typeof api.testController.discover,
      'function',
      'the real discover() is back in place',
    );
    assertTree(api.testController, EXPECTED, 'the reactively loaded tree outlives the spy');
  });

  test('a burst of solution changes coalesces into exactly one discovery sweep', async function () {
    this.timeout(DOTNET_CLI_MS);
    await discoverSolution(api, slnPath, EXPECTED);
    // Settle the baseline load's own debounce: the burst must be the only sweep.
    await drainDiscovery(() => undefined, api.testController);
    const cached = api.testController.cachedResults.size;
    const spy = spyOnDiscover(api.testController);
    try {
      // Six writes (clear+load ×3), unawaited: the burst a real load emits.
      const loads = [0, 1, 2].map(() => {
        api.explorerProvider.clear();
        return api.explorerProvider.loadSolution(slnPath);
      });
      assert.strictEqual(loads.length, 3, 'three loads were actually issued');
      await Promise.all(loads);
      await drainDiscovery(() => undefined, api.testController);
      assert.strictEqual(
        spy.stacks.length,
        1,
        `six signal writes must debounce to ONE sweep, saw ${spy.stacks.length}`,
      );
      assert.strictEqual(
        spy.stacks[0]?.includes(THIS_FILE),
        false,
        "and that sweep is the controller's own",
      );
      assert.strictEqual(
        spy.stacks.every(fromController),
        true,
        'and it ran inside the extension, not this test',
      );
      const ids = await pollUntilDiscovered(api.testController, EXPECTED);
      assert.deepStrictEqual(
        sorted(ids),
        sorted(EXPECTED),
        'the burst leaves exactly the fixture behind',
      );
      assert.strictEqual(
        ids.filter((id) => id === CS.parameterized).length,
        1,
        'both [InlineData] rows collapse to ONE item',
      );
      assert.strictEqual(
        ids.filter((id) => id === CS_MIXED_THEORY).length,
        1,
        'a theory whose rows disagree is one item too',
      );
      assert.strictEqual(
        new Set(ids).size,
        EXPECTED.length,
        'the burst produced one tree, not two',
      );
      assert.strictEqual(ids.length, EXPECTED.length, 'and appended nothing to it');
      assert.strictEqual(
        ids.includes(CS.failing),
        true,
        'a failing test is discovered like any other',
      );
      assertTree(api.testController, EXPECTED, 'the root holds each test exactly once');
      // A non-coalesced burst gets the NAMES right; it leaves duplicates and a
      // wrong size, which `assertTree` catches.
      assertTree(api.testController, EXPECTED, 'settled tree after a coalesced burst');
      assertRows(api.testController, solutionDir, 'settled tree after a coalesced burst');
      assertFqnShape(ids, 'settled tree after a coalesced burst');
      assertLeaf(api.testController, CS.parameterized, 'settled tree after a coalesced burst');
      assertLeaf(api.testController, CS.skipped, 'settled tree after a coalesced burst');
      assert.strictEqual(
        findItem(api.testController.items, CS.passing)?.id,
        CS.passing,
        'resolves by FQN id',
      );
      assertCacheUntouched(api.testController, cached, 'settled tree after a coalesced burst');
      assert.strictEqual(
        spy.stacks.length,
        1,
        'and no further sweep ran while the tree was being read',
      );
    } finally {
      spy.restore();
    }
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(api.testController, 'discover'),
      undefined,
      'spy restored',
    );
  });

  test('adding a [Fact] on disk adds exactly one item, and removing it undoes that', async function () {
    this.timeout(DOTNET_CLI_MS);
    const before = await discoverSolution(api, slnPath, EXPECTED);
    assert.strictEqual(before.length, EXPECTED.length, 'the round trip starts from the fixture');
    assert.strictEqual(before.includes(ADDED_FQN), false, `${ADDED_FQN} must not exist yet`);
    // The user types a new test into the file. A REAL edit, on disk.
    const originalText = fs.readFileSync(csSourcePath, 'utf8');
    assert.strictEqual(originalText, CS.source, 'the fixture source is pristine before the edit');
    insertMethod(csSourcePath, ADDED_FACT);
    const editedText = fs.readFileSync(csSourcePath, 'utf8');
    assert.strictEqual(editedText.includes(ADDED_FACT), true, 'the new [Fact] is on disk');
    assert.notStrictEqual(editedText, originalText, 'the file really changed');
    assert.strictEqual(
      editedText.split('\n').length,
      originalText.split('\n').length + 1,
      'added exactly one line',
    );
    // The user presses ⟳ in the Testing view.
    await vscode.commands.executeCommand('testing.refreshTests');
    const grown = await pollForIds(api.testController, (ids) => ids.includes(ADDED_FQN));
    assert.strictEqual(
      grown.includes(ADDED_FQN),
      true,
      `the new test must appear: ${ADDED_FQN}\ngot: ${grown.join(', ')}`,
    );
    assert.strictEqual(grown.length, before.length + 1, 'the tree grew by exactly one');
    assert.deepStrictEqual(
      sorted(grown),
      sorted([...EXPECTED, ADDED_FQN]),
      'and by exactly that one name',
    );
    assertTree(api.testController, [...EXPECTED, ADDED_FQN], 'tree after a source-file addition');
    assertRows(api.testController, solutionDir, 'tree after a source-file addition');
    assertFqnShape(grown, 'tree after a source-file addition');
    const added = assertLeaf(api.testController, ADDED_FQN, 'tree after a source-file addition');
    assert.strictEqual(
      added.label,
      'Adds_Reactively',
      'the label is the method name the user typed',
    );
    assert.strictEqual(
      comparablePath(added.uri?.fsPath ?? ''),
      comparablePath(solutionDir),
      'anchored at the solution',
    );
    // …and the user deletes it again.
    fs.writeFileSync(csSourcePath, originalText, 'utf8');
    assert.strictEqual(
      fs.readFileSync(csSourcePath, 'utf8'),
      CS.source,
      'the fixture source is restored byte for byte',
    );
    await vscode.commands.executeCommand('testing.refreshTests');
    const shrunk = await pollForIds(api.testController, (ids) => !ids.includes(ADDED_FQN));
    assert.strictEqual(
      shrunk.includes(ADDED_FQN),
      false,
      `a deleted test must leave: ${ADDED_FQN}\ngot: ${shrunk.join(', ')}`,
    );
    assert.strictEqual(
      findItem(api.testController.items, ADDED_FQN),
      undefined,
      'and must no longer resolve by id',
    );
    assert.strictEqual(
      api.testController.items.get(ADDED_FQN),
      undefined,
      'nor be reachable from the root collection',
    );
    assert.strictEqual(shrunk.length, before.length, 'the tree returned to its original size');
    assert.deepStrictEqual(sorted(shrunk), sorted(EXPECTED), 'and to its original contents');
    assertTree(api.testController, EXPECTED, 'tree after the added test was deleted again');
    assertFqnShape(shrunk, 'tree after the added test was deleted again');
    assertLeaf(api.testController, CS.passing, 'tree after the added test was deleted again');
  });

  test('a project joining and leaving the solution adds and removes its tests', async function () {
    this.timeout(DOTNET_CLI_MS);
    const before = await discoverSolution(api, slnPath, EXPECTED);
    assert.strictEqual(before.length, EXPECTED.length, 'the solution starts with one project');
    for (const extra of EXTRA_TESTS) {
      assert.strictEqual(before.includes(extra), false, `${extra} must not be discoverable yet`);
    }
    await dotnet(['sln', slnPath, 'add', extraProjDir], root);
    const listed = await dotnet(['sln', slnPath, 'list'], root);
    assert.strictEqual(
      listed.includes(`${EXTRA_PROJECT}.csproj`),
      true,
      'the CLI reports the added project',
    );
    assert.strictEqual(
      listed.includes(CS.projectFileName),
      true,
      'and still reports the original one',
    );
    assert.strictEqual(
      fs.readFileSync(slnPath, 'utf8').includes(`${EXTRA_PROJECT}.csproj`),
      true,
      'the sln carries it',
    );
    await vscode.commands.executeCommand('testing.refreshTests');
    const both = await pollForIds(api.testController, (ids) =>
      EXTRA_TESTS.every((n) => ids.includes(n)),
    );
    assert.strictEqual(both.length, EXPECTED.length + EXTRA_TESTS.length, 'both projects, in full');
    assert.deepStrictEqual(
      sorted(both),
      sorted([...EXPECTED, ...EXTRA_TESTS]),
      "exactly the two projects' tests",
    );
    assertTree(api.testController, [...EXPECTED, ...EXTRA_TESTS], 'tree spanning two projects');
    assertRows(api.testController, solutionDir, 'tree spanning two projects');
    assertFqnShape(both, 'tree spanning two projects');
    const partition = (prefix: string): number => both.filter((id) => id.startsWith(prefix)).length;
    assert.strictEqual(
      partition('Cs.Extra.Fixtures.'),
      EXTRA_TESTS.length,
      'the joined project contributes both tests',
    );
    assert.strictEqual(
      partition('Cs.Xunit.Fixtures.'),
      EXPECTED.length,
      'and the original keeps all of its own',
    );
    // Different dirs, yet items anchor at the TARGET: the FQN namespace, not the
    // uri, is what tells the two projects apart.
    const joined = assertLeaf(api.testController, EXTRA_TESTS[0], 'tree spanning two projects');
    assert.strictEqual(
      joined.label,
      'Multiplies_TwoNumbers',
      "the joined project's row renders its method name",
    );
    assert.notStrictEqual(
      comparablePath(csProjDir),
      comparablePath(extraProjDir),
      'the projects are distinct dirs',
    );
    assert.strictEqual(
      comparablePath(joined.uri?.fsPath ?? ''),
      comparablePath(solutionDir),
      'anchored at the solution',
    );
    assert.notStrictEqual(
      comparablePath(joined.uri?.fsPath ?? ''),
      comparablePath(extraProjDir),
      'not at its own project',
    );
    assert.strictEqual(path.dirname(csProjDir), root, 'both live directly under the fixture root');
    assert.strictEqual(path.dirname(extraProjDir), root, 'including the added one');
    await dotnet(['sln', slnPath, 'remove', extraProjDir], root);
    const listedAfter = await dotnet(['sln', slnPath, 'list'], root);
    assert.strictEqual(
      listedAfter.includes(`${EXTRA_PROJECT}.csproj`),
      false,
      'the CLI no longer reports it',
    );
    assert.strictEqual(
      listedAfter.includes(CS.projectFileName),
      true,
      'while the original project stays',
    );
    assert.strictEqual(
      fs.readFileSync(slnPath, 'utf8').includes(`${EXTRA_PROJECT}.csproj`),
      false,
      'the sln dropped it',
    );
    await vscode.commands.executeCommand('testing.refreshTests');
    const after = await pollForIds(
      api.testController,
      (ids) => !EXTRA_TESTS.some((n) => ids.includes(n)),
    );
    for (const extra of EXTRA_TESTS) {
      assert.strictEqual(
        after.includes(extra),
        false,
        `removed project's tests must go: ${extra}\n${after.join()}`,
      );
    }
    assert.strictEqual(after.length, before.length, 'back to the original size');
    assert.deepStrictEqual(sorted(after), sorted(EXPECTED), 'and to the original set');
    assert.strictEqual(
      fs.existsSync(path.join(extraProjDir, 'ExtraTests.cs')),
      true,
      'the project is still on disk',
    );
    assertTree(api.testController, EXPECTED, 'tree after the second project was removed');
    assertFqnShape(after, 'tree after the second project was removed');
  });

  test('a discovery sweep where every target fails keeps the last good tree', async function () {
    this.timeout(DOTNET_CLI_MS);
    const good = await discoverSolution(api, slnPath, EXPECTED);
    assert.strictEqual(good.length, EXPECTED.length, 'a populated tree is the precondition');
    const cached = api.testController.cachedResults.size;
    const ghost = path.join(root, 'Vanished.slnx');
    assert.strictEqual(fs.existsSync(ghost), false, 'the ghost target must genuinely not exist');
    await api.explorerProvider.loadSolution(ghost);
    await assert.doesNotReject(
      async () => api.testController.discover(),
      'a missing target must not reject',
    );
    await drainDiscovery(() => undefined, api.testController);
    const kept = collectLeafIds(api.testController.items);
    assert.strictEqual(kept.length, good.length, 'a failed sweep must not blank the view');
    assert.deepStrictEqual(sorted(kept), sorted(good), 'the kept tree is the previous tree');
    assert.strictEqual(new Set(kept).size, kept.length, 'and it is kept once, not re-appended');
    assert.strictEqual(
      kept.includes(CS_MIXED_THEORY),
      true,
      'the kept tree keeps even the mixed theory',
    );
    assertTree(api.testController, EXPECTED, 'and the root collection kept its rows');
    assert.strictEqual(fs.existsSync(ghost), false, 'and the failed sweep created nothing on disk');
    assertTree(api.testController, EXPECTED, 'tree kept across a total discovery failure');
    assertFqnShape(kept, 'tree kept across a total discovery failure');
    const survivor = assertLeaf(
      api.testController,
      CS.passing,
      'tree kept across a total discovery failure',
    );
    assert.strictEqual(survivor.label, 'Adds_TwoNumbers', 'and keeps its rendered label');
    assertCacheUntouched(api.testController, cached, 'tree kept across a total discovery failure');
    // Recovery: pointing back at the real solution reconciles the tree again.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.discover();
    const recovered = await pollUntilDiscovered(api.testController, EXPECTED);
    assert.strictEqual(recovered.length, EXPECTED.length, 'recovery leaves nothing stale behind');
    assert.deepStrictEqual(
      sorted(recovered),
      sorted(EXPECTED),
      'and rediscovers exactly the fixture',
    );
    assert.strictEqual(
      recovered.includes(CS.skipped),
      true,
      'including the skipped test the sweep lost',
    );
    assert.strictEqual(new Set(recovered).size, recovered.length, 'without doubling what it kept');
    assertTree(api.testController, EXPECTED, 'tree after recovering from a missing target');
    assertRows(api.testController, solutionDir, 'tree after recovering from a missing target');
    assertLeaf(api.testController, CS.failing, 'tree after recovering from a missing target');
  });

  test('whenIdle() really drains the dotnet queue before it resolves', async function () {
    this.timeout(DOTNET_CLI_MS);
    await discoverSolution(api, slnPath, EXPECTED);
    const cached = api.testController.cachedResults.size;
    // Schedule reactive discovery, then drain it the way teardown does.
    api.explorerProvider.clear();
    await api.explorerProvider.loadSolution(slnPath);
    await drainDiscovery(() => undefined, api.testController);
    const idleStart = Date.now();
    await api.testController.whenIdle();
    const idleMs = Date.now() - idleStart;
    assert.strictEqual(
      idleMs < 1_000,
      true,
      `a drained queue must settle at once, took ${idleMs}ms`,
    );
    const settled = await pollUntilDiscovered(api.testController, EXPECTED);
    assert.strictEqual(settled.length, EXPECTED.length, 'complete the moment whenIdle() returns');
    assert.deepStrictEqual(sorted(settled), sorted(EXPECTED), 'with exactly the fixture in it');
    assert.strictEqual(
      new Set(settled).size,
      settled.length,
      'a drained tree carries no duplicates',
    );
    assert.strictEqual(
      settled.includes(CS.parameterized),
      true,
      'a theory is one drained item, not two',
    );
    assert.strictEqual(
      findItem(api.testController.items, CS.skipped)?.label,
      'Skipped_OnPurpose',
      'label kept',
    );
    assertTree(api.testController, EXPECTED, 'drained tree is complete, not half-written');
    assertFqnShape(settled, 'drained tree');
    assertLeaf(api.testController, CS.skipped, 'drained tree');
    const sweepStart = Date.now();
    await assert.doesNotReject(
      async () => api.testController.discover(),
      'a sweep after whenIdle() must not reject',
    );
    const sweepMs = Date.now() - sweepStart;
    assert.strictEqual(
      sweepMs < 240_000,
      true,
      `a warm sweep must finish inside its window, took ${sweepMs}ms`,
    );
    const secondIdleStart = Date.now();
    await api.testController.whenIdle();
    const secondIdleMs = Date.now() - secondIdleStart;
    assert.strictEqual(
      secondIdleMs < 1_000,
      true,
      `whenIdle() must resolve at once after its sweep, ${secondIdleMs}ms`,
    );
    assertTree(api.testController, EXPECTED, 'the tree is unchanged by an idempotent re-sweep');
    assert.deepStrictEqual(
      sorted(collectLeafIds(api.testController.items)),
      sorted(settled),
      'same as the drained read',
    );
    assertTree(api.testController, EXPECTED, 'the root count agrees');
    assert.strictEqual(
      new Set(collectLeafIds(api.testController.items)).size,
      EXPECTED.length,
      'replaced, not appended',
    );
    assert.strictEqual(
      findItem(api.testController.items, CS.failing)?.description,
      CS.failing,
      'the FQN is kept',
    );
    assertRows(api.testController, solutionDir, 'tree after an idempotent re-sweep');
    assertCacheUntouched(api.testController, cached, 'an idempotent re-sweep');
  });

  test('revealing the Testing view leaves a populated tree behind the refresh affordance', async function () {
    this.timeout(DOTNET_CLI_MS);
    const commands = await vscode.commands.getCommands(true);
    assert.strictEqual(
      commands.includes('testing.refreshTests'),
      true,
      'the workbench exposes the ⟳ refresh command',
    );
    assert.strictEqual(
      commands.includes('workbench.view.testing.focus'),
      true,
      'the workbench reveals the Testing view',
    );
    assert.strictEqual(
      commands.filter((id) => id === 'testing.refreshTests').length,
      1,
      'registered exactly once',
    );
    await api.explorerProvider.loadSolution(slnPath);
    const reveal = async (): Promise<unknown> =>
      vscode.commands.executeCommand('workbench.view.testing.focus');
    await assert.doesNotReject(reveal, 'revealing the Testing view must never reject');
    await api.testController.activateAndDiscover();
    const ids = await pollUntilDiscovered(api.testController, EXPECTED);
    assert.deepStrictEqual(
      sorted(ids),
      sorted(EXPECTED),
      'revealing the view must leave the fixture on screen',
    );
    assertTree(api.testController, EXPECTED, 'tree behind a revealed Testing view');
    assertRows(api.testController, solutionDir, 'tree behind a revealed Testing view');
    assertFqnShape(ids, 'tree behind a revealed Testing view');
    const revealedSnapshots = snapshotItems(api.testController.items);
    assert.strictEqual(
      revealedSnapshots.filter((row) => row.childCount === 0).length,
      EXPECTED.length,
      'one rendered TEST row per test',
    );
    assert.strictEqual(
      revealedSnapshots.filter((row) => row.childCount > 0).length,
      3,
      'the fixture assembly, its namespace and its class render as GROUP rows',
    );
    // The buttons the revealed view draws come from the registered profiles.
    const profiles = api.testController.profiles;
    assert.strictEqual(
      profiles.length,
      3,
      'Run, Debug and Coverage are the three registered profiles',
    );
    assert.deepStrictEqual(
      profiles.map((p) => p.label),
      ['Run', 'Debug', 'Run with Coverage'],
      'in the order shown',
    );
    assert.strictEqual(
      new Set(profiles.map((p) => p.label)).size,
      3,
      'each profile is registered exactly once',
    );
    const kinds = [
      vscode.TestRunProfileKind.Run,
      vscode.TestRunProfileKind.Debug,
      vscode.TestRunProfileKind.Coverage,
    ];
    assert.deepStrictEqual(
      profiles.map((p) => p.kind),
      kinds,
      'each profile keeps the kind its button binds to',
    );
    // And the affordance still works after the reveal.
    const refresh = async (): Promise<unknown> =>
      vscode.commands.executeCommand('testing.refreshTests');
    await assert.doesNotReject(refresh, 'refresh must survive a view reveal');
    const refreshed = await pollUntilDiscovered(api.testController, EXPECTED);
    assert.deepStrictEqual(
      sorted(refreshed),
      sorted(EXPECTED),
      'refresh after a reveal repopulates the same set',
    );
    assert.strictEqual(
      refreshed.includes(CS.skipped),
      true,
      'a skipped test is still a discovered test',
    );
    assert.strictEqual(
      refreshed.length,
      EXPECTED.length,
      'and refresh replaced the tree rather than growing it',
    );
    assertTree(api.testController, EXPECTED, 'the root holds each test exactly once');
    assertLeaf(api.testController, CS.skipped, 'tree after refreshing a revealed view');
    assertTree(api.testController, EXPECTED, 'tree after refreshing a revealed view');
  });

  test('two concurrent activateAndDiscover() sweeps settle on one duplicate-free tree', async function () {
    this.timeout(DOTNET_CLI_MS);
    await api.explorerProvider.loadSolution(slnPath);
    api.testController.items.replace([]);
    assert.deepStrictEqual(
      collectLeafIds(api.testController.items),
      [],
      'the race starts from an empty tree',
    );
    assert.strictEqual(api.testController.items.size, 0, 'and from an empty root collection');
    const cached = api.testController.cachedResults.size;
    // `discoverGeneration` makes the SUPERSEDED sweep drop its results instead of
    // writing them: without it the loser's `replace` races the winner's.
    const sweep = (): Promise<void> => api.testController.activateAndDiscover();
    const outcomes = await Promise.all([sweep(), sweep()]);
    assert.strictEqual(outcomes.length, 2, 'both sweeps resolved');
    assert.deepStrictEqual(outcomes, [undefined, undefined], 'neither sweep returned a value');
    await drainDiscovery(() => undefined, api.testController);
    const ids = await pollUntilDiscovered(api.testController, EXPECTED);
    assert.deepStrictEqual(
      sorted(ids),
      sorted(EXPECTED),
      'the race leaves exactly one copy of the fixture',
    );
    assert.strictEqual(ids.length, EXPECTED.length, 'a lost `replace` would have doubled this');
    assert.strictEqual(new Set(ids).size, ids.length, 'and would have duplicated these ids');
    assert.strictEqual(
      ids.includes(CS_MIXED_THEORY),
      true,
      'the mixed theory survives the race exactly once',
    );
    assertTree(api.testController, EXPECTED, 'tree after two concurrent sweeps');
    assertTree(api.testController, EXPECTED, 'the root holds each test exactly once');
    assertRows(api.testController, solutionDir, 'tree after two concurrent sweeps');
    assertFqnShape(ids, 'tree after two concurrent sweeps');
    assertCacheUntouched(api.testController, cached, 'two concurrent sweeps');
    // Stability: two consecutive reads of a settled tree must agree, in order.
    const read = (): string[] => collectLeafIds(api.testController.items);
    assert.deepStrictEqual(read(), read(), 'a settled tree must not change between two reads');
    assert.deepStrictEqual(sorted(read()), sorted(ids), 'and must still be what the poll observed');
    assert.strictEqual(
      read().length,
      EXPECTED.length,
      'the settled read is the whole fixture, once',
    );
    for (const expected of EXPECTED) {
      assertLeaf(api.testController, expected, 'tree after two concurrent sweeps');
      assert.strictEqual(
        findItem(api.testController.items, expected)?.id,
        expected,
        'and is reachable from the root, through its group path',
      );
    }
    await assert.doesNotReject(
      async () => api.testController.whenIdle(),
      'the queue must drain cleanly',
    );
    assertTree(api.testController, EXPECTED, 'and the drained tree is still the settled one');
  });
});
