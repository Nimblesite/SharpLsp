/**
 * Reading the NAME listings VSTest writes, and normalising them into the ids the
 * Test Explorer keys on.
 *
 * An id has to be one value three separate things agree about: the tree, the
 * `--filter FullyQualifiedName=` clause a run substitutes it into, and the
 * `className.name` key the TRX report records it under. Anything an adapter adds
 * on top of that name belongs to the adapter, not to the test.
 *
 * Split out of `test-discovery.ts`, which is about RUNNING the two enumeration
 * passes; this module is about reading what they wrote.
 *
 * Implements [TEST-DISCOVERY-FQN].
 */

/** Byte-order mark VSTest may prepend to the fully-qualified test listing. */
const BOM = '﻿';

/** Hex digits: an adapter's appended unique ID and MSBuild's `%XX` both need them. */
export const HEX_DIGITS = new Set('0123456789abcdefABCDEF'.split(''));

/** What an adapter puts between the name and the unique ID it appends. */
const UNIQUE_ID_OPENER = ' (';

/**
 * Width of the unique ID an adapter appends: xUnit's `TestCase.UniqueID` is a
 * SHA-1, rendered as 40 hex digits.
 */
const UNIQUE_ID_LENGTH = 40;

/**
 * The name with any adapter-appended test-case unique ID removed.
 *
 * `dotnet vstest --ListFullyQualifiedTests` does NOT always write a bare
 * `TestCase.FullyQualifiedName`. `xunit.runner.visualstudio` 2.2.0 — still
 * pinned by real-world projects, FluentValidation among them — reports
 * `Ns.Class.Method (d87517d9ff18440615ea8de9ec508cb292e09385)`. Kept as the id,
 * that suffix breaks everything downstream at once: the tree labels a test with
 * a hex blob, `--filter` escapes the parentheses and then matches NO test, and
 * the TRX report keys on the BARE name so no outcome can be attributed back —
 * every test in the project errors with "No result reported" (issue #232).
 *
 * A theory's rows each carry their OWN unique ID, so stripping also collapses
 * them back onto the one name they share, which is the documented contract:
 * "xUnit `[Theory]` … (no row data)".
 *
 * The match is deliberately narrow, because a name may legitimately END in
 * parentheses: [TEST-DISCOVERY-FQN] requires the NUnit `[TestCase]` shape
 * `Ns.Class.Adds_Case(2,2,4)` to round-trip unchanged. It differs on both
 * counts — no space before the `(`, and its contents are not hex — so a
 * SPACE-delimited group of exactly {@link UNIQUE_ID_LENGTH} hex digits is what
 * identifies the decoration. Scanned rather than matched with a regex, per the
 * same reasoning as `escapeFilterValue`.
 */
export function withoutAdapterUniqueId(name: string): string {
  const start = name.length - (UNIQUE_ID_LENGTH + UNIQUE_ID_OPENER.length + 1);
  // `<= 0` and not `< 0`: a name that is NOTHING but a suffix is not a decorated
  // name, and stripping it would leave an empty id.
  if (start <= 0 || !name.endsWith(')')) return name;
  if (name.slice(start, start + UNIQUE_ID_OPENER.length) !== UNIQUE_ID_OPENER) return name;
  const digits = name.slice(start + UNIQUE_ID_OPENER.length, name.length - 1);
  return isHexRun(digits) ? name.slice(0, start) : name;
}

/** Every character is a hex digit. A run of none is not a unique ID. */
function isHexRun(candidate: string): boolean {
  if (candidate.length === 0) return false;
  for (const character of candidate) {
    if (!HEX_DIGITS.has(character)) return false;
  }
  return true;
}

/**
 * Parse the file `--ListTestsTargetPath` wrote: one `TestCase.FullyQualifiedName`
 * per line. Names may contain spaces, so no shape filter is applied — only blank
 * lines and a leading BOM are dropped, and any adapter unique ID is stripped.
 *
 * De-duplicated AFTER stripping, so a theory's rows collapse to the single name
 * they now share instead of surviving as one leaf per row.
 */
export function parseFullyQualifiedTestList(content: string): string[] {
  const body = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  return [...new Set(dedupeLines(body, () => true).map(withoutAdapterUniqueId))];
}

/** Trim, drop blanks, keep `accept`ed lines, preserve order, de-duplicate. */
export function dedupeLines(text: string, accept: (line: string) => boolean): string[] {
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
