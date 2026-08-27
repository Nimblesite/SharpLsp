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
