// Real-world .NET Framework corpus, C#: JoshClose/CsvHelper, pinned.
//
// CsvHelper builds its library for net462, net47, net48, netstandard2.0,
// netstandard2.1, net8.0 and net9.0, and its tests for all three .NET Framework
// versions plus net8.0 and net9.0 — and its code really does differ per
// framework: `Enum.TryParse(Type, …)` exists only from netstandard2.1 and .NET,
// so older frameworks fall back to `Enum.Parse`; a `TextWriter.DisposeAsync`
// shim exists only where the BCL has none; and `DateOnlyConverterTests` compile
// only for .NET 6+. Every framework below is read off the pinned project files,
// and every runtime off this agent.
//
// Covers [NETFX-CORPUS] through [NETFX-CONTEXT], [NETFX-PROJECTS-CSHARP],
// [NETFX-SCOPE], [NETFX-TEST-DISCOVERY], [NETFX-TEST-RESULTS] and
// [NETFX-TEST-PROFILES].
import * as assert from 'node:assert/strict';
import {
  assertBranches,
  assertContext,
  assertStatusShows,
  declared,
  frameworkContextOf,
  underFramework,
} from './netfx-context-kit';
import {
  assertDeclaresFamilies,
  assertFrameworkProfiles,
  assertFrameworkRoot,
  assertTaggedFor,
  frameworkProfilesOf,
  isNetFramework,
  runnableOf,
  rootLabelled,
} from './netfx-test-kit';
import { openRepoFile, positionOf } from './real-repo-helpers';
import { type Anchor, assertDefinitionIn, pollLocations } from './real-repo-kit';
import { CSVHELPER, useCorpus } from './real-repo-netfx-kit';
import { drainDiscovery } from './test-explorer-kit';
import { itemsFor } from './test-explorer-outcome-assertions';
import { comparablePath } from './test-helpers';
import { LSP_RESPONSE_MS, REAL_REPO_MS, REAL_REPO_WARMUP_MS } from './test-timeouts';

const ENUM_CONVERTER = 'src/CsvHelper/TypeConversion/EnumConverter.cs';
const ASYNC_EXTENSIONS = 'src/CsvHelper/Compatibility/AsyncExtensions.cs';
const CSV_WRITER = 'src/CsvHelper/CsvWriter.cs';
const DATE_ONLY_TESTS = 'tests/CsvHelper.Tests/TypeConversion/DateOnlyConverterTests.cs';

/** The library's `<TargetFrameworks>`: net9.0 FIRST, so net9.0 answers by default. */
const LIBRARY = declared(
  ...['net9.0', 'net8.0', 'netstandard2.1', 'netstandard2.0'],
  ...['net48', 'net47', 'net462'],
);

/** The test project's `<TargetFrameworks>`: three .NET Framework versions, two .NET. */
const TESTS = declared('net9.0', 'net8.0', 'net48', 'net47', 'net462');

/** `#if NETSTANDARD2_1_OR_GREATER || NET6_0_OR_GREATER`: the non-generic TryParse. */
const TRY_PARSE: Anchor = ['if (Enum.TryParse(type, text, ignoreCase, out var value))', 'TryParse'];
/** Its `#else`: every framework without that overload parses and catches. */
const PARSE: Anchor = ['return Enum.Parse(type, text, ignoreCase);', 'Parse'];
/** `#if !(NETSTANDARD2_1_OR_GREATER || NET)`: the shim for a BCL with no DisposeAsync. */
const SHIM: Anchor = [
  'public static ValueTask DisposeAsync(this TextWriter textWriter)',
  'DisposeAsync',
];
/** The call the shim serves. */
const DISPOSE_CALL: Anchor = ['await writer.DisposeAsync().ConfigureAwait(false);', 'DisposeAsync'];
/** The whole of DateOnlyConverterTests.cs sits under `#if NET6_0_OR_GREATER`. */
const DATE_ONLY: Anchor = ['var date = DateOnly.FromDateTime(DateTime.Now);', 'DateOnly'];

/** What each framework generation compiles in EnumConverter.cs and AsyncExtensions.cs. */
const MODERN = { live: [TRY_PARSE], inert: [PARSE] };
const LEGACY = { live: [PARSE], inert: [TRY_PARSE] };
const SHIM_LIVE = { live: [SHIM], inert: [] };
const SHIM_DARK = { live: [], inert: [SHIM] };

/** xUnit ids, read off the built assemblies at the pinned commit. */
const BOOLEAN_TESTS = 'CsvHelper.Tests.TypeConversion.BooleanConverterTests';
const DATE_ONLY_CLASS = 'CsvHelper.Tests.TypeConversion.DateOnlyConverterTests';
const SHARED_IDS = [
  `${BOOLEAN_TESTS}.ConvertToStringTest`,
  `${BOOLEAN_TESTS}.WriteField_TrueValue_UsesValue`,
];
const NET_ONLY_IDS = [
  `${DATE_ONLY_CLASS}.ConvertToStringTest`,
  `${DATE_ONLY_CLASS}.ConvertFromStringTest`,
];

suite('Real repo .NET Framework — CsvHelper (C#)', () => {
  const { repoDir, api, installed, discovered, runClass } = useCorpus(
    CSVHELPER,
    ENUM_CONVERTER,
    TRY_PARSE,
    [...SHARED_IDS, ...NET_ONLY_IDS],
  );

  test('the library answers from its FIRST framework, net9.0: the modern branch live, the shim dark', async function () {
    this.timeout(LSP_RESPONSE_MS * 4);
    const shim = await openRepoFile(repoDir(), ASYNC_EXTENSIONS);
    const { doc, uri } = await openRepoFile(repoDir(), ENUM_CONVERTER);
    assertContext(await frameworkContextOf(uri), LIBRARY.first, LIBRARY.available, 'CsvHelper');
    await assertStatusShows(api(), LIBRARY.first, LIBRARY.available);
    await assertBranches(doc, LIBRARY.first, MODERN);
    await assertBranches(shim.doc, LIBRARY.first, SHIM_DARK);
    assertContext(await frameworkContextOf(shim.uri), LIBRARY.first, LIBRARY.available, 'sibling');
  });

  test('every .NET Framework version takes the legacy branch AND the shim', async function () {
    this.timeout(LSP_RESPONSE_MS * 12);
    const shim = await openRepoFile(repoDir(), ASYNC_EXTENSIONS);
    const { doc, uri } = await openRepoFile(repoDir(), ENUM_CONVERTER);
    const { available } = await frameworkContextOf(uri);
    const families = {
      netfx: ['net48', 'net47', 'net462'],
      standards: ['netstandard2.1', 'netstandard2.0'],
    };
    assertDeclaresFamilies(available, families, 'CsvHelper, as the server reports it');
    for (const tfm of available.filter(isNetFramework)) {
      await underFramework(uri, tfm, LIBRARY, async () => {
        await assertBranches(doc, tfm, LEGACY);
        await assertBranches(shim.doc, tfm, SHIM_LIVE);
      });
    }
  });

  test('the two .NET Standard versions split: netstandard2.0 is legacy, netstandard2.1 is modern', async function () {
    this.timeout(LSP_RESPONSE_MS * 8);
    const shim = await openRepoFile(repoDir(), ASYNC_EXTENSIONS);
    const { doc, uri } = await openRepoFile(repoDir(), ENUM_CONVERTER);
    await underFramework(uri, 'netstandard2.0', LIBRARY, async () => {
      await assertBranches(doc, 'netstandard2.0', LEGACY);
      await assertBranches(shim.doc, 'netstandard2.0', SHIM_LIVE);
    });
    await underFramework(uri, 'netstandard2.1', LIBRARY, async () => {
      await assertBranches(doc, 'netstandard2.1', MODERN);
      await assertBranches(shim.doc, 'netstandard2.1', SHIM_DARK);
    });
  });

  test('Go to Definition follows the framework: DisposeAsync is the shim on net48, never on net9.0', async function () {
    this.timeout(LSP_RESPONSE_MS * 6);
    const { doc, uri } = await openRepoFile(repoDir(), CSV_WRITER);
    const at = positionOf(doc, ...DISPOSE_CALL);
    await underFramework(uri, 'net48', LIBRARY, async () => {
      await assertDefinitionIn(uri, at, ASYNC_EXTENSIONS, 'DisposeAsync');
    });
    const onNet = await pollLocations('vscode.executeDefinitionProvider', uri, at, 1);
    assert.ok(onNet.length > 0, 'on net9.0 the call still resolves: to the BCL member');
    const shimFile = comparablePath(`${repoDir()}/${ASYNC_EXTENSIONS}`);
    for (const location of onNet) {
      const target = comparablePath(location.uri.fsPath);
      assert.notStrictEqual(target, shimFile, `net9.0 never binds the shim, got ${target}`);
    }
  });

  test('the test project answers from net9.0: DateOnlyConverterTests live there and dark on every net4x', async function () {
    this.timeout(LSP_RESPONSE_MS * 10);
    const { doc, uri } = await openRepoFile(repoDir(), DATE_ONLY_TESTS);
    assertContext(await frameworkContextOf(uri), TESTS.first, TESTS.available, 'CsvHelper.Tests');
    await assertStatusShows(api(), TESTS.first, TESTS.available);
    await assertBranches(doc, TESTS.first, { live: [DATE_ONLY], inert: [] });
    for (const tfm of TESTS.available.filter(isNetFramework)) {
      await underFramework(uri, tfm, TESTS, async () => {
        await assertBranches(doc, tfm, { live: [], inert: [DATE_ONLY] });
      });
    }
  });

  test('discovery: ONE root describing five frameworks; shared tests tagged for all, .NET-only tests never for net4x', async function () {
    this.timeout(REAL_REPO_WARMUP_MS);
    await discovered();
    assertFrameworkRoot(rootLabelled(api(), 'CsvHelper.Tests'), TESTS.available, installed());
    const everywhere = runnableOf(TESTS.available, installed());
    for (const item of itemsFor(api(), SHARED_IDS)) assertTaggedFor(item, everywhere);
    const netOnly = everywhere.filter((tfm) => !isNetFramework(tfm));
    for (const item of itemsFor(api(), NET_ONLY_IDS)) assertTaggedFor(item, netOnly);
  });

  test('running BooleanConverterTests reports eight passes across every runnable framework', async function () {
    this.timeout(REAL_REPO_MS);
    await runClass({ anyTest: SHARED_IDS[0] ?? '', count: 8, declared: TESTS.available });
  });

  test('running DateOnlyConverterTests: .NET alone ran them, and the net4x sessions did not fail them', async function () {
    this.timeout(REAL_REPO_MS);
    const tagged = runnableOf(TESTS.available, installed()).filter((tfm) => !isNetFramework(tfm));
    const anyTest = NET_ONLY_IDS[0] ?? '';
    await runClass({ anyTest, count: NET_ONLY_IDS.length, declared: TESTS.available, tagged });
  });

  test('Run on <tfm>: one profile per framework the test project announced, sorted', async function () {
    this.timeout(REAL_REPO_WARMUP_MS);
    await discovered();
    const profiles = frameworkProfilesOf(api());
    assertFrameworkProfiles(profiles, TESTS.available);
    assert.strictEqual(profiles[0]?.label, 'Run on net462', '.NET Framework, oldest first');
    assert.strictEqual(profiles.at(-1)?.label, 'Run on net9.0', '.NET, newest last');
    // [TEST-REACTIVITY]: a refresh re-runs discovery; the profiles it registers
    // must be the same set again — never duplicated, never dropped.
    await drainDiscovery(() => {
      void api().testController.activateAndDiscover();
    }, api().testController);
    assertFrameworkProfiles(frameworkProfilesOf(api()), TESTS.available);
  });
});
