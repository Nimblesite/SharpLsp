// C# cast semantics the router performs itself, from netcoredbg's renderings.
//
// Implements the "type casts" half of [DEBUG-FEATURES-VARIABLES]'s T1 tier
// row: netcoredbg 3.2.0 refuses every `CastExpression`, so `dap-evaluate.ts`
// evaluates the operand and converts here. THE GOVERNING RULE: emulate only
// conversions whose exact C# result AND exact netcoredbg rendering are both
// derivable from the operand's rendering — everything else returns nothing
// and the adapter's own refusal reaches the user, because a fabricated
// success is worse than an honest error. Concretely that means: integral and
// floating numeric targets (including their `T?` spellings), `null` into a
// nullable target, the identity cast, and the always-legal boxing cast to
// `object`. Reference downcasts, enum targets, user conversion operators and
// `(string)x` coercions are all refused — the router cannot check them.

/** One evaluated value as netcoredbg rendered it, plus its expansion handle. */
export interface RenderedValue {
  readonly result: string;
  readonly type: string;
  readonly variablesReference: number;
}

interface IntegralTarget {
  readonly bits: number;
  readonly unsigned: boolean;
  readonly rendersAsChar: boolean;
}

/** C#'s integral cast targets, keyed by keyword AND `System.*` spelling. */
const INTEGRAL_TARGETS: ReadonlyMap<string, IntegralTarget> = new Map(
  (
    [
      ['sbyte', 'System.SByte', 8, false, false],
      ['byte', 'System.Byte', 8, true, false],
      ['short', 'System.Int16', 16, false, false],
      ['ushort', 'System.UInt16', 16, true, false],
      ['int', 'System.Int32', 32, false, false],
      ['uint', 'System.UInt32', 32, true, false],
      ['long', 'System.Int64', 64, false, false],
      ['ulong', 'System.UInt64', 64, true, false],
      ['nint', 'System.IntPtr', 64, false, false],
      ['nuint', 'System.UIntPtr', 64, true, false],
      ['char', 'System.Char', 16, true, true],
    ] as const
  ).flatMap(([keyword, alias, bits, unsigned, rendersAsChar]): [string, IntegralTarget][] => [
    [keyword, { bits, unsigned, rendersAsChar }],
    [alias, { bits, unsigned, rendersAsChar }],
  ]),
);

const FLOAT_TARGETS: ReadonlySet<string> = new Set(['float', 'System.Single']);
const DOUBLE_TARGETS: ReadonlySet<string> = new Set(['double', 'System.Double']);
const DECIMAL_TARGETS: ReadonlySet<string> = new Set(['decimal', 'System.Decimal']);

/** `decimal`'s magnitude bound: |value| < 2^96. */
const DECIMAL_LIMIT = 79_228_162_514_264_337_593_543_950_336n;

const INTEGER_TEXT = /^-?\d+$/u;

/** netcoredbg renders a char as `97 'a'`; the leading code is the value. */
const CHAR_RENDERING = /^(\d+) '/u;

/** `T?` / `Nullable<T>` / `System.Nullable<T>` unwrapped to `T`, else `type`. */
function unwrapNullable(type: string): string {
  if (type.endsWith('?')) return type.slice(0, -1).trim();
  for (const wrapper of ['System.Nullable<', 'Nullable<']) {
    if (type.startsWith(wrapper) && type.endsWith('>')) {
      return type.slice(wrapper.length, -1).trim();
    }
  }
  return type;
}

/** The numeric value a netcoredbg rendering carries, or nothing. */
function numericOf(result: string): bigint | number | undefined {
  const text = result.trim();
  if (INTEGER_TEXT.test(text)) return BigInt(text);
  const char = CHAR_RENDERING.exec(text);
  const code = char?.[1];
  if (code !== undefined) return BigInt(code);
  const floating = Number(text);
  return text !== '' && Number.isFinite(floating) ? floating : undefined;
}

/** netcoredbg's escapes for the chars it renders symbolically (`10 '\n'`). */
const CHAR_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0, '\\0'],
  [7, '\\a'],
  [8, '\\b'],
  [9, '\\t'],
  [10, '\\n'],
  [11, '\\v'],
  [12, '\\f'],
  [13, '\\r'],
  [39, "\\'"],
  [92, '\\\\'],
]);

/**
 * A char in netcoredbg's own `10 '\n'` form. Control chars without a standard
 * escape, DEL and lone surrogates are refused — their netcoredbg rendering is
 * unverified, and a lone surrogate is not even a valid JSON string.
 */
function renderChar(code: number): string | undefined {
  const escaped = CHAR_ESCAPES.get(code);
  if (escaped !== undefined) return `${String(code)} '${escaped}'`;
  if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return `${String(code)} '${String.fromCodePoint(code)}'`;
}

/** `(T)value` in C#'s unchecked integral semantics: truncate, then wrap. */
function castToIntegral(
  displayType: string,
  target: IntegralTarget,
  operand: RenderedValue,
): RenderedValue | undefined {
  const value = numericOf(operand.result);
  if (value === undefined) return undefined;
  const whole = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const wrapped = target.unsigned
    ? BigInt.asUintN(target.bits, whole)
    : BigInt.asIntN(target.bits, whole);
  const result = target.rendersAsChar ? renderChar(Number(wrapped)) : wrapped.toString();
  if (result === undefined) return undefined;
  return { result, type: displayType, variablesReference: 0 };
}

/** The shortest decimal spelling that round-trips through `Math.fround`. */
function shortestFloat(value: number): string | undefined {
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return String(candidate);
  }
  return undefined;
}

/** `(float)x` — real single-precision rounding, refusing overflow. */
function castToFloat(displayType: string, operand: RenderedValue): RenderedValue | undefined {
  const value = numericOf(operand.result);
  if (value === undefined) return undefined;
  const rounded = Math.fround(Number(value));
  if (!Number.isFinite(rounded)) return undefined;
  const result = shortestFloat(rounded);
  return result === undefined ? undefined : { result, type: displayType, variablesReference: 0 };
}

/** `(double)x` — JS numbers ARE doubles, and both sides print shortest-round-trip. */
function castToDouble(displayType: string, operand: RenderedValue): RenderedValue | undefined {
  const value = numericOf(operand.result);
  if (value === undefined || !Number.isFinite(Number(value))) return undefined;
  return { result: String(Number(value)), type: displayType, variablesReference: 0 };
}

/** `(decimal)x` — exact for in-range integers; floating operands are refused. */
function castToDecimal(displayType: string, operand: RenderedValue): RenderedValue | undefined {
  const value = numericOf(operand.result);
  if (typeof value !== 'bigint') return undefined;
  if (value >= DECIMAL_LIMIT || value <= -DECIMAL_LIMIT) return undefined;
  return { result: value.toString(), type: displayType, variablesReference: 0 };
}

/** The numeric conversion for `bare`, when `bare` names a numeric target. */
function numericCast(
  displayType: string,
  bare: string,
  operand: RenderedValue,
): RenderedValue | undefined {
  const integral = INTEGRAL_TARGETS.get(bare);
  if (integral !== undefined) return castToIntegral(displayType, integral, operand);
  if (FLOAT_TARGETS.has(bare)) return castToFloat(displayType, operand);
  if (DOUBLE_TARGETS.has(bare)) return castToDouble(displayType, operand);
  if (DECIMAL_TARGETS.has(bare)) return castToDecimal(displayType, operand);
  return undefined;
}

/**
 * Emulate `(T)value` from netcoredbg's rendering of `value`, or nothing when
 * the conversion cannot be answered faithfully (the caller then surfaces the
 * adapter's own refusal). See the file header for the exact contract.
 */
export function emulateCast(targetType: string, operand: RenderedValue): RenderedValue | undefined {
  const bare = unwrapNullable(targetType);
  const wrapped = bare !== targetType;
  if (wrapped && operand.result === 'null') {
    // `(long?)null` is C#'s null of the nullable target.
    return { result: 'null', type: targetType, variablesReference: 0 };
  }
  const numeric = numericCast(targetType, bare, operand);
  if (numeric !== undefined) return numeric;
  if (!wrapped && targetType === operand.type) return operand;
  if (targetType === 'object' || targetType === 'System.Object') {
    // Boxing/upcast to object is legal for EVERY C# value.
    return {
      result: operand.result,
      type: targetType,
      variablesReference: operand.variablesReference,
    };
  }
  return undefined;
}

/** The rendered value inside an `evaluate` response body shape. */
export function renderedOf(body: Record<string, unknown>): RenderedValue {
  return {
    result: typeof body.result === 'string' ? body.result : '',
    type: typeof body.type === 'string' ? body.type : '',
    variablesReference: Number(body.variablesReference ?? 0),
  };
}
