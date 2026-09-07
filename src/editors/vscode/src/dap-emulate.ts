// Pure emulation helpers for the DAP proxy: hit-count conditions, logpoint
// message tokenization, and the shared message narrowing the router needs.
//
// Implements the client-side halves of [DEBUG-FEATURES-BREAKPOINTS] rows the
// adapter cannot serve natively ([DEBUG-ADAPTER-GAPS]): netcoredbg ignores
// `hitCondition` and `logMessage` outright, so the DapRouter evaluates them.
// Deliberately free of `vscode` imports so the transforms stay unit-testable
// against captured DAP payloads.

/** One DAP message. The index signature keeps fields this file never names
 *  surviving a spread when the router rewrites a message. */
export interface DapMessage {
  type?: unknown;
  command?: unknown;
  body?: unknown;
  arguments?: unknown;
  seq?: unknown;
  [field: string]: unknown;
}

/** Narrow an unknown to a plain non-null object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow an unknown to a list of plain objects, dropping anything else. */
export function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The `source.path` of a `setBreakpoints`/`gotoTargets` arguments record. */
export function sourcePathOf(args: Record<string, unknown>): string | undefined {
  const source = args.source;
  if (!isRecord(source) || typeof source.path !== 'string') return undefined;
  return source.path;
}

/** One parsed hit-count condition. `satisfies` is the whole semantics. */
export interface HitCondition {
  /** Stop when the visit count passes this relation. */
  satisfies(count: number): boolean;
  /** The source text, for logging. */
  readonly source: string;
}

const RELATIONS: Readonly<Record<string, (count: number, n: number) => boolean>> = {
  '': (count, n) => count === n,
  '==': (count, n) => count === n,
  '!=': (count, n) => count !== n,
  '>=': (count, n) => count >= n,
  '>': (count, n) => count > n,
  '<=': (count, n) => count <= n,
  '<': (count, n) => count < n,
};

/**
 * Parse a DAP `hitCondition`. VS Code documents the grammar as a bare count
 * (`3`), a relation (`>= 2`, `==4`) or a modulo (`%5`, every fifth visit).
 * Anything unparseable is treated as "always stop" — silently ignoring a
 * condition the user typed would turn a hit-count breakpoint into a plain one.
 */
export function parseHitCondition(text: unknown): HitCondition | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const source = text;
  const modulo = /^\s*%\s*(\d+)\s*$/.exec(text);
  if (modulo !== null) {
    const n = Number.parseInt(modulo[1] ?? '0', 10);
    return { source, satisfies: (count) => count > 0 && count % n === 0 };
  }
  const relational = /^\s*(>=|<=|==|!=|>|<)?\s*(\d+)\s*$/.exec(text);
  if (relational !== null) {
    const relation = RELATIONS[relational[1] ?? ''] ?? ((count: number, n: number) => count === n);
    const n = Number.parseInt(relational[2] ?? '0', 10);
    return { source, satisfies: (count) => relation(count, n) };
  }
  return { source, satisfies: () => true };
}

/** One slice of a logpoint message: literal text or a `{expression}` hole. */
export type LogToken =
  | { readonly kind: 'literal'; readonly text: string }
  | {
      readonly kind: 'expression';
      readonly expression: string;
    };

/**
 * Split a logpoint message into literals and `{expression}` holes. The
 * interpolation grammar is VS Code's: every `{...}` is evaluated in the stopped
 * frame; a stray unmatched brace is literal text.
 */
export function tokenizeLogMessage(message: unknown): LogToken[] | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined;
  const tokens: LogToken[] = [];
  let literal = '';
  for (let index = 0; index < message.length; index += 1) {
    const character = message[index] ?? '';
    if (character === '{') {
      const close = message.indexOf('}', index + 1);
      if (close > index) {
        if (literal.length > 0) {
          tokens.push({ kind: 'literal', text: literal });
          literal = '';
        }
        tokens.push({ kind: 'expression', expression: message.slice(index + 1, close) });
        index = close;
        continue;
      }
    }
    literal += character;
  }
  if (literal.length > 0) tokens.push({ kind: 'literal', text: literal });
  return tokens;
}

/**
 * Interpolate evaluated values into tokenized message text. The hole renders as
 * the evaluate result verbatim — VS Code's own logpoints print values, not
 * debug displays, for locals.
 */
export function interpolateLog(tokens: readonly LogToken[], values: readonly string[]): string {
  let text = '';
  let hole = 0;
  for (const token of tokens) {
    if (token.kind === 'literal') text += token.text;
    else text += values[hole++] ?? '{?}';
  }
  return text;
}

/** True when the double quote at `index` opens a C# verbatim string. */
function isVerbatimQuote(text: string, index: number): boolean {
  if (text[index] !== '"') return false;
  const before = text[index - 1];
  return before === '@' || ((before === '$' || before === '@') && text[index - 2] === '@');
}

/**
 * The index just past the string/char literal opening at `index`. Verbatim
 * strings (`@"..."`, `$@"..."`, `@$"..."`) treat backslash as literal text and
 * `""` as the one quote escape; every other literal escapes with backslash.
 */
export function skipLiteral(text: string, index: number): number {
  const quote = text[index];
  const verbatim = isVerbatimQuote(text, index);
  for (let scan = index + 1; scan < text.length; scan += 1) {
    if (!verbatim && text[scan] === '\\') {
      scan += 1;
    } else if (text[scan] === quote) {
      if (verbatim && text[scan + 1] === '"') {
        scan += 1;
      } else {
        return scan + 1;
      }
    }
  }
  return text.length;
}

/** The index of the `closer` matching the `opener` at `open`, or -1. */
function matchingClose(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '"' || character === "'") {
      index = skipLiteral(text, index) - 1;
    } else if (character === opener) {
      depth += 1;
    } else if (character === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** One top-level `==`/`!=`, located by a nesting- and literal-aware walk. */
interface ComparisonHit {
  readonly at: number;
  readonly negated: boolean;
}

/** The `==`/`!=` starting at `index`, when one does. `<=`, `>=`, `=>`, `=` never match. */
function comparisonAt(expression: string, index: number, depth: number): ComparisonHit | undefined {
  if (depth !== 0 || expression[index + 1] !== '=') return undefined;
  const character = expression[index];
  if (character !== '=' && character !== '!') return undefined;
  return { at: index, negated: character === '!' };
}

/** Top-level `==`/`!=` positions, skipping nested groups and literals. */
function topLevelComparisons(expression: string): ComparisonHit[] {
  const hits: ComparisonHit[] = [];
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] ?? '';
    if (character === '"' || character === "'") {
      index = skipLiteral(expression, index) - 1;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    const hit = comparisonAt(expression, index, depth);
    if (hit !== undefined) {
      hits.push(hit);
      index += 1;
    }
  }
  return hits;
}

/** True when any character of `operators` appears at top level of `text`. */
function hasTopLevel(text: string, operators: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '"' || character === "'") {
      index = skipLiteral(text, index) - 1;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    } else if (depth === 0 && operators.includes(character)) {
      return true;
    }
  }
  return false;
}

/**
 * A null test netcoredbg's evaluator refuses outright: `x == null` and
 * `null != x` fail with `0x80070057` or `CS0019`, `x is null` and
 * `x is not null` with `ConstantPattern not implemented` ([DEBUG-ADAPTER-GAPS]
 * "Expression evaluator incomplete"). The T1 row "Null checks, type casts" of
 * [DEBUG-FEATURES-VARIABLES] specifies both as working in Phase 4.
 *
 * The two forms carry DIFFERENT C# semantics, so the pattern is reported:
 * `is null` is always a reference test, while `==`/`!=` dispatches to a
 * user-defined `operator ==` when the operand's type declares one — the
 * router may only answer the `operator` form for types it has proven have no
 * such operator (dap-evaluate.ts).
 */
export interface NullComparison {
  /** The non-null side, still un-evaluated. */
  readonly operand: string;
  /** True for `!=` and `is not null` — the answer flips. */
  readonly negated: boolean;
  /** Which grammar matched: `==`/`!=`, or the `is [not] null` pattern. */
  readonly pattern: 'operator' | 'is';
}

/** Parse a top-level null comparison, or nothing when `expression` is not one. */
export function parseNullComparison(expression: unknown): NullComparison | undefined {
  if (typeof expression !== 'string') return undefined;
  const hits = topLevelComparisons(expression);
  const hit = hits[0];
  if (hits.length !== 1 || hit === undefined) {
    return hits.length === 0 ? parseIsNull(expression) : undefined;
  }
  const left = expression.slice(0, hit.at).trim();
  const right = expression.slice(hit.at + 2).trim();
  const operand = right === 'null' ? left : left === 'null' ? right : '';
  // C# binds `&`, `|`, `^`, `??` and `?:` LOOSER than `==`: in `a && b == null`
  // the null test covers only `b`, so such expressions are never emulated.
  if (operand === '' || hasTopLevel(operand, '&|^?=')) return undefined;
  return { operand, negated: hit.negated, pattern: 'operator' };
}

/** Strip one trailing word, requiring whitespace before it and text ahead of it. */
function stripTrailingWord(text: string, word: string): string | undefined {
  const spaced = text.trimEnd();
  if (!spaced.endsWith(word)) return undefined;
  const head = spaced.slice(0, spaced.length - word.length);
  return head !== '' && head.trimEnd() !== head ? head : undefined;
}

/** `x is null` / `x is not null`, split by hand so `crisis null` never matches. */
function parseIsNull(expression: string): NullComparison | undefined {
  const head = stripTrailingWord(expression, 'null');
  if (head === undefined) return undefined;
  const beforeNot = stripTrailingWord(head, 'not');
  const negated = beforeNot !== undefined;
  const operand = stripTrailingWord(beforeNot ?? head, 'is')?.trim();
  if (operand === undefined || operand === '' || hasTopLevel(operand, '&|^?=')) return undefined;
  return { operand, negated, pattern: 'is' };
}

/** A cast netcoredbg cannot evaluate — `(long)expr` — split into its halves. */
export interface CastSplit {
  readonly targetType: string;
  readonly operand: string;
}

/**
 * Split `(T)expr`. Only called AFTER netcoredbg refused the expression with
 * `CastExpression not implemented`, so the adapter's own Roslyn parse has
 * already ruled out `(a)+(b)`-style parenthesized arithmetic.
 */
export function parseCastExpression(expression: unknown): CastSplit | undefined {
  if (typeof expression !== 'string') return undefined;
  const trimmed = expression.trim();
  if (!trimmed.startsWith('(')) return undefined;
  const close = matchingClose(trimmed, 0, '(', ')');
  if (close < 0) return undefined;
  const targetType = trimmed.slice(1, close).trim();
  const operand = trimmed.slice(close + 1).trim();
  if (targetType === '' || operand === '' || !isUnaryOperand(operand)) return undefined;
  return { targetType, operand };
}

/**
 * True when `text` is one unary/primary operand. A cast binds tighter than
 * every binary operator — `(long)a + b` is `((long)a) + b` — so an operand
 * carrying a top-level binary operator must stay with the adapter's refusal
 * rather than be converted as a whole.
 */
function isUnaryOperand(text: string): boolean {
  let start = 0;
  while (start < text.length && '!+-~ '.includes(text[start] ?? '')) start += 1;
  return !hasTopLevel(text.slice(start), '+-*/%&|^?<>=!');
}

/** One piece of a `[DebuggerDisplay]` format: literal text or a `{hole}`. */
export type DisplayToken =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'hole'; readonly expression: string };

/** Push accumulated literal text as a token; the new accumulator is empty. */
function pushLiteral(tokens: DisplayToken[], literal: string): string {
  if (literal !== '') tokens.push({ kind: 'literal', text: literal });
  return '';
}

/** Split on top-level commas only — `{Method(a, b),nq}` keeps its call intact. */
function topLevelSplit(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '"' || character === "'") {
      index = skipLiteral(text, index) - 1;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      segments.push(text.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(text.slice(start));
  return segments;
}

const SPECIFIER = /^[A-Za-z][A-Za-z0-9]*$/u;

/** The expression inside a hole, with `,nq`-style display specifiers dropped. */
function holeExpression(hole: string): string {
  const segments = topLevelSplit(hole);
  while (segments.length > 1 && SPECIFIER.test((segments[segments.length - 1] ?? '').trim())) {
    segments.pop();
  }
  return segments.join(',').trim();
}

/**
 * Parse a `[DebuggerDisplay]` format — `Box({Label},{Value})` — into literals
 * and expression holes. The grammar differs from the logpoint one above:
 * holes carry `,nq`-style specifiers and may nest braces, so the two parsers
 * stay separate. A malformed format returns nothing and the caller keeps the
 * adapter's raw rendering.
 */
export function parseDisplayFormat(format: string): DisplayToken[] | undefined {
  const tokens: DisplayToken[] = [];
  let literal = '';
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index] ?? '';
    if (character !== '{') {
      literal += character;
      continue;
    }
    const close = matchingClose(format, index, '{', '}');
    const expression = close < 0 ? '' : holeExpression(format.slice(index + 1, close));
    if (expression === '') return undefined;
    literal = pushLiteral(tokens, literal);
    tokens.push({ kind: 'hole', expression });
    index = close;
  }
  pushLiteral(tokens, literal);
  return tokens;
}
