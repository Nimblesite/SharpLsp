// The Test Explorer over projects built for .NET Framework AND .NET at once,
// F# first: one xUnit project per language, each targeting net462, net472,
// net48 and the two newest .NET versions this agent runs — every one of them
// RUNNABLE here, so every outcome below is a real one.
//
// Each project carries the shapes [NETFX-TEST] exists for: a test that passes
// everywhere; one that fails on all three .NET Framework versions; one that
// fails on net472 alone; a skip; a test only net48 compiles; and a test only
// .NET compiles. Discovery must tag each with exactly the frameworks whose
// assemblies list it, describe each project root with all of them, merge each
// result across frameworks with a per-framework prefix, scope a `Run on <tfm>`
// profile to its framework, and refuse to debug what only .NET Framework has.
//
// Covers [NETFX-TEST-DISCOVERY], [NETFX-TEST-RESULTS], [NETFX-TEST-PROFILES]
// and [NETFX-DEBUG].
import * as assert from 'node:assert/strict';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  installedFrameworkPair,
  NET_FRAMEWORK_TARGETS,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  assertDebugged,
  assertDebugRefused,
  assertOneRootPerProject,
  idsOf,
  type MultiTargetFixture,
  NETFX_DEBUG_REFUSAL,
  runAllAndAssertPassing,
  writeAndDiscover,
} from './netfx-explorer-kit';
import {
  assertFailedOn,
  assertFrameworkProfiles,
  assertFrameworkRoot,
  assertTaggedFor,
  frameworkProfilesOf,
  profileFor,
  rootLabelled,
  runWithProfile,
} from './netfx-test-kit';
import { fixtureNames } from './test-explorer-fixtures';
import { activateWithScratch, teardownFixtureSolution } from './test-explorer-kit';
import {
  assertPassed,
  assertReported,
  assertSkipped,
  cachedFor,
  itemsFor,
  XUNIT_FAILURE_TEXT,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DEBUG_TEST_MS, DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The ids one fixture project exposes, by the shape each test has. */
interface NetfxIds {
  readonly passes: string;
  readonly failsOnNetfx: string;
  readonly failsOnNet472: string;
  readonly skipped: string;
  readonly net48Only: string;
  readonly modernOnly: string;
}

/** One buildable VSTest project, and its ids. */
interface NetfxFixture extends MultiTargetFixture {
  readonly ids: NetfxIds;
}

/** `#if <symbol>` around a body, with an `#else` body for every other framework. */
function eitherOr(symbol: string, then: string, otherwise: string): string[] {
  return [`#if ${symbol}`, then, '#else', otherwise, '#endif'];
}

const FS_SOURCE = [
  'module Fs.Netfx.Tests',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let ``passes everywhere`` () = Assert.Equal(2, 1 + 1)',
  '',
  '[<Fact>]',
  'let ``fails only on netfx`` () =',
  ...eitherOr('NETFRAMEWORK', '    Assert.Equal("dotnet", "netfx")', '    Assert.Equal(2, 1 + 1)'),
  '',
  '[<Fact>]',
  'let ``fails only on net472`` () =',
  ...eitherOr('NET472', '    Assert.Equal("net472", "elsewhere")', '    Assert.Equal(2, 1 + 1)'),
  '',
  '[<Fact(Skip = "fixture: deliberately skipped")>]',
  'let ``skipped everywhere`` () = ()',
  '',
  '#if NET48',
  '[<Fact>]',
  'let ``exists only on net48`` () = Assert.Equal(2, 1 + 1)',
  '#endif',
  '',
  '#if NET',
  '[<Fact>]',
  'let ``exists only on modern dotnet`` () = Assert.Equal(2, 1 + 1)',
  '#endif',
  '',
].join('\n');

const CS_SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.Netfx',
  '{',
  '    public class NetfxTests',
  '    {',
  '        [Fact] public void PassesEverywhere() => Assert.Equal(2, 1 + 1);',
  '        [Fact] public void FailsOnlyOnNetfx() =>',
  ...eitherOr(
    'NETFRAMEWORK',
    '            Assert.Equal("dotnet", "netfx");',
    '            Assert.Equal(2, 1 + 1);',
  ),
  '        [Fact] public void FailsOnlyOnNet472() =>',
  ...eitherOr(
    'NET472',
    '            Assert.Equal("net472", "elsewhere");',
    '            Assert.Equal(2, 1 + 1);',
  ),
  '        [Fact(Skip = "fixture: deliberately skipped")] public void SkippedEverywhere() { }',
  '#if NET48',
  '        [Fact] public void ExistsOnlyOnNet48() => Assert.Equal(2, 1 + 1);',
  '#endif',
  '#if NET',
  '        [Fact] public void ExistsOnlyOnModernDotnet() => Assert.Equal(2, 1 + 1);',
  '#endif',
  '    }',
  '}',
  '',
].join('\n');

/** The F# fixture's ids: backtick names, SPACES verbatim. */
const FSHARP: NetfxFixture = {
  ...fixtureNames('xunit', 'fsharp', 'Netfx'),
  language: 'fsharp',
  packages: XUNIT_PACKAGES,
  source: FS_SOURCE,
  ids: {
    passes: 'Fs.Netfx.Tests.passes everywhere',
    failsOnNetfx: 'Fs.Netfx.Tests.fails only on netfx',
    failsOnNet472: 'Fs.Netfx.Tests.fails only on net472',
    skipped: 'Fs.Netfx.Tests.skipped everywhere',
    net48Only: 'Fs.Netfx.Tests.exists only on net48',
    modernOnly: 'Fs.Netfx.Tests.exists only on modern dotnet',
  },
};

/** The C# fixture's ids. */
const CSHARP: NetfxFixture = {
  ...fixtureNames('xunit', 'csharp', 'Netfx'),
  language: 'csharp',
  packages: XUNIT_PACKAGES,
  source: CS_SOURCE,
  ids: {
    passes: 'Cs.Netfx.NetfxTests.PassesEverywhere',
    failsOnNetfx: 'Cs.Netfx.NetfxTests.FailsOnlyOnNetfx',
    failsOnNet472: 'Cs.Netfx.NetfxTests.FailsOnlyOnNet472',
    skipped: 'Cs.Netfx.NetfxTests.SkippedEverywhere',
    net48Only: 'Cs.Netfx.NetfxTests.ExistsOnlyOnNet48',
    modernOnly: 'Cs.Netfx.NetfxTests.ExistsOnlyOnModernDotnet',
  },
};

/** F# FIRST, always. */
const FIXTURES = [FSHARP, CSHARP];

suite('Test Explorer — one project built for .NET Framework AND .NET', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  /** The two newest `netN.0` monikers this agent runs. */
  let modern: string[];
  /** net462, net472, net48, then `modern`. */
  let declared: string[];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    ({ api, root } = await activateWithScratch('sharplsp-netfx-te-'));
    modern = await installedFrameworkPair(root);
    declared = [...NET_FRAMEWORK_TARGETS, ...modern];
    await writeAndDiscover(api, root, {
      name: 'NetfxTests',
      fixtures: FIXTURES,
      properties: { TargetFrameworks: declared.join(';') },
      expected: FIXTURES.flatMap((fixture) => Object.values(fixture.ids)),
    });
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('ONE root per project, each describing all five frameworks, .NET Framework first', function () {
    assertOneRootPerProject(api, FIXTURES);
    for (const fixture of FIXTURES) {
      assertFrameworkRoot(rootLabelled(api, fixture.projectName), declared, modern);
    }
    assert.strictEqual(
      rootLabelled(api, FSHARP.projectName).description,
      [...NET_FRAMEWORK_TARGETS, ...modern].join(' · '),
      'the F# root spells them out: net462 · net472 · net48 · then .NET',
    );
  });

  test('tags: every framework whose assembly lists a test, and no other', function () {
    const everywhere: (keyof NetfxIds)[] = ['passes', 'failsOnNetfx', 'failsOnNet472', 'skipped'];
    for (const shape of everywhere) {
      for (const item of itemsFor(api, idsOf(FIXTURES, shape))) assertTaggedFor(item, declared);
    }
    for (const item of itemsFor(api, idsOf(FIXTURES, 'net48Only'))) {
      assertTaggedFor(item, ['net48']);
    }
    for (const item of itemsFor(api, idsOf(FIXTURES, 'modernOnly'))) assertTaggedFor(item, modern);
  });

  test('a run merges each test across frameworks, prefixing every failure with the frameworks that failed', async function () {
    this.timeout(DOTNET_CLI_MS * 2);
    const exclusive = [...idsOf(FIXTURES, 'net48Only'), ...idsOf(FIXTURES, 'modernOnly')];
    await runAllAndAssertPassing(api, [...idsOf(FIXTURES, 'passes'), ...exclusive]);
    for (const id of idsOf(FIXTURES, 'failsOnNetfx')) {
      assertFailedOn(cachedFor(api, id), NET_FRAMEWORK_TARGETS, XUNIT_FAILURE_TEXT, id);
    }
    for (const id of idsOf(FIXTURES, 'failsOnNet472')) {
      assertFailedOn(cachedFor(api, id), ['net472'], XUNIT_FAILURE_TEXT, id);
    }
    for (const id of idsOf(FIXTURES, 'skipped')) assertSkipped(cachedFor(api, id), id);
  });

  test('Run on <tfm>: one profile per framework; the newest .NET alone never sees the .NET Framework failure', async function () {
    this.timeout(DOTNET_CLI_MS * 2);
    const profiles = frameworkProfilesOf(api);
    assertFrameworkProfiles(profiles, declared);
    const netfxFailures = idsOf(FIXTURES, 'failsOnNetfx');
    await runWithProfile(profileFor(profiles, modern.at(-1) ?? ''), itemsFor(api, netfxFailures));
    for (const id of netfxFailures) assertPassed(assertReported(api, id), id);
    const net472Failures = idsOf(FIXTURES, 'failsOnNet472');
    await runWithProfile(profileFor(profiles, 'net472'), itemsFor(api, net472Failures));
    for (const id of net472Failures) {
      const message = cachedFor(api, id).message ?? '';
      assert.strictEqual(cachedFor(api, id).outcome, 'failed', `${id} fails on net472`);
      assert.ok(message.includes(XUNIT_FAILURE_TEXT), `${id} keeps xUnit's own text`);
      assert.ok(!message.startsWith('['), `${id}: ONE framework ran, so no prefix`);
    }
  });

  test('Debug refuses a test only .NET Framework compiles: no session, the quoted refusal, the cache untouched', async function () {
    this.timeout(DEBUG_TEST_MS);
    const ids = idsOf(FIXTURES, 'net48Only');
    const cached = (): unknown[] => ids.map((id) => api.testController.getResult(id));
    const before = cached();
    const refusals = FIXTURES.map((fixture) => `${fixture.projectName} ${NETFX_DEBUG_REFUSAL}`);
    await assertDebugRefused(api, itemsFor(api, ids), refusals);
    assert.deepStrictEqual(cached(), before, 'Debug never writes the result cache');
  });

  test('Debug of a test every framework compiles debugs its .NET hosts and is never refused', async function () {
    this.timeout(DEBUG_TEST_MS);
    await assertDebugged(api, itemsFor(api, [FSHARP.ids.passes]));
    await assertDebugged(api, itemsFor(api, [CSHARP.ids.modernOnly]));
  });
});
