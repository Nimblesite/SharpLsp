// Coarse end-to-end coverage for the Test Explorer discovery + run pipeline
// (`src/testing.ts` + `src/test-discovery.ts`), driven against REAL on-disk C#
// and F# xUnit projects wired into a REAL solution built with the `dotnet` CLI.
//
// This is the regression suite for the "No tests have been found in this
// workspace yet" bug: the Test Explorer never discovered anything because the
// controller was not wired to (a) VS Code's refresh trigger and (b) the loaded
// solution. F# is first-class here — idiomatic backtick test names carry spaces
// in their fully-qualified name (`Ns.Module.adds two numbers`), which the old
// `^[\w.]+$` name filter silently dropped, so F# tests could never appear.
//
// The suite exercises the SAME public surface the running extension uses:
//   • the shared `state.solutionPath` signal (loading a solution),
//   • the extension-owned `TestController` exposed on the public API,
//   • `dotnet test --list-tests` / `dotnet test --filter` through the controller.
//
// Covers [TEST-DISCOVERY-FQN].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { parseTestList } from '../../test-discovery.js';
import {
  XUNIT_PACKAGES,
  collectItemIds,
  createSolution,
  dotnet,
  drainDiscovery,
  projectXml,
  writeProject,
} from './dotnet-fixtures';
import { EXTENSION_ID, pollUntilResult } from './test-helpers';

// Fully-qualified names the fixtures MUST expose. C#: namespace.class.method.
// F#: module.function. The spaced name is an idiomatic F# backtick binding whose
// xUnit FQN literally contains spaces — the crux of the F# discovery bug.
const CS_FACT = 'Cs.Sample.Tests.CalculatorTests.Adds_TwoNumbers';
const CS_FACT_2 = 'Cs.Sample.Tests.CalculatorTests.Subtracts_TwoNumbers';
const FS_FACT = 'Fs.Sample.Tests.addsTwoNumbers';
const FS_FACT_2 = 'Fs.Sample.Tests.subtractsTwoNumbers';
const FS_FACT_SPACED = 'Fs.Sample.Tests.adds two numbers with spaces';

const CSPROJ = projectXml(XUNIT_PACKAGES);

const CS_TESTS = [
  'using Xunit;',
  'namespace Cs.Sample.Tests',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, 1 + 2);',
  '        [Fact] public void Subtracts_TwoNumbers() => Assert.Equal(1, 3 - 2);',
  '    }',
  '}',
  '',
].join('\n');

const FSPROJ = projectXml(XUNIT_PACKAGES, 'Tests.fs');

const FS_TESTS = [
  'module Fs.Sample.Tests',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let addsTwoNumbers () =',
  '    Assert.Equal(3, 1 + 2)',
  '',
  '[<Fact>]',
  'let subtractsTwoNumbers () =',
  '    Assert.Equal(1, 3 - 2)',
  '',
  '[<Fact>]',
  'let ``adds two numbers with spaces`` () =',
  '    Assert.Equal(5, 2 + 3)',
  '',
].join('\n');

suite('Test Explorer e2e — real C#/F# discovery and run', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let csProjDir: string;
  let fsProjDir: string;

  suiteSetup(async function () {
    this.timeout(600_000);
    const ext = vscode.extensions.getExtension<SharpLspExtensionApi>(EXTENSION_ID);
    assert.ok(ext, 'the SharpLsp extension must be installed in the test host');
    api = await ext.activate();
    assert.ok(api.testController, 'the extension must expose its Test Explorer controller');

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testexplorer-'));
    csProjDir = path.join(root, 'CsTests');
    fsProjDir = path.join(root, 'FsTests');
    writeProject(csProjDir, 'CsTests.csproj', CSPROJ, 'CalculatorTests.cs', CS_TESTS);
    writeProject(fsProjDir, 'FsTests.fsproj', FSPROJ, 'Tests.fs', FS_TESTS);

    slnPath = await createSolution(root, 'Mixed', [csProjDir, fsProjDir]);

    // Warm the FULL VSTest discovery path once here (it builds both projects and
    // pays the cold `dotnet test` / adapter JIT cost), so the reactive discovery
    // exercised by the tests below runs warm and well inside its poll window.
    await dotnet(['test', slnPath, '--list-tests', '--nologo', '--verbosity', 'quiet'], root);
  });

  teardown(() => {
    // Reset the extension's loaded-solution state between tests so each test's
    // load is a real transition that re-fires reactive discovery.
    api.explorerProvider.clear();
  });

  suiteTeardown(async function () {
    this.timeout(300_000);
    // Drain reactive re-discovery before deleting the fixture — see
    // `drainDiscovery`: a `dotnet test` left pointing at a removed directory
    // hangs forever and poisons later runs.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
    }, api.testController);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  test('the Test Explorer discovers the loaded solution’s C# AND F# tests on activation', async function () {
    this.timeout(300_000);
    api.testController.items.replace([]);

    // The bug scenario: a solution is loaded and the user opens the Testing view
    // (or hits refresh). That must discover the loaded solution's tests — the
    // recovery from "No tests have been found in this workspace yet".
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();

    // Loading a solution also schedules a DEBOUNCED sweep, which supersedes the
    // explicit one (`discoverGeneration`) and populates the tree slightly later.
    // Assert on the settled tree, not on the first read, or this test's result
    // depends on whether an earlier suite already activated the controller.
    const ids = await pollUntilResult(
      () => Promise.resolve(collectItemIds(api.testController.items)),
      (found) => found.includes(CS_FACT) && found.includes(FS_FACT_SPACED),
      120_000,
      500,
    );
    assert.ok(ids.includes(CS_FACT), `C# [Fact] must be discovered: ${CS_FACT}`);
    assert.ok(ids.includes(CS_FACT_2), 'the second C# [Fact] must be discovered');
    assert.ok(ids.includes(FS_FACT), `F# [<Fact>] must be discovered: ${FS_FACT}`);
    assert.ok(ids.includes(FS_FACT_2), 'the second F# [<Fact>] must be discovered');
    assert.ok(
      ids.includes(FS_FACT_SPACED),
      `idiomatic F# backtick test (spaces in FQN) must be discovered: ${FS_FACT_SPACED}`,
    );
  });

  test('once active, loading a solution reactively re-populates the tree, and tests run green', async function () {
    this.timeout(300_000);
    // Activate the Test Explorer as opening the Testing view would.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();

    // Now prove the reactive contract: clear + (re)load the solution with NO
    // further manual discovery call — the subscription must repopulate on its own.
    api.testController.items.replace([]);
    api.explorerProvider.clear();
    await api.explorerProvider.loadSolution(slnPath);

    const discovered = await pollUntilResult(
      () => Promise.resolve(collectItemIds(api.testController.items)),
      (ids) => ids.includes(FS_FACT) && ids.includes(CS_FACT),
      120_000,
      1_000,
    );
    assert.ok(discovered.includes(FS_FACT), 'F# must be re-discovered reactively after load');
    assert.ok(discovered.includes(CS_FACT), 'C# must be re-discovered reactively after load');

    // F# first (first-class): run a real F# test and assert it passes + caches.
    const fsResult = await api.testController.runSingle(FS_FACT, fsProjDir);
    assert.ok(fsResult.passed, `F# test must run green: ${fsResult.message ?? ''}`);
    assert.strictEqual(
      api.testController.getResult(FS_FACT)?.passed,
      true,
      'F# result must be cached as passed',
    );

    // C# next.
    const csResult = await api.testController.runSingle(CS_FACT, csProjDir);
    assert.ok(csResult.passed, `C# test must run green: ${csResult.message ?? ''}`);
    assert.strictEqual(
      api.testController.getResult(CS_FACT)?.passed,
      true,
      'C# result must be cached as passed',
    );
  });

  test('parseTestList extracts C# and idiomatic (spaced) F# names from a real listing', function () {
    this.timeout(20_000);
    // A faithful multi-project `dotnet test --list-tests` listing: one banner
    // per project, path/version chatter, and — critically — an F# backtick test
    // whose xUnit FQN contains spaces (the exact shape the old filter dropped).
    const listing = [
      'Test run for C:\\repo\\FsTests\\bin\\Debug\\net10.0\\FsTests.dll (.NETCoreApp,Version=v10.0)',
      'The following Tests are available:',
      '    Fs.Sample.Tests.addsTwoNumbers',
      '    Fs.Sample.Tests.adds two numbers with spaces',
      'Test run for C:\\repo\\CsTests\\bin\\Debug\\net10.0\\CsTests.dll (.NETCoreApp,Version=v10.0)',
      'The following Tests are available:',
      '    Cs.Sample.Tests.CalculatorTests.Adds_TwoNumbers',
    ].join('\n');

    const names = parseTestList(listing);
    assert.deepStrictEqual(names, [
      'Fs.Sample.Tests.addsTwoNumbers',
      'Fs.Sample.Tests.adds two numbers with spaces',
      'Cs.Sample.Tests.CalculatorTests.Adds_TwoNumbers',
    ]);
  });
});
