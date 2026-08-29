// The Statics scope netcoredbg never offers, synthesized by the router.
//
// Implements [DEBUG-FEATURES-VARIABLES] "Static fields | `variables` | P1":
// netcoredbg answers `scopes` with Locals alone, so a static the program just
// assigned is unreachable from the panel. The router remembers each frame's
// display name off the `stackTrace` responses it proxies and offers a Statics
// scope for every frame whose enclosing type it can derive — the scope itself
// costs nothing ([DEBUG-PERFORMANCE]): enumeration runs lazily inside the
// scope's own `variables` request, exactly the on-demand shape DAP gives it.
//
// Enumeration walks the debuggee's own reflection, the only route netcoredbg's
// evaluator can execute (no `typeof`, no `BindingFlags` combinations): the
// type is resolved through `Assembly.GetEntryAssembly().GetType`, then
// `System.Type.GetType`, then EVERY loaded assembly via
// `AppDomain.CurrentDomain.GetAssemblies()[i].GetType` — so class-library
// types and test-host runs (entry assembly = testhost) resolve too. Public
// static fields are kept (`GetFields()` cannot take visibility flags, so
// non-public statics stay unlisted). Field lists are cached per type and
// dropped on restart/hot reload (`invalidate`), where a new static field can
// legally appear ([DEBUG-FEATURES-HOT-RELOAD] "Add new static field | Yes");
// values are re-evaluated on every request so edits stay visible.
//
// Frames the router cannot resolve — generic display names, compiler-
// generated closure classes, unloaded types — get an EMPTY Statics scope or
// none at all: the panel degrades to netcoredbg's native shape, never to an
// error.
import type { RetryHost } from './dap-attach';
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import { childrenOf, evaluateIn, referenceOf, stringField, unquote } from './dap-values';

/**
 * First synthetic handle. netcoredbg numbers its own handles from 1 per stop
 * and never approaches 2^30, so the ranges cannot collide; the session-scoped
 * offset of `HandleNamespace` keeps two routers' synthetic ranges apart.
 */
const SYNTHETIC_BASE = 1_073_741_824;

/** Bound on the fields one enumeration walks — each costs evaluations. */
const MAX_FIELDS = 64;

/** Bound on remembered frames and handed-out scopes; both recycle per stop. */
const MAX_REMEMBERED = 1_024;

/** Bound on the loaded assemblies the type lookup is willing to scan. */
const MAX_ASSEMBLIES = 48;

/** The two direct reflection entry points netcoredbg's evaluator can execute. */
const TYPE_SOURCES: readonly string[] = [
  'System.Reflection.Assembly.GetEntryAssembly().GetType',
  'System.Type.GetType',
];

/** Every loaded assembly, for types the direct entry points cannot reach. */
const LOADED_ASSEMBLIES = 'System.AppDomain.CurrentDomain.GetAssemblies()';

/** Type-name spellings safe to splice into a reflection lookup string. */
const SAFE_TYPE_NAME = /^[A-Za-z0-9_.@`$]+$/u;

/** One handed-out Statics scope: whose statics, read from which frame. */
interface StaticsHandle {
  readonly typeName: string;
  readonly frameId: number;
}

/** A type lookup outcome: the resolving expression, or a definitive miss. */
interface TypeLookup {
  readonly expression?: string;
  /** False when a probe errored — the miss may be transient, do not cache. */
  readonly definitive: boolean;
}

type ProbeOutcome =
  { readonly kind: 'hit'; readonly expression: string } | { readonly kind: 'miss' | 'error' };

/** The enclosing type a frame display name carries, or nothing to skip. */
function enclosingTypeOf(frameName: string | undefined): string | undefined {
  if (frameName === undefined) return undefined;
  const paren = frameName.indexOf('(');
  const qualified = (paren < 0 ? frameName : frameName.slice(0, paren)).trim();
  const cut = qualified.lastIndexOf('.');
  if (cut <= 0) return undefined;
  const typeName = qualified.slice(0, cut);
  return SAFE_TYPE_NAME.test(typeName) ? typeName : undefined;
}

/** CLR lookup spellings for a dotted display name: `A.B.C` may nest as `A.B+C`. */
function clrNamesOf(typeName: string): string[] {
  const names = [typeName];
  const cut = typeName.lastIndexOf('.');
  if (cut > 0) names.push(`${typeName.slice(0, cut)}+${typeName.slice(cut + 1)}`);
  return names;
}

/** Drop the oldest entries once a per-session map outgrows its bound. */
function bound<Value>(map: Map<number, Value>): void {
  for (const key of map.keys()) {
    if (map.size <= MAX_REMEMBERED) return;
    map.delete(key);
  }
}

/** Synthesizes and serves the Statics scope for stopped frames. */
export class StaticsScopes {
  /** Adapter-space frame id -> the frame's display name, latest stop wins. */
  private readonly frameNames = new Map<number, string>();

  /** Enclosing type -> its static field names; `undefined` = unenumerable. */
  private readonly enumerations = new Map<string, Promise<readonly string[] | undefined>>();

  private readonly handles = new Map<number, StaticsHandle>();

  private nextHandle = SYNTHETIC_BASE;

  constructor(private readonly host: RetryHost) {}

  /** Restart / hot reload can change any type's fields: re-enumerate. */
  public invalidate(): void {
    this.enumerations.clear();
  }

  /** Remember frame names off one raw adapter `stackTrace` response. */
  public observeFrames(response: DapMessage): void {
    const body = isRecord(response.body) ? response.body : {};
    for (const frame of recordList(body.stackFrames)) {
      const id = Number(frame.id ?? -1);
      const name = stringField(frame, 'name');
      if (Number.isInteger(id) && id >= 0 && name !== '') this.frameNames.set(id, name);
    }
    bound(this.frameNames);
  }

  /** True when `reference` names a scope this class handed out. */
  public owns(reference: number): boolean {
    return this.handles.has(reference);
  }

  /** A Statics scope for `frameId` — free to offer; enumeration is lazy. */
  public scopeFor(frameId: number): Record<string, unknown> | undefined {
    const typeName = enclosingTypeOf(this.frameNames.get(frameId));
    if (typeName === undefined) return undefined;
    const reference = this.nextHandle;
    this.nextHandle += 1;
    this.handles.set(reference, { typeName, frameId });
    bound(this.handles);
    return { name: 'Statics', variablesReference: reference, expensive: true };
  }

  /** The freshly-evaluated rows behind one handed-out Statics scope. */
  public async variablesFor(reference: number): Promise<Record<string, unknown>[] | undefined> {
    const handle = this.handles.get(reference);
    if (handle === undefined) return undefined;
    const fields = await this.fieldsOf(handle.typeName, handle.frameId);
    if (fields === undefined || this.host.isClosed()) return [];
    return await Promise.all(fields.map(async (field) => await this.row(handle, field)));
  }

  /** One static field, evaluated through its dotted type-qualified name. */
  private async row(handle: StaticsHandle, field: string): Promise<Record<string, unknown>> {
    const expression = `${handle.typeName}.${field}`;
    const body = await evaluateIn(this.host, handle.frameId, expression);
    return {
      name: field,
      value: body === undefined ? '' : stringField(body, 'result'),
      type: body === undefined ? '' : stringField(body, 'type'),
      variablesReference: body === undefined ? 0 : Number(body.variablesReference ?? 0),
      evaluateName: expression,
    };
  }

  /** The type's static field names, enumerated once and cached per type. */
  private async fieldsOf(
    typeName: string,
    frameId: number,
  ): Promise<readonly string[] | undefined> {
    const cached = this.enumerations.get(typeName);
    if (cached !== undefined) return await cached;
    const enumeration = this.enumerate(typeName, frameId);
    this.enumerations.set(typeName, enumeration);
    return await enumeration;
  }

  private async enumerate(
    typeName: string,
    frameId: number,
  ): Promise<readonly string[] | undefined> {
    const lookup = await this.typeExpression(typeName, frameId);
    if (lookup.expression === undefined) {
      if (!lookup.definitive) this.enumerations.delete(typeName);
      return undefined;
    }
    const names = await this.staticFieldNames(lookup.expression, frameId);
    // A failed walk (dead frame, transient refusal) must not stick.
    if (names === undefined) this.enumerations.delete(typeName);
    return names;
  }

  /** Probe one lookup expression: the expression on a hit, a miss kind else. */
  private async probeLookup(expression: string, frameId: number): Promise<ProbeOutcome> {
    const body = await evaluateIn(this.host, frameId, expression);
    if (body === undefined) return { kind: 'error' };
    return stringField(body, 'result') === 'null' ? { kind: 'miss' } : { kind: 'hit', expression };
  }

  /** Resolve the type through direct entry points, then every loaded assembly. */
  private async typeExpression(typeName: string, frameId: number): Promise<TypeLookup> {
    let sawError = false;
    for (const clrName of clrNamesOf(typeName)) {
      for (const source of TYPE_SOURCES) {
        if (this.host.isClosed()) return { definitive: false };
        const outcome = await this.probeLookup(`${source}("${clrName}")`, frameId);
        if (outcome.kind === 'error') sawError = true;
        else if (outcome.kind === 'hit') {
          return { expression: outcome.expression, definitive: true };
        }
      }
      const scanned = await this.scanAssemblies(clrName, frameId);
      if (scanned.expression !== undefined) return scanned;
      sawError = sawError || !scanned.definitive;
    }
    return { definitive: !sawError };
  }

  /** Ask every loaded assembly for the type, concurrently, first index wins. */
  private async scanAssemblies(clrName: string, frameId: number): Promise<TypeLookup> {
    const list = await evaluateIn(this.host, frameId, LOADED_ASSEMBLIES);
    if (list === undefined) return { definitive: false };
    const assemblies = (await childrenOf(this.host, referenceOf(list))).slice(0, MAX_ASSEMBLIES);
    const outcomes = await Promise.all(
      assemblies.map(async (assembly) => {
        const base = stringField(assembly, 'evaluateName');
        if (base === '' || this.host.isClosed()) return { kind: 'error' } as const;
        return await this.probeLookup(`${base}.GetType("${clrName}")`, frameId);
      }),
    );
    const hit = outcomes.find((outcome) => outcome.kind === 'hit');
    if (hit?.kind === 'hit') return { expression: hit.expression, definitive: true };
    return { definitive: !outcomes.some((outcome) => outcome.kind === 'error') };
  }

  /**
   * The static members of `GetFields()` — netcoredbg's evaluator cannot
   * combine `BindingFlags`, so the walk sees public fields and keeps the ones
   * whose `IsStatic` answers true, each probed concurrently.
   */
  private async staticFieldNames(typeExpr: string, frameId: number): Promise<string[] | undefined> {
    const array = await evaluateIn(this.host, frameId, `${typeExpr}.GetFields()`);
    if (array === undefined) return undefined;
    const children = await childrenOf(this.host, referenceOf(array));
    const names = await Promise.all(
      children
        .slice(0, MAX_FIELDS)
        .map(async (child) => await this.staticNameOf(stringField(child, 'evaluateName'), frameId)),
    );
    return names.filter((name): name is string => name !== undefined);
  }

  /** One FieldInfo's name, only when the field is static and readable. */
  private async staticNameOf(base: string, frameId: number): Promise<string | undefined> {
    if (base === '' || this.host.isClosed()) return undefined;
    const isStatic = await evaluateIn(this.host, frameId, `${base}.IsStatic`);
    if (isStatic === undefined || stringField(isStatic, 'result') !== 'true') return undefined;
    const name = await evaluateIn(this.host, frameId, `${base}.Name`);
    const rendered = name === undefined ? '' : stringField(name, 'result');
    if (!rendered.startsWith('"')) return undefined;
    const unquoted = unquote(rendered);
    return unquoted === '' ? undefined : unquoted;
  }
}
