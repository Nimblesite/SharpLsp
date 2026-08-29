// `[DebuggerDisplay]` rendering, emulated where the spec assigns it in Phase 4.
//
// Implements [DEBUG-FEATURES-VARIABLES] "[DebuggerDisplay] attribute rendering
// | variables | P1" and its Phase-4 emulation paragraph: netcoredbg never
// renders the attribute ([DEBUG-ADAPTER-GAPS]), so a decorated object reaches
// the panel as its raw `{Ns.Type}` class name. The router discovers the format
// string through the debuggee's own reflection — `expr.GetType()
// .GetCustomAttributes(true)` is evaluable where `typeof` and multi-argument
// `Attribute.GetCustomAttribute` are not — parses its `{hole}` grammar, and
// replaces the summary line with the evaluated format. The discovery verdict
// is cached per type — one reflection round-trip per type — and the cache is
// dropped on restart and hot reload (`invalidate`), where the attribute text
// itself can change ([DEBUG-FEATURES-HOT-RELOAD]). Hole values are memoized
// per stop (`onNewStop`) and evaluated concurrently, keeping repeated panel
// reads inside [DEBUG-PERFORMANCE]'s variable budget.
//
// Hole results render without their string quotes: the fixture contract for
// `Box({Label},{Value})` is `Box(boxed,8)`, so `,nq` is the panel's default
// and the specifier itself is honored by construction. Failure at ANY point —
// no attribute, an unevaluable hole, a dead frame — returns nothing and the
// raw class-name rendering stands, exactly as the spec's fallback requires.
import type { RetryHost } from './dap-attach';
import { parseDisplayFormat, type DisplayToken } from './dap-emulate';
import { childrenOf, evaluateIn, referenceOf, stringField, unquote } from './dap-values';

const ATTRIBUTE_TYPE = 'System.Diagnostics.DebuggerDisplayAttribute';

/** Bound on the evaluations one rendering may cost the stopped session. */
const MAX_HOLES = 8;

/** Multi-line hole results (F# `%A`-style renderings) fold to one panel line. */
function singleLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}

/** Tokens usable for rendering: parsed, and affordably few holes. */
function boundedTokens(tokens: DisplayToken[] | undefined): DisplayToken[] | undefined {
  if (tokens === undefined) return undefined;
  const holes = tokens.filter((token) => token.kind === 'hole').length;
  return holes > MAX_HOLES ? undefined : tokens;
}

/** Renders `[DebuggerDisplay]` summaries the adapter left as `{Type}`. */
export class DebuggerDisplayEmulator {
  /** type name -> parsed format; `undefined` once a type proved undecorated. */
  private readonly formats = new Map<string, Promise<DisplayToken[] | undefined>>();

  /** `frameId|expression` -> hole value, valid for the current stop only. */
  private readonly holes = new Map<string, Promise<string | undefined>>();

  constructor(private readonly host: RetryHost) {}

  /** Hot reload / restart can change any attribute: forget every format. */
  public invalidate(): void {
    this.formats.clear();
    this.holes.clear();
  }

  /** A fresh stackTrace means fresh frames: hole values may have changed. */
  public onNewStop(): void {
    this.holes.clear();
  }

  /**
   * The attribute-directed summary for `variable`, or nothing to keep raw.
   *
   * Only values netcoredbg rendered as exactly `{TheirType}` — its default
   * for an object it has nothing better for — are candidates: a value the
   * adapter already rendered (a number, a string, a ToString product) is
   * never second-guessed.
   */
  public async display(
    variable: Record<string, unknown>,
    objectExpression: string | undefined,
    frameId: number | undefined,
  ): Promise<string | undefined> {
    const type = stringField(variable, 'type');
    const isRawObject = type !== '' && stringField(variable, 'value') === `{${type}}`;
    if (!isRawObject || objectExpression === undefined || frameId === undefined) return undefined;
    const tokens = await this.formatFor(type, objectExpression, frameId);
    if (tokens === undefined) return undefined;
    return await this.render(tokens, objectExpression, frameId);
  }

  private async formatFor(
    type: string,
    expression: string,
    frameId: number,
  ): Promise<DisplayToken[] | undefined> {
    const cached = this.formats.get(type);
    if (cached !== undefined) return await cached;
    const discovery = this.discoverTokens(type, expression, frameId);
    this.formats.set(type, discovery);
    return await discovery;
  }

  /** The parsed format off the type's own attribute list, or nothing. */
  private async discoverTokens(
    type: string,
    expression: string,
    frameId: number,
  ): Promise<DisplayToken[] | undefined> {
    const list = await evaluateIn(
      this.host,
      frameId,
      `${expression}.GetType().GetCustomAttributes(true)`,
    );
    if (list === undefined) {
      // The probe itself failed (dead frame, transient refusal): retry later
      // instead of marking the type undecorated for the whole session.
      this.formats.delete(type);
      return undefined;
    }
    const format = await this.attributeValue(referenceOf(list));
    return format === undefined ? undefined : boundedTokens(parseDisplayFormat(format));
  }

  /** The `Value` member of the DebuggerDisplay attribute instance, unquoted. */
  private async attributeValue(reference: number): Promise<string | undefined> {
    const attributes = await childrenOf(this.host, reference);
    const decorated = attributes.find((entry) => stringField(entry, 'type') === ATTRIBUTE_TYPE);
    const members = await childrenOf(this.host, referenceOf(decorated));
    const value = members.find((member) => stringField(member, 'name') === 'Value');
    const rendered = value === undefined ? '' : stringField(value, 'value');
    return rendered.startsWith('"') ? unquote(rendered) : undefined;
  }

  /** One hole, evaluated at most once per stop per expression. */
  private async holeValue(expression: string, frameId: number): Promise<string | undefined> {
    const key = `${String(frameId)}|${expression}`;
    const cached = this.holes.get(key);
    if (cached !== undefined) return await cached;
    const evaluation = evaluateIn(this.host, frameId, expression).then((body) =>
      body === undefined ? undefined : unquote(stringField(body, 'result')),
    );
    this.holes.set(key, evaluation);
    return await evaluation;
  }

  /** The format with each hole evaluated against the object, single-line. */
  private async render(
    tokens: readonly DisplayToken[],
    expression: string,
    frameId: number,
  ): Promise<string | undefined> {
    const parts = await Promise.all(
      tokens.map(async (token) =>
        token.kind === 'literal'
          ? token.text
          : await this.holeValue(`${expression}.${token.expression}`, frameId),
      ),
    );
    if (parts.some((part) => part === undefined)) return undefined;
    return singleLine(parts.join(''));
  }
}
