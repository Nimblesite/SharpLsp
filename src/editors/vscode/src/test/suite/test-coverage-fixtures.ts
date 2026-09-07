// The fixture solution the `[TEST-COVERAGE]` suite runs against.
//
// [TEST-COVERAGE] makes two claims that a single-test-project fixture cannot
// falsify, and both were the actual defect:
//
//   • "the collector writes one Cobertura report per test project" — with one
//     test project, one report, `reports.length >= 1` passes forever,
//   • "**every** one of them is parsed … taking only the first drops every
//     other project's coverage" — with one report, first IS every, so reading
//     only `reports[0]` is indistinguishable from reading them all.
//
// So this fixture is TWO test projects over ONE library, each exercising a
// DIFFERENT function of it:
//
//   CoverCs  → Calculator.Add       (and nothing else)
//   CoverFs  → Calculator.Multiply  (and nothing else)
//
// Neither `Subtract` nor `NeverCalled` is ever executed. That makes the union of
// the two reports strictly larger than either one alone, so a reader that keeps
// only the first report reports MULTIPLY as dead code on a run that just
// executed it — a wrong red gutter, not merely a missing one.
//
// F# is first here as everywhere: the F# test is an idiomatic backtick binding
// whose fully-qualified name carries SPACES, and it has to survive the coverage
// run's filter exactly as it does an ordinary one ([TEST-FILTER-ESCAPE]).
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildProjectXml,
  libraryProjectXml,
  XUNIT_PACKAGES,
  writeProject,
  type PackageRef,
} from './dotnet-project-kit';
import { LIBRARY_PROJECT, LIBRARY_SOURCE } from './test-explorer-fixtures';

/** Where the Coverage profile drops TRX + Cobertura, beside the solution. */
export const COVERAGE_DIR_NAME = '.sharplsp-coverage';

/** The collector `--collect:"XPlat Code Coverage"` needs referenced. */
export const COVERLET_PACKAGE: PackageRef = { id: 'coverlet.collector', version: '6.0.2' };

/** The single source file both test projects cover, and its four functions. */
export const LIBRARY_FILE = 'Calculator.cs';

/**
 * The TEST sources, which the collector must never report.
 *
 * `coverlet.collector` leaves the test assembly out by default
 * (`IncludeTestAssembly` is false), so these names appearing in a report means
 * the fixture is measuring the tests rather than the library they exercise
 * ([TEST-COVERAGE]).
 */
export const CS_TESTS_FILE = 'CoverageTests.cs';
export const FS_TESTS_FILE = 'CoverageTests.fs';
/** Executed only by the C# project. */
export const COVERED_BY_CSHARP = 'Add';
/** Executed only by the F# project. */
export const COVERED_BY_FSHARP = 'Multiply';
/** Compiled, never executed — the partial-coverage proof. */
export const NEVER_COVERED: readonly string[] = ['Subtract', 'NeverCalled'];

const CS_PROJECT = 'CoverCs';
const FS_PROJECT = 'CoverFs';
const CS_NAMESPACE = 'Cs.Cover.Fixtures';
const FS_NAMESPACE = 'Fs.Cover.Fixtures';
const CS_CLASS = 'AdditionTests';

/** The C# test project: it touches `Add`, and nothing else in the library. */
export const CS_COVERS = `${CS_NAMESPACE}.${CS_CLASS}.Covers_Add`;
/** A red test, so outcome attribution stays assertable UNDER the Coverage profile. */
export const CS_FAILING = `${CS_NAMESPACE}.${CS_CLASS}.Fails_Loudly`;
/** A skipped test whose body would have covered `Subtract` had it run. */
export const CS_SKIPPED = `${CS_NAMESPACE}.${CS_CLASS}.Never_Runs`;
/** A two-row `[Theory]`, reported under one name ([TEST-RUN-TRX]). */
export const CS_THEORY = `${CS_NAMESPACE}.${CS_CLASS}.Adds_Rows`;

/** The F# test project: a backtick name with SPACES, touching `Multiply`. */
export const FS_COVERS = `${FS_NAMESPACE}.covers multiply only`;
/** An F# test that touches the library not at all. */
export const FS_ISOLATED = `${FS_NAMESPACE}.adds without touching the library`;

/** Every test the fixture solution exposes. */
export const ALL_COVERAGE_TESTS: readonly string[] = [
  CS_COVERS,
  CS_FAILING,
  CS_SKIPPED,
  CS_THEORY,
  FS_COVERS,
  FS_ISOLATED,
];

const CS_SOURCE = [
  'using Calc.Library;',
  'using Xunit;',
  '',
  `namespace ${CS_NAMESPACE}`,
  '{',
  `    public class ${CS_CLASS}`,
  '    {',
  '        [Fact] public void Covers_Add() => Assert.Equal(3, Calculator.Add(1, 2));',
  '',
  '        [Fact] public void Fails_Loudly() => Assert.Equal(4, Calculator.Add(1, 2));',
  '',
  '        [Fact(Skip = "covers Subtract only if it ever runs")]',
  '        public void Never_Runs() => Assert.Equal(0, Calculator.Subtract(1, 1));',
  '',
  '        [Theory]',
  '        [InlineData(1, 2, 3)]',
  '        [InlineData(2, 3, 5)]',
  '        public void Adds_Rows(int a, int b, int expected) =>',
  '            Assert.Equal(expected, Calculator.Add(a, b));',
  '    }',
  '}',
  '',
].join('\n');

const FS_SOURCE = [
  `module ${FS_NAMESPACE}`,
  '',
  'open Calc.Library',
  'open Xunit',
  '',
  '[<Fact>]',
  'let ``covers multiply only`` () = Assert.Equal(6, Calculator.Multiply(2, 3))',
  '',
  '[<Fact>]',
  'let ``adds without touching the library`` () = Assert.Equal(3, 1 + 2)',
  '',
].join('\n');

/**
 * Write the library and BOTH test projects; returns their directories.
 *
 * Both test projects reference the library and the collector, because
 * `coverlet.collector` only reports assemblies the run actually LOADED: a test
 * project without the reference contributes a valid, empty report and proves
 * nothing about whether its report was read.
 */
export function writeSplitCoverageFixture(root: string): string[] {
  const packages = [...XUNIT_PACKAGES, COVERLET_PACKAGE];
  const reference = path.join('..', LIBRARY_PROJECT, `${LIBRARY_PROJECT}.csproj`);
  const libDir = writeProject(
    path.join(root, LIBRARY_PROJECT),
    `${LIBRARY_PROJECT}.csproj`,
    libraryProjectXml(),
    LIBRARY_FILE,
    LIBRARY_SOURCE,
  );
  const csDir = writeProject(
    path.join(root, CS_PROJECT),
    `${CS_PROJECT}.csproj`,
    buildProjectXml({ packages, projectReferences: [reference] }),
    CS_TESTS_FILE,
    CS_SOURCE,
  );
  const fsDir = writeProject(
    path.join(root, FS_PROJECT),
    `${FS_PROJECT}.fsproj`,
    buildProjectXml({
      packages,
      projectReferences: [reference],
      compileIncludes: [FS_TESTS_FILE],
    }),
    FS_TESTS_FILE,
    FS_SOURCE,
  );
  return [libDir, csDir, fsDir];
}

/**
 * The RUN-ID FOLDERS under `dir` — the ones actually carrying a Cobertura
 * report, which is what [TEST-COVERAGE] means by "one Cobertura report per test
 * project, each in its own run-id folder one level down".
 *
 * A run-id folder is not the only directory the collector's results directory
 * ends up holding. `--results-directory` is shared with the TRX logger, and the
 * logger creates its OWN attachments folder there — named for the user, machine
 * and timestamp — as soon as the run produces an attachment, which a coverage
 * run always does. Counting every directory therefore counts the TRX folder as
 * a third project's report and fails a green run.
 *
 * Filtering on the report is also the STRONGER assertion: it is exactly the set
 * `findCoberturaFiles` walks (one level down, `coverage.cobertura.xml`), so a
 * count taken here is a count of reports the product can actually load, not of
 * folders that merely exist.
 */
export function reportDirsOf(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => fs.existsSync(path.join(dir, entry, REPORT_FILE_NAME)))
    .sort();
}

/** The file name `coverlet.collector` writes into each run-id folder. */
const REPORT_FILE_NAME = 'coverage.cobertura.xml';
