// A framework a multi-targeted test project builds survives a discovery sweep
// whose VSTest banner for it never parsed (#532). On Windows CI CsvHelper's
// tests lost net47 and GitReader's root lost net10.0, with no warning: the
// per-framework banners are written unsynchronised to one stdout, and one that
// did not parse took its framework's tag and profile with it. MSBuild names what
// the project declares; a missing build is listed from its own assembly, and the
// sweep says so. Implements [NETFX-TEST-DISCOVERY].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProjectProperties } from '../../msbuild.js';
import { err, ok, type Result } from '../../result.js';
import { withDeclaredFrameworks, type FrameworkSources } from '../../test-declared-frameworks.js';
import { mergeMultiTargeted } from '../../test-discovery.js';
import { makeAssemblyItem } from '../../test-items.js';
import type { TestAssemblyListing, TestListing } from '../../test-listing-model.js';
import { assertTaggedFor, inFrameworkOrder } from './netfx-test-kit';

const ROOT = path.join(path.parse(process.cwd()).root, 'repo', 'tests', 'Csv.Tests');
const PROJECT = path.join(ROOT, 'Csv.Tests.csproj');
const ASSEMBLY = 'Csv.Tests';
/** CsvHelper's test project: two .NET versions, three .NET Framework ones. */
const DECLARED = ['net9.0', 'net8.0', 'net48', 'net47', 'net462'];
const MONIKERS: Readonly<Record<string, string>> = {
  'net9.0': '.NETCoreApp,Version=v9.0',
  'net8.0': '.NETCoreApp,Version=v8.0',
  'net8.0-windows': '.NETCoreApp,Version=v8.0',
  net48: '.NETFramework,Version=v4.8',
  net47: '.NETFramework,Version=v4.7',
  net462: '.NETFramework,Version=v4.6.2',
};
const SHARED = [
  'Csv.Tests.BooleanConverterTests.ConvertToStringTest',
  'Csv.Tests.BooleanConverterTests.WriteField_TrueValue_UsesValue',
];
/** Behind `#if NET47`: only the net47 build compiles it. */
const NET47_ONLY = 'Csv.Tests.LegacyTests.OnlyOnNet47';

function outputOf(framework: string, name = ASSEMBLY): string {
  return path.join(ROOT, 'bin', 'Debug', framework, `${name}.dll`);
}

function namesOf(framework: string): string[] {
  return framework === 'net47' ? [...SHARED, NET47_ONLY] : [...SHARED];
}

/** What discovery parsed when only `frameworks` announced themselves. */
function announced(frameworks: readonly string[], projectFile?: string): TestListing {
  const one = (framework: string): TestAssemblyListing => ({
    name: ASSEMBLY,
    path: outputOf(framework),
    names: namesOf(framework),
    frameworks: [{ framework, path: outputOf(framework), names: namesOf(framework) }],
  });
  const merged = mergeMultiTargeted(frameworks.map(one));
  const byAssembly = merged.map((each) =>
    projectFile === undefined ? each : { ...each, projectFile },
  );
  const names = [...new Set(byAssembly.flatMap((each) => each.names))];
  return { names, ok: true, warnings: [], byAssembly };
}

function properties(overrides: Partial<ProjectProperties>): ProjectProperties {
  return {
    targetPath: '',
    targetFramework: '',
    targetFrameworks: [],
    targetFrameworkMoniker: '',
    outputType: 'Library',
    isTestingPlatformApplication: false,
    ...overrides,
  };
}

interface Fake {
  readonly declared?: readonly string[];
  /** Frameworks whose assembly is on disk; every declared one by default. */
  readonly built?: readonly string[];
  /** The assembly name a pinned evaluation reports, when not this one. */
  readonly outputName?: string;
  readonly broken?: boolean;
}

interface Recorded {
  readonly sources: FrameworkSources;
  /** `project` for an unpinned evaluation, `project|tfm` for a pinned one. */
  readonly evaluated: string[];
  readonly listed: string[];
}

/** MSBuild, VSTest and the disk as `fake` says, recording every question. */
function fakeSources(fake: Fake = {}): Recorded {
  const evaluated: string[] = [];
  const listed: string[] = [];
  const declared = fake.declared ?? DECLARED;
  const built = new Set((fake.built ?? declared).map((each) => outputOf(each)));
  const evaluate = async (project: string, tfm?: string): Promise<Result<ProjectProperties>> => {
    evaluated.push(tfm === undefined ? project : `${project}|${tfm}`);
    await Promise.resolve();
    if (fake.broken === true) return err('MSB4025: The project file could not be loaded.');
    if (tfm === undefined) return ok(properties({ targetFrameworks: declared }));
    const targetPath = outputOf(tfm, fake.outputName);
    return ok(properties({ targetPath, targetFrameworkMoniker: MONIKERS[tfm] ?? '' }));
  };
  const list = async (assembly: string): Promise<{ names: string[]; warnings: string[] }> => {
    listed.push(assembly);
    await Promise.resolve();
    return { names: namesOf(path.basename(path.dirname(assembly))), warnings: [] };
  };
  return { sources: { evaluate, list, exists: (file) => built.has(file) }, evaluated, listed };
}

function frameworksOf(listing: TestListing): string[] {
  return (listing.byAssembly[0]?.frameworks ?? []).map((build) => build.framework).sort();
}

/** Every declared framework but `lost`, as one sweep parsed them. */
function losing(...lost: string[]): TestListing {
  return announced(DECLARED.filter((each) => !lost.includes(each)));
}

suite(
  'Test Explorer — every declared framework survives a lost banner [NETFX-TEST-DISCOVERY]',
  () => {
    test('every declared framework announced: the listing is untouched and nothing is listed again', async () => {
      for (const declared of [DECLARED, ['net48', 'net8.0']]) {
        const listing = announced(declared);
        const fake = fakeSources({ declared });
        const checked = await withDeclaredFrameworks(listing, [PROJECT], fake.sources);
        assert.strictEqual(checked, listing, `${declared.join(';')}: the very same listing`);
        assert.deepStrictEqual(
          fake.evaluated,
          [PROJECT],
          'one evaluation of the project, unpinned',
        );
        assert.deepStrictEqual(fake.listed, [], 'no assembly is listed a second time');
      }
    });

    test('a framework whose banner never parsed is listed from its own assembly, whichever it was', async () => {
      for (const lost of DECLARED) {
        const fake = fakeSources();
        const checked = await withDeclaredFrameworks(losing(lost), [PROJECT], fake.sources);
        const why = `${lost} lost`;
        assert.deepStrictEqual(
          frameworksOf(checked),
          [...DECLARED].sort(),
          `${why}: all five builds`,
        );
        const build = checked.byAssembly[0]?.frameworks?.find((each) => each.framework === lost);
        assert.strictEqual(build?.path, outputOf(lost), `${why}: its own assembly`);
        assert.deepStrictEqual(build.names, namesOf(lost), `${why}: the names IT lists`);
        assert.deepStrictEqual(
          fake.evaluated,
          [PROJECT, `${PROJECT}|${lost}`],
          `${why}: one pinned evaluation`,
        );
        assert.deepStrictEqual(
          fake.listed,
          [outputOf(lost)],
          `${why}: only that assembly is listed`,
        );
        const said = `No test run announced ${lost} of ${PROJECT}; listed ${outputOf(lost)} directly`;
        assert.deepStrictEqual(checked.warnings, [said], `${why}: the sweep says what it repaired`);
      }
    });

    test('a test only the lost framework compiles comes back, and every test is tagged for every build', async () => {
      const lost = losing('net47');
      const checked = await withDeclaredFrameworks(lost, [PROJECT], fakeSources().sources);
      assert.ok(checked.names.includes(NET47_ONLY), 'the net47-only test is a name of the listing');
      assert.ok(checked.byAssembly[0]?.names.includes(NET47_ONLY), 'and of its assembly');
      const controller = vscode.tests.createTestController(
        'declared-frameworks',
        'Declared frameworks',
      );
      try {
        const context = { controller, uri: vscode.Uri.file(ROOT), locations: undefined };
        const broken = rootOf(context, lost);
        const without = inFrameworkOrder(DECLARED.filter((each) => each !== 'net47'));
        assert.strictEqual(
          broken.description,
          without.join(' · '),
          'unchecked, the root drops net47',
        );
        assertTaggedFor(leaf(broken, SHARED[0] ?? ''), without);
        const root = rootOf(context, checked);
        assert.strictEqual(
          root.description,
          inFrameworkOrder(DECLARED).join(' · '),
          'the root names all five',
        );
        for (const id of SHARED) assertTaggedFor(leaf(root, id), DECLARED);
        assertTaggedFor(leaf(root, NET47_ONLY), ['net47']);
      } finally {
        controller.dispose();
      }
    });

    test('several lost banners are each recovered and each reported', async () => {
      const fake = fakeSources();
      const checked = await withDeclaredFrameworks(
        losing('net9.0', 'net462'),
        [PROJECT],
        fake.sources,
      );
      assert.deepStrictEqual(frameworksOf(checked), [...DECLARED].sort(), 'all five builds');
      assert.deepStrictEqual(
        [...fake.listed].sort(),
        [outputOf('net462'), outputOf('net9.0')].sort(),
      );
      assert.strictEqual(checked.warnings.length, 2, 'one warning per recovered framework');
      for (const lost of ['net9.0', 'net462']) {
        assert.ok(
          checked.warnings.some((line) => line.includes(`announced ${lost} of`)),
          lost,
        );
      }
    });

    test('a two-framework project that announced one is no longer mistaken for single-target', async () => {
      const declared = ['net48', 'net8.0'];
      const listing = announced(['net8.0']);
      assert.strictEqual(
        listing.byAssembly[0]?.path,
        outputOf('net8.0'),
        'before: one build, its own path',
      );
      const checked = await withDeclaredFrameworks(
        listing,
        [PROJECT],
        fakeSources({ declared }).sources,
      );
      assert.deepStrictEqual(frameworksOf(checked), ['net48', 'net8.0'], 'both builds');
      const shared = path.join(ROOT, 'bin', 'Debug', `${ASSEMBLY}.dll`);
      assert.strictEqual(checked.byAssembly[0]?.path, shared, 'the identity both builds share');
      assert.strictEqual(
        checked.byAssembly[0]?.path,
        announced(declared).byAssembly[0]?.path,
        'as a full sweep has',
      );
    });

    test('a declared framework with no built assembly is reported, never invented', async () => {
      const fake = fakeSources({ built: DECLARED.filter((each) => each !== 'net47') });
      const checked = await withDeclaredFrameworks(losing('net47'), [PROJECT], fake.sources);
      assert.deepStrictEqual(
        frameworksOf(checked),
        DECLARED.filter((each) => each !== 'net47').sort(),
      );
      assert.deepStrictEqual(fake.listed, [], 'nothing is listed');
      const said = `${PROJECT} declares net47, but it has no built test assembly`;
      assert.deepStrictEqual(checked.warnings, [said]);
      assert.ok(!checked.names.includes(NET47_ONLY), 'no name is invented for it');
    });

    test('a platform spelling of an announced framework is not missing', async () => {
      const declared = ['net8.0-windows', 'net48'];
      const listing = announced(['net8.0', 'net48']);
      const fake = fakeSources({ declared });
      const checked = await withDeclaredFrameworks(listing, [PROJECT], fake.sources);
      assert.strictEqual(checked, listing, 'net8.0-windows builds the announced net8.0');
      assert.deepStrictEqual(fake.evaluated, [PROJECT, `${PROJECT}|net8.0-windows`]);
      assert.deepStrictEqual(fake.listed, []);
    });

    test("a namesake project whose output is another assembly's is not this assembly's project", async () => {
      const fake = fakeSources({ outputName: 'Csv.Tests.Renamed' });
      const listing = losing('net47');
      const checked = await withDeclaredFrameworks(listing, [PROJECT], fake.sources);
      assert.strictEqual(checked, listing, 'a custom AssemblyName names another assembly');
      assert.deepStrictEqual(fake.listed, []);
    });

    test('the project a declaration named wins over a namesake', async () => {
      const declaredBy = path.join(ROOT, 'elsewhere', 'Real.csproj');
      const fake = fakeSources();
      await withDeclaredFrameworks(announced(DECLARED, declaredBy), [PROJECT], fake.sources);
      assert.deepStrictEqual(fake.evaluated, [declaredBy]);
    });

    test('MTP listings, failed runs and assemblies no project builds are left alone', async () => {
      const mtp = { ...losing('net47'), mtp: { modules: [] } };
      const failed = { ...losing('net47'), partial: true };
      for (const [listing, projects, why] of [
        [mtp, [PROJECT], 'an MTP sweep reports its own frameworks'],
        [failed, [PROJECT], 'a failed run already says why a build is missing'],
        [losing('net47'), [path.join(ROOT, 'Other.csproj')], 'no project builds this assembly'],
      ] as const) {
        const fake = fakeSources();
        assert.strictEqual(
          await withDeclaredFrameworks(listing, projects, fake.sources),
          listing,
          why,
        );
        assert.deepStrictEqual(fake.evaluated, [], `${why}: MSBuild is not asked`);
      }
    });

    test('a project MSBuild cannot evaluate says so and keeps what was listed', async () => {
      const listing = losing('net47');
      const checked = await withDeclaredFrameworks(
        listing,
        [PROJECT],
        fakeSources({ broken: true }).sources,
      );
      assert.deepStrictEqual(checked.byAssembly, listing.byAssembly, 'the listing is kept');
      const said = `Could not evaluate ${PROJECT}: MSB4025: The project file could not be loaded.`;
      assert.deepStrictEqual(checked.warnings, [said]);
    });
  },
);

/** The Test Explorer root `listing`'s one assembly renders as. */
function rootOf(
  context: Parameters<typeof makeAssemblyItem>[0],
  listing: TestListing,
): vscode.TestItem {
  const assembly = listing.byAssembly[0];
  assert.ok(assembly, 'one merged assembly');
  return makeAssemblyItem(context, assembly);
}

/** The row for test `id` anywhere under `root`. */
function leaf(root: vscode.TestItem, id: string): vscode.TestItem {
  const found: vscode.TestItem[] = [];
  const visit = (item: vscode.TestItem): void => {
    if (item.id === id) found.push(item);
    item.children.forEach(visit);
  };
  visit(root);
  const [only, ...others] = found;
  assert.ok(only !== undefined && others.length === 0, `exactly one row for ${id}`);
  return only;
}
