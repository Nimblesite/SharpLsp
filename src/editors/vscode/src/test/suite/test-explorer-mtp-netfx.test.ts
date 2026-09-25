// Microsoft.Testing.Platform modules built for .NET Framework AND .NET, F#
// first: an F# `xunit.v3` project and a C# MSTest project, each targeting net48
// and the two newest .NET versions this agent runs.
//
// [NETFX-TEST-MTP]: a .NET Framework MTP module is `<Name>.exe` and is executed
// DIRECTLY — `dotnet exec` cannot host it and fails on hostpolicy.dll. So the
// test only net48 compiles is the proof: it can pass only if the .exe itself
// ran. [NETFX-DEBUG]: no .NET Framework debugger is bundled, so Debug never
// starts that module; a selection with no .NET module fails at once with the
// quoted refusal, and a selection that has one is debugged there.
//
// Covers [NETFX-TEST-MTP] and [NETFX-DEBUG].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  installedFrameworkPair,
  MTP_MSTEST_PACKAGES,
  MTP_PROPERTIES,
  MTP_XUNIT_PACKAGES,
  writeMtpGlobalJson,
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
import { rootLabelled } from './netfx-test-kit';
import { fixtureNames } from './test-explorer-fixtures';
import {
  activateWithScratch,
  collectLeafIds,
  runViaProfile,
  teardownFixtureSolution,
} from './test-explorer-kit';
import {
  assertPassed,
  assertReported,
  assertSkipped,
  cachedFor,
  itemsFor,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DEBUG_TEST_MS, DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The ids one MTP fixture exposes, by the shape each test has. */
interface MtpNetfxIds {
  readonly passes: string;
  readonly failsOnNet48: string;
  readonly skipped: string;
  readonly net48Only: string;
}

/** One MTP project, its ids, and the failure text its framework writes. */
interface MtpNetfxFixture extends MultiTargetFixture {
  readonly ids: MtpNetfxIds;
  readonly failureText: string;
}

const FS_SOURCE = [
  'module Fs.XunitMtpNetfx.Fixtures',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let ``passes on every framework`` () = Assert.Equal(3, 1 + 2)',
  '',
  '[<Fact>]',
  'let ``fails only on net48`` () =',
  '#if NETFRAMEWORK',
  '    Assert.Equal(4, 1 + 2)',
  '#else',
  '    Assert.Equal(3, 1 + 2)',
  '#endif',
  '',
  '[<Fact(Skip = "fixture: deliberately skipped")>]',
  'let ``skipped on every framework`` () = ()',
  '',
  '#if NETFRAMEWORK',
  '[<Fact>]',
  'let ``exists only on net framework`` () = Assert.Equal(3, 1 + 2)',
  '#endif',
  '',
].join('\n');

const CS_SOURCE = [
  'using Microsoft.VisualStudio.TestTools.UnitTesting;',
  '',
  'namespace Cs.MstestMtpNetfx.Fixtures',
  '{',
  '    [TestClass]',
  '    public class NetfxTests',
  '    {',
  '        [TestMethod] public void PassesOnEveryFramework() => Assert.AreEqual(3, 1 + 2);',
  '        [TestMethod] public void FailsOnlyOnNet48() =>',
  '#if NETFRAMEWORK',
  '            Assert.AreEqual(4, 1 + 2);',
  '#else',
  '            Assert.AreEqual(3, 1 + 2);',
  '#endif',
  '        [TestMethod, Ignore] public void SkippedOnEveryFramework() { }',
  '#if NETFRAMEWORK',
  '        [TestMethod] public void ExistsOnlyOnNetFramework() => Assert.AreEqual(3, 1 + 2);',
  '#endif',
  '    }',
  '}',
  '',
].join('\n');

/** F# `xunit.v3`: backtick ids with SPACES, taken from the listing's `type` block. */
const FSHARP: MtpNetfxFixture = {
  ...fixtureNames('xunit', 'fsharp', 'MtpNetfx'),
  language: 'fsharp',
  packages: MTP_XUNIT_PACKAGES,
  source: FS_SOURCE,
  ids: {
    passes: 'Fs.XunitMtpNetfx.Fixtures.passes on every framework',
    failsOnNet48: 'Fs.XunitMtpNetfx.Fixtures.fails only on net48',
    skipped: 'Fs.XunitMtpNetfx.Fixtures.skipped on every framework',
    net48Only: 'Fs.XunitMtpNetfx.Fixtures.exists only on net framework',
  },
  failureText: 'Assert.Equal() Failure',
};

/** C# MSTest: its DISPLAY name is the bare method, its id the full name. */
const CSHARP: MtpNetfxFixture = {
  ...fixtureNames('mstest', 'csharp', 'MtpNetfx'),
  language: 'csharp',
  packages: MTP_MSTEST_PACKAGES,
  source: CS_SOURCE,
  ids: {
    passes: 'Cs.MstestMtpNetfx.Fixtures.NetfxTests.PassesOnEveryFramework',
    failsOnNet48: 'Cs.MstestMtpNetfx.Fixtures.NetfxTests.FailsOnlyOnNet48',
    skipped: 'Cs.MstestMtpNetfx.Fixtures.NetfxTests.SkippedOnEveryFramework',
    net48Only: 'Cs.MstestMtpNetfx.Fixtures.NetfxTests.ExistsOnlyOnNetFramework',
  },
  failureText: 'Assertion failed. Expected values to be equal.',
};

/** F# FIRST, always. */
const FIXTURES = [FSHARP, CSHARP];

/** Where the build put `fixture`'s module for `tfm`: `.exe` on net48, `.dll` on .NET. */
function modulePath(root: string, fixture: MtpNetfxFixture, tfm: string): string {
  const extension = tfm === 'net48' ? 'exe' : 'dll';
  return path.join(
    root,
    fixture.projectName,
    'bin',
    'Debug',
    tfm,
    `${fixture.projectName}.${extension}`,
  );
}

suite('Test Explorer — MTP modules built for .NET Framework AND .NET', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let frameworks: string[];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    ({ api, root } = await activateWithScratch('sharplsp-mtp-netfx-'));
    frameworks = ['net48', ...(await installedFrameworkPair(root))];
    writeMtpGlobalJson(root);
    await writeAndDiscover(api, root, {
      name: 'MtpNetfx',
      fixtures: FIXTURES,
      properties: { ...MTP_PROPERTIES, TargetFrameworks: frameworks.join(';') },
      expected: FIXTURES.flatMap((fixture) => Object.values(fixture.ids)),
    });
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('ONE root per project, however many modules its frameworks built — the net48 one an .exe', function () {
    assertOneRootPerProject(api, FIXTURES);
    for (const fixture of FIXTURES) {
      for (const tfm of frameworks) {
        const module = modulePath(root, fixture, tfm);
        assert.ok(fs.existsSync(module), `${tfm} built its module: ${module}`);
      }
      const leaves = collectLeafIds(rootLabelled(api, fixture.projectName).children);
      assert.deepStrictEqual(
        leaves.sort(),
        Object.values(fixture.ids).sort(),
        'the union of every module',
      );
    }
  });

  test('the test only .NET Framework compiles PASSES: its .exe module ran as itself', async function () {
    this.timeout(DOTNET_CLI_MS * 2);
    const ids = idsOf(FIXTURES, 'net48Only');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, ids));
    for (const id of ids) assertPassed(assertReported(api, id), id);
    for (const item of itemsFor(api, ids)) {
      assert.strictEqual(item.error, undefined, `${item.id} carries no hostpolicy.dll error`);
      assert.strictEqual(item.children.size, 0, `${item.id} is a test, never a group`);
    }
  });

  test('a run of every module: net48-only failures are red with their own text; skips stay skips; F# spaces survive', async function () {
    this.timeout(DOTNET_CLI_MS * 2);
    await runAllAndAssertPassing(api, [
      ...idsOf(FIXTURES, 'passes'),
      ...idsOf(FIXTURES, 'net48Only'),
    ]);
    for (const fixture of FIXTURES) {
      const failed = cachedFor(api, fixture.ids.failsOnNet48);
      assert.strictEqual(
        failed.outcome,
        'failed',
        `${fixture.ids.failsOnNet48} is red: net48 failed it`,
      );
      assert.ok(
        (failed.message ?? '').includes(fixture.failureText),
        `its own text: ${failed.message ?? ''}`,
      );
      assertSkipped(cachedFor(api, fixture.ids.skipped), fixture.ids.skipped);
    }
    const [fsRow] = itemsFor(api, [FSHARP.ids.passes]);
    assert.strictEqual(fsRow?.label, 'passes on every framework', 'the F# row keeps its spaces');
  });

  test('Debug refuses a selection only .NET Framework has: no session, the quoted .exe refusal', async function () {
    this.timeout(DEBUG_TEST_MS);
    const refusals = FIXTURES.map((fixture) => `${fixture.projectName}.exe ${NETFX_DEBUG_REFUSAL}`);
    await assertDebugRefused(api, itemsFor(api, idsOf(FIXTURES, 'net48Only')), refusals);
  });

  test('Debug of a test every module has attaches to its .NET modules and is never refused', async function () {
    this.timeout(DEBUG_TEST_MS);
    await assertDebugged(api, itemsFor(api, [FSHARP.ids.passes]));
  });
});
