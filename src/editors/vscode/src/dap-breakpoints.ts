// The hit-count and logpoint half of the router's Phase-4 breakpoint emulation.
//
// Implements [DEBUG-FEATURES-BREAKPOINTS] rows netcoredbg cannot serve
// ([DEBUG-ADAPTER-GAPS] records it ignores `hitCondition` and `logMessage`
// outright): the DapRouter keeps this bookkeeping and decides, for every stop
// that names breakpoints, whether the stop must reach VS Code, be silently
// continued, or be turned into a logpoint `output` event.
//
// It also owns the armed function-breakpoint set ([DEBUG-FEATURES-BREAKPOINTS]
// "Function/method breakpoints"): [DEBUG-GAPS] records that netcoredbg reports
// the plain `breakpoint` reason for a function-breakpoint stop, so the KIND of
// a stop must be identified from what is armed, never from the reason string.
//
// Deliberately free of `vscode` imports so the judgement stays unit-testable
// against captured DAP payloads.
import {
  isRecord,
  parseHitCondition,
  recordList,
  tokenizeLogMessage,
  type DapMessage,
  type LogToken,
} from './dap-emulate';
import { topFrameLocation } from './dap-stepping';
import { normalizePath } from './launch-target';

/** What the router should do with a stop that named breakpoints. */
export type StopVerdict =
  | { readonly action: 'forward' }
  | { readonly action: 'continue'; readonly threadId: number }
  | { readonly action: 'log'; readonly tokens: LogToken[] | undefined; readonly threadId: number };

/** The emulated attributes one client-authored breakpoint carried. */
export interface BreakpointMeta {
  readonly hitCondition?: unknown;
  readonly logMessage?: unknown;
  readonly line?: unknown;
  /** The adapter-confirmed id, to name in synthesized `hitBreakpointIds`. */
  readonly id?: number;
}

/** One counted visit of a breakpoint, before folding. */
interface Visit {
  readonly passes: boolean;
  readonly tokens: LogToken[] | undefined;
}

/** What probing the adapter or re-arming breakpoints needs from the router. */
export interface RequestHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
}

/** Where the router can send a stop the emulator has classified. */
export interface StopRoute {
  /** Treat the stop as a function entry: elide the brace, then deliver. */
  elide: () => void;
  /** Deliver the stop on the normal judged path, emulations and all. */
  deliver: () => void;
}

/** A `path:line` key for location lookups. */
function locationKey(path: string, line: number): string {
  return `${path}:${String(line)}`;
}

/** The `name` a client-authored function breakpoint carries, for reporting. */
function functionName(armed: Record<string, unknown>): string {
  return typeof armed.name === 'string' ? armed.name : '?';
}

/**
 * Counts breakpoint visits and judges stops.
 *
 * `record` is called with every `setBreakpoints` exchange so the id -> metadata
 * map matches what the adapter actually armed; `judge` is called with every
 * `stopped` event's `hitBreakpointIds`.
 */
export class BreakpointEmulator {
  /** Adapter breakpoint id -> the condition/message the client attached. */
  private readonly meta = new Map<number, BreakpointMeta>();
  /**
   * Normalized source path -> (bound line -> attributes), for stops that name
   * no breakpoint id. Keys go through `normalizePath` on write AND read, so
   * the client's authored spelling and the adapter's reported one meet even
   * when Windows case, separators or 8.3 short forms differ; lines are keyed
   * by where the adapter BOUND the breakpoint, falling back to the authored
   * line, because that is the line a stop's top frame will report.
   */
  private readonly byLocation = new Map<string, Map<number, BreakpointMeta>>();
  /** Adapter breakpoint id (or location key) -> visits observed. */
  private readonly counts = new Map<string, number>();
  /**
   * The armed function breakpoints, exactly as the client authored them —
   * `name` verbatim so overloads, generics and nested types reach netcoredbg
   * as typed, with `condition`/`hitCondition` riding along untouched.
   */
  private armedFunctions: readonly Record<string, unknown>[] = [];

  /** Forget every visit count; a re-armed breakpoint starts over. */
  public reset(): void {
    this.counts.clear();
  }

  /** Learn id -> condition/message from one request/response exchange. */
  public record(args: Record<string, unknown> | undefined, body: unknown): void {
    if (args === undefined) return;
    const confirmed = recordList(isRecord(body) ? body.breakpoints : undefined);
    const sent = recordList(args.breakpoints);
    const source = isRecord(args.source) ? args.source : undefined;
    const path = typeof source?.path === 'string' ? source.path : undefined;
    const lines = new Map<number, BreakpointMeta>();
    confirmed.forEach((breakpoint, index) => {
      this.recordOne(breakpoint, sent[index] ?? { line: undefined }, lines);
    });
    if (path !== undefined) this.rearmSource(normalizePath(path), lines);
  }

  /** Register one confirmed breakpoint's attributes by id and bound line. */
  private recordOne(
    confirmed: Record<string, unknown>,
    authored: Record<string, unknown>,
    lines: Map<number, BreakpointMeta>,
  ): void {
    const id = Number(confirmed.id ?? 0);
    if (id <= 0) return;
    const attributes: BreakpointMeta = {
      hitCondition: authored.hitCondition,
      logMessage: authored.logMessage,
      line: authored.line,
      id,
    };
    this.meta.set(id, attributes);
    const bound = typeof confirmed.line === 'number' ? confirmed.line : authored.line;
    if (typeof bound === 'number') lines.set(bound, attributes);
  }

  /**
   * Replace ONE source's armed lines, leaving every other source's intact —
   * `setBreakpoints` is a whole-set replacement per source, not per session.
   * An empty set disarms the source.
   */
  private rearmSource(key: string, lines: Map<number, BreakpointMeta>): void {
    if (lines.size === 0) this.byLocation.delete(key);
    else this.byLocation.set(key, lines);
  }

  /**
   * Learn the armed function-breakpoint set from one client request.
   *
   * DAP defines `setFunctionBreakpoints` as a whole-set replacement, so each
   * call replaces the recorded set — an empty list disarms everything. The
   * entries are recorded from the REQUEST, not the response: netcoredbg names
   * no ids in the `stopped` events its function breakpoints raise, so ids
   * would attribute nothing, and binding stays the adapter's job — its
   * `verified` flags and later `breakpoint` events reach VS Code untouched,
   * so a name that cannot bind surfaces as unverified rather than vanishing.
   * Implements [DEBUG-FEATURES-BREAKPOINTS] "Function/method breakpoints".
   */
  public recordFunctions(args: Record<string, unknown> | undefined): void {
    this.armedFunctions = recordList(args?.breakpoints);
  }

  /**
   * Take ownership of a stop that may be a function-breakpoint entry stop.
   *
   * Returns false when the stop cannot be one — the reason gate: [DEBUG-GAPS]
   * "Function-breakpoint stop reason" records that netcoredbg reports the
   * plain `breakpoint` reason and names no `hitBreakpointIds`, so any
   * `breakpoint` stop while function breakpoints are armed passes the gate.
   * A gated stop is then classified asynchronously by where it parked and
   * routed: [DEBUG-GAPS] requires identifying the kind from the breakpoint
   * that BOUND, so a top frame sitting on an armed line-breakpoint location
   * is that line breakpoint's stop — even parked on a closing brace — and is
   * `deliver`ed on the normal judged path. Only a stop matching NO armed line
   * breakpoint may be a function entry, whose `elide` moves it off the entry
   * brace.
   */
  public routeFunctionEntry(
    reason: string,
    threadId: number,
    host: RequestHost,
    route: StopRoute,
  ): boolean {
    const mayBeEntry =
      reason === 'function breakpoint' ||
      (reason === 'breakpoint' && this.armedFunctions.length > 0);
    if (!mayBeEntry) return false;
    void this.classifyEntry(threadId, host, route);
    return true;
  }

  /**
   * Classify one gated stop by its parked location, then route it.
   *
   * The probe never rejects (the correlator settles a dead child with
   * `success: false`); an unreadable stack routes to the elision, which
   * delivers unmoved stops exactly as they arrived, so no stop can vanish.
   */
  private async classifyEntry(
    threadId: number,
    host: RequestHost,
    route: StopRoute,
  ): Promise<void> {
    const stack = await host.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    const { path, line } = topFrameLocation(stack.body);
    const lineBreakpoint = path !== undefined && this.lineBreakpointAt(path, line);
    if (lineBreakpoint) route.deliver();
    else route.elide();
  }

  /** True when an armed line breakpoint sits at this reported location. */
  private lineBreakpointAt(path: string, line: number): boolean {
    return this.byLocation.get(normalizePath(path))?.has(line) === true;
  }

  /**
   * Re-arm the recorded function breakpoints on a respawned adapter.
   *
   * `restart` and the terminal-launch attach replace the netcoredbg child
   * without the client ever being told, so the set the client armed must be
   * re-sent in the router's own name before the replayed `configurationDone`
   * resumes the debuggee. The correlator settles a refusal or a dead child
   * with `success: false` instead of rejecting, so this never throws; the
   * recorded set is kept either way, and a re-arm the adapter refused or
   * failed is `report`ed by name instead of disappearing silently.
   */
  public async replayFunctions(
    host: RequestHost,
    report: (message: string) => void,
  ): Promise<void> {
    if (this.armedFunctions.length === 0) return;
    const breakpoints = this.armedFunctions.map((armed) => ({ ...armed }));
    const response = await host.request('setFunctionBreakpoints', { breakpoints });
    const lost = this.lostFunctions(response);
    if (lost.length === 0) return;
    report(`function breakpoint re-arm failed after adapter respawn: ${lost.join(', ')}`);
  }

  /**
   * The armed names a re-arm response refused, dropped, or failed to bind.
   *
   * A refused request loses every name; an entry the response omits is lost;
   * an unverified entry carrying an adapter `message` failed with that reason.
   * A PLAIN unverified entry is deliberately not counted: immediately after a
   * respawn the module is not loaded yet, so `verified: false` is the lazy
   * verification [DEBUG-FEATURES-BREAKPOINTS-VERIFY] defines as "not yet
   * bound — NOT a failure", answered by a later `breakpoint` event.
   */
  private lostFunctions(response: DapMessage): string[] {
    if (response.success !== true) {
      return this.armedFunctions.map((armed) => functionName(armed));
    }
    const confirmed = recordList(isRecord(response.body) ? response.body.breakpoints : undefined);
    return this.armedFunctions.flatMap((armed, index) => {
      const entry = confirmed[index];
      const failed =
        entry === undefined || (entry.verified !== true && typeof entry.message === 'string');
      return failed ? [functionName(armed)] : [];
    });
  }

  /** Judge one stop. `hits` is `hitBreakpointIds`, already numbers. */
  public judge(hits: readonly number[], threadId: number): StopVerdict {
    if (hits.length === 0) return { action: 'forward' };
    const visits = hits.map((id) => {
      const entry = this.meta.get(id);
      const count = (this.counts.get(String(id)) ?? 0) + 1;
      this.counts.set(String(id), count);
      return this.visitFor(entry, count);
    });
    return this.combine(visits, threadId);
  }

  /** Judge a stop that named no breakpoint id, by where it landed. */
  public judgeLocation(
    path: string,
    line: number,
    threadId: number,
  ): StopVerdict & { known: boolean; hitId?: number | undefined } {
    const source = normalizePath(path);
    const entry = this.byLocation.get(source)?.get(line);
    if (entry === undefined) return { action: 'forward', known: false };
    const key = locationKey(source, line);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return {
      ...this.combine([this.visitFor(entry, count)], threadId),
      known: true,
      hitId: entry.id,
    };
  }

  /** True once any breakpoint with emulated attributes is armed. */
  public hasEmulatedAttributes(): boolean {
    return this.byLocation.size > 0 || this.meta.size > 0;
  }

  /** The verdict for one counted visit of a breakpoint. */
  private visitFor(entry: BreakpointMeta | undefined, count: number): Visit {
    const condition = parseHitCondition(entry?.hitCondition);
    const tokens = tokenizeLogMessage(entry?.logMessage);
    const passes = condition === undefined || condition.satisfies(count);
    return { passes, tokens };
  }

  /** Fold per-breakpoint visits into one decision. */
  private combine(visits: readonly Visit[], threadId: number): StopVerdict {
    const anyPlain = visits.some((visit) => visit.passes && visit.tokens === undefined);
    if (anyPlain) return { action: 'forward' };
    const logOnly = visits.every((visit) => visit.tokens !== undefined);
    if (logOnly) return { action: 'log', tokens: visits[0]?.tokens, threadId };
    return { action: 'continue', threadId };
  }
}
