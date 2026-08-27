// The DAP proxy that sits between VS Code and netcoredbg.
// Implements [DEBUG-ARCHITECTURE-ROUTER]'s Phase Four responsibilities that are
// reachable from the editor process: adapter lifecycle, DAP proxying, capability
// augmentation, async stack enrichment, and the emulations [DEBUG-ADAPTER-GAPS]
// records netcoredbg cannot serve natively — restart, hit-count breakpoints,
// logpoints, run-to-cursor and terminal-hosted debuggees.
// This class is the switchboard; narrow collaborators own child framing, stop
// decisions, stack delivery, and individual emulations.
import type * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { retarget } from './dap-exceptions';
import { isRecord, sourcePathOf, type DapMessage } from './dap-emulate';
import { BreakpointEmulator } from './dap-breakpoints';
import { AttachRetrier, EvaluateRetrier, type RetryHost } from './dap-attach';
import { SessionReplayer, type ReplayHost } from './dap-replay';
import { GotoEmulator } from './dap-goto';
import { StepCoalescer, STEP_COMMANDS } from './dap-stepping';
import { StopJudge, type StopHost } from './dap-stops';
import { StackDelivery, type StackHost } from './dap-stack';
import { RequestCorrelator } from './dap-correlator';
import { enrichResponse, withEventCapabilities } from './dap-caps';
import { HandleNamespace } from './dap-namespace';
import { AdapterWire } from './dap-wire';
import { carriesUserCode } from './dap-statement';
import { VariableExpander } from './dap-variables';
import { error, traceInfo } from './log';
import { getErrorMessage } from './utils';
import { err, ok, type Result } from './result';

/** The DAP dialect netcoredbg speaks; without it there is no DAP at all. */
export const INTERPRETER_ARGS: readonly string[] = ['--interpreter=vscode'];

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
  private readonly evaluations: EvaluateRetrier;
  private readonly variables: VariableExpander;
  /** True once the child itself sent the DAP `terminated` event. */
  private childAnnouncedTerminated = false;
  private justMyCode = true;
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

  /**
   * Start a router, or report why netcoredbg could not be launched at all.
   *
   * Constructing a router SPAWNS the child, and `cp.spawn` throws
   * SYNCHRONOUSLY for every failure outside its EACCES/EAGAIN/EMFILE/ENFILE/
   * ENOENT allowlist — a wrong-architecture or corrupt `netcoredbg.exe` raises
   * `spawn UNKNOWN` that way. An inline adapter has no executable-process
   * boundary to contain that, so the throw escaped into the extension host.
   * A `Result` is therefore the only honest signature: the caller refuses the
   * descriptor and VS Code starts no session, instead of one that can never
   * answer. Failures that DO reach the allowlist still arrive asynchronously
   * on `child.on('error')` and end the session through `onChildGone`.
   */
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
    this.evaluations = new EvaluateRetrier(retryHost);
    this.variables = new VariableExpander(retryHost);
    this.wire = this.startWire(adapterPath);
    this.replayer = new SessionReplayer(this);
    this.goto = new GotoEmulator(this, (path) => this.replayer.breakpointArgumentsFor(path));
    this.stops = new StopJudge(this, this.breakpoints, this.goto, this.handles);
    this.stacks = new StackDelivery(this, this.handles);
    this.stepper = new StepCoalescer({
      request: async (command, args) => await this.request(command, args),
      forward: (outbound) => {
        this.write(this.handles.translateRequestArguments(retarget(outbound)));
      },
      deliverStop: (stop) => {
        this.stops.deliverStop(stop);
      },
      carriesCode: async (location) => await carriesUserCode(location, this.justMyCode),
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
    if (!this.childAnnouncedTerminated) {
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
    const msg: DapMessage = message;
    if (message.type === 'response') {
      this.onClientResponse(msg);
      return;
    }
    const command = typeof message.command === 'string' ? message.command : '';
    const args = isRecord(message.arguments) ? message.arguments : undefined;
    if (process.env.SHARPLSP_DAP_TRACE === '1' && command !== '') {
      traceInfo(`[dap->] ${command} ${JSON.stringify(args ?? {}).slice(0, 90)}`);
    }
    const breakpointPath = command === 'setBreakpoints' ? sourcePathOf(args ?? {}) : undefined;
    this.replayer.observe(msg, breakpointPath);
    if (command === 'launch' && this.replayer.wantsTerminal()) {
      this.replayer.startTerminalLaunch();
      return;
    }
    if (this.interceptCommand(msg, command, args, breakpointPath)) return;
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
        // A fresh debuggee is starting; any previous exit is history.
        this.debuggeeExited = false;
        this.rememberLaunchOptions(args);
        return false;
      case 'attach':
        this.debuggeeExited = false;
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
      default:
        return false;
    }
  }

  public dispose(): void {
    // Kill the child BEFORE disposing the emitter: netcoredbg can have output
    // frames still in flight, and firing into a disposed EventEmitter throws,
    // which takes the whole extension host down with it.
    this.disposed = true;
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
    if (args === undefined || typeof args.justMyCode !== 'boolean') return;
    this.justMyCode = args.justMyCode;
    this.stacks.setJustMyCode(args.justMyCode);
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
    this.emitter.fire(message);
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
        `[dap<-] ${String(message.command ?? message.event ?? message.type)} seq=${String(message.seq)} rs=${String(message.request_seq)} ${JSON.stringify(message.body ?? {}).slice(0, 80)}`,
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
    }
    if (message.command === 'stackTrace') {
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
      if (this.stops.onStopped(message)) return;
    } else if (name === 'initialized') {
      // Either way the transition is over: a configured client gets the replay
      // (its own copy was already consumed), a first-time client now drives
      // the child through its breakpoint/configuration sequence.
      this.transitioning = false;
      if (this.clientConfigured) {
        this.replayer.replayConfiguration();
        return;
      }
    } else if (name === 'exited' || name === 'terminated') {
      this.debuggeeExited = true;
      if (name === 'terminated') this.childAnnouncedTerminated = true;
      if (this.transitioning) return;
    } else if (name === 'breakpoint') {
      // Keep breakpoint EVENT ids in the session-scoped space the
      // setBreakpoints responses already promised VS Code.
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

  /** Restart: respawn through the replayer and swallow the teardown noise. */
  private onRestart(): void {
    this.transitioning = true;
    // The NEXT debuggee has not exited. Leaving this set would make the
    // restarted session answer `threads` with an empty list forever.
    this.debuggeeExited = false;
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

  /** True while a respawn replays the handshake; stale stops are swallowed. */
  public isTransitioning(): boolean {
    return this.transitioning;
  }

  /** Offer a stop to the step coalescer; true when it took ownership of it. */
  public coalesceStep(message: DapMessage, threadId: number, reason: string): boolean {
    if (this.stepper.onStopped(message, threadId, reason)) return true;
    return reason === 'function breakpoint'
      ? this.stepper.elideFunctionEntry(message, threadId)
      : false;
  }
}
