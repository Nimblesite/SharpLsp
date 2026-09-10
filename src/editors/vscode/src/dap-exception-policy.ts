// Editor-neutral DAP policy translation. Implements [CONFIG-DEBUG-EXCEPTIONS].
import { isRecord, type DapMessage } from './dap-emulate';

/** Wire representation of the LSP's validated TOML exception configuration. */
export interface ExceptionPolicy {
  readonly break_on?: 'editor' | 'all' | 'user-unhandled' | 'unhandled';
  readonly ignore?: readonly string[];
  readonly external_code?: 'throw-site' | 'user-boundary';
}

/** Apply exclusions to every selected filter, avoiding an unfiltered parallel entry. */
function excludeTypes(
  option: Record<string, unknown>,
  ignored: readonly string[],
): Record<string, unknown> {
  const condition = typeof option.condition === 'string' ? option.condition : '';
  // netcoredbg negates the entire list with ONE leading !, not each name.
  const negative = condition.startsWith('!');
  const names = (negative ? condition.slice(1) : condition)
    .replaceAll(',', ' ')
    .split(/\s+/u)
    .filter(Boolean);
  const included = names.filter((name) => !ignored.includes(name));
  if (!negative && names.length > 0)
    return { ...option, condition: included.join(' '), disabled: included.length === 0 };
  const excluded = [...new Set([...names, ...ignored])];
  return {
    ...option,
    condition: excluded.length === 0 ? '' : `!${excluded.join(' ')}`,
  };
}

/** Merge client checkbox selections with the server policy after DAP option translation. */
export function withExceptionPolicy(
  message: DapMessage,
  policy: ExceptionPolicy | undefined,
): DapMessage {
  if (message.command !== 'setExceptionBreakpoints' || policy === undefined) return message;
  const args = isRecord(message.arguments) ? message.arguments : {};
  const filters = Array.isArray(args.filters)
    ? args.filters.filter((id): id is string => typeof id === 'string')
    : [];
  const supplied = Array.isArray(args.filterOptions) ? args.filterOptions.filter(isRecord) : [];
  const selected =
    policy.break_on === undefined || policy.break_on === 'editor'
      ? [...supplied, ...filters.map((filterId) => ({ filterId }))]
      : policy.break_on === 'unhandled'
        ? []
        : [{ filterId: policy.break_on }];
  const options = selected
    .map((option) => excludeTypes(option, policy.ignore ?? []))
    .filter((option) => option.disabled !== true)
    .map(({ disabled: _disabled, ...option }) => option);
  return { ...message, arguments: { ...args, filters: [], filterOptions: options } };
}
