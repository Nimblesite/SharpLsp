/**
 * Test discovery: enumerate a project/solution's tests via
 * `dotnet test --list-tests` and parse the fully-qualified names out of the
 * VSTest listing.
 *
 * The parser is deliberately format-tolerant. `dotnet test --list-tests` prints
 * one "The following Tests are available:" banner PER project, so a solution
 * with N test projects yields N banners interleaved with build chatter — a
 * banner-index slice is fragile. Instead every output line is classified
 * independently: a line is a test name iff it is a dotted identifier that is not
 * VSTest/MSBuild noise. Crucially this admits idiomatic F# backtick tests, whose
 * xUnit fully-qualified name contains SPACES (e.g. `Ns.Module.adds two numbers`)
 * — the old `^[\w.]+$` filter dropped those, so F# tests never appeared.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
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

/**
 * True when `line` is a discovered test's fully-qualified name. Test FQNs are
 * dotted identifiers (F# allows embedded spaces) and never contain path/scope
 * punctuation, so path lines, the `Proj -> out.dll` mapping, version banners and
 * the summary are all excluded.
 */
export function isDiscoveredTestLine(line: string): boolean {
  if (!line.includes('.')) return false;
  if (/[\\/:]/.test(line)) return false;
  if (line.includes(' -> ')) return false;
  const lower = line.toLowerCase();
  return !NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Parse `dotnet test --list-tests` output into a de-duplicated list of FQNs. */
export function parseTestList(output: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || seen.has(line) || !isDiscoveredTestLine(line)) continue;
    seen.add(line);
    names.push(line);
  }
  return names;
}

/**
 * Run `dotnet test --list-tests` against a directory, solution (.sln/.slnx) or
 * project file and return the discovered fully-qualified test names.
 */
export async function listTests(target: string, timeoutMs = 600_000): Promise<string[]> {
  const isDir = fs.statSync(target).isDirectory();
  const cwd = isDir ? target : path.dirname(target);
  const positional = isDir ? [] : [target];
  const args = ['test', ...positional, '--list-tests', '--nologo', '--verbosity', 'quiet'];
  const output = await runDotnet(args, cwd, timeoutMs);
  return parseTestList(output);
}

/**
 * Invoke `dotnet` and resolve stdout. A non-zero EXIT is tolerated when the
 * output still carried a parseable test list — some SDKs exit non-zero after a
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
        if (!killed && parseTestList(stdout).length > 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() !== '' ? stderr.trim() : error.message));
      },
    );
  });
}
