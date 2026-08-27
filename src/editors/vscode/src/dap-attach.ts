// Bounded retry for netcoredbg's transient Windows invalid-argument failure.
//
// Implements [DEBUG-GAPS] "Attach error `0x80070057` | Retry with exponential
// backoff". The same upstream race can reject the first `evaluate` issued as a
// freshly stopped Windows thread becomes inspectable. The proxy owns retry
// sequence numbers and restores the client's original sequence only when it
// delivers the final response.
import type { DapMessage } from './dap-emulate';

const RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];

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
      const wait = RETRY_DELAYS_MS[attempt];
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

/** Retry policy for the documented Windows attach race. */
export class AttachRetrier extends InvalidArgumentRetrier {
  constructor(host: RetryHost) {
    super(host, 'attach');
  }
}

/** Retry policy for the same race on the first evaluation after a stop. */
export class EvaluateRetrier extends InvalidArgumentRetrier {
  constructor(host: RetryHost) {
    super(host, 'evaluate');
  }
}
