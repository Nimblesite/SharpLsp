/**
 * The shape a discovery sweep reports, whichever runner produced it.
 *
 * Both runners fill the same model — VSTest through
 * `dotnet vstest --ListFullyQualifiedTests`, Microsoft.Testing.Platform through
 * a module's own `--list-tests json` — so the Test Explorer builds one tree and
 * the two paths never diverge past this point.
 *
 * Implements [TEST-DISCOVERY-FQN] and [TEST-MTP-DISCOVERY].
 */

/** The outcome of enumerating one target. Never an exception. */
export interface TestListing {
  /** Fully-qualified names, in discovery order, de-duplicated. */
  readonly names: readonly string[];
  /** True when the enumeration ran to completion (so an empty list is real). */
  readonly ok: boolean;
  /** Diagnostics worth writing to the extension log. */
  readonly warnings: readonly string[];
  /**
   * The names grouped by the assembly that contributed them — the grouping the
   * Test Explorer renders as Assembly → Namespace → Class → Test. Empty for
   * the weaker display-name fallback, which cannot attribute names.
   */
  readonly byAssembly: readonly TestAssemblyListing[];
  /**
   * How to RUN what was discovered, when the runner was
   * Microsoft.Testing.Platform. Absent for a VSTest sweep, whose ids are the
   * filter values themselves. Spec: [TEST-MTP-RUN].
   */
  readonly mtp?: MtpRunPlan;
  /**
   * Source location per test id, when the runner reported one. The VSTest path
   * reports none; MTP reports one for every framework except NUnit.
   */
  readonly locations?: ReadonlyMap<string, TestLocation>;
}

/** Where a test is written, as the discovery pass reported it. */
export interface TestLocation {
  readonly file: string;
  /** 1-based first line, when the framework reported one. */
  readonly line: number | undefined;
}

/** Everything an MTP run needs that the test ids do not carry themselves. */
export interface MtpRunPlan {
  readonly modules: readonly MtpModuleRun[];
}

/** One test module, and the uids each of its test ids owns. */
export interface MtpModuleRun {
  /** Absolute path of the built test module. */
  readonly modulePath: string;
  /** Test id to the `--filter-uid` values that run it. */
  readonly uidsById: ReadonlyMap<string, readonly string[]>;
}

/** One built test assembly and the fully-qualified names it contributed. */
export interface TestAssemblyListing {
  /** Assembly file name without extension — the tree's root label. */
  readonly name: string;
  /** Absolute path of the built assembly — the stable, unique group id. */
  readonly path: string;
  /** Fully-qualified test names this assembly contributed, in listing order. */
  readonly names: readonly string[];
}

/**
 * Collapse the assemblies ONE multi-targeted project produced into one listing.
 *
 * `dotnet test --list-tests` announces a `Test run for …` banner per TARGET
 * FRAMEWORK, so a project declaring `<TargetFrameworks>net8.0;net9.0</…>` reports
 * two assemblies carrying the same file name under different
 * `bin/<config>/<tfm>/` directories. That is one project, and so one root of the
 * Assembly → Namespace → Class → Test tree: keeping them apart rendered every
 * namespace, class and test of that project TWICE, under two labels the user
 * cannot tell apart.
 *
 * Names are UNIONED, never taken from whichever framework was announced first: a
 * test compiled behind `#if NET8_0` exists in only one of the assemblies, and
 * dropping it would trade a duplicated tree for a missing test. The surviving
 * path is the identity the frameworks SHARE (see {@link sharedOutputPath}), so
 * the group ids the tree builds from it stay put across sweeps however the
 * build ordered its banners.
 */
export function mergeMultiTargeted(
  listings: readonly TestAssemblyListing[],
): TestAssemblyListing[] {
  const merged = new Map<string, { paths: string[]; names: string[] }>();
  for (const listing of listings) {
    const existing = merged.get(listing.name);
    if (existing === undefined) {
      merged.set(listing.name, { paths: [listing.path], names: [...listing.names] });
      continue;
    }
    existing.paths.push(listing.path);
    existing.names.push(...listing.names);
  }
  return [...merged].map(([name, entry]) => ({
    name,
    path: sharedOutputPath(entry.paths),
    names: [...new Set(entry.names)],
  }));
}

/**
 * The identity several builds of ONE assembly share.
 *
 * Two target frameworks put the same assembly under `bin/<config>/net8.0/` and
 * `bin/<config>/net9.0/`, so their paths agree everywhere except the segments
 * that name a build. Keeping one of them as the merged group id keys the whole
 * project's tree on a framework it merely happens to target: the id moves the
 * moment the build announces its banners in another order, and a project
 * targeting four frameworks gets a row identified by exactly one of them.
 *
 * Taking the common prefix back to its last separator and re-attaching the file
 * name leaves what every build of the project agrees on. A project with one
 * target framework has nothing to reconcile and keeps its real path.
 */
function sharedOutputPath(paths: readonly string[]): string {
  const [first, ...rest] = paths;
  if (first === undefined) return '';
  if (rest.length === 0) return first;
  const shared = rest.reduce(commonPrefix, first);
  return shared.slice(0, lastSeparator(shared) + 1) + first.slice(lastSeparator(first) + 1);
}

/** The leading characters two paths agree on. */
function commonPrefix(left: string, right: string): string {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return left.slice(0, index);
}

/**
 * Index of the last `/` or `\`, or -1. Both are checked rather than `path.sep`
 * because the separator comes from whichever host BUILT the listing, which is
 * not necessarily the one reading it.
 */
function lastSeparator(value: string): number {
  return Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
}

/**
 * One run plan for every target of a sweep.
 *
 * A workspace with several folders enumerates each one, and a run selects tests
 * across all of them. Concatenating the modules keeps that one invocation set;
 * an empty result means the sweep found no MTP module at all, and the VSTest
 * path stays in charge.
 */
export function mergePlans(plans: readonly MtpRunPlan[]): MtpRunPlan | undefined {
  const modules = plans.flatMap((plan) => [...plan.modules]);
  return modules.length === 0 ? undefined : { modules };
}
