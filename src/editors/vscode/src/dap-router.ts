// The DAP proxy that sits between VS Code and netcoredbg.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER]'s Phase Four responsibilities that are
// reachable from the editor process: adapter lifecycle, DAP proxying, capability
// augmentation, async stack enrichment, and the emulations [DEBUG-ADAPTER-GAPS]
// records netcoredbg cannot serve natively — restart, hit-count breakpoints,
// logpoints, run-to-cursor and terminal-hosted debuggees.
//
// SCOPE. The spec sites the router in the Rust host and gives it more jobs than
// this class does — `[DebuggerDisplay]` emulation against the C# sidecar and
// continuation-following via ICorDebug are NOT implemented here. What is
// implemented is honest: a capability is advertised only when it is served,
// natively or by the emulations in this file and its helpers.
import * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { withTranslatedExceptionOptions } from './dap-exceptions';
import { enrichAsyncFrames, type RawFrame } from './dap-frames';
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import { interpolateLog, type LogToken } from './dap-emulate';
import { BreakpointEmulator, type StopVerdict } from './dap-breakpoints';
import { SessionReplayer, type ReplayHost } from './dap-replay';
import { GotoEmulator } from './dap-goto';
import { withEventCapabilities, withRouterCapabilities } from './dap-caps';
import { HandleNamespace } from './dap-namespace';
import { error, info, traceInfo } from './log';

/** DAP frames are `Content-Length: N\r\n\r\n<json>`; this is the separator. */
const HEADER_END = '\r\n\r\n';

/** The header that carries the payload length. */
const CONTENT_LENGTH = 'Content-Length: ';

/** Narrow the parsed frames to the shape the transform reads. */
function isFrameList(value: unknown): value is RawFrame[] {
  return Array.isArray(value);
}

/** Read the body length out of one DAP header block, if well-formed. */
function parseContentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    if (!line.startsWith(CONTENT_LENGTH)) continue;
    const value = Number.parseInt(line.slice(CONTENT_LENGTH.length), 10);
    return Number.isNaN(value) ? undefined : value;
  }
  return undefined;
}

/**
 * Proxies DAP between VS Code and a netcoredbg child process, enriching and
 * emulating the messages the spec requires the router to serve.
 */
export class DapRouter implements vscode.DebugAdapter, ReplayHost {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private child: cp.ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  /** Mirrors the launch argument so stack enrichment matches the user's choice. */
  private justMyCode = true;
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
  /** Synthetic request seq -> resolver, for requests this proxy issues. */
  private readonly pendingOurs = new Map<number, (message: DapMessage) => void>();
  private nextSeq = 1_000_000;
  /** Run-to-cursor emulation ([DEBUG-FEATURES-STEPPING], P2). */
  private readonly goto: GotoEmulator;
  /** Session-scoped handle namespacing ([DEBUG-FEATURES-MULTIPROCESS]). */
  private readonly handles = new HandleNamespace();
  /** Serializes logpoint evaluation so output stays in program order. */
  private emulationQueue: Promise<void> = Promise.resolve();
  /** True once the session is being torn down; nothing may fire or write. */
  private disposed = false;
  /** The child's latest advertised capabilities, from `capabilities` events. */
  private latestChildCaps: Record<string, unknown> = {};
  private readonly breakpoints = new BreakpointEmulator();
  private readonly replayer: SessionReplayer;

  public readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.emitter.event;

  constructor(private readonly adapterPath: string) {
    this.child = this.spawn([]);
    this.replayer = new SessionReplayer(this);
    this.goto = new GotoEmulator(this, (path) => this.breakpointArgsFor(path));
  }

  /** Spawn netcoredbg and wire its output into the frame parser. */
  private spawn(attachArgs: readonly string[]): cp.ChildProcessWithoutNullStreams {
    info(`DapRouter starting netcoredbg: ${this.adapterPath}`);
    const child = cp.spawn(this.adapterPath, ['--interpreter=vscode', ...attachArgs], {
      stdio: 'pipe',
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.consume(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error(`netcoredbg: ${chunk.toString('utf8').trimEnd()}`);
    });
    child.on('exit', (code) => {
      info(`netcoredbg exited with code ${String(code)}`);
    });
    child.on('error', (cause: Error) => {
      error(`netcoredbg failed to start: ${cause.message}`);
      this.closed = true;
    });
    return child;
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
    const breakpointPath = command === 'setBreakpoints' ? this.sourcePathOf(args ?? {}) : undefined;
    this.replayer.observe(msg, breakpointPath);
    if (command === 'launch' && this.replayer.wantsTerminal()) {
      this.replayer.startTerminalLaunch();
      return;
    }
    switch (command) {
      case 'setBreakpoints': {
        this.pendingBreakpointArgs.set(this.seqOf(message), args ?? {});
        if (breakpointPath !== undefined) this.breakpoints.reset();
        break;
      }
      case 'stackTrace':
        this.pendingStackArgs.set(this.seqOf(message), args ?? {});
        break;
      case 'configurationDone':
        this.clientConfigured = true;
        break;
      case 'threads':
        // DAP defines no failure case for `threads`: the honest answer to
        // "which threads are there" once the debuggee is gone is none, and an
        // empty list is exactly what the schema expects. netcoredbg instead
        // fails the request, and because VS Code polls `threads` during
        // teardown that error reached the client as a session error on every
        // run. Only answered locally AFTER exit — while the debuggee lives, a
        // failure is real and must reach the client untouched.
        if (this.debuggeeExited) {
          this.respondTo(message, true, { threads: [] });
          return;
        }
        break;
      case 'restart':
        this.onRestart();
        this.respondTo(message, true, {});
        return;
      case 'gotoTargets':
        this.goto.onGotoTargets(msg);
        return;
      case 'goto':
        this.goto.onGoto(msg);
        return;
      case 'launch':
      case 'attach':
        // A fresh debuggee is starting; any previous exit is history.
        this.debuggeeExited = false;
        this.rememberLaunchOptions(args);
        break;
      default:
        break;
    }
    this.write(this.handles.translateRequestArguments(retarget(msg)));
  }

  public dispose(): void {
    // Kill the child BEFORE disposing the emitter: netcoredbg can have output
    // frames still in flight, and firing into a disposed EventEmitter throws,
    // which takes the whole extension host down with it.
    this.disposed = true;
    this.child.stdout.removeAllListeners('data');
    this.child.stderr.removeAllListeners('data');
    if (!this.closed) this.child.kill();
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
  }

  /** Serialise one message to the child using DAP's framing. */
  public write(message: DapMessage): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) return;
    const body = JSON.stringify(message);
    this.child.stdin.write(
      `${CONTENT_LENGTH}${String(Buffer.byteLength(body))}${HEADER_END}${body}`,
    );
  }

  /** Send a request in the router's own name and await its response. */
  public async request(command: string, args: Record<string, unknown>): Promise<DapMessage> {
    const seq = this.nextSeq++;
    const reply = new Promise<DapMessage>((resolve) => {
      this.pendingOurs.set(seq, resolve);
    });
    this.write({ seq, type: 'request', command, arguments: args });
    return await reply;
  }

  /** Emit one message towards VS Code, filling in missing sequence numbers. */
  public fire(message: Record<string, unknown> & { seq?: unknown }): void {
    if (this.disposed) return;
    const seq = typeof message.seq === 'number' ? message.seq : this.nextSeq++;
    const framed: DapMessage = { ...message, seq };
    this.emitter.fire(framed);
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

  /** Accumulate child output and dispatch every complete frame it contains. */
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.takeFrame();
      if (frame === undefined) return;
      this.routeChildMessage(frame);
    }
  }

  /** Split one complete frame off the front of the buffer, if there is one. */
  private takeFrame(): DapMessage | undefined {
    const end = this.buffer.indexOf(HEADER_END);
    if (end < 0) return undefined;
    const length = parseContentLength(this.buffer.subarray(0, end).toString('utf8'));
    if (length === undefined) return undefined;
    const start = end + HEADER_END.length;
    if (this.buffer.length < start + length) return undefined;
    const text = this.buffer.subarray(start, start + length).toString('utf8');
    this.buffer = this.buffer.subarray(start + length);
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
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
      const requestSeq = Number(message.request_seq ?? -1);

      const ours = this.pendingOurs.get(requestSeq);
      if (ours !== undefined) {
        this.pendingOurs.delete(requestSeq);
        ours(message);
        return;
      }
      if (this.replayer.swallowResponse(requestSeq)) return;
      if (message.command === 'initialize' && this.clientConfigured) return;
      if (message.command === 'setBreakpoints') {
        this.breakpoints.record(this.pendingBreakpointArgs.get(requestSeq), message.body);
        this.pendingBreakpointArgs.delete(requestSeq);
      }
      if (message.command === 'stackTrace') {
        this.deliverStackTrace(message, this.pendingStackArgs.get(requestSeq));
        this.pendingStackArgs.delete(requestSeq);
        return;
      }
      this.emitter.fire(this.handles.translateResponseBody(this.enrich(message)));
      return;
    }
    if (message.type === 'event') {
      this.onChildEvent(message);
      return;
    }
    this.emitter.fire(message);
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
      if (this.onStopped(message)) return;
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
      if (this.transitioning) return;
    } else if (name === 'breakpoint') {
      // Keep breakpoint EVENT ids in the session-scoped space the
      // setBreakpoints responses already promised VS Code.
      this.emitter.fire(this.handles.translateEvent(message));
      return;
    } else if (name === 'capabilities') {
      // netcoredbg puts some flags (e.g. `supportsDisassembleRequest`) only in
      // this event, never in the initialize response — remember them so the
      // initialize merge serves the union, then forward the merged event.
      const body = isRecord(message.body) ? message.body : {};
      const advertised = isRecord(body.capabilities) ? body.capabilities : {};
      this.latestChildCaps = { ...this.latestChildCaps, ...advertised };
      this.emitter.fire(withEventCapabilities(message));
      return;
    }
    this.emitter.fire(message);
  }

  /** Auto-continue stops the adapter cannot judge. Returns true when swallowed. */
  private onStopped(message: DapMessage): boolean {
    if (this.transitioning) return true;
    const body = isRecord(message.body) ? message.body : {};
    const threadId = Number(body.threadId ?? 0);
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
    this.emulationQueue = this.emulationQueue
      .then(async () => {
        const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
        const frame = recordList(isRecord(stack.body) ? stack.body.stackFrames : undefined)[0];
        const source =
          isRecord(frame?.source) && typeof frame.source.path === 'string'
            ? frame.source.path
            : undefined;
        const line = Number(frame?.line ?? 0);
        this.goto.absorbHitAt(source, line);
        const verdict =
          source !== undefined
            ? this.breakpoints.judgeLocation(source, line, threadId)
            : { action: 'forward' as const, known: false };
        if (verdict.action === 'forward') {
          // netcoredbg names no breakpoint ids; the location match knows which
          // one it was, so the forwarded stop carries it for VS Code and the
          // suites that read `hitBreakpointIds`.
          const hitIds =
            verdict.known && verdict.hitId !== undefined
              ? [this.handles.outward(verdict.hitId)]
              : undefined;
          this.fire(
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
          return;
        }
        if (verdict.action === 'log') {
          await this.runLogpoint(verdict.tokens, verdict.threadId);
          return;
        }
        await this.request('continue', { threadId });
      })
      .catch((cause: unknown) => {
        error(`stop emulation failed: ${String(cause)}`);
      });
  }

  /** Act on a folded verdict. Returns true when the stop is swallowed. */
  private actOn(verdict: StopVerdict): boolean {
    if (verdict.action === 'forward') return false;
    if (verdict.action === 'continue') {
      const threadId = verdict.threadId;
      void this.request('continue', { threadId }).catch(() => undefined);
      return true;
    }
    this.emulationQueue = this.emulationQueue
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
      await this.request('continue', { threadId });
      return;
    }
    const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    const body = isRecord(stack.body) ? stack.body : {};
    const frameId = Number(recordList(body.stackFrames)[0]?.id ?? 0);
    const values: string[] = [];
    for (const token of tokens) {
      if (token.kind !== 'expression') continue;
      const evaluation = await this.request('evaluate', {
        expression: token.expression,
        frameId,
        context: 'repl',
      });
      const result = isRecord(evaluation.body) ? evaluation.body.result : undefined;
      values.push(typeof result === 'string' ? result : '{?}');
    }
    const output = `${interpolateLog(tokens, values)}\n`;
    this.fire({ type: 'event', event: 'output', body: { category: 'console', output } });
    await this.request('continue', { threadId });
  }

  /** Restart: respawn through the replayer and swallow the teardown noise. */
  private onRestart(): void {
    this.transitioning = true;
    // The NEXT debuggee has not exited. Leaving this set would make the
    // restarted session answer `threads` with an empty list forever.
    this.debuggeeExited = false;
    this.breakpoints.reset();
    this.replayer.restart();
  }

  /** Swap the child process for a respawn, clearing stale transport state. */
  public respawn(attachArgs: readonly string[], onReady?: () => void): void {
    this.transitioning = true;
    this.buffer = Buffer.alloc(0);
    const old = this.child;
    old.stdout.removeAllListeners('data');
    old.kill();
    // A paused debuggee can make netcoredbg linger on SIGTERM; the restart
    // gesture must not wait for it. Escalate to SIGKILL after a grace second.
    const escalate = setTimeout(() => {
      old.kill('SIGKILL');
    }, 1_000);
    old.once('exit', () => {
      clearTimeout(escalate);
      this.child = this.spawn(attachArgs);
      onReady?.();
    });
  }

  /** The last `setBreakpoints` arguments a source recorded, or a bare source. */
  private breakpointArgsFor(path: string): Record<string, unknown> {
    const recorded = this.replayer.breakpointRequestFor(path);
    return recorded !== undefined && isRecord(recorded.arguments)
      ? recorded.arguments
      : { source: { path } };
  }

  /** The `source.path` of a `setBreakpoints`/`gotoTargets` arguments record. */
  private sourcePathOf(args: Record<string, unknown>): string | undefined {
    const source = args.source;
    if (!isRecord(source) || typeof source.path !== 'string') return undefined;
    return source.path;
  }

  /** The seq of a recorded client message. */
  public seqOf(message: DapMessage): number {
    return Number(message.seq ?? -1);
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
  private deliverStackTrace(message: DapMessage, args: Record<string, unknown> | undefined): void {
    const body = isRecord(message.body) ? message.body : {};
    const frames = isFrameList(body.stackFrames) ? body.stackFrames : [];
    const logical = enrichAsyncFrames(frames, this.justMyCode);
    if (logical.length > 0 || frames.length === 0) {
      this.emitter.fire(
        this.handles.translateResponseBody(
          this.withWindow(
            { ...message, body: { ...body, stackFrames: logical, totalFrames: logical.length } },
            args,
          ),
        ),
      );
      return;
    }
    const threadId = Number(args?.threadId ?? 0);
    void this.request('stackTrace', { threadId, startFrame: 0, levels: 1_000 })
      .then((full) => {
        const fullBody = isRecord(full.body) ? full.body : {};
        const fullFrames = isFrameList(fullBody.stackFrames) ? fullBody.stackFrames : [];
        const enriched = enrichAsyncFrames(fullFrames, this.justMyCode);
        const stack = enriched.length > 0 ? enriched : fullFrames;
        this.emitter.fire(
          this.handles.translateResponseBody(
            this.withWindow(
              { ...message, body: { ...body, stackFrames: stack, totalFrames: stack.length } },
              args,
            ),
          ),
        );
      })
      .catch(() => {
        // Never leave the caller without a stack; the physical frames are the
        // adapter's own answer.
        this.emitter.fire(message);
      });
  }

  /** Apply the caller's `startFrame`/`levels` window to enriched frames. */
  private withWindow(message: DapMessage, args: Record<string, unknown> | undefined): DapMessage {
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

  /** netcoredbg -> VS Code, with the router's enrichments applied. */
  private enrich(message: DapMessage): DapMessage {
    if (message.type !== 'response') return message;
    if (message.command === 'initialize') {
      return withRouterCapabilities(message, this.latestChildCaps);
    }
    return message;
  }
}

/**
 * Rewrite one workbench request into the dialect netcoredbg understands.
 *
 * Only `setExceptionBreakpoints` needs it today: VS Code expresses a per-type
 * selection as `exceptionOptions`, which netcoredbg ignores, while the
 * equivalent `filterOptions[].condition` is applied. Every other request is
 * forwarded byte-for-byte.
 */
function retarget(message: DapMessage): DapMessage {
  if (message.type !== 'request' || message.command !== 'setExceptionBreakpoints') return message;
  const args: unknown = message.arguments;
  if (!isRecord(args)) return message;
  return { ...message, arguments: withTranslatedExceptionOptions(args) };
}
