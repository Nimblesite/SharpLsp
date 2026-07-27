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
 * `dotnet vstest ... --ListFullyQualifiedTests`, which writes
 * `TestCase.FullyQualifiedName` verbatim — identical in shape for xUnit, NUnit
 * and MSTest, in both C# and F#, including idiomatic F# backtick names whose FQN
 * contains SPACES (e.g. `Ns.Module.adds two numbers`).
 *
 * Implements [TEST-DISCOVERY-FQN].
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Lower-cased prefixes of VSTest/MSBuild output lines that are never tests. */
const NOISE_PREFIXES = [
  'the following',
  'test run for',
  'no test',
  'starting test',
  'a total of',
  'passed!',
  'failed!',
  'skipped!',
  'microsoft',
  'copyright',
  'vstest',
  'determining',
  'restored',
  'restore complete',
  'build succeeded',
  'build started',
];

/** VSTest prints one of these per test assembly it was handed. */
const ASSEMBLY_BANNER = 'Test run for ';

/** Byte-order mark VSTest may prepend to the fully-qualified test listing. */
const BOM = '\uFEFF';

/**
 * True when `line` is a discovered test's DISPLAY name. Display names are dotted
 * identifiers (F# allows embedded spaces) and never contain path/scope
 * punctuation, so path lines, the `Proj -> out.dll` mapping, version banners and
 * the summary are all excluded. Used only by the legacy fallback listing.
 */
export function isDiscoveredTestLine(line: string): boolean {
  if (!line.includes('.')) return false;
  if (/[\\/:]/.test(line)) return false;
  if (line.includes(' -> ')) return false;
  const lower = line.toLowerCase();
  return !NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Parse `dotnet test --list-tests` output into a de-duplicated list of names. */
export function parseTestList(output: string): string[] {
  return dedupeLines(output, isDiscoveredTestLine);
}

/**
 * Parse the file `--ListTestsTargetPath` wrote: one `TestCase.FullyQualifiedName`
 * per line, verbatim. Names may contain spaces, so no shape filter is applied —
 * only blank lines and a leading BOM are dropped.
 */
export function parseFullyQualifiedTestList(content: string): string[] {
  const body = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  return dedupeLines(body, () => true);
}

/** Trim, drop blanks, keep `accept`ed lines, preserve order, de-duplicate. */
function dedupeLines(text: string, accept: (line: string) => boolean): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || seen.has(line) || !accept(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
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

/** The test assemblies a `dotnet test --list-tests` run reported and built. */
export function parseTestAssemblies(output: string): string[] {
  const assemblies = new Set<string>();
  for (const raw of output.split('\n')) {
    const assembly = assemblyFromBanner(raw.trim());
    if (assembly !== undefined) assemblies.add(assembly);
  }
  return [...assemblies].filter((assembly) => fs.existsSync(assembly));
}

/**
 * Run `dotnet test --list-tests` against a directory, solution (.sln/.slnx) or
 * project file and return the discovered fully-qualified test names. `onWarn`
 * receives a diagnostic when the FQN pass could not run and the DisplayName
 * listing had to be used instead.
 */
export async function listTests(
  target: string,
  onWarn?: (message: string) => void,
  timeoutMs = 600_000,
): Promise<string[]> {
  const isDir = fs.statSync(target).isDirectory();
  const cwd = isDir ? target : path.dirname(target);
  const positional = isDir ? [] : [target];
  const args = ['test', ...positional, '--list-tests', '--nologo', '--verbosity', 'quiet'];
  const output = await runDotnet(args, cwd, timeoutMs);

  const assemblies = parseTestAssemblies(output);
  const fqns = assemblies.length === 0 ? [] : await listFqns(assemblies, cwd, timeoutMs, onWarn);
  if (fqns.length > 0) return fqns;

  // Fallback: no assembly reported a test case (a Microsoft.Testing.Platform
  // project VSTest cannot load, or a genuinely empty solution). The DisplayName
  // listing is strictly weaker but never worse than returning nothing.
  return parseTestList(output);
}

/**
 * Ask VSTest for `TestCase.FullyQualifiedName` on the built assemblies. VSTest
 * writes them to `--ListTestsTargetPath` rather than stdout, so the file is the
 * source of truth: a non-zero exit with a populated file still counts.
 */
async function listFqns(
  assemblies: string[],
  cwd: string,
  timeoutMs: number,
  onWarn?: (message: string) => void,
): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-fqn-'));
  const listPath = path.join(dir, 'tests.txt');
  try {
    await runDotnet(
      ['vstest', ...assemblies, '--ListFullyQualifiedTests', `--ListTestsTargetPath:${listPath}`],
      cwd,
      timeoutMs,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onWarn?.(`Fully-qualified test listing failed (falling back to display names): ${message}`);
  }
  return readAndRemove(listPath, dir);
}

/** Read the FQN listing, then delete its temp directory either way. */
function readAndRemove(listPath: string, dir: string): string[] {
  try {
    return parseFullyQualifiedTestList(fs.readFileSync(listPath, 'utf8'));
  } catch {
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Invoke `dotnet` and resolve stdout. A non-zero EXIT is tolerated when the
 * output still carried a parseable listing — some SDKs exit non-zero after a
 * successful enumeration when a sibling project fails to build, and dropping the
 * tests that DID enumerate would be worse than surfacing them. A KILLED process
 * (timeout / signal) is always fatal: its stdout is truncated, so treating a
 * partial listing as success would silently drop the tests that had not yet been
 * printed (e.g. the second project in a solution).
 */
async function runDotnet(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'dotnet',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const killed = error.killed === true;
        if (!killed && salvageable(stdout)) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() !== '' ? stderr.trim() : error.message));
      },
    );
  });
}

/** True when a failed run still enumerated something usable. */
function salvageable(stdout: string): boolean {
  return parseTestAssemblies(stdout).length > 0 || parseTestList(stdout).length > 0;
}
