// The respawn half of the router's Phase-4 emulation: `restart` and terminal
// launches both replace the netcoredbg child, and both must then replay the
// recorded handshake so the new child serves the SAME session.
//
// Implements [DEBUG-FEATURES-LAUNCH] ("a restart is a fresh launch of the same
// config") and [DEBUG-FEATURES-LAUNCH-OUTPUT] row `integratedTerminal`
// ([DEBUG-ADAPTER-GAPS]: netcoredbg never issues the `runInTerminal` reverse
// request and cannot attach mid-session, so the router hosts the debuggee via
// the client and attaches a fresh adapter to it with `--attach`).
import type { DapMessage } from './dap-emulate';
import { isRecord } from './dap-emulate';

/**
 * The DAP `runInTerminal` kind each `console` value names.
 * [DEBUG-FEATURES-LAUNCH-OUTPUT] routes `integratedTerminal` to VS Code's own
 * terminal and `externalTerminal` to an OS terminal window; every other value
 * is adapter-hosted and asks the client for no terminal at all.
 */
const TERMINAL_KINDS = new Map<string, 'integrated' | 'external'>([
  ['integratedTerminal', 'integrated'],
  ['externalTerminal', 'external'],
]);

/** What the replayer needs from its owning router. */
export interface ReplayHost {
  /** Write one message to the live child (DAP framing applied by the host). */
  write(message: DapMessage): void;
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Emit one message towards VS Code. */
  fire(message: Record<string, unknown> & { seq?: unknown }): void;
  /** Swap the child process; `attachArgs` are extra CLI arguments. */
  respawn(attachArgs: readonly string[], onReady?: () => void): void;
  /** The seq of a recorded client message, for response correlation. */
  seqOf(message: DapMessage): number;
}

/**
 * Records the client's configuration sequence and replays it after a respawn.
 *
 * The client's original requests were already answered, so replayed responses
 * are registered for swallowing rather than forwarded — VS Code's protocol
 * client would drop them anyway, but silently and after a warning.
 */
export class SessionReplayer {
  private initializeMessage?: DapMessage;
  private launchMessage?: DapMessage;
  private readonly breakpointRequests = new Map<string, DapMessage>();
  private exceptionMessage?: DapMessage;
  private configurationDoneMessage?: DapMessage;

  constructor(private readonly host: ReplayHost) {}

  /** The launch/attach request, for terminal routing decisions. */
  public launch(): DapMessage | undefined {
    return this.launchMessage;
  }

  /** Observe one client request travelling towards the adapter. */
  public observe(message: DapMessage, breakpointPath: string | undefined): void {
    const command = typeof message.command === 'string' ? message.command : '';
    if (command === 'initialize') {
      this.initializeMessage = message;
    } else if (command === 'launch' || command === 'attach') {
      this.launchMessage = message;
    } else if (command === 'setBreakpoints' && breakpointPath !== undefined) {
      this.breakpointRequests.set(breakpointPath, message);
    } else if (command === 'setExceptionBreakpoints') {
      this.exceptionMessage = message;
    } else if (command === 'configurationDone') {
      this.configurationDoneMessage = message;
    }
  }

  /**
   * The DAP `runInTerminal` kind this launch asked for, when the client can
   * host one at all.
   *
   * Both hosted rows of the [DEBUG-FEATURES-LAUNCH-OUTPUT] routing table are
   * answered here. Recognising only `integratedTerminal` meant a launch that
   * asked for `externalTerminal` was forwarded to netcoredbg verbatim, no
   * `runInTerminal` was ever issued, and the debuggee quietly took the
   * adapter-hosted row instead of the one the configuration named.
   */
  public terminalKind(): 'integrated' | 'external' | undefined {
    const args: unknown = this.launchMessage?.arguments;
    if (!isRecord(args)) return undefined;
    const console = typeof args.console === 'string' ? args.console : '';
    const kind = TERMINAL_KINDS.get(console);
    if (kind === undefined) return undefined;
    const initArgs: unknown = this.initializeMessage?.arguments;
    return isRecord(initArgs) && initArgs.supportsRunInTerminalRequest === true ? kind : undefined;
  }

  /** The launch asked for a terminal VS Code can host. */
  public wantsTerminal(): boolean {
    return this.terminalKind() !== undefined;
  }

  /** Answer the launch and ask VS Code to host the debuggee in a terminal. */
  public startTerminalLaunch(): void {
    const launch = this.launchMessage;
    if (launch === undefined) return;
    this.host.fire({
      type: 'response',
      request_seq: this.host.seqOf(launch),
      command: 'launch',
      success: true,
      body: {},
    });
    const args = isRecord(launch.arguments) ? launch.arguments : {};
    const program = typeof args.program === 'string' ? args.program : '';
    const argv = Array.isArray(args.args) ? args.args.map(String) : [];
    const debuggee = ['dotnet', program, ...argv];
    // On POSIX, `exec` replaces the terminal shell with the debuggee, so the
    // shell pid the client reports IS the dotnet process to attach to.
    // Windows' terminal shells have no `exec`; the client's processId is used
    // when present and the launch falls back to adapter-hosted otherwise.
    const command = process.platform === 'win32' ? debuggee : ['exec', ...debuggee];
    const terminalArgs: Record<string, unknown> = {
      kind: this.terminalKind() ?? 'integrated',
      title: 'SharpLsp Debug',
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      args: command,
    };
    if (isRecord(args.env)) terminalArgs.env = args.env;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.ourReverseSeqs.add(seq);
    this.host.fire({ seq, type: 'request', command: 'runInTerminal', arguments: terminalArgs });
  }

  /** VS Code hosted the debuggee; respawn the adapter attached to it. */
  public onTerminalResponse(message: DapMessage): void {
    const body = isRecord(message.body) ? message.body : {};
    // Windows' terminal shells cannot `exec` the debuggee, so the shell pid is
    // NOT the dotnet process; only an explicit processId may be attached to.
    const attachable =
      process.platform === 'win32' ? body.processId : (body.processId ?? body.shellProcessId);
    const pid = Number(attachable ?? 0);
    if (message.success !== true || !Number.isInteger(pid) || pid <= 0) {
      // Degrade honestly rather than kill the session: respawn the adapter
      // plainly and run the launch through it, adapter-hosted. The debuggee
      // will not live in the terminal, but debugging still works.
      this.host.respawn([], () => {
        this.replayHandshake({ withLaunch: true });
      });
      return;
    }
    this.host.respawn(['--attach', String(pid)], () => {
      this.replayHandshake();
    });
  }

  /** Kill and respawn the adapter for `restart`, then replay the handshake. */
  public restart(): void {
    this.host.respawn([], () => {
      this.replayHandshake();
    });
  }

  /** initialize + launch again; breakpoint replay waits for `initialized`. */
  private replayHandshake(options: { withLaunch?: boolean } = {}): void {
    const initialize = this.initializeMessage;
    const launch = this.launchMessage;
    if (initialize !== undefined) {
      this.swallow.add(this.host.seqOf(initialize));
      this.host.write(initialize);
    }
    if (launch !== undefined && (options.withLaunch === true || !this.wantsTerminal())) {
      this.swallow.add(this.host.seqOf(launch));
      this.host.write(launch);
    }
  }

  /** Replay the client's breakpoint/exception/configuration sequence. */
  public replayConfiguration(): void {
    for (const message of this.breakpointRequests.values()) {
      this.swallow.add(this.host.seqOf(message));
      this.host.write(message);
    }
    if (this.exceptionMessage !== undefined) {
      this.swallow.add(this.host.seqOf(this.exceptionMessage));
      this.host.write(this.exceptionMessage);
    }
    if (this.configurationDoneMessage !== undefined) {
      this.swallow.add(this.host.seqOf(this.configurationDoneMessage));
      this.host.write(this.configurationDoneMessage);
    }
  }

  /** The last `setBreakpoints` request a source's breakpoints were set by. */
  private breakpointRequestFor(path: string): DapMessage | undefined {
    return this.breakpointRequests.get(path);
  }

  /**
   * The last `setBreakpoints` arguments a source recorded, or a bare source.
   *
   * Run-to-cursor merges its temporary breakpoint into the source's CURRENT
   * set, so it needs the arguments the client last armed that source with —
   * which is exactly what the replayer already records.
   */
  public breakpointArgumentsFor(path: string): Record<string, unknown> {
    const recorded = this.breakpointRequestFor(path);
    return recorded !== undefined && isRecord(recorded.arguments)
      ? recorded.arguments
      : { source: { path } };
  }

  /** Consume one replayed response so it never reaches VS Code. */
  public swallowResponse(requestSeq: number): boolean {
    return this.swallow.delete(requestSeq);
  }

  /** Replay responses to swallow: the client's original requests were answered. */
  private readonly swallow = new Set<number>();

  /** Seqs the router issued itself for its reverse `runInTerminal` request. */
  private readonly ourReverseSeqs = new Set<number>();
  private nextSeq = 2_000_000;

  /** Was this reverse-request response answering OUR `runInTerminal`? */
  public isOurReverseResponse(requestSeq: number): boolean {
    return this.ourReverseSeqs.delete(requestSeq);
  }
}
