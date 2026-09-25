/**
 * Discovering the tests of Microsoft.Testing.Platform modules.
 *
 * The VSTest path builds with `dotnet test --list-tests` and then asks
 * `dotnet vstest` for the names. This path does the same two things with the
 * MTP commands: `dotnet build` first, then the built MODULE is asked directly.
 *
 * `dotnet test` cannot be used here. It does not forward the `json` argument of
 * `--list-tests` (dotnet/sdk#49754), and the text listing it does forward is
 * display names — which MSTest renders as the BARE method name, the same defect
 * as issue #180. `dotnet exec` runs a module on every platform, with no apphost
 * and no execute bit.
 *
 * Nothing here throws. A module that cannot be listed adds a warning and leaves
 * every other module alone.
 *
 * Implements [TEST-MTP-DISCOVERY].
 */

import * as path from 'node:path';
import { DOTNET_TIMEOUT_MS, runDotnet, type DotnetRun } from './dotnet-process.js';
import {
  mergeMultiTargeted,
  type MtpModuleRun,
  type TestAssemblyListing,
  type TestListing,
  type TestLocation,
} from './test-listing-model.js';
import {
  mtpIds,
  mtpLocationsById,
  mtpUidsById,
  parseMtpTestList,
  rejectedMtpOption,
  type MtpTest,
} from './test-mtp.js';
import {
  probeMtpProjects,
  scanMtpProjects,
  type MtpProject,
  type MtpProjectScan,
} from './test-mtp-modules.js';

/** Ask a module for its tests as JSON, and nothing else. */
export function listArgs(modulePath: string): string[] {
  return ['exec', modulePath, '--list-tests', 'json', '--no-banner', '--no-ansi'];
}

/** One module's tests, plus whatever went wrong asking for them. */
interface ModuleListing {
  readonly tests: readonly MtpTest[];
  readonly warnings: readonly string[];
}

/** Run `--list-tests json` against one module. */
async function listModule(
  modulePath: string,
  cwd: string,
  timeoutMs: number,
): Promise<ModuleListing> {
  const run = await runDotnet(listArgs(modulePath), cwd, timeoutMs);
  const output = `${run.stdout}\n${run.stderr}`;
  const rejected = rejectedMtpOption(output);
  if (rejected !== undefined) {
    return {
      tests: [],
      warnings: [
        `${path.basename(modulePath)} rejected ${rejected}. ` +
          'Its Microsoft.Testing.Platform version is older than 2.3, which is the first ' +
          'to list tests as JSON. Update the test framework package.',
      ],
    };
  }
  return moduleListing(modulePath, run);
}

/** Distinguish a valid empty document from a failed or incomplete listing. */
function moduleListing(modulePath: string, run: DotnetRun): ModuleListing {
  const listing = parseMtpTestList(run.stdout);
  // MTP exit 8 means no tests. Trust it only with a complete, valid empty
  // document; crashes, truncated output and malformed nodes must keep the tree.
  const empty =
    listing.tests.length === 0 &&
    listing.warnings.length === 0 &&
    !run.killed &&
    (!run.failed || run.errorMessage === 'dotnet exited with code 8');
  const failure =
    listing.tests.length === 0 && run.failed && !empty
      ? [`${path.basename(modulePath)} listed no test: ${run.errorMessage ?? 'no detail'}`]
      : [];
  return { tests: listing.tests, warnings: [...listing.warnings, ...failure] };
}

/**
 * `module` with the uids its CURRENT build reports, or unchanged when the
 * listing fails. A valid empty listing clears its previous uids. A uid may hash
 * more than the test's name — `xunit.v3`
 * hashes a theory row's data — so a rebuilt module's uids are read off the
 * rebuilt module, never off the discovery that preceded the edit
 * ([TEST-MTP-RUN]).
 */
export async function relistModule(
  module: MtpModuleRun,
  cwd: string,
  timeoutMs: number,
): Promise<MtpModuleRun> {
  const listed = await listModule(module.modulePath, cwd, timeoutMs);
  return listed.tests.length === 0 && listed.warnings.length > 0
    ? module
    : { ...module, uidsById: mtpUidsById(listed.tests) };
}

/** The tree root and the run plan one module contributes. */
interface ModuleResult {
  readonly assembly: TestAssemblyListing;
  readonly run: MtpModuleRun;
  readonly locations: ReadonlyMap<string, TestLocation>;
  readonly warnings: readonly string[];
}

/** Where a sweep's modules came from, and how long each `dotnet` call may take. */
interface SweepContext {
  /** The discovery target: the build that produces every module listed. */
  readonly target: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** List one module and shape what it reported for both the tree and the run. */
async function scanModule(modulePath: string, sweep: SweepContext): Promise<ModuleResult> {
  const listed = await listModule(modulePath, sweep.cwd, sweep.timeoutMs);
  return {
    assembly: {
      name: path.basename(modulePath, path.extname(modulePath)),
      path: modulePath,
      names: mtpIds(listed.tests),
    },
    run: { modulePath, buildTarget: sweep.target, uidsById: mtpUidsById(listed.tests) },
    locations: mtpLocationsById(listed.tests),
    warnings: listed.warnings,
  };
}

/** Every module of every MTP project the scan found. */
function modulesOf(projects: readonly MtpProject[]): string[] {
  return projects.flatMap((project) => [...project.modules]);
}

/** Merge one module's locations into the sweep-wide map, first report winning. */
function collectLocations(
  into: Map<string, TestLocation>,
  from: ReadonlyMap<string, TestLocation>,
): void {
  for (const [id, location] of from) {
    if (!into.has(id)) into.set(id, location);
  }
}

/**
 * Enumerate every MTP test of `target`, building it first.
 *
 * `ok` says whether an EMPTY result can be trusted, because that is what
 * decides whether the caller blanks the Testing view. A target with no MTP
 * project at all is a truthful empty answer; a target whose modules all failed
 * to list, or whose build `dotnet` refused outright, is not.
 */
export async function listMtpTests(
  target: string,
  cwd: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
): Promise<TestListing> {
  const sweep: SweepContext = { target, cwd, timeoutMs };
  return await listScanned(await scanMtpProjects(target, cwd, timeoutMs), sweep);
}

/**
 * Enumerate every MTP test of a target the VSTest passes have just restored.
 *
 * Unlike {@link listMtpTests} it builds only when a project turns out to BE an
 * MTP test module: this runs after every VSTest sweep that attributed no
 * assembly, so a library solution or a VSTest solution that failed to build
 * must not pay a second build for a probe that finds nothing. Spec:
 * [TEST-MTP-DETECT].
 */
export async function probeMtpTests(
  target: string,
  cwd: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
): Promise<TestListing> {
  const sweep: SweepContext = { target, cwd, timeoutMs };
  return await listScanned(await probeMtpProjects(target, cwd, timeoutMs), sweep);
}

/** What every module of a sweep reported, gathered for the tree and the run. */
interface Gathered {
  readonly byAssembly: TestAssemblyListing[];
  readonly runs: MtpModuleRun[];
  readonly locations: Map<string, TestLocation>;
  readonly warnings: string[];
}

/** List each module in turn; one module's failure never stops the next. */
async function gather(
  modules: readonly string[],
  sweep: SweepContext,
  warnings: readonly string[],
): Promise<Gathered> {
  const gathered: Gathered = {
    byAssembly: [],
    runs: [],
    locations: new Map(),
    warnings: [...warnings],
  };
  for (const modulePath of modules) {
    const scanned = await scanModule(modulePath, sweep);
    gathered.warnings.push(...scanned.warnings);
    gathered.byAssembly.push(scanned.assembly);
    gathered.runs.push(scanned.run);
    collectLocations(gathered.locations, scanned.locations);
  }
  return gathered;
}

/** List every module a project scan found. */
async function listScanned(scan: MtpProjectScan, sweep: SweepContext): Promise<TestListing> {
  const modules = modulesOf(scan.projects);
  const { byAssembly, runs, locations, warnings } = await gather(modules, sweep, scan.warnings);
  const names = [...new Set(byAssembly.flatMap((assembly) => [...assembly.names]))];
  return {
    names,
    // Nothing found is a truthful answer only when nothing went wrong finding
    // it: a build `dotnet` refused (MSB1011) must reach the user as an error
    // row, never as an empty tree.
    ok: names.length > 0 || warnings.length === 0,
    warnings,
    byAssembly: mergeMultiTargeted(byAssembly.filter((assembly) => assembly.names.length > 0)),
    mtp: { modules: runs },
    locations,
  };
}
