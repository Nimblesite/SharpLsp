// Same-line step coalescing for the DAP proxy.
//
// Implements the "one gesture, one statement" half of
// [DEBUG-FEATURES-STEPPING] rows "Step over | next | P1", "Step into | stepIn |
// P1" and "Step out | stepOut | P1".
//
// A single source line can carry SEVERAL sequence points, and `ICorDebugStepper`
// stops at each one. F# is where this bites hardest — `for index in 1 .. 3 do`
// compiles to a sequence point for the loop construct AND one for the range
// enumerator, both on the loop-header line — so F10 on that line comes to rest
// on the line it started from and the user has to press F10 twice to move one
// statement. C# `for (var index = 1; index <= 3; index++)` has the same shape.
// [DEBUG-MISSION] requires the same specified behaviour for C# and F#, and a
// step gesture that visibly does nothing is worse in F# than in C# precisely
// because F# emits more of these.
//
// The rule is deliberately narrow: a step is re-issued only when the debuggee
// came to rest at the SAME line of the SAME source at the SAME stack depth it
// started from. Any of those changing is real movement the user must see —
// stepping out of a recursive call lands on the same line of the same file one
// frame shallower, and that is a stop, not a no-op.
//
// Deliberately free of `vscode` imports so the judgement stays exercisable
// directly against captured netcoredbg output.
import { isRecord, recordList, type DapMessage } from './dap-emulate';

/** The DAP requests whose stops are coalesced. */
export const STEP_COMMANDS: readonly string[] = ['next', 'stepIn', 'stepOut'];

/** The DAP stop reason a stepper completion carries. */
const STEP_REASON = 'step';

/**
 * How many extra sequence points one gesture may absorb.
 *
 * Bounded so a pathological run of same-line sequence points can never spin:
 * once the budget is spent the stop is delivered, and the user presses again.
 */
const MAX_COALESCED = 8;

/**
 * Stepping granularities a LINE comparison is a valid no-op test for.
 *
 * DAP also defines `instruction`, where several stops on one source line are
 * the whole point of the gesture; coalescing those would make the Disassembly
 * view's step button skip the rest of the line. An absent granularity is
 * `statement`, DAP's default.
 */
const LINE_GRANULARITIES: readonly string[] = ['statement', 'line'];

/** Where a stop happened, at the granularity coalescing compares. */
export interface StepLocation {
  /** The frame's source path, or undefined for a frame with no source. */
  readonly path: string | undefined;
  /** The 1-based DAP line the frame is parked on. */
  readonly line: number;
  /** The 1-based DAP column where the sequence point starts. */
  readonly column: number;
  /** The full stack depth, which separates recursion from a no-op step. */
  readonly depth: number;
}

/** The step in flight, and how much of its budget is spent. */
interface PendingStep {
  readonly threadId: number;
  readonly command: string;
  readonly origin: StepLocation;
  /** Original function-breakpoint event whose reason survives brace elision. */
  readonly deliverAs?: DapMessage;
  absorbed: number;
}

/** What the coalescer needs from its owning router. */
export interface StepHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Send one client request on to the adapter, unchanged. */
  forward(message: DapMessage): void;
  /** Hand a `stopped` event back to the router's normal delivery path. */
  deliverStop(message: DapMessage): void;
  /** Whether this source position carries code rather than block punctuation. */
  carriesCode(location: StepLocation): Promise<boolean>;
}

/**
 * The location a `stackTrace` response body reports for its first frame.
 *
 * `totalFrames` is the adapter's own count of the whole stack; a response that
 * omits it leaves the depth unknown, which `sameStatement` treats as "cannot
 * prove this is a no-op" rather than as a match.
 */
export function topFrameLocation(body: unknown): StepLocation {
  const record = isRecord(body) ? body : {};
  const frame = recordList(record.stackFrames)[0];
  const source = isRecord(frame?.source) ? frame.source : undefined;
  return {
    path: typeof source?.path === 'string' ? source.path : undefined,
    line: Number(frame?.line ?? 0),
    column: Number(frame?.column ?? 0),
    depth: Number(record.totalFrames ?? 0),
  };
}

/** True when the gesture is a source-line step, not an instruction step. */
export function steppingByLine(message: DapMessage): boolean {
  const args = isRecord(message.arguments) ? message.arguments : {};
  const granularity = args.granularity;
  if (granularity === undefined) return true;
  return typeof granularity === 'string' && LINE_GRANULARITIES.includes(granularity);
}

/** True when two stops are the same statement of the same frame. */
export function sameStatement(before: StepLocation, after: StepLocation): boolean {
  if (before.path === undefined || after.path === undefined) return false;
  if (before.depth <= 0 || after.depth <= 0) return false;
  return before.path === after.path && before.line === after.line && before.depth === after.depth;
}

/** Re-issues a step that left the debuggee on the line it started from. */
export class StepCoalescer {
  private pending: PendingStep | undefined;
  /** Serialises the location probes so they never interleave. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: StepHost) {}

  /**
   * Intercept one client step request: record where it starts, then forward it.
   *
   * The client's own message is forwarded verbatim so netcoredbg answers the
   * client's `seq` directly; only the re-issued steps are the router's own.
   */
  public begin(message: DapMessage, command: string, threadId: number): void {
    if (!steppingByLine(message)) {
      this.pending = undefined;
      this.host.forward(message);
      return;
    }
    this.run(async () => {
      const origin = await this.locate(threadId);
      this.pending = origin.depth > 0 ? { threadId, command, origin, absorbed: 0 } : undefined;
      this.host.forward(message);
    });
  }

  /** Forget the step in flight; the next stop is delivered as it arrives. */
  public reset(): void {
    this.pending = undefined;
  }

  /**
   * Move a function-breakpoint stop from a structural entry brace to the first
   * statement, retaining the original event's `function breakpoint` reason.
   */
  public elideFunctionEntry(message: DapMessage, threadId: number): boolean {
    this.run(async () => {
      const origin = await this.locate(threadId);
      if (await this.host.carriesCode(origin)) {
        this.host.deliverStop(message);
        return;
      }
      const pending: PendingStep = {
        threadId,
        command: 'next',
        origin,
        deliverAs: message,
        absorbed: 1,
      };
      this.pending = pending;
      const response = await this.host.request('next', { threadId });
      if (response.success === false && this.pending === pending) {
        this.pending = undefined;
        this.host.deliverStop(message);
      }
    });
    return true;
  }

  /**
   * Judge one `stopped` event. Returns true when the router must not deliver
   * it — either because it is being coalesced away or because delivery has
   * been deferred until the location probe answers.
   */
  public onStopped(message: DapMessage, threadId: number, reason: string): boolean {
    const pending = this.pending;
    if (pending === undefined) return false;
    if (reason !== STEP_REASON || pending.threadId !== threadId) {
      this.pending = undefined;
      return false;
    }
    if (pending.absorbed >= MAX_COALESCED) {
      this.pending = undefined;
      return false;
    }
    this.run(async () => {
      await this.judge(message, pending);
    });
    return true;
  }

  /** Re-step when nothing moved; otherwise hand the stop back to the router. */
  private async judge(message: DapMessage, pending: PendingStep): Promise<void> {
    const now = await this.locate(pending.threadId);
    const movedToCode = !sameStatement(pending.origin, now) && (await this.host.carriesCode(now));
    if (this.pending !== pending || movedToCode) {
      this.pending = undefined;
      this.host.deliverStop(pending.deliverAs ?? message);
      return;
    }
    pending.absorbed += 1;
    const again = await this.host.request(pending.command, { threadId: pending.threadId });
    // A refused re-step means no further `stopped` is coming, so the stop that
    // was swallowed on its behalf is the only one the user will ever get.
    if (again.success === false) {
      this.pending = undefined;
      this.host.deliverStop(pending.deliverAs ?? message);
    }
  }

  /**
   * Ask the adapter where the stopped thread's innermost frame is parked.
   *
   * Never rejects: an unreadable stack is reported as an unknown location,
   * which `sameStatement` refuses to match, so the stop is delivered rather
   * than swallowed by a failure the user cannot see.
   */
  private async locate(threadId: number): Promise<StepLocation> {
    try {
      const stack = await this.host.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
      return topFrameLocation(stack.body);
    } catch {
      return { path: undefined, line: 0, column: 0, depth: 0 };
    }
  }

  /**
   * Run one probe on the serialised queue.
   *
   * A failed probe must never strand the session: the step in flight is
   * forgotten so the next stop is delivered normally.
   */
  private run(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch(() => {
      this.pending = undefined;
    });
  }
}
