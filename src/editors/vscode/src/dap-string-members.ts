// String members netcoredbg cannot resolve, answered from the value it already
// rendered.
//
// netcoredbg 3.2.0 walks members through `ICorDebugObjectValue`, and a string
// is an `ICorDebugStringValue`, so ANY member reached through a string receiver
// comes back `The name 'text.Length' does not exist in the current context` —
// even though the adapter evaluated the receiver itself perfectly well. The
// "Expression evaluation quality tiers" table of [DEBUG-FEATURES-VARIABLES]
// marks T2 "Method calls on locals" as Works for Phase 4, so this gap is the
// router's to close.
//
// THE GOVERNING RULE, the same one dap-cast.ts states: emulate only what is
// EXACTLY derivable from the adapter's own rendering. The members below are
// pure functions of the string's characters and nothing else — no culture, no
// allocation, no observable side effect — so answering them here gives the same
// value the debuggee would compute. Anything outside the table (`Split`,
// `Format`, culture-sensitive overloads, anything taking a comparison flag)
// returns undefined and the caller surfaces netcoredbg's own refusal.
import { skipLiteral } from './dap-emulate';
import type { RenderedValue } from './dap-cast';

/** A member access split into the part before the dot and the part after. */
export interface MemberAccess {
  /** Everything left of the final top-level dot. */
  readonly receiver: string;
  /** The member name. */
  readonly member: string;
  /** The argument text inside the call parentheses; empty for a property. */
  readonly args: string;
  /** Whether the member was written as a call. */
  readonly invoked: boolean;
}

/**
 * Split `a.b.C(d)` into receiver `a.b`, member `C`, args `d`.
 *
 * The dot is found by SCANNING, never by pattern: string and char literals are
 * skipped whole and bracket depth is tracked, so `f("a.b").Length` splits at
 * the dot outside the literal and `xs[i.j].Length` at the one outside the
 * brackets. Returns undefined for anything that is not a member access.
 */
export function parseMemberAccess(expression: string): MemberAccess | undefined {
  const dot = lastTopLevelDot(expression);
  if (dot <= 0) return undefined;
  const receiver = expression.slice(0, dot).trim();
  const tail = expression.slice(dot + 1).trim();
  if (receiver === '' || tail === '') return undefined;
  return callOf(tail, receiver) ?? propertyOf(tail, receiver);
}

/** The tail read as `Name(args)`, when it is one. */
function callOf(tail: string, receiver: string): MemberAccess | undefined {
  if (!tail.endsWith(')')) return undefined;
  const open = tail.indexOf('(');
  if (open <= 0) return undefined;
  const member = tail.slice(0, open);
  if (!isIdentifier(member)) return undefined;
  return { receiver, member, args: tail.slice(open + 1, -1).trim(), invoked: true };
}

/** The tail read as a bare property name, when it is one. */
function propertyOf(tail: string, receiver: string): MemberAccess | undefined {
  if (!isIdentifier(tail)) return undefined;
  return { receiver, member: tail, args: '', invoked: false };
}

/** The index of the final dot at bracket depth zero and outside any literal. */
function lastTopLevelDot(expression: string): number {
  let depth = 0;
  let dot = -1;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] ?? '';
    if (character === '"' || character === "'") {
      index = skipLiteral(expression, index) - 1;
    } else if (character === '(' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      depth -= 1;
    } else if (character === '.' && depth === 0) {
      dot = index;
    }
  }
  return dot;
}

/** A C# identifier: a letter or underscore, then letters, digits, underscores. */
function isIdentifier(text: string): boolean {
  if (text === '') return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    const digit = code >= 48 && code <= 57;
    if (!(letter || (digit && index > 0))) return false;
  }
  return true;
}

/** An indexer access split into the collection and the index expression. */
export interface IndexAccess {
  /** Everything left of the final top-level `[`. */
  readonly receiver: string;
  /** The expression between the brackets. */
  readonly index: string;
}

/**
 * Split `a.b[i + 1]` into receiver `a.b` and index `i + 1`.
 *
 * Same scan as `parseMemberAccess`: literals are skipped whole and bracket
 * depth is tracked, so only a trailing indexer at depth zero matches.
 */
export function parseIndexAccess(expression: string): IndexAccess | undefined {
  const trimmed = expression.trim();
  if (!trimmed.endsWith(']')) return undefined;
  const open = lastTopLevelOpenBracket(trimmed);
  if (open <= 0) return undefined;
  const receiver = trimmed.slice(0, open).trim();
  const index = trimmed.slice(open + 1, -1).trim();
  return receiver === '' || index === '' ? undefined : { receiver, index };
}

/** The index of the `[` opening the trailing indexer, or -1. */
function lastTopLevelOpenBracket(expression: string): number {
  let depth = 0;
  for (let index = expression.length - 1; index >= 0; index -= 1) {
    const character = expression[index] ?? '';
    if (character === ']' || character === ')') {
      depth += 1;
    } else if (character === '(') {
      depth -= 1;
    } else if (character === '[') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Whether a rendered value is netcoredbg's rendering of an exception INSTANCE.
 *
 * It renders one as `{Namespace.SomethingException}` with the type to match.
 * On its own this says nothing about whether the expression faulted - a watch
 * on a caught exception renders identically - so callers must pair it with
 * evidence of the fault itself.
 */
export function rendersAsException(value: RenderedValue): boolean {
  return (
    value.type.endsWith('Exception') && value.result.startsWith('{') && value.result.endsWith('}')
  );
}

/** Whether a rendered type is `string` in either of its spellings. */
export function isStringValue(value: RenderedValue): boolean {
  return value.type === 'string' || value.type === 'System.String';
}

/**
 * The value of `member` on the string `value` already rendered, or undefined
 * when this module does not own that member.
 */
export function emulateStringMember(
  access: MemberAccess,
  value: RenderedValue,
): RenderedValue | undefined {
  const text = unrender(value.result);
  if (text === undefined) return undefined;
  if (!access.invoked) return access.member === 'Length' ? intValue(text.length) : undefined;
  const argument = literalArgument(access.args);
  return invokedMember(access.member, text, argument);
}

/** One string member written as a call, applied to `text`. */
function invokedMember(
  member: string,
  text: string,
  argument: string | undefined,
): RenderedValue | undefined {
  if (argument === undefined) {
    return NO_ARGUMENT.get(member)?.(text);
  }
  return ONE_STRING_ARGUMENT.get(member)?.(text, argument);
}

/** Members taking nothing, each a pure function of the characters. */
const NO_ARGUMENT = new Map<string, (text: string) => RenderedValue>([
  ['ToUpper', (text) => stringValue(text.toUpperCase())],
  ['ToLower', (text) => stringValue(text.toLowerCase())],
  ['ToUpperInvariant', (text) => stringValue(text.toUpperCase())],
  ['ToLowerInvariant', (text) => stringValue(text.toLowerCase())],
  ['Trim', (text) => stringValue(text.trim())],
  ['TrimStart', (text) => stringValue(text.trimStart())],
  ['TrimEnd', (text) => stringValue(text.trimEnd())],
  ['ToString', (text) => stringValue(text)],
]);

/** Members taking exactly one STRING literal — ordinal comparisons only. */
const ONE_STRING_ARGUMENT = new Map<string, (text: string, arg: string) => RenderedValue>([
  ['Contains', (text, arg) => boolValue(text.includes(arg))],
  ['StartsWith', (text, arg) => boolValue(text.startsWith(arg))],
  ['EndsWith', (text, arg) => boolValue(text.endsWith(arg))],
  ['IndexOf', (text, arg) => intValue(text.indexOf(arg))],
  ['LastIndexOf', (text, arg) => intValue(text.lastIndexOf(arg))],
]);

/** The argument text read as a single string literal, or undefined. */
function literalArgument(args: string): string | undefined {
  if (args === '') return undefined;
  const unrendered = unrender(args);
  return unrendered;
}

/**
 * The characters behind netcoredbg's rendering of a string.
 *
 * It renders a string wrapped in quotes with the usual C# escapes; anything
 * that is not so wrapped is not a rendered string and is not emulated.
 */
function unrender(rendered: string): string | undefined {
  if (rendered.length < 2 || !rendered.startsWith('"') || !rendered.endsWith('"')) return undefined;
  return unescape(rendered.slice(1, -1));
}

/** The one-character C# escapes a rendered string can contain. */
const ESCAPES = new Map<string, string>([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['0', '\0'],
  ['a', ''],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
  ['\\', '\\'],
  ['"', '"'],
  ["'", "'"],
]);

/** Resolve the escapes in a rendered literal's body. */
function unescape(body: string): string {
  let text = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? '';
    const next = body[index + 1];
    if (character !== '\\' || next === undefined) {
      text += character;
      continue;
    }
    text += ESCAPES.get(next) ?? next;
    index += 1;
  }
  return text;
}

/** A rendered `int`. */
function intValue(value: number): RenderedValue {
  return { result: String(value), type: 'int', variablesReference: 0 };
}

/** A rendered `bool`. */
function boolValue(value: boolean): RenderedValue {
  return { result: String(value), type: 'bool', variablesReference: 0 };
}

/** A rendered `string`, quoted the way netcoredbg quotes one. */
function stringValue(value: string): RenderedValue {
  return { result: `"${value}"`, type: 'string', variablesReference: 0 };
}
