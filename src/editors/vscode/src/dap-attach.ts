// The router's attach semantics: the bounded retry for netcoredbg's transient
// Windows invalid-argument failure, what "stop" means for an attached process,
// and the VSTest host-debug handshake a test debug run attaches through.
//
// Implements [DEBUG-GAPS] "Attach error `0x80070057` | Retry with exponential
// backoff" (the same upstream race can reject the first `evaluate` issued as a
// freshly stopped Windows thread becomes inspectable; the proxy owns retry
// sequence numbers and restores the client's original sequence only when it
// delivers the final response), the [DEBUG-FEATURES-LAUNCH] attach rows
// (stopping an ATTACH session detaches — it must never kill a process the user
// did not start), and the closing rule of [DEBUG-FEATURES-TESTS] (resume the
// `Debugger.Break()` a VSTEST_HOST_DEBUG test host issues on attach, so the
// first stop the user sees is their own breakpoint).
import { isRecord, type DapMessage } from './dap-emulate';

/**
 * Backoff for netcoredbg's transient `0x80070057`, PER COMMAND.
 *
 * No response reaches VS Code until the ladder is exhausted, so its total is a
 * hard floor under how long the client can be left waiting. An attach must fit
 * inside [DEBUG-PERFORMANCE] "Attach to running process | <3s", which is also
 * the policy DEBUGGING-PLAN 4.3 states (three retries, 500 ms). A watch
 * expression that answers late is an annoyance; an attach that answers late is
 * a dead session, so the two no longer share one ladder.
 */
const RETRY_DELAYS_MS: Readonly<Record<'attach' | 'evaluate', readonly number[]>> = {
  attach: [250, 500, 1_000],
  evaluate: [500, 1_000, 2_000, 4_000],
};

/**
 * Attach-configuration marker a Test Explorer debug run sets so the router
 * resumes the test host's own `Debugger.Break()` instead of surfacing it.
 * netcoredbg ignores configuration keys it does not read, so the flag rides
 * the `attach` request untouched. Spec: [DEBUG-FEATURES-TESTS].
 */
export const TEST_HOST_ATTACH_FLAG = 'testHostAttach';

/** Stop reasons that carry the user's own gesture and are never absorbed. */
const USER_STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'exception', 'entry'];

export interface RetryHost {
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  deliver(message: DapMessage): void;
  isClosed(): boolean;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isTransientInvalidArgument(message: DapMessage): boolean {
  if (message.success === true) return false;
  const detail = JSON.stringify({ message: message.message, body: message.body }).toLowerCase();
  return detail.includes('80070057');
}

/** Retries only netcoredbg's exact transient invalid-argument response. */
class InvalidArgumentRetrier {
  constructor(
    private readonly host: RetryHost,
    private readonly command: 'attach' | 'evaluate',
  ) {}

  public start(clientRequest: DapMessage, args: Record<string, unknown>): void {
    void this.run(clientRequest, args);
  }

  private async run(clientRequest: DapMessage, args: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; !this.host.isClosed(); attempt += 1) {
      const response = await this.host.request(this.command, args);
      const wait = RETRY_DELAYS_MS[this.command][attempt];
      if (!isTransientInvalidArgument(response) || wait === undefined) {
        this.deliver(clientRequest, response);
        return;
      }
      await delay(wait);
    }
  }

  private deliver(clientRequest: DapMessage, response: DapMessage): void {
    this.host.deliver({ ...response, request_seq: Number(clientRequest.seq ?? -1) });
  }
}

/**
 * Retry policy for the documented Windows attach race, plus the semantics an
 * attach session carries for the rest of its life: how `disconnect` must be
 * phrased, and whether the first stop is the VSTest host's own break.
 */
export class AttachRetrier extends InvalidArgumentRetrier {
  /** True once this session attached rather than launched. */
  private attachMode = false;
  /** One-shot: the next non-user stop is the test host's `Debugger.Break()`. */
  private pendingTestHostBreak = false;

  constructor(private readonly attachHost: RetryHost) {
    super(attachHost, 'attach');
  }

  public override start(clientRequest: DapMessage, args: Record<string, unknown>): void {
    this.attachMode = true;
    this.pendingTestHostBreak = args[TEST_HOST_ATTACH_FLAG] === true;
    super.start(clientRequest, args);
  }

  /**
   * Phrase a client `disconnect` for the process this session is bound to.
   *
   * VS Code's stop gesture sends `terminateDebuggee: true` whenever the
   * adapter advertises `supportTerminateDebuggee`, and netcoredbg then KILLS
   * the debuggee — data loss on any long-running service the user merely
   * attached to. An ATTACH session therefore always disconnects with
   * `terminateDebuggee: false`; a LAUNCH session's disconnect passes through
   * untouched, so stopping a launched debuggee still terminates it.
   * Spec: [DEBUG-FEATURES-LAUNCH] attach rows.
   */
  public rewriteDisconnect(message: DapMessage): DapMessage {
    if (!this.attachMode) return message;
    const args = isRecord(message.arguments) ? message.arguments : {};
    return { ...message, arguments: { ...args, terminateDebuggee: false } };
  }

  /**
   * Absorb the stop a VSTEST_HOST_DEBUG test host issues once a debugger is
   * attached, resuming the host so the run proceeds to the user's breakpoint.
   *
   * The waiting test host calls `Debugger.Break()` the moment it observes the
   * attach — a `pause` stop inside VSTest's own wait loop, before any test
   * code has run. Surfacing it would park the user in framework code on every
   * test debug, so it is continued here instead; a stop that names the user's
   * own gesture (a breakpoint, a step, an exception) is never absorbed.
   * Returns true when the stop was swallowed. Spec: [DEBUG-FEATURES-TESTS].
   */
  public absorbTestHostBreak(message: DapMessage): boolean {
    if (!this.pendingTestHostBreak) return false;
    this.pendingTestHostBreak = false;
    const body = isRecord(message.body) ? message.body : {};
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const hits = Array.isArray(body.hitBreakpointIds) ? body.hitBreakpointIds : [];
    if (USER_STOP_REASONS.includes(reason) || hits.length > 0) return false;
    const threadId = Number(body.threadId ?? 0);
    void this.attachHost.request('continue', { threadId }).catch(() => undefined);
    return true;
  }
}

/** Retry policy for the same race on the first evaluation after a stop. */
export class EvaluateRetrier extends InvalidArgumentRetrier {
  constructor(host: RetryHost) {
    super(host, 'evaluate');
  }
}
