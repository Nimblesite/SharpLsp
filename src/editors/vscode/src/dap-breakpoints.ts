// The hit-count and logpoint half of the router's Phase-4 breakpoint emulation.
//
// Implements [DEBUG-FEATURES-BREAKPOINTS] rows netcoredbg cannot serve
// ([DEBUG-ADAPTER-GAPS] records it ignores `hitCondition` and `logMessage`
// outright): the DapRouter keeps this bookkeeping and decides, for every stop
// that names breakpoints, whether the stop must reach VS Code, be silently
// continued, or be turned into a logpoint `output` event.
//
// Deliberately free of `vscode` imports so the judgement stays unit-testable
// against captured DAP payloads.
import {
  isRecord,
  parseHitCondition,
  recordList,
  tokenizeLogMessage,
  type LogToken,
} from './dap-emulate';

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

/** A `path:line` key for location lookups. */
function locationKey(path: string, line: number): string {
  return `${path}:${String(line)}`;
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
  /** `path:line` -> attributes, for stops that name no breakpoint id. */
  private readonly byLocation = new Map<string, BreakpointMeta>();
  /** Adapter breakpoint id (or location key) -> visits observed. */
  private readonly counts = new Map<string, number>();

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
    this.byLocation.clear();
    confirmed.forEach((breakpoint, index) => {
      const id = Number(breakpoint.id ?? 0);
      const authored = sent[index] ?? { line: undefined };
      const attributes: BreakpointMeta = {
        hitCondition: authored.hitCondition,
        logMessage: authored.logMessage,
        line: authored.line,
        id,
      };
      if (id <= 0) return;
      this.meta.set(id, attributes);
      if (path !== undefined && typeof authored.line === 'number') {
        this.byLocation.set(locationKey(path, authored.line), attributes);
      }
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
    const key = locationKey(path, line);
    const entry = this.byLocation.get(key);
    if (entry === undefined) return { action: 'forward', known: false };
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
