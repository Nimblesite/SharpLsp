// `stackTrace` delivery for the DAP proxy: async enrichment, heap-recovered
// awaiting frames, and the caller's window re-applied to the LOGICAL stack.
//
// Implements the editor-side half of the async call-stack rows of
// [DEBUG-FEATURES-STACK] and [DEBUG-FEATURES-STACK-ASYNC]: netcoredbg reports
// the physical `MoveNext` frames of a state machine; `dap-frames.ts` renames
// and filters them, `dap-async-chain.ts` walks the heap's continuation chain
// for the awaiting callers that are on NO thread's stack, and this module
// splices the two together, serves `scopes` for the injected frames, and
// decides what the client actually receives. Source locations for injected
// frames come from the language server via `dap-frame-sources.ts` (the
// "resolve the type with Roslyn" step, served for C# and F# alike).
//
// The chain registry only exists if `Task.s_asyncDebuggingEnabled` was set
// BEFORE the awaits ran, so `onLaunch` arms every debug launch with an
// invisible entry stop: `stopAtEntry` is forced on, the resulting `entry`
// stop flips the flag and silently continues, and a user-requested entry stop
// is armed in passing and delivered untouched.
import {
  enrichAsyncFrames,
  frameStateMachineType,
  logicalFrameName,
  splitQualifiedName,
  withoutArguments,
  type RawFrame,
} from './dap-frames';
import { armAsyncDebugging, readAsyncChain, topFrameId, type AsyncChain } from './dap-async-chain';
import { resolveMethodSource } from './dap-frame-sources';
import { belongsToUserCode } from './dap-statement';
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import type { HandleNamespace } from './dap-namespace';
import { error } from './log';

/** Synthetic frame ids live far above netcoredbg's per-stop counters. */
const SYNTHETIC_BASE = 0x0f00_0000;

/** How deep the full-stack refetch reads. */
const FULL_STACK_LEVELS = 1_000;

/** Threads examined when stitching a cut chain from other threads' stacks. */
const MAX_STITCH_THREADS = 16;

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

/** A frame's identity for dedup: its qualified name without arguments. */
function nameKey(name: string): string {
  return withoutArguments(name);
}

/** The bare method a logical frame name renders. */
function bareMethod(name: string): string {
  const segments = splitQualifiedName(nameKey(name));
  return segments[segments.length - 1] ?? name;
}

/** What stack delivery needs from its owning router. */
export interface StackHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Emit one message towards VS Code exactly as it is framed. */
  emit(message: DapMessage): void;
  /** Respond to a client request on the router's behalf. */
  respondTo(message: DapMessage, success: boolean, body: unknown): void;
}

/** The entry-stop arming state of one launch. */
interface Arming {
  /** True when the user's own configuration asked to stop at entry. */
  readonly userWantedEntry: boolean;
}

/** One stop's reconstructed logical stack, reused across window requests. */
interface StackCache {
  readonly threadId: number;
  readonly frames: RawFrame[];
}

/** Enriches and windows every `stackTrace` response before the client sees it. */
export class StackDelivery {
  /** Mirrors the launch argument so stack enrichment matches the user's choice. */
  private justMyCode = true;
  /** The launch `cwd`, anchoring the "is this source the user's" judgement. */
  private launchRoot: string | undefined;
  /** Entry-stop arming for the current launch; undefined for attach/noDebug. */
  private arming: Arming | undefined;
  /** Whether one source path is the user's own code, for frame filtering. */
  private readonly isUserPath = (path: string): boolean =>
    belongsToUserCode({ path, line: 0, column: 0 }, this.launchRoot);
  /** Synthetic frame id -> the state machine's `variablesReference`. */
  private readonly synthetic = new Map<number, number>();
  private nextSyntheticId = SYNTHETIC_BASE;
  /** The current stop's assembled logical stack, per thread. */
  private readonly cache = new Map<number, StackCache>();
  /** Serialises reconstructions so concurrent requests share one walk. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: StackHost,
    private readonly handles: HandleNamespace,
  ) {}

  /** Track `justMyCode` off the launch/attach request that carries it. */
  public setJustMyCode(value: boolean): void {
    this.justMyCode = value;
  }

  /**
   * Observe one launch request, arming async-debugging support.
   *
   * MUTATES the launch arguments: `stopAtEntry` is forced on so the router
   * gets one paused moment before user code runs. The injected stop never
   * reaches the client; a user-requested one is delivered as always.
   */
  public onLaunch(args: Record<string, unknown>): void {
    this.arming = undefined;
    if (typeof args.cwd === 'string') this.launchRoot = args.cwd;
    if (args.noDebug === true) return;
    const userWantedEntry = args.stopAtEntry === true;
    args.stopAtEntry = true;
    this.arming = { userWantedEntry };
  }

  /**
   * Observe one `stopped` event before any other judgement.
   *
   * Returns true when the stop is the router's own injected entry stop, which
   * is consumed here: the async-task registry is enabled and the debuggee is
   * silently resumed. Every stop also invalidates the per-stop stack cache.
   */
  public interceptStop(message: DapMessage): boolean {
    this.cache.clear();
    this.synthetic.clear();
    const body = isRecord(message.body) ? message.body : {};
    if (this.arming === undefined || body.reason !== 'entry') return false;
    const threadId = Number(body.threadId ?? 0);
    if (this.arming.userWantedEntry) {
      void this.armAtStop(threadId, false);
      return false;
    }
    void this.armAtStop(threadId, true);
    return true;
  }

  /** Enable the async-task registry at a paused moment; optionally resume. */
  private async armAtStop(threadId: number, resume: boolean): Promise<void> {
    try {
      await armAsyncDebugging(this.host, await topFrameId(this.host, threadId));
    } catch (cause) {
      error(`async-debug arming failed: ${String(cause)}`);
    }
    if (!resume) return;
    await this.host.request('continue', { threadId }).catch(() => undefined);
  }

  /** Serve `scopes` for an injected logical frame. True when handled. */
  public serveScopes(message: DapMessage): boolean {
    const args = isRecord(message.arguments) ? message.arguments : {};
    const rawId = this.handles.inward(Number(args.frameId ?? -1));
    const localsRef = this.synthetic.get(rawId);
    if (localsRef === undefined) return false;
    const scopes =
      localsRef > 0
        ? [
            {
              name: 'Locals',
              variablesReference: this.handles.outward(localsRef),
              expensive: false,
            },
          ]
        : [];
    this.host.respondTo(message, true, { scopes });
    return true;
  }

  /**
   * Deliver a `stackTrace` response, windowing the LOGICAL stack, not the
   * physical one.
   *
   * A response containing async state-machine frames — or one whose window
   * filtered down to nothing — is rebuilt from a full fetch: renamed, heap
   * reconstruction spliced in, and the caller's original window re-applied.
   */
  public deliver(message: DapMessage, args: Record<string, unknown> | undefined): void {
    const body = isRecord(message.body) ? message.body : {};
    const frames = isFrameList(body.stackFrames) ? body.stackFrames : [];
    const hasAsyncFrames = frames.some((frame) => logicalFrameName(frame.name) !== frame.name);
    const logical = enrichAsyncFrames(frames, this.justMyCode, this.isUserPath);
    if (!hasAsyncFrames && (logical.length > 0 || frames.length === 0)) {
      this.emitStack(message, body, args, logical);
      return;
    }
    const threadId = Number(args?.threadId ?? 0);
    this.queue = this.queue.then(async () => {
      try {
        this.emitStack(message, body, args, await this.logicalStack(threadId));
      } catch (cause) {
        error(`async stack reconstruction failed: ${String(cause)}`);
        this.host.emit(this.handles.translateResponseBody(message));
      }
    });
  }

  /** The full logical stack for a stopped thread, cached per stop. */
  private async logicalStack(threadId: number): Promise<RawFrame[]> {
    const cached = this.cache.get(threadId);
    if (cached !== undefined) return cached.frames;
    const raw = await this.fetchFrames(threadId);
    const assembled = await this.assemble(threadId, raw);
    this.cache.set(threadId, { threadId, frames: assembled });
    return assembled;
  }

  /** One thread's raw physical frames, fetched in full. */
  private async fetchFrames(threadId: number): Promise<RawFrame[]> {
    const full = await this.host.request('stackTrace', {
      threadId,
      startFrame: 0,
      levels: FULL_STACK_LEVELS,
    });
    const body = isRecord(full.body) ? full.body : {};
    return isFrameList(body.stackFrames) ? body.stackFrames : [];
  }

  /** Rename, reconstruct, splice and stitch one thread's logical stack. */
  private async assemble(threadId: number, raw: RawFrame[]): Promise<RawFrame[]> {
    const enriched = enrichAsyncFrames(raw, this.justMyCode, this.isUserPath);
    const renamedKeys = new Set(
      raw
        .map((frame) => logicalFrameName(frame.name))
        .filter((name, index) => name !== raw[index]?.name)
        .map(nameKey),
    );
    if (renamedKeys.size === 0 || raw.length === 0) return enriched;
    const chain = await this.recoverChain(raw);
    const present = new Set(enriched.map((frame) => nameKey(frame.name)));
    const injected = await this.injectedFrames(chain, present, enriched);
    const tail = chain.complete ? [] : await this.stitchedTail(threadId, present, injected);
    const insertAfter = findLastRenamed(enriched, renamedKeys);
    return [
      ...enriched.slice(0, insertAfter + 1),
      ...injected,
      ...enriched.slice(insertAfter + 1),
      ...tail,
    ];
  }

  /** Walk the heap for the awaiting callers of the paused async method. */
  private async recoverChain(raw: RawFrame[]): Promise<AsyncChain> {
    const pausedSmType = raw
      .map((frame) => frameStateMachineType(frame.name))
      .find((smType) => smType !== undefined);
    const pausedMethod = raw
      .map((frame) => ({ logical: logicalFrameName(frame.name), original: frame.name }))
      .filter((entry) => entry.logical !== entry.original)
      .map((entry) => bareMethod(entry.logical))[0];
    const frameId = raw[0]?.id ?? 0;
    try {
      const chain = await readAsyncChain(this.host, frameId, pausedSmType, pausedMethod);
      return chain ?? { frames: [], complete: false };
    } catch {
      return { frames: [], complete: false };
    }
  }

  /** Materialise heap-recovered awaiting frames, resolving their sources. */
  private async injectedFrames(
    chain: AsyncChain,
    present: Set<string>,
    enriched: readonly RawFrame[],
  ): Promise<RawFrame[]> {
    const candidates = enriched
      .map((frame) => frame.source?.path)
      .filter((path): path is string => path !== undefined);
    const injected: RawFrame[] = [];
    for (const awaiting of chain.frames) {
      if (present.has(nameKey(awaiting.name))) continue;
      present.add(nameKey(awaiting.name));
      const source = await resolveMethodSource(awaiting.method, candidates);
      this.nextSyntheticId += 1;
      this.synthetic.set(this.nextSyntheticId, awaiting.localsRef);
      injected.push(syntheticFrame(this.nextSyntheticId, awaiting.name, source));
    }
    return injected;
  }

  /**
   * Continue a CUT chain from the one other thread still building it.
   *
   * A stop can freeze the debuggee while an awaiter is mid-suspension: its box
   * exists but its continuation is not yet hooked, and the awaiting methods
   * are still PHYSICAL frames on the thread that is suspending them. When
   * exactly one other thread carries async frames, its enriched stack is the
   * unambiguous rest of the logical chain; any ambiguity keeps the stack as
   * reconstructed, per the spec's fallback.
   */
  private async stitchedTail(
    pausedThreadId: number,
    present: Set<string>,
    injected: readonly RawFrame[],
  ): Promise<RawFrame[]> {
    const candidates = await this.asyncThreadStacks(pausedThreadId);
    if (candidates.length !== 1) return [];
    const seen = new Set([...present, ...injected.map((frame) => nameKey(frame.name))]);
    const tail = candidates[0] ?? [];
    let start = 0;
    while (start < tail.length && seen.has(nameKey(tail[start]?.name ?? ''))) start += 1;
    return tail.slice(start);
  }

  /** The enriched stacks of other threads that carry async frames. */
  private async asyncThreadStacks(pausedThreadId: number): Promise<RawFrame[][]> {
    const response = await this.host.request('threads', {});
    const body = isRecord(response.body) ? response.body : {};
    const ids = recordList(body.threads)
      .map((thread) => Number(thread.id ?? 0))
      .filter((id) => id > 0 && id !== pausedThreadId)
      .slice(0, MAX_STITCH_THREADS);
    const stacks: RawFrame[][] = [];
    for (const id of ids) {
      const raw = await this.fetchFrames(id);
      if (!raw.some((frame) => logicalFrameName(frame.name) !== frame.name)) continue;
      stacks.push(enrichAsyncFrames(raw, this.justMyCode, this.isUserPath));
    }
    return stacks;
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

/** The index of the last enriched frame that was renamed from a machine. */
function findLastRenamed(enriched: readonly RawFrame[], renamedKeys: Set<string>): number {
  for (let index = enriched.length - 1; index >= 0; index -= 1) {
    if (renamedKeys.has(nameKey(enriched[index]?.name ?? ''))) return index;
  }
  return enriched.length - 1;
}

/** Build one injected awaiting frame. */
function syntheticFrame(
  id: number,
  name: string,
  source: { path: string; line: number } | undefined,
): RawFrame {
  if (source === undefined) return { id, name, line: 0, column: 0 };
  const segments = source.path.split(/[\\/]/);
  return {
    id,
    name,
    line: source.line,
    column: 1,
    source: { name: segments[segments.length - 1] ?? source.path, path: source.path },
  };
}
