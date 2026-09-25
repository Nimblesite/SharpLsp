// Just My Code exception stops. Implements [CONFIG-DEBUG-EXCEPTIONS].
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import { topFrameLocation, type StepLocation } from './dap-stepping';

/** Raw adapter operations; classification must precede call-stack presentation. */
export interface ExceptionStopHost {
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  resume(threadId: number): Promise<DapMessage>;
  belongsToUser(location: StepLocation): boolean;
}

/** Resume non-user first-chance throws, preserving user and terminal exceptions. */
export async function filterExceptionStop(
  host: ExceptionStopHost,
  message: DapMessage,
  justMyCode: boolean,
): Promise<DapMessage | undefined> {
  const body = isRecord(message.body) ? message.body : {};
  if (!justMyCode || body.reason !== 'exception' || typeof body.threadId !== 'number')
    return message;
  try {
    if (!(await externalFirstChance(host, body.threadId))) return message;
    const resumed = await host.resume(body.threadId);
    return resumed.success === true ? undefined : message;
  } catch {
    // A failed probe or resume must leave the real stop available to the user.
    return message;
  }
}

/** Use exceptionInfo's stage, never localized text or a projected stack. */
async function externalFirstChance(host: ExceptionStopHost, threadId: number): Promise<boolean> {
  const info = await host.request('exceptionInfo', { threadId });
  if (info.success !== true || !isRecord(info.body) || info.body.breakMode !== 'always')
    return false;
  const stack = await host.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
  if (
    stack.success !== true ||
    !isRecord(stack.body) ||
    recordList(stack.body.stackFrames).length === 0
  )
    return false;
  return !host.belongsToUser(topFrameLocation(stack.body));
}
