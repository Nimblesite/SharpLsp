// The deadline a request to stop has to produce the end of the session.
//
// netcoredbg can wedge while terminating: it answers `terminate`, then sends
// neither `exited` nor `terminated` and does not exit. The router's
// adapter-death path never runs, because the adapter is not dead — so nothing
// fires `terminated`, VS Code keeps the session in the debug toolbar with no
// way to close it, and the debuggee the adapter launched outlives the session
// that owned it. That is the other side of #260: the SIGSEGV leaves a DEAD
// adapter, which the router already handles; the wedge leaves a LIVE one, which
// until now nothing did.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle".
//
// Deliberately free of `vscode` imports: nothing here needs the workbench.
import type { DapMessage } from './dap-emulate';

/**
 * How long a stop request may go unhonoured before the router ends the session.
 *
 * Well above any healthy teardown — detach, reap the debuggee, report the end —
 * which completes in under a second, so a merely slow stop is never mistaken
 * for a wedge. And strictly below the suite's 45s teardown poll with a full
 * deadline to spare, so the router's recovery lands and the workbench has time
 * to drop the session before anything watching gives up.
 */
export const SHUTDOWN_DEADLINE_MS = 15_000;

/** The requests that ask the adapter to end the session. */
const STOP_COMMANDS: readonly string[] = ['terminate', 'disconnect'];

/** True for a client request that asks the adapter to stop. */
export function asksToStop(message: DapMessage): boolean {
  return (
    message.type === 'request' &&
    typeof message.command === 'string' &&
    STOP_COMMANDS.includes(message.command)
  );
}

/** True for the event that says the session itself has ended. */
function announcesSessionEnd(message: DapMessage): boolean {
  return message.type === 'event' && message.event === 'terminated';
}

/** The end a stop request is owed, and the deadline it is owed by. */
export class ShutdownDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly milliseconds: number,
    private readonly onWedged: () => void,
  ) {}

  /** Arm on the FIRST stop request; a second one does not extend the clock. */
  public armFor(message: DapMessage): void {
    if (this.timer !== undefined || !asksToStop(message)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onWedged();
    }, this.milliseconds);
  }

  /** The adapter reported the end it owed. */
  public observe(message: DapMessage): void {
    if (announcesSessionEnd(message)) this.cancel();
  }

  /** The session is over by some other route; the debt cannot come due. */
  public cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * The stop requests the client sent that no response has answered yet.
 *
 * netcoredbg on Windows exits by itself once its debuggee has ended, so the
 * `disconnect` VS Code sends in reply to `terminated` can reach a process that
 * never answers it. VS Code holds the session until its own disconnect timeout
 * gives up: a launch made meanwhile found the dead session still active, and a
 * breakpoint edit reached an adapter that refused it. An adapter that is gone
 * IS the stopped state, so whatever it still owed is answered for it.
 */
export class UnansweredStops {
  private readonly owed = new Map<number, DapMessage>();

  /** Owe an answer to `message` when it asks to stop. */
  public expect(message: DapMessage): void {
    if (asksToStop(message)) this.owed.set(Number(message.seq ?? -1), message);
  }

  /** A response reached the client; the request it answers is owed nothing. */
  public observe(message: DapMessage): void {
    if (message.type === 'response') this.owed.delete(Number(message.request_seq ?? -1));
  }

  /** Hand each stop request still owed to `answer`, once. */
  public settle(answer: (message: DapMessage) => void): void {
    const owed = [...this.owed.values()];
    this.owed.clear();
    owed.forEach(answer);
  }
}
