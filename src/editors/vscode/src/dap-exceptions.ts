// DAP `exceptionOptions` translated into the filter language netcoredbg speaks.
//
// Implements the `supportsExceptionOptions` row of
// [DEBUG-PROTOCOL-CAPABILITIES] ("Yes | Yes | Filter by type, user code, etc.")
// and the [DEBUG-FEATURES-EXCEPTIONS] row "Break on specific exception types
// (include/exclude filter) | P1", whose configuration that section pins to
// "`setExceptionBreakpoints` with `filterOptions` and `exceptionOptions` per the
// DAP 1.71.0 specification".
//
// netcoredbg answers `supportsExceptionOptions: false` and silently ignores an
// `exceptionOptions` array, so VS Code's per-type configuration would reach a
// debugger that never applies it. What netcoredbg DOES implement is
// `filterOptions[].condition`, and that condition is a type filter: a
// whitespace-separated list of fully qualified CLR type names, each optionally
// prefixed with `!` to exclude it. Verified against netcoredbg 3.2.0-1092 —
// `System.DivideByZeroException` lets an `InvalidOperationException` throw run
// past untouched, `System.InvalidOperationException` stops on it, and a bare
// `InvalidOperationException` matches nothing, so the names must stay fully
// qualified.
//
// This module is therefore a TRANSLATION, not a claim: the capability is only
// advertised because every `exceptionOptions` entry is rewritten into a
// `filterOptions` entry the adapter honours.

/** netcoredbg's filter id for "break on every throw". */
const FILTER_ALL = 'all';

/** netcoredbg's filter id for "break only where the exception escapes". */
const FILTER_USER_UNHANDLED = 'user-unhandled';

/** The `!` netcoredbg reads as "every type EXCEPT this one". */
const NEGATE = '!';

/** The separator netcoredbg splits a condition's type list on. */
const NAME_SEPARATOR = ' ';

/** One `ExceptionFilterOptions` entry — what netcoredbg actually reads. */
export interface FilterOption {
  readonly filterId: string;
  readonly condition?: string;
}

/** Narrow an unknown to an indexable object without asserting it is one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read one field of an unknown value, or undefined when it has no fields. */
function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

/** Every string in an unknown array, with non-strings discarded. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The netcoredbg filter id a DAP `breakMode` selects.
 *
 * `never` has no filter: DAP expresses "do not break" by the ABSENCE of a
 * filter, and inventing one would break on everything.
 */
function filterIdFor(breakMode: unknown): string | undefined {
  if (breakMode === 'always') return FILTER_ALL;
  if (breakMode === 'unhandled' || breakMode === 'userUnhandled') return FILTER_USER_UNHANDLED;
  return undefined;
}

/** The type names one `ExceptionPathSegment` contributes, `!` when negated. */
function namesOf(segment: unknown): string[] {
  const prefix = field(segment, 'negate') === true ? NEGATE : '';
  return strings(field(segment, 'names')).map((name) => `${prefix}${name}`);
}

/** Every type name an `exceptionOptions` entry's `path` selects, in order. */
function conditionFor(option: unknown): string {
  const path: unknown = field(option, 'path');
  if (!Array.isArray(path)) return '';
  return path.flatMap((segment: unknown) => namesOf(segment)).join(NAME_SEPARATOR);
}

/**
 * One `filterOptions` entry per `exceptionOptions` entry, dropping the ones
 * DAP defines as "do not break".
 *
 * An entry with an empty path is a whole-filter selection rather than a type
 * filter, so it becomes a bare `filterId` with no condition — exactly what
 * ticking the checkbox without naming a type means.
 */
export function filterOptionsFrom(options: readonly unknown[]): FilterOption[] {
  const translated: FilterOption[] = [];
  for (const entry of options) {
    const filterId = filterIdFor(field(entry, 'breakMode'));
    if (filterId === undefined) continue;
    const condition = conditionFor(entry);
    translated.push(condition.length === 0 ? { filterId } : { filterId, condition });
  }
  return translated;
}

/** True when two filter options address the same filter with the same types. */
function sameOption(left: FilterOption, right: FilterOption): boolean {
  return left.filterId === right.filterId && (left.condition ?? '') === (right.condition ?? '');
}

/** One client-supplied `filterOptions` entry, narrowed to its two fields. */
function suppliedOption(entry: unknown): FilterOption | undefined {
  const filterId: unknown = field(entry, 'filterId');
  if (typeof filterId !== 'string') return undefined;
  const condition: unknown = field(entry, 'condition');
  return typeof condition === 'string' ? { filterId, condition } : { filterId };
}

/** The client's own `filterOptions`, kept so a translation never drops one. */
function existingFilterOptions(supplied: unknown): FilterOption[] {
  if (!Array.isArray(supplied)) return [];
  return supplied
    .map((entry: unknown) => suppliedOption(entry))
    .filter((option): option is FilterOption => option !== undefined);
}

/**
 * Rewrite one `setExceptionBreakpoints` argument bag so netcoredbg applies the
 * per-type configuration VS Code expressed as `exceptionOptions`.
 *
 * `exceptionOptions` is REMOVED after translation. Leaving it in place would be
 * harmless today — netcoredbg ignores it — but it would let a future adapter
 * apply the same selection twice, once per spelling.
 */
export function withTranslatedExceptionOptions(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const options: unknown = args.exceptionOptions;
  if (!Array.isArray(options)) return args;
  const merged = existingFilterOptions(args.filterOptions);
  for (const option of filterOptionsFrom(options)) {
    if (!merged.some((present) => sameOption(present, option))) merged.push(option);
  }
  const { exceptionOptions: _translated, ...rest } = args;
  return merged.length === 0 ? rest : { ...rest, filterOptions: merged };
}
