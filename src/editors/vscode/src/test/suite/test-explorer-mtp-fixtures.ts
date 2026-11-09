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
import {
  csClassNames,
  fixtureByKey,
  fixtureNames,
  type FixtureTests,
  csXunitSource,
  csNunitSource,
  csMstestSource,
  fsNunitSource,
  type FixtureProject,
} from './test-explorer-fixtures';

/**
 * One buildable MTP fixture project plus the ids it is expected to expose.
 *
 * The project itself is the {@link FixtureProject} the VSTest matrix builds
 * from the same sources; what MTP adds is the id shapes and failure text it
 * reports. `mixedParameterized` widens from its base doc: here it is the id of
 * a data-driven test whose rows disagree, merged to a failure.
 */
export interface MtpFixture extends FixtureProject {
  /**
   * Whether the framework reports a source location for its tests. NUnit does
   * not, and its rows must still appear in the tree.
   */
  readonly reportsLocation: boolean;
  /**
   * A distinctive fragment of the assertion text this framework writes for
   * {@link FixtureProject.failing}. Each one is different, and surfacing the
   * framework's OWN text — rather than a generic "Test failed" — is what
   * [TEST-RUN-TRX] requires of the report reader.
   */
  readonly failureText: string;
}

/** What each framework reports about a failing test: its location and its own assertion text. */
type MtpShape = Pick<MtpFixture, 'reportsLocation' | 'failureText'>;

/** xUnit writes `Assert.Equal() Failure` and does report a source location. */
const XUNIT_SHAPE: MtpShape = { reportsLocation: true, failureText: 'Assert.Equal() Failure' };

/** MSTest reports a location too, and phrases its own assertion failure. */
const MSTEST_SHAPE: MtpShape = {
  reportsLocation: true,
  failureText: 'Assertion failed. Expected values to be equal.',
};

/** NUnit reports NO location and its message starts at the assertion call. */
const NUNIT_SHAPE: MtpShape = { reportsLocation: false, failureText: 'Assert.That(' };

/** One MTP fixture, its project names derived by {@link fixtureNames} with the `Mtp` flavour. */
function mtpFixture(
  framework: FixtureProject['framework'],
  language: FixtureProject['language'],
  packages: readonly PackageRef[],
  source: string,
  tests: FixtureTests,
  shape: MtpShape,
): MtpFixture {
  const names = fixtureNames(framework, language, 'Mtp');
  return { ...names, framework, language, packages, source, ...tests, ...shape };
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

/**
 * Every MTP fixture, F# FIRST within each framework.
 *
 * The ids are the ones the modules really report, read off a built fixture —
 * the F# backtick names carrying SPACES, the F# MSTest nested-type `+`, and the
 * data-driven ids carrying NO row data because the listing's `type` block
 * carries none.
 */
export const MTP_FIXTURES: readonly MtpFixture[] = [
  mtpFixture(
    'xunit',
    'fsharp',
    MTP_XUNIT_PACKAGES,
    FS_XUNIT_SOURCE,
    {
      passing: 'Fs.XunitMtp.Fixtures.adds two numbers with spaces',
      failing: 'Fs.XunitMtp.Fixtures.fails on purpose',
      skipped: 'Fs.XunitMtp.Fixtures.skipped on purpose',
      parameterized: 'Fs.XunitMtp.Fixtures.adds theory rows',
    },
    XUNIT_SHAPE,
  ),
  mtpFixture(
    'xunit',
    'csharp',
    MTP_XUNIT_PACKAGES,
    csXunitSource('namespace Cs.XunitMtp.Fixtures'),
    csClassNames('Cs.XunitMtp.Fixtures', 'Adds_Theory', 'Mixed_Theory'),
    XUNIT_SHAPE,
  ),
  mtpFixture(
    'mstest',
    'fsharp',
    MTP_MSTEST_PACKAGES,
    FS_MSTEST_SOURCE,
    {
      passing: 'Fs.MstestMtp.Fixtures+CalculatorTests.AddsTwoNumbers',
      failing: 'Fs.MstestMtp.Fixtures+CalculatorTests.FailsOnPurpose',
      skipped: 'Fs.MstestMtp.Fixtures+CalculatorTests.SkippedOnPurpose',
      parameterized: 'Fs.MstestMtp.Fixtures+CalculatorTests.AddsRow',
    },
    MSTEST_SHAPE,
  ),
  mtpFixture(
    'mstest',
    'csharp',
    MTP_MSTEST_PACKAGES,
    csMstestSource('namespace Cs.MstestMtp.Fixtures', '        [TestMethod]'),
    csClassNames('Cs.MstestMtp.Fixtures', 'Adds_Row'),
    MSTEST_SHAPE,
  ),
  mtpFixture(
    'nunit',
    'fsharp',
    MTP_NUNIT_PACKAGES,
    fsNunitSource(
      'module Fs.NunitMtp.Fixtures',
      'let ``adds two numbers with spaces`` () = Assert.That(1 + 2, Is.EqualTo(3))',
    ),
    {
      passing: 'Fs.NunitMtp.Fixtures.adds two numbers with spaces',
      failing: 'Fs.NunitMtp.Fixtures.fails on purpose',
      skipped: 'Fs.NunitMtp.Fixtures.skipped on purpose',
      parameterized: 'Fs.NunitMtp.Fixtures.adds case',
    },
    NUNIT_SHAPE,
  ),
  mtpFixture(
    'nunit',
    'csharp',
    MTP_NUNIT_PACKAGES,
    csNunitSource('namespace Cs.NunitMtp.Fixtures'),
    csClassNames('Cs.NunitMtp.Fixtures', 'Adds_Case'),
    NUNIT_SHAPE,
  ),
];

/** Every id one fixture must contribute to the tree. */
export function idsOf(fixture: MtpFixture): readonly string[] {
  const mixed = fixture.mixedParameterized === undefined ? [] : [fixture.mixedParameterized];
  return [fixture.passing, fixture.failing, fixture.skipped, fixture.parameterized, ...mixed];
}

/** Every id the whole MTP fixture solution must expose. */
export const ALL_MTP_IDS: readonly string[] = MTP_FIXTURES.flatMap(idsOf);

/** Look an MTP fixture up by key, failing loudly on a typo. */
export function mtpFixtureFor(key: string): MtpFixture {
  return fixtureByKey(MTP_FIXTURES, key, 'MTP fixture');
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
