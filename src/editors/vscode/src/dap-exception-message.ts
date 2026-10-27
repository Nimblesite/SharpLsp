// The exception panel's message, recovered when netcoredbg could not read the
// exception object off the stop that produced it.
//
// netcoredbg sometimes answers `exceptionInfo` with only
// "Exception thrown: 'System.ApplicationException' in <unknown module>": no
// `details.message`, an empty `stackTrace`, and re-asking never fills it in,
// because the object it would read is not reachable on that stop. The panel
// then carries the type but not the message — the one part the user needs to
// act on. The router asks for the message another way: `evaluate` of
// `$exception.Message` in the stopped thread's top frame, and splices that into
// the reply before the client sees it. Implements [DEBUG-ADAPTER-GAPS].
import { topFrameId } from './dap-async-chain';
import type { RetryHost } from './dap-attach';
import { isRecord, type DapMessage } from './dap-emulate';
import { warn } from './log';

/** Reads the message off the exception object DAP parks on a stopped thread. */
const EXCEPTION_MESSAGE = '$exception.Message';

/** True when the reply leaves the exception panel with no message to show. */
function lacksMessage(message: DapMessage): boolean {
  const body = isRecord(message.body) ? message.body : {};
  const details = isRecord(body.details) ? body.details : {};
  return typeof details.message !== 'string' || details.message === '';
}

/** Splice a recovered message into the reply's details and its description. */
function withMessage(message: DapMessage, text: string): DapMessage {
  const body = isRecord(message.body) ? message.body : {};
  const details = isRecord(body.details) ? body.details : {};
  const description = typeof body.description === 'string' ? body.description : '';
  const carried = description === '' || description.includes(text);
  return {
    ...message,
    body: {
      ...body,
      description: carried ? description : `${description}: ${text}`,
      details: { ...details, message: text },
    },
  };
}

/** Answers `exceptionInfo` replies that carry no exception message. */
export class ExceptionMessageRescuer {
  private loggedGap = false;

  constructor(private readonly host: Pick<RetryHost, 'request' | 'deliver'>) {}

  /**
   * Take over a message-less `exceptionInfo` reply; true when taken.
   *
   * The same shape as the `threads` rescue in dap-threads.ts: the reply is
   * answered from the fallback's outcome — enriched when the message was
   * recovered, unchanged when it was not — and never both.
   */
  public rescue(message: DapMessage, threadId: number | undefined): boolean {
    if (message.command !== 'exceptionInfo' || message.success !== true) return false;
    if (!lacksMessage(message)) return false;
    const seq = Number(message.request_seq ?? -1);
    void this.recover(message, seq, threadId);
    return true;
  }

  /** Answer the client with the recovered message, or the reply it had. */
  private async recover(
    message: DapMessage,
    seq: number,
    threadId: number | undefined,
  ): Promise<void> {
    const text = threadId === undefined ? undefined : await this.evaluatedMessage(threadId);
    if (text === undefined) this.logGapOnce();
    const answer = text === undefined ? message : withMessage(message, text);
    this.host.deliver({ ...answer, request_seq: seq, command: 'exceptionInfo' });
  }

  /** `$exception.Message` in the stopped thread's top frame, if it evaluates. */
  private async evaluatedMessage(threadId: number): Promise<string | undefined> {
    const frameId = await topFrameId(this.host, threadId);
    if (frameId === 0) return undefined;
    const reply = await this.host.request('evaluate', {
      expression: EXCEPTION_MESSAGE,
      frameId,
      context: 'repl',
    });
    const result = isRecord(reply.body) ? reply.body.result : undefined;
    return reply.success === true && typeof result === 'string' && result !== ''
      ? result
      : undefined;
  }

  /** Name the gap once per session; a retried ask must not repeat it. */
  private logGapOnce(): void {
    if (this.loggedGap) return;
    this.loggedGap = true;
    warn(
      `exceptionInfo carried no message and ${EXCEPTION_MESSAGE} could not be evaluated; ` +
        'the exception panel shows the exception type only.',
    );
  }
}
