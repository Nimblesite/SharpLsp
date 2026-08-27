// `stackTrace` delivery for the DAP proxy: async enrichment, then the caller's
// window re-applied to the LOGICAL stack.
//
// Implements the editor-side half of the async call-stack rows of
// [DEBUG-FEATURES-STACK] and [DEBUG-FEATURES-STACK-ASYNC]: netcoredbg reports the
// physical `MoveNext` frames of a state machine, `dap-frames.ts` reconstructs
// the logical chain from them, and this module decides what the client
// actually receives.
//
// Deliberately free of `vscode` imports so the delivery decision stays
// exercisable directly against captured netcoredbg responses.
import { enrichAsyncFrames, type RawFrame } from './dap-frames';
import { isRecord, type DapMessage } from './dap-emulate';
import type { HandleNamespace } from './dap-namespace';

/** Narrow the parsed frames to the shape the transform reads. */
function isFrameList(value: unknown): value is RawFrame[] {
  return Array.isArray(value);
}

/** Apply the caller's `startFrame`/`levels` window to enriched frames. */
function withWindow(message: DapMessage, args: Record<string, unknown> | undefined): DapMessage {
  const body = isRecord(message.body) ? message.body : {};
  const frames = isFrameList(body.stackFrames) ? body.stackFrames : [];
  const start = Number(args?.startFrame ?? 0);
  const levels = Number(args?.levels ?? 0);
  if ((start <= 0 || !Number.isInteger(start)) && (levels <= 0 || !Number.isInteger(levels))) {
    return message;
  }
  const from = Number.isInteger(start) && start > 0 ? start : 0;
  const count = Number.isInteger(levels) && levels > 0 ? levels : frames.length;
  return { ...message, body: { ...body, stackFrames: frames.slice(from, from + count) } };
}

/** What stack delivery needs from its owning router. */
export interface StackHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Emit one message towards VS Code exactly as it is framed. */
  emit(message: DapMessage): void;
}

/** Enriches and windows every `stackTrace` response before the client sees it. */
export class StackDelivery {
  /** Mirrors the launch argument so stack enrichment matches the user's choice. */
  private justMyCode = true;

  constructor(
    private readonly host: StackHost,
    private readonly handles: HandleNamespace,
  ) {}

  /** Track `justMyCode` off the launch/attach request that carries it. */
  public setJustMyCode(value: boolean): void {
    this.justMyCode = value;
  }

  /**
   * Deliver a `stackTrace` response, windowing the ENRICHED stack, not the
   * physical one.
   *
   * Just-My-Code filtering is meaningless on a window: a `levels: 1` request
   * that lands on a runtime frame (paused in `Thread.Sleep`) would filter to
   * an EMPTY stack and the user would see nothing to inspect. When the window
   * collapses, the full stack is fetched, enriched, and the caller's original
   * window re-applied to the logical frames.
   */
  public deliver(message: DapMessage, args: Record<string, unknown> | undefined): void {
    const body = isRecord(message.body) ? message.body : {};
    const frames = isFrameList(body.stackFrames) ? body.stackFrames : [];
    const logical = enrichAsyncFrames(frames, this.justMyCode);
    if (logical.length > 0 || frames.length === 0) {
      this.emitStack(message, body, args, logical);
      return;
    }
    const threadId = Number(args?.threadId ?? 0);
    void this.host
      .request('stackTrace', { threadId, startFrame: 0, levels: 1_000 })
      .then((full) => {
        this.emitStack(message, body, args, this.enrichedOrPhysical(full));
      })
      .catch(() => {
        // Never leave the caller without a stack; the physical frames are the
        // adapter's own answer.
        this.host.emit(message);
      });
  }

  /** The logical stack of a full fetch, or its physical frames if none survive. */
  private enrichedOrPhysical(full: DapMessage): RawFrame[] {
    const fullBody = isRecord(full.body) ? full.body : {};
    const fullFrames = isFrameList(fullBody.stackFrames) ? fullBody.stackFrames : [];
    const enriched = enrichAsyncFrames(fullFrames, this.justMyCode);
    return enriched.length > 0 ? enriched : fullFrames;
  }

  /** Emit one enriched stack, windowed and handle-translated as promised. */
  private emitStack(
    message: DapMessage,
    body: Record<string, unknown>,
    args: Record<string, unknown> | undefined,
    frames: readonly RawFrame[],
  ): void {
    const windowed = withWindow(
      { ...message, body: { ...body, stackFrames: frames, totalFrames: frames.length } },
      args,
    );
    this.host.emit(this.handles.translateResponseBody(windowed));
  }
}
