// Implements [NETFX-TEST-DISCOVERY]: every framework a test project builds is
// accounted for, whether or not VSTest's banner for it was read.
//
// A framework build is learned from the `Test run for <dll> (<framework>)`
// banner, which the per-framework VSTest passes of a multi-targeted project
// write unsynchronised to ONE stdout. When one never parsed, that framework
// vanished from the tree without a word (#532): its tag left every test and its
// `Run on <tfm>` profile went with it. MSBuild decides what a project builds, so
// it is asked. A declared framework no banner named is listed from its own
// assembly, and the sweep says so.
import * as fs from 'node:fs';
import { DOTNET_TIMEOUT_MS } from './dotnet-process.js';
import { evaluateProject, type ProjectProperties } from './msbuild.js';
import { directoryOf, extensionOf, fileNameOf } from './paths.js';
import type { Result } from './result.js';
import { testConfiguration } from './test-configuration.js';
import { listFqnBatch } from './test-discovery.js';
import { frameworkMoniker } from './test-frameworks.js';
import type { FrameworkBuild, TestAssemblyListing, TestListing } from './test-listing-model.js';
import { sharedOutputPath } from './test-listing-model.js';

/** What the check consults: MSBuild, VSTest and the disk. Injected by tests. */
export interface FrameworkSources {
  /** MSBuild's evaluation of `projectFile`, pinned to `framework` when given. */
  readonly evaluate: (
    projectFile: string,
    framework?: string,
  ) => Promise<Result<ProjectProperties>>;
  /** The fully-qualified names one built assembly lists. */
  readonly list: (assembly: string) => Promise<{ names: string[]; warnings: string[] }>;
  readonly exists: (file: string) => boolean;
}

/** One assembly after the check, and what the check had to say about it. */
interface Checked {
  readonly assembly: TestAssemblyListing;
  readonly warnings: readonly string[];
}

/** A declared framework the banners missed: its build, if it has one, and why. */
interface Recovered {
  readonly build?: FrameworkBuild;
  readonly warnings: readonly string[];
}

/**
 * The real sources: MSBuild under the test configuration, VSTest, the disk. The
 * configuration is asked for once, and only when a project is evaluated.
 */
export function frameworkSources(target: string): FrameworkSources {
  let configuration: Promise<string> | undefined;
  return {
    evaluate: async (project, framework) =>
      await evaluateProject(
        project,
        framework,
        await (configuration ??= testConfiguration(target)),
      ),
    list: async (assembly) =>
      await listFqnBatch([assembly], directoryOf(assembly), DOTNET_TIMEOUT_MS),
    exists: (file) => fs.existsSync(file),
  };
}

/**
 * `listing` with every framework its test projects declare accounted for.
 * `projects` is every project of the target, for assemblies no declaration tied
 * to one. A run that failed is left alone: a framework missing there is its
 * failed build, which the listing already reports.
 */
export async function withDeclaredFrameworks(
  listing: TestListing,
  projects: readonly string[],
  sources: FrameworkSources,
): Promise<TestListing> {
  if (listing.mtp !== undefined || listing.partial === true) return listing;
  const checked = await Promise.all(
    listing.byAssembly.map(async (assembly) => await accountFor(assembly, projects, sources)),
  );
  const warnings = checked.flatMap((each) => each.warnings);
  if (warnings.length === 0) return listing;
  const byAssembly = checked.map((each) => each.assembly);
  const names = [...new Set([...listing.names, ...byAssembly.flatMap((each) => each.names)])];
  return { ...listing, names, byAssembly, warnings: [...listing.warnings, ...warnings] };
}

/** The project that builds `assembly`: the one a declaration named, else its namesake. */
function projectOf(assembly: TestAssemblyListing, projects: readonly string[]): string | undefined {
  return assembly.projectFile ?? projects.find((project) => stemOf(project) === assembly.name);
}

function stemOf(file: string): string {
  return fileNameOf(file, extensionOf(file));
}

function builtFor(assembly: TestAssemblyListing, framework: string): boolean {
  return (assembly.frameworks ?? []).some((build) => build.framework === framework);
}

/** One assembly against the frameworks its project declares. */
async function accountFor(
  assembly: TestAssemblyListing,
  projects: readonly string[],
  sources: FrameworkSources,
): Promise<Checked> {
  const project = projectOf(assembly, projects);
  if (project === undefined) return { assembly, warnings: [] };
  const declared = await sources.evaluate(project);
  if (!declared.ok)
    return { assembly, warnings: [`Could not evaluate ${project}: ${declared.error}`] };
  const frameworks = declared.value.targetFrameworks;
  const unseen = frameworks.filter((framework) => !builtFor(assembly, framework));
  if (frameworks.length < 2 || unseen.length === 0) return { assembly, warnings: [] };
  const found = await Promise.all(
    unseen.map(async (framework) => await recover(project, framework, assembly, sources)),
  );
  return {
    assembly: withBuilds(assembly, found),
    warnings: found.flatMap((each) => each.warnings),
  };
}

/**
 * A declared framework no banner named. MSBuild pinned to it says what it is and
 * where its assembly is: a spelling of a framework already announced
 * (`net8.0-windows` builds `net8.0`) is not missing, and an output under another
 * name belongs to another assembly.
 */
async function recover(
  project: string,
  declared: string,
  assembly: TestAssemblyListing,
  sources: FrameworkSources,
): Promise<Recovered> {
  const pinned = await sources.evaluate(project, declared);
  if (!pinned.ok) {
    return { warnings: [`Could not evaluate ${project} for ${declared}: ${pinned.error}`] };
  }
  const moniker = pinned.value.targetFrameworkMoniker;
  const framework = frameworkMoniker(moniker.length > 0 ? moniker : declared);
  const output = pinned.value.targetPath;
  if (builtFor(assembly, framework) || stemOf(output) !== assembly.name) return { warnings: [] };
  if (!sources.exists(output)) {
    return { warnings: [`${project} declares ${framework}, but it has no built test assembly`] };
  }
  return await listed(project, framework, output, sources);
}

/** List a recovered framework's own assembly, saying the banner never named it. */
async function listed(
  project: string,
  framework: string,
  output: string,
  sources: FrameworkSources,
): Promise<Recovered> {
  const { names, warnings } = await sources.list(output);
  const missed = `No test run announced ${framework} of ${project}; listed ${output} directly`;
  return { build: { framework, path: output, names }, warnings: [missed, ...warnings] };
}

/** `assembly` with the recovered builds added: their names, and one shared identity. */
function withBuilds(
  assembly: TestAssemblyListing,
  found: readonly Recovered[],
): TestAssemblyListing {
  const builds = found.flatMap((each) => (each.build === undefined ? [] : [each.build]));
  if (builds.length === 0) return assembly;
  const frameworks = [...(assembly.frameworks ?? []), ...builds];
  return {
    ...assembly,
    path: sharedOutputPath([assembly.path, ...builds.map((build) => build.path)]),
    names: [...new Set([...assembly.names, ...builds.flatMap((build) => build.names)])],
    frameworks,
  };
}
