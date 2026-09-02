// Coarse end-to-end proof that Test Explorer discovery is FRAMEWORK-AGNOSTIC:
// xUnit, NUnit and MSTest, each written twice — once in C# and once in F# — as
// six REAL projects in one REAL solution built by the real `dotnet` CLI inside
// the extension host, driven through the extension's OWN controller.
//
// Regression suite for issue #180. Discovery used to scrape `dotnet test
// --list-tests`, which prints each test's **DisplayName**: xUnit's happens to
// EQUAL `Namespace.Class.Method`, so scraping worked for xUnit by accident and
// hid the bug, while NUnit and MSTest default it to the BARE method name
// (`Adds_TwoNumbers`) — no dot, so the shape filter dropped them outright, and a
// bare name could never be fed to `--filter FullyQualifiedName=` anyway. The
// FQNs also come in three shapes a naive `^[\w.]+$` filter mangles: F# backtick
// names carry SPACES, an NUnit `[TestCase]` name carries PARENTHESES AND COMMAS
// (VSTest filter GRAMMAR), and an F# `[<TestClass>]` is a CLR nested type, so
// its FQN carries a `+`. F# comes FIRST throughout (project rule).
//
// Covers [TEST-DISCOVERY-FQN] and [TEST-FILTER-ESCAPE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  parseAnnouncedAssemblies,
  parseTestAssemblies,
  parseTestList,
} from '../../test-discovery.js';
import { escapeFilterValue, filterClause, filterExpression } from '../../test-filter.js';
import {
  buildFilterArgs,
  isExpectoTest,
  isFsCheckTest,
  type CachedTestResult,
  type SharpLspTestController,
} from '../../testing.js';
import { createSolution, projectXml, warmDiscovery, writeProject } from './dotnet-project-kit';
import { FRAMEWORK_FIXTURES, type FrameworkFixture } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  discoverSolution,
  drainDiscovery,
  findItem,
  nextResultsChange,
  snapshotItems,
  type TestItemSnapshot,
} from './test-explorer-kit';
import { comparablePath, removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The idiomatic F# backtick fact whose xUnit FQN literally contains spaces. */
const FS_SPACED_FACT = 'Fs.Xunit.Fixtures.adds two numbers with spaces';
/** The NUnit `[TestCase]` FQNs — parentheses and commas, verbatim. */
const FS_NUNIT_CASE = 'Fs.Nunit.Fixtures.adds case(2,2,4)';
const CS_NUNIT_CASE = 'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)';
/** The F# MSTest FQN — `[<TestClass>]` is a CLR NESTED type, hence the `+`. */
const FS_MSTEST_NESTED = 'Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers';
/** The exact property set of EVERY cached result, in construction order. */
const RESULT_KEYS = ['outcome', 'passed', 'duration', 'message'];
/** Names a fixture exposes beyond the four roles its record names. */
const EXTRA_FQNS = new Map<string, readonly string[]>([['xunit-fsharp', [FS_SPACED_FACT]]]);
/** VSTest chatter that must never survive into the tree as a test id. */
const CHATTER = [
  'Passed!',
  'Failed!',
  'Skipped!',
  'Test run for',
  'The following',
  'Duration:',
  ' -> ',
];

/** Every fully-qualified name one fixture must contribute to the tree. */
function fqnsOf(fixture: FrameworkFixture): readonly string[] {
  const mixed = fixture.mixedParameterized === undefined ? [] : [fixture.mixedParameterized];
  const roles = [fixture.passing, fixture.failing, fixture.skipped, fixture.parameterized];
  return [...roles, ...mixed, ...(EXTRA_FQNS.get(fixture.key) ?? [])];
}

/** Every name the six-project solution must expose, F# fixtures first. */
const ALL_EXPECTED: readonly string[] = FRAMEWORK_FIXTURES.flatMap(fqnsOf);

/** The theories whose rows DISAGREE — one pass, one fail, under one FQN. */
const MIXED_THEORIES: readonly string[] = FRAMEWORK_FIXTURES.flatMap(
  (one) => one.mixedParameterized ?? [],
);

/**
 * The ONLY names whose DisplayName equals their FullyQualifiedName: the xUnit
 * facts. A theory's display name carries its row arguments, and NUnit/MSTest
 * print the bare member name — so nothing else can reach that listing.
 */
const XUNIT_DISPLAY_NAMES: readonly string[] = FRAMEWORK_FIXTURES.filter(
  (one) => one.framework === 'xunit',
).flatMap((one) => [one.passing, one.failing, one.skipped, ...(EXTRA_FQNS.get(one.key) ?? [])]);

/** The awkward shapes: the FQN, the label it renders as, and why it is hard. */
const AWKWARD_SHAPES: readonly (readonly [string, string, string])[] = [
  [FS_SPACED_FACT, 'adds two numbers with spaces', 'an F# backtick binding carries SPACES'],
  [FS_NUNIT_CASE, 'adds case(2,2,4)', 'an F# [<TestCase>] mixes a SPACE and PARENTHESES'],
  [CS_NUNIT_CASE, 'Adds_Case(2,2,4)', 'a C# [TestCase] carries PARENTHESES AND COMMAS'],
  [FS_MSTEST_NESTED, 'AddsTwoNumbers', 'an F# [<TestClass>] is a CLR nested type, hence the +'],
];

/** The dotted prefix every name in one fixture shares — unique, so it partitions the tree. */
function namespaceOf(fixture: FrameworkFixture): string {
  return fixture.passing.split('.').slice(0, 3).join('.');
}

/** Ordinal sort with an explicit comparator, for set-equality assertions. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Project XML for a fixture: F# must declare its compile order, C# must not. */
function xmlFor(fixture: FrameworkFixture): string {
  return fixture.language === 'fsharp'
    ? projectXml(fixture.packages, fixture.sourceFileName)
    : projectXml(fixture.packages);
}

/** Write all six fixture projects under `root`; returns dir keyed by fixture. */
function writeAllProjects(root: string): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const one of FRAMEWORK_FIXTURES) {
    const dir = path.join(root, one.projectName);
    dirs.set(
      one.key,
      writeProject(dir, one.projectFileName, xmlFor(one), one.sourceFileName, one.source),
    );
  }
  return dirs;
}

/** The fixture with `key`, asserted present. */
function fixtureByKey(key: string): FrameworkFixture {
  const fixture = FRAMEWORK_FIXTURES.find((candidate) => candidate.key === key);
  assert.ok(fixture, `FRAMEWORK_FIXTURES must define the ${key} fixture`);
  assert.strictEqual(fixture.key, key, `fixtureByKey must return the ${key} fixture, not another`);
  return fixture;
}

/** No banner, summary line or build echo may be mistaken for a test. */
function assertNoChatter(ids: readonly string[]): void {
  for (const id of ids) {
    assert.strictEqual(id.trim(), id, `a tree id never keeps the listing's indentation: '${id}'`);
    assert.strictEqual(
      id.length > 0,
      true,
      'an empty id would render as a blank row in the Testing view',
    );
    for (const noise of CHATTER) {
      assert.strictEqual(
        id.includes(noise),
        false,
        `VSTest chatter '${noise}' must never become a test item: '${id}'`,
      );
    }
  }
}

/** Everything one fixture must contribute to the settled tree. */
function assertFixtureInTree(fixture: FrameworkFixture, ids: readonly string[]): void {
  const expected = fqnsOf(fixture);
  const mine = ids.filter((id) => id.startsWith(namespaceOf(fixture)));
  assert.strictEqual(
    ids.includes(fixture.passing),
    true,
    `${fixture.key}: the passing test must be discovered — ${fixture.passing}`,
  );
  assert.strictEqual(
    ids.includes(fixture.failing),
    true,
    `${fixture.key}: a FAILING test must still be discovered — discovery is not a run`,
  );
  assert.strictEqual(
    ids.includes(fixture.skipped),
    true,
    `${fixture.key}: a SKIPPED test must still appear in the tree, not be hidden`,
  );
  assert.strictEqual(
    ids.includes(fixture.parameterized),
    true,
    `${fixture.key}: the data-driven test appears under its single FQN — ${fixture.parameterized}`,
  );
  assert.deepStrictEqual(
    sorted(mine),
    sorted(expected),
    `${fixture.key} must expose exactly its own tests, no more and no fewer`,
  );
  assert.strictEqual(
    new Set(mine).size,
    mine.length,
    `${fixture.key} must not contribute a duplicate id: ${mine.join(', ')}`,
  );
  assert.strictEqual(
    mine.length,
    expected.length,
    `${fixture.key} contributes exactly ${expected.length} tests`,
  );
  assert.strictEqual(
    mine.length >= 4,
    true,
    `${fixture.key} must contribute at least a passing, failing, skipped and data-driven test`,
  );
}

/** One `Test run for <dll>` banner, asserted to name a real built assembly. */
function assertAnnouncedAssembly(assembly: string): void {
  assert.strictEqual(path.isAbsolute(assembly), true, `${assembly} must be an absolute path`);
  assert.strictEqual(
    fs.existsSync(assembly),
    true,
    `${assembly} must exist on disk — the project really built`,
  );
  assert.strictEqual(path.extname(assembly), '.dll', `${assembly} must name a managed assembly`);
  assert.strictEqual(
    assembly.includes('(.NETCoreApp'),
    false,
    `the framework suffix must be stripped from ${assembly}`,
  );
  assert.strictEqual(assembly.trim(), assembly, `${assembly} must not carry banner padding`);
}

/** THE REGRESSION: a NUnit/MSTest fixture is INVISIBLE in the DisplayName listing. */
function assertInvisibleInListing(
  fixture: FrameworkFixture,
  displayNames: readonly string[],
  ids: readonly string[],
): void {
  for (const fqn of fqnsOf(fixture)) {
    assert.strictEqual(
      displayNames.includes(fqn),
      false,
      `${fixture.key}: ${fqn} is INVISIBLE in the display listing — that is issue #180`,
    );
    assert.strictEqual(
      displayNames.includes(fqn.split('.').at(-1) ?? ''),
      false,
      `${fixture.key}: the BARE member name is not a usable id either`,
    );
    assert.strictEqual(
      ids.includes(fqn),
      true,
      `${fixture.key}: the FQN pass must find ${fqn} anyway`,
    );
    assert.strictEqual(
      ids.filter((id) => id === fqn).length,
      1,
      `${fixture.key}: ${fqn} reaches the tree exactly once`,
    );
  }
}

/** xUnit is the one framework whose DisplayName equals its FQN — hence the bug's long life. */
function assertXunitVisible(fixture: FrameworkFixture, displayNames: readonly string[]): void {
  assert.strictEqual(
    displayNames.includes(fixture.passing),
    true,
    `${fixture.key}: xUnit's DisplayName equals its FQN, so ${fixture.passing} appears`,
  );
  assert.strictEqual(
    displayNames.includes(fixture.failing),
    true,
    `${fixture.key}: the failing xUnit fact appears in the display listing too`,
  );
  assert.strictEqual(
    displayNames.includes(fixture.skipped),
    true,
    `${fixture.key}: a skipped xUnit fact is still enumerated`,
  );
  assert.strictEqual(
    displayNames.includes(fixture.parameterized),
    false,
    `${fixture.key}: a theory's display name carries ROW ARGUMENTS, so the bare ${fixture.parameterized} is absent`,
  );
  assert.strictEqual(
    displayNames.includes(fixture.mixedParameterized ?? ''),
    false,
    `${fixture.key}: the mixed theory is likewise absent under its bare FQN`,
  );
  assert.strictEqual(
    displayNames.filter((name) => name === fixture.passing).length,
    1,
    `${fixture.key}: ${fixture.passing} is listed exactly once`,
  );
}

/** Every property a discovered item hands the Testing view. */
function assertItemShape(snapshot: TestItemSnapshot, anchor: string): void {
  assert.strictEqual(
    snapshot.description,
    snapshot.id,
    'the description must carry the whole FQN so same-named methods stay distinct',
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
  assert.strictEqual(
    snapshot.childCount,
    0,
    `a discovered TEST is a leaf; groups sit above it: ${snapshot.id}`,
  );
  assert.deepStrictEqual(
    snapshot.tags,
    [],
    `plain xUnit/NUnit/MSTest tests carry no framework tag: ${snapshot.id}`,
  );
  assert.strictEqual(
    isExpectoTest(snapshot.id),
    false,
    `${snapshot.id} is not an Expecto name, which is WHY it is untagged`,
  );
  assert.strictEqual(
    isFsCheckTest(snapshot.id),
    false,
    `${snapshot.id} is not an FsCheck name, which is WHY it is untagged`,
  );
  assert.strictEqual(
    typeof snapshot.uriPath,
    'string',
    `${snapshot.id} must carry a uri for the editor to open`,
  );
  assert.strictEqual(
    comparablePath(snapshot.uriPath ?? ''),
    comparablePath(anchor),
    `${snapshot.id} must be anchored at the discovery target's directory`,
  );
}

/** A fixture's project really is on disk, directly under the solution root. */
function assertProjectOnDisk(fixture: FrameworkFixture, dir: string, root: string): void {
  assert.strictEqual(
    comparablePath(path.dirname(dir)),
    comparablePath(root),
    `${fixture.key}: the solution root is the project directory's parent`,
  );
  assert.strictEqual(
    path.basename(dir),
    fixture.projectName,
    `${fixture.key}: the project directory is named after the project`,
  );
  assert.strictEqual(
    comparablePath(dir).startsWith(comparablePath(root) + path.sep),
    true,
    `${fixture.key}: its project must live under the solution root ${root}`,
  );
  assert.strictEqual(
    fs.existsSync(path.join(dir, fixture.projectFileName)),
    true,
    `${fixture.key}: ${fixture.projectFileName} must be on disk`,
  );
  assert.strictEqual(
    fs.existsSync(path.join(dir, fixture.sourceFileName)),
    true,
    `${fixture.key}: ${fixture.sourceFileName} must be on disk`,
  );
  assert.strictEqual(
    fs.readFileSync(path.join(dir, fixture.sourceFileName), 'utf8'),
    fixture.source,
    `${fixture.key}: the built source is the fixture's source, verbatim`,
  );
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

/** One awkward FQN, from the listing to the rendered row to the filter value. */
function assertShapeSurvives(
  items: vscode.TestItemCollection,
  ids: readonly string[],
  shape: readonly [string, string, string],
): void {
  const [fqn, label, why] = shape;
  assert.strictEqual(ids.includes(fqn), true, `${why}: ${fqn} must survive discovery verbatim`);
  assert.strictEqual(
    ids.filter((id) => id === fqn).length,
    1,
    `${why}: ${fqn} must appear exactly once in the tree`,
  );
  assert.strictEqual(
    assertLeafItem(items, fqn).label,
    label,
    `${why}: ${fqn} must render as '${label}'`,
  );
  assert.strictEqual(
    fqn.includes('`'),
    false,
    `${why}: F# backticks are source syntax, never part of the FQN`,
  );
  assert.strictEqual(fqn.trim(), fqn, `${why}: ${fqn} must not carry listing padding`);
  assert.strictEqual(
    escapeFilterValue(fqn).length >= fqn.length,
    true,
    `${why}: escaping ${fqn} may only ever lengthen it`,
  );
}

/** Every assertion a genuinely GREEN cached result must satisfy. */
function assertGreen(result: CachedTestResult, fqn: string, key: string): void {
  const detail = result.message ?? 'no message';
  assert.strictEqual(
    result.outcome,
    'passed',
    `${key}: ${fqn} must run green — got '${result.outcome}': ${detail}`,
  );
  assert.strictEqual(result.passed, true, `${key}: a pass must set passed=true, ${fqn}`);
  assert.strictEqual(
    result.message,
    undefined,
    `${key}: a passing test carries no failure message, ${fqn}`,
  );
  assert.strictEqual(
    typeof result.duration,
    'number',
    `${key}: the TRX duration must reach the cache for ${fqn}`,
  );
  assert.strictEqual(
    (result.duration ?? -1) >= 0,
    true,
    `${key}: ${fqn} duration must not be negative`,
  );
  assert.deepStrictEqual(
    Object.keys(result),
    RESULT_KEYS,
    `${key}: the cached result shape is fixed for ${fqn}`,
  );
  const whole = { outcome: 'passed', passed: true, duration: result.duration, message: undefined };
  assert.deepStrictEqual(
    { ...result },
    whole,
    `${key}: the whole green result for ${fqn}, field for field`,
  );
}

/** Every assertion the notRun path owes the user. */
function assertNotRun(result: CachedTestResult, fqn: string): void {
  const message = `No result reported for ${fqn}`;
  assert.strictEqual(
    result.outcome,
    'notRun',
    'a filter that matches nothing is notRun, not failed',
  );
  assert.strictEqual(result.passed, false, 'nothing ran, so nothing passed');
  assert.notStrictEqual(result.outcome, 'passed', 'a missing test must never read as green');
  assert.notStrictEqual(
    result.outcome,
    'skipped',
    'a missing test is not the same thing as a skipped one',
  );
  assert.strictEqual(
    result.message,
    message,
    'the message must NAME the test, so the user sees which id matched nothing',
  );
  assert.strictEqual(
    typeof result.duration,
    'number',
    'the wall-clock duration of the invocation is still reported',
  );
  assert.strictEqual(
    (result.duration ?? -1) >= 0,
    true,
    'a run that matched nothing still took real time',
  );
  assert.deepStrictEqual(
    Object.keys(result),
    RESULT_KEYS,
    'a notRun result carries the same four properties a real one does',
  );
  assert.deepStrictEqual(
    { ...result },
    { outcome: 'notRun', passed: false, duration: result.duration, message },
    'the whole notRun result, field for field',
  );
}

/** Run one test in its own project directory and assert the whole green path. */
async function runGreen(
  controller: SharpLspTestController,
  fixture: FrameworkFixture,
  fqn: string,
  cwd: string,
): Promise<CachedTestResult> {
  const notified = nextResultsChange(controller, DOTNET_CLI_MS);
  const before = controller.cachedResults.size;
  const result = await controller.runSingle(fqn, cwd);
  assertGreen(result, fqn, fixture.key);
  assert.strictEqual(await notified, true, `runSingle must fire onResultsChanged for ${fqn}`);
  assert.strictEqual(
    controller.getResult(fqn),
    result,
    `getResult must hand back the very result runSingle cached for ${fqn}`,
  );
  assert.strictEqual(
    controller.cachedResults.get(fqn),
    result,
    `cachedResults must expose the same object getResult returns for ${fqn}`,
  );
  assert.strictEqual(
    controller.cachedResults.has(fqn),
    true,
    `${fqn} must be keyed by its FQN in the result cache`,
  );
  assert.strictEqual(
    controller.cachedResults.size >= before,
    true,
    `${fqn}: caching a result must never shrink the cache`,
  );
  assert.strictEqual(
    findItem(controller.items, fqn)?.id,
    fqn,
    `running ${fqn} must leave its tree item exactly where it was`,
  );
  return result;
}

/** A name no fixture declares: absent from the listing AND from the tree. */
function assertGhostAbsent(
  items: vscode.TestItemCollection,
  ids: readonly string[],
  ghost: string,
): void {
  assert.strictEqual(
    ids.includes(ghost),
    false,
    `the fixture must not accidentally define ${ghost}`,
  );
  assert.strictEqual(ALL_EXPECTED.includes(ghost), false, `no fixture declares ${ghost}`);
  assert.strictEqual(
    findItem(items, ghost),
    undefined,
    'a name that does not exist must never become a tree item',
  );
  assert.strictEqual(
    collectLeafIds(items).length,
    27,
    'a lookup that matched nothing must not disturb the discovered tree',
  );
  assert.deepStrictEqual(
    sorted(collectLeafIds(items)),
    sorted(ALL_EXPECTED),
    'and the tree still holds exactly the fixtures’ names',
  );
}

/** The `--filter` VALUE and clause for one parenthesised name, character for character. */
function assertEscaped(fqn: string, expected: string): void {
  assert.strictEqual(escapeFilterValue(fqn), expected, `${fqn} must escape to exactly ${expected}`);
  assert.strictEqual(
    filterClause(fqn),
    `FullyQualifiedName=${expected}`,
    'the clause escapes the VALUE but never the FullyQualifiedName= key',
  );
  assert.strictEqual(
    /[^\\]\(/.test(filterClause(fqn)),
    false,
    `no bare '(' may reach VSTest for ${fqn}`,
  );
  assert.strictEqual(
    /[^\\]\)/.test(filterClause(fqn)),
    false,
    `no bare ')' may reach VSTest for ${fqn}`,
  );
  assert.strictEqual(
    expected.replace(/\\\(/g, '(').replace(/\\\)/g, ')'),
    fqn,
    `unescaping ${expected} must round-trip back to the FQN`,
  );
  assert.strictEqual(
    escapeFilterValue(expected).includes('\\\\'),
    true,
    'escaping is not idempotent — the backslash is grammar too',
  );
}

suite('Test Explorer e2e — xUnit, NUnit and MSTest across C# and F#', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let projectDirs: Map<string, string>;
  /** The REAL `dotnet test --list-tests` output, kept for parser assertions. */
  let listing: string;

  /** A fixture's project directory, asserted written by suiteSetup. */
  function dirFor(fixture: FrameworkFixture): string {
    const dir = projectDirs.get(fixture.key);
    assert.ok(dir, `suiteSetup must have written a project for ${fixture.key}`);
    return dir;
  }

  /** Discover the fixture solution unless the tree already holds every name. */
  async function ensureTree(): Promise<string[]> {
    const current = collectLeafIds(api.testController.items);
    if (ALL_EXPECTED.every((name) => current.includes(name))) return current;
    const ids = await discoverSolution(api, slnPath, ALL_EXPECTED);
    await api.testController.whenIdle();
    return ids;
  }

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-frameworks-'));
    projectDirs = writeAllProjects(root);
    slnPath = await createSolution(root, 'Frameworks', [...projectDirs.values()]);
    // Warm the FULL discovery path once — six restores, six builds, three VSTest
    // adapters JITted — so every test runs warm. The output is KEPT: the parser
    // assertions run against a genuine six-project listing, never an imitation.
    listing = await warmDiscovery(slnPath, root);
  });

  teardown(async () => {
    // Never leave a `dotnet` invocation in flight across tests: discovery builds
    // the same `bin/`/`obj/` a run rebuilds, and the overlap kills VSTest.
    await api.testController.whenIdle();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Drain reactive re-discovery BEFORE deleting the fixture.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('discovery finds every test in all six framework × language fixtures', async function () {
    this.timeout(DOTNET_CLI_MS);
    api.testController.items.replace([]);
    assert.deepStrictEqual(
      collectLeafIds(api.testController.items),
      [],
      'the tree starts empty, so everything below was discovered HERE',
    );
    const ids = await discoverSolution(api, slnPath, ALL_EXPECTED);
    assert.strictEqual(
      FRAMEWORK_FIXTURES.length,
      6,
      'six fixtures: three frameworks × two languages',
    );
    for (const fixture of FRAMEWORK_FIXTURES) assertFixtureInTree(fixture, ids);
    assert.strictEqual(
      ALL_EXPECTED.length,
      27,
      'the six fixtures declare 27 fully-qualified names',
    );
    assert.strictEqual(
      new Set(ALL_EXPECTED).size,
      27,
      'no fixture may claim a name another fixture already owns',
    );
    assert.strictEqual(
      new Set(ids).size,
      ids.length,
      `the tree must not contain duplicate ids: ${ids.join(', ')}`,
    );
    assert.strictEqual(
      ids.length,
      27,
      `exactly the fixtures' 27 tests must appear: ${ids.join(', ')}`,
    );
    assert.deepStrictEqual(
      sorted(ids),
      sorted(ALL_EXPECTED),
      'the tree is EXACTLY the fixtures’ name set — nothing extra, nothing missing',
    );
    assert.deepStrictEqual(
      MIXED_THEORIES,
      ['Fs.Xunit.Fixtures.mixed theory', 'Cs.Xunit.Fixtures.CalculatorTests.Mixed_Theory'],
      'both xUnit fixtures — and only they — carry a theory whose rows disagree',
    );
    for (const name of MIXED_THEORIES)
      assert.strictEqual(
        ids.filter((id) => id === name).length,
        1,
        `a theory whose rows disagree is ONE tree item, not one per row: ${name}`,
      );
    assert.strictEqual(
      ids.filter((id) => id.startsWith('Fs.')).length,
      14,
      'F# contributes 14 of the 27 names — F# never takes the backseat',
    );
    assert.strictEqual(
      ids.filter((id) => id.startsWith('Cs.')).length,
      13,
      'C# contributes the remaining 13 names',
    );
    assert.strictEqual(
      ids.filter((id) => id.includes('+')).length,
      4,
      'the four F# MSTest names, and only those, carry a CLR nested-type separator',
    );
    assert.strictEqual(
      ids.filter((id) => id.includes(' ')).length,
      8,
      'eight F# backtick names carry spaces the old `^[\\w.]+$` filter dropped',
    );
    assertNoChatter(ids);
  });

  test('the DisplayName listing loses NUnit and MSTest entirely — the FQN pass does not', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ids = await ensureTree();
    const [announced, displayNames] = [parseAnnouncedAssemblies(listing), parseTestList(listing)];
    assert.strictEqual(announced.length, 6, `one banner per project: ${announced.join(', ')}`);
    assert.strictEqual(new Set(announced).size, 6, 'no assembly may be announced twice');
    assert.deepStrictEqual(
      sorted(announced.map((one) => path.basename(one))),
      sorted(FRAMEWORK_FIXTURES.map((one) => `${one.projectName}.dll`)),
      'every fixture project, and only those, is announced by --list-tests',
    );
    assert.deepStrictEqual(
      parseTestAssemblies(listing),
      announced,
      'every announced assembly is on disk, so the filtered list is identical',
    );
    for (const assembly of announced) assertAnnouncedAssembly(assembly);
    for (const fixture of FRAMEWORK_FIXTURES.filter((one) => one.framework !== 'xunit'))
      assertInvisibleInListing(fixture, displayNames, ids);
    for (const fixture of FRAMEWORK_FIXTURES.filter((one) => one.framework === 'xunit'))
      assertXunitVisible(fixture, displayNames);
    assert.strictEqual(
      displayNames.includes('Adds_TwoNumbers'),
      false,
      'a bare method name is not a discovered test line — it has no namespace',
    );
    assert.strictEqual(
      displayNames.includes('AddsTwoNumbers'),
      false,
      'the F# MSTest bare member name is likewise dropped by the display listing',
    );
    assert.strictEqual(
      displayNames.includes(FS_SPACED_FACT),
      true,
      'the spaced F# xUnit name survives the display filter — spaces are legal in an FQN',
    );
    assert.strictEqual(
      new Set(displayNames).size,
      displayNames.length,
      'the display listing is de-duplicated',
    );
    assert.strictEqual(
      XUNIT_DISPLAY_NAMES.length,
      7,
      'seven of the 27 tests have a DisplayName equal to their FQN',
    );
    assert.deepStrictEqual(
      sorted(displayNames),
      sorted(XUNIT_DISPLAY_NAMES),
      'ONLY the xUnit facts survive the DisplayName listing — that is the whole of issue #180',
    );
    assert.strictEqual(
      displayNames.length < ids.length,
      true,
      `the display listing (${displayNames.length}) must be strictly WEAKER than the FQN tree (${ids.length})`,
    );
    assertNoChatter(ids);
  });

  test('every discovered item carries the label, description, uri and tags the tree renders', async function () {
    this.timeout(DOTNET_CLI_MS);
    await ensureTree();
    const snapshots = snapshotItems(api.testController.items);
    // Groups and tests render different row shapes — the hierarchy has both.
    const groupSnapshots = snapshots.filter((snapshot) => snapshot.childCount > 0);
    const testSnapshots = snapshots.filter((snapshot) => snapshot.childCount === 0);
    const labels = testSnapshots.map((snapshot) => snapshot.label);
    assert.strictEqual(
      testSnapshots.length,
      ALL_EXPECTED.length,
      'one snapshot per discovered test',
    );
    assert.strictEqual(testSnapshots.length, 27, 'the Testing view renders exactly 27 TEST rows');
    assert.strictEqual(
      groupSnapshots.length,
      18,
      'six assemblies plus their namespace and class groups render 18 GROUP rows',
    );
    assert.strictEqual(
      api.testController.items.size,
      6,
      'one root per fixture assembly — the 27 tests nest under them',
    );
    assert.deepStrictEqual(
      sorted(testSnapshots.map((snapshot) => snapshot.id)),
      sorted(ALL_EXPECTED),
      'the rendered TEST ids are exactly the fixtures’ names',
    );
    for (const snapshot of groupSnapshots) {
      assert.strictEqual(
        snapshot.childCount > 0,
        true,
        `a group row carries its children: ${snapshot.id}`,
      );
      assert.strictEqual(
        ALL_EXPECTED.includes(snapshot.id),
        false,
        `a group id is never an FQN: ${snapshot.id}`,
      );
      assert.strictEqual(
        snapshot.description,
        undefined,
        `a group row carries no FQN description: ${snapshot.id}`,
      );
      assert.deepStrictEqual(snapshot.tags, [], `a group row carries no tag: ${snapshot.id}`);
    }
    for (const snapshot of testSnapshots) assertItemShape(snapshot, root);
    assert.deepStrictEqual(
      snapshots.flatMap((snapshot) => snapshot.tags),
      [],
      'plain xUnit/NUnit/MSTest tests AND their groups carry no framework tag anywhere in the tree',
    );
    assert.strictEqual(
      new Set(snapshots.map((snapshot) => snapshot.uriPath)).size,
      1,
      'every item — test and group alike — shares the one discovery-target uri',
    );
    assert.strictEqual(
      new Set(testSnapshots.map((snapshot) => snapshot.description)).size,
      27,
      'descriptions stay unique even where labels collide',
    );
    assert.strictEqual(
      testSnapshots.reduce((sum, snapshot) => sum + snapshot.childCount, 0),
      0,
      'only GROUP rows carry children — every TEST row is a leaf',
    );
    assert.strictEqual(
      labels.filter((label) => label === 'Adds_TwoNumbers').length,
      3,
      'three C# fixtures share one label — which is WHY the description carries the FQN',
    );
    assert.strictEqual(
      labels.filter((label) => label === 'addsTwoNumbers').length,
      2,
      'the F# xUnit and F# NUnit bindings share a lower-camel label',
    );
    assert.strictEqual(
      labels.filter((label) => label === 'AddsTwoNumbers').length,
      1,
      'the F# MSTest member is the only PascalCase AddsTwoNumbers',
    );
    for (const fixture of FRAMEWORK_FIXTURES) assertProjectOnDisk(fixture, dirFor(fixture), root);
    for (const fixture of FRAMEWORK_FIXTURES)
      assertLeafItem(api.testController.items, fixture.parameterized);
  });

  test('the three awkward FQN shapes survive discovery verbatim', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ids = await ensureTree();
    assert.strictEqual(
      FS_SPACED_FACT,
      'Fs.Xunit.Fixtures.adds two numbers with spaces',
      'the spaced F# name, asserted character for character',
    );
    assert.strictEqual(
      FS_NUNIT_CASE,
      'Fs.Nunit.Fixtures.adds case(2,2,4)',
      'the F# NUnit case name mixes a SPACE and PARENTHESES in one FQN',
    );
    assert.strictEqual(
      CS_NUNIT_CASE,
      'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)',
      'the C# NUnit case name, character for character',
    );
    assert.strictEqual(
      FS_MSTEST_NESTED,
      'Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers',
      'the F# MSTest nested-type name, character for character',
    );
    assert.strictEqual(
      fixtureByKey('xunit-fsharp').passing,
      'Fs.Xunit.Fixtures.addsTwoNumbers',
      'the spaced fact is an EXTRA name, not the fixture’s passing one',
    );
    assert.strictEqual(
      fixtureByKey('nunit-fsharp').parameterized,
      FS_NUNIT_CASE,
      'the F# [<TestCase>] FQN is that fixture’s data-driven name',
    );
    assert.strictEqual(
      fixtureByKey('nunit-csharp').parameterized,
      CS_NUNIT_CASE,
      'the C# [TestCase] FQN is that fixture’s data-driven name',
    );
    assert.strictEqual(
      fixtureByKey('mstest-fsharp').passing,
      FS_MSTEST_NESTED,
      'the nested-type FQN is the F# MSTest fixture’s passing name',
    );
    for (const shape of AWKWARD_SHAPES) assertShapeSurvives(api.testController.items, ids, shape);
    assert.strictEqual(
      FS_SPACED_FACT.split(' ').length,
      5,
      'the spaced name really carries four spaces, not one',
    );
    assert.strictEqual(
      FS_MSTEST_NESTED.split('.').length,
      4,
      '`+` is not a dotted separator: the name still has four dotted segments',
    );
    assert.strictEqual(
      FS_MSTEST_NESTED.split('+').length,
      2,
      'exactly one CLR nested-type separator',
    );
    assert.strictEqual(
      ids.filter((id) => id.includes('(')).length,
      2,
      'exactly the two NUnit [TestCase] names carry row data in the FQN',
    );
    assert.strictEqual(
      ids.filter((id) => id.endsWith('(2,2,4)')).length,
      2,
      'and both keep the argument list verbatim',
    );
    assert.strictEqual(
      fixtureByKey('xunit-csharp').parameterized.includes('('),
      false,
      'an xUnit [Theory] FQN carries NO row data — that is NUnit-only',
    );
    assert.strictEqual(
      fixtureByKey('mstest-csharp').parameterized.includes('('),
      false,
      'an MSTest [DataRow] FQN carries no row data either',
    );
  });

  test('F# first: one passing test from each F# fixture runs green through the controller', async function () {
    this.timeout(DOTNET_CLI_MS);
    await ensureTree();
    const fsharp = FRAMEWORK_FIXTURES.filter((fixture) => fixture.language === 'fsharp');
    assert.strictEqual(fsharp.length, 3, 'F# must cover xUnit, NUnit and MSTest');
    assert.deepStrictEqual(
      fsharp.map((one) => one.framework),
      ['xunit', 'nunit', 'mstest'],
      'the F# fixtures come first in FRAMEWORK_FIXTURES — F# never takes the backseat',
    );
    assert.deepStrictEqual(
      fsharp.map((one) => one.key),
      ['xunit-fsharp', 'nunit-fsharp', 'mstest-fsharp'],
      'the F# fixture keys, in build order',
    );
    assert.deepStrictEqual(
      FRAMEWORK_FIXTURES.slice(0, 3),
      fsharp,
      'F# FIRST: every F# fixture is built, listed and RUN before any C# one',
    );
    for (const fixture of fsharp) {
      const result = await runGreen(api.testController, fixture, fixture.passing, dirFor(fixture));
      assert.strictEqual(
        fixture.passing.startsWith('Fs.'),
        true,
        `${fixture.key}: an F# FQN starts at the F# module`,
      );
      assert.strictEqual(
        api.testController.getResult(fixture.passing),
        result,
        `${fixture.key}: the cache hands back the very object the run produced`,
      );
      assert.notStrictEqual(
        api.testController.getResult(fixture.failing)?.outcome,
        'passed',
        `${fixture.key}: running the passing test must never mark the failing one green`,
      );
      assert.notStrictEqual(
        api.testController.getResult(fixture.skipped)?.outcome,
        'passed',
        `${fixture.key}: nor the skipped one`,
      );
      assert.strictEqual(
        findItem(api.testController.items, fixture.passing)?.description,
        fixture.passing,
        `${fixture.key}: a run leaves the tree item untouched`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size >= 3,
      true,
      'three F# runs leave at least three cached results',
    );
    for (const one of fsharp)
      assert.strictEqual(
        api.testController.getResult(one.passing)?.outcome,
        'passed',
        `${one.key}: still cached green once the later F# runs finished`,
      );
    for (const one of fsharp)
      assert.strictEqual(
        api.testController.getResult(one.passing)?.message,
        undefined,
        `${one.key}: a green F# run leaves no message behind`,
      );
  });

  test('and then C#: one passing test from each C# fixture runs green through the controller', async function () {
    this.timeout(DOTNET_CLI_MS);
    await ensureTree();
    const csharp = FRAMEWORK_FIXTURES.filter((fixture) => fixture.language === 'csharp');
    assert.strictEqual(csharp.length, 3, 'C# must cover xUnit, NUnit and MSTest');
    assert.deepStrictEqual(
      csharp.map((one) => one.framework),
      ['xunit', 'nunit', 'mstest'],
      'the C# fixtures mirror the F# ones, framework for framework',
    );
    assert.deepStrictEqual(
      csharp.map((one) => one.key),
      ['xunit-csharp', 'nunit-csharp', 'mstest-csharp'],
      'the C# fixture keys, in build order',
    );
    assert.deepStrictEqual(
      FRAMEWORK_FIXTURES.slice(3),
      csharp,
      'the C# fixtures are the LAST three — F# leads',
    );
    for (const fixture of csharp) {
      const result = await runGreen(api.testController, fixture, fixture.passing, dirFor(fixture));
      assert.strictEqual(
        fixture.passing.startsWith('Cs.'),
        true,
        `${fixture.key}: a C# FQN starts at the C# namespace`,
      );
      assert.strictEqual(
        fixture.passing.split('.').length,
        5,
        `${fixture.key}: a three-part namespace, a class and a method — five dotted segments`,
      );
      assert.strictEqual(
        result.message,
        undefined,
        `${fixture.key}: a green C# run leaves no message behind`,
      );
      assert.notStrictEqual(
        api.testController.getResult(fixture.failing),
        result,
        `${fixture.key}: results are keyed per test, never shared across a project`,
      );
      assert.notStrictEqual(
        api.testController.getResult(fixture.failing)?.outcome,
        'passed',
        `${fixture.key}: the failing sibling is never marked green by this run`,
      );
    }
    assert.strictEqual(
      api.testController.cachedResults.size >= 6,
      true,
      'all six fixtures have now cached a passing result',
    );
    for (const one of FRAMEWORK_FIXTURES)
      assert.strictEqual(
        api.testController.getResult(one.passing)?.passed,
        true,
        `${one.key}: every fixture’s passing test is cached as a genuine pass`,
      );
    for (const one of FRAMEWORK_FIXTURES)
      assert.strictEqual(
        api.testController.cachedResults.has(one.passing),
        true,
        `${one.key}: keyed by its FQN, not by label`,
      );
  });

  test('an NUnit [TestCase] name with parentheses runs green — the filter-escaping regression', async function () {
    this.timeout(DOTNET_CLI_MS);
    await ensureTree();
    const [fsNunit, csNunit] = [fixtureByKey('nunit-fsharp'), fixtureByKey('nunit-csharp')];
    assert.strictEqual(fsNunit.parameterized, FS_NUNIT_CASE, 'the F# [<TestCase>] FQN, verbatim');
    assert.strictEqual(csNunit.parameterized, CS_NUNIT_CASE, 'the C# [TestCase] FQN, verbatim');
    // Unescaped, `(2,2,4)` is filter GRAMMAR: the NUnit adapter throws.
    assertEscaped(FS_NUNIT_CASE, 'Fs.Nunit.Fixtures.adds case\\(2,2,4\\)');
    assertEscaped(CS_NUNIT_CASE, 'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)');
    assert.strictEqual(
      escapeFilterValue(FS_NUNIT_CASE).includes(' '),
      true,
      'a SPACE is not filter grammar, so it passes through unescaped',
    );
    assert.strictEqual(
      escapeFilterValue(FS_MSTEST_NESTED),
      FS_MSTEST_NESTED,
      '`+` is not filter grammar either — escaping it would break the MSTest filter',
    );
    assert.strictEqual(
      escapeFilterValue(FS_SPACED_FACT),
      FS_SPACED_FACT,
      'a spaced xUnit name needs no escaping at all',
    );
    assert.deepStrictEqual(
      buildFilterArgs([{ id: CS_NUNIT_CASE }]),
      ['--filter', 'FullyQualifiedName=Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)'],
      'the escaped clause is EXACTLY what reaches the dotnet CLI',
    );
    assert.strictEqual(
      filterExpression([FS_NUNIT_CASE, CS_NUNIT_CASE]),
      `${filterClause(FS_NUNIT_CASE)}|${filterClause(CS_NUNIT_CASE)}`,
      'clauses are OR-ed with the grammar’s union operator',
    );
    await runGreen(api.testController, fsNunit, FS_NUNIT_CASE, dirFor(fsNunit));
    await runGreen(api.testController, csNunit, CS_NUNIT_CASE, dirFor(csNunit));
    assert.strictEqual(
      api.testController.getResult(FS_NUNIT_CASE)?.outcome,
      'passed',
      'the F# parenthesised case is cached as a pass, not an adapter crash',
    );
    assert.strictEqual(
      api.testController.getResult(CS_NUNIT_CASE)?.outcome,
      'passed',
      'the C# parenthesised case is cached as a pass, not an adapter crash',
    );
    assert.strictEqual(
      api.testController.getResult(FS_NUNIT_CASE)?.message,
      undefined,
      'a green parenthesised run leaves no failure message',
    );
  });

  test('a run of a name that does not exist reports notRun, names the test, and never reports a pass', async function () {
    this.timeout(DOTNET_CLI_MS);
    // Deliberately OUTSIDE every fixture's namespace: the extension host runs one
    // controller for the whole suite, and its result cache outlives a suite, so a
    // ghost id sharing a fixture's prefix pollutes a neighbouring suite's counts.
    const ghost = 'Ghost.Frameworks.NoSuchClass.No_Such_Test_Here';
    const fixture = fixtureByKey('xunit-csharp');
    const ids = await ensureTree();
    assertGhostAbsent(api.testController.items, ids, ghost);
    const notified = nextResultsChange(api.testController, DOTNET_CLI_MS);
    const result = await api.testController.runSingle(ghost, dirFor(fixture));
    assertNotRun(result, ghost);
    assert.strictEqual(await notified, true, 'a notRun result still notifies the lens listeners');
    assert.strictEqual(
      api.testController.getResult(ghost),
      result,
      'the notRun result is cached like any other',
    );
    assert.strictEqual(
      api.testController.cachedResults.get(ghost),
      result,
      'cachedResults exposes the very object runSingle resolved',
    );
    assertGhostAbsent(api.testController.items, collectLeafIds(api.testController.items), ghost);
    // The controller is not poisoned: a real test still runs green afterwards.
    await runGreen(api.testController, fixture, fixture.passing, dirFor(fixture));
    assert.strictEqual(
      api.testController.getResult(ghost)?.outcome,
      'notRun',
      'the ghost result stays notRun — a later run must never overwrite another id',
    );
    assert.strictEqual(
      api.testController.getResult(ghost)?.message,
      `No result reported for ${ghost}`,
      'and it keeps naming the id that matched nothing',
    );
    assert.notStrictEqual(
      api.testController.getResult(ghost),
      api.testController.getResult(fixture.passing),
      'the ghost and the real test hold distinct cached results',
    );
  });
});
