// Coarse end-to-end coverage for the Testing module (`src/testing.ts`) and the
// Test Status Lens (`src/test-lens.ts`).
//
// Project HARD RULE (CLAUDE.md): "No unit tests. Only COARSE e2e tests." These
// flows re-express the archived pure-logic tests as REAL end-to-end behaviour:
//   • the registered `sharplsp.test.runAtCursor` / `sharplsp.test.debugAtCursor`
//     commands are driven through the live extension host (cursor on a method),
//   • the test-lens CodeLens provider is exercised through the public
//     `vscode.executeCodeLensProvider` request against on-disk C#/F# files,
//   • the `sharplsp.testLens.enabled` workspace setting is toggled through the
//     real configuration system and the lens output is observed to change,
//   • the exported pure helpers are asserted INSIDE those flows on real disk
//     fixtures (cobertura XML on disk, a real .csproj, real TestItem ids).
//
// The test controller itself is owned by the already-activated extension, so we
// NEVER call registerTestExplorer()/registerTestStatusLens()/new
// SharpLspTestController() (they throw "duplicate controller id"). We drive
// everything via registered commands and the public provider request API.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildFilterArgs,
  findCoberturaFile,
  isExpectoTest,
  isFsCheckTest,
  isTestName,
  parseCoberturaXml,
} from '../../testing.js';
import {
  extractCSharpMethodName,
  extractFSharpFunctionName,
  formatDuration,
} from '../../test-lens.js';
import { CMD_TEST_RUN_AT_CURSOR, CMD_TEST_DEBUG_AT_CURSOR } from '../../constants.js';
import {
  closeAllEditors,
  openCSharpFile,
  openFSharpFile,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';

const TEST_LENS_SECTION = 'sharplsp.testLens';
const TEST_LENS_KEY = 'enabled';

/** A faithful TestItem stand-in carrying the only field buildFilterArgs reads. */
function testItem(id: string): vscode.TestItem {
  return { id } as unknown as vscode.TestItem;
}

/** Pull only the lenses this extension's test-lens provider contributes. */
function testLensCommands(lenses: vscode.CodeLens[]): vscode.CodeLens[] {
  return lenses.filter(
    (lens) =>
      lens.command?.command === CMD_TEST_RUN_AT_CURSOR ||
      lens.command?.command === CMD_TEST_DEBUG_AT_CURSOR,
  );
}

/** Request CodeLenses from every provider registered for `uri`. */
async function lensesFor(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const result = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return result ?? [];
}

/** A minimal but realistic cobertura report: one covered, one uncovered line. */
const COBERTURA_XML = [
  '<?xml version="1.0"?>',
  '<coverage>',
  '  <packages>',
  '    <package>',
  '      <classes>',
  '        <class filename="/src/Sample.cs">',
  '          <lines>',
  '            <line number="1" hits="4"/>',
  '            <line number="2" hits="0"/>',
  '            <line number="9" hits="2"/>',
  '          </lines>',
  '        </class>',
  '      </classes>',
  '    </package>',
  '  </packages>',
  '</coverage>',
].join('\n');

// A C# xUnit-style test class. We write a real .csproj alongside it so the
// fixture is a genuine, buildable test project (no `dotnet new` restore wait).
const CSPROJ_XML = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup>',
  '    <TargetFramework>net10.0</TargetFramework>',
  '    <Nullable>enable</Nullable>',
  '    <IsPackable>false</IsPackable>',
  '  </PropertyGroup>',
  '  <ItemGroup>',
  '    <PackageReference Include="xunit" Version="2.9.2" />',
  '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />',
  '  </ItemGroup>',
  '</Project>',
].join('\n');

const CSHARP_TESTS = [
  'using Xunit;',
  '',
  'namespace Sample.Tests',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact]',
  '        public void Adds_TwoNumbers()',
  '        {',
  '            Assert.Equal(3, 1 + 2);',
  '        }',
  '',
  '        [Theory]',
  '        [InlineData(2, 2, 4)]',
  '        public void Adds_Theory(int a, int b, int expected)',
  '        {',
  '            Assert.Equal(expected, a + b);',
  '        }',
  '',
  '        public void NotATest()',
  '        {',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

const FSHARP_TESTS = [
  'module Sample.FSharpTests',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let addsTwoNumbers () =',
  '    Assert.Equal(3, 1 + 2)',
  '',
  '[<Theory>]',
  '[<InlineData(2, 2, 4)>]',
  'let addsTheory a b expected =',
  '    Assert.Equal(expected, a + b)',
  '',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Testing module — run/debug commands + discovery & coverage helpers
// ─────────────────────────────────────────────────────────────────────────────

suite('Testing module e2e — run/debug commands and helpers', () => {
  let tmpDir: string;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(60_000);
    ({ tmpDir } = await setupLspTestSuite('testing-e2e-'));
  });

  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  setup(() => {
    stubs = installUiStubs();
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
  });

  test('runAtCursor on a [Fact] method resolves and warns when no test is discovered', async function () {
    this.timeout(30_000);
    const projectDir = path.join(tmpDir, 'RunProj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'RunProj.csproj'), CSPROJ_XML, 'utf8');
    const { doc, uri } = await openCSharpFile(projectDir, 'CalculatorTests.cs', CSHARP_TESTS);

    // Put the cursor on the [Fact] test method body so this is a real
    // "run the test under my caret" interaction, not a synthetic call.
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor !== undefined, 'a text editor must be active');
    const factLine = doc
      .getText()
      .split('\n')
      .findIndex((line) => line.includes('Adds_TwoNumbers()'));
    assert.ok(factLine > 0, 'fixture must contain the [Fact] method');
    editor.selection = new vscode.Selection(factLine, 8, factLine, 8);

    // The lens hands the command (uri, methodName). With a freshly-activated
    // controller no tests are discovered yet, so the deterministic outcome is a
    // warning — which we capture via the stub instead of a real modal.
    stubs.queueWarning(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_RUN_AT_CURSOR, uri, 'Adds_TwoNumbers');
    });

    assert.strictEqual(stubs.log.warningMessages.length, 1, 'one warning must be shown');
    const warning = stubs.log.warningMessages[0] ?? '';
    assert.ok(warning.includes('Adds_TwoNumbers'), 'warning names the missing test method');
    assert.ok(warning.includes('discovery'), 'warning points the user at discovery');
  });

  test('debugAtCursor on a method resolves and warns for an undiscovered test', async function () {
    this.timeout(30_000);
    const projectDir = path.join(tmpDir, 'DebugProj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'DebugProj.csproj'), CSPROJ_XML, 'utf8');
    const { doc, uri } = await openCSharpFile(projectDir, 'CalculatorTests.cs', CSHARP_TESTS);

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor !== undefined);
    const theoryLine = doc
      .getText()
      .split('\n')
      .findIndex((line) => line.includes('Adds_Theory('));
    assert.ok(theoryLine > 0);
    editor.selection = new vscode.Selection(theoryLine, 8, theoryLine, 8);

    stubs.queueWarning(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_DEBUG_AT_CURSOR, uri, 'Adds_Theory');
    });

    assert.strictEqual(stubs.log.warningMessages.length, 1);
    assert.ok((stubs.log.warningMessages[0] ?? '').includes('Adds_Theory'));
  });

  test('both at-cursor commands are registered and stay registered', async function () {
    this.timeout(20_000);
    const registered = await vscode.commands.getCommands(true);
    assert.ok(
      registered.includes(CMD_TEST_RUN_AT_CURSOR),
      'sharplsp.test.runAtCursor must be registered',
    );
    assert.ok(
      registered.includes(CMD_TEST_DEBUG_AT_CURSOR),
      'sharplsp.test.debugAtCursor must be registered',
    );

    // Driving them back to back must never reject, even with no discovered tests.
    stubs.queueWarning(undefined, undefined);
    const uri = vscode.Uri.file(path.join(tmpDir, 'phantom.cs'));
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_RUN_AT_CURSOR, uri, 'Phantom');
    });
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_DEBUG_AT_CURSOR, uri, 'Phantom');
    });
    assert.strictEqual(stubs.log.warningMessages.length, 2);
  });

  test('discovery predicates classify a real test project listing', async function () {
    this.timeout(20_000);
    // Mirror the line-by-line output that discoverTestsInFolder filters: a
    // banner, prose, and fully-qualified test names from the C# fixture.
    const listing = [
      'Determining projects to restore...',
      'Build succeeded.',
      'The following Tests are available:',
      'Sample.Tests.CalculatorTests.Adds_TwoNumbers',
      'Sample.Tests.CalculatorTests.Adds_Theory',
      'Passed!  - Failed: 0, Passed: 2',
    ];

    const accepted = listing.filter((line) => isTestName(line));
    assert.deepStrictEqual(accepted, [
      'Sample.Tests.CalculatorTests.Adds_TwoNumbers',
      'Sample.Tests.CalculatorTests.Adds_Theory',
    ]);
    assert.strictEqual(isTestName('The following Tests are available:'), false);
    assert.strictEqual(isTestName('Build succeeded.'), false);
    assert.strictEqual(isTestName('JustAnIdentifierNoDot'), false);
    assert.strictEqual(isTestName('Ns.Class.Param(x: 1)'), false);

    // The same addTestItem tagging logic (Expecto || FsCheck => F#).
    const isFsharp = (name: string): boolean => isExpectoTest(name) || isFsCheckTest(name);
    assert.strictEqual(isFsharp('MyLib.Tests.testCase'), true);
    assert.strictEqual(isFsharp('MyLib.Tests.testList'), true);
    assert.strictEqual(isFsharp('MyLib.Expecto.Foo'), true);
    assert.strictEqual(isFsharp('MyLib.FsCheck.Prop'), true);
    assert.strictEqual(isFsharp('MyLib.Property.Roundtrip'), true);
    assert.strictEqual(isFsharp('Sample.Tests.CalculatorTests.Adds_TwoNumbers'), false);
    assert.strictEqual(isExpectoTest('FsCheck'), false);
    assert.strictEqual(isFsCheckTest('Expecto'), false);
  });

  test('buildFilterArgs assembles the dotnet --filter clause for selected tests', async function () {
    this.timeout(20_000);
    assert.deepStrictEqual(buildFilterArgs([]), []);

    const single = buildFilterArgs([testItem('Sample.Tests.CalculatorTests.Adds_TwoNumbers')]);
    assert.deepStrictEqual(single, [
      '--filter',
      'FullyQualifiedName=Sample.Tests.CalculatorTests.Adds_TwoNumbers',
    ]);

    const many = buildFilterArgs([
      testItem('Sample.Tests.CalculatorTests.Adds_TwoNumbers'),
      testItem('Sample.Tests.CalculatorTests.Adds_Theory'),
    ]);
    assert.strictEqual(many.length, 2);
    assert.strictEqual(many[0], '--filter');
    assert.strictEqual(
      many[1],
      'FullyQualifiedName=Sample.Tests.CalculatorTests.Adds_TwoNumbers|' +
        'FullyQualifiedName=Sample.Tests.CalculatorTests.Adds_Theory',
    );
    // Exactly one pipe per extra test; order is preserved verbatim.
    assert.strictEqual((many[1] ?? '').split('|').length - 1, 1);
    assert.ok(
      (many[1] ?? '').startsWith('FullyQualifiedName=Sample.Tests.CalculatorTests.Adds_Two'),
    );
  });

  test('coverage helpers find and parse a real cobertura report on disk', async function () {
    this.timeout(20_000);
    const resultsDir = path.join(tmpDir, '.sharplsp-coverage');
    // findCoberturaFile only looks ONE level below the results dir.
    assert.strictEqual(findCoberturaFile(resultsDir), undefined, 'missing dir → undefined');
    fs.mkdirSync(resultsDir, { recursive: true });
    assert.strictEqual(findCoberturaFile(resultsDir), undefined, 'empty dir → undefined');

    const runDir = path.join(resultsDir, 'run-guid');
    fs.mkdirSync(runDir, { recursive: true });
    const coveragePath = path.join(runDir, 'coverage.cobertura.xml');
    fs.writeFileSync(coveragePath, COBERTURA_XML, 'utf8');

    const found = findCoberturaFile(resultsDir);
    assert.strictEqual(found, coveragePath, 'finds the nested coverage report');

    assert.ok(found !== undefined);
    const coverages = parseCoberturaXml(found);
    assert.strictEqual(coverages.length, 1, 'one class → one FileCoverage');
    const fc = coverages[0];
    assert.ok(fc !== undefined);
    // 3 lines total, 2 with hits>0 (4 and 2), 1 with 0 hits.
    assert.strictEqual(fc.statementCoverage.total, 3);
    assert.strictEqual(fc.statementCoverage.covered, 2);
    assert.strictEqual(fc.uri.scheme, 'file');
    assert.strictEqual(fc.uri.toString(), vscode.Uri.file('/src/Sample.cs').toString());

    // A report with no packages yields no coverage entries.
    const emptyPath = path.join(runDir, 'empty.cobertura.xml');
    fs.writeFileSync(
      emptyPath,
      '<?xml version="1.0"?><coverage><packages></packages></coverage>',
      'utf8',
    );
    assert.deepStrictEqual(parseCoberturaXml(emptyPath), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Status Lens — live CodeLens provider over real C#/F# files
// ─────────────────────────────────────────────────────────────────────────────

suite('Test status lens e2e — CodeLens provider and toggle', () => {
  let tmpDir: string;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(60_000);
    ({ tmpDir } = await setupLspTestSuite('test-lens-e2e-'));
  });

  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  setup(() => {
    stubs = installUiStubs();
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
  });

  test('a C# test file exposes Run + Debug test lenses wired to the at-cursor commands', async function () {
    this.timeout(30_000);
    const { uri } = await openCSharpFile(tmpDir, 'LensTargets.cs', CSHARP_TESTS);

    const all = await lensesFor(uri);
    const lenses = testLensCommands(all);
    assert.ok(
      lenses.length >= 4,
      `expected ≥4 test lenses (2 per [Fact]/[Theory]), got ${lenses.length}`,
    );

    const runLenses = lenses.filter((l) => l.command?.command === CMD_TEST_RUN_AT_CURSOR);
    const debugLenses = lenses.filter((l) => l.command?.command === CMD_TEST_DEBUG_AT_CURSOR);
    assert.strictEqual(runLenses.length, debugLenses.length, 'Run/Debug lenses are paired');
    assert.ok(runLenses.length >= 2, 'both [Fact] and [Theory] get a Run lens');

    // Each Run lens carries (uri, methodName) targeting a discovered method name.
    const runTargets = runLenses
      .map((l) => l.command?.arguments?.[1])
      .filter((name): name is string => typeof name === 'string');
    assert.ok(runTargets.includes('Adds_TwoNumbers'));
    assert.ok(runTargets.includes('Adds_Theory'));
    assert.ok(!runTargets.includes('NotATest'), 'plain methods get no test lens');

    // The Run lens title matches the rendered "play" action.
    const firstRun = runLenses[0];
    assert.ok(firstRun !== undefined);
    assert.strictEqual(firstRun.command?.title, '$(play) Run Test');
    assert.strictEqual(firstRun.command?.arguments?.[0]?.toString(), uri.toString());
  });

  test('an F# test file exposes Run + Debug lenses for [<Fact>]/[<Theory>] bindings', async function () {
    this.timeout(30_000);
    const { uri } = await openFSharpFile(tmpDir, 'LensTargets.fs', FSHARP_TESTS);

    const lenses = testLensCommands(await lensesFor(uri));
    const runTargets = lenses
      .filter((l) => l.command?.command === CMD_TEST_RUN_AT_CURSOR)
      .map((l) => l.command?.arguments?.[1])
      .filter((name): name is string => typeof name === 'string');

    assert.ok(
      runTargets.length >= 2,
      `F# file must expose ≥2 run lenses, got ${runTargets.length}`,
    );
    // Both [<Fact>] and [<Theory>] sit over a plain `let` binding, so each is a
    // resolvable run target.
    assert.ok(runTargets.includes('addsTwoNumbers'), 'the [<Fact>] let binding is a run target');
    assert.ok(runTargets.includes('addsTheory'), 'the [<Theory>] let binding is a run target');
    assert.ok(
      lenses.some((l) => l.command?.command === CMD_TEST_DEBUG_AT_CURSOR),
      'F# tests also get a Debug lens',
    );
  });

  test('disabling sharplsp.testLens.enabled removes the test lenses; re-enabling restores them', async function () {
    this.timeout(40_000);
    const { uri } = await openCSharpFile(tmpDir, 'Toggle.cs', CSHARP_TESTS);

    const cfg = vscode.workspace.getConfiguration(TEST_LENS_SECTION);
    const savedWorkspaceValue = cfg.inspect<boolean>(TEST_LENS_KEY)?.workspaceValue;

    try {
      // Baseline: lenses present while enabled (default true).
      await cfg.update(TEST_LENS_KEY, true, vscode.ConfigurationTarget.Workspace);
      const enabledLenses = testLensCommands(await lensesFor(uri));
      assert.ok(enabledLenses.length >= 2, 'lenses present while enabled');

      // Disable → the provider returns an empty array, so no test lenses remain.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, false, vscode.ConfigurationTarget.Workspace);
      const disabledLenses = testLensCommands(await lensesFor(uri));
      assert.strictEqual(disabledLenses.length, 0, 'disabling testLens removes the lenses');

      // Re-enable → lenses come back.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, true, vscode.ConfigurationTarget.Workspace);
      const reEnabledLenses = testLensCommands(await lensesFor(uri));
      assert.ok(reEnabledLenses.length >= 2, 're-enabling restores the lenses');
    } finally {
      // Restore the exact prior workspace value (undefined when unset) so the
      // key is removed rather than persisted into the fixture settings.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, savedWorkspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('a non-test C# file produces no test lenses, and the signature parsers agree with discovery', async function () {
    this.timeout(30_000);
    const plain = [
      'namespace Sample',
      '{',
      '    public class Plain',
      '    {',
      '        public void Helper() { }',
      '    }',
      '}',
      '',
    ].join('\n');
    const { uri } = await openCSharpFile(tmpDir, 'Plain.cs', plain);
    const lenses = testLensCommands(await lensesFor(uri));
    assert.strictEqual(lenses.length, 0, 'a class with no [Fact]/[Test] yields no test lenses');

    // The exported signature parsers drive which method names the lenses target;
    // assert their literal behaviour on the fixture's own lines.
    assert.strictEqual(
      extractCSharpMethodName('        public void Adds_TwoNumbers()'),
      'Adds_TwoNumbers',
    );
    assert.strictEqual(
      extractCSharpMethodName('        public void Adds_Theory(int a, int b, int expected)'),
      'Adds_Theory',
    );
    assert.strictEqual(
      extractCSharpMethodName('        [Fact]'),
      undefined,
      'attribute line is not a method',
    );
    assert.strictEqual(
      extractCSharpMethodName('if (x > 0)'),
      undefined,
      'control flow is not a method',
    );

    assert.strictEqual(extractFSharpFunctionName('let addsTheory a b expected ='), 'addsTheory');
    assert.strictEqual(extractFSharpFunctionName('member this.MyTest () ='), 'MyTest');
    assert.strictEqual(extractFSharpFunctionName('[<Fact>]'), undefined);
  });

  test('formatDuration renders the lens status suffix across the ms/seconds boundary', async function () {
    this.timeout(20_000);
    // Drives the exact string the status lens appends after "$(pass) Passed".
    assert.strictEqual(formatDuration(undefined), '');
    assert.strictEqual(formatDuration(0), ' (0ms)');
    assert.strictEqual(formatDuration(42), ' (42ms)');
    assert.strictEqual(formatDuration(999), ' (999ms)');
    assert.strictEqual(formatDuration(1000), ' (1.0s)');
    assert.strictEqual(formatDuration(1500), ' (1.5s)');

    const passedTitle = `$(pass) Passed${formatDuration(1500)}`;
    assert.strictEqual(passedTitle, '$(pass) Passed (1.5s)');
    const msTitle = `$(pass) Passed${formatDuration(42)}`;
    assert.strictEqual(msTitle, '$(pass) Passed (42ms)');
  });
});
