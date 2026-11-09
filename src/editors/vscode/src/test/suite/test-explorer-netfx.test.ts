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

/** Each test shape's id suffix: the F# backtick binding and the C# method. */
const NETFX_NAMES: Readonly<Record<keyof NetfxIds, readonly [fs: string, cs: string]>> = {
  passes: ['passes everywhere', 'PassesEverywhere'],
  failsOnNetfx: ['fails only on netfx', 'FailsOnlyOnNetfx'],
  failsOnNet472: ['fails only on net472', 'FailsOnlyOnNet472'],
  skipped: ['skipped everywhere', 'SkippedEverywhere'],
  net48Only: ['exists only on net48', 'ExistsOnlyOnNet48'],
  modernOnly: ['exists only on modern dotnet', 'ExistsOnlyOnModernDotnet'],
};

/** The id namespace each language's tests live in. */
const NETFX_NAMESPACES: Readonly<Record<'fsharp' | 'csharp', string>> = {
  fsharp: 'Fs.Netfx.Tests',
  csharp: 'Cs.Netfx.NetfxTests',
};

/** One language's fixture: project metadata, its source, and its six ids. */
function netfxFixture(language: 'fsharp' | 'csharp', source: string): NetfxFixture {
  const csharp = language === 'csharp';
  const id = (shape: keyof NetfxIds): string =>
    csharp
      ? `${NETFX_NAMESPACES[language]}.${NETFX_NAMES[shape][1]}`
      : `${NETFX_NAMESPACES[language]}.${NETFX_NAMES[shape][0]}`;
  return {
    ...fixtureNames('xunit', language, 'Netfx'),
    language,
    packages: XUNIT_PACKAGES,
    source,
    ids: {
      passes: id('passes'),
      failsOnNetfx: id('failsOnNetfx'),
      failsOnNet472: id('failsOnNet472'),
      skipped: id('skipped'),
      net48Only: id('net48Only'),
      modernOnly: id('modernOnly'),
    },
  };
}

/** The F# fixture: backtick ids, SPACES verbatim. */
const FSHARP: NetfxFixture = netfxFixture('fsharp', FS_SOURCE);

/** The C# fixture. */
const CSHARP: NetfxFixture = netfxFixture('csharp', CS_SOURCE);

/** F# FIRST, always. */
const FIXTURES = [FSHARP, CSHARP];

/** A SINGLE-target neighbour in the same solution, whose rows [NETFX] must leave alone. */
const SINGLE: MultiTargetFixture = {
  ...fixtureNames('xunit', 'fsharp', 'Single'),
  language: 'fsharp',
  packages: XUNIT_PACKAGES,
  source: [
    'module Fs.Single.Tests',
    '',
    'open Xunit',
    '',
    '[<Fact>]',
    'let ``passes on one framework`` () = Assert.Equal(1, 1)',
    '',
  ].join('\n'),
};

/** Its one test, under its plain fully-qualified name. */
const SINGLE_ID = 'Fs.Single.Tests.passes on one framework';

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
    const [, newest = ''] = modern;
    const single = { ...SINGLE, properties: { TargetFramework: newest } };
    await writeAndDiscover(api, root, {
      name: 'NetfxTests',
      fixtures: [...FIXTURES, single],
      properties: { TargetFrameworks: declared.join(';') },
      expected: [...FIXTURES.flatMap((fixture) => Object.values(fixture.ids)), SINGLE_ID],
    });
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('a SINGLE-target neighbour keeps its rows unchanged: no framework description, no tfm tag', function () {
    const singleRoot = rootLabelled(api, SINGLE.projectName);
    assert.strictEqual(
      singleRoot.description,
      undefined,
      'a single-target root describes no frameworks',
    );
    const [item] = itemsFor(api, [SINGLE_ID]);
    assert.ok(item, `${SINGLE_ID} is a row`);
    assertTaggedFor(item, []);
    assert.strictEqual(item.description, SINGLE_ID, 'its description is its plain FQN, as before');
  });

  test('ONE root per project, each describing all five frameworks, .NET Framework first', function () {
    assertOneRootPerProject(api, [...FIXTURES, SINGLE]);
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
