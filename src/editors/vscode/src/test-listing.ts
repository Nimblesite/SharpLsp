/**
 * Classifying one line of `dotnet test --list-tests` STDOUT.
 *
 * This is the fallback listing: the primary discovery path reads the
 * fully-qualified names VSTest writes to a file ([TEST-DISCOVERY-FQN]), and
 * this one salvages a run whose file never arrived. Every line is classified
 * INDEPENDENTLY — a banner-index slice is not admissible, because parallel
 * project builds interleave two projects' banners and names.
 *
 * It lives apart from `test-discovery.ts` because it is pure: no process, no
 * filesystem, no VS Code. Implements the listing half of [TEST-DISCOVERY-FQN].
 */

import { dedupeLines } from './test-names.js';

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

/** Punctuation a display name never contains but a diagnostic or stack frame does. */
const NON_NAME_CHARACTERS = ['\\', '/', ':', '(', ')', ',', '"', "'", '<', '>', '='];

/**
 * Punctuation that disqualifies a trailing `(...)` from being a test-case
 * argument list.
 *
 * An NUnit `[TestCase(2,2,4)]` prints `…Adds_Case(2,2,4)`: bare values and
 * commas, nothing else. A colon means NAMED arguments — a display name
 * (`Ns.Class.Param(x: 1)`), not the fully-qualified one — and a path separator,
 * scope marker or nested parenthesis means the line is a diagnostic that merely
 * happens to end in `)`.
 */
const NON_ARGUMENT_CHARACTERS = ['\\', '/', ':', '(', ')', '<', '>', '='];

/** A managed stack frame starts with this, and is otherwise dotted-identifier shaped. */
const STACK_FRAME_PREFIX = 'at ';

/**
 * True when `line` is a discovered test's name. Names are dotted identifiers
 * (F# allows embedded spaces) optionally carrying a test-case argument list,
 * and never contain path or scope punctuation — so path lines, the
 * `Proj -> out.dll` mapping, version banners, the summary and, critically,
 * managed STACK FRAMES like
 * `at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs(Object obj, …)` are
 * all excluded. A stack frame slipping through would make a crashed
 * `dotnet test` look like a successful enumeration to `salvageable`.
 */
export function isDiscoveredTestLine(line: string): boolean {
  if (line.includes(' -> ')) return false;
  const name = withoutCaseArguments(line.trim());
  if (name === undefined) return false;
  if (!name.includes('.')) return false;
  if (NON_NAME_CHARACTERS.some((character) => name.includes(character))) return false;
  const lower = name.toLowerCase();
  if (lower.startsWith(STACK_FRAME_PREFIX)) return false;
  return !NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * `line` with a trailing test-case argument list removed, or `undefined` when
 * what is inside the parentheses is not one.
 *
 * [TEST-DISCOVERY-FQN]'s table requires
 * `Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)` to round-trip: an NUnit
 * `[TestCase]` and an MSTest `[DataRow]` carry their arguments INSIDE the
 * fully-qualified name. Rejecting every line containing a parenthesis or a
 * comma — which is how the shape used to be excluded — dropped every one of
 * them from the fallback listing, so a solution whose fully-qualified pass had
 * failed lost its entire NUnit and MSTest surface instead of degrading to it.
 */
function withoutCaseArguments(line: string): string | undefined {
  if (!line.endsWith(')')) return line;
  const open = line.indexOf('(');
  if (open <= 0) return undefined;
  const args = line.slice(open + 1, -1);
  const admissible = !NON_ARGUMENT_CHARACTERS.some((character) => args.includes(character));
  return admissible ? line.slice(0, open) : undefined;
}

/** Parse `dotnet test --list-tests` output into a de-duplicated list of names. */
export function parseTestList(output: string): string[] {
  return dedupeLines(output, isDiscoveredTestLine);
}
