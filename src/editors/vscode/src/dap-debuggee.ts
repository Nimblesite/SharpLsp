// The process a LAUNCH session started, and the rule that it never outlives the
// adapter that owned it.
//
// netcoredbg names the debuggee it starts in the DAP `process` event
// (`startMethod: "launch"`, `systemProcessId`). Ending that process is the
// adapter's job — `terminate` and `disconnect` do it — so while the adapter
// lives the router never touches it. An adapter that DIES first takes the job
// with it: the debuggee is reparented to init and, stopped by a debugger that
// no longer exists, stays suspended for good, holding its files and ports. Only
// then does the router end it itself. An ATTACHED process is the user's own and
// is never ended ([DEBUG-FEATURES-LAUNCH] attach rows).
//
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle".
//
// Deliberately free of `vscode` imports: nothing here needs the workbench.
import { isRecord, type DapMessage } from './dap-emulate';
import { signalPid } from './child-signal';
import { info } from './log';

/** The pid a `process` event names for a debuggee the adapter itself LAUNCHED. */
function launchedPid(message: DapMessage): number | undefined {
  if (message.type !== 'event' || message.event !== 'process') return undefined;
  const body = isRecord(message.body) ? message.body : {};
  const pid = Number(body.systemProcessId ?? Number.NaN);
  return body.startMethod === 'launch' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** True for the events that say the debuggee has already ended. */
function announcesEnd(message: DapMessage): boolean {
  return message.type === 'event' && (message.event === 'exited' || message.event === 'terminated');
}

/** The one debuggee this session's adapter launched and has not yet ended. */
export class LaunchedDebuggee {
  private pid: number | undefined;

  /** Follow the adapter's own account of the debuggee it launched and ended. */
  public observe(message: DapMessage): void {
    if (announcesEnd(message)) this.pid = undefined;
    this.pid = launchedPid(message) ?? this.pid;
  }

  /** A new debuggee is about to start; the previous one is not ours to end. */
  public forget(): void {
    this.pid = undefined;
  }

  /**
   * The adapter died with the debuggee still running: end it, as the adapter's
   * own `terminate` would have. SIGKILL, because a process stopped by a
   * debugger that is gone runs no handler a gentler signal could reach.
   */
  public endOrphan(): void {
    const pid = this.pid;
    this.pid = undefined;
    if (pid === undefined) return;
    const outcome = signalPid(pid, 'SIGKILL');
    info(
      outcome.ok
        ? `Ended debuggee ${String(pid)}: its adapter exited without ending it.`
        : `Debuggee ${String(pid)} was already gone: ${outcome.error}`,
    );
  }
}
