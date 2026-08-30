/**
 * `dotnet test --filter` expression building.
 *
 * A filter is an EXPRESSION, not a literal: `(`, `)`, `&`, `|`, `=`, `!`, `~`
 * and `\` are grammar, so a fully-qualified name containing any of them has to
 * be escaped before it is substituted in. This is not cosmetic — an NUnit
 * `[TestCase]` FQN is literally `Ns.Class.AddsCase(2,2,4)`, and handing that to
 * VSTest unescaped makes the NUnit adapter throw
 * (`VsTestFilter.get_IsEmpty()`), so the run dies instead of reporting a result.
 *
 * Implements [TEST-FILTER-ESCAPE].
 */

/** Characters VSTest's filter grammar reserves; each is escaped with a backslash. */
const FILTER_METACHARACTERS = new Set(['\\', '(', ')', '&', '|', '=', '!', '~']);

/**
 * Escape a fully-qualified test name for use as a `--filter` value.
 *
 * A membership test over code points rather than a regex replace: the escape has
 * to cover the backslash itself, and a `String.replace` with a non-global regex
 * is the classic incomplete-sanitization bug.
 */
export function escapeFilterValue(fullyQualifiedName: string): string {
  let escaped = '';
  for (const char of fullyQualifiedName) {
    escaped += FILTER_METACHARACTERS.has(char) ? `\\${char}` : char;
  }
  return escaped;
}

/** `FullyQualifiedName=<escaped>` — the clause matching exactly one test. */
export function filterClause(fullyQualifiedName: string): string {
  return `FullyQualifiedName=${escapeFilterValue(fullyQualifiedName)}`;
}

/** OR the per-test clauses together; `|` is the grammar's union operator. */
export function filterExpression(fullyQualifiedNames: readonly string[]): string {
  return fullyQualifiedNames.map(filterClause).join('|');
}

/**
 * Ceiling on the joined `--filter` expression handed to ONE `dotnet test`.
 *
 * Windows caps a process command line at 32 767 characters, and past it
 * Node's `spawn` THROWS SYNCHRONOUSLY (issue: 816 discovered tests, ▶ on the
 * root of the Testing view, `spawn ENAMETOOLONG` rejected the run handler).
 * The filter is one argv entry among several — exe, target, `--logger trx`,
 * `--results-directory <path>` — so the budget keeps the WHOLE vector well
 * under the ceiling. Mirrors `MAX_ASSEMBLY_ARG_CHARS` in discovery.
 */
export const MAX_FILTER_ARG_CHARS = 24_000;

/**
 * Split fully-qualified names into batches whose joined filter expression
 * stays under the Windows command-line ceiling. A single over-budget name
 * still gets its own batch: dropping it silently would lose a runnable test,
 * and splitting a NAME would corrupt the filter.
 *
 * The cost of a name is its escaped clause plus the joining `|` — escaping can
 * GROW the text (every `(` gains a backslash), so the clause is measured, not
 * the raw name.
 */
export function filterBatches(
  fullyQualifiedNames: readonly string[],
  maxChars: number = MAX_FILTER_ARG_CHARS,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let width = 0;
  for (const name of fullyQualifiedNames) {
    const cost = filterClause(name).length + 1;
    if (current.length > 0 && width + cost > maxChars) {
      batches.push(current);
      current = [];
      width = 0;
    }
    current.push(name);
    width += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
