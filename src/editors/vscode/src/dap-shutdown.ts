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
function asksToStop(message: DapMessage): boolean {
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
