// The test projects the Test Explorer suites discover and run.
//
// Every framework the extension claims to support appears twice — once in C#
// and once in F# — because the three interesting shapes of a fully-qualified
// name are framework- and language-specific:
//
//   • xUnit's DisplayName equals its FQN, so scraping `--list-tests` worked for
//     xUnit by accident and hid the bug for everything else,
//   • NUnit and MSTest render the BARE method name as the DisplayName, and an
//     NUnit `[TestCase]` FQN carries PARENTHESES that VSTest's filter grammar
//     reads as an expression unless escaped,
//   • idiomatic F# backtick bindings carry SPACES inside the FQN.
//
// Each project deliberately contains a passing, a failing and a skipped test so
// outcome attribution can be asserted per test rather than per run.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildProjectXml,
  libraryProjectXml,
  MSTEST_PACKAGES,
  NUNIT_PACKAGES,
  projectXml,
  writeProject,
  XUNIT_LEGACY_PACKAGES,
  XUNIT_PACKAGES,
  type PackageRef,
} from './dotnet-project-kit';

/** One buildable fixture project plus the names it is expected to expose. */
export interface FrameworkFixture {
  /** Stable key: `<framework>-<language>`. */
  readonly key: string;
  readonly framework: 'xunit' | 'nunit' | 'mstest';
  readonly language: 'csharp' | 'fsharp';
  readonly packages: readonly PackageRef[];
  /** Project directory name, also the project file's base name. */
  readonly projectName: string;
  readonly projectFileName: string;
  readonly sourceFileName: string;
  readonly source: string;
  /** Fully-qualified name of the test that passes. */
  readonly passing: string;
  /** Fully-qualified name of the test that fails, and its assertion text. */
  readonly failing: string;
  /** Fully-qualified name of the test that is skipped/ignored. */
  readonly skipped: string;
  /** Fully-qualified name of the data-driven test (every row passes). */
  readonly parameterized: string;
  /**
   * Fully-qualified name of a data-driven test whose rows DISAGREE — one passes,
   * one fails. Both rows report under this single name, so the merged outcome
   * must be a failure. Only the xUnit fixtures carry one.
   */
  readonly mixedParameterized?: string;
}

const CS_XUNIT_SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.Xunit.Fixtures',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, 1 + 2);',
  '        [Fact] public void Fails_OnPurpose() => Assert.Equal(4, 1 + 2);',
  '        [Fact(Skip = "fixture: deliberately skipped")] public void Skipped_OnPurpose() { }',
  '        [Theory]',
  '        [InlineData(2, 2, 4)]',
  '        [InlineData(1, 1, 2)]',
  '        public void Adds_Theory(int a, int b, int expected) => Assert.Equal(expected, a + b);',
  '        [Theory]',
  '        [InlineData(2, 2, 4)]',
  '        [InlineData(1, 1, 99)]',
  '        public void Mixed_Theory(int a, int b, int expected) => Assert.Equal(expected, a + b);',
  '    }',
  '}',
  '',
].join('\n');

const CS_NUNIT_SOURCE = [
  'using NUnit.Framework;',
  '',
  'namespace Cs.Nunit.Fixtures',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Test] public void Adds_TwoNumbers() => Assert.That(1 + 2, Is.EqualTo(3));',
  '        [Test] public void Fails_OnPurpose() => Assert.That(1 + 2, Is.EqualTo(4));',
  '        [Test, Ignore("fixture: deliberately skipped")] public void Skipped_OnPurpose() { }',
  '        [TestCase(2, 2, 4)]',
  '        public void Adds_Case(int a, int b, int expected) =>',
  '            Assert.That(a + b, Is.EqualTo(expected));',
  '    }',
  '}',
  '',
].join('\n');

const CS_MSTEST_SOURCE = [
  'using Microsoft.VisualStudio.TestTools.UnitTesting;',
  '',
  'namespace Cs.Mstest.Fixtures',
  '{',
  '    [TestClass]',
  '    public class CalculatorTests',
  '    {',
  '        [TestMethod] public void Adds_TwoNumbers() => Assert.AreEqual(3, 1 + 2);',
  '        [TestMethod] public void Fails_OnPurpose() => Assert.AreEqual(4, 1 + 2);',
  '        [TestMethod, Ignore] public void Skipped_OnPurpose() { }',
  '        [DataTestMethod]',
  '        [DataRow(2, 2, 4)]',
  '        public void Adds_Row(int a, int b, int expected) => Assert.AreEqual(expected, a + b);',
  '    }',
  '}',
  '',
].join('\n');

const FS_XUNIT_SOURCE = [
  'module Fs.Xunit.Fixtures',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let addsTwoNumbers () = Assert.Equal(3, 1 + 2)',
  '',
  '[<Fact>]',
  'let ``adds two numbers with spaces`` () = Assert.Equal(5, 2 + 3)',
  '',
  '[<Fact>]',
  'let ``fails on purpose`` () = Assert.Equal(4, 1 + 2)',
  '',
  '[<Fact(Skip = "fixture: deliberately skipped")>]',
  'let ``skipped on purpose`` () = ()',
  '',
  '[<Theory>]',
  '[<InlineData(2, 2, 4)>]',
  'let ``adds theory`` (a: int) (b: int) (expected: int) = Assert.Equal(expected, a + b)',
  '',
  '[<Theory>]',
  '[<InlineData(2, 2, 4)>]',
  '[<InlineData(1, 1, 99)>]',
  'let ``mixed theory`` (a: int) (b: int) (expected: int) = Assert.Equal(expected, a + b)',
  '',
].join('\n');

const FS_NUNIT_SOURCE = [
  'module Fs.Nunit.Fixtures',
  '',
  'open NUnit.Framework',
  '',
  '[<Test>]',
  'let addsTwoNumbers () = Assert.That(1 + 2, Is.EqualTo(3))',
  '',
  '[<Test>]',
  'let ``fails on purpose`` () = Assert.That(1 + 2, Is.EqualTo(4))',
  '',
  '[<Test; Ignore("fixture: deliberately skipped")>]',
  'let ``skipped on purpose`` () = ()',
  '',
  '[<TestCase(2, 2, 4)>]',
  'let ``adds case`` (a: int) (b: int) (expected: int) = Assert.That(a + b, Is.EqualTo(expected))',
  '',
].join('\n');

const FS_MSTEST_SOURCE = [
  'module Fs.Mstest.Fixtures',
  '',
  'open Microsoft.VisualStudio.TestTools.UnitTesting',
  '',
  '[<TestClass>]',
  'type CalculatorTests() =',
  '',
  '    [<TestMethod>]',
  '    member _.AddsTwoNumbers() = Assert.AreEqual<int>(3, 1 + 2)',
  '',
  '    [<TestMethod>]',
  '    member _.FailsOnPurpose() = Assert.AreEqual<int>(4, 1 + 2)',
  '',
  '    [<TestMethod; Ignore>]',
  '    member _.SkippedOnPurpose() = ()',
  '',
  '    [<DataTestMethod; DataRow(2, 2, 4)>]',
  '    member _.AddsRow(a: int, b: int, expected: int) = Assert.AreEqual<int>(expected, a + b)',
  '',
].join('\n');

/** Every framework × language fixture, in build order. */
export const FRAMEWORK_FIXTURES: readonly FrameworkFixture[] = [
  {
    key: 'xunit-fsharp',
    framework: 'xunit',
    language: 'fsharp',
    packages: XUNIT_PACKAGES,
    projectName: 'XunitFs',
    projectFileName: 'XunitFs.fsproj',
    sourceFileName: 'Tests.fs',
    source: FS_XUNIT_SOURCE,
    passing: 'Fs.Xunit.Fixtures.addsTwoNumbers',
    failing: 'Fs.Xunit.Fixtures.fails on purpose',
    skipped: 'Fs.Xunit.Fixtures.skipped on purpose',
    parameterized: 'Fs.Xunit.Fixtures.adds theory',
    mixedParameterized: 'Fs.Xunit.Fixtures.mixed theory',
  },
  {
    key: 'nunit-fsharp',
    framework: 'nunit',
    language: 'fsharp',
    packages: NUNIT_PACKAGES,
    projectName: 'NunitFs',
    projectFileName: 'NunitFs.fsproj',
    sourceFileName: 'Tests.fs',
    source: FS_NUNIT_SOURCE,
    passing: 'Fs.Nunit.Fixtures.addsTwoNumbers',
    failing: 'Fs.Nunit.Fixtures.fails on purpose',
    skipped: 'Fs.Nunit.Fixtures.skipped on purpose',
    parameterized: 'Fs.Nunit.Fixtures.adds case(2,2,4)',
  },
  {
    key: 'mstest-fsharp',
    framework: 'mstest',
    language: 'fsharp',
    packages: MSTEST_PACKAGES,
    projectName: 'MstestFs',
    projectFileName: 'MstestFs.fsproj',
    sourceFileName: 'Tests.fs',
    source: FS_MSTEST_SOURCE,
    passing: 'Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers',
    failing: 'Fs.Mstest.Fixtures+CalculatorTests.FailsOnPurpose',
    skipped: 'Fs.Mstest.Fixtures+CalculatorTests.SkippedOnPurpose',
    parameterized: 'Fs.Mstest.Fixtures+CalculatorTests.AddsRow',
  },
  {
    key: 'xunit-csharp',
    framework: 'xunit',
    language: 'csharp',
    packages: XUNIT_PACKAGES,
    projectName: 'XunitCs',
    projectFileName: 'XunitCs.csproj',
    sourceFileName: 'Tests.cs',
    source: CS_XUNIT_SOURCE,
    passing: 'Cs.Xunit.Fixtures.CalculatorTests.Adds_TwoNumbers',
    failing: 'Cs.Xunit.Fixtures.CalculatorTests.Fails_OnPurpose',
    skipped: 'Cs.Xunit.Fixtures.CalculatorTests.Skipped_OnPurpose',
    parameterized: 'Cs.Xunit.Fixtures.CalculatorTests.Adds_Theory',
    mixedParameterized: 'Cs.Xunit.Fixtures.CalculatorTests.Mixed_Theory',
  },
  {
    key: 'nunit-csharp',
    framework: 'nunit',
    language: 'csharp',
    packages: NUNIT_PACKAGES,
    projectName: 'NunitCs',
    projectFileName: 'NunitCs.csproj',
    sourceFileName: 'Tests.cs',
    source: CS_NUNIT_SOURCE,
    passing: 'Cs.Nunit.Fixtures.CalculatorTests.Adds_TwoNumbers',
    failing: 'Cs.Nunit.Fixtures.CalculatorTests.Fails_OnPurpose',
    skipped: 'Cs.Nunit.Fixtures.CalculatorTests.Skipped_OnPurpose',
    parameterized: 'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)',
  },
  {
    key: 'mstest-csharp',
    framework: 'mstest',
    language: 'csharp',
    packages: MSTEST_PACKAGES,
    projectName: 'MstestCs',
    projectFileName: 'MstestCs.csproj',
    sourceFileName: 'Tests.cs',
    source: CS_MSTEST_SOURCE,
    passing: 'Cs.Mstest.Fixtures.CalculatorTests.Adds_TwoNumbers',
    failing: 'Cs.Mstest.Fixtures.CalculatorTests.Fails_OnPurpose',
    skipped: 'Cs.Mstest.Fixtures.CalculatorTests.Skipped_OnPurpose',
    parameterized: 'Cs.Mstest.Fixtures.CalculatorTests.Adds_Row',
  },
];

/**
 * The same C# xUnit project, built against the LEGACY 2.2.0 VSTest adapter.
 *
 * Deliberately NOT a member of {@link FRAMEWORK_FIXTURES}: the framework matrix
 * asserts one project per framework/language pair, and this is a second build of
 * a pair it already covers. What it adds is the adapter shape that matrix cannot
 * see — 2.2.0 appends each test case's 40-hex unique ID to the
 * `FullyQualifiedName` it reports, which is how a real-world project (issue
 * \#232) ends up with `Method (4159b661…)` in the tree and a `--filter` that can
 * never match. Its own namespace keeps its FQNs out of the shared result cache
 * every other Test Explorer suite writes into.
 */
export const LEGACY_ADAPTER_FIXTURE: FrameworkFixture = {
  key: 'xunit-legacy-csharp',
  framework: 'xunit',
  language: 'csharp',
  packages: XUNIT_LEGACY_PACKAGES,
  projectName: 'XunitLegacyCs',
  projectFileName: 'XunitLegacyCs.csproj',
  sourceFileName: 'Tests.cs',
  source: CS_XUNIT_SOURCE.replace('Cs.Xunit.Fixtures', 'Cs.XunitLegacy.Fixtures'),
  passing: 'Cs.XunitLegacy.Fixtures.CalculatorTests.Adds_TwoNumbers',
  failing: 'Cs.XunitLegacy.Fixtures.CalculatorTests.Fails_OnPurpose',
  skipped: 'Cs.XunitLegacy.Fixtures.CalculatorTests.Skipped_OnPurpose',
  parameterized: 'Cs.XunitLegacy.Fixtures.CalculatorTests.Adds_Theory',
  mixedParameterized: 'Cs.XunitLegacy.Fixtures.CalculatorTests.Mixed_Theory',
};

/** Look a fixture up by key, failing loudly on a typo. */
export function fixtureFor(key: string): FrameworkFixture {
  const fixture = FRAMEWORK_FIXTURES.find((candidate) => candidate.key === key);
  if (fixture === undefined) throw new Error(`no framework fixture named '${key}'`);
  return fixture;
}

/**
 * A plain library the test project references, and a test that exercises it.
 *
 * A coverage run needs something to cover. `coverlet.collector` leaves the TEST
 * assembly out of its report by default (`IncludeTestAssembly` is false), so a
 * solution made only of test projects yields a valid but EMPTY Cobertura
 * document — the report is written and parses, and reports nothing. Every real
 * user has a library and a test project pointed at it, so the fixture does too.
 */
export const LIBRARY_PROJECT = 'CalcLib';
export const LIBRARY_SOURCE = [
  'namespace Calc.Library',
  '{',
  '    public static class Calculator',
  '    {',
  '        public static int Add(int a, int b) => a + b;',
  '        public static int Subtract(int a, int b) => a - b;',
  '        public static int Multiply(int a, int b) => a * b;',
  '        public static int NeverCalled(int a) => a * 100;',
  '    }',
  '}',
  '',
].join('\n');

/** The C# test project's SECOND source file: it is what covers the library. */
export const LIBRARY_TESTS_FILE = 'LibraryTests.cs';
export const LIBRARY_TESTS_SOURCE = [
  'using Calc.Library;',
  'using Xunit;',
  '',
  'namespace Cs.Xunit.Fixtures',
  '{',
  '    public class LibraryTests',
  '    {',
  '        [Fact] public void Covers_The_Library()',
  '        {',
  '            Assert.Equal(3, Calculator.Add(1, 2));',
  '            Assert.Equal(1, Calculator.Subtract(3, 2));',
  '            Assert.Equal(6, Calculator.Multiply(2, 3));',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

/** The FQN that test exposes — a real pass, so it joins the green group. */
export const LIBRARY_TEST = 'Cs.Xunit.Fixtures.LibraryTests.Covers_The_Library';

/** `--collect:"XPlat Code Coverage"` needs this collector in the project. */
const COVERLET: PackageRef = { id: 'coverlet.collector', version: '6.0.2' };

/**
 * A library, a C# test project referencing it, and an F# test project — the
 * shape a coverage run needs. `coverlet.collector` leaves the TEST assembly out
 * of its report by default, so a solution of nothing but test projects yields a
 * valid but EMPTY Cobertura document; and it only reports assemblies the run
 * actually LOADED, so a test that exercises the library has to exist and be run.
 */
export function writeCoverageFixture(root: string): string[] {
  const CS = fixtureFor('xunit-csharp');
  const FSX = fixtureFor('xunit-fsharp');
  const packages = [...XUNIT_PACKAGES, COVERLET];
  const reference = path.join('..', LIBRARY_PROJECT, `${LIBRARY_PROJECT}.csproj`);
  const libDir = writeProject(
    path.join(root, LIBRARY_PROJECT),
    `${LIBRARY_PROJECT}.csproj`,
    libraryProjectXml(),
    'Calculator.cs',
    LIBRARY_SOURCE,
  );
  const csDir = writeProject(
    path.join(root, CS.projectName),
    CS.projectFileName,
    buildProjectXml({ packages, projectReferences: [reference] }),
    CS.sourceFileName,
    CS.source,
  );
  fs.writeFileSync(path.join(csDir, LIBRARY_TESTS_FILE), LIBRARY_TESTS_SOURCE, 'utf8');
  const fsDir = writeProject(
    path.join(root, FSX.projectName),
    FSX.projectFileName,
    projectXml(packages, FSX.sourceFileName),
    FSX.sourceFileName,
    FSX.source,
  );
  return [libDir, csDir, fsDir];
}
