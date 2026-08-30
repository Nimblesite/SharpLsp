// The [DIST-CI-WIN-VSIX] guard for the Test Explorer: what breaks when a real
// user's repo does NOT live at `/tmp/x`. The fixture is built inside `Program
// Files (x86) copy/My Tests`, because a `Test run for <path> (.NETCoreApp,…)`
// banner sliced at the FIRST ` (` truncates there, enumerates nothing and
// silently empties the tree; VSTest's `--filter` grammar reserves `( ) & | = !
// ~ \`, so an unescaped NUnit `[TestCase]` FQN makes the adapter throw; and
// every outcome string parsed here is ENGLISH, on the platform most likely to
// be installed in another language. Parsers are driven against Windows shapes:
// CRLF, a UTF-8 BOM, drive-letter stack traces. Covers [DIST-CI-WIN-VSIX],
// [TEST-DISCOVERY-FQN], [TEST-FILTER-ESCAPE], [TEST-RUN-TRX], [TEST-ENV-LOCALE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  parseAnnouncedAssemblies,
  parseTestAssemblies,
  resolveAnnouncedAssembly,
} from '../../test-discovery.js';
import { buildFilterArgs, runTests } from '../../test-execution.js';
import { escapeFilterValue, filterClause, filterExpression } from '../../test-filter.js';
import { createSolution, projectXml, warmDiscovery, writeProject } from './dotnet-project-kit';
import { fixtureFor } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectItemIds,
  discoverSolution,
  drainDiscovery,
  findItem,
  snapshotItems,
} from './test-explorer-kit';
import { comparablePath, removeDirRecursive } from './test-helpers.js';
import { DOTNET_CLI_MS, FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';

const CS = fixtureFor('xunit-csharp');
const FS_FIXTURE = fixtureFor('xunit-fsharp');

/** The idiomatic F# backtick binding whose xUnit FQN literally contains spaces. */
const FS_FACT_SPACED = 'Fs.Xunit.Fixtures.adds two numbers with spaces';
/** The C# theory whose two rows DISAGREE — both report under this one name. */
const CS_MIXED_THEORY = 'Cs.Xunit.Fixtures.CalculatorTests.Mixed_Theory';

/** EXHAUSTIVELY every FQN the two xUnit fixtures expose: six F# (first), five C#. */
const EXPECTED = [
  FS_FIXTURE.passing,
  FS_FACT_SPACED,
  FS_FIXTURE.failing,
  FS_FIXTURE.skipped,
  FS_FIXTURE.parameterized,
  'Fs.Xunit.Fixtures.mixed theory',
  CS.passing,
  CS.failing,
  CS.skipped,
  CS.parameterized,
  CS_MIXED_THEORY,
] as const;

/** The real NUnit `[TestCase]` FQNs — the ones that kill the adapter unescaped. */
const NUNIT_CASE = 'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)';
const FS_NUNIT_CASE = 'Fs.Nunit.Fixtures.adds case(2,2,4)';
/** The F# MSTest FQN, carrying the CLR nested-type `+` separator. */
const FS_MSTEST_NESTED = 'Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers';

/** Order-independent comparison of two name lists. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

suite('Test Explorer e2e — Windows-hostile paths, encodings and filter grammar', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  /** The hostile directory: a space AND parentheses in one path segment. */
  let hostileDir: string;
  let slnPath: string;
  let listing: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testexplorer-win-'));
    // The most common real Windows path with a space followed by `(`.
    hostileDir = path.join(root, 'Program Files (x86) copy', 'My Tests');
    fs.mkdirSync(hostileDir, { recursive: true });
    const projectDirs = [CS, FS_FIXTURE].map((fixture) =>
      writeProject(
        path.join(hostileDir, fixture.projectName),
        fixture.projectFileName,
        projectXml(
          fixture.packages,
          ...(fixture.language === 'fsharp' ? [fixture.sourceFileName] : []),
        ),
        fixture.sourceFileName,
        fixture.source,
      ),
    );
    slnPath = await createSolution(hostileDir, 'Hostile', projectDirs);
    // Pay the cold restore once; the banner assertions read this REAL listing.
    listing = await warmDiscovery(slnPath, hostileDir);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // A `dotnet test` pointed at a deleted directory hangs forever and poisons
    // every later suite, so the debounced sweep lands BEFORE the fixture goes.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('discovery survives a solution directory carrying a space AND parentheses', async function () {
    this.timeout(DOTNET_CLI_MS);
    // The premise of this whole suite: the fixture really is in a hostile path.
    assert.strictEqual(
      path.basename(path.dirname(hostileDir)),
      'Program Files (x86) copy',
      'the fixture must sit under a directory carrying a space AND parentheses',
    );
    assert.strictEqual(
      path.basename(hostileDir),
      'My Tests',
      'the leaf fixture directory carries a space of its own',
    );
    assert.strictEqual(
      hostileDir.includes(' ('),
      true,
      `the fixture path must contain the ' (' sequence the banner parser slices on: ${hostileDir}`,
    );
    assert.strictEqual(
      hostileDir.includes(')'),
      true,
      `the fixture path must contain a closing paren: ${hostileDir}`,
    );
    assert.strictEqual(
      path.dirname(slnPath),
      hostileDir,
      'the solution must live directly inside the hostile directory',
    );
    assert.strictEqual(
      fs.existsSync(slnPath),
      true,
      `dotnet new sln must have produced ${slnPath}`,
    );
    assert.strictEqual(
      slnPath.endsWith('.slnx') || slnPath.endsWith('.sln'),
      true,
      `dotnet new sln produced an unexpected file: ${slnPath}`,
    );
    api.testController.items.replace([]);
    assert.strictEqual(
      collectItemIds(api.testController.items).length,
      0,
      'the tree starts empty for this test',
    );
    assert.strictEqual(
      api.testController.items.size,
      0,
      'clearing the tree empties the controller collection itself',
    );
    // Load the hostile solution and open the Testing view, exactly as a user does.
    const ids = await discoverSolution(api, slnPath, EXPECTED);
    for (const expected of EXPECTED) {
      assert.strictEqual(
        ids.includes(expected),
        true,
        `must be discovered from a hostile path: ${expected}\ngot: ${ids.join(', ')}`,
      );
      assert.strictEqual(
        ids.filter((id) => id === expected).length,
        1,
        `${expected} must appear EXACTLY once in the tree`,
      );
    }
    assert.deepStrictEqual(
      sorted(ids),
      sorted(EXPECTED),
      `the tree must be exactly the fixture's tests: ${ids.join(', ')}`,
    );
    assert.strictEqual(
      ids.length,
      EXPECTED.length,
      `exactly ${String(EXPECTED.length)} tests must be discovered: ${ids.join(', ')}`,
    );
    assert.strictEqual(
      new Set(ids).size,
      ids.length,
      `the tree must carry no duplicate ids: ${ids.join(', ')}`,
    );
    assert.strictEqual(
      ids.includes(FS_FACT_SPACED),
      true,
      `the spaced F# name must survive a spaced PATH too: ${FS_FACT_SPACED}`,
    );
    assert.strictEqual(
      ids.filter((id) => id.startsWith('Fs.Xunit.Fixtures.')).length,
      6,
      'all six F# tests are discovered — F# is never the afterthought',
    );
    assert.strictEqual(
      ids.filter((id) => id.startsWith('Cs.Xunit.Fixtures.CalculatorTests.')).length,
      5,
      'all five C# tests are discovered',
    );
    assert.strictEqual(
      ids.some((id) => id.includes('Test run for') || id.includes('Passed!')),
      false,
      'VSTest banner/summary chatter must never become a test item',
    );
    assert.strictEqual(
      ids.some((id) => id.includes('(a: 2')),
      false,
      "a theory's ROWS collapse into the one parameterless FQN VSTest filters on",
    );
    // Every item is anchored at the hostile dir — the uri the view reveals with.
    const snapshots = snapshotItems(api.testController.items);
    assert.strictEqual(
      snapshots.length,
      EXPECTED.length,
      `one snapshot per discovered test, got ${String(snapshots.length)}`,
    );
    assert.deepStrictEqual(
      sorted(snapshots.map((snapshot) => snapshot.id)),
      sorted(EXPECTED),
      'the snapshots are the discovered items, one for one',
    );
    for (const snapshot of snapshots) {
      assert.strictEqual(
        comparablePath(snapshot.uriPath ?? ''),
        comparablePath(hostileDir),
        `${snapshot.id} must be anchored at the hostile solution directory, parentheses and all`,
      );
      assert.strictEqual(
        snapshot.description,
        snapshot.id,
        'the description carries the full FQN so same-named methods disambiguate',
      );
      assert.strictEqual(
        snapshot.label,
        snapshot.id.split('.').at(-1),
        `the label must be the last dotted segment of ${snapshot.id}`,
      );
      assert.strictEqual(snapshot.childCount, 0, 'discovery produces a flat tree');
      assert.deepStrictEqual(
        snapshot.tags,
        [],
        `${snapshot.id} is plain xUnit and must carry no framework tag`,
      );
    }
    const spaced = findItem(api.testController.items, FS_FACT_SPACED);
    assert.ok(spaced, `${FS_FACT_SPACED} must resolve by id`);
    assert.strictEqual(
      spaced.id,
      FS_FACT_SPACED,
      'findItem returns the item carrying the requested id',
    );
    assert.strictEqual(
      spaced.label,
      'adds two numbers with spaces',
      'the F# label keeps every space',
    );
    assert.strictEqual(
      spaced.description,
      FS_FACT_SPACED,
      'the F# description is the whole FQN, spaces included',
    );
    assert.strictEqual(spaced.canResolveChildren, false, 'a leaf test resolves no children');
    assert.strictEqual(spaced.children.size, 0, 'a leaf test has no children');
    assert.strictEqual(
      comparablePath(spaced.uri?.fsPath ?? ''),
      comparablePath(hostileDir),
      'the spaced F# test is revealed inside the hostile directory',
    );
    const mixed = findItem(api.testController.items, CS_MIXED_THEORY);
    assert.ok(mixed, `${CS_MIXED_THEORY} must be ONE item, not one per theory row`);
    assert.strictEqual(
      mixed.label,
      'Mixed_Theory',
      'the theory item is labelled by its method name, with no row data',
    );
    assert.strictEqual(
      mixed.description,
      CS_MIXED_THEORY,
      'the theory item keeps the FQN --filter accepts',
    );
    assert.strictEqual(
      findItem(api.testController.items, 'Cs.Xunit.Fixtures.CalculatorTests.Nope'),
      undefined,
      'findItem must never invent an item for an unknown id',
    );
  });

  test('the assembly banner parser strips the framework suffix from the RIGHT of a hostile path', function () {
    this.timeout(FAST_MS);
    // The genuine listing for a path containing ` (` — why `lastIndexOf` exists.
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

    // The banner path comes through MSBuild, which PERCENT-ESCAPES the
    // characters it reserves — `(` becomes `%28`, `)` becomes `%29`. That is why
    // `C:\Program Files (x86)\…`, the commonest hostile Windows path there is,
    // is announced as a path that does not exist. Resolving it is what keeps the
    // fully-qualified listing from being skipped and discovery from silently
    // degrading to DISPLAY names — which loses every NUnit, MSTest and theory.
    const resolved = parseTestAssemblies(listing);
    assert.strictEqual(
      resolved.length,
      2,
      `both projects must resolve to a real file: ${announced.join(', ')}`,
    );
    for (const assembly of announced) {
      assert.strictEqual(path.isAbsolute(assembly), true, `${assembly} must be an absolute path`);
      assert.strictEqual(
        path.extname(assembly),
        '.dll',
        `${assembly} must be an assembly, not a truncated prefix`,
      );
      assert.strictEqual(
        assembly.includes('(.NETCoreApp'),
        false,
        `the framework suffix must be stripped: ${assembly}`,
      );
      assert.strictEqual(
        assembly.includes('Version=v'),
        false,
        `no part of the framework moniker may survive: ${assembly}`,
      );
      assert.strictEqual(
        path.basename(path.dirname(assembly)),
        'net10.0',
        `${assembly} must sit in its target-framework output directory`,
      );
      assert.notStrictEqual(
        resolveAnnouncedAssembly(assembly),
        undefined,
        `${assembly} must resolve to a file on disk, escaped or not`,
      );
    }
    for (const assembly of resolved) {
      assert.strictEqual(
        fs.existsSync(assembly),
        true,
        `${assembly} must exist on disk — a truncated or still-escaped path never does`,
      );
      assert.strictEqual(
        assembly.includes('%28'),
        false,
        `${assembly} must not still carry MSBuild's escaping`,
      );
      assert.strictEqual(
        assembly.includes(' ('),
        true,
        `the path's OWN ' (' must survive the strip: ${assembly}`,
      );
      assert.strictEqual(
        assembly.includes('Program Files (x86) copy'),
        true,
        `${assembly} must keep the hostile directory name intact`,
      );
      assert.strictEqual(
        assembly.includes('My Tests'),
        true,
        `${assembly} must keep the spaced leaf directory`,
      );
      assert.strictEqual(
        comparablePath(assembly).startsWith(comparablePath(hostileDir)),
        true,
        `${assembly} must still be rooted in the hostile directory`,
      );
      assert.strictEqual(path.extname(assembly), '.dll', `${assembly} resolves to an assembly`);
    }

    assert.strictEqual(
      resolveAnnouncedAssembly(path.join(hostileDir, 'nope.dll')),
      undefined,
      'a path that exists in neither spelling resolves to undefined',
    );
    // `unescapeMsBuildPath` itself is asserted exhaustively next door, in
    // test-explorer-parsers.test.ts, against every escape MSBuild emits.

    const csAssembly = announced.find((assembly) => assembly.endsWith(`${CS.projectName}.dll`));
    const fsAssembly = announced.find((assembly) =>
      assembly.endsWith(`${FS_FIXTURE.projectName}.dll`),
    );
    assert.ok(csAssembly, `the C# assembly must be announced: ${announced.join(', ')}`);
    assert.ok(fsAssembly, `the F# assembly must be announced: ${announced.join(', ')}`);
    assert.strictEqual(
      path.basename(csAssembly),
      'XunitCs.dll',
      'the C# banner names the C# assembly exactly',
    );
    assert.strictEqual(
      path.basename(fsAssembly),
      'XunitFs.dll',
      'the F# banner names the F# assembly exactly',
    );
    // And prove the naive parse breaks. MSBuild escapes the parentheses out of
    // the raw banner, so the proof runs on the RESOLVED path — the real on-disk
    // spelling, which genuinely carries ' (' inside a directory NAME.
    const assembly = resolved[0];
    assert.ok(assembly !== undefined, 'the listing must resolve at least one assembly');
    assert.strictEqual(
      assembly.includes(' ('),
      true,
      `the resolved path must carry the hostile ' (': ${assembly}`,
    );
    const banner = `Test run for ${assembly} (.NETCoreApp,Version=v10.0)`;
    assert.deepStrictEqual(
      parseAnnouncedAssemblies(banner),
      [assembly],
      'the banner round-trips through the parser',
    );
    assert.deepStrictEqual(
      parseAnnouncedAssemblies(`${banner}\r\n${banner}\r\n`),
      [assembly],
      'CRLF banners parse, and the repeat yields one entry',
    );
    assert.deepStrictEqual(
      parseAnnouncedAssemblies(`    ${banner}`),
      [assembly],
      'an indented banner is trimmed before it is parsed',
    );
    assert.deepStrictEqual(
      parseAnnouncedAssemblies('Build succeeded.\nDetermining projects to restore...'),
      [],
      'build chatter announces no assembly',
    );
    assert.deepStrictEqual(parseAnnouncedAssemblies(''), [], 'empty output announces no assembly');
    const rest = banner.slice('Test run for '.length);
    assert.strictEqual(
      rest.indexOf(' (') < rest.lastIndexOf(' ('),
      true,
      "the banner must contain more than one ' (' or this test proves nothing",
    );
    const naive = rest.slice(0, rest.indexOf(' ('));
    assert.strictEqual(
      comparablePath(naive),
      comparablePath(path.join(root, 'Program Files')),
      "the FIRST ' (' lands inside the directory NAME, so a naive slice yields '<root>/Program Files'",
    );
    assert.strictEqual(
      fs.existsSync(naive),
      false,
      'the naively sliced path is not on disk — which is how the tree silently emptied',
    );
    assert.notStrictEqual(
      naive,
      assembly,
      "slicing at the FIRST ' (' must truncate — that is the bug this parser fixes",
    );
  });

  test('running a C# and an F# test from a hostile directory reports real per-test outcomes', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ids = await discoverSolution(api, slnPath, EXPECTED);
    assert.strictEqual(
      ids.includes(FS_FIXTURE.passing),
      true,
      'the F# test about to be run must be in the tree',
    );
    assert.strictEqual(
      ids.includes(CS.skipped),
      true,
      'the skipped C# test about to be run must be in the tree',
    );
    let resultEvents = 0;
    const subscription = api.testController.onResultsChanged(() => {
      resultEvents += 1;
    });
    try {
      // F# first: F# is never the afterthought.
      const fsResult = await api.testController.runSingle(FS_FIXTURE.passing, hostileDir);
      assert.strictEqual(
        fsResult.outcome,
        'passed',
        `${FS_FIXTURE.passing} must pass when run from '${hostileDir}'`,
      );
      assert.strictEqual(fsResult.passed, true, 'a passing F# test reports passed === true');
      assert.strictEqual(fsResult.message, undefined, 'a passing test carries no failure message');
      assert.deepStrictEqual(
        sorted(Object.keys(fsResult)),
        ['duration', 'message', 'outcome', 'passed'],
        'a cached result carries exactly these four fields',
      );
      assert.strictEqual(
        typeof fsResult.duration,
        'number',
        'TRX must yield a numeric duration for a test that really ran',
      );
      assert.strictEqual(
        (fsResult.duration ?? -1) >= 0,
        true,
        `a duration must never be negative: ${String(fsResult.duration)}`,
      );
      // SPACES in the FQN, run from a path with spaces: one `--filter` argument.
      const spacedResult = await api.testController.runSingle(FS_FACT_SPACED, hostileDir);
      assert.strictEqual(
        spacedResult.outcome,
        'passed',
        `${FS_FACT_SPACED} must run and pass — a space is not a filter delimiter`,
      );
      assert.strictEqual(spacedResult.passed, true, 'the spaced F# test reports a genuine pass');
      assert.strictEqual(
        spacedResult.message,
        undefined,
        'the spaced filter matched a real test, so nothing was reported missing',
      );
      // A REAL failure, carrying the adapter's own assertion text.
      const failedResult = await api.testController.runSingle(FS_FIXTURE.failing, hostileDir);
      assert.strictEqual(
        failedResult.outcome,
        'failed',
        `${FS_FIXTURE.failing} must be reported as a failure`,
      );
      assert.strictEqual(failedResult.passed, false, 'a failing test is never reported as passed');
      assert.ok(failedResult.message, 'a failure must carry the assertion text VSTest reported');
      assert.strictEqual(
        failedResult.message.includes('Assert.Equal()'),
        true,
        `the xUnit assertion text must reach the user: ${failedResult.message}`,
      );
      assert.notStrictEqual(
        failedResult.message,
        'Test failed',
        'the placeholder message means the TRX message was lost',
      );
      // A SKIP is not a failure — the bug the whole TRX pipeline replaced.
      const skippedResult = await api.testController.runSingle(CS.skipped, hostileDir);
      assert.strictEqual(
        skippedResult.outcome,
        'skipped',
        `${CS.skipped} must be reported as SKIPPED, not failed`,
      );
      assert.strictEqual(skippedResult.passed, false, 'a skip is not a pass either');
      assert.notStrictEqual(
        skippedResult.outcome,
        'failed',
        "TRX 'NotExecuted' must never surface as a failure",
      );
      const csResult = await api.testController.runSingle(CS.passing, hostileDir);
      assert.strictEqual(
        csResult.outcome,
        'passed',
        `${CS.passing} must pass when run from '${hostileDir}'`,
      );
      assert.strictEqual(csResult.passed, true, 'a passing C# test reports passed === true');
      assert.strictEqual(csResult.message, undefined, 'a passing test carries no failure message');
      assert.strictEqual(
        typeof csResult.duration,
        'number',
        'TRX must yield a duration for the C# test too',
      );
      // Every run must have been cached and announced to the lens/decoration layer.
      assert.strictEqual(
        resultEvents,
        5,
        `each runSingle must fire onResultsChanged exactly once, saw ${String(resultEvents)}`,
      );
      assert.deepStrictEqual(
        api.testController.getResult(FS_FIXTURE.passing),
        fsResult,
        'the F# result is cached verbatim',
      );
      assert.deepStrictEqual(
        api.testController.getResult(FS_FACT_SPACED),
        spacedResult,
        'the spaced F# result is cached verbatim',
      );
      assert.deepStrictEqual(
        api.testController.getResult(FS_FIXTURE.failing),
        failedResult,
        'the F# failure is cached verbatim, message and all',
      );
      assert.deepStrictEqual(
        api.testController.getResult(CS.skipped),
        skippedResult,
        'the skip is cached verbatim',
      );
      assert.deepStrictEqual(
        api.testController.getResult(CS.passing),
        csResult,
        'the C# result is cached verbatim',
      );
      const cached = api.testController.cachedResults;
      assert.strictEqual(
        cached.has(FS_FIXTURE.passing),
        true,
        'the cache is keyed by fully-qualified name for F#',
      );
      assert.strictEqual(
        cached.has(FS_FACT_SPACED),
        true,
        'a name with spaces is a valid cache key',
      );
      assert.strictEqual(
        cached.has(CS.passing),
        true,
        'the cache is keyed by fully-qualified name for C#',
      );
      assert.strictEqual(
        cached.get(CS.skipped)?.outcome,
        'skipped',
        'the cache keeps a skip a skip',
      );
      assert.strictEqual(
        cached.get(FS_FIXTURE.failing)?.passed,
        false,
        'the cache keeps a failure a failure',
      );
      assert.strictEqual(
        cached.has(FS_MSTEST_NESTED),
        false,
        'a test that was never run has no cache entry',
      );
      assert.strictEqual(
        api.testController.getResult('Ns.Nope.Missing'),
        undefined,
        'an unknown name has no cached result',
      );
    } finally {
      subscription.dispose();
    }
  });

  test('the filter grammar escapes every VSTest metacharacter and nothing else', function () {
    this.timeout(FAST_MS);
    // Each of these is grammar to VSTest, so each must be backslash-escaped.
    assert.strictEqual(
      escapeFilterValue('\\'),
      '\\\\',
      'the backslash itself must be escaped, or the escape is forgeable',
    );
    assert.strictEqual(escapeFilterValue('('), '\\(', 'an open paren opens a sub-expression');
    assert.strictEqual(escapeFilterValue(')'), '\\)', 'a close paren closes a sub-expression');
    assert.strictEqual(escapeFilterValue('&'), '\\&', 'ampersand is the AND operator');
    assert.strictEqual(escapeFilterValue('|'), '\\|', 'pipe is the OR operator');
    assert.strictEqual(escapeFilterValue('='), '\\=', 'equals separates property from value');
    assert.strictEqual(escapeFilterValue('!'), '\\!', 'bang is negation');
    assert.strictEqual(escapeFilterValue('~'), '\\~', 'tilde is the contains operator');
    assert.strictEqual(
      escapeFilterValue('a(b)c&d|e=f!g~h\\i'),
      'a\\(b\\)c\\&d\\|e\\=f\\!g\\~h\\\\i',
      'every metacharacter in one value is escaped, not just the first',
    );
    assert.strictEqual(
      escapeFilterValue('((('),
      '\\(\\(\\(',
      'EVERY occurrence is escaped — a non-global replace is the classic incomplete-sanitization bug',
    );
    assert.strictEqual(
      escapeFilterValue('\\('),
      '\\\\\\(',
      'escaping is deliberately NOT idempotent: a value is escaped exactly once, at the clause',
    );
    // These are NOT grammar. Escaping them would change the value and stop it matching.
    assert.strictEqual(
      escapeFilterValue(','),
      ',',
      'a comma is data — NUnit case arguments are comma-separated',
    );
    assert.strictEqual(
      escapeFilterValue(' '),
      ' ',
      'a space is data — F# backtick names are full of them',
    );
    assert.strictEqual(
      escapeFilterValue('.'),
      '.',
      'a dot is the namespace separator, not grammar',
    );
    assert.strictEqual(
      escapeFilterValue('+'),
      '+',
      'plus is the CLR nested-type separator, not grammar',
    );
    assert.strictEqual(
      escapeFilterValue('a-b_c'),
      'a-b_c',
      'hyphen and underscore are ordinary identifier characters',
    );
    assert.strictEqual(
      escapeFilterValue('0123456789'),
      '0123456789',
      'digits pass through untouched',
    );
    assert.strictEqual(
      escapeFilterValue('adds_二つ_числа'),
      'adds_二つ_числа',
      'non-ASCII identifiers are legal C#/F# and must pass through',
    );
    assert.strictEqual(escapeFilterValue(''), '', 'an empty value escapes to an empty value');
    // The real fixture names, in the shapes VSTest actually produces.
    assert.strictEqual(
      escapeFilterValue(NUNIT_CASE),
      'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)',
      'the NUnit [TestCase] parens must be escaped or the adapter throws',
    );
    assert.strictEqual(
      escapeFilterValue(NUNIT_CASE).length,
      NUNIT_CASE.length + 2,
      'exactly the two parens gained a backslash — the commas and digits are untouched',
    );
    assert.strictEqual(
      escapeFilterValue(FS_NUNIT_CASE),
      'Fs.Nunit.Fixtures.adds case\\(2,2,4\\)',
      'the F# [TestCase] name escapes its parens while keeping its space',
    );
    assert.strictEqual(
      escapeFilterValue(FS_MSTEST_NESTED),
      FS_MSTEST_NESTED,
      "the F# MSTest '+' name needs no escaping at all",
    );
    for (const name of EXPECTED) {
      assert.strictEqual(
        escapeFilterValue(name),
        name,
        `an xUnit FQN carries no filter grammar and must survive verbatim: ${name}`,
      );
      assert.strictEqual(
        filterClause(name),
        `FullyQualifiedName=${name}`,
        `the clause for ${name} substitutes the name verbatim`,
      );
    }
    // A clause, and the OR expression built from clauses.
    assert.strictEqual(
      filterClause(NUNIT_CASE),
      'FullyQualifiedName=Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)',
      'the clause escapes its value but never its own = separator',
    );
    assert.strictEqual(
      filterClause(FS_MSTEST_NESTED),
      `FullyQualifiedName=${FS_MSTEST_NESTED}`,
      "the CLR nested-type '+' reaches VSTest verbatim",
    );
    assert.strictEqual(
      filterClause(''),
      'FullyQualifiedName=',
      'an empty name still produces a well-formed clause',
    );
    assert.strictEqual(filterExpression([]), '', 'no names produce an empty expression');
    assert.strictEqual(
      filterExpression([FS_FACT_SPACED]),
      `FullyQualifiedName=${FS_FACT_SPACED}`,
      'one name produces one clause with no separator',
    );
    assert.strictEqual(
      filterExpression([FS_FACT_SPACED]).includes('|'),
      false,
      'a single clause carries no union operator',
    );
    assert.strictEqual(
      filterExpression([FS_FACT_SPACED, NUNIT_CASE]),
      `FullyQualifiedName=${FS_FACT_SPACED}|FullyQualifiedName=Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)`,
      "the joining '|' stays UNESCAPED — it is the union operator — while each value is escaped",
    );
    assert.strictEqual(
      filterExpression([CS.passing, CS.failing, CS.skipped]).split('|').length,
      3,
      'three names produce three clauses joined by two unescaped pipes',
    );
    assert.deepStrictEqual(
      filterExpression([CS.passing, CS.failing]).split('|'),
      [filterClause(CS.passing), filterClause(CS.failing)],
      'the expression is exactly its clauses, in the order given',
    );
    // And the argument vector the run path actually passes to `dotnet test`.
    assert.deepStrictEqual(
      buildFilterArgs([]),
      [],
      'an empty selection means "run everything", so NO --filter is passed',
    );
    assert.deepStrictEqual(
      buildFilterArgs([{ id: NUNIT_CASE }]),
      ['--filter', 'FullyQualifiedName=Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)'],
      'the filter is one argv entry, so a value with spaces or parens never needs shell quoting',
    );
    assert.deepStrictEqual(
      buildFilterArgs([{ id: FS_FACT_SPACED }]),
      ['--filter', `FullyQualifiedName=${FS_FACT_SPACED}`],
      'a name full of spaces stays ONE argv entry',
    );
    assert.strictEqual(
      buildFilterArgs([{ id: FS_FACT_SPACED }]).length,
      2,
      'a filter is exactly two argv entries: the flag and its value',
    );
    assert.strictEqual(
      buildFilterArgs([{ id: FS_FACT_SPACED }])[0],
      '--filter',
      'the flag comes first, the expression second',
    );
    assert.deepStrictEqual(
      buildFilterArgs([{ id: CS.passing }, { id: CS.failing }]),
      ['--filter', `FullyQualifiedName=${CS.passing}|FullyQualifiedName=${CS.failing}`],
      'a multi-test selection is ONE invocation with one OR-ed filter, never one build per test',
    );
  });

  test('running a selection too big for one Windows command line resolves — it must not crash with spawn ENAMETOOLONG', async function () {
    this.timeout(DOTNET_CLI_MS);
    // The reported bug, reproduced at the run seam: a real solution discovers
    // 816 tests, and ▶ on the root ORs every FQN into ONE --filter value. That
    // single argv entry alone dwarfs CreateProcess's 32 767-character ceiling,
    // and Node's spawn throws SYNCHRONOUSLY — out of runDotnet, rejecting the
    // run handler, which VS Code surfaces as "An error occurred attempting to
    // run tests: Error: spawn ENAMETOOLONG".
    const many: string[] = [];
    for (let index = 0; index < 816; index += 1) {
      many.push(
        `Serilog.Tests.Formatting.Display.MessageTemplateTextFormatterqc.CanRenderLevel_${String(index)}`,
      );
    }
    assert.strictEqual(
      filterExpression(many).length > 32_767,
      true,
      'premise: the un-batched filter expression for 816 real-shaped FQNs exceeds the Windows command-line ceiling',
    );
    // A directory with NO project: `dotnet test` fails fast in the run itself,
    // so the API is exercised without paying for a build.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-ceiling-'));
    try {
      const outcome = await runTests(many, cwd);
      assert.notStrictEqual(
        outcome.failure,
        undefined,
        'a project-less directory must fail the RUN (a dotnet diagnostic), never the API contract',
      );
      assert.strictEqual(
        outcome.results.size,
        0,
        'no test can have run in a directory without a project',
      );
    } finally {
      removeDirRecursive(cwd);
    }
  });

  // The pure readers those Windows shapes feed — TRX with a BOM and CRLF, the
  // console summary, MSBuild's percent-escaping and the locale pinning — are
  // asserted next door in `test-explorer-parsers.test.ts`. They live there, not
  // here, so neither file duplicates the other.
});
