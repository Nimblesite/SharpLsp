// F# and C# values netcoredbg exposes only as runtime internals.
//
// Implements [DEBUG-FSHARP-UNIONS] and the collection, static-field and
// [DebuggerDisplay] rows of [DEBUG-FEATURES-VARIABLES]. C# List<T> arrives as
// `_items` plus `_size`; FSharpList<T> arrives as a recursive Head/Tail union;
// a discriminated union case arrives as a bare `{Ns.Shape.Rect}` with its
// fields underneath; a `[DebuggerDisplay]` type arrives as its raw class name
// (dap-display.ts); statics arrive not at all (dap-statics.ts). All of them
// already carry real adapter handles, so the router can present the logical
// value without guessing at it.
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import { childrenOf, evaluateIn, referenceOf, stringField, variablesOf } from './dap-values';
import { DebuggerDisplayEmulator } from './dap-display';
import { StaticsScopes } from './dap-statics';
import type { RetryHost } from './dap-attach';

const MAX_FSHARP_ITEMS = 1_024;

interface VariableContext {
  readonly frameId: number;
  readonly evaluateName?: string;
  /** True when the reference is a scope: children are addressable by name. */
  readonly scope?: boolean;
}

function named(
  variables: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return variables.find((variable) => stringField(variable, 'name').toLowerCase() === name);
}

function withVariables(response: DapMessage, variables: Record<string, unknown>[]): DapMessage {
  const body = isRecord(response.body) ? response.body : {};
  return { ...response, body: { ...body, variables } };
}

/** Surface bindings hoisted into an F# resumable state machine's `this`. */
async function fsharpStateMachineLocals(
  host: RetryHost,
  variables: Record<string, unknown>[],
  context: VariableContext | undefined,
): Promise<Record<string, unknown>[] | undefined> {
  const self = context?.scope === true ? named(variables, 'this') : undefined;
  if (self === undefined || referenceOf(self) <= 0) return undefined;
  const fields = await childrenOf(host, referenceOf(self));
  if (named(fields, 'data') === undefined || named(fields, 'resumptionpoint') === undefined) {
    return undefined;
  }
  return [...variables, ...fields];
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
  const frameId = context?.frameId;
  const root = context?.evaluateName;
  if (root === undefined || frameId === undefined || elements.length >= MAX_FSHARP_ITEMS) return;
  for (let index = elements.length; index < MAX_FSHARP_ITEMS && !host.isClosed(); index += 1) {
    const tail = `${root}${'.Tail'.repeat(index)}`;
    const empty = await evaluateIn(host, frameId, `${tail}.IsEmpty`);
    if (empty === undefined || stringField(empty, 'result').toLowerCase() === 'true') return;
    const head = await evaluateIn(host, frameId, `${tail}.Head`);
    if (head === undefined) return;
    elements.push(evaluatedItem(head, index, `${tail}.Head`));
  }
}

/** One evaluated element, in the shape the variables panel expects. */
function evaluatedItem(
  body: Record<string, unknown>,
  index: number,
  evaluateName: string,
): Record<string, unknown> {
  return {
    name: `[${String(index)}]`,
    value: stringField(body, 'result'),
    type: stringField(body, 'type'),
    variablesReference: Number(body.variablesReference ?? 0),
    evaluateName,
  };
}

/** `Ns.Union.Case` split into the union and the case it could name. */
function caseCandidate(typeName: string): { declaring: string; name: string } | undefined {
  const cut = typeName.lastIndexOf('.');
  const segment = typeName.slice(cut + 1);
  // The compiler names the singleton class of a nullary case `_Case`.
  if (cut <= 0 || !/^_?[A-Z][A-Za-z0-9_]*$/u.test(segment)) return undefined;
  return { declaring: typeName.slice(0, cut), name: segment.replace(/^_/u, '') };
}

/** The values of a case's fields, one per field however it is exposed. */
function caseFields(children: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const child of children) {
    // netcoredbg lists a case field twice — as its backing field `_width` and
    // as its property `width` — and appends a typeless `Static members` node.
    const field = stringField(child, 'name').replace(/^_/u, '').toLowerCase();
    if (stringField(child, 'type') === '' || seen.has(field)) continue;
    seen.add(field);
    values.push(stringField(child, 'value'));
  }
  return values;
}

/** `Rect(3, 4)`, and a bare case name when the case carries nothing. */
function renderCase(name: string, fields: readonly string[]): string {
  return fields.length === 0 ? name : `${name}(${fields.join(', ')})`;
}

/**
 * Proof that a CLR type is an F# union case, taken from the union's metadata.
 *
 * `type Shape = Circle of int | Rect of int * int` compiles to one nested class
 * per case PLUS a nested `Tags` class holding one `int` constant per case. So
 * `Shape.Tags.Rect` resolves for a union and for nothing else: not for a C#
 * nested class, not for an F# record, and not for a class that merely happens
 * to expose a `Tag` member. netcoredbg answers it out of the assembly's own
 * metadata, so no FCS round trip is involved, and the answer is a property of
 * the type rather than of the value — one evaluation per type per session.
 */
class UnionCaseProof {
  private readonly verdicts = new Map<string, string | undefined>();

  constructor(private readonly host: RetryHost) {}

  /** The case `typeName` names, or nothing when it names no case. */
  public async caseNameOf(typeName: string, frameId: number): Promise<string | undefined> {
    if (!this.verdicts.has(typeName)) {
      this.verdicts.set(typeName, await this.prove(typeName, frameId));
    }
    return this.verdicts.get(typeName);
  }

  private async prove(typeName: string, frameId: number): Promise<string | undefined> {
    const candidate = caseCandidate(typeName);
    if (candidate === undefined) return undefined;
    const proof = await evaluateIn(
      this.host,
      frameId,
      `${candidate.declaring}.Tags.${candidate.name}`,
    );
    const tag = proof === undefined ? '' : stringField(proof, 'result');
    return /^-?\d+$/u.test(tag) ? candidate.name : undefined;
  }
}

/** `option<'T>` is one union, but the CLR type names the union, not the case. */
const OPTION_TYPE = /(?:^|\.)FSharpOption</u;

/** `Some(42)` and `None` — [DEBUG-FSHARP-UNIONS]'s own worked example. */
async function optionDisplay(
  host: RetryHost,
  variable: Record<string, unknown>,
): Promise<string | undefined> {
  if (!OPTION_TYPE.test(stringField(variable, 'type'))) return undefined;
  // `None` is the null reference; there is no instance to ask about.
  if (stringField(variable, 'value') === 'null') return 'None';
  const fields = caseFields(await childrenOf(host, referenceOf(variable)));
  return fields.length === 0 ? undefined : renderCase('Some', fields);
}

/** `Rect(3, 4)` for a value the union's own `Tags` metadata proves is a case. */
async function unionDisplay(
  host: RetryHost,
  proof: UnionCaseProof,
  variable: Record<string, unknown>,
  frameId: number,
): Promise<string | undefined> {
  const name = await proof.caseNameOf(stringField(variable, 'type'), frameId);
  if (name === undefined) return undefined;
  return renderCase(name, caseFields(await childrenOf(host, referenceOf(variable))));
}

/** The expression that re-evaluates `variable`, for attribute emulation. */
function objectExpressionOf(
  variable: Record<string, unknown>,
  context: VariableContext | undefined,
): string | undefined {
  const evaluateName = stringField(variable, 'evaluateName');
  if (evaluateName !== '') return evaluateName;
  const name = stringField(variable, 'name');
  return context?.scope === true && name !== '' ? name : undefined;
}

/** The F# or [DebuggerDisplay] summary for one variable, when one applies. */
async function displayOf(
  host: RetryHost,
  proof: UnionCaseProof,
  displays: DebuggerDisplayEmulator,
  variable: Record<string, unknown>,
  context: VariableContext | undefined,
): Promise<string | undefined> {
  const frameId = context?.frameId;
  const fsharp =
    (await optionDisplay(host, variable)) ??
    (frameId === undefined ? undefined : await unionDisplay(host, proof, variable, frameId));
  if (fsharp !== undefined) return fsharp;
  return await displays.display(variable, objectExpressionOf(variable, context), frameId);
}

/** Replace the raw CLR summary of every value the router can render better. */
async function enrichDisplays(
  host: RetryHost,
  proof: UnionCaseProof,
  displays: DebuggerDisplayEmulator,
  variables: readonly Record<string, unknown>[],
  context: VariableContext | undefined,
): Promise<Record<string, unknown>[]> {
  const enriched: Record<string, unknown>[] = [];
  for (const variable of variables) {
    const display = host.isClosed()
      ? undefined
      : await displayOf(host, proof, displays, variable, context);
    enriched.push(display === undefined ? variable : { ...variable, value: display });
  }
  return enriched;
}

/** Intercept one client variables request and deliver its logical collection view. */
export class VariableExpander {
  private readonly contexts = new Map<number, VariableContext>();

  private readonly unions: UnionCaseProof;

  private readonly displays: DebuggerDisplayEmulator;

  private readonly statics: StaticsScopes;

  constructor(private readonly host: RetryHost) {
    this.unions = new UnionCaseProof(host);
    this.displays = new DebuggerDisplayEmulator(host);
    this.statics = new StaticsScopes(host);
  }

  /** Frame display names feed the Statics scope ([DEBUG-FEATURES-VARIABLES]). */
  public observeStackTrace(response: DapMessage): void {
    this.statics.observeFrames(response);
  }

  public startScopes(clientRequest: DapMessage, args: Record<string, unknown>): void {
    void this.runScopes(clientRequest, args);
  }

  public start(clientRequest: DapMessage, args: Record<string, unknown>): void {
    void this.run(clientRequest, args);
  }

  private async run(clientRequest: DapMessage, args: Record<string, unknown>): Promise<void> {
    const reference = Number(args.variablesReference ?? 0);
    if (this.statics.owns(reference)) {
      await this.deliverStatics(clientRequest, reference);
      return;
    }
    const response = await this.host.request('variables', args);
    if (this.host.isClosed()) return;
    const raw = variablesOf(response);
    const context = this.contexts.get(reference);
    if (context !== undefined) this.rememberChildren(raw, context.frameId);
    const logical =
      response.success === false
        ? undefined
        : ((await fsharpStateMachineLocals(this.host, raw, context)) ??
          (await csharpList(this.host, raw)) ??
          (await fsharpList(this.host, raw, context)));
    const displayed =
      logical ?? (await enrichDisplays(this.host, this.unions, this.displays, raw, context));
    if (this.host.isClosed()) return;
    this.host.deliver({
      ...(response.success === false ? response : withVariables(response, displayed)),
      request_seq: Number(clientRequest.seq ?? -1),
    });
  }

  /** Serve a synthesized Statics reference without touching the adapter. */
  private async deliverStatics(clientRequest: DapMessage, reference: number): Promise<void> {
    const rows = await this.statics.variablesFor(reference);
    if (this.host.isClosed()) return;
    this.host.deliver({
      seq: 0,
      type: 'response',
      command: 'variables',
      success: true,
      body: { variables: rows ?? [] },
      request_seq: Number(clientRequest.seq ?? -1),
    });
  }

  private async runScopes(clientRequest: DapMessage, args: Record<string, unknown>): Promise<void> {
    const response = await this.host.request('scopes', args);
    if (this.host.isClosed()) return;
    const frameId = Number(args.frameId ?? 0);
    this.rememberScopes(response, frameId);
    const delivered = this.withStatics(response, frameId);
    if (this.host.isClosed()) return;
    this.host.deliver({ ...delivered, request_seq: Number(clientRequest.seq ?? -1) });
  }

  private rememberScopes(response: DapMessage, frameId: number): void {
    const body = isRecord(response.body) ? response.body : {};
    for (const scope of recordList(body.scopes)) {
      const reference = referenceOf(scope);
      if (reference > 0) this.contexts.set(reference, { frameId, scope: true });
    }
  }

  /** Append the synthesized Statics scope when the frame's type has statics. */
  private withStatics(response: DapMessage, frameId: number): DapMessage {
    if (response.success === false) return response;
    const scope = this.statics.scopeFor(frameId);
    if (scope === undefined) return response;
    const body = isRecord(response.body) ? response.body : {};
    return { ...response, body: { ...body, scopes: [...recordList(body.scopes), scope] } };
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
