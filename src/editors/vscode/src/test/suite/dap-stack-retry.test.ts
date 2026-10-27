// A stop's logical stack is cached only once its reconstruction settles: a
// walk that failed or found nothing is retried by the next `stackTrace`, so one
// transient adapter failure never pins the physical stack for the rest of the
// stop (GitHub #519). Implements [DEBUG-FEATURES-STACK-ASYNC].
import * as assert from 'node:assert/strict';
import type { DapMessage } from '../../dap-emulate';
import { HandleNamespace } from '../../dap-namespace';
import { StackDelivery, type StackHost } from '../../dap-stack';

/** The paused async method's physical frame, as netcoredbg names it. */
const LEAF = 'StepTarget.Program.<LeafAsync>d__0.MoveNext()';

/** User code under the launch root, so Just My Code keeps the frame. */
const USER_SOURCE = { name: 'Program.cs', path: '/work/Program.cs' };

/** A stand-in adapter: arming succeeds, the heap walk is always refused. */
class RefusingAdapter implements StackHost {
  public readonly requests: string[] = [];
  private readonly answered: DapMessage[] = [];
  private waiting: (() => void) | undefined;

  public request(command: string, _args: Record<string, unknown>): Promise<DapMessage> {
    this.requests.push(command);
    const frames = [{ id: 1, name: LEAF, line: 7, column: 1, source: USER_SOURCE }];
    const refused = command === 'evaluate' || command === 'variables';
    const body = command === 'stackTrace' ? { stackFrames: frames, totalFrames: 1 } : {};
    return Promise.resolve({ type: 'response', command, success: !refused, body });
  }

  public emit(message: DapMessage): void {
    if (message.command !== 'stackTrace') return;
    this.answered.push(message);
    this.waiting?.();
  }

  public respondTo(): void {
    // The router answers nothing else of the client's in these interactions.
  }

  /** Resolves once `count` stack answers have reached the client. */
  public async answers(count: number): Promise<void> {
    while (this.answered.length < count) {
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  /** How many heap reads the walks have asked for so far. */
  public walks(): number {
    return this.requests.filter((command) => command === 'evaluate').length;
  }
}

function stopped(reason: string): DapMessage {
  return { type: 'event', event: 'stopped', body: { reason, threadId: 1 } };
}

function stackResponse(): DapMessage {
  const stackFrames = [{ id: 1, name: LEAF, line: 7, column: 1, source: USER_SOURCE }];
  return { type: 'response', command: 'stackTrace', success: true, body: { stackFrames } };
}

/** Let the router's queued work run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

suite('DAP router — async stack reconstruction retries', () => {
  test('a walk that recovered nothing is walked again by the next stackTrace', async () => {
    const adapter = new RefusingAdapter();
    const delivery = new StackDelivery(adapter, new HandleNamespace());
    delivery.onLaunch({ cwd: '/work' });
    assert.ok(
      delivery.interceptStop(stopped('entry')),
      'the injected entry stop arms the registry',
    );
    await settle();
    assert.ok(adapter.requests.includes('setExpression'), 'async debugging is switched on');

    delivery.interceptStop(stopped('breakpoint'));
    delivery.deliver(stackResponse(), { threadId: 1 });
    await adapter.answers(1);
    const first = adapter.walks();
    assert.ok(first > 0, 'the first stackTrace walks the heap');

    delivery.deliver(stackResponse(), { threadId: 1 });
    await adapter.answers(2);
    assert.ok(
      adapter.walks() > first,
      'the unsettled walk is retried, never served from the cache',
    );
  });
});
