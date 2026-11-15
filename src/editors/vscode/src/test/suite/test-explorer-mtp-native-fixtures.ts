// The `xunit.v3` NATIVE-console fixtures of issue #581: MTP projects with NO
// `global.json` opt-in and NO runner switch, F# FIRST (project rule).
//
// From `xunit.v3` 4.0.1 the package ships its OWN runner console whenever a
// project does not set `UseMicrosoftTestingPlatformRunner`: the built module
// refuses every Microsoft.Testing.Platform option (`error: unknown option:
// --list-tests`) and the .NET 10 SDK's VSTest target refuses the project
// outright ("Testing with VSTest target is no longer supported"). That is the
// reported defect — discovery found nothing, and the VSTest pass Microsoft
// itself recommends against ran first anyway.
//
// These projects carry NO runner switch on purpose: the MTP fixtures in
// `test-explorer-mtp-fixtures.ts` set one and speak MTP's own options; these
// speak the runner's own `-list` / `-id` / `-result-trx` commands, so the same
// tree, run profiles and TRX reader must attribute them with no switch thrown.
// The C# project is the issue's exact repro, `Microsoft.NET.Test.Sdk` and
// `xunit.runner.visualstudio` included.
import * as path from 'node:path';
import {
  buildProjectXml,
  createSolution,
  writeProject,
  type PackageRef,
} from './dotnet-project-kit';
import { csXunitSource, fixtureNames } from './test-explorer-fixtures';

/** The F# shape: the module speaks the native console, nothing else beside it. */
export const NATIVE_XUNIT_PACKAGES: readonly PackageRef[] = [{ id: 'xunit.v3', version: '4.0.3' }];

/** The C# shape: the issue #581 repro, VSTest packages included. */
export const NATIVE_REPRO_PACKAGES: readonly PackageRef[] = [
  { id: 'xunit.v3', version: '4.0.3' },
  { id: 'Microsoft.NET.Test.Sdk', version: '17.11.1' },
  { id: 'xunit.runner.visualstudio', version: '4.0.1' },
];

/** The one property a native module needs: an Exe, and no runner switch. */
const NATIVE_PROPERTIES: Readonly<Record<string, string>> = { OutputType: 'Exe' };

const FS_NATIVE_SOURCE = [
  'module Fs.XunitNative.Fixtures',
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
  '[<InlineData(1, 1, 5)>]',
  'let ``adds theory rows`` (a: int) (b: int) (expected: int) = Assert.Equal(expected, a + b)',
  '',
].join('\n');

/** One native fixture and the ids its module must expose. */
export interface NativeFixture {
  readonly key: string;
  readonly language: 'fsharp' | 'csharp';
  readonly packages: readonly PackageRef[];
  readonly projectName: string;
  readonly projectFileName: string;
  readonly sourceFileName: string;
  readonly source: string;
  readonly passing: string;
  readonly failing: string;
  readonly skipped: string;
  readonly parameterized: string;
  /** A data-driven test whose rows disagree: its merged outcome must fail. */
  readonly mixedParameterized: string;
  /** A distinctive fragment of the module's own assertion text. */
  readonly failureText: string;
}

/** Every native fixture, F# first. */
export const NATIVE_FIXTURES: readonly NativeFixture[] = [
  {
    ...fixtureNames('xunit', 'fsharp', 'Native'),
    key: 'xunit-fsharp-native',
    language: 'fsharp',
    packages: NATIVE_XUNIT_PACKAGES,
    source: FS_NATIVE_SOURCE,
    passing: 'Fs.XunitNative.Fixtures.adds two numbers with spaces',
    failing: 'Fs.XunitNative.Fixtures.fails on purpose',
    skipped: 'Fs.XunitNative.Fixtures.skipped on purpose',
    parameterized: 'Fs.XunitNative.Fixtures.adds theory rows',
    mixedParameterized: 'Fs.XunitNative.Fixtures.adds theory rows',
    failureText: 'Assert.Equal() Failure',
  },
  {
    ...fixtureNames('xunit', 'csharp', 'Native'),
    key: 'xunit-csharp-native',
    language: 'csharp',
    packages: NATIVE_REPRO_PACKAGES,
    source: csXunitSource('namespace Cs.XunitNative.Fixtures'),
    passing: 'Cs.XunitNative.Fixtures.CalculatorTests.Adds_TwoNumbers',
    failing: 'Cs.XunitNative.Fixtures.CalculatorTests.Fails_OnPurpose',
    skipped: 'Cs.XunitNative.Fixtures.CalculatorTests.Skipped_OnPurpose',
    parameterized: 'Cs.XunitNative.Fixtures.CalculatorTests.Adds_Theory',
    mixedParameterized: 'Cs.XunitNative.Fixtures.CalculatorTests.Mixed_Theory',
    failureText: 'Assert.Equal() Failure',
  },
];

/** Every id the native fixture solution must expose, its mixed theory included. */
export function nativeIdsOf(fixture: NativeFixture): readonly string[] {
  return [...new Set([...nativeRunIds(fixture), fixture.mixedParameterized])];
}

/** The ids one native run selects: the four shapes every fixture carries. */
function nativeRunIds(fixture: NativeFixture): readonly string[] {
  return [fixture.passing, fixture.failing, fixture.skipped, fixture.parameterized];
}

/** Write one native fixture project and return its directory. */
export function writeNativeProject(root: string, fixture: NativeFixture): string {
  const compile = fixture.language === 'fsharp' ? [fixture.sourceFileName] : [];
  return writeProject(
    path.join(root, fixture.projectName),
    fixture.projectFileName,
    buildProjectXml({
      packages: fixture.packages,
      compileIncludes: compile,
      properties: NATIVE_PROPERTIES,
    }),
    fixture.sourceFileName,
    fixture.source,
  );
}

/** Write every native fixture and produce a real `dotnet`-authored solution. */
export async function createNativeSolution(
  root: string,
  fixtures: readonly NativeFixture[] = NATIVE_FIXTURES,
): Promise<string> {
  const dirs = fixtures.map((fixture) => writeNativeProject(root, fixture));
  return await createSolution(root, 'NativeFixtures', dirs);
}
