// Coarse end-to-end coverage for Test Explorer discovery across the test
// frameworks whose VSTest DisplayName is NOT the fully-qualified name
// (https://github.com/Nimblesite/SharpLsp/issues/180).
//
// `dotnet test --list-tests` prints each test's DisplayName. xUnit's DisplayName
// happens to be `Namespace.Class.Method`, so xUnit discovery worked by accident
// (covered by test-explorer-e2e.test.ts). MSTest and NUnit default their
// DisplayName to the BARE method name, so a listing-scraping discovery both
// drops them (no dot in the line) and — even if kept — could never build the
// `FullyQualifiedName=` filter a run needs. Discovery must therefore source
// `TestCase.FullyQualifiedName` itself.
//
// F# is first-class here: every framework is exercised in F# as well as C#,
// including an idiomatic backtick member whose FQN contains spaces.
//
// Covers [TEST-DISCOVERY-FQN].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  MSTEST_PACKAGES,
  NUNIT_PACKAGES,
  collectItemIds,
  createSolution,
  dotnet,
  drainDiscovery,
  projectXml,
  writeProject,
} from './dotnet-fixtures';
import { EXTENSION_ID, pollUntilResult } from './test-helpers';

// The fully-qualified names the fixtures MUST expose. These are exactly the
// names `TestCase.FullyQualifiedName` carries and exactly what
// `dotnet test --filter FullyQualifiedName=` accepts.
const FS_MSTEST = 'Fs.Mstest.Tests.MsCalcTests.AddsTwoNumbers';
const FS_MSTEST_SPACED = 'Fs.Mstest.Tests.MsCalcTests.adds two numbers with spaces';
const CS_MSTEST = 'Cs.Mstest.Tests.MsCalcTests.AddsTwoNumbers';
const FS_NUNIT = 'Fs.Nunit.Tests.CalcTests.AddsTwoNumbers';
const CS_NUNIT = 'Cs.Nunit.Tests.CalcTests.AddsTwoNumbers';

const FS_MSTEST_SRC = [
  'namespace Fs.Mstest.Tests',
  '',
  'open Microsoft.VisualStudio.TestTools.UnitTesting',
  '',
  '[<TestClass>]',
  'type MsCalcTests () =',
  '    [<TestMethod>]',
  '    member _.AddsTwoNumbers () =',
  '        Assert.AreEqual<int>(3, 1 + 2)',
  '',
  '    [<TestMethod>]',
  '    member _.``adds two numbers with spaces`` () =',
  '        Assert.AreEqual<int>(5, 2 + 3)',
  '',
].join('\n');

const CS_MSTEST_SRC = [
  'using Microsoft.VisualStudio.TestTools.UnitTesting;',
  'namespace Cs.Mstest.Tests',
  '{',
  '    [TestClass]',
  '    public class MsCalcTests',
  '    {',
  '        [TestMethod] public void AddsTwoNumbers() => Assert.AreEqual(3, 1 + 2);',
  '    }',
  '}',
  '',
].join('\n');

const FS_NUNIT_SRC = [
  'namespace Fs.Nunit.Tests',
  '',
  'open NUnit.Framework',
  '',
  '[<TestFixture>]',
  'type CalcTests () =',
  '    [<Test>]',
  '    member _.AddsTwoNumbers () =',
  '        Assert.That(1 + 2, Is.EqualTo(3))',
  '',
].join('\n');

const CS_NUNIT_SRC = [
  'using NUnit.Framework;',
  'namespace Cs.Nunit.Tests',
  '{',
  '    public class CalcTests',
  '    {',
  '        [Test] public void AddsTwoNumbers() => Assert.That(1 + 2, Is.EqualTo(3));',
  '    }',
  '}',
  '',
].join('\n');

suite('Test Explorer e2e — MSTest and NUnit discovery (F# and C#)', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let fsMsTestDir: string;
  let csNunitDir: string;

  suiteSetup(async function () {
    this.timeout(900_000);
    const ext = vscode.extensions.getExtension<SharpLspExtensionApi>(EXTENSION_ID);
    assert.ok(ext, 'the SharpLsp extension must be installed in the test host');
    api = await ext.activate();
    assert.ok(api.testController, 'the extension must expose its Test Explorer controller');

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-testfx-'));
    fsMsTestDir = path.join(root, 'FsMsTests');
    const csMsTestDir = path.join(root, 'CsMsTests');
    const fsNunitDir = path.join(root, 'FsNunitTests');
    csNunitDir = path.join(root, 'CsNunitTests');

    // F# first (first-class), then C#, for each framework.
    writeProject(
      fsMsTestDir,
      'FsMsTests.fsproj',
      projectXml(MSTEST_PACKAGES, 'Tests.fs'),
      'Tests.fs',
      FS_MSTEST_SRC,
    );
    writeProject(
      csMsTestDir,
      'CsMsTests.csproj',
      projectXml(MSTEST_PACKAGES),
      'MsCalcTests.cs',
      CS_MSTEST_SRC,
    );
    writeProject(
      fsNunitDir,
      'FsNunitTests.fsproj',
      projectXml(NUNIT_PACKAGES, 'Tests.fs'),
      'Tests.fs',
      FS_NUNIT_SRC,
    );
    writeProject(
      csNunitDir,
      'CsNunitTests.csproj',
      projectXml(NUNIT_PACKAGES),
      'CalcTests.cs',
      CS_NUNIT_SRC,
    );

    slnPath = await createSolution(root, 'Frameworks', [
      fsMsTestDir,
      csMsTestDir,
      fsNunitDir,
      csNunitDir,
    ]);

    // Warm the FULL build + VSTest adapter path once (cold restore/build/JIT), so
    // the discovery the tests below drive runs warm and inside its poll window.
    await dotnet(['test', slnPath, '--list-tests', '--nologo', '--verbosity', 'quiet'], root);
  });

  teardown(() => {
    api.explorerProvider.clear();
  });

  suiteTeardown(async function () {
    this.timeout(300_000);
    await drainDiscovery(() => {
      api.explorerProvider.clear();
    }, api.testController);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  /**
   * Load the fixture solution, discover, and poll until `expected` is present.
   * Discovery is reactive and debounced — loading a solution schedules a sweep
   * that can supersede the explicit one — so the tree is asserted on when it
   * settles, not on the first read.
   */
  async function discoveredIds(expected: string[]): Promise<string[]> {
    api.testController.items.replace([]);
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    return pollUntilResult(
      () => Promise.resolve(collectItemIds(api.testController.items)),
      (ids) => expected.every((name) => ids.includes(name)),
      120_000,
      500,
    );
  }

  test('the Test Explorer discovers MSTest tests by fully-qualified name (F# and C#)', async function () {
    this.timeout(600_000);
    const ids = await discoveredIds([FS_MSTEST, FS_MSTEST_SPACED, CS_MSTEST]);

    assert.ok(ids.includes(FS_MSTEST), `F# [<TestMethod>] must be discovered: ${FS_MSTEST}`);
    assert.ok(
      ids.includes(FS_MSTEST_SPACED),
      `idiomatic F# backtick MSTest member (spaces in FQN) must be discovered: ${FS_MSTEST_SPACED}`,
    );
    assert.ok(ids.includes(CS_MSTEST), `C# [TestMethod] must be discovered: ${CS_MSTEST}`);
  });

  test('the Test Explorer discovers NUnit tests by fully-qualified name (F# and C#)', async function () {
    this.timeout(600_000);
    const ids = await discoveredIds([FS_NUNIT, CS_NUNIT]);

    assert.ok(ids.includes(FS_NUNIT), `F# [<Test>] must be discovered: ${FS_NUNIT}`);
    assert.ok(ids.includes(CS_NUNIT), `C# [Test] must be discovered: ${CS_NUNIT}`);
  });

  test('discovered MSTest and NUnit ids are runnable FullyQualifiedName filters', async function () {
    this.timeout(600_000);
    // The whole point of discovering by FQN: the id the tree carries is the id
    // `dotnet test --filter FullyQualifiedName=` accepts. A DisplayName-derived
    // id would not match anything here.
    const ids = await discoveredIds([FS_MSTEST, CS_NUNIT]);
    assert.ok(
      ids.includes(FS_MSTEST),
      `F# MSTest must be discovered before it can run: ${ids[0] ?? '<none>'}`,
    );
    assert.ok(ids.includes(CS_NUNIT), 'C# NUnit must be discovered before it can run');

    // F# first (first-class).
    const msResult = await api.testController.runSingle(FS_MSTEST, fsMsTestDir);
    assert.ok(msResult.passed, `F# MSTest must run green: ${msResult.message ?? ''}`);
    assert.strictEqual(
      api.testController.getResult(FS_MSTEST)?.passed,
      true,
      'F# MSTest result must be cached as passed',
    );

    const nunitResult = await api.testController.runSingle(CS_NUNIT, csNunitDir);
    assert.ok(nunitResult.passed, `C# NUnit must run green: ${nunitResult.message ?? ''}`);
    assert.strictEqual(
      api.testController.getResult(CS_NUNIT)?.passed,
      true,
      'C# NUnit result must be cached as passed',
    );
  });
});
