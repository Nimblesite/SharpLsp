// Real .NET fixtures for the extension-host suites: a project file, a source
// file, and a solution the `dotnet` CLI itself produced.
//
// Every Test Explorer suite needs the same thing — a genuine, buildable test
// project wired into a genuine solution — and eight suites had grown their own
// copy of the same hand-written `<Project Sdk="Microsoft.NET.Sdk">` string.
// Project XML is a STRUCTURED file, so it is built from an object model and
// serialized by an XML writer here, never spliced together from lines.
//
// Solutions are produced by `dotnet new sln` + `dotnet sln add`, never authored:
// .NET 10 emits the XML `.slnx` format by default and the extension has to cope
// with whichever the CLI chose, so the fixture must not assume an extension.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { XMLBuilder } from 'fast-xml-parser';
import { FIXTURE_BUILD_MS } from './test-timeouts';

/** A `<PackageReference Include=".." Version=".." />`. */
export interface PackageRef {
  readonly id: string;
  readonly version: string;
}

/** xUnit + the VSTest adapter + the test SDK: the C#/F# default. */
export const XUNIT_PACKAGES: readonly PackageRef[] = [
  { id: 'xunit', version: '2.9.2' },
  { id: 'xunit.runner.visualstudio', version: '2.8.2' },
  { id: 'Microsoft.NET.Test.Sdk', version: '17.11.1' },
];

/**
 * xUnit on its 2.2.0 VSTest adapter — the version real-world projects still pin
 * (FluentValidation among them).
 *
 * This adapter does NOT write a bare `TestCase.FullyQualifiedName`: it appends
 * the test case's 40-hex unique ID, so `--ListFullyQualifiedTests` emits
 * `Ns.Class.Method (d87517d9…)`. Modern adapters do not, which is why every
 * fixture built on {@link XUNIT_PACKAGES} is blind to the whole class of defect
 * that suffix causes. Pinned deliberately; do NOT "upgrade" it.
 */
export const XUNIT_DECORATING_PACKAGES: readonly PackageRef[] = [
  { id: 'xunit', version: '2.2.0' },
  { id: 'xunit.runner.visualstudio', version: '2.2.0' },
  { id: 'Microsoft.NET.Test.Sdk', version: '17.11.1' },
];

/** NUnit. Its `[TestCase]` names carry parentheses — the filter-escaping case. */
export const NUNIT_PACKAGES: readonly PackageRef[] = [
  { id: 'NUnit', version: '4.2.2' },
  { id: 'NUnit3TestAdapter', version: '4.6.0' },
  { id: 'Microsoft.NET.Test.Sdk', version: '17.11.1' },
];

/** MSTest. Its DisplayName is the BARE method name — the issue-#180 case. */
export const MSTEST_PACKAGES: readonly PackageRef[] = [
  { id: 'MSTest.TestFramework', version: '3.6.4' },
  { id: 'MSTest.TestAdapter', version: '3.6.4' },
  { id: 'Microsoft.NET.Test.Sdk', version: '17.11.1' },
];

/** Every framework the Test Explorer claims to support, for table-driven suites. */
export const TEST_FRAMEWORKS = {
  xunit: XUNIT_PACKAGES,
  nunit: NUNIT_PACKAGES,
  mstest: MSTEST_PACKAGES,
} as const;

// `XMLBuilder` is marked deprecated in fast-xml-parser 5 in favour of the
// `fast-xml-builder` package, which was first published days ago. Project XML is
// a STRUCTURED file, so it must come out of a real serializer rather than string
// concatenation — and taking a brand-new package into the extension's dependency
// tree purely to author a test fixture is a worse trade than keeping the still
// shipping API of a library `src/test-coverage.ts` already depends on. Revisit
// once `fast-xml-builder` has a track record.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- see above; the replacement package is days old
const projectBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
});

/** Everything a fixture project file can declare. */
export interface ProjectOptions {
  readonly packages?: readonly PackageRef[];
  /** `<Compile Include>` entries. F# needs them; C# projects glob by default. */
  readonly compileIncludes?: readonly string[];
  /** `<ProjectReference Include>` entries, relative to the project directory. */
  readonly projectReferences?: readonly string[];
  /**
   * Extra `<PropertyGroup>` entries, merged over the pinned defaults.
   *
   * A run/debug fixture needs `OutputType`, and the cases in
   * [DEBUG-FEATURES-LAUNCH-BUILD] need `AssemblyName`, `OutputPath`,
   * `TargetFramework(s)` and `RuntimeIdentifier` too. They go through the same
   * XML writer as everything else — a fixture must never splice project XML.
   */
  readonly properties?: Readonly<Record<string, string>>;
}

/** The pinned defaults every fixture project starts from. */
const DEFAULT_PROPERTIES: Readonly<Record<string, string>> = {
  TargetFramework: 'net10.0',
  IsPackable: 'false',
  EnableMSTestRunner: 'false',
  TestingPlatformDotnetTestSupport: 'false',
};

/**
 * The pinned defaults with `properties` merged over them.
 *
 * `TargetFrameworks` (plural) REPLACES the singular default rather than joining
 * it: MSBuild treats a project declaring both as single-targeted, so a fixture
 * meant to be multi-targeted would silently build one TFM and the multi-target
 * cases of [DEBUG-FEATURES-LAUNCH-BUILD] would assert nothing.
 */
function mergeProperties(
  properties: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_PROPERTIES, ...(properties ?? {}) };
  if (properties?.TargetFrameworks !== undefined) delete merged.TargetFramework;
  return merged;
}

/**
 * Project XML for a fixture project.
 *
 * `EnableMSTestRunner` / `TestingPlatformDotnetTestSupport` are pinned off so
 * the fixture runs under VSTest whichever SDK the agent has. Microsoft.Testing
 * .Platform changes both the `--list-tests` output and whether `dotnet vstest`
 * can load the assembly at all, and a fixture that silently switched runners
 * would be asserting a different code path on different machines.
 */
export function buildProjectXml(options: ProjectOptions): string {
  const itemGroups: object[] = [];
  const compile = options.compileIncludes ?? [];
  const references = options.projectReferences ?? [];
  const packages = options.packages ?? [];
  if (compile.length > 0) {
    itemGroups.push({ Compile: compile.map((include) => ({ '@_Include': include })) });
  }
  if (references.length > 0) {
    itemGroups.push({
      ProjectReference: references.map((include) => ({ '@_Include': include })),
    });
  }
  if (packages.length > 0) {
    itemGroups.push({
      PackageReference: packages.map((pkg) => ({ '@_Include': pkg.id, '@_Version': pkg.version })),
    });
  }
  const xml: string = projectBuilder.build({
    Project: {
      '@_Sdk': 'Microsoft.NET.Sdk',
      PropertyGroup: mergeProperties(options.properties),
      ItemGroup: itemGroups,
    },
  });
  return xml.trimStart();
}

/** Project XML for a test project: packages plus any explicit compile order. */
export function projectXml(
  packages: readonly PackageRef[],
  ...compileIncludes: readonly string[]
): string {
  return buildProjectXml({ packages, compileIncludes });
}

/**
 * Project XML for a plain LIBRARY — no test packages at all.
 *
 * A coverage run needs something to cover. `coverlet.collector` leaves the test
 * assembly out of its report by default (`IncludeTestAssembly` is false), so a
 * "solution" made only of test projects produces a valid but EMPTY Cobertura
 * document. A real user has a library and a test project that references it,
 * and that is what a coverage fixture has to be.
 */
export function libraryProjectXml(...compileIncludes: readonly string[]): string {
  return buildProjectXml({ compileIncludes });
}

/** Write a fixture project (project file + single source file); returns its dir. */
export function writeProject(
  dir: string,
  projectFileName: string,
  projectContent: string,
  sourceFileName: string,
  sourceContent: string,
): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, projectFileName), projectContent, 'utf8');
  fs.writeFileSync(path.join(dir, sourceFileName), sourceContent, 'utf8');
  return dir;
}

/** Run a `dotnet` command, resolving stdout or rejecting with stderr. */
export async function dotnet(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = FIXTURE_BUILD_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'dotnet',
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en-US' },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(new Error(`dotnet ${args.join(' ')} failed: ${stderr || error.message}\n${stdout}`));
      },
    );
  });
}

/**
 * Build a REAL solution the way a user's project is laid out and return its
 * path. `dotnet new sln` emits `.slnx` on .NET 10 and `.sln` on older SDKs, so
 * the produced file is detected rather than assumed.
 */
export async function createSolution(
  root: string,
  name: string,
  projectDirs: readonly string[],
): Promise<string> {
  await dotnet(['new', 'sln', '--name', name], root);
  const solutionFile = fs
    .readdirSync(root)
    .find((entry) => entry === `${name}.sln` || entry === `${name}.slnx`);
  if (solutionFile === undefined) {
    throw new Error(`dotnet new sln produced neither ${name}.sln nor ${name}.slnx in ${root}`);
  }
  const solutionPath = path.join(root, solutionFile);
  if (projectDirs.length > 0) {
    await dotnet(['sln', solutionPath, 'add', ...projectDirs], root);
  }
  return solutionPath;
}

/** Warm the FULL VSTest discovery path (restore + build + adapter JIT) once. */
export async function warmDiscovery(solutionPath: string, cwd: string): Promise<string> {
  return dotnet(['test', solutionPath, '--list-tests', '--nologo', '--verbosity', 'quiet'], cwd);
}

/** The shared framework whose installed runtimes decide what a test host can run. */
const NETCORE_APP = 'Microsoft.NETCore.App';

/**
 * The MAJOR version of a `Microsoft.NETCore.App <version> [<path>]` line, or
 * `undefined` for any other line `dotnet --list-runtimes` prints (ASP.NET Core
 * and the Windows Desktop pack announce themselves the same way).
 */
function netCoreAppMajor(line: string): number | undefined {
  if (!line.startsWith(`${NETCORE_APP} `)) return undefined;
  const version = line.slice(NETCORE_APP.length + 1).split(' ')[0] ?? '';
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? undefined : major;
}

/**
 * The two NEWEST target-framework monikers this agent can actually RUN, oldest
 * first — the `<TargetFrameworks>` a multi-targeted fixture must declare.
 *
 * Pinning the pair does not work: a fixture whose second framework has no
 * installed runtime never gets a test host, so VSTest never announces its
 * assembly and the project silently degrades to a single target — which would
 * make a multi-targeting regression suite pass vacuously. Agents disagree about
 * which runtimes they carry (a developer box and a CI runner rarely match), so
 * the pair is READ off the machine. The two NEWEST are taken rather than the
 * oldest and the newest because an out-of-support moniker makes the SDK
 * complain about the fixture instead of building it.
 */
export async function installedFrameworkPair(cwd: string): Promise<string[]> {
  const output = await dotnet(['--list-runtimes'], cwd);
  const majors = new Set<number>();
  for (const raw of output.split('\n')) {
    const major = netCoreAppMajor(raw.trim());
    if (major !== undefined) majors.add(major);
  }
  const newest = [...majors].sort((left, right) => right - left).slice(0, 2);
  if (newest.length < 2) {
    throw new Error(
      `multi-targeting needs two runnable ${NETCORE_APP} runtimes; this agent has: ${
        [...majors].join(', ') || '(none)'
      }`,
    );
  }
  return newest.sort((left, right) => left - right).map((major) => `net${String(major)}.0`);
}
