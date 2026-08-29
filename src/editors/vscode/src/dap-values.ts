// Shared value plumbing for the router's variables/display/statics emulations:
// the narrow field accessors and the two adapter requests — evaluate-in-frame
// and children-of-handle — every emulation performs.
//
// Implements the shared halves of [DEBUG-FEATURES-VARIABLES]. Deliberately
// free of `vscode` imports so the emulations stay unit-testable against
// captured DAP payloads.
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import type { RetryHost } from './dap-attach';

/** A string field of a loosely-typed DAP record, or '' when absent. */
export function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value : '';
}

/** A record's `variablesReference`, with 0 — DAP's "no children" — as default. */
export function referenceOf(variable: Record<string, unknown> | undefined): number {
  return Number(variable?.variablesReference ?? 0);
}

/** The `variables` list of a DAP response body, dropping malformed entries. */
export function variablesOf(response: DapMessage): Record<string, unknown>[] {
  const body = isRecord(response.body) ? response.body : {};
  return recordList(body.variables);
}

/** One `evaluate` in a frame, or nothing when the adapter refuses it. */
export async function evaluateIn(
  host: RetryHost,
  frameId: number,
  expression: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await host.request('evaluate', { expression, frameId, context: 'watch' });
  if (response.success === false) return undefined;
  return isRecord(response.body) ? response.body : {};
}

/** The children behind a variable's handle; none when it has no handle. */
export async function childrenOf(
  host: RetryHost,
  reference: number,
): Promise<Record<string, unknown>[]> {
  if (reference <= 0) return [];
  const response = await host.request('variables', { variablesReference: reference });
  return response.success === false ? [] : variablesOf(response);
}

/** Strip the one pair of quotes netcoredbg wraps a rendered string value in. */
export function unquote(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}
