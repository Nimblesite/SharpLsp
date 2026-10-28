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
import { testConfigurationArgs } from './test-configuration';
import { directoryOf, extensionOf, fileNameOf, joinPath } from './paths';
import { DOTNET_TIMEOUT_MS, runDotnet, type DotnetRun } from './dotnet-process.js';
import { batchByWidth, MAX_ARG_CHARS } from './test-batching.js';
import { parseListingDiagnostics, parseTestList } from './test-listing.js';
import { HEX_DIGITS, parseFullyQualifiedTestList } from './test-names.js';
import {
  mergeMultiTargeted,
  type TestAssemblyListing,
  type TestListing,
} from './test-listing-model.js';
import { frameworkMoniker } from './test-frameworks.js';
import { listBuiltMtpTests, listMtpTests, probeMtpTests } from './test-mtp-discovery.js';
import { usesMtpRunner } from './test-mtp.js';
import { removeDirRecursive } from './utils.js';

export { parseFullyQualifiedTestList, withoutAdapterUniqueId } from './test-names.js';
export { isDiscoveredTestLine, parseTestList } from './test-listing.js';
export { mergeMultiTargeted } from './test-listing-model.js';
export type { TestAssemblyListing, TestListing } from './test-listing-model.js';

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
 * A solution with many test projects — each contributing a long
 * `bin/Debug/netX/Name.dll` path — reaches the Windows command-line limit, at
 * which point the spawn fails outright instead of enumerating.
 */
const MAX_ASSEMBLY_ARG_CHARS = MAX_ARG_CHARS;

/** Every FrameworkName a banner closes with carries this: `.NETCoreApp,Version=v10.0`. */
const FRAMEWORK_VERSION = ',Version=';

/** One `Test run for <path> (<framework>)` banner, as announced. */
interface Banner {
  readonly assembly: string;
  /** Short moniker (`net48`), when the banner named its framework. */
  readonly framework?: string;
}

/**
 * Every banner in one stdout line. A solution's VSTest passes write to ONE
 * stdout unsynchronised, so a banner can arrive glued to another pass's text on
 * either side (`The following Tests are available:Test run for …`). One glued
 * after other text counts only when its framework closes it, so a test name
 * that happens to carry the words is never mistaken for a banner.
 * Spec: [TEST-DISCOVERY-FQN], [NETFX-TEST-DISCOVERY].
 */
function bannersIn(line: string): Banner[] {
  const [lead, ...pieces] = line.split(ASSEMBLY_BANNER);
  return pieces.flatMap((rest, index) => {
    const banner =
      framedBanner(rest) ?? (index === 0 && lead === '' ? bareBanner(rest) : undefined);
    return banner === undefined ? [] : [banner];
  });
}

/**
 * `<path> (<FrameworkName>)` at the start of `rest`, whatever was glued after
 * it. The path may itself contain spaces and parentheses, so the framework is
 * the RIGHTMOST group that names one, not the last parenthesis on the line.
 */
function framedBanner(rest: string): Banner | undefined {
  for (let open = rest.lastIndexOf(' ('); open > 0; open = rest.lastIndexOf(' (', open - 1)) {
    const close = rest.indexOf(')', open);
    const name = close === -1 ? '' : rest.slice(open + 2, close);
    if (name.includes(FRAMEWORK_VERSION)) {
      const assembly = rest.slice(0, open).trim();
      return assembly.length === 0 ? undefined : { assembly, framework: frameworkMoniker(name) };
    }
  }
  return undefined;
}

/** A banner opening its line that names no framework: the path is all of it. */
function bareBanner(rest: string): Banner | undefined {
  const suffix = rest.lastIndexOf(' (');
  const assembly = (suffix === -1 ? rest : rest.slice(0, suffix)).trim();
  return assembly.length === 0 ? undefined : { assembly };
}

/** Every banner of `output`, line by line, in the order they were written. */
function announcedBanners(output: string): Banner[] {
  return output.split('\n').flatMap((raw) => bannersIn(raw.trim()));
}

/** Each announced assembly's framework, keyed by its ON-DISK path. */
export function parseAnnouncedFrameworks(output: string): Map<string, string> {
  const frameworks = new Map<string, string>();
  for (const { assembly: announced, framework } of announcedBanners(output)) {
    const assembly = resolveAnnouncedAssembly(announced);
    if (assembly !== undefined && framework !== undefined) frameworks.set(assembly, framework);
  }
  return frameworks;
}

/** One assembly's listing, carrying the framework build it came from. */
function assemblyListing(
  assembly: string,
  names: readonly string[],
  framework: string | undefined,
): TestAssemblyListing {
  return {
    name: fileNameOf(assembly, extensionOf(assembly)),
    path: assembly,
    names,
    ...(framework === undefined ? {} : { frameworks: [{ framework, path: assembly, names }] }),
  };
}

/** Every assembly path a `dotnet test --list-tests` run announced, in order. */
export function parseAnnouncedAssemblies(output: string): string[] {
  return [...new Set(announcedBanners(output).map((banner) => banner.assembly))];
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
  return batchByWidth(assemblies, (assembly) => assembly.length + 3, maxChars);
}

/**
 * Enumerate a directory, solution (.sln/.slnx) or project file. Resolves a
 * {@link TestListing} whatever happens — callers decide what an unusable
 * enumeration means for the tree.
 */
export async function listTests(
  target: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
  noBuild = false,
): Promise<TestListing> {
  const cwd = targetCwd(target);
  if (cwd === undefined) return missingTarget(target);
  // [TEST-MTP-DETECT]: a `global.json` opt-in makes the whole target MTP, and
  // every VSTest command below would fail against it — `--nologo` alone exits
  // with code 5 and lists nothing. Go straight to the runner that can answer.
  if (usesMtpRunner(cwd))
    return await (noBuild ? listBuiltMtpTests : listMtpTests)(target, cwd, timeoutMs);
  const vstest = await listWithVsTest(target, cwd, timeoutMs, noBuild);
  if (vstest.byAssembly.length > 0) return vstest;
  return await withMtpProbe(vstest, target, cwd, timeoutMs, noBuild);
}

/** A listing that could not be produced: empty, with the reason as its warning. */
export function failedListing(reason: string): TestListing {
  return { names: [], ok: false, warnings: [reason], byAssembly: [] };
}

/** A target that is not on disk: nothing to enumerate, and the reason why. */
function missingTarget(target: string): TestListing {
  return failedListing(`Discovery target does not exist: ${target}`);
}

/**
 * VSTest attributed no assembly: either a genuinely empty solution, or an MTP
 * project with no opt-in — which MTP v2 on the .NET 10 SDK makes ordinary,
 * because it removed the VSTest shim. Ask MSBuild before settling for the
 * display-name fallback, which cannot run anything it lists. The probe builds
 * nothing unless MSBuild names an MTP project: the VSTest passes have already
 * restored the target, and a solution with no MTP project must not pay twice.
 */
async function withMtpProbe(
  vstest: TestListing,
  target: string,
  cwd: string,
  timeoutMs: number,
  noBuild: boolean,
): Promise<TestListing> {
  const mtp = await (noBuild ? listBuiltMtpTests : probeMtpTests)(target, cwd, timeoutMs);
  const warnings = [...vstest.warnings, ...mtp.warnings];
  return mtp.names.length === 0 ? { ...vstest, warnings } : { ...mtp, warnings };
}

/** The two VSTest passes: build and announce, then ask for the real names. */
async function listWithVsTest(
  target: string,
  cwd: string,
  timeoutMs: number,
  noBuild: boolean,
): Promise<TestListing> {
  const positional = cwd === target ? [] : [target];
  const args = [
    'test',
    ...positional,
    ...(await testConfigurationArgs(target)),
    ...(noBuild ? ['--no-build', '--no-restore'] : []),
    '--list-tests',
    '--nologo',
    '--verbosity',
    'quiet',
    VSTEST_LISTING_OUTPUT,
  ];
  return await listingFrom(await runDotnet(args, cwd, timeoutMs), cwd, timeoutMs);
}

/**
 * The listing one VSTest pass produced. A run that FAILED yet listed some tests
 * keeps them ([TEST-DISCOVERY-FQN]) and says why the rest are missing: a
 * sibling's build error must never make its tests vanish without a word.
 */
async function listingFrom(run: DotnetRun, cwd: string, timeoutMs: number): Promise<TestListing> {
  const output = usableStdout(run);
  if (output === undefined) return failedListing(listFailure(run));
  const listing = await namesFrom(output, cwd, timeoutMs);
  if (!run.failed) return listing;
  return { ...listing, partial: true, warnings: [partialFailure(run), ...listing.warnings] };
}

/** Why a run that still listed tests failed: its error lines, else its tail. */
function partialFailure(run: DotnetRun): string {
  const errors = parseListingDiagnostics(run.stdout);
  return errors.length === 0
    ? listFailure(run)
    : `dotnet test --list-tests failed for part of the target: ${errors.join('\n')}`;
}

/** Working directory for a target, or `undefined` when it is not on disk. */
function targetCwd(target: string): string | undefined {
  try {
    return fs.statSync(target).isDirectory() ? target : directoryOf(target);
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

/** Prefer VSTest's fully-qualified names; fall back to the display listing. */
async function namesFrom(output: string, cwd: string, timeoutMs: number): Promise<TestListing> {
  const announced = parseAnnouncedAssemblies(output);
  const assemblies = parseTestAssemblies(output);
  const missing = announced.filter((one) => resolveAnnouncedAssembly(one) === undefined);
  const warnings = missing.map((assembly) => `Announced test assembly is missing: ${assembly}`);
  const frameworks = parseAnnouncedFrameworks(output);

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
      byAssembly.push(assemblyListing(assembly, one.names, frameworks.get(assembly)));
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
  if (fallback.length > 0) return { names: fallback, ok: true, warnings, byAssembly: [] };

  // Nothing at all: no assembly, no name. A target `dotnet` REFUSED and still
  // exited 0 lands here, and its diagnostic is the whole answer — the one thing
  // that separates it from a solution that really holds no test
  // ([TEST-MTP-MODULES]). Consulted only here, so a build warning over a
  // solution that did enumerate is never mistaken for a failure.
  const refusals = parseListingDiagnostics(output);
  const ok = assemblies.length === 0 && warnings.length === 0 && refusals.length === 0;
  return { names: [], ok, warnings: [...warnings, ...refusals], byAssembly: [] };
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
export async function listFqnBatch(
  assemblies: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ names: string[]; warnings: string[] }> {
  const dir = makeTempDir();
  if (dir === undefined) {
    return { names: [], warnings: ['Could not create a temp directory for the FQN listing'] };
  }
  const listPath = joinPath(dir, 'tests.txt');
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
    return fs.mkdtempSync(joinPath(os.tmpdir(), 'sharplsp-fqn-'));
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
    removeDirRecursive(dir);
  }
}
