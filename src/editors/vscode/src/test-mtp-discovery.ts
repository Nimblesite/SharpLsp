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
import { DOTNET_TIMEOUT_MS, runDotnet } from './dotnet-process.js';
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
import { scanMtpProjects, type MtpProject } from './test-mtp-modules.js';

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
  const listing = parseMtpTestList(run.stdout);
  const failure =
    listing.tests.length === 0 && run.failed
      ? [`${path.basename(modulePath)} listed no test: ${run.errorMessage ?? 'no detail'}`]
      : [];
  return { tests: listing.tests, warnings: [...listing.warnings, ...failure] };
}

/** The tree root and the run plan one module contributes. */
interface ModuleResult {
  readonly assembly: TestAssemblyListing;
  readonly run: MtpModuleRun;
  readonly locations: ReadonlyMap<string, TestLocation>;
  readonly warnings: readonly string[];
}

/** List one module and shape what it reported for both the tree and the run. */
async function scanModule(
  modulePath: string,
  cwd: string,
  timeoutMs: number,
): Promise<ModuleResult> {
  const listed = await listModule(modulePath, cwd, timeoutMs);
  return {
    assembly: {
      name: path.basename(modulePath, path.extname(modulePath)),
      path: modulePath,
      names: mtpIds(listed.tests),
    },
    run: { modulePath, uidsById: mtpUidsById(listed.tests) },
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
 * Enumerate every MTP test of `target`.
 *
 * `ok` says whether an EMPTY result can be trusted, because that is what
 * decides whether the caller blanks the Testing view. A target with no MTP
 * project at all is a truthful empty answer; a target whose modules all failed
 * to list is not.
 */
export async function listMtpTests(
  target: string,
  cwd: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
): Promise<TestListing> {
  const scan = await scanMtpProjects(target, cwd, timeoutMs);
  const warnings = [...scan.warnings];
  const modules = modulesOf(scan.projects);
  const byAssembly: TestAssemblyListing[] = [];
  const runs: MtpModuleRun[] = [];
  const locations = new Map<string, TestLocation>();
  for (const modulePath of modules) {
    const scanned = await scanModule(modulePath, cwd, timeoutMs);
    warnings.push(...scanned.warnings);
    byAssembly.push(scanned.assembly);
    runs.push(scanned.run);
    collectLocations(locations, scanned.locations);
  }
  const names = [...new Set(byAssembly.flatMap((assembly) => [...assembly.names]))];
  return {
    names,
    ok: names.length > 0 || modules.length === 0,
    warnings,
    byAssembly: mergeMultiTargeted(byAssembly.filter((assembly) => assembly.names.length > 0)),
    mtp: { modules: runs },
    locations,
  };
}
