// [SE-ACTIONS-BUILD-FIXTURES], clause by clause, asked of the .NET SDK's own
// solution model rather than of the text of the files.
//
// fixture-solutions.test.ts proves the BUILD outcome: every solution × every
// configuration produces all three assemblies. This suite proves the CONTRACT
// behind it, where the spec states it:
//
//   • "The `.sln` MUST declare both solution configurations and each project's
//     active/build mapping." — `dotnet sln migrate` reads the `.sln` with the
//     SDK's solution parser and writes an `.slnx`; any project a configuration
//     does not build comes out as `<Build Solution="Release|*" Project="false"/>`,
//     and any configuration set other than the default Debug + Release comes out
//     as a `<Configurations>` element. A clean migration is the mapping, proven.
//   • "Every solution offered … MUST build all three declared projects" — both
//     files declare the SAME three projects, as `dotnet sln list` reports them.
//   • "These projects are semantic-test libraries, not .NET test projects. An
//     empty test listing for these libraries is correct" — MSBuild evaluates
//     none of them as a test project or a Testing Platform application, none
//     references a test framework, and discovery reports an empty listing as
//     SUCCESS, not as a failure.
//
// Covers [SE-ACTIONS-BUILD-FIXTURES].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { evaluateProject, isRunnableOutputType } from '../../msbuild.js';
import { listTests } from '../../test-discovery.js';
import { parseSolutionProjects } from '../../test-mtp-modules.js';
import { isRecord } from '../../utils.js';
import { dotnet } from './dotnet-project-kit';
import { comparablePath, removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The checked-in fixture workspace every e2e suite starts from. */
const WORKSPACE = path.resolve(__dirname, '../../../test-fixtures/workspace');

/** The three projects the spec says every fixture solution declares. */
const DECLARED = [
  'TestFixtures.csproj',
  'fsharp/FSharpFixtures.fsproj',
  'crosslanguage/CSharpConsumer.csproj',
];

/** Packages whose presence would make a fixture library a test project. */
const TEST_FRAMEWORKS = [
  'Microsoft.NET.Test.Sdk',
  'xunit',
  'xunit.v3',
  'NUnit',
  'MSTest',
  'MSTest.TestFramework',
  'Expecto',
];

/**
 * Element paths that may repeat. Keyed on the PATH, not the tag: `<Project>`
 * repeats inside an `.slnx` but is the single root of a project file.
 */
const REPEATED = [
  'Solution.Project',
  'Solution.Project.Build',
  'Project.ItemGroup',
  'Project.ItemGroup.PackageReference',
];

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (_name, jpath) => REPEATED.includes(String(jpath)),
});

/** One `<Project>` of an `.slnx`: its path, and every build override it carries. */
interface SlnxProject {
  readonly path: string;
  readonly overrides: readonly unknown[];
}

/** The projects and the explicit configuration set of an `.slnx` document. */
interface Slnx {
  readonly projects: readonly SlnxProject[];
  readonly configurations: unknown;
}

/** Parse an `.slnx` with a real XML parser; its paths use `/` whatever the host. */
function parseSlnx(file: string): Slnx {
  const parsed: unknown = xml.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(isRecord(parsed) && isRecord(parsed.Solution), `${file} is a <Solution> document`);
  const projects: unknown[] = Array.isArray(parsed.Solution.Project) ? parsed.Solution.Project : [];
  return {
    projects: projects.map((project) => {
      assert.ok(isRecord(project), `${file}: every <Project> is an element`);
      const overrides: unknown[] = Array.isArray(project.Build) ? project.Build : [];
      return { path: String(project['@_Path']).split('\\').join('/'), overrides };
    }),
    configurations: parsed.Solution.Configurations,
  };
}

/** The package ids a project file references, read from its XML. */
function packagesOf(projectFile: string): string[] {
  const parsed: unknown = xml.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.ok(isRecord(parsed) && isRecord(parsed.Project), `${projectFile} is a <Project>`);
  const groups: unknown[] = Array.isArray(parsed.Project.ItemGroup) ? parsed.Project.ItemGroup : [];
  return groups.flatMap((group) => {
    const references: unknown[] =
      isRecord(group) && Array.isArray(group.PackageReference) ? group.PackageReference : [];
    return references.flatMap((reference) =>
      isRecord(reference) && typeof reference['@_Include'] === 'string'
        ? [reference['@_Include']]
        : [],
    );
  });
}

/** Copy the `.sln` and the three project files — nothing else — to a scratch root. */
function copySolutionSkeleton(root: string): string {
  for (const file of ['TestFixtures.sln', ...DECLARED]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(WORKSPACE, file), path.join(root, file));
  }
  return path.join(root, 'TestFixtures.sln');
}

/** The projects `dotnet sln list` reports for `solution`, as comparable absolute paths. */
async function listedProjects(solution: string): Promise<string[]> {
  const output = await dotnet(['sln', solution, 'list'], path.dirname(solution));
  return parseSolutionProjects(output, path.dirname(solution)).map(comparablePath).sort();
}

suite('Fixture solutions — the configuration mapping and project contract', () => {
  let scratch: string;
  /** What the SDK's solution parser makes of the checked-in `.sln`. */
  let migrated: Slnx;

  suiteSetup(async function () {
    this.timeout(DOTNET_CLI_MS);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-sln-contract-'));
    const solution = copySolutionSkeleton(scratch);
    await dotnet(['sln', solution, 'migrate'], scratch);
    migrated = parseSlnx(path.join(scratch, 'TestFixtures.slnx'));
  });

  suiteTeardown(() => {
    removeDirRecursive(scratch);
  });

  test('the .sln maps EVERY project to build in BOTH Debug and Release', function () {
    const paths = migrated.projects.map((project) => project.path).sort();
    assert.deepStrictEqual(
      paths,
      [...DECLARED].sort(),
      'the .sln declares exactly the three projects',
    );
    for (const project of migrated.projects) {
      assert.deepStrictEqual(
        project.overrides,
        [],
        `${project.path} builds in every configuration`,
      );
    }
    assert.strictEqual(
      migrated.configurations,
      undefined,
      'the .sln declares Debug AND Release, no fewer',
    );
  });

  test('the .sln and the .slnx declare the SAME three projects, and every one exists', async function () {
    this.timeout(DOTNET_CLI_MS);
    const fromSln = await listedProjects(path.join(WORKSPACE, 'TestFixtures.sln'));
    const fromSlnx = await listedProjects(path.join(WORKSPACE, 'TestFixtures.slnx'));
    assert.deepStrictEqual(fromSlnx, fromSln, 'both solution files offer the same projects');
    assert.strictEqual(fromSln.length, DECLARED.length, 'three projects, no more and no fewer');
    for (const project of fromSln) assert.ok(fs.existsSync(project), `${project} is on disk`);
  });

  test('the checked-in .slnx is exactly what the SDK derives from the .sln', function () {
    const checkedIn = parseSlnx(path.join(WORKSPACE, 'TestFixtures.slnx'));
    const sorted = (slnx: Slnx): string[] => slnx.projects.map((project) => project.path).sort();
    assert.deepStrictEqual(sorted(checkedIn), sorted(migrated), 'the two files cannot drift apart');
    for (const project of checkedIn.projects) {
      assert.deepStrictEqual(
        project.overrides,
        [],
        `${project.path} is never excluded from a build`,
      );
    }
    assert.strictEqual(
      checkedIn.configurations,
      undefined,
      'the .slnx keeps the default Debug + Release',
    );
  });

  test('the fixture projects are semantic-test LIBRARIES: no test framework, no test project, no test app', async function () {
    this.timeout(DOTNET_CLI_MS * DECLARED.length);
    for (const relative of DECLARED) {
      const project = path.join(WORKSPACE, relative);
      const packages = packagesOf(project);
      const frameworks = packages.filter((id) => TEST_FRAMEWORKS.includes(id));
      assert.deepStrictEqual(frameworks, [], `${relative} references no test framework`);
      const evaluated = await evaluateProject(project);
      assert.ok(evaluated.ok, `MSBuild evaluates ${relative}`);
      assert.ok(!isRunnableOutputType(evaluated.value.outputType), `${relative} builds a library`);
      assert.ok(
        !evaluated.value.isTestingPlatformApplication,
        `${relative} is no Testing Platform app`,
      );
      const isTestProject = (
        await dotnet(['msbuild', project, '-nologo', '-getProperty:IsTestProject'], WORKSPACE)
      ).trim();
      assert.notStrictEqual(
        isTestProject.toLowerCase(),
        'true',
        `${relative} is no .NET test project`,
      );
    }
  });

  test('discovery over the fixture solution reports an EMPTY listing as success, not as a failure', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const listing = await listTests(path.join(WORKSPACE, 'TestFixtures.sln'));
    assert.ok(
      listing.ok,
      `an empty listing is CORRECT for these libraries: ${listing.warnings.join(' | ')}`,
    );
    assert.deepStrictEqual(listing.names, [], 'no test names, because there are no tests');
    assert.deepStrictEqual(listing.byAssembly, [], 'and no test assembly announced');
    assert.strictEqual(listing.mtp, undefined, 'and no Testing Platform module either');
  });
});
