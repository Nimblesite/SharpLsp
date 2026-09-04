/**
 * Recognising a test attribute, and the declaration it belongs to.
 *
 * Pure line inspection, shared by both languages the status lens renders over.
 * Kept out of `test-lens.ts` so the provider file stays about lenses.
 *
 * Implements the attribute half of [TEST-STATUS-LENS] and the framework list in
 * [TEST-OVERVIEW].
 */

/**
 * Attribute markers that identify a member as a test, in either language.
 *
 * ONE list, not one per language: C# writes `[Fact]` and F# writes `[<Fact>]`,
 * but the set of frameworks [TEST-OVERVIEW] supports is the same on both sides,
 * and two lists drift.
 *
 * `DataTestMethod` and `DataRow` are MSTest's data-driven pair. Without them a
 * `[DataRow(1, 2)]` / `[DataTestMethod]` method carried no lens at all — no
 * status, no Run, no Debug — because neither line contains `[TestMethod]`.
 */
const TEST_ATTRIBUTES = [
  'Fact',
  'Theory',
  'Test',
  'TestMethod',
  'TestCase',
  'DataTestMethod',
  'DataRow',
] as const;

/** How far below its attribute a C# signature may sit before the search gives up. */
export const CS_DECLARATION_SPAN = 6;

/** The same for an F# binding, which carries no access modifiers to wrap. */
export const FS_DECLARATION_SPAN = 4;

/** True when `line` carries a C# test attribute, alone or beside a signature. */
export function hasCSharpTestAttribute(line: string): boolean {
  const trimmed = line.trim();
  return TEST_ATTRIBUTES.some(
    (attr) => trimmed.includes(`[${attr}]`) || trimmed.includes(`[${attr}(`),
  );
}

/** The same for F#, whose attributes are written in the angle-bracket form. */
export function hasFSharpTestAttribute(line: string): boolean {
  const trimmed = line.trim();
  return TEST_ATTRIBUTES.some(
    (attr) => trimmed.includes(`[<${attr}>]`) || trimmed.includes(`[<${attr}(`),
  );
}

/** A declaration an attribute belongs to: where it is, and what it is called. */
export interface Declaration {
  readonly line: number;
  readonly name: string;
}

/**
 * The declaration an attribute at `from` belongs to, within `span` lines of it.
 *
 * The LINE is part of the answer, not just the name: a test may carry several
 * attributes (`[DataRow(1, 2)]` above `[DataTestMethod]`, or NUnit's `[Test]`
 * above `[TestCase(2, 2, 4)]`), and the caller needs to know they all resolve
 * to the same member so it renders one lens pair rather than one per attribute.
 */
export function declarationBelow(
  lines: readonly string[],
  from: number,
  span: number,
  nameAt: (line: string) => string | undefined,
): Declaration | undefined {
  const limit = Math.min(from + span, lines.length);
  for (let i = from; i < limit; i++) {
    const name = nameAt(lines[i] ?? '');
    if (name !== undefined) return { line: i, name };
  }
  return undefined;
}
