// The delivery half of the router's Phase-4 breakpoint emulation: deciding
// whether one netcoredbg `stopped` event ever reaches the user.
//
// `dap-breakpoints.ts` counts visits and returns a verdict; this module ACTS on
// it — forwarding the stop, silently continuing it, or turning it into a
// logpoint `output` event — which is what makes the
// [DEBUG-FEATURES-BREAKPOINTS] rows [DEBUG-ADAPTER-GAPS] records netcoredbg
// ignores (`hitCondition`, `logMessage`) behave as the spec describes.
//
// It also resolves the stops netcoredbg names NO breakpoint ids for, by asking
// where the debuggee actually parked and matching that location against the
// armed set — the same probe run-to-cursor ([DEBUG-FEATURES-STEPPING], P2)
// needs to retire its temporary breakpoint.
import { interpolateLog, isRecord, recordList } from './dap-emulate';
import type { DapMessage, LogToken } from './dap-emulate';
import type { BreakpointEmulator, StopVerdict } from './dap-breakpoints';
import type { GotoEmulator } from './dap-goto';
import type { HandleNamespace } from './dap-namespace';
import { topFrameLocation } from './dap-stepping';
import { error } from './log';

/** What a location match knows about the breakpoint the stop landed on. */
interface LocatedBreakpoint {
  readonly known: boolean;
  readonly hitId?: number | undefined;
}

/** What the stop judge needs from its owning router. */
export interface StopHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Emit one message towards VS Code. */
  fire(message: Record<string, unknown> & { seq?: unknown }): void;
  /** True while a respawn replays the handshake; stale stops are swallowed. */
  isTransitioning(): boolean;
  /** Offer a stop to the step coalescer; true when it took ownership of it. */
  coalesceStep(message: DapMessage, threadId: number, reason: string): boolean;
}

/** Judges every `stopped` event against the router's breakpoint emulations. */
export class StopJudge {
  /** Serializes logpoint evaluation so output stays in program order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: StopHost,
    private readonly breakpoints: BreakpointEmulator,
    private readonly goto: GotoEmulator,
    private readonly handles: HandleNamespace,
  ) {}

  /** Auto-continue stops the adapter cannot judge. Returns true when swallowed. */
  public onStopped(message: DapMessage): boolean {
    if (this.host.isTransitioning()) return true;
    const body = isRecord(message.body) ? message.body : {};
    const threadId = Number(body.threadId ?? 0);
    const reason = typeof body.reason === 'string' ? body.reason : '';
    // A step that came to rest on the line it started from is re-issued rather
    // than shown; the coalescer hands anything it declines straight back.
    if (this.host.coalesceStep(message, threadId, reason)) return true;
    return this.judgeStop(message, body, threadId);
  }

  /** Deliver a stop the step coalescer declined, emulations and all. */
  public deliverStop(message: DapMessage): void {
    const body = isRecord(message.body) ? message.body : {};
    if (this.judgeStop(message, body, Number(body.threadId ?? 0))) return;
    this.host.fire(message);
  }

  /** Judge one stop against the breakpoint emulations. True when swallowed. */
  private judgeStop(message: DapMessage, body: Record<string, unknown>, threadId: number): boolean {
    const rawHits = Array.isArray(body.hitBreakpointIds) ? body.hitBreakpointIds.map(Number) : [];
    if (rawHits.length === 0) {
      // netcoredbg names no breakpoint ids; judge by where the stop landed.
      if (this.breakpoints.hasEmulatedAttributes() || this.goto.hasTemp()) {
        this.judgeByLocation(message, threadId);
        return true;
      }
      return false;
    }
    this.goto.absorbHit(rawHits);
    return this.actOn(this.breakpoints.judge(rawHits, threadId));
  }

  /** Resolve an id-less stop asynchronously: locate, then act. */
  private judgeByLocation(message: DapMessage, threadId: number): void {
    this.queue = this.queue
      .then(async () => {
        await this.locateAndAct(message, threadId);
      })
      .catch((cause: unknown) => {
        error(`stop emulation failed: ${String(cause)}`);
      });
  }

  /** Ask where the debuggee parked, then forward, log, or silently continue. */
  private async locateAndAct(message: DapMessage, threadId: number): Promise<void> {
    const stack = await this.host.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    const { path: source, line } = topFrameLocation(stack.body);
    this.goto.absorbHitAt(source, line);
    const verdict =
      source !== undefined
        ? this.breakpoints.judgeLocation(source, line, threadId)
        : { action: 'forward' as const, known: false };
    if (verdict.action === 'forward') {
      this.forwardLocated(message, verdict);
      return;
    }
    if (verdict.action === 'log') {
      await this.runLogpoint(verdict.tokens, verdict.threadId);
      return;
    }
    await this.host.request('continue', { threadId });
  }

  /**
   * Forward a located stop, naming the breakpoint netcoredbg did not.
   *
   * netcoredbg names no breakpoint ids; the location match knows which one it
   * was, so the forwarded stop carries it for VS Code and the suites that read
   * `hitBreakpointIds`.
   */
  private forwardLocated(message: DapMessage, verdict: LocatedBreakpoint): void {
    const hitIds =
      verdict.known && verdict.hitId !== undefined
        ? [this.handles.outward(verdict.hitId)]
        : undefined;
    this.host.fire(
      hitIds === undefined
        ? message
        : {
            ...message,
            body: {
              ...(isRecord(message.body) ? message.body : {}),
              hitBreakpointIds: hitIds,
            },
          },
    );
  }

  /** Act on a folded verdict. Returns true when the stop is swallowed. */
  private actOn(verdict: StopVerdict): boolean {
    if (verdict.action === 'forward') return false;
    if (verdict.action === 'continue') {
      const threadId = verdict.threadId;
      void this.host.request('continue', { threadId }).catch(() => undefined);
      return true;
    }
    this.queue = this.queue
      .then(async () => {
        await this.runLogpoint(verdict.tokens, verdict.threadId);
      })
      .catch((cause: unknown) => {
        error(`logpoint emulation failed: ${String(cause)}`);
      });
    return true;
  }

  /** Evaluate a logpoint message in the stopped frame, print it, resume. */
  private async runLogpoint(tokens: LogToken[] | undefined, threadId: number): Promise<void> {
    if (tokens === undefined || tokens.length === 0) {
      await this.host.request('continue', { threadId });
      return;
    }
    const stack = await this.host.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    const body = isRecord(stack.body) ? stack.body : {};
    const frameId = Number(recordList(body.stackFrames)[0]?.id ?? 0);
    const values = await this.evaluateAll(tokens, frameId);
    const output = `${interpolateLog(tokens, values)}\n`;
    this.host.fire({ type: 'event', event: 'output', body: { category: 'console', output } });
    await this.host.request('continue', { threadId });
  }

  /** Evaluate every expression token of a logpoint, in author order. */
  private async evaluateAll(tokens: readonly LogToken[], frameId: number): Promise<string[]> {
    const values: string[] = [];
    for (const token of tokens) {
      if (token.kind !== 'expression') continue;
      const evaluation = await this.host.request('evaluate', {
        expression: token.expression,
        frameId,
        context: 'repl',
      });
      const result = isRecord(evaluation.body) ? evaluation.body.result : undefined;
      values.push(typeof result === 'string' ? result : '{?}');
    }
    return values;
  }
}
