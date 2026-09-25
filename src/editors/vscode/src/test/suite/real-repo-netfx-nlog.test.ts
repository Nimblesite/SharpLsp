// Real-world .NET Framework corpus, C#: NLog/NLog, pinned.
//
// NLog is the widest framework spread in the corpus: its library targets
// net35, net46, netstandard2.0 and netstandard2.1, and its FIRST framework is
// net35 — a CLR 2 target, so the default context is the oldest .NET there is.
// Its code differs at every step: `CounterLayoutRenderer` keeps its sequences
// in a locked `Dictionary` on net35 (which has no `ConcurrentDictionary`) and a
// `ConcurrentDictionary` everywhere else; `PlatformDetector` reads
// `Environment.OSVersion` on .NET Framework and `RuntimeInformation` on .NET
// Standard. Four test projects target net462 and net10.0, and some tests —
// `AppSettingTests`, reading app.config — exist only on .NET Framework.
//
// Covers [NETFX-CORPUS] through [NETFX-CONTEXT], [NETFX-PROJECTS-CSHARP],
// [NETFX-SCOPE], [NETFX-TEST-DISCOVERY] and [NETFX-TEST-RESULTS].
import * as assert from 'node:assert/strict';
import {
  assertBranches,
  assertContext,
  assertHoverInert,
  assertStatusShows,
  declared,
  frameworkContextOf,
  underFramework,
} from './netfx-context-kit';
import {
  assertDeclaresFamilies,
  assertFrameworkRoot,
  assertTaggedFor,
  isNetFramework,
  rootLabelled,
  runnableOf,
  standardsOf,
} from './netfx-test-kit';
import { openRepoFile, positionOf } from './real-repo-helpers';
import { type Anchor, assertDefinitionIn } from './real-repo-kit';
import { NLOG, useCorpus } from './real-repo-netfx-kit';
import { itemsFor } from './test-explorer-outcome-assertions';
import { LSP_RESPONSE_MS, REAL_REPO_MS, REAL_REPO_WARMUP_MS } from './test-timeouts';

const COUNTER = 'src/NLog/LayoutRenderers/CounterLayoutRenderer.cs';
const PLATFORM = 'src/NLog/Internal/PlatformDetector.cs';
const CONSOLE_HELPER = 'src/NLog/Targets/ConsoleTargetHelper.cs';

/** The library's `<TargetFrameworks>`: two .NET Framework, two .NET Standard, net35 FIRST. */
const LIBRARY = declared('net35', 'net46', 'netstandard2.0', 'netstandard2.1');

/** Every NLog test project's `<TargetFrameworks>` under the .NET 10 SDK. */
const TESTS = declared('net462', 'net10.0');

/** The four multi-targeted test projects `src/NLog.sln` holds. */
const TEST_PROJECTS = [
  'NLog.UnitTests',
  'NLog.RegEx.Tests',
  'NLog.Targets.AtomicFile.Tests',
  'NLog.Targets.GZipFile.Tests',
];

/** `#if NET35`: a locked Dictionary, because net35 has no ConcurrentDictionary. */
const DICTIONARY: Anchor = [
  'private static readonly System.Collections.Generic.Dictionary<string, GlobalSequence> Sequences',
  'Dictionary',
];
const LOCK: Anchor = ['lock (Sequences)', 'Sequences'];
/** Its `#else`: the concurrent collection every later framework has. */
const CONCURRENT: Anchor = [
  'private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, GlobalSequence> Sequences',
  'ConcurrentDictionary',
];
const TRY_ADD: Anchor = ['if (!Sequences.TryAdd(sequenceName, globalSequence))', 'TryAdd'];

/** `#if NETFRAMEWORK` in PlatformDetector: the OS from Environment.OSVersion. */
const OS_VERSION: Anchor = ['PlatformID platformID = Environment.OSVersion.Platform;', 'OSVersion'];
/** Its `#else`: the OS from RuntimeInformation. */
const IS_OS_PLATFORM: Anchor = [
  'RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Linux)',
  'IsOSPlatform',
];

/** `#if NETFRAMEWORK` in ConsoleTargetHelper: a call into PlatformDetector.IsMono. */
const IS_MONO_CALL: Anchor = [
  'if (Internal.PlatformDetector.IsMono && Console.In is StreamReader)',
  'IsMono',
];

/** What each framework compiles in the two library files. */
const ON_NET35 = { live: [DICTIONARY, LOCK], inert: [CONCURRENT, TRY_ADD] };
const PAST_NET35 = { live: [CONCURRENT, TRY_ADD], inert: [DICTIONARY, LOCK] };
const ON_NETFX = { live: [OS_VERSION], inert: [IS_OS_PLATFORM] };
const ON_NETSTANDARD = { live: [IS_OS_PLATFORM], inert: [OS_VERSION] };

/** xUnit ids, read off both built assemblies at the pinned commit. */
const COUNTER_TESTS = 'NLog.UnitTests.LayoutRenderers.CounterTests';
const APP_SETTING_TESTS = 'NLog.UnitTests.LayoutRenderers.AppSettingTests';
const SHARED_IDS = ['DefaultCounterTest', 'LayoutCounterTest', 'PresetCounterTest'].map(
  (name) => `${COUNTER_TESTS}.${name}`,
);
const NETFX_ONLY_IDS = ['UseAppSettingTest', 'FallbackToDefaultTest', 'NoAppSettingTest'].map(
  (name) => `${APP_SETTING_TESTS}.${name}`,
);

suite('Real repo .NET Framework — NLog (C#)', () => {
  const { repoDir, api, installed, discovered, runClass } = useCorpus(NLOG, COUNTER, LOCK, [
    ...SHARED_IDS,
    ...NETFX_ONLY_IDS,
  ]);

  test('NLog answers from net35, its FIRST framework: the .NET 3.5 and .NET Framework branches live', async function () {
    this.timeout(LSP_RESPONSE_MS * 6);
    const platform = await openRepoFile(repoDir(), PLATFORM);
    const { doc, uri } = await openRepoFile(repoDir(), COUNTER);
    const context = await frameworkContextOf(uri);
    assertContext(context, LIBRARY.first, LIBRARY.available, 'NLog');
    const families = { netfx: ['net35', 'net46'], standards: ['netstandard2.0', 'netstandard2.1'] };
    assertDeclaresFamilies(context.available, families, 'NLog, as the server reports it');
    await assertStatusShows(api(), LIBRARY.first, LIBRARY.available);
    await assertBranches(doc, LIBRARY.first, ON_NET35);
    await assertBranches(platform.doc, LIBRARY.first, ON_NETFX);
    assertContext(await frameworkContextOf(platform.uri), 'net35', LIBRARY.available, 'sibling');
  });

  test('net46 is still .NET Framework but past 3.5: ConcurrentDictionary lights up, OSVersion stays', async function () {
    this.timeout(LSP_RESPONSE_MS * 6);
    const platform = await openRepoFile(repoDir(), PLATFORM);
    const { doc, uri } = await openRepoFile(repoDir(), COUNTER);
    await underFramework(uri, 'net46', LIBRARY, async () => {
      await assertBranches(doc, 'net46', PAST_NET35);
      await assertBranches(platform.doc, 'net46', ON_NETFX);
      await assertStatusShows(api(), 'net46', LIBRARY.available);
    });
    await assertBranches(doc, LIBRARY.first, ON_NET35);
  });

  test('both .NET Standard versions leave .NET Framework behind: RuntimeInformation answers', async function () {
    this.timeout(LSP_RESPONSE_MS * 8);
    const platform = await openRepoFile(repoDir(), PLATFORM);
    const { doc, uri } = await openRepoFile(repoDir(), COUNTER);
    for (const tfm of standardsOf(LIBRARY.available)) {
      await underFramework(uri, tfm, LIBRARY, async () => {
        await assertBranches(platform.doc, tfm, ON_NETSTANDARD);
        await assertBranches(doc, tfm, PAST_NET35);
      });
    }
  });

  test('definition from #if NETFRAMEWORK code crosses files on both .NET Framework versions, and goes dark on .NET Standard', async function () {
    this.timeout(LSP_RESPONSE_MS * 8);
    const { doc, uri } = await openRepoFile(repoDir(), CONSOLE_HELPER);
    const at = positionOf(doc, ...IS_MONO_CALL);
    await assertDefinitionIn(uri, at, PLATFORM, 'IsMono');
    await underFramework(uri, 'net46', LIBRARY, async () => {
      await assertDefinitionIn(uri, at, PLATFORM, 'IsMono');
    });
    await underFramework(uri, 'netstandard2.1', LIBRARY, async () => {
      await assertHoverInert(uri, at, 'IsMono under netstandard2.1');
    });
  });

  test('discovery: four test roots, each describing net462 and net10.0', async function () {
    this.timeout(REAL_REPO_WARMUP_MS);
    await discovered();
    for (const project of TEST_PROJECTS) {
      assertFrameworkRoot(rootLabelled(api(), project), TESTS.available, installed());
    }
  });

  test('tags: CounterTests carry every runnable framework, AppSettingTests .NET Framework alone', async function () {
    this.timeout(REAL_REPO_WARMUP_MS);
    await discovered();
    const everywhere = runnableOf(TESTS.available, installed());
    for (const item of itemsFor(api(), SHARED_IDS)) assertTaggedFor(item, everywhere);
    const netfx = everywhere.filter(isNetFramework);
    for (const item of itemsFor(api(), NETFX_ONLY_IDS)) assertTaggedFor(item, netfx);
  });

  test('running CounterTests: five passes, on every framework that can run them', async function () {
    this.timeout(REAL_REPO_MS);
    await runClass({ anyTest: SHARED_IDS[0] ?? '', count: 5, declared: TESTS.available });
    for (const item of itemsFor(api(), SHARED_IDS)) {
      assert.strictEqual(item.parent?.label, 'CounterTests', `${item.id} hangs off its class row`);
    }
  });

  test('running AppSettingTests: five .NET Framework-only passes, never failed by the net10.0 session', async function () {
    this.timeout(REAL_REPO_MS);
    const tagged = runnableOf(TESTS.available, installed()).filter(isNetFramework);
    await runClass({
      anyTest: NETFX_ONLY_IDS[0] ?? '',
      count: 5,
      declared: TESTS.available,
      tagged,
    });
  });
});
