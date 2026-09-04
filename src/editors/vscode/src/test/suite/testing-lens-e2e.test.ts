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
import { buildFilterArgs, isExpectoTest, isFsCheckTest } from '../../testing.js';
import type { CachedTestResult } from '../../testing.js';
import {
  batchAssemblies,
  isDiscoveredTestLine,
  mergeMultiTargeted,
  parseAnnouncedAssemblies,
  parseTestList,
  resolveAnnouncedAssembly,
  unescapeMsBuildPath,
} from '../../test-discovery.js';
import {
  findCoberturaFile,
  findCoberturaFiles,
  mergeCoberturaReports,
  parseCoberturaXml,
} from '../../test-coverage.js';
import {
  extractCSharpMethodName,
  extractFSharpFunctionName,
  formatDuration,
  statusLensTitle,
} from '../../test-lens.js';
import { CMD_TEST_RUN_AT_CURSOR, CMD_TEST_DEBUG_AT_CURSOR } from '../../constants.js';
import {
  closeAllEditors,
  deepEq,
  eq,
  neq,
  openCSharpFile,
  openFSharpFile,
  replaceDocumentContent,
  requireAt,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { codeLensesFor, warmCodeLensPath } from './code-lens-kit';
import {
  ACTIVATION_MS,
  COMMAND_MS,
  FAST_MS,
  LSP_RESPONSE_MS,
  SETTINGS_WRITE_MS,
  SIDECAR_COLD_MS,
} from './test-timeouts';
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

/**
 * The characters [TEST-FILTER-ESCAPE] calls grammar and requires escaping.
 *
 * `,`, `+`, `.` and SPACE are deliberately absent: they occur inside real
 * fully-qualified names (`Adds_Case(2,2,4)`, a nested-type `+`, an F# backtick
 * binding) and escaping one would corrupt the very names the spec's table says
 * must round-trip unchanged.
 */
const FILTER_GRAMMAR: readonly string[] = ['\\', '(', ')', '&', '|', '=', '!', '~'];

/**
 * How many pipes in a filter expression are CLAUSE SEPARATORS, i.e. not
 * preceded by a backslash.
 *
 * Counting every `|` cannot tell an OR between two selected tests from a pipe
 * that occurs INSIDE one test's name — and those two are exactly what
 * [TEST-FILTER-ESCAPE] distinguishes ("OR'd with an UNESCAPED `|` between
 * escaped clauses").
 */
function separatorPipes(expression: string): number {
  let count = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '|' && expression[index - 1] !== '\\') {
      count += 1;
    }
  }
  return count;
}

/** A cobertura report over one file with the given per-line hit counts. */
function coberturaFor(filename: string, hits: readonly number[]): string {
  const lines = hits
    .map((hit, index) => `<line number="${String(index + 1)}" hits="${String(hit)}"/>`)
    .join('');
  return (
    '<?xml version="1.0"?><coverage><packages><package><classes>' +
    `<class filename="${filename}"><lines>${lines}</lines></class>` +
    '</classes></package></packages></coverage>'
  );
}

/** Write `xml` into its own run-id folder one level below `resultsDir`. */
function plantReport(resultsDir: string, runId: string, xml: string): string {
  const runDir = path.join(resultsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, 'coverage.cobertura.xml');
  fs.writeFileSync(reportPath, xml, 'utf8');
  return reportPath;
}

/** A `CachedTestResult` literal, so the four lens titles can be driven directly. */
function cached(
  result: Partial<CachedTestResult> & Pick<CachedTestResult, 'outcome'>,
): CachedTestResult {
  return { passed: result.outcome === 'passed', ...result };
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

// The method names are deliberately prefixed and unique to THIS suite. The
// at-cursor tests below assert the "no discovered test matches" warning path,
// which only holds while nothing else has put a same-named item into the shared
// SharpLspTestController. test-explorer-e2e discovers a real
// `…CalculatorTests.Adds_TwoNumbers`, so reusing that name makes this suite pass
// or fail depending on whether that suite's discovery won the race — green on
// Ubuntu, red on Windows ([DIST-CI-WIN-VSIX]). Keep these names suite-unique.
const CSHARP_TESTS = [
  'using Xunit;',
  '',
  'namespace Sample.Tests',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact]',
  '        public void Lens_AddsTwoNumbers()',
  '        {',
  '            Assert.Equal(3, 1 + 2);',
  '        }',
  '',
  '        [Theory]',
  '        [InlineData(2, 2, 4)]',
  '        public void Lens_AddsTheory(int a, int b, int expected)',
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

// Every attribute shape [TEST-OVERVIEW] names ("xUnit, NUnit, MSTest, Expecto
// and FsCheck, in BOTH C# and F#") over one class, plus three methods that are
// NOT tests. A lens above a helper runs nothing; a missing lens above an
// [TestMethod] leaves MSTest users with no Run button at all.
const FRAMEWORK_TESTS = [
  'using Xunit;',
  'using NUnit.Framework;',
  'using Microsoft.VisualStudio.TestTools.UnitTesting;',
  '',
  'namespace Sample.Frameworks',
  '{',
  '    public class MixedTests',
  '    {',
  '        [Fact]',
  '        public void Mixed_XunitFact()',
  '        {',
  '        }',
  '',
  '        [Theory]',
  '        [InlineData(1)]',
  '        public void Mixed_XunitTheory(int a)',
  '        {',
  '        }',
  '',
  '        [Test]',
  '        public void Mixed_NunitTest()',
  '        {',
  '        }',
  '',
  '        [TestCase(2, 2, 4)]',
  '        public void Mixed_NunitCase(int a, int b, int expected)',
  '        {',
  '        }',
  '',
  '        [TestMethod]',
  '        public void Mixed_MstestMethod()',
  '        {',
  '        }',
  '',
  '        [DataRow(1, 2)]',
  '        [DataTestMethod]',
  '        public void Mixed_MstestRow(int a, int b)',
  '        {',
  '        }',
  '',
  '        private void Mixed_Helper()',
  '        {',
  '        }',
  '',
  '        public int Mixed_Property { get; set; }',
  '',
  '        public void Mixed_PlainMethod()',
  '        {',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

/** The methods FRAMEWORK_TESTS decorates with a test attribute. */
const FRAMEWORK_TEST_METHODS: readonly string[] = [
  'Mixed_XunitFact',
  'Mixed_XunitTheory',
  'Mixed_NunitTest',
  'Mixed_NunitCase',
  'Mixed_MstestMethod',
  'Mixed_MstestRow',
];

/** The members of FRAMEWORK_TESTS that no lens may ever offer to run. */
const FRAMEWORK_NON_TESTS: readonly string[] = [
  'Mixed_Helper',
  'Mixed_Property',
  'Mixed_PlainMethod',
];

// ─────────────────────────────────────────────────────────────────────────────
// Testing module — run/debug commands + discovery & coverage helpers
// ─────────────────────────────────────────────────────────────────────────────

suite('Testing module e2e — run/debug commands and helpers', () => {
  let tmpDir: string;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
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
    this.timeout(COMMAND_MS);
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
      .findIndex((line) => line.includes('Lens_AddsTwoNumbers()'));
    assert.ok(factLine > 0, 'fixture must contain the [Fact] method');
    editor.selection = new vscode.Selection(factLine, 8, factLine, 8);

    // The lens hands the command (uri, methodName). With a freshly-activated
    // controller no tests are discovered yet, so the deterministic outcome is a
    // warning — which we capture via the stub instead of a real modal.
    stubs.queueWarning(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_RUN_AT_CURSOR, uri, 'Lens_AddsTwoNumbers');
    });

    assert.strictEqual(stubs.log.warningMessages.length, 1, 'one warning must be shown');
    const warning = stubs.log.warningMessages[0] ?? '';
    assert.ok(warning.includes('Lens_AddsTwoNumbers'), 'warning names the missing test method');
    assert.ok(warning.includes('discovery'), 'warning points the user at discovery');

    // Interaction 3 - "not discovered yet" is a WARNING, not an error and not a
    // silent no-op. The user pressed Run and something must answer: a silent
    // return leaves them pressing it again ([TEST-EXPLORER]).
    assert.deepEqual(stubs.log.errorMessages, [], 'an undiscovered test is not an error');
    assert.deepEqual(stubs.log.infoMessages, [], 'and nothing claims the test ran');
    assert.notStrictEqual(stubs.log.warningOptions[0]?.modal, true, 'and it does not block');

    // Interaction 4 - the caret really was on the [Fact] method, so the warning
    // is about discovery rather than about a caret that resolved to nothing.
    assert.strictEqual(
      editor.selection.active.line,
      factLine,
      'the caret sat on the [Fact] method',
    );
    assert.ok(
      doc.lineAt(factLine).text.includes('Lens_AddsTwoNumbers'),
      'and that line really declares the method the command was given',
    );
    assert.ok(
      doc.getText().includes('[Fact]'),
      'the fixture carries the attribute that makes it a test at all',
    );

    // Interaction 5 - running the SAME method again warns again. A command that
    // remembers it already complained goes silent on the second press, which is
    // exactly when the user is most likely to press it.
    stubs.queueWarning(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_RUN_AT_CURSOR, uri, 'Lens_AddsTwoNumbers');
    });
    assert.strictEqual(stubs.log.warningMessages.length, 2, 'the second press warns again');
    assert.strictEqual(
      stubs.log.warningMessages[1],
      warning,
      'with the same message, naming the same method',
    );
  });

  test('debugAtCursor on a method resolves and warns for an undiscovered test', async function () {
    this.timeout(COMMAND_MS);
    const projectDir = path.join(tmpDir, 'DebugProj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'DebugProj.csproj'), CSPROJ_XML, 'utf8');
    const { doc, uri } = await openCSharpFile(projectDir, 'CalculatorTests.cs', CSHARP_TESTS);

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor !== undefined);
    const theoryLine = doc
      .getText()
      .split('\n')
      .findIndex((line) => line.includes('Lens_AddsTheory('));
    assert.ok(theoryLine > 0);
    editor.selection = new vscode.Selection(theoryLine, 8, theoryLine, 8);

    stubs.queueWarning(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_DEBUG_AT_CURSOR, uri, 'Lens_AddsTheory');
    });

    assert.strictEqual(stubs.log.warningMessages.length, 1);
    const debugWarning = stubs.log.warningMessages[0] ?? '';
    assert.ok(debugWarning.includes('Lens_AddsTheory'), 'the warning names the theory method');
    assert.ok(debugWarning.includes('discovery'), 'and points the user at discovery');

    // Interaction 2 - a debug that cannot start must not START ANYTHING. A
    // half-launched session with no test to run leaves the debug toolbar on
    // screen with nothing behind it ([TEST-EXPLORER]).
    assert.strictEqual(
      vscode.debug.activeDebugSession,
      undefined,
      'an undiscovered test starts no debug session',
    );
    assert.deepEqual(stubs.log.errorMessages, [], 'and reports no error');
    assert.deepEqual(stubs.log.infoMessages, [], 'and claims no run');

    // Interaction 3 - the caret sat on the [Theory] declaration, so the warning
    // is about discovery and not about an unresolvable caret.
    assert.strictEqual(editor?.selection.active.line, theoryLine, 'the caret sat on the theory');
    assert.ok(
      doc.lineAt(theoryLine).text.includes('Lens_AddsTheory'),
      'and that line declares the method the command was given',
    );
    assert.ok(doc.getText().includes('[Theory]'), 'the fixture really declares a theory');

    // Interaction 4 - the DEBUG path warns for the same reason the RUN path
    // does. Two commands that disagree about whether a test exists send the
    // user hunting for a difference that is not there.
    stubs.queueWarning(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_RUN_AT_CURSOR, uri, 'Lens_AddsTheory');
    });
    assert.strictEqual(stubs.log.warningMessages.length, 2, 'the run path warns as well');
    assert.strictEqual(
      stubs.log.warningMessages[1],
      debugWarning,
      'with the very same message for the very same method',
    );
  });

  test('both at-cursor commands are registered and stay registered', async function () {
    this.timeout(COMMAND_MS);
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

    // Interaction 3 - the two are DISTINCT commands. A lens pair backed by one
    // id renders two buttons that do the same thing, which is the defect the
    // Run/Debug pair exists to avoid.
    assert.notStrictEqual(CMD_TEST_RUN_AT_CURSOR, CMD_TEST_DEBUG_AT_CURSOR, 'two ids, not one');
    assert.ok(CMD_TEST_RUN_AT_CURSOR.startsWith('sharplsp.'), 'both live in our namespace');
    assert.ok(CMD_TEST_DEBUG_AT_CURSOR.startsWith('sharplsp.'), 'both of them');

    // Interaction 4 - they STAY registered after being driven. A command that
    // disposes itself on a failed run works exactly once per window.
    const after = await vscode.commands.getCommands(true);
    assert.ok(after.includes(CMD_TEST_RUN_AT_CURSOR), 'runAtCursor survives being run');
    assert.ok(after.includes(CMD_TEST_DEBUG_AT_CURSOR), 'and so does debugAtCursor');

    // Interaction 5 - a phantom file warns rather than throwing, and warns for
    // BOTH commands: the two warnings above came one from each.
    assert.deepEqual(stubs.log.errorMessages, [], 'a phantom file is not an error');
    assert.strictEqual(
      stubs.log.warningMessages.every((message) => message.includes('Phantom')),
      true,
      `both warnings name the phantom method: ${stubs.log.warningMessages.join(' | ')}`,
    );
  });

  test('discovery predicates classify a real test project listing', async function () {
    this.timeout(FAST_MS);
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

    // `isDiscoveredTestLine` is the predicate discovery actually applies to the
    // `--list-tests` fallback listing. The suite used to assert a second,
    // near-identical `isTestName` that nothing in production called any more —
    // a green assertion over dead code.
    const accepted = listing.filter((line) => isDiscoveredTestLine(line));
    assert.deepStrictEqual(accepted, [
      'Sample.Tests.CalculatorTests.Adds_TwoNumbers',
      'Sample.Tests.CalculatorTests.Adds_Theory',
    ]);
    assert.strictEqual(isDiscoveredTestLine('The following Tests are available:'), false);
    assert.strictEqual(isDiscoveredTestLine('Build succeeded.'), false);
    assert.strictEqual(isDiscoveredTestLine('Determining projects to restore...'), false);
    assert.strictEqual(isDiscoveredTestLine('Passed!  - Failed: 0, Passed: 2'), false);
    assert.strictEqual(isDiscoveredTestLine('JustAnIdentifierNoDot'), false);
    assert.strictEqual(isDiscoveredTestLine('Ns.Class.Param(x: 1)'), false);
    // A managed stack frame is dotted-identifier shaped, so it has to be
    // rejected explicitly: accepting one makes a CRASHED `dotnet test` look
    // like a successful enumeration to the salvage path.
    assert.strictEqual(
      isDiscoveredTestLine('at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs'),
      false,
      'a stack frame is never a test name',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Ns.Module.adds two numbers with spaces'),
      true,
      'an idiomatic F# backtick name carries spaces and must survive',
    );
    assert.strictEqual(
      isDiscoveredTestLine('Proj -> C:\\out\\Proj.dll'),
      false,
      'the MSBuild output mapping is never a test name',
    );

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
    this.timeout(FAST_MS);
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

    // Interaction 2 - EVERY selected test reaches the clause. A filter that
    // drops one runs fewer tests than the user selected and reports the missing
    // ones as never run ([TEST-FILTER-ESCAPE]).
    const three = buildFilterArgs([
      testItem('Sample.Tests.CalculatorTests.A'),
      testItem('Sample.Tests.CalculatorTests.B'),
      testItem('Sample.Tests.CalculatorTests.C'),
    ]);
    assert.strictEqual(three.length, 2, 'three tests still make one --filter pair');
    assert.strictEqual((three[1] ?? '').split('|').length, 3, 'with three OR-ed clauses');
    for (const name of ['.A', '.B', '.C']) {
      assert.ok((three[1] ?? '').includes(name), `${name} must reach the clause`);
    }

    // Interaction 3 - the flag is always `--filter`, exactly once. A clause
    // emitted as two flags makes `dotnet test` use the last one and silently
    // run a subset.
    assert.strictEqual(three.filter((argument) => argument === '--filter').length, 1, 'one flag');
    assert.strictEqual(three[0], '--filter', 'and it comes first');
    assert.strictEqual(
      single.filter((argument) => argument === '--filter').length,
      1,
      'for one too',
    );

    // Interaction 4 - an empty selection produces NO flag at all. A bare
    // `--filter` with an empty value matches nothing, so the run reports zero
    // tests instead of running everything.
    assert.deepStrictEqual(buildFilterArgs([]), [], 'no selection, no filter');
    assert.strictEqual(buildFilterArgs([]).length, 0, 'not even the flag');
  });

  test('coverage helpers find and parse a real cobertura report on disk', async function () {
    this.timeout(FAST_MS);
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

  // Implements [TEST-FILTER-ESCAPE]: "`\`, `(`, `)`, `&`, `|`, `=`, `!` and `~`
  // are grammar and MUST be backslash-escaped inside a fully-qualified name
  // before substitution", and "Multiple selected tests are OR'd with an
  // UNESCAPED `|` between escaped clauses".
  test('buildFilterArgs escapes every grammar character and OR-s clauses with a bare pipe', async function () {
    this.timeout(FAST_MS);

    // Interaction 1 - each reserved character on its own. An unescaped NUnit
    // `[TestCase]` name crashes the NUnit adapter in `VsTestFilter.get_IsEmpty()`,
    // so the run dies instead of reporting a result: this is not cosmetic.
    for (const char of FILTER_GRAMMAR) {
      const args = buildFilterArgs([testItem('Ns.Class.Method' + char + 'Tail')]);
      eq(args.length, 2, char + ': one --filter flag and one expression, never more');
      eq(args[0], '--filter', char + ': the flag comes first');
      eq(
        args[1],
        'FullyQualifiedName=Ns.Class.Method\\' + char + 'Tail',
        char + ' is filter grammar and MUST be backslash-escaped inside the name',
      );
      eq(
        (args[1] ?? '').startsWith('FullyQualifiedName='),
        true,
        char + ': the FullyQualifiedName= separator is the grammar, never escaped itself',
      );
      eq(separatorPipes(args[1] ?? ''), 0, char + ': one test is one clause, so no OR');
    }

    // Interaction 2 - the shapes [TEST-DISCOVERY-FQN]'s table says must
    // round-trip unchanged. `,`, `+` and SPACE are not grammar: escaping one
    // would corrupt the name it was meant to protect.
    const nunit = buildFilterArgs([testItem('Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)')]);
    eq(
      nunit[1],
      'FullyQualifiedName=Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)',
      'the NUnit [TestCase] parentheses are escaped and its commas are left alone',
    );
    eq((nunit[1] ?? '').includes('\\,'), false, 'a comma is not filter grammar');
    const fsharp = buildFilterArgs([testItem('Fs.Xunit.Fixtures.adds two numbers with spaces')]);
    eq(
      fsharp[1],
      'FullyQualifiedName=Fs.Xunit.Fixtures.adds two numbers with spaces',
      'an idiomatic F# backtick name carries SPACES and must survive verbatim',
    );
    eq((fsharp[1] ?? '').includes('\\ '), false, 'a space is not filter grammar');
    const mstest = buildFilterArgs([testItem('Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers')]);
    eq(
      mstest[1],
      'FullyQualifiedName=Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers',
      'a CLR nested-type + is part of the name, not the filter grammar',
    );
    eq((mstest[1] ?? '').includes('\\+'), false, 'a plus is not filter grammar');

    // Interaction 3 - a SELECTION. The joining pipe is unescaped; a pipe inside
    // a name is not. Getting that backwards either merges two tests into one
    // clause or splits one name in half, and both run the wrong tests.
    deepEq(buildFilterArgs([]), [], 'no selection is no filter at all, not an empty expression');
    const pair = buildFilterArgs([
      testItem('Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)'),
      testItem('Fs.Xunit.Fixtures.adds two numbers with spaces'),
    ]);
    eq(pair.length, 2, 'a selection is still ONE --filter argument, never one per test');
    eq(
      pair[1],
      'FullyQualifiedName=Cs.Nunit.Fixtures.CalculatorTests.Adds_Case\\(2,2,4\\)|' +
        'FullyQualifiedName=Fs.Xunit.Fixtures.adds two numbers with spaces',
      'two selected tests are OR-ed with an UNESCAPED pipe between escaped clauses',
    );
    eq(separatorPipes(pair[1] ?? ''), 1, 'exactly one separator for two clauses');
    const hostile = buildFilterArgs([
      testItem('Ns.Class.Has|Pipe'),
      testItem('Ns.Class.Plain'),
      testItem('Ns.Class.Also|Piped'),
    ]);
    eq(
      separatorPipes(hostile[1] ?? ''),
      2,
      'three selected tests are two separators, however many pipes their NAMES carry',
    );
    eq(
      (hostile[1] ?? '').includes('\\|Pipe'),
      true,
      'the pipe inside a name is escaped, so it can never be read as a clause break',
    );
    eq(
      (hostile[1] ?? '').split('FullyQualifiedName=').length - 1,
      3,
      'one FullyQualifiedName= clause per selected test, in selection order',
    );
    eq(
      (hostile[1] ?? '').indexOf('Ns.Class.Plain') > (hostile[1] ?? '').indexOf('Has'),
      true,
      'and the order the user selected them in is preserved',
    );
  });

  // Implements [TEST-DISCOVERY-FQN] - the at-cursor commands address a test by
  // the name the lens read off the signature, whatever characters it holds.
  test('the at-cursor commands carry hostile method names through verbatim', async function () {
    this.timeout(COMMAND_MS);
    const uri = vscode.Uri.file(path.join(tmpDir, 'AtCursor.cs'));

    // Interaction 1 - an F# backtick binding: the name carries SPACES, and the
    // warning must show the user the name it actually looked for. A name that
    // arrived trimmed or split is a name no discovered test can ever match.
    const spaced = 'adds two numbers with spaces';
    stubs.queueWarning(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_RUN_AT_CURSOR, uri, spaced);
    });
    eq(stubs.log.warningMessages.length, 1, 'an unresolvable at-cursor run warns exactly once');
    const first = stubs.log.warningMessages[0] ?? '';
    eq(first.includes(spaced), true, 'the warning names the binding, spaces and all');
    eq(first.includes('discovery'), true, 'and points the user at discovery');
    deepEq(stubs.log.errorMessages, [], 'a name it cannot resolve is not an ERROR');

    // Interaction 2 - every remaining shape the spec's tables name, plus each
    // filter-grammar character. None may reject, and each must be echoed back.
    const names = [
      'Adds_Case(2,2,4)',
      'Fixtures+CalculatorTests.AddsTwoNumbers',
      'Has|Pipe',
      'Has&Amp',
      'Has=Equals',
      'Has!Bang',
      'Has~Tilde',
    ];
    stubs.queueWarning(...names.map(() => undefined));
    for (const name of names) {
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand(CMD_TEST_RUN_AT_CURSOR, uri, name);
      }, name + ' must never make the at-cursor command reject');
    }
    eq(
      stubs.log.warningMessages.length,
      names.length + 1,
      'one warning per invocation - a swallowed gesture is a Run Test that did nothing',
    );
    for (const name of names) {
      eq(
        stubs.log.warningMessages.some((message) => message.includes(name)),
        true,
        name + ' must be reported back verbatim, not escaped or truncated',
      );
    }

    // Interaction 3 - the DEBUG half must behave identically. [TEST-STATUS-LENS]
    // puts both actions on the lens, so a Debug that rejects where Run warns is
    // a dead button on every test in the file.
    const before = stubs.log.warningMessages.length;
    stubs.queueWarning(undefined, undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_DEBUG_AT_CURSOR, uri, spaced);
    });
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_TEST_DEBUG_AT_CURSOR, uri, 'Adds_Case(2,2,4)');
    });
    eq(stubs.log.warningMessages.length, before + 2, 'Debug warns once per gesture as Run does');
    eq(
      (stubs.log.warningMessages[before] ?? '').includes(spaced),
      true,
      'and names the same binding the Run action would have run',
    );
    deepEq(stubs.log.errorMessages, [], 'still nothing reported to the user as a failure');
  });

  // Implements the [TEST-DISCOVERY-FQN] listing rules: every line is classified
  // INDEPENDENTLY ("a banner-index slice is not admissible"), and the MSBuild
  // `%XX` escaping in an announced assembly path is decoded before resolution.
  test('the discovery parsers hold every line shape a real solution listing prints', async function () {
    this.timeout(FAST_MS);

    // Interaction 1 - a listing in which two projects' banners and names
    // INTERLEAVE, which is what parallel project builds actually emit.
    const listing = [
      'Determining projects to restore...',
      '  Restored /w/Cs.Xunit.Fixtures/Cs.Xunit.Fixtures.csproj (in 412 ms).',
      'Cs.Xunit.Fixtures -> /w/bin/Debug/net10.0/Cs.Xunit.Fixtures.dll',
      'Test run for /w/bin/Debug/net10.0/Cs.Xunit.Fixtures.dll (.NETCoreApp,Version=v10.0)',
      'The following Tests are available:',
      '    Cs.Xunit.Fixtures.CalculatorTests.Adds_TwoNumbers',
      'Test run for /w/bin/Debug/net10.0/Fs.Xunit.Fixtures.dll (.NETCoreApp,Version=v10.0)',
      '    Fs.Xunit.Fixtures.adds two numbers with spaces',
      '    Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)',
      '    Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers',
      'Passed!  - Failed: 0, Passed: 4',
    ].join('\n');
    const names = parseTestList(listing);
    eq(
      names.includes('Fs.Xunit.Fixtures.adds two numbers with spaces'),
      true,
      'an F# backtick name printed AFTER a second banner is still a test name - every line ' +
        'is classified independently, so a banner-index slice can never be the rule',
    );
    eq(
      names.includes('Cs.Xunit.Fixtures.CalculatorTests.Adds_TwoNumbers'),
      true,
      'as is the C# one',
    );
    eq(
      names.includes('Cs.Xunit.Fixtures -> /w/bin/Debug/net10.0/Cs.Xunit.Fixtures.dll'),
      false,
      'the MSBuild output mapping is dotted-identifier shaped and must still be rejected',
    );
    eq(names.includes('Passed!  - Failed: 0, Passed: 4'), false, 'nor is the summary a test');
    eq(names.length, new Set(names).size, 'the listing is de-duplicated');

    // Interaction 2 - the same predicate at its boundary, one line at a time.
    const rejected = [
      'The following Tests are available:',
      'Build succeeded.',
      'Determining projects to restore...',
      'JustAnIdentifierNoDot',
      'Ns.Class.Param(x: 1)',
      'at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs',
      'Proj -> C:\\out\\Proj.dll',
      '',
      '   ',
    ];
    for (const line of rejected) {
      eq(isDiscoveredTestLine(line), false, JSON.stringify(line) + ' is never a test name');
    }
    for (const line of [
      'Cs.Xunit.Fixtures.CalculatorTests.Adds_TwoNumbers',
      'Fs.Xunit.Fixtures.adds two numbers with spaces',
      'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)',
      'Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers',
      'Cs.Mstest.Fixtures.CalculatorTests.Adds_Row',
    ]) {
      eq(isDiscoveredTestLine(line), true, line + ' is a shape the spec table requires');
    }

    // Interaction 3 - the announced assemblies, and the MSBuild `%XX` escaping
    // a Windows path under "Program Files (x86)" really carries. Dropping the
    // decode skips the fully-qualified pass and silently loses every NUnit
    // test, every MSTest test and every theory.
    const announced = parseAnnouncedAssemblies(listing);
    eq(announced.length, 2, 'one banner per built test assembly');
    eq(
      announced.includes('/w/bin/Debug/net10.0/Fs.Xunit.Fixtures.dll'),
      true,
      'and the F# assembly is announced as well as the C# one',
    );
    const escaped = 'C:\\Program Files %28x86%29\\App\\bin\\Debug\\net10.0\\Cs.Xunit.Fixtures.dll';
    eq(
      unescapeMsBuildPath(escaped),
      'C:\\Program Files (x86)\\App\\bin\\Debug\\net10.0\\Cs.Xunit.Fixtures.dll',
      'MSBuild reserves ( and ) and encodes them as %28/%29; the path must be decoded',
    );
    eq(unescapeMsBuildPath('%25'), '%', 'a literal percent is itself escaped as %25');
    eq(
      unescapeMsBuildPath('/plain/path/App.dll'),
      '/plain/path/App.dll',
      'a path with nothing reserved in it is returned untouched',
    );
    eq(
      resolveAnnouncedAssembly('/nowhere/that/exists/Ghost.dll'),
      undefined,
      'an announced assembly that is not on disk resolves to nothing, and must not throw',
    );
  });

  // Implements [TEST-DISCOVERY-FQN]: assemblies are batched under the Windows
  // 32 767-character command-line ceiling, and a MULTI-TARGETED project
  // collapses to ONE group whose names are the UNION of the frameworks'.
  test('assembly batching stays under the command-line ceiling and multi-targets merge', async function () {
    this.timeout(FAST_MS);

    // Interaction 1 - a solution with dozens of test projects. Handing them all
    // to one `dotnet vstest` fails to SPAWN instead of enumerating, so the
    // batcher must split - but never a batch that is empty or reordered.
    const many = Array.from({ length: 40 }, (_, index) => {
      return '/w/very/long/output/path/segment/Project' + String(index) + '/bin/Debug/Tests.dll';
    });
    const batches = batchAssemblies(many, 400);
    eq(batches.length > 1, true, 'forty long paths cannot fit one 400-character command line');
    deepEq(batches.flat(), many, 'every assembly appears exactly once, in listing order');
    for (const batch of batches) {
      eq(batch.length >= 1, true, 'an empty batch would spawn vstest with no assembly');
      eq(batch.join(' ').length <= 400 + 3, true, 'each batch stays inside the ceiling');
    }
    deepEq(batchAssemblies([], 400), [], 'nothing to enumerate is no invocation at all');
    deepEq(
      batchAssemblies(['/w/a.dll'], 400),
      [['/w/a.dll']],
      'one assembly is one batch, never two',
    );
    const single = batchAssemblies([many[0] ?? '', many[1] ?? ''], 10);
    eq(
      single.length,
      2,
      'a path longer than the whole ceiling still goes out alone rather than being dropped',
    );

    // Interaction 2 - the same project built for two frameworks. Left apart,
    // every namespace, class and test renders TWICE under two labels the user
    // cannot tell apart.
    const merged = mergeMultiTargeted([
      {
        name: 'Cs.Multi.Fixtures',
        path: '/w/bin/Debug/net9.0/Cs.Multi.Fixtures.dll',
        names: ['Ns.C.Shared', 'Ns.C.Only_On_NET9_0'],
      },
      {
        name: 'Cs.Multi.Fixtures',
        path: '/w/bin/Debug/net10.0/Cs.Multi.Fixtures.dll',
        names: ['Ns.C.Shared', 'Ns.C.Only_On_NET10_0'],
      },
    ]);
    eq(merged.length, 1, 'two banners for one project collapse to ONE assembly group');
    const group = requireAt(merged, 0, 'the merged group');
    eq(group.name, 'Cs.Multi.Fixtures', 'under the project name the user recognises');
    deepEq(
      [...group.names].sort(),
      ['Ns.C.Only_On_NET10_0', 'Ns.C.Only_On_NET9_0', 'Ns.C.Shared'],
      'the collapsed names are the UNION - a test behind #if exists in only one assembly, ' +
        'and taking the first framework alone would trade a duplicated tree for a missing test',
    );
    eq(
      group.names.filter((name) => name === 'Ns.C.Shared').length,
      1,
      'a test compiled into BOTH assemblies still appears exactly once',
    );

    // Interaction 3 - two genuinely different projects must NOT be merged, and
    // a single-framework project must survive the same call untouched.
    const distinct = mergeMultiTargeted([
      { name: 'Cs.Fixtures', path: '/w/a/Cs.Fixtures.dll', names: ['Ns.A.One'] },
      { name: 'Fs.Fixtures', path: '/w/b/Fs.Fixtures.dll', names: ['Ns.B.two names'] },
    ]);
    eq(distinct.length, 2, 'two different assemblies are two roots, not one');
    deepEq(
      distinct.map((entry) => entry.name).sort(),
      ['Cs.Fixtures', 'Fs.Fixtures'],
      'each keeps its own label, C# and F# alike',
    );
    deepEq(mergeMultiTargeted([]), [], 'no assemblies is no tree, and never a throw');
    const lone = mergeMultiTargeted([
      { name: 'Solo', path: '/w/Solo.dll', names: ['Ns.S.a test with spaces'] },
    ]);
    deepEq(
      requireAt(lone, 0, 'the lone group').names,
      ['Ns.S.a test with spaces'],
      'and a single-framework project passes through with its F# spaces intact',
    );
  });

  // Implements [TEST-COVERAGE]: "one Cobertura report per test project, each in
  // its own run-id folder one level down, and EVERY one of them is parsed ...
  // taking only the first drops every other project's coverage, and which one
  // is 'first' is directory order".
  test('every Cobertura report one level down is found and merged, not just the first', async function () {
    this.timeout(FAST_MS);
    const resultsDir = path.join(tmpDir, 'multi-coverage');

    // Interaction 1 - the empty cases, which must answer rather than throw.
    deepEq(findCoberturaFiles(resultsDir), [], 'a results directory that does not exist is empty');
    fs.mkdirSync(resultsDir, { recursive: true });
    deepEq(findCoberturaFiles(resultsDir), [], 'and so is one the collector never wrote to');
    eq(findCoberturaFile(resultsDir), undefined, 'the single-report reader agrees');
    deepEq(mergeCoberturaReports([]), [], 'merging no reports yields no coverage');

    // Interaction 2 - TWO test projects, each covering a DIFFERENT library file.
    // This is the case a first-only reader cannot be told apart from a correct
    // one when the fixture has a single test project.
    const alpha = plantReport(resultsDir, 'run-alpha', coberturaFor('/src/Alpha.cs', [3, 0, 1]));
    const beta = plantReport(resultsDir, 'run-beta', coberturaFor('/src/Beta.cs', [0, 0, 7, 2]));
    const found = findCoberturaFiles(resultsDir);
    eq(found.length, 2, 'one report per test project, and BOTH must be found');
    eq(found.includes(alpha), true, 'the first project report is in the list');
    eq(found.includes(beta), true, 'and so is the second - directory order decides neither');
    neq(
      findCoberturaFile(resultsDir),
      undefined,
      'the single-report reader still answers, but it is only ever a subset',
    );

    const merged = mergeCoberturaReports(found);
    const files = merged.map((entry) => entry.uri.fsPath).sort();
    eq(merged.length, 2, 'two reports over two files produce two FileCoverage entries');
    eq(
      files.some((file) => file.endsWith('Alpha.cs')),
      true,
      'the first project file is covered',
    );
    eq(
      files.some((file) => file.endsWith('Beta.cs')),
      true,
      'and so is the second - attaching only reports[0] paints it as dead code',
    );

    // Interaction 3 - the per-file totals must survive the merge, and depth
    // must stay at ONE level: the collector writes `<run-id>/coverage.cobertura.xml`
    // and nothing deeper.
    const alphaCoverage = merged.find((entry) => entry.uri.fsPath.endsWith('Alpha.cs'));
    assert.ok(alphaCoverage, 'Alpha.cs must appear in the merged coverage');
    eq(alphaCoverage.statementCoverage.total, 3, 'Alpha.cs declares three lines');
    eq(alphaCoverage.statementCoverage.covered, 2, 'two of them were executed');
    const betaCoverage = merged.find((entry) => entry.uri.fsPath.endsWith('Beta.cs'));
    assert.ok(betaCoverage, 'Beta.cs must appear too');
    eq(betaCoverage.statementCoverage.total, 4, 'Beta.cs declares four lines');
    eq(betaCoverage.statementCoverage.covered, 2, 'two of them were executed');

    const deepDir = path.join(resultsDir, 'run-gamma', 'nested');
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepDir, 'coverage.cobertura.xml'),
      coberturaFor('/src/Gamma.cs', [1]),
      'utf8',
    );
    eq(
      findCoberturaFiles(resultsDir).length,
      2,
      'the collector writes exactly one level down, so a deeper file is not a run report',
    );
  });

  // Implements [TEST-COVERAGE]: a coverage read must survive whatever the
  // collector wrote - "a solution of nothing but test projects yields a valid,
  // EMPTY report", and a report the run never finished must not take the run
  // down with it.
  test('the Cobertura reader survives empty, multi-class and malformed reports', async function () {
    this.timeout(FAST_MS);
    const dir = path.join(tmpDir, 'cobertura-shapes');
    fs.mkdirSync(dir, { recursive: true });

    // Interaction 1 - several classes in one report, which is one test project
    // exercising several library files.
    const multi = path.join(dir, 'multi.cobertura.xml');
    fs.writeFileSync(
      multi,
      '<?xml version="1.0"?><coverage><packages><package><classes>' +
        '<class filename="/src/One.cs"><lines><line number="1" hits="1"/></lines></class>' +
        '<class filename="/src/Two.cs"><lines>' +
        '<line number="4" hits="0"/><line number="5" hits="9"/></lines></class>' +
        '</classes></package></packages></coverage>',
      'utf8',
    );
    const parsed = parseCoberturaXml(multi);
    eq(parsed.length, 2, 'one FileCoverage per class element');
    const one = requireAt(parsed, 0, 'the first class');
    const two = requireAt(parsed, 1, 'the second class');
    eq(one.statementCoverage.total, 1, 'One.cs declares a single line');
    eq(one.statementCoverage.covered, 1, 'and it ran');
    eq(two.statementCoverage.total, 2, 'Two.cs declares two');
    eq(two.statementCoverage.covered, 1, 'of which one ran');
    eq(one.uri.scheme, 'file', 'a FileCoverage always addresses a file on disk');
    neq(one.uri.toString(), two.uri.toString(), 'and the two classes are two different files');

    // Interaction 2 - the valid-but-empty report [TEST-COVERAGE] names: a run
    // that loaded no library assembly reports nothing, and that is not an error.
    const empty = path.join(dir, 'empty.cobertura.xml');
    fs.writeFileSync(
      empty,
      '<?xml version="1.0"?><coverage><packages></packages></coverage>',
      'utf8',
    );
    deepEq(parseCoberturaXml(empty), [], 'no packages is no coverage, and never a throw');
    const noLines = path.join(dir, 'nolines.cobertura.xml');
    fs.writeFileSync(
      noLines,
      '<?xml version="1.0"?><coverage><packages><package><classes>' +
        '<class filename="/src/Bare.cs"><lines></lines></class>' +
        '</classes></package></packages></coverage>',
      'utf8',
    );
    const bare = parseCoberturaXml(noLines);
    eq(bare.length, 1, 'a class with no executable line is still a file the run loaded');
    eq(requireAt(bare, 0, 'the bare class').statementCoverage.total, 0, 'with nothing to cover');
    eq(requireAt(bare, 0, 'the bare class').statementCoverage.covered, 0, 'and nothing covered');

    // Interaction 3 - a report truncated mid-write (the run was cancelled) and
    // a path that is not a file at all. Coverage is a REPORTING step: it must
    // never be the thing that fails a run whose tests all passed.
    const truncated = path.join(dir, 'truncated.cobertura.xml');
    fs.writeFileSync(truncated, '<?xml version="1.0"?><coverage><packages><package>', 'utf8');
    assert.doesNotThrow(
      () => parseCoberturaXml(truncated),
      'a report truncated by a cancelled run must not throw out of the reporting step',
    );
    assert.doesNotThrow(
      () => parseCoberturaXml(path.join(dir, 'does-not-exist.xml')),
      'nor must a report the collector never wrote',
    );
    deepEq(
      parseCoberturaXml(path.join(dir, 'does-not-exist.xml')),
      [],
      'a missing report is no coverage, reported as such',
    );
    deepEq(
      mergeCoberturaReports([empty, multi]),
      parseCoberturaXml(multi),
      'merging an empty report with a populated one keeps exactly the populated one',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Status Lens — live CodeLens provider over real C#/F# files
// ─────────────────────────────────────────────────────────────────────────────

suite('Test status lens e2e — CodeLens provider and toggle', () => {
  let tmpDir: string;
  let stubs: UiStubs;

  suiteSetup(async function () {
    // A cold sidecar, not just activation: the warm-up below is the FIRST
    // `textDocument/codeLens` this process sends for each language, so this hook
    // pays both engines' project-cracking cost. `SIDECAR_COLD_MS` is the tier
    // written for exactly that, and it is the larger of the two costs this hook
    // carries.
    this.timeout(SIDECAR_COLD_MS);
    ({ tmpDir } = await setupLspTestSuite('test-lens-e2e-'));

    // Every test below asks VS Code for the lenses on a C# or F# file, and that
    // request FANS OUT to the LSP client's server-backed provider as well as
    // this extension's own (see `code-lens-kit.ts`). Paying each sidecar's cold
    // start HERE is what makes `LSP_RESPONSE_MS` — "one semantic request
    // answered by a WARM sidecar" — an honest ceiling for the tests that
    // follow. Left in a test body it is a cold start measured against a warm
    // budget, which is the flake this suite hit on the Windows runner.
    const warmCSharp = await openCSharpFile(tmpDir, 'Warmup.cs', CSHARP_TESTS);
    const warmFSharp = await openFSharpFile(tmpDir, 'Warmup.fs', FSHARP_TESTS);
    await warmCodeLensPath(warmCSharp.uri, warmFSharp.uri);
    await closeAllEditors();
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
    // `codeLensesFor` awaits the LSP client's server-backed provider too, so
    // this is a SEMANTIC request, not the editor round trip `COMMAND_MS` names.
    this.timeout(LSP_RESPONSE_MS);
    const { uri } = await openCSharpFile(tmpDir, 'LensTargets.cs', CSHARP_TESTS);

    const all = await codeLensesFor(uri);
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
    assert.ok(runTargets.includes('Lens_AddsTwoNumbers'));
    assert.ok(runTargets.includes('Lens_AddsTheory'));
    assert.ok(!runTargets.includes('NotATest'), 'plain methods get no test lens');

    // The Run lens title matches the rendered "play" action.
    const firstRun = runLenses[0];
    assert.ok(firstRun !== undefined);
    assert.strictEqual(firstRun.command?.title, '$(play) Run Test');
    assert.strictEqual(firstRun.command?.arguments?.[0]?.toString(), uri.toString());

    // Interaction 2 — the DEBUG half of [TEST-STATUS-LENS]'s "plus Run and Debug
    // actions". A Debug lens that reached the wrong method, or carried no
    // method at all, is how "Debug Test does nothing" presents to the user.
    const debugTargets = debugLenses
      .map((lens) => lens.command?.arguments?.[1])
      .filter((name): name is string => typeof name === 'string');
    assert.deepStrictEqual(
      [...debugTargets].sort(),
      [...runTargets].sort(),
      'every method offering Run must offer Debug, and for the SAME method name',
    );
    assert.deepStrictEqual(
      [...new Set(debugLenses.map((lens) => lens.command?.title))],
      ['$(bug) Debug Test'],
      'and every one of them renders as the Debug action',
    );
    assert.deepStrictEqual(
      debugLenses.filter((lens) => lens.command?.arguments?.length !== 2),
      [],
      'the at-cursor command takes (uri, methodName) — a missing argument makes it a no-op',
    );
    assert.deepStrictEqual(
      [...new Set(debugLenses.map((lens) => lens.command?.arguments?.[0]?.toString() ?? ''))],
      [uri.toString()],
      'and every Debug lens points at the file the user is looking at',
    );

    // Interaction 3 — the pair sits on ONE method: Run and Debug for a given
    // method share the range, so the user sees them side by side above it.
    for (const target of runTargets) {
      const run = runLenses.find((lens) => lens.command?.arguments?.[1] === target);
      const debug = debugLenses.find((lens) => lens.command?.arguments?.[1] === target);
      assert.ok(run && debug, `${target} must have both a Run and a Debug lens`);
      assert.strictEqual(
        run.range.isEqual(debug.range),
        true,
        `${target}: the Run and Debug actions must render on the same line`,
      );
      assert.strictEqual(
        runLenses.filter((lens) => lens.command?.arguments?.[1] === target).length,
        1,
        `${target}: one Run lens, not one per attribute`,
      );
      assert.strictEqual(
        debugLenses.filter((lens) => lens.command?.arguments?.[1] === target).length,
        1,
        `${target}: one Debug lens either`,
      );
    }
  });

  test('an F# test file exposes Run + Debug lenses for [<Fact>]/[<Theory>] bindings', async function () {
    // As above, and F# is the slower of the two engines: measured at 1967ms
    // cold against 96ms for a warm C# call in the same process.
    this.timeout(LSP_RESPONSE_MS);
    const { uri } = await openFSharpFile(tmpDir, 'LensTargets.fs', FSHARP_TESTS);

    const lenses = testLensCommands(await codeLensesFor(uri));
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

    // Interaction 2 — F# is not a second-class case here ([TEST-OVERVIEW]): the
    // Debug action must reach every binding the Run action does, addressed by
    // the same name, and carrying the same (uri, methodName) pair.
    const fsDebug = lenses.filter((l) => l.command?.command === CMD_TEST_DEBUG_AT_CURSOR);
    const fsDebugTargets = fsDebug
      .map((lens) => lens.command?.arguments?.[1])
      .filter((name): name is string => typeof name === 'string');
    assert.deepStrictEqual(
      [...fsDebugTargets].sort(),
      [...runTargets].sort(),
      'every F# binding offering Run offers Debug, for the same binding',
    );
    assert.strictEqual(
      fsDebugTargets.includes('addsTwoNumbers'),
      true,
      'the [<Fact>] binding is a DEBUG target too, not only a run target',
    );
    assert.deepStrictEqual(
      [...new Set(fsDebug.map((lens) => lens.command?.title))],
      ['$(bug) Debug Test'],
      'and it renders as the Debug action above the binding',
    );
    assert.deepStrictEqual(
      [...new Set(fsDebug.map((lens) => lens.command?.arguments?.[0]?.toString() ?? ''))],
      [uri.toString()],
      'pointing at the .fs file the user has open',
    );

    // Interaction 3 — no lens targets a name the F# file does not declare: a
    // lens over the wrong binding runs the wrong test.
    for (const target of [...runTargets, ...fsDebugTargets]) {
      assert.strictEqual(
        FSHARP_TESTS.includes(target),
        true,
        `${target} must be a binding this fixture actually declares`,
      );
    }

    // Interaction 4 - one Run lens and one Debug lens PER BINDING. Two lenses
    // over the same `let` render two identical buttons, and the user cannot
    // tell which of them is about to run.
    for (const target of runTargets) {
      assert.strictEqual(
        runTargets.filter((name) => name === target).length,
        1,
        `${target}: one Run lens, not one per attribute`,
      );
      assert.strictEqual(
        fsDebugTargets.filter((name) => name === target).length,
        1,
        `${target}: one Debug lens either`,
      );
    }

    // Interaction 5 - every lens is anchored inside the file, and the Run
    // lenses render as the Run action. A lens with no title renders a blank
    // clickable line above the binding.
    const document = await vscode.workspace.openTextDocument(uri);
    for (const lens of lenses) {
      assert.ok(
        lens.range.end.line < document.lineCount,
        `a lens at line ${lens.range.start.line} must sit inside the file`,
      );
      assert.ok((lens.command?.title ?? '').length > 0, 'and carry a visible title');
    }
    assert.deepStrictEqual(
      [
        ...new Set(
          lenses
            .filter((lens) => lens.command?.command === CMD_TEST_RUN_AT_CURSOR)
            .map((lens) => lens.command?.title),
        ),
      ],
      ['$(play) Run Test'],
      'and the Run half renders as the Run action',
    );
  });

  test('disabling sharplsp.testLens.enabled removes the test lenses; re-enabling restores them', async function () {
    // FOUR scoped configuration writes AND four semantic lens round trips.
    // `SETTINGS_WRITE_MS` is the tier for repeated settings writes and is the
    // larger of the two costs; `COMMAND_MS` covered neither.
    this.timeout(SETTINGS_WRITE_MS);
    const { uri } = await openCSharpFile(tmpDir, 'Toggle.cs', CSHARP_TESTS);

    const cfg = vscode.workspace.getConfiguration(TEST_LENS_SECTION);
    const savedWorkspaceValue = cfg.inspect<boolean>(TEST_LENS_KEY)?.workspaceValue;

    try {
      // Baseline: lenses present while enabled (default true).
      await cfg.update(TEST_LENS_KEY, true, vscode.ConfigurationTarget.Workspace);
      const enabledLenses = testLensCommands(await codeLensesFor(uri));
      assert.ok(enabledLenses.length >= 2, 'lenses present while enabled');

      // Disable → the provider returns an empty array, so no test lenses remain.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, false, vscode.ConfigurationTarget.Workspace);
      const disabledLenses = testLensCommands(await codeLensesFor(uri));
      assert.strictEqual(disabledLenses.length, 0, 'disabling testLens removes the lenses');

      // Re-enable → lenses come back.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, true, vscode.ConfigurationTarget.Workspace);
      const reEnabledLenses = testLensCommands(await codeLensesFor(uri));
      assert.ok(reEnabledLenses.length >= 2, 're-enabling restores the lenses');

      // Interaction 4 - the setting really flipped at each step, so the lens
      // counts above are a statement about the provider and not about a write
      // that never landed.
      const read = () =>
        vscode.workspace.getConfiguration(TEST_LENS_SECTION).get<boolean>(TEST_LENS_KEY);
      assert.strictEqual(read(), true, 'the setting reads back as enabled');
      assert.strictEqual(
        vscode.workspace.getConfiguration(TEST_LENS_SECTION).inspect<boolean>(TEST_LENS_KEY)
          ?.workspaceValue,
        true,
        'and is recorded at the workspace scope it was written to',
      );

      // Interaction 5 - restoring is EXACT, not approximate. The re-enabled
      // set must name the same targets as the baseline, or "restored" means
      // "some lenses came back".
      assert.deepStrictEqual(
        reEnabledLenses.map((lens) => lens.command?.arguments?.[1]).sort(),
        enabledLenses.map((lens) => lens.command?.arguments?.[1]).sort(),
        'the restored lenses target exactly the baseline methods',
      );
      assert.strictEqual(
        reEnabledLenses.length,
        enabledLenses.length,
        'and there are exactly as many of them',
      );

      // Interaction 6 - disabling removes the TEST lenses only. The setting is
      // scoped to the test lens; taking the reference-count lenses with it
      // would make one toggle silently disable an unrelated feature.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, false, vscode.ConfigurationTarget.Workspace);
      const allWhileDisabled = await codeLensesFor(uri);
      assert.strictEqual(
        testLensCommands(allWhileDisabled).length,
        0,
        'no test lens survives the disable',
      );
      assert.strictEqual(read(), false, 'and the setting reads back as disabled');
      assert.ok(
        Array.isArray(allWhileDisabled),
        'the provider still answers while disabled, with an empty test-lens set',
      );
      assert.strictEqual(
        allWhileDisabled.every((lens) => lens.command?.command !== CMD_TEST_RUN_AT_CURSOR),
        true,
        'and no Run-Test lens is among whatever it did return',
      );
    } finally {
      // Restore the exact prior workspace value (undefined when unset) so the
      // key is removed rather than persisted into the fixture settings.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, savedWorkspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('a non-test C# file produces no test lenses, and the signature parsers agree with discovery', async function () {
    this.timeout(LSP_RESPONSE_MS);
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
    const lenses = testLensCommands(await codeLensesFor(uri));
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
    this.timeout(FAST_MS);
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

    // Interaction 2 - the BOUNDARY is exact and one-sided. 999ms must stay in
    // milliseconds and 1000ms must become seconds; an off-by-one there prints
    // "(1000ms)" on one run and "(1.0s)" on the next for the same test.
    assert.strictEqual(formatDuration(998), ' (998ms)', 'just below the boundary');
    assert.strictEqual(formatDuration(1001), ' (1.0s)', 'just above it');
    assert.strictEqual(
      formatDuration(999).includes('s)') && !formatDuration(999).includes('ms)'),
      false,
      '999ms must not be rendered as seconds',
    );

    // Interaction 3 - seconds carry ONE decimal place, always. A bare "1s" and
    // a "1.53333s" in the same column make the lens unreadable at a glance
    // ([TEST-STATUS-LENS] fixes the suffix shape).
    for (const [milliseconds, expected] of [
      [1000, ' (1.0s)'],
      [1050, ' (1.1s)'],
      [2500, ' (2.5s)'],
      [12_300, ' (12.3s)'],
    ] as const) {
      assert.strictEqual(
        formatDuration(milliseconds),
        expected,
        `${milliseconds}ms renders as ${expected}`,
      );
    }

    // Interaction 4 - a missing duration renders NOTHING, so the title is
    // "$(pass) Passed" with no dangling parenthesis. An undiscovered duration
    // is not a zero-length run.
    assert.strictEqual(formatDuration(undefined), '', 'no duration, no suffix');
    assert.strictEqual(`$(pass) Passed${formatDuration(undefined)}`, '$(pass) Passed');
    assert.notStrictEqual(
      formatDuration(undefined),
      formatDuration(0),
      'and it is not the same as 0ms',
    );
  });

  // Implements [TEST-STATUS-LENS] verbatim: "The status title reflects the
  // Testing API's three states: `$(pass) Passed (<duration>)`,
  // `$(debug-step-over) Skipped`, `$(circle-slash) Not run`, and
  // `$(error) Failed: <assertion text>`."
  test('the status title renders each of the four states with the spec icon', async function () {
    this.timeout(FAST_MS);

    // Interaction 1 - a pass, with and without a duration. The icon is what the
    // user reads at a glance; a wrong one makes a green run look red.
    eq(
      statusLensTitle(cached({ outcome: 'passed', duration: 1500 })),
      '$(pass) Passed (1.5s)',
      'a pass over a second renders in seconds to one decimal',
    );
    eq(
      statusLensTitle(cached({ outcome: 'passed', duration: 42 })),
      '$(pass) Passed (42ms)',
      'and under a second in whole milliseconds',
    );
    eq(
      statusLensTitle(cached({ outcome: 'passed', duration: 0 })),
      '$(pass) Passed (0ms)',
      'a zero duration is a real measurement, not a missing one',
    );
    eq(
      statusLensTitle(cached({ outcome: 'passed' })),
      '$(pass) Passed',
      'a pass with no recorded duration still says Passed, with no empty brackets',
    );

    // Interaction 2 - the two states that are NOT failures. [TEST-RUN-TRX] is
    // explicit that "a skipped test MUST NOT be reported as a failure", and a
    // never-run test is not a result at all.
    const skipped = statusLensTitle(cached({ outcome: 'skipped' }));
    eq(skipped, '$(debug-step-over) Skipped', 'a skip renders as the step-over icon');
    eq(skipped.includes('$(error)'), false, 'and never as an error');
    eq(skipped.includes('$(pass)'), false, 'nor as a pass');
    const notRun = statusLensTitle(cached({ outcome: 'notRun' }));
    eq(notRun, '$(circle-slash) Not run', 'a test that has never run says so');
    eq(notRun.includes('$(error)'), false, 'a test nobody ran has not failed');
    eq(
      statusLensTitle(cached({ outcome: 'skipped', duration: 12 })),
      '$(debug-step-over) Skipped',
      'a skip carries no duration - it never executed, so there is nothing to time',
    );

    // Interaction 3 - a failure must carry the ASSERTION TEXT. [TEST-RUN-TRX]:
    // "the assertion text and stack trace come from the TRX ErrorInfo, so a
    // failure shows what actually went wrong instead of a generic 'Test failed'".
    const message = 'Assert.Equal() Failure: Values differ';
    const failed = statusLensTitle(cached({ outcome: 'failed', message }));
    eq(failed.startsWith('$(error) Failed:'), true, 'a failure renders as the error icon');
    eq(failed.includes(message), true, 'and shows the assertion the test actually tripped on');
    eq(failed.includes('\n'), false, 'a CodeLens title is ONE line; a newline mangles the lens');
    const multiline = statusLensTitle(
      cached({ outcome: 'failed', message: message + '\nExpected: 4\nActual: 5' }),
    );
    eq(multiline.startsWith('$(error) Failed:'), true, 'a multi-line assertion still renders');
    eq(multiline.includes('\n'), false, 'flattened onto the single line a lens can show');
    eq(
      statusLensTitle(cached({ outcome: 'failed' })).startsWith('$(error) Failed'),
      true,
      'a failure with no ErrorInfo at all still reads as a failure',
    );
    const titles = [statusLensTitle(cached({ outcome: 'passed' })), skipped, notRun, failed];
    eq(new Set(titles).size, 4, 'the four states are four distinct titles the user can tell apart');
    for (const title of titles) {
      eq(title.startsWith('$('), true, 'every status title leads with its icon');
    }
  });

  // Implements [TEST-STATUS-LENS] ("above every C# and F# test method") and
  // [TEST-OVERVIEW] ("It supports xUnit, NUnit, MSTest, Expecto and FsCheck").
  test('every framework attribute gets a lens pair, and no helper or property does', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { uri } = await openCSharpFile(tmpDir, 'Frameworks.cs', FRAMEWORK_TESTS);

    // Interaction 1 - a Run action above every attributed method, whichever
    // framework's attribute it carries. A framework that gets no lens is a
    // framework whose users have no Run Test button.
    const lenses = testLensCommands(await codeLensesFor(uri));
    const runLenses = lenses.filter((lens) => lens.command?.command === CMD_TEST_RUN_AT_CURSOR);
    const debugLenses = lenses.filter((lens) => lens.command?.command === CMD_TEST_DEBUG_AT_CURSOR);
    const runTargets = runLenses
      .map((lens) => lens.command?.arguments?.[1])
      .filter((name): name is string => typeof name === 'string');
    for (const method of FRAMEWORK_TEST_METHODS) {
      eq(runTargets.includes(method), true, method + ' must be offered a Run action');
      eq(
        runTargets.filter((name) => name === method).length,
        1,
        method + ': ONE lens, not one per attribute - [DataRow] plus [DataTestMethod] is two',
      );
    }
    eq(
      runLenses.length,
      FRAMEWORK_TEST_METHODS.length,
      'exactly one Run lens per attributed method, and none over anything else',
    );

    // Interaction 2 - and nothing over a helper, a property or a plain public
    // method. A lens there runs a "test" the adapter has never heard of.
    for (const member of FRAMEWORK_NON_TESTS) {
      eq(runTargets.includes(member), false, member + ' is not a test and gets no Run action');
      eq(
        debugLenses.some((lens) => lens.command?.arguments?.[1] === member),
        false,
        member + ' gets no Debug action either',
      );
    }

    // Interaction 3 - Run and Debug are PAIRED on the same line for every one
    // of them, which is what [TEST-STATUS-LENS] means by "plus Run and Debug
    // actions".
    eq(debugLenses.length, runLenses.length, 'the two actions are paired, one for one');
    deepEq(
      [...new Set(debugLenses.map((lens) => lens.command?.title))],
      ['$(bug) Debug Test'],
      'every Debug action renders as the Debug lens',
    );
    deepEq(
      [...new Set(runLenses.map((lens) => lens.command?.title))],
      ['$(play) Run Test'],
      'and every Run action as the Run lens',
    );
    for (const method of FRAMEWORK_TEST_METHODS) {
      const run = runLenses.find((lens) => lens.command?.arguments?.[1] === method);
      const debug = debugLenses.find((lens) => lens.command?.arguments?.[1] === method);
      assert.ok(run && debug, method + ' must carry both actions');
      eq(run.range.isEqual(debug.range), true, method + ': both actions render on the same line');
      eq(
        run.command?.arguments?.[0]?.toString(),
        uri.toString(),
        method + ': the Run action points at the file the user has open',
      );
      eq(
        debug.command?.arguments?.length,
        2,
        method + ': the at-cursor command takes (uri, methodName) - a short call is a no-op',
      );
    }
  });

  // The project's HARD RULE: "All screens MUST BE 100% reactive. If underlying
  // data changes, the screen must be listening and update accordingly."
  // A lens list computed once is a Run button over a method the user deleted.
  test('editing the document adds and removes lenses without a reload', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri } = await openCSharpFile(tmpDir, 'Reactive.cs', CSHARP_TESTS);

    // Interaction 1 - the baseline the fixture declares.
    const before = testLensCommands(await codeLensesFor(uri))
      .filter((lens) => lens.command?.command === CMD_TEST_RUN_AT_CURSOR)
      .map((lens) => lens.command?.arguments?.[1])
      .filter((name): name is string => typeof name === 'string');
    deepEq(
      [...before].sort(),
      ['Lens_AddsTheory', 'Lens_AddsTwoNumbers'],
      'the fixture declares exactly two test methods',
    );
    eq(before.includes('NotATest'), false, 'and one plain method, which gets no lens');

    // Interaction 2 - the user ADDS a test method. The new lens must appear
    // against the edited buffer, with no save and no window reload.
    const withExtra = doc
      .getText()
      .replace(
        '        public void NotATest()',
        '        [Fact]\n        public void Lens_AddedLater()\n        {\n        }\n\n' +
          '        public void NotATest()',
      );
    eq(await replaceDocumentContent(doc, withExtra), true, 'the edit must apply');
    const afterAdd = testLensCommands(await codeLensesFor(uri))
      .filter((lens) => lens.command?.command === CMD_TEST_RUN_AT_CURSOR)
      .map((lens) => lens.command?.arguments?.[1])
      .filter((name): name is string => typeof name === 'string');
    eq(
      afterAdd.includes('Lens_AddedLater'),
      true,
      'a test method typed into the open buffer gets its lens immediately',
    );
    eq(afterAdd.length, before.length + 1, 'and exactly one new lens, not a duplicated set');
    eq(afterAdd.includes('Lens_AddsTwoNumbers'), true, 'the existing lenses survive the edit');
    eq(afterAdd.includes('NotATest'), false, 'the plain method still gets none');

    // Interaction 3 - the user REMOVES every test. A lens left behind runs a
    // method that no longer exists.
    eq(
      await replaceDocumentContent(
        doc,
        [
          'namespace Sample.Tests',
          '{',
          '    public class CalculatorTests',
          '    {',
          '    }',
          '}',
          '',
        ].join('\n'),
      ),
      true,
      'the second edit must apply too',
    );
    const afterRemove = testLensCommands(await codeLensesFor(uri));
    deepEq(afterRemove, [], 'a file with no test method carries no test lens at all');
    eq(doc.isDirty, true, 'and all of this happened in the buffer, with nothing written to disk');
  });

  // Implements [TEST-STATUS-LENS]: "`sharplsp.testLens.enabled` (default true)".
  // The setting governs BOTH languages - F# is not a second-class case
  // ([TEST-OVERVIEW]) - and turning it off must remove the actions as well as
  // the status.
  test('the enable setting governs the lens in C# and F# alike, and restores cleanly', async function () {
    this.timeout(SETTINGS_WRITE_MS);
    const csharp = await openCSharpFile(tmpDir, 'ToggleBoth.cs', CSHARP_TESTS);
    const fsharp = await openFSharpFile(tmpDir, 'ToggleBoth.fs', FSHARP_TESTS);

    const section = vscode.workspace.getConfiguration(TEST_LENS_SECTION);
    const saved = section.inspect<boolean>(TEST_LENS_KEY)?.workspaceValue;
    try {
      // Interaction 1 - the default. Both languages carry lenses before the
      // user has touched the setting at all.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, true, vscode.ConfigurationTarget.Workspace);
      const csOn = testLensCommands(await codeLensesFor(csharp.uri));
      const fsOn = testLensCommands(await codeLensesFor(fsharp.uri));
      eq(csOn.length >= 4, true, 'C# carries a Run and a Debug lens per test method');
      eq(fsOn.length >= 4, true, 'and F# carries them for its [<Fact>] and [<Theory>] bindings');
      eq(
        fsOn.some((lens) => lens.command?.command === CMD_TEST_DEBUG_AT_CURSOR),
        true,
        'F# gets the Debug action too - it is not a second-class case',
      );
      eq(
        vscode.workspace.getConfiguration(TEST_LENS_SECTION).get<boolean>(TEST_LENS_KEY),
        true,
        'and the setting reads back as the user left it',
      );

      // Interaction 2 - switch it off. BOTH languages must go quiet, and the
      // status half must go with the actions: a lens showing a stale "Passed"
      // over a file whose lenses the user disabled is the worst of both.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, false, vscode.ConfigurationTarget.Workspace);
      const csOff = await codeLensesFor(csharp.uri);
      const fsOff = await codeLensesFor(fsharp.uri);
      deepEq(testLensCommands(csOff), [], 'no C# test lens survives the setting being off');
      deepEq(testLensCommands(fsOff), [], 'and no F# one either');
      deepEq(
        csOff.filter((lens) => (lens.command?.title ?? '').startsWith('$(circle-slash)')),
        [],
        'nor a status lens - the setting governs the whole contribution',
      );
      deepEq(
        fsOff.filter((lens) => (lens.command?.title ?? '').startsWith('$(circle-slash)')),
        [],
        'in F# as in C#',
      );

      // Interaction 3 - switch it back on. What comes back must be what left,
      // for both languages, addressed by the same names.
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, true, vscode.ConfigurationTarget.Workspace);
      const csBack = testLensCommands(await codeLensesFor(csharp.uri));
      const fsBack = testLensCommands(await codeLensesFor(fsharp.uri));
      eq(csBack.length, csOn.length, 're-enabling restores exactly the C# lenses that were there');
      eq(fsBack.length, fsOn.length, 'and exactly the F# ones');
      deepEq(
        csBack
          .map((lens) => lens.command?.arguments?.[1])
          .filter((name): name is string => typeof name === 'string')
          .sort(),
        csOn
          .map((lens) => lens.command?.arguments?.[1])
          .filter((name): name is string => typeof name === 'string')
          .sort(),
        'addressing the same C# methods by the same names',
      );
      deepEq(
        fsBack
          .map((lens) => lens.command?.arguments?.[1])
          .filter((name): name is string => typeof name === 'string')
          .sort(),
        fsOn
          .map((lens) => lens.command?.arguments?.[1])
          .filter((name): name is string => typeof name === 'string')
          .sort(),
        'and the same F# bindings',
      );
    } finally {
      await vscode.workspace
        .getConfiguration(TEST_LENS_SECTION)
        .update(TEST_LENS_KEY, saved, vscode.ConfigurationTarget.Workspace);
    }
  });

  // Implements [TEST-STATUS-LENS] - the SIGNATURE readers that decide which
  // method name a lens carries. A reader that answers the wrong name puts a Run
  // button over one test and runs another.
  test('the signature readers agree with the fixtures on every shape and near miss', async function () {
    this.timeout(FAST_MS);

    // Interaction 1 - C# signatures, including the modifiers a real test class
    // uses. Every name it returns must be a method the fixture declares.
    const csharpCases: readonly (readonly [string, string | undefined])[] = [
      ['        public void Lens_AddsTwoNumbers()', 'Lens_AddsTwoNumbers'],
      ['        public void Lens_AddsTheory(int a, int b, int expected)', 'Lens_AddsTheory'],
      ['    public async Task Runs_AsynchronouslyAsync()', 'Runs_AsynchronouslyAsync'],
      ['        internal static void Helper_Method()', 'Helper_Method'],
      ['        [Fact]', undefined],
      ['        [InlineData(2, 2, 4)]', undefined],
      ['if (x > 0)', undefined],
      ['        public int Value { get; set; }', undefined],
      ['', undefined],
      ['        // public void Commented()', undefined],
    ];
    for (const [line, expected] of csharpCases) {
      eq(
        extractCSharpMethodName(line),
        expected,
        JSON.stringify(line) + ' reads as ' + String(expected),
      );
    }
    for (const method of FRAMEWORK_TEST_METHODS) {
      eq(
        FRAMEWORK_TESTS.includes(method),
        true,
        method + ' must be a method the framework fixture really declares',
      );
    }

    // Interaction 2 - F# signatures. The backtick binding is the one that
    // matters most: its name carries SPACES, and a reader that stops at the
    // first space addresses a test that does not exist.
    const fsharpCases: readonly (readonly [string, string | undefined])[] = [
      ['let addsTheory a b expected =', 'addsTheory'],
      ['let addsTwoNumbers () =', 'addsTwoNumbers'],
      ['member this.MyTest () =', 'MyTest'],
      ['[<Fact>]', undefined],
      ['[<Theory>]', undefined],
      ['open Xunit', undefined],
      ['module Sample.FSharpTests', undefined],
      ['', undefined],
    ];
    for (const [line, expected] of fsharpCases) {
      eq(
        extractFSharpFunctionName(line),
        expected,
        JSON.stringify(line) + ' reads as ' + String(expected),
      );
    }

    // Interaction 3 - the duration suffix the status title appends, across the
    // ms/seconds boundary the spec's `(<duration>)` implies.
    eq(formatDuration(undefined), '', 'no measurement renders no suffix at all');
    eq(formatDuration(0), ' (0ms)', 'zero is a measurement');
    eq(formatDuration(1), ' (1ms)', 'and so is one millisecond');
    eq(formatDuration(999), ' (999ms)', 'the last value before the boundary stays in ms');
    eq(formatDuration(1000), ' (1.0s)', 'the boundary itself flips to seconds');
    eq(formatDuration(1500), ' (1.5s)', 'with one decimal place');
    eq(formatDuration(60000), ' (60.0s)', 'a minute is still reported in seconds, not mangled');
    eq(
      '$(pass) Passed' + formatDuration(1500),
      '$(pass) Passed (1.5s)',
      'and composes into exactly the title [TEST-STATUS-LENS] specifies',
    );
    eq(
      '$(pass) Passed' + formatDuration(undefined),
      '$(pass) Passed',
      'with no trailing space when there is nothing to report',
    );
  });
});
