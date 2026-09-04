// VS Code/netcoredbg proxy — implements [DEBUG-ARCHITECTURE-ROUTER] proxying and [DEBUG-ADAPTER-GAPS] emulations; narrow collaborators own framing, stops, stacks, and each gap.
import type * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { retarget } from './dap-exceptions';
import { isRecord, sourcePathOf, type DapMessage } from './dap-emulate';
import { isFSharpSource, withClrConditions } from './dap-fsharp-conditions';
import { BreakpointEmulator } from './dap-breakpoints';
import { AttachRetrier, type RetryHost } from './dap-attach';
import { EvaluateEmulator } from './dap-evaluate';
import { SessionReplayer, type ReplayHost } from './dap-replay';
import { GotoEmulator } from './dap-goto';
import { StepCoalescer, STEP_COMMANDS } from './dap-stepping';
import { StopJudge, type StopHost } from './dap-stops';
import { StackDelivery, type StackHost } from './dap-stack';
import { RequestCorrelator } from './dap-correlator';
import { enrichResponse, withEventCapabilities } from './dap-caps';
import { HandleNamespace } from './dap-namespace';
import { AdapterWire } from './dap-wire';
import { belongsToUserCode, carriesUserCode } from './dap-statement';
import { VariableExpander } from './dap-variables';
import { DapHotReload } from './dap-hot-reload';
import { error, traceInfo } from './log';
import { getErrorMessage } from './utils';
import { err, ok, type Result } from './result';

/** The DAP dialect netcoredbg speaks; without it there is no DAP at all. */
export const INTERPRETER_ARGS: readonly string[] = ['--interpreter=vscode'];

/**
 * A refusal the panel cannot show is a refusal the user cannot act on.
 *
 * netcoredbg answers some requests it cannot serve with `success: false` and an
 * EMPTY `message` — a `setVariable` addressed through `variablesReference: 0`,
 * which DAP defines as naming no container at all, is one. VS Code renders a
 * response's `message` and has nothing else to show, so the edit visibly fails
 * with no reason attached and the user is left guessing which of the name, the
 * value or the target was wrong. Naming the request is the least a client can
 * put in front of them.
 */
function withRefusalReason(message: DapMessage): DapMessage {
  if (message.type !== 'response' || message.success !== false) return message;
  if (typeof message.message === 'string' && message.message !== '') return message;
  const command = typeof message.command === 'string' ? message.command : 'request';
  return { ...message, message: `The debug adapter refused the ${command} request.` };
}

/**
 * Proxies DAP between VS Code and a netcoredbg child process, enriching and
 * emulating the messages the spec requires the router to serve.
 */
export class DapRouter implements vscode.DebugAdapter, ReplayHost, StopHost, StackHost {
  /**
   * The ONLY options netcoredbg is spawned with, exposed so the contract is
   * observable rather than merely commented. No `cwd` and no `env` override is
   * imposed: the resolved adapter path inherits the extension host's working
   * directory and environment ([DEBUG-ADAPTER-NETCOREDBG], B59).
   */
  public readonly spawnOptions: cp.SpawnOptionsWithoutStdio = { stdio: 'pipe' };
  /** The argv netcoredbg is spawned with, before any attach arguments. */
  public readonly spawnArgs: readonly string[] = INTERPRETER_ARGS;
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  /** The netcoredbg child process and the DAP framing on its stdio. */
  private readonly wire: AdapterWire;
  /** Set once the child is gone, so a late frame never reaches a dead session. */
  private closed = false;
  /** True while a respawn replays the handshake; stale events are swallowed. */
  private transitioning = false;
  /** True once VS Code finished its breakpoint/configuration sequence. */
  private clientConfigured = false;
  /** True once netcoredbg ANSWERED `configurationDone`; the request is not it. */
  private configurationAnswered = false;
  /** Breakpoint ids netcoredbg answered as PENDING, still awaiting their bind. */
  private readonly unverified = new Set<number>();
  /** Resolver for {@link whenArmed}; cleared once it has fired. */
  private resolveArmed: (() => void) | undefined;
  private readonly armed = new Promise<void>((resolve) => {
    this.resolveArmed = resolve;
  });
  /**
   * Set once the debuggee is gone, so `threads` can be answered honestly.
   *
   * netcoredbg fails that request with `0x80004005` after exit rather than
   * reporting an empty list, and VS Code polls it while tearing a session
   * down — so the raw error surfaced on essentially every run.
   */
  private debuggeeExited = false;
  /** seq -> arguments, correlating `setBreakpoints` requests with responses. */
  private readonly pendingBreakpointArgs = new Map<number, Record<string, unknown>>();
  /** seq -> arguments, correlating client `stackTrace` requests with responses. */
  private readonly pendingStackArgs = new Map<number, Record<string, unknown>>();
  /** The router's own requests, and the sequence space they are issued in. */
  private readonly correlator: RequestCorrelator;
  /** DAP requests that need retrying or logical response expansion. */
  private readonly attaches: AttachRetrier;
  private readonly evaluations: EvaluateEmulator;
  private readonly variables: VariableExpander;
  private readonly hotReload: DapHotReload;
  /** True once the child itself sent the DAP `terminated` event. */
  private childAnnouncedTerminated = false;
  private justMyCode = true;
  private launchRoot: string | undefined;
  /** Run-to-cursor emulation ([DEBUG-FEATURES-STEPPING], P2). */
  private readonly goto: GotoEmulator;
  /** Same-line step coalescing ([DEBUG-FEATURES-STEPPING], P1). */
  private readonly stepper: StepCoalescer;
  /** Session-scoped handle namespacing ([DEBUG-FEATURES-MULTIPROCESS]). */
  private readonly handles = new HandleNamespace();
  /** True once the session is being torn down; nothing may fire or write. */
  private disposed = false;
  /** The child's latest advertised capabilities, from `capabilities` events. */
  private latestChildCaps: Record<string, unknown> = {};
  private readonly breakpoints = new BreakpointEmulator();
  private readonly replayer: SessionReplayer;
  /** Whether one `stopped` event ever reaches the user, and how. */
  private readonly stops: StopJudge;
  /** `stackTrace` enrichment and windowing. */
  private readonly stacks: StackDelivery;
  public readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.emitter.event;
  /** Spawn the router, returning synchronous process failures to its caller. */
  public static start(adapterPath: string): Result<DapRouter> {
    try {
      return ok(new DapRouter(adapterPath));
    } catch (cause) {
      return err(getErrorMessage(cause));
    }
  }
  constructor(public readonly adapterPath: string) {
    this.correlator = new RequestCorrelator((message) => {
      this.write(message);
    });
    const retryHost: RetryHost = {
      request: async (command, args) => await this.request(command, args),
      deliver: (message) => {
        this.emit(this.handles.translateResponseBody(message));
      },
      isClosed: () => this.closed || this.disposed,
    };
    this.attaches = new AttachRetrier(retryHost);
    this.evaluations = new EvaluateEmulator(retryHost);
    this.variables = new VariableExpander(retryHost);
    this.hotReload = new DapHotReload(this);
    this.wire = this.startWire(adapterPath);
    this.replayer = new SessionReplayer(this);
    this.goto = new GotoEmulator(this, (path) => this.replayer.breakpointArgumentsFor(path));
    this.stacks = new StackDelivery(this, this.handles);
    this.stops = new StopJudge(this, this.breakpoints, this.goto, this.handles, this.stacks);
    this.stepper = new StepCoalescer({
      request: async (command, args) => await this.request(command, args),
      forward: (outbound) => {
        this.write(this.handles.translateRequestArguments(retarget(outbound)));
      },
      deliverStop: (stop, origin) => {
        this.stops.deliverStop(stop, origin);
      },
      carriesCode: async (location) =>
        await carriesUserCode(location, this.justMyCode, this.launchRoot),
      belongsToUser: (location) => belongsToUserCode(location, this.launchRoot),
    });
  }
  /** Spawn netcoredbg, routing its frames and its death back into the router. */
  private startWire(adapterPath: string): AdapterWire {
    return new AdapterWire(adapterPath, this.spawnArgs, this.spawnOptions, {
      onFrame: (frame) => {
        this.routeChildMessage(frame);
      },
      onGone: (why) => {
        this.onChildGone(why);
      },
      announcedTerminated: () => this.childAnnouncedTerminated,
      isClosed: () => this.closed,
      isDisposed: () => this.disposed,
    });
  }

  /**
   * The netcoredbg child is gone, or its wire is corrupt beyond repair.
   *
   * VS Code believes a session is still running, so nothing may be left
   * hanging: every request the router issued in its own name is settled with
   * a failure response, the user is told why on the debug console, and the
   * session is terminated — unless the child already announced `terminated`
   * itself (the clean path) or VS Code is disposing the router, in which case
   * `why` is undefined and only the settlement happens.
   */
  private onChildGone(why: string | undefined): void {
    // ONCE. A failed spawn emits `error` AND then `exit`, and a crash emits
    // `exit` after the parser has already given up on a corrupt frame — so
    // without this guard VS Code received two `terminated` events and two
    // console lines for one death, and the second `terminated` lands after the
    // session is already gone.
    if (this.closed) return;
    this.closed = true;
    this.correlator.failAll(why ?? 'exited');
    if (why === undefined || this.disposed) return;
    error(`netcoredbg ${why}; ending the debug session.`);
    this.fire({
      type: 'event',
      event: 'output',
      body: {
        category: 'stderr',
        output: `SharpLsp: netcoredbg ${why}. Ending the debug session.\n`,
      },
    });
    if (this.endsSessionOnce('terminated')) {
      this.fire({ type: 'event', event: 'terminated', body: {} });
    }
  }

  /** VS Code -> netcoredbg, with the router's intercepts. */
  public handleMessage(message: vscode.DebugProtocolMessage): void {
    if (!isRecord(message)) return;
    if (process.env.SHARPLSP_DAP_TRACE === '1') {
      traceInfo(
        `[dap->] ${String(message.command ?? message.type)} ${JSON.stringify(message.arguments ?? message.body ?? {}).slice(0, 100)}`,
      );
    }
    if (message.type === 'response') {
      this.onClientResponse(message);
      return;
    }
    const command = typeof message.command === 'string' ? message.command : '';
    const args = isRecord(message.arguments) ? message.arguments : undefined;
    if (process.env.SHARPLSP_DAP_TRACE === '1' && command !== '') {
      traceInfo(`[dap->] ${command} ${JSON.stringify(args ?? {}).slice(0, 90)}`);
    }
    const breakpointPath = command === 'setBreakpoints' ? sourcePathOf(args ?? {}) : undefined;
    // An F# condition is spelled in F#; netcoredbg only evaluates C#. Translate
    // BEFORE anything records the message, so the replayer re-arms the same
    // translated breakpoint and the pending-args map holds what was sent.
    const msg: DapMessage =
      breakpointPath !== undefined && isFSharpSource(breakpointPath)
        ? withClrConditions(message)
        : message;
    this.replayer.observe(msg, breakpointPath);
    if (command === 'setFunctionBreakpoints') this.breakpoints.recordFunctions(args);
    if (command === 'launch' && this.replayer.wantsTerminal()) {
      this.replayer.startTerminalLaunch();
      return;
    }
    const sentArgs = isRecord(msg.arguments) ? msg.arguments : undefined;
    if (this.interceptCommand(msg, command, sentArgs, breakpointPath)) return;
    if (STEP_COMMANDS.includes(command)) {
      this.stepper.begin(msg, command, Number(args?.threadId ?? 0));
      return;
    }
    this.write(this.handles.translateRequestArguments(retarget(msg)));
  }

  /**
   * Observe or answer one client request.
   *
   * Returns true when the router SERVED the request itself and nothing may be
   * forwarded to the adapter; false when the adapter still owns the answer,
   * with any bookkeeping the router needed already recorded.
   */
  private interceptCommand(
    message: DapMessage,
    command: string,
    args: Record<string, unknown> | undefined,
    breakpointPath: string | undefined,
  ): boolean {
    switch (command) {
      case 'setBreakpoints': {
        this.pendingBreakpointArgs.set(this.seqOf(message), args ?? {});
        if (breakpointPath !== undefined) this.breakpoints.reset();
        return false;
      }
      case 'stackTrace':
        this.pendingStackArgs.set(this.seqOf(message), args ?? {});
        return false;
      case 'configurationDone':
        this.clientConfigured = true;
        return false;
      case 'threads':
        // DAP defines no failure case for `threads`: the honest answer to
        // "which threads are there" once the debuggee is gone is none, and an
        // empty list is exactly what the schema expects. netcoredbg instead
        // fails the request, and because VS Code polls `threads` during
        // teardown that error reached the client as a session error on every
        // run. Only answered locally AFTER exit — while the debuggee lives, a
        // failure is real and must reach the client untouched.
        if (!this.debuggeeExited) return false;
        this.respondTo(message, true, { threads: [] });
        return true;
      case 'restart':
        this.onRestart();
        this.respondTo(message, true, {});
        return true;
      case 'gotoTargets':
        this.goto.onGotoTargets(message);
        return true;
      case 'goto':
        // Run-to-cursor resumes the debuggee, so any step in flight is over.
        this.stepper.reset();
        this.goto.onGoto(message);
        return true;
      case 'launch':
        // A fresh debuggee is starting; any previous end is history.
        this.armSession();
        this.rememberLaunchOptions(args);
        if (args !== undefined) this.stacks.onLaunch(args);
        this.hotReload.prepareLaunch(args);
        return false;
      case 'attach':
        this.armSession();
        this.rememberLaunchOptions(args);
        this.attaches.start(message, args ?? {});
        return true;
      case 'evaluate': {
        const translated = this.handles.translateRequestArguments(message);
        const retryArgs = isRecord(translated.arguments) ? translated.arguments : {};
        this.evaluations.start(message, retryArgs);
        return true;
      }
      case 'scopes': {
        if (this.stacks.serveScopes(message)) return true;
        const translated = this.handles.translateRequestArguments(message);
        this.variables.startScopes(
          message,
          isRecord(translated.arguments) ? translated.arguments : {},
        );
        return true;
      }
      case 'variables': {
        const translated = this.handles.translateRequestArguments(message);
        this.variables.start(message, isRecord(translated.arguments) ? translated.arguments : {});
        return true;
      }
      case 'continue':
      case 'pause':
        // Resuming the debuggee ends any step in flight: the stop that follows
        // is the user's new gesture, never the old one's second sequence point.
        this.stepper.reset();
        return false;
      case 'disconnect':
        // Attach semantics live in dap-attach.ts: an ATTACH session detaches
        // instead of killing the debuggee ([DEBUG-FEATURES-LAUNCH] attach rows).
        this.write(this.attaches.rewriteDisconnect(message));
        return true;
      default:
        return false;
    }
  }
  public dispose(): void {
    // Kill the child BEFORE disposing the emitter: netcoredbg can have output
    // frames still in flight, and firing into a disposed EventEmitter throws,
    // which takes the whole extension host down with it.
    this.disposed = true;
    this.hotReload.dispose();
    this.wire.dispose();
    this.emitter.dispose();
  }

  /** A response from VS Code can only answer a reverse request we issued. */
  private onClientResponse(message: DapMessage): void {
    const requestSeq = Number(message.request_seq ?? -1);
    if (this.replayer.isOurReverseResponse(requestSeq)) {
      this.replayer.onTerminalResponse(message);
      return;
    }
    this.write(message);
  }
  /** Track `justMyCode` off the launch/attach request that carries it. */
  private rememberLaunchOptions(args: Record<string, unknown> | undefined): void {
    if (args === undefined) return;
    if (typeof args.cwd === 'string') this.launchRoot = args.cwd;
    if (typeof args.justMyCode === 'boolean') {
      this.justMyCode = args.justMyCode;
      this.stacks.setJustMyCode(args.justMyCode);
    }
  }
  /** Serialise one message to the child using DAP's framing. */
  public write(message: DapMessage): void {
    this.wire.write(message);
  }
  /** Send a request in the router's own name and await its response. */
  public async request(command: string, args: Record<string, unknown>): Promise<DapMessage> {
    return await this.correlator.request(command, args);
  }
  /** Emit one message towards VS Code, filling in missing sequence numbers. */
  public fire(message: Record<string, unknown> & { seq?: unknown }): void {
    if (this.disposed) return;
    const seq = typeof message.seq === 'number' ? message.seq : this.correlator.nextSequence();
    const framed: DapMessage = { ...message, seq };
    this.emitter.fire(framed);
  }

  /** Emit one message towards VS Code exactly as the adapter framed it. */
  public emit(message: DapMessage): void {
    const outbound = withRefusalReason(message);
    if (process.env.SHARPLSP_DAP_TRACE === '1') {
      traceInfo(
        `[dap=>] ${String(outbound.command ?? outbound.event ?? outbound.type)} seq=${String(outbound.seq)} rs=${String(outbound.request_seq)} ok=${String(outbound.success)} msg=${JSON.stringify(outbound.message ?? '')}`,
      );
    }
    this.emitter.fire(outbound);
  }

  /** Respond to a client request on the router's behalf. */
  public respondTo(message: DapMessage, success: boolean, body: unknown): void {
    this.fire({
      type: 'response',
      request_seq: this.seqOf(message),
      command: message.command,
      success,
      body,
    });
  }

  /** netcoredbg -> VS Code, with the router's enrichments and emulations. */
  private routeChildMessage(message: DapMessage): void {
    if (this.disposed) return;
    if (process.env.SHARPLSP_DAP_TRACE === '1') {
      traceInfo(
        `[dap<-] ${String(message.command ?? message.event ?? message.type)} seq=${String(message.seq)} rs=${String(message.request_seq)} ok=${String(message.success)} msg=${JSON.stringify(message.message ?? '')} ${JSON.stringify(message.body ?? {}).slice(0, 80)}`,
      );
    }
    if (message.type === 'response') {
      this.onChildResponse(message);
      return;
    }
    if (message.type === 'event') {
      this.onChildEvent(message);
      return;
    }
    this.emit(message);
  }

  /** A response from netcoredbg: settle ours, or enrich and forward theirs. */
  private onChildResponse(message: DapMessage): void {
    const requestSeq = Number(message.request_seq ?? -1);
    if (this.correlator.settle(requestSeq, message)) return;
    if (this.replayer.swallowResponse(requestSeq)) return;
    if (message.command === 'initialize' && this.clientConfigured) return;
    if (message.command === 'setBreakpoints') {
      this.breakpoints.record(this.pendingBreakpointArgs.get(requestSeq), message.body);
      this.pendingBreakpointArgs.delete(requestSeq);
      this.noteBreakpointBinds(message.body);
    }
    if (message.command === 'configurationDone') {
      this.configurationAnswered = true;
      this.announceWhenArmed();
    }
    if (message.command === 'stackTrace') {
      // Frame display names feed the synthesized Statics scope
      // ([DEBUG-FEATURES-VARIABLES] "Static fields | variables | P1").
      this.variables.observeStackTrace(message);
      // Only a SUCCESSFUL read describes a stack. The correlator resolves a
      // failed response rather than rejecting, so handing one to StackDelivery
      // would present a refusal as "this thread has no frames" and send it into
      // the empty-stack recovery. A refusal is the client's to see.
      if (message.success === false) {
        this.pendingStackArgs.delete(requestSeq);
        this.emit(this.handles.translateResponseBody(message));
        return;
      }
      this.stacks.deliver(message, this.pendingStackArgs.get(requestSeq));
      this.pendingStackArgs.delete(requestSeq);
      return;
    }
    this.emit(this.handles.translateResponseBody(enrichResponse(message, this.latestChildCaps)));
  }
  /** Events that carry emulation state, not just data. */
  private onChildEvent(message: DapMessage): void {
    const name = typeof message.event === 'string' ? message.event : '';
    if (['stopped', 'continued'].includes(name)) {
      traceInfo(`[stop] ${name} ${JSON.stringify(message.body ?? {}).slice(0, 90)}`);
    }
    if (process.env.SHARPLSP_DAP_TRACE === '1') {
      traceInfo(`[dap<-event] ${name} ${JSON.stringify(message.body ?? {}).slice(0, 80)}`);
    }
    if (name === 'stopped') {
      if (this.stacks.interceptStop(message)) return;
      // A VSTest host's own attach break is resumed, never surfaced
      // ([DEBUG-FEATURES-TESTS]); dap-attach.ts owns that judgement.
      if (this.attaches.absorbTestHostBreak(message)) return;
      this.hotReload.onStopped(message, () => {
        if (!this.stops.onStopped(message)) this.emit(message);
      });
      return;
    } else if (name === 'initialized') {
      this.transitioning = false;
      if (this.clientConfigured) {
        void this.breakpoints.replayFunctions(this, error);
        this.replayer.replayConfiguration();
        return;
      }
    } else if (name === 'exited' || name === 'terminated') {
      if (!this.endsSessionOnce(name)) return;
      if (this.transitioning) return;
    } else if (name === 'breakpoint') {
      // Keep breakpoint EVENT ids in the session-scoped space the
      // setBreakpoints responses already promised VS Code.
      const body = isRecord(message.body) ? message.body : {};
      this.noteBreakpointBind(body.breakpoint);
      this.announceWhenArmed();
      this.emit(this.handles.translateEvent(message));
      return;
    } else if (name === 'capabilities') {
      this.rememberChildCapabilities(message);
      return;
    }
    this.emit(message);
  }

  /**
   * Remember and forward one `capabilities` event.
   *
   * netcoredbg puts some flags (e.g. `supportsDisassembleRequest`) only in
   * this event, never in the initialize response — remember them so the
   * initialize merge serves the union, then forward the merged event.
   */
  private rememberChildCapabilities(message: DapMessage): void {
    const body = isRecord(message.body) ? message.body : {};
    const advertised = isRecord(body.capabilities) ? body.capabilities : {};
    this.latestChildCaps = { ...this.latestChildCaps, ...advertised };
    this.emit(withEventCapabilities(message));
  }
  /**
   * Record an end-of-session announcement, and report whether it is the FIRST.
   *
   * DAP lets an adapter announce the end more than once and netcoredbg does:
   * once when the debuggee exits, again when the client disconnects in reply.
   * A session ends once, so only the first announcement of each kind reaches
   * VS Code - a repeat is a duplicate of an event the client already acted on.
   * `launch`, `attach` and `onRestart` re-arm both flags, so a respawned
   * session can announce its own end.
   */
  private endsSessionOnce(name: 'exited' | 'terminated'): boolean {
    if (name === 'terminated') {
      if (this.childAnnouncedTerminated) return false;
      this.childAnnouncedTerminated = true;
      this.debuggeeExited = true;
      return true;
    }
    if (this.debuggeeExited) return false;
    this.debuggeeExited = true;
    return true;
  }

  /** Re-arm the end-of-session guards for a debuggee that is about to start. */
  private armSession(): void {
    this.debuggeeExited = false;
    this.childAnnouncedTerminated = false;
  }

  /** Restart: respawn through the replayer and swallow the teardown noise. */
  private onRestart(): void {
    this.transitioning = true;
    // The NEXT debuggee has not exited. Leaving this set would make the
    // restarted session answer `threads` with an empty list forever, and leave
    // it unable to announce its own termination.
    this.armSession();
    this.breakpoints.reset();
    this.stepper.reset();
    this.replayer.restart();
  }
  /** Swap the child process for a respawn, clearing stale transport state. */
  public respawn(attachArgs: readonly string[], onReady?: () => void): void {
    this.transitioning = true;
    this.wire.respawn(attachArgs, onReady);
  }
  /** The seq of a recorded client message. */
  public seqOf(message: DapMessage): number {
    return Number(message.seq ?? -1);
  }

  /**
   * Settles once the session is ARMED: `configurationDone` has been ANSWERED
   * and every breakpoint the adapter accepted has bound.
   *
   * `vscode.debug.startDebugging` resolves as soon as the session exists, which
   * is several DAP round trips before it can run anything: the breakpoints are
   * still being sent and `configurationDone` has not been issued. A caller that
   * treats "started" as "ready" hands the user a session that is not listening
   * yet — the Debug press that ends in silence (issue #233).
   *
   * Neither is the `configurationDone` REQUEST the moment: netcoredbg answers it
   * dozens of milliseconds later and only finishes the attach as it does, and a
   * breakpoint armed before its module is loaded comes back `verified: false`
   * and binds later through a `breakpoint` event
   * ([DEBUG-FEATURES-BREAKPOINTS-VERIFY]). A VSTEST host attached under
   * `VSTEST_HOST_DEBUG` has not loaded the test assembly yet, so EVERY
   * breakpoint in the user's own test starts out pending there — reporting the
   * attach settled before they bind is reporting it before the debugger can stop
   * anywhere. This is the signal that says otherwise, and it is the router's to
   * give because the router is the adapter the workbench is configuring.
   */
  public async whenArmed(): Promise<void> {
    await this.armed;
  }

  /**
   * Note one breakpoint's bind state, from a response entry or an event body.
   *
   * netcoredbg reports the SAME shape in both: `{id, verified, ...}`. A pending
   * one gates {@link whenArmed} until the module carrying its line is loaded.
   */
  private noteBreakpointBind(entry: unknown): void {
    if (!isRecord(entry)) return;
    const id = Number(entry.id ?? Number.NaN);
    if (!Number.isInteger(id)) return;
    if (entry.verified === true) this.unverified.delete(id);
    else this.unverified.add(id);
  }

  /** Note every breakpoint in one `setBreakpoints` response body. */
  private noteBreakpointBinds(body: unknown): void {
    const list = isRecord(body) && Array.isArray(body.breakpoints) ? body.breakpoints : [];
    for (const entry of list) this.noteBreakpointBind(entry);
  }

  /** Release everything awaiting {@link whenArmed}, once. Idempotent. */
  private announceWhenArmed(): void {
    if (!this.configurationAnswered || this.unverified.size > 0) return;
    const resolve = this.resolveArmed;
    this.resolveArmed = undefined;
    resolve?.();
  }

  /** True while a respawn replays the handshake; stale stops are swallowed. */
  public isTransitioning(): boolean {
    return this.transitioning;
  }

  /** Offer a stop to the step coalescer; true when it took ownership of it. */
  public coalesceStep(message: DapMessage, threadId: number, reason: string): boolean {
    if (this.stepper.onStopped(message, threadId, reason)) return true;
    // The bound location, not the reason string, decides the kind ([DEBUG-GAPS]).
    return this.breakpoints.routeFunctionEntry(reason, threadId, this, {
      elide: () => this.stepper.elideFunctionEntry(message, threadId),
      deliver: () => {
        this.stops.deliverStop(message);
      },
    });
  }
}
