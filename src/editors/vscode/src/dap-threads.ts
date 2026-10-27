// The client's `threads` requests, kept answerable across a resume.
//
// netcoredbg aborts a `threads` request still in flight when the debuggee
// resumes — the router's own `continue` past its injected entry stop, or the
// user's — and answers it "The operation was canceled". The workbench asked for
// that list on its own, so the Call Stack panel logged an error for a list one
// round trip away (#508). Implements [DEBUG-ADAPTER-GAPS].
import type { DapMessage } from './dap-emulate';
import type { StackHost } from './dap-stack';

/**
 * Ask a refused client `threads` request again in the router's own name, and
 * answer the client's request with that reply. `threads` reads state and
 * changes none, so a second ask is always safe. One retry only: a second
 * refusal is the client's to see. True when the refusal was taken over.
 */
export function rescuedThreads(
  host: Pick<StackHost, 'request' | 'emit'>,
  message: DapMessage,
): boolean {
  if (message.command !== 'threads' || message.success !== false) return false;
  const seq = Number(message.request_seq ?? -1);
  void host.request('threads', {}).then((retry) => {
    host.emit({ ...retry, request_seq: seq, command: 'threads' });
  });
  return true;
}
