// The Microsoft.Testing.Platform projects the MTP Test Explorer suites build.
//
// Every framework appears twice — once in F# and once in C#, F# FIRST (project
// rule) — because each one exercises a different part of [TEST-MTP-DISCOVERY]:
//
//   • `xunit.v3` 4.0.0 supports MTP v2 ONLY and carries no VSTest adapter, so
//     `dotnet vstest` cannot load it at all. This is the reported case (#249).
//   • MSTest reports the BARE method name as its DISPLAY name, so it is what
//     proves the id comes from the listing's `type` block and never from the
//     display name — the issue-#180 defect in its MTP shape.
//   • NUnit's uid is a DECORATED name carrying parentheses and commas
//     (`Ns.Class.Adds_Case(2,2,4)`), which proves `--filter-uid` takes literal
//     values and must never be escaped; and NUnit reports NO source location,
//     which proves the location is optional.
//
// The F# shapes matter on their own: a backtick binding produces an id carrying
// SPACES, and an F# `[<TestClass>]` nested in a module produces a CLR
// nested-type id carrying `+`.
//
// Each project holds a passing, a failing and a skipped test plus a data-driven
// one, so outcome attribution is asserted per test rather than per run. Their
// namespaces are their own, so their ids never collide with the VSTest fixtures
// in the shared result cache.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createSolution,
  mtpProjectXml,
  writeMtpGlobalJson,
  writeProject,
  MTP_MSTEST_PACKAGES,
  MTP_NUNIT_PACKAGES,
  MTP_XUNIT_PACKAGES,
  type PackageRef,
} from './dotnet-project-kit';

/** One buildable MTP fixture project plus the ids it is expected to expose. */
export interface MtpFixture {
  /** Stable key: `<framework>-<language>`. */
  readonly key: string;
  readonly framework: 'xunit' | 'mstest' | 'nunit';
  readonly language: 'fsharp' | 'csharp';
  readonly packages: readonly PackageRef[];
  readonly projectName: string;
  readonly projectFileName: string;
  readonly sourceFileName: string;
  readonly source: string;
  /** Id of the test that passes. */
  readonly passing: string;
  /** Id of the test that fails. */
  readonly failing: string;
  /** Id of the test that is skipped or ignored. */
  readonly skipped: string;
  /** Id of the data-driven test whose rows all pass. */
  readonly parameterized: string;
  /**
   * Id of a data-driven test whose rows DISAGREE — one passes, one fails. Both
   * rows report under this one id, so the merged outcome must be a failure.
   * Only the xUnit fixtures carry one.
   */
  readonly mixedParameterized?: string;
  /**
   * Whether the framework reports a source location for its tests. NUnit does
   * not, and its rows must still appear in the tree.
   */
  readonly reportsLocation: boolean;
  /**
   * A distinctive fragment of the assertion text this framework writes for
   * {@link failing}. Each one is different, and surfacing the framework's OWN
   * text — rather than a generic "Test failed" — is what [TEST-RUN-TRX]
   * requires of the report reader.
   */
  readonly failureText: string;
}

const FS_XUNIT_SOURCE = [
  'module Fs.XunitMtp.Fixtures',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let ``adds two numbers with spaces`` () = Assert.Equal(3, 1 + 2)',
  '',
  '[<Fact>]',
  'let ``fails on purpose`` () = Assert.Equal(4, 1 + 2)',
  '',
  '[<Fact(Skip = "fixture: deliberately skipped")>]',
  'let ``skipped on purpose`` () = ()',
  '',
  '[<Theory>]',
  '[<InlineData(2, 2, 4)>]',
  '[<InlineData(1, 1, 2)>]',
  'let ``adds theory rows`` (a: int) (b: int) (expected: int) = Assert.Equal(expected, a + b)',
  '',
].join('\n');

const CS_XUNIT_SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.XunitMtp.Fixtures',
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

const FS_MSTEST_SOURCE = [
  'module Fs.MstestMtp.Fixtures',
  '',
  'open Microsoft.VisualStudio.TestTools.UnitTesting',
  '',
  '[<TestClass>]',
  'type CalculatorTests() =',
  '    [<TestMethod>]',
  '    member _.AddsTwoNumbers() = Assert.AreEqual(3, 1 + 2)',
  '',
  '    [<TestMethod>]',
  '    member _.FailsOnPurpose() = Assert.AreEqual(4, 1 + 2)',
  '',
  '    [<TestMethod; Ignore>]',
  '    member _.SkippedOnPurpose() = ()',
  '',
  '    [<TestMethod; DataRow(2, 2, 4)>]',
  '    member _.AddsRow(a: int, b: int, expected: int) = Assert.AreEqual(expected, a + b)',
  '',
].join('\n');

const CS_MSTEST_SOURCE = [
  'using Microsoft.VisualStudio.TestTools.UnitTesting;',
  '',
  'namespace Cs.MstestMtp.Fixtures',
  '{',
  '    [TestClass]',
  '    public class CalculatorTests',
  '    {',
  '        [TestMethod] public void Adds_TwoNumbers() => Assert.AreEqual(3, 1 + 2);',
  '        [TestMethod] public void Fails_OnPurpose() => Assert.AreEqual(4, 1 + 2);',
  '        [TestMethod, Ignore] public void Skipped_OnPurpose() { }',
  '        [TestMethod]',
  '        [DataRow(2, 2, 4)]',
  '        public void Adds_Row(int a, int b, int expected) => Assert.AreEqual(expected, a + b);',
  '    }',
  '}',
  '',
].join('\n');

const FS_NUNIT_SOURCE = [
  'module Fs.NunitMtp.Fixtures',
  '',
  'open NUnit.Framework',
  '',
  '[<Test>]',
  'let ``adds two numbers with spaces`` () = Assert.That(1 + 2, Is.EqualTo(3))',
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

const CS_NUNIT_SOURCE = [
  'using NUnit.Framework;',
  '',
  'namespace Cs.NunitMtp.Fixtures',
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

/**
 * Every MTP fixture, F# FIRST within each framework.
 *
 * The ids are the ones the modules really report, read off a built fixture —
 * the F# backtick names carrying SPACES, the F# MSTest nested-type `+`, and the
 * data-driven ids carrying NO row data because the listing's `type` block
 * carries none.
 */
export const MTP_FIXTURES: readonly MtpFixture[] = [
  {
    key: 'xunit-fsharp',
    framework: 'xunit',
    language: 'fsharp',
    packages: MTP_XUNIT_PACKAGES,
    projectName: 'XunitMtpFs',
    projectFileName: 'XunitMtpFs.fsproj',
    sourceFileName: 'Tests.fs',
    source: FS_XUNIT_SOURCE,
    passing: 'Fs.XunitMtp.Fixtures.adds two numbers with spaces',
    failing: 'Fs.XunitMtp.Fixtures.fails on purpose',
    skipped: 'Fs.XunitMtp.Fixtures.skipped on purpose',
    parameterized: 'Fs.XunitMtp.Fixtures.adds theory rows',
    reportsLocation: true,
    failureText: 'Assert.Equal() Failure',
  },
  {
    key: 'xunit-csharp',
    framework: 'xunit',
    language: 'csharp',
    packages: MTP_XUNIT_PACKAGES,
    projectName: 'XunitMtpCs',
    projectFileName: 'XunitMtpCs.csproj',
    sourceFileName: 'Tests.cs',
    source: CS_XUNIT_SOURCE,
    passing: 'Cs.XunitMtp.Fixtures.CalculatorTests.Adds_TwoNumbers',
    failing: 'Cs.XunitMtp.Fixtures.CalculatorTests.Fails_OnPurpose',
    skipped: 'Cs.XunitMtp.Fixtures.CalculatorTests.Skipped_OnPurpose',
    parameterized: 'Cs.XunitMtp.Fixtures.CalculatorTests.Adds_Theory',
    mixedParameterized: 'Cs.XunitMtp.Fixtures.CalculatorTests.Mixed_Theory',
    reportsLocation: true,
    failureText: 'Assert.Equal() Failure',
  },
  {
    key: 'mstest-fsharp',
    framework: 'mstest',
    language: 'fsharp',
    packages: MTP_MSTEST_PACKAGES,
    projectName: 'MstestMtpFs',
    projectFileName: 'MstestMtpFs.fsproj',
    sourceFileName: 'Tests.fs',
    source: FS_MSTEST_SOURCE,
    passing: 'Fs.MstestMtp.Fixtures+CalculatorTests.AddsTwoNumbers',
    failing: 'Fs.MstestMtp.Fixtures+CalculatorTests.FailsOnPurpose',
    skipped: 'Fs.MstestMtp.Fixtures+CalculatorTests.SkippedOnPurpose',
    parameterized: 'Fs.MstestMtp.Fixtures+CalculatorTests.AddsRow',
    reportsLocation: true,
    failureText: 'Assertion failed. Expected values to be equal.',
  },
  {
    key: 'mstest-csharp',
    framework: 'mstest',
    language: 'csharp',
    packages: MTP_MSTEST_PACKAGES,
    projectName: 'MstestMtpCs',
    projectFileName: 'MstestMtpCs.csproj',
    sourceFileName: 'Tests.cs',
    source: CS_MSTEST_SOURCE,
    passing: 'Cs.MstestMtp.Fixtures.CalculatorTests.Adds_TwoNumbers',
    failing: 'Cs.MstestMtp.Fixtures.CalculatorTests.Fails_OnPurpose',
    skipped: 'Cs.MstestMtp.Fixtures.CalculatorTests.Skipped_OnPurpose',
    parameterized: 'Cs.MstestMtp.Fixtures.CalculatorTests.Adds_Row',
    reportsLocation: true,
    failureText: 'Assertion failed. Expected values to be equal.',
  },
  {
    key: 'nunit-fsharp',
    framework: 'nunit',
    language: 'fsharp',
    packages: MTP_NUNIT_PACKAGES,
    projectName: 'NunitMtpFs',
    projectFileName: 'NunitMtpFs.fsproj',
    sourceFileName: 'Tests.fs',
    source: FS_NUNIT_SOURCE,
    passing: 'Fs.NunitMtp.Fixtures.adds two numbers with spaces',
    failing: 'Fs.NunitMtp.Fixtures.fails on purpose',
    skipped: 'Fs.NunitMtp.Fixtures.skipped on purpose',
    parameterized: 'Fs.NunitMtp.Fixtures.adds case',
    reportsLocation: false,
    failureText: 'Assert.That(',
  },
  {
    key: 'nunit-csharp',
    framework: 'nunit',
    language: 'csharp',
    packages: MTP_NUNIT_PACKAGES,
    projectName: 'NunitMtpCs',
    projectFileName: 'NunitMtpCs.csproj',
    sourceFileName: 'Tests.cs',
    source: CS_NUNIT_SOURCE,
    passing: 'Cs.NunitMtp.Fixtures.CalculatorTests.Adds_TwoNumbers',
    failing: 'Cs.NunitMtp.Fixtures.CalculatorTests.Fails_OnPurpose',
    skipped: 'Cs.NunitMtp.Fixtures.CalculatorTests.Skipped_OnPurpose',
    parameterized: 'Cs.NunitMtp.Fixtures.CalculatorTests.Adds_Case',
    reportsLocation: false,
    failureText: 'Assert.That(',
  },
];

/** Every id one fixture must contribute to the tree. */
export function idsOf(fixture: MtpFixture): readonly string[] {
  const mixed = fixture.mixedParameterized === undefined ? [] : [fixture.mixedParameterized];
  return [fixture.passing, fixture.failing, fixture.skipped, fixture.parameterized, ...mixed];
}

/** Every id the whole MTP fixture solution must expose. */
export const ALL_MTP_IDS: readonly string[] = MTP_FIXTURES.flatMap(idsOf);

/** Look a fixture up by key, failing loudly on a typo. */
export function mtpFixtureFor(key: string): MtpFixture {
  const fixture = MTP_FIXTURES.find((candidate) => candidate.key === key);
  if (fixture === undefined) throw new Error(`no MTP fixture named '${key}'`);
  return fixture;
}

/** Write one fixture project and return its directory. */
export function writeMtpProject(root: string, fixture: MtpFixture): string {
  const compile = fixture.language === 'fsharp' ? [fixture.sourceFileName] : [];
  return writeProject(
    path.join(root, fixture.projectName),
    fixture.projectFileName,
    mtpProjectXml(fixture.packages, ...compile),
    fixture.sourceFileName,
    fixture.source,
  );
}

/**
 * Write every MTP fixture plus the `global.json` opt-in, then produce a real
 * solution the `dotnet` CLI itself authored.
 *
 * The opt-in is the switch a real user throws, and it is what [TEST-MTP-DETECT]
 * reads first — without it the VSTest passes run and waste a build before the
 * MSBuild probe rescues the sweep.
 */
export async function createMtpSolution(
  root: string,
  fixtures: readonly MtpFixture[] = MTP_FIXTURES,
): Promise<string> {
  fs.mkdirSync(root, { recursive: true });
  writeMtpGlobalJson(root);
  const dirs = fixtures.map((fixture) => writeMtpProject(root, fixture));
  return await createSolution(root, 'MtpFixtures', dirs);
}
