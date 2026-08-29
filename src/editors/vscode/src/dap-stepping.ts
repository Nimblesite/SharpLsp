// Step-stop judgement for the DAP proxy: same-statement coalescing, block
// entry/exit elision, and Just-My-Code traversal of symbol-carrying machinery.
//
// Implements the "one gesture, one statement" half of
// [DEBUG-FEATURES-STEPPING] rows "Step over | next | P1", "Step into | stepIn |
// P1", "Step out | stepOut | P1", and the "Just My Code | launch config | P1"
// row for code netcoredbg cannot classify itself.
//
// A single source line can carry SEVERAL sequence points, and `ICorDebugStepper`
// stops at each one. F# is where this bites hardest — `for index in 1 .. 3 do`
// compiles to a sequence point for the loop construct AND one for the range
// enumerator, both on the loop-header line — so F10 on that line comes to rest
// on the line it started from and the user has to press F10 twice to move one
// statement. C# `for (var index = 1; index <= 3; index++)` has the same shape.
// [DEBUG-MISSION] requires the same specified behaviour for C# and F#.
//
// The same-line no-op rule is STATEMENT-aware, not line-aware. A gesture that
// began on pure block structure (a `{`, judged over the concrete syntax tree
// by `carriesCode`) and lands on a DIFFERENT column of that line that DOES
// carry code has reached the block's first real statement — the single-line
// body `{ return _x; }` — and that is a stop, not a no-op. And an elision that
// finds itself SHALLOWER than where it began has escaped its frame: it stops
// and delivers right there, because re-stepping would run the caller the user
// never asked to run.
//
// Just My Code emulation: netcoredbg's own stepper only skips code WITHOUT
// symbols. FSharp.Core ships embedded PDBs, so one F11 into `printfn` or a
// `task {}` builder physically parks in the library's own source
// ([DEBUG-FSHARP-PDB]). A step-stop in code the user does not own is therefore
// traversed rather than shown: a `stepIn` gesture DIGS for the user callback
// the machinery is about to invoke (the body of a `task {}`), and when the dig
// budget is spent — `printfn` never reaches user code by digging — the gesture
// CLIMBS back out with `stepOut` and retries the origin line's next call.
// Every budget is bounded, and exhaustion DELIVERS the raw stop: the emulation
// degrades to netcoredbg's own answer, never to a spin.
//
// Deliberately free of `vscode` imports: the ownership and statement
// judgements arrive through the host callbacks, so the judgement stays
// exercisable directly against captured netcoredbg output.
import { isRecord, recordList, type DapMessage } from './dap-emulate';

/** The DAP requests whose stops are coalesced. */
export const STEP_COMMANDS: readonly string[] = ['next', 'stepIn', 'stepOut'];

/** The DAP stop reason a stepper completion carries. */
const STEP_REASON = 'step';

/** Why a stop is being delivered, for the delivery path's own judgement. */
export type StopOrigin = 'function-entry';

/**
 * How many same-statement sequence points one gesture may absorb.
 *
 * Bounded so a pathological run of same-line sequence points can never spin:
 * once the budget is spent the stop is delivered, and the user presses again.
 */
const MAX_COALESCED = 8;

/** `stepIn` probes spent digging through one stretch of non-user code. */
const MAX_MACHINERY_EXPLORE = 16;

/** `stepOut` climbs allowed while escaping non-user code. */
const MAX_MACHINERY_ESCAPES = 24;

/** Hard cap on every swallowed stop for one gesture, whatever the mode. */
const MAX_TOTAL_ABSORBED = 64;

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

/** The step in flight, and how much of its budgets are spent. */
interface PendingStep {
  readonly threadId: number;
  readonly command: StepCommand;
  readonly origin: StepLocation;
  /** Original function-breakpoint event whose reason survives brace elision. */
  readonly deliverAs?: DapMessage;
  /** Whether the ORIGIN position carries code, resolved when the step begins. */
  readonly originCarries: boolean;
  /** Every stop swallowed on this gesture's behalf. */
  absorbed: number;
  /** Same-statement and structure re-steps, capped at MAX_COALESCED. */
  plainSteps: number;
  /** `stepIn` probes spent in the current stretch of non-user code. */
  machinerySteps: number;
  /** `stepOut` climbs spent escaping the current stretch of non-user code. */
  escapes: number;
}

/** The gestures a pending step may re-issue. */
type StepCommand = 'next' | 'stepIn' | 'stepOut';

/** Parse a wire command into a re-issuable step gesture. */
function asStepCommand(command: string): StepCommand | undefined {
  return command === 'next' || command === 'stepIn' || command === 'stepOut' ? command : undefined;
}

/** What the coalescer decided to do with one stop. */
type Verdict = 'deliver' | StepCommand;

/** What the coalescer needs from its owning router. */
export interface StepHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Send one client request on to the adapter, unchanged. */
  forward(message: DapMessage): void;
  /** Hand a `stopped` event back to the router's normal delivery path. */
  deliverStop(message: DapMessage, origin?: StopOrigin): void;
  /** Whether this source position carries code rather than block punctuation. */
  carriesCode(location: StepLocation): Promise<boolean>;
  /** Whether this location belongs to the launched project rather than framework code. */
  belongsToUser(location: StepLocation): boolean;
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

/** True when two stops are on the same line of the same frame. */
export function sameStatement(before: StepLocation, after: StepLocation): boolean {
  if (before.path === undefined || after.path === undefined) return false;
  if (before.depth <= 0 || after.depth <= 0) return false;
  return before.path === after.path && before.line === after.line && before.depth === after.depth;
}

/** True when the stack is provably shallower than where the gesture began. */
function escapedFrame(origin: StepLocation, now: StepLocation): boolean {
  return origin.depth > 0 && now.depth > 0 && now.depth < origin.depth;
}

/** The zeroed budget fields a fresh gesture starts with. */
function freshBudgets(): Pick<
  PendingStep,
  'absorbed' | 'plainSteps' | 'machinerySteps' | 'escapes'
> {
  return { absorbed: 0, plainSteps: 0, machinerySteps: 0, escapes: 0 };
}

/** The pending step an entry elision starts with: one `next` already spent. */
function elisionPending(message: DapMessage, threadId: number, origin: StepLocation): PendingStep {
  return {
    threadId,
    command: 'next',
    origin,
    deliverAs: message,
    originCarries: false,
    ...freshBudgets(),
    absorbed: 1,
    plainSteps: 1,
  };
}

/**
 * The move to make from inside non-user code.
 *
 * A `stepIn` gesture DIGS first — `task {}` builders invoke the user's own
 * body a few frames down, and stepping out would run that body to completion
 * unseen. Once the dig budget is spent, the gesture CLIMBS out so the origin
 * line's next call can be tried. `next` and `stepOut` gestures never dig:
 * entering machinery was not what those gestures meant.
 */
function machineryVerdict(pending: PendingStep): Verdict {
  const digging = pending.command === 'stepIn' && pending.escapes === 0;
  if (digging && pending.machinerySteps < MAX_MACHINERY_EXPLORE) {
    pending.machinerySteps += 1;
    return 'stepIn';
  }
  if (pending.escapes < MAX_MACHINERY_ESCAPES) {
    pending.escapes += 1;
    return 'stepOut';
  }
  return 'deliver';
}

/** Re-issues a step that left the debuggee short of a showable statement. */
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
    const stepCommand = asStepCommand(command);
    this.run(async () => {
      const origin = await this.locate(threadId);
      const originCarries = await this.host.carriesCode(origin);
      this.pending =
        origin.depth > 0 && stepCommand !== undefined
          ? { threadId, command: stepCommand, origin, originCarries, ...freshBudgets() }
          : undefined;
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
        this.host.deliverStop(message, 'function-entry');
        return;
      }
      const pending = elisionPending(message, threadId, origin);
      this.pending = pending;
      const response = await this.host.request('next', { threadId });
      if (response.success === false && this.pending === pending) {
        this.pending = undefined;
        this.host.deliverStop(message, 'function-entry');
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
    if (pending.absorbed >= MAX_TOTAL_ABSORBED) {
      this.pending = undefined;
      return false;
    }
    this.run(async () => {
      await this.judge(message, pending);
    });
    return true;
  }

  /** Act on one located stop: deliver it, or spend budget on another step. */
  private async judge(message: DapMessage, pending: PendingStep): Promise<void> {
    const now = await this.locate(pending.threadId);
    const verdict = this.pending === pending ? await this.decide(pending, now) : 'deliver';
    if (verdict === 'deliver') {
      this.deliver(message, pending);
      return;
    }
    pending.absorbed += 1;
    const again = await this.host.request(verdict, { threadId: pending.threadId });
    // A refused re-step means no further `stopped` is coming, so the stop that
    // was swallowed on its behalf is the only one the user will ever get.
    if (again.success === false) this.deliver(message, pending);
  }

  /** Hand the stop to the router's delivery path and retire the gesture. */
  private deliver(message: DapMessage, pending: PendingStep): void {
    if (this.pending === pending) this.pending = undefined;
    this.host.deliverStop(
      pending.deliverAs ?? message,
      pending.deliverAs === undefined ? undefined : 'function-entry',
    );
  }

  /** The full judgement matrix for one located stop. */
  private async decide(pending: PendingStep, now: StepLocation): Promise<Verdict> {
    if (await this.isMachinery(now)) return machineryVerdict(pending);
    pending.machinerySteps = 0;
    pending.escapes = 0;
    if (sameStatement(pending.origin, now)) return await this.sameLineVerdict(pending, now);
    if (escapedFrame(pending.origin, now) && !pending.originCarries) {
      // An elision that escaped its frame must stop HERE: re-stepping executes
      // the caller the user never asked to run.
      return 'deliver';
    }
    if (await this.host.carriesCode(now)) return 'deliver';
    return this.plainRestep(pending);
  }

  /** Same path, line and depth: statement identity decides, not the line. */
  private async sameLineVerdict(pending: PendingStep, now: StepLocation): Promise<Verdict> {
    if (now.column !== pending.origin.column && !pending.originCarries) {
      if (await this.host.carriesCode(now)) {
        // The gesture began on block structure and this column IS a statement:
        // the single-line body `{ return _x; }` the elision exists to reach.
        return 'deliver';
      }
    }
    return this.plainRestep(pending);
  }

  /** One more same-statement/structure re-step, if the budget allows. */
  private plainRestep(pending: PendingStep): Verdict {
    if (pending.plainSteps >= MAX_COALESCED) return 'deliver';
    pending.plainSteps += 1;
    return pending.command;
  }

  /** True when a stop parked in symbol-carrying code the user does not own. */
  private async isMachinery(now: StepLocation): Promise<boolean> {
    if (now.path === undefined || this.host.belongsToUser(now)) return false;
    return !(await this.host.carriesCode(now));
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
