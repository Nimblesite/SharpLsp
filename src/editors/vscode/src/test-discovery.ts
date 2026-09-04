/**
 * Test discovery: enumerate a project/solution's tests and return their
 * fully-qualified names — the ids the Test Explorer keys on and the values
 * `dotnet test --filter FullyQualifiedName=` accepts.
 *
 * `dotnet test --list-tests` prints each test's **DisplayName**, not its
 * FullyQualifiedName. xUnit's DisplayName happens to be `Namespace.Class.Method`
 * so scraping that listing worked for xUnit by accident, but NUnit and MSTest
 * default their DisplayName to the BARE method name — those tests were dropped
 * outright and could never have been run by FQN filter anyway (issue #180).
 *
 * So the listing pass is used only to BUILD the projects and to learn which test
 * assemblies they produced; the names themselves come from
 * `dotnet vstest ... --ListFullyQualifiedTests`, which reports
 * `TestCase.FullyQualifiedName` — identical in shape for xUnit, NUnit and MSTest,
 * in both C# and F#, including idiomatic F# backtick names whose FQN contains
 * SPACES (e.g. `Ns.Module.adds two numbers`). Reading that listing back into ids
 * — including stripping the unique ID some adapters append — is `test-names.ts`.
 *
 * Nothing here throws: a listing that could not be produced comes back as an
 * empty name list plus warnings, so a discovery sweep can decide whether to
 * replace the tree or leave the previous one standing.
 *
 * Implements [TEST-DISCOVERY-FQN].
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOTNET_TIMEOUT_MS, runDotnet, type DotnetRun } from './dotnet-process.js';
import { parseTestList } from './test-listing.js';
import { HEX_DIGITS, parseFullyQualifiedTestList } from './test-names.js';

export { parseFullyQualifiedTestList, withoutAdapterUniqueId } from './test-names.js';
export { isDiscoveredTestLine, parseTestList } from './test-listing.js';

/** VSTest prints one of these per test assembly it was handed. */
const ASSEMBLY_BANNER = 'Test run for ';

/**
 * Keep VSTest on its parseable console-listing path.
 *
 * The SDK terminal logger can consume `--list-tests` output and leave only a
 * build summary. This supported VSTest switch routes the listing through the
 * MSBuild console path on every host, independent of whether stdout is a TTY.
 */
const VSTEST_LISTING_OUTPUT = '-p:VsTestUseMSBuildOutput=false';

/**
 * Ceiling on the assembly arguments handed to a single `dotnet vstest`.
 * Windows caps a process command line at 32 767 characters, and a solution with
 * many test projects — each contributing a long `bin/Debug/netX/Name.dll` path —
 * reaches that, at which point the spawn fails outright instead of enumerating.
 */
const MAX_ASSEMBLY_ARG_CHARS = 24_000;

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
 * Extract the assembly path from a `Test run for <path> (<framework>)` banner.
 * The path may itself contain spaces and parentheses, so the framework suffix is
 * stripped from the RIGHT rather than pattern-matched.
 */
function assemblyFromBanner(line: string): string | undefined {
  if (!line.startsWith(ASSEMBLY_BANNER)) return undefined;
  const rest = line.slice(ASSEMBLY_BANNER.length);
  const suffix = rest.lastIndexOf(' (');
  const candidate = (suffix === -1 ? rest : rest.slice(0, suffix)).trim();
  return candidate.length === 0 ? undefined : candidate;
}

/** Every assembly path a `dotnet test --list-tests` run announced, in order. */
export function parseAnnouncedAssemblies(output: string): string[] {
  const assemblies = new Set<string>();
  for (const raw of output.split('\n')) {
    const assembly = assemblyFromBanner(raw.trim());
    if (assembly !== undefined) assemblies.add(assembly);
  }
  return [...assemblies];
}

/**
 * Undo MSBuild's percent-escaping of a path.
 *
 * MSBuild reserves `%`, `*`, `?`, `@`, `$`, `(`, `)`, `;`, `'` and `,` inside
 * property and item values and encodes them as `%XX`. The assembly path VSTest
 * prints in its `Test run for …` banner comes through MSBuild, so a solution
 * living under `C:\Program Files (x86)\…` — the single most common shape of a
 * Windows path with reserved characters — is announced as
 * `C:\Program Files %28x86%29\…`, which does not exist. Dropping it silently
 * skipped the fully-qualified listing and degraded discovery to DISPLAY names,
 * losing every NUnit and MSTest test and every theory.
 *
 * Decoded by scanning rather than by a regex replace: the escape covers `%`
 * itself, and a non-global `String.replace` is the classic half-done unescape.
 */
export function unescapeMsBuildPath(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const hex = value.slice(index + 1, index + 3);
    if (character !== '%' || !isHexPair(hex)) {
      decoded += character;
      continue;
    }
    decoded += String.fromCharCode(Number.parseInt(hex, 16));
    index += 2;
  }
  return decoded;
}

/**
 * Exactly two hex digits. Checked digit by digit because `Number.parseInt`
 * stops at the first non-hex character — `parseInt('2/', 16)` is 2 — so a
 * truncated escape like `%2/` would otherwise decode to a control character and
 * corrupt the path instead of being left alone.
 */
function isHexPair(candidate: string): boolean {
  if (candidate.length !== 2) return false;
  return HEX_DIGITS.has(candidate[0] ?? '') && HEX_DIGITS.has(candidate[1] ?? '');
}

/** The on-disk spelling of an announced assembly, escaped or not. */
export function resolveAnnouncedAssembly(announced: string): string | undefined {
  if (fs.existsSync(announced)) return announced;
  const unescaped = unescapeMsBuildPath(announced);
  return unescaped !== announced && fs.existsSync(unescaped) ? unescaped : undefined;
}

/** The test assemblies a `dotnet test --list-tests` run reported AND built. */
export function parseTestAssemblies(output: string): string[] {
  return parseAnnouncedAssemblies(output)
    .map((announced) => resolveAnnouncedAssembly(announced))
    .filter((assembly): assembly is string => assembly !== undefined);
}

/**
 * Split assemblies into batches whose joined argument text stays under the
 * Windows command-line ceiling. A single over-long path still gets its own
 * batch: dropping it silently would lose every test in that project.
 */
export function batchAssemblies(
  assemblies: readonly string[],
  maxChars: number = MAX_ASSEMBLY_ARG_CHARS,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let width = 0;
  for (const assembly of assemblies) {
    const cost = assembly.length + 3;
    if (current.length > 0 && width + cost > maxChars) {
      batches.push(current);
      current = [];
      width = 0;
    }
    current.push(assembly);
    width += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Enumerate a directory, solution (.sln/.slnx) or project file. Resolves a
 * {@link TestListing} whatever happens — callers decide what an unusable
 * enumeration means for the tree.
 */
export async function listTests(
  target: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
): Promise<TestListing> {
  const cwd = targetCwd(target);
  if (cwd === undefined) {
    return {
      names: [],
      ok: false,
      warnings: [`Discovery target does not exist: ${target}`],
      byAssembly: [],
    };
  }
  const positional = cwd === target ? [] : [target];
  const args = [
    'test',
    ...positional,
    '--list-tests',
    '--nologo',
    '--verbosity',
    'quiet',
    VSTEST_LISTING_OUTPUT,
  ];
  const run = await runDotnet(args, cwd, timeoutMs);
  const output = usableStdout(run);
  if (output === undefined) {
    return { names: [], ok: false, warnings: [listFailure(run)], byAssembly: [] };
  }
  return await namesFrom(output, cwd, timeoutMs);
}

/** Working directory for a target, or `undefined` when it is not on disk. */
function targetCwd(target: string): string | undefined {
  try {
    return fs.statSync(target).isDirectory() ? target : path.dirname(target);
  } catch {
    return undefined;
  }
}

/**
 * Stdout worth parsing. A non-zero EXIT is tolerated when the output still
 * carried a parseable listing — some SDKs exit non-zero after a successful
 * enumeration when a sibling project fails to build, and dropping the tests that
 * DID enumerate would be worse than surfacing them. A KILLED process (timeout /
 * signal) is always fatal: its stdout is truncated, so treating a partial
 * listing as success would silently drop the tests that had not yet been
 * printed (e.g. the second project in a solution).
 */
function usableStdout(run: DotnetRun): string | undefined {
  if (!run.failed) return run.stdout;
  if (run.killed) return undefined;
  return salvageable(run.stdout) ? run.stdout : undefined;
}

/** True when a failed run still enumerated something usable. */
function salvageable(stdout: string): boolean {
  return parseTestAssemblies(stdout).length > 0 || parseTestList(stdout).length > 0;
}

/** Diagnostic for a `--list-tests` pass whose output cannot be trusted. */
function listFailure(run: DotnetRun): string {
  const cause = run.errorMessage ?? 'unknown failure';
  const output = `${run.stdout}\n${run.stderr}`.trim();
  const detail = output.length === 0 ? '' : `; output: ${output.slice(-2_000)}`;
  return run.killed
    ? `dotnet test --list-tests was killed (timeout or signal); output truncated: ${cause}${detail}`
    : `dotnet test --list-tests failed: ${cause}${detail}`;
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

/** Prefer VSTest's fully-qualified names; fall back to the display listing. */
async function namesFrom(output: string, cwd: string, timeoutMs: number): Promise<TestListing> {
  const announced = parseAnnouncedAssemblies(output);
  const assemblies = parseTestAssemblies(output);
  const missing = announced.filter((one) => resolveAnnouncedAssembly(one) === undefined);
  const warnings = missing.map((assembly) => `Announced test assembly is missing: ${assembly}`);

  if (assemblies.length > 0) {
    // One listing invocation PER assembly: the names a multi-assembly
    // `--ListFullyQualifiedTests` writes are combined with no attribution, and
    // attribution is exactly what the tree's Assembly level needs. A single
    // assembly path is far below the command-line ceiling on its own.
    const byAssembly: TestAssemblyListing[] = [];
    const all: string[] = [];
    for (const assembly of assemblies) {
      const one = await listFqnBatch([assembly], cwd, timeoutMs);
      warnings.push(...one.warnings);
      all.push(...one.names);
      byAssembly.push({
        name: path.basename(assembly, path.extname(assembly)),
        path: assembly,
        names: one.names,
      });
    }
    const names = [...new Set(all)];
    if (names.length > 0) {
      return { names, ok: true, warnings, byAssembly: mergeMultiTargeted(byAssembly) };
    }
  }

  // Fallback: no assembly reported a test case (a Microsoft.Testing.Platform
  // project VSTest cannot load, or a genuinely empty solution). The DisplayName
  // listing is strictly weaker — it cannot attribute names to assemblies, so
  // the tree falls back to flat rows — but never worse than returning nothing.
  //
  // `ok` says whether an EMPTY result can be trusted, because that is what
  // decides whether the caller blanks the Testing view. An enumeration that
  // announced assemblies and then produced nothing at all did not run to
  // completion, whatever the exit code claimed.
  const fallback = parseTestList(output);
  const ok = fallback.length > 0 || (assemblies.length === 0 && warnings.length === 0);
  return { names: fallback, ok, warnings, byAssembly: [] };
}

// Batched multi-assembly listing is intentionally no longer used by discovery:
// per-assembly invocations are what attribute names to assemblies
// (`namesFrom`). `batchAssemblies` stays exported — it documents and tests the
// command-line ceiling that every argument vector built here must respect.

/**
 * Ask VSTest for `TestCase.FullyQualifiedName` on the built assemblies. VSTest
 * writes them to `--ListTestsTargetPath` rather than stdout, so the file is the
 * source of truth: a non-zero exit with a populated file still counts.
 */
/** One `dotnet vstest --ListFullyQualifiedTests` invocation. */
async function listFqnBatch(
  assemblies: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ names: string[]; warnings: string[] }> {
  const dir = makeTempDir();
  if (dir === undefined) {
    return { names: [], warnings: ['Could not create a temp directory for the FQN listing'] };
  }
  const listPath = path.join(dir, 'tests.txt');
  const args = [
    'vstest',
    ...assemblies,
    '--ListFullyQualifiedTests',
    `--ListTestsTargetPath:${listPath}`,
  ];
  const run = await runDotnet(args, cwd, timeoutMs);
  const names = readAndRemove(listPath, dir);
  return { names, warnings: fqnWarnings(run, names.length, assemblies.length) };
}

/** A private directory for one listing, or `undefined` when the disk says no. */
function makeTempDir(): string | undefined {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-fqn-'));
  } catch {
    return undefined;
  }
}

/**
 * Diagnostics for one FQN batch. VSTest can exit ZERO having enumerated nothing
 * — a crashed testhost is the usual cause — so an empty listing from a
 * non-empty batch is reported whatever the exit code said.
 */
function fqnWarnings(run: DotnetRun, nameCount: number, assemblyCount: number): string[] {
  if (nameCount > 0 || assemblyCount === 0) return [];
  const cause = run.errorMessage ?? 'the listing file was empty';
  return [
    `Fully-qualified test listing produced nothing (falling back to display names): ${cause}`,
  ];
}

/** Read the FQN listing, then delete its temp directory either way. */
function readAndRemove(listPath: string, dir: string): string[] {
  try {
    return parseFullyQualifiedTestList(fs.readFileSync(listPath, 'utf8'));
  } catch {
    return [];
  } finally {
    removeTempDir(dir);
  }
}

/**
 * Best-effort delete. `force: true` swallows ENOENT but does NOT retry, and on
 * Windows a directory whose file a just-exited `dotnet` still holds open fails
 * with EPERM/EBUSY — which, thrown from a `finally`, would discard a listing
 * that parsed perfectly well.
 */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // A leaked handle in a child process must not fail discovery.
  }
}
