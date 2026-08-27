// Collection-shaped variables netcoredbg exposes only through runtime internals.
//
// C# List<T> arrives as `_items` plus `_size`; FSharpList<T> arrives as a
// recursive Head/Tail union. Both already carry real adapter handles, so the
// router can present their elements without evaluating code or guessing values.
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import type { RetryHost } from './dap-attach';

const MAX_FSHARP_ITEMS = 1_024;

interface VariableContext {
  readonly frameId: number;
  readonly evaluateName?: string;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value : '';
}

function named(
  variables: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return variables.find((variable) => stringField(variable, 'name').toLowerCase() === name);
}

function referenceOf(variable: Record<string, unknown> | undefined): number {
  return Number(variable?.variablesReference ?? 0);
}

function variablesOf(response: DapMessage): Record<string, unknown>[] {
  const body = isRecord(response.body) ? response.body : {};
  return recordList(body.variables);
}

function withVariables(response: DapMessage, variables: Record<string, unknown>[]): DapMessage {
  const body = isRecord(response.body) ? response.body : {};
  return { ...response, body: { ...body, variables } };
}

/** Turn List<T>'s backing array into its logical, size-bounded elements. */
async function csharpList(
  host: RetryHost,
  variables: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[] | undefined> {
  const items = named(variables, '_items');
  const size = Number(named(variables, '_size')?.value ?? 0);
  const reference = referenceOf(items);
  if (!Number.isInteger(size) || size < 0 || reference <= 0) return undefined;
  const expanded = await host.request('variables', { variablesReference: reference });
  if (expanded.success === false) return undefined;
  return variablesOf(expanded)
    .filter((variable) => /^\[\d+\]$/u.test(stringField(variable, 'name')))
    .slice(0, size);
}

function isFsharpList(variables: readonly Record<string, unknown>[]): boolean {
  const tail = named(variables, 'tail');
  if (named(variables, 'head') === undefined || tail === undefined) return false;
  const shape = `${stringField(tail, 'type')} ${stringField(tail, 'value')}`;
  return /FSharpList|list</iu.test(shape) || named(variables, 'tag') !== undefined;
}

/** Walk FSharpList<T>'s bounded cons chain and expose one element per Head. */
async function fsharpList(
  host: RetryHost,
  first: readonly Record<string, unknown>[],
  context: VariableContext | undefined,
): Promise<Record<string, unknown>[] | undefined> {
  if (!isFsharpList(first)) return undefined;
  const elements: Record<string, unknown>[] = [];
  let variables = first;
  for (let index = 0; index < MAX_FSHARP_ITEMS; index += 1) {
    const head = named(variables, 'head');
    const tail = named(variables, 'tail');
    if (head === undefined || tail === undefined) break;
    elements.push({ ...head, name: `[${String(index)}]` });
    const reference = referenceOf(tail);
    if (reference <= 0 || host.isClosed()) break;
    const expanded = await host.request('variables', { variablesReference: reference });
    if (expanded.success === false) break;
    variables = variablesOf(expanded);
  }
  await appendEvaluatedFsharpItems(host, context, elements);
  return elements.length === 0 ? undefined : elements;
}

/** Recover list tails whose adapter handle disappears, using real evaluations. */
async function appendEvaluatedFsharpItems(
  host: RetryHost,
  context: VariableContext | undefined,
  elements: Record<string, unknown>[],
): Promise<void> {
  if (context?.evaluateName === undefined || elements.length >= MAX_FSHARP_ITEMS) return;
  for (let index = elements.length; index < MAX_FSHARP_ITEMS && !host.isClosed(); index += 1) {
    const tail = `${context.evaluateName}${'.Tail'.repeat(index)}`;
    const empty = await host.request('evaluate', {
      expression: `${tail}.IsEmpty`,
      frameId: context.frameId,
      context: 'watch',
    });
    if (empty.success === false || resultOf(empty).toLowerCase() === 'true') return;
    const head = await host.request('evaluate', {
      expression: `${tail}.Head`,
      frameId: context.frameId,
      context: 'watch',
    });
    if (head.success === false) return;
    const body = isRecord(head.body) ? head.body : {};
    elements.push({
      name: `[${String(index)}]`,
      value: resultOf(head),
      type: stringField(body, 'type'),
      variablesReference: Number(body.variablesReference ?? 0),
      evaluateName: `${tail}.Head`,
    });
  }
}

function resultOf(response: DapMessage): string {
  return stringField(isRecord(response.body) ? response.body : {}, 'result');
}

function fsharpCaseName(variable: Record<string, unknown>): string | undefined {
  const shape = `${stringField(variable, 'type')} ${stringField(variable, 'value')}`;
  if (/FSharpOption|option</iu.test(shape)) return 'Some';
  const raw = stringField(variable, 'value').replace(/[{}]/gu, '');
  const segment = raw.split(/[.+]/u).at(-1);
  return segment !== undefined && /^[A-Z][A-Za-z0-9_]*$/u.test(segment) ? segment : undefined;
}

function fsharpDisplay(
  variable: Record<string, unknown>,
  children: readonly Record<string, unknown>[],
): string | undefined {
  const shape = `${stringField(variable, 'type')} ${stringField(variable, 'value')}`;
  if (/FSharpList/iu.test(shape)) return undefined;
  const option = /FSharpOption|option</iu.test(shape);
  const tag = named(children, 'tag');
  if (!option && tag === undefined) return undefined;
  const name = fsharpCaseName(variable);
  if (name === undefined) return undefined;
  const payload = children.filter((child) => stringField(child, 'name').toLowerCase() !== 'tag');
  if (option && payload.length === 0) return 'None';
  return `${name}(${payload.map((child) => stringField(child, 'value')).join(', ')})`;
}

/** Replace raw CLR summaries only when their real child metadata proves a DU. */
async function enrichFsharpDisplays(
  host: RetryHost,
  variables: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const enriched: Record<string, unknown>[] = [];
  for (const variable of variables) {
    const reference = referenceOf(variable);
    const shape = `${stringField(variable, 'type')} ${stringField(variable, 'value')}`;
    if (
      reference <= 0 ||
      (!shape.includes('FSharp') && !/^\{.+\}$/u.test(stringField(variable, 'value')))
    ) {
      enriched.push(variable);
      continue;
    }
    const response = await host.request('variables', { variablesReference: reference });
    const display =
      response.success === false ? undefined : fsharpDisplay(variable, variablesOf(response));
    enriched.push(display === undefined ? variable : { ...variable, value: display });
  }
  return enriched;
}

/** Intercept one client variables request and deliver its logical collection view. */
export class VariableExpander {
  private readonly contexts = new Map<number, VariableContext>();

  constructor(private readonly host: RetryHost) {}

  public startScopes(clientRequest: DapMessage, args: Record<string, unknown>): void {
    void this.runScopes(clientRequest, args);
  }

  public start(clientRequest: DapMessage, args: Record<string, unknown>): void {
    void this.run(clientRequest, args);
  }

  private async run(clientRequest: DapMessage, args: Record<string, unknown>): Promise<void> {
    const response = await this.host.request('variables', args);
    if (this.host.isClosed()) return;
    const raw = variablesOf(response);
    const context = this.contexts.get(Number(args.variablesReference ?? 0));
    if (context !== undefined) this.rememberChildren(raw, context.frameId);
    const logical =
      response.success === false
        ? undefined
        : ((await csharpList(this.host, raw)) ?? (await fsharpList(this.host, raw, context)));
    const displayed = logical ?? (await enrichFsharpDisplays(this.host, raw));
    if (this.host.isClosed()) return;
    this.host.deliver({
      ...(response.success === false ? response : withVariables(response, displayed)),
      request_seq: Number(clientRequest.seq ?? -1),
    });
  }

  private async runScopes(clientRequest: DapMessage, args: Record<string, unknown>): Promise<void> {
    const response = await this.host.request('scopes', args);
    if (this.host.isClosed()) return;
    const body = isRecord(response.body) ? response.body : {};
    const frameId = Number(args.frameId ?? 0);
    for (const scope of recordList(body.scopes)) {
      const reference = referenceOf(scope);
      if (reference > 0) this.contexts.set(reference, { frameId });
    }
    this.host.deliver({ ...response, request_seq: Number(clientRequest.seq ?? -1) });
  }

  private rememberChildren(variables: readonly Record<string, unknown>[], frameId: number): void {
    for (const variable of variables) {
      const reference = referenceOf(variable);
      const evaluateName = stringField(variable, 'evaluateName');
      if (reference > 0) {
        this.contexts.set(reference, { frameId, ...(evaluateName === '' ? {} : { evaluateName }) });
      }
    }
  }
}
