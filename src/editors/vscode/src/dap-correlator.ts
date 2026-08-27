// The router's own DAP requests, correlated with netcoredbg's responses.
//
// Every emulation in [DEBUG-ADAPTER-GAPS] — hit counts, logpoints,
// run-to-cursor, same-line step coalescing — needs to ASK netcoredbg something
// in the router's own name rather than the client's: where is the thread
// parked, what does this expression evaluate to, continue. Those requests carry
// sequence numbers the client never sees, and their responses must be settled
// here instead of forwarded.
//
// This is the consumer-side twin of `lspkit-sidecar::correlator::Correlator`;
// see the migration table in CLAUDE.md.
//
// Deliberately free of `vscode` imports: nothing here needs the workbench.
import type { DapMessage } from './dap-emulate';

/** The first sequence number the router issues in its own name. */
const FIRST_SEQ = 1_000_000;

/** One request awaiting its response. */
interface Pending {
  readonly command: string;
  readonly resolve: (message: DapMessage) => void;
}

/** Issues the router's own requests and settles their responses. */
export class RequestCorrelator {
  /** The router's own in-flight requests, settled if the child dies mid-await. */
  private readonly pending = new Map<number, Pending>();
  private nextSeq = FIRST_SEQ;

  constructor(private readonly write: (message: DapMessage) => void) {}

  /** The next sequence number for anything the router issues itself. */
  public nextSequence(): number {
    return this.nextSeq++;
  }

  /** Send a request in the router's own name and await its response. */
  public async request(command: string, args: Record<string, unknown>): Promise<DapMessage> {
    const seq = this.nextSequence();
    const reply = new Promise<DapMessage>((resolve) => {
      this.pending.set(seq, { command, resolve });
    });
    this.write({ seq, type: 'request', command, arguments: args });
    return await reply;
  }

  /** Settle one response if it answers a request we issued. True when it did. */
  public settle(requestSeq: number, message: DapMessage): boolean {
    const ours = this.pending.get(requestSeq);
    if (ours === undefined) return false;
    this.pending.delete(requestSeq);
    ours.resolve(message);
    return true;
  }

  /**
   * Fail every request still in flight; none may hang.
   *
   * The child is gone while VS Code still believes the session is running, so
   * an awaited emulation that never settles would strand the stop it was
   * judging — a paused debuggee nobody can resume.
   */
  public failAll(reason: string): void {
    const inFlight = [...this.pending];
    this.pending.clear();
    for (const [seq, entry] of inFlight) {
      entry.resolve({
        seq,
        type: 'response',
        request_seq: seq,
        command: entry.command,
        success: false,
        message: `netcoredbg ${reason}`,
      });
    }
  }
}
