// F# breakpoint conditions, rewritten into the dialect netcoredbg evaluates.
//
// netcoredbg's expression evaluator is C#-only. An F# developer writes the
// equality they write everywhere else in their language — `index = 2` — and the
// adapter reads that as an assignment, so the condition never selects a pass
// and the breakpoint behaves as an unconditional one: the debuggee stops on the
// FIRST hit, not the one the user asked for. The identical C# suite is green
// only because `index == 2` happens to already be the adapter's dialect.
//
// [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rule 3 calls that asymmetry
// non-conforming, and F# is a first-class citizen here, so the translation
// happens at the one place that knows the source language.
//
// Only the two operators whose SPELLING differs are rewritten — `=` and `<>`.
// Everything else in an F# condition that netcoredbg can evaluate at all
// (member access, literals, `&&`, comparisons) is already spelled the same, and
// rewriting more would be inventing an F# evaluator rather than spelling one
// operator the way the evaluator expects.
import { isRecord, recordList, type DapMessage } from './dap-emulate';

/** Source extensions whose conditions are written in F#. */
const FSHARP_EXTENSIONS: readonly string[] = ['.fs', '.fsi', '.fsx', '.fsscript'];

/** Operators that CONTAIN `=` and must survive the rewrite untouched. */
const COMPOSITE_EQUALS: readonly string[] = ['==', '!=', '<=', '>=', '=>'];

/** Whether `path` is F# source, so its conditions are F# expressions. */
export function isFSharpSource(path: string): boolean {
  const lowered = path.toLowerCase();
  return FSHARP_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

/**
 * Rewrite `setBreakpoints` arguments so every condition is C#-spelled.
 *
 * Returns the message unchanged when nothing needed rewriting, so a condition
 * already written in the adapter's dialect is passed through byte for byte.
 */
export function withClrConditions(message: DapMessage): DapMessage {
  const args = isRecord(message.arguments) ? message.arguments : undefined;
  if (args === undefined) return message;
  const breakpoints = recordList(args.breakpoints);
  if (breakpoints.length === 0) return message;
  const rewritten = breakpoints.map(withClrCondition);
  if (rewritten.every((entry, index) => entry === breakpoints[index])) return message;
  return { ...message, arguments: { ...args, breakpoints: rewritten } };
}

/** One breakpoint's condition, C#-spelled. */
function withClrCondition(breakpoint: Record<string, unknown>): Record<string, unknown> {
  const condition = breakpoint.condition;
  if (typeof condition !== 'string' || condition === '') return breakpoint;
  const translated = toClrCondition(condition);
  return translated === condition ? breakpoint : { ...breakpoint, condition: translated };
}

/**
 * `index = 2` -> `index == 2`, `name <> "x"` -> `name != "x"`.
 *
 * Scans the text rather than matching a pattern: string and character literals
 * are skipped whole, so an `=` or `<>` INSIDE a literal is left alone, and a
 * `=` that is already part of `==`, `!=`, `<=`, `>=` or `=>` is not doubled.
 */
export function toClrCondition(condition: string): string {
  let translated = '';
  for (let index = 0; index < condition.length; index += 1) {
    const character = condition[index] ?? '';
    if (character === '"' || character === "'") {
      const end = endOfLiteral(condition, index);
      translated += condition.slice(index, end);
      index = end - 1;
    } else if (condition.startsWith('<>', index)) {
      translated += '!=';
      index += 1;
    } else if (character === '=' && isLoneEquals(condition, index)) {
      translated += '==';
    } else {
      translated += character;
    }
  }
  return translated;
}

/** Whether the `=` at `index` is an equality on its own, not part of a pair. */
function isLoneEquals(condition: string, index: number): boolean {
  const pairs = [condition.slice(index - 1, index + 1), condition.slice(index, index + 2)];
  return !pairs.some((pair) => COMPOSITE_EQUALS.includes(pair));
}

/**
 * The index just past the literal opening at `index`.
 *
 * F# has no verbatim `@"..."` form but does have triple-quoted strings, in
 * which nothing escapes; both are closed by the same quote character, so a
 * backslash is only an escape outside a triple quote.
 */
function endOfLiteral(condition: string, index: number): number {
  const quote = condition[index] ?? '"';
  const triple = condition.startsWith('"""', index);
  if (triple) {
    const close = condition.indexOf('"""', index + 3);
    return close === -1 ? condition.length : close + 3;
  }
  for (let scan = index + 1; scan < condition.length; scan += 1) {
    if (condition[scan] === '\\') {
      scan += 1;
    } else if (condition[scan] === quote) {
      return scan + 1;
    }
  }
  return condition.length;
}
