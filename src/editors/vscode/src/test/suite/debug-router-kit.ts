// Live DAP driver independent of language-sidecar activation.
// Implements [DEBUG-ARCHITECTURE-ROUTER].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DapRouter } from '../../dap-router';
import { isRecord, recordList, type DapMessage } from '../../dap-emulate';
import type { DebugFixture } from './debug-fixture-programs';
import { pollUntilResult } from './test-helpers';
import { DEBUG_SESSION_MS } from './test-timeouts';

/** Drive the production router and real netcoredbg without a VS Code debug session. */
export class LiveRouter implements vscode.Disposable {
  private readonly router: DapRouter;
  private readonly messages: DapMessage[] = [];
  private readonly subscription: vscode.Disposable;
  private seq = 0;

  constructor() {
    const configured = process.env['SHARPLSP_TEST_ADAPTER'];
    const adapter =
      configured ??
      path.resolve(
        __dirname,
        '../../../bin',
        `${process.platform}-${process.arch}`,
        'netcoredbg',
        process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg',
      );
    assert.ok(fs.existsSync(adapter), `a real netcoredbg is required: ${adapter}`);
    this.router = new DapRouter(adapter);
    this.subscription = this.router.onDidSendMessage((message) => {
      this.messages.push({ ...message });
    });
  }

  async request(command: string, args: Record<string, unknown> = {}): Promise<DapMessage> {
    const seq = ++this.seq;
    this.router.handleMessage({ type: 'request', seq, command, arguments: args });
    const response = await pollUntilResult(
      async () =>
        this.messages.find((message) => message.type === 'response' && message.request_seq === seq),
      (message) => message !== undefined,
      DEBUG_SESSION_MS,
      20,
    );
    assert.ok(response, `response to ${command}`);
    return response;
  }

  async event(name: string, count = 1): Promise<DapMessage> {
    const events = await pollUntilResult(
      async () => this.messages.filter((message) => message.event === name),
      (messages) => messages.length >= count,
      DEBUG_SESSION_MS,
      20,
    );
    const event = events[count - 1];
    assert.ok(event, `event ${name} #${count}`);
    return event;
  }

  /** The `count`th `stopped` event's body, proven to carry `reason`. */
  async stopped(count: number, reason: string, why?: string): Promise<Record<string, unknown>> {
    const event = await this.event('stopped', count);
    assert.ok(isRecord(event.body), `stopped #${count} carries a body`);
    assert.equal(event.body.reason, reason, why ?? `stopped #${count} is a ${reason} stop`);
    return event.body;
  }

  /** `stackTrace` for the top frame of `threadId`, and that frame's line. */
  async topStack(threadId: number): Promise<{ body: Record<string, unknown>; line: unknown }> {
    const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    assert.ok(isRecord(stack.body), 'stackTrace carries a body');
    return { body: stack.body, line: recordList(stack.body.stackFrames)[0]?.line };
  }

  /** Observe protocol traffic without substituting an adapter. */
  public traffic(): readonly DapMessage[] {
    return this.messages;
  }

  /** The pid netcoredbg reported for the debuggee it LAUNCHED, once it has. */
  async launchedPid(): Promise<number> {
    const event = await this.event('process');
    assert.ok(isRecord(event.body), 'the process event carries a body');
    assert.strictEqual(event.body.startMethod, 'launch', 'the debuggee was launched, not attached');
    const pid = Number(event.body.systemProcessId);
    assert.ok(
      Number.isInteger(pid) && pid > 0,
      `a real pid, not ${String(event.body.systemProcessId)}`,
    );
    return pid;
  }

  /** Answer a reverse request as the DAP client, including a deliberately late answer. */
  public answerReverse(request: DapMessage, success: boolean, body = {}): void {
    this.router.handleMessage({
      type: 'response',
      seq: ++this.seq,
      request_seq: request.seq,
      command: request.command,
      success,
      body,
    });
  }

  async launch(
    fixture: DebugFixture,
    mode: string,
    exceptionPolicy?: Record<string, unknown>,
    breakpointAnchors: readonly string[] = [],
  ): Promise<void> {
    assert.equal(
      (
        await this.request('initialize', {
          adapterID: 'coreclr',
          linesStartAt1: true,
          columnsStartAt1: true,
        })
      ).success,
      true,
    );
    const launched = this.request('launch', {
      program: fixture.dll,
      cwd: fixture.dir,
      args: [mode],
      console: 'internalConsole',
      justMyCode: true,
      exceptionPolicy,
    });
    await this.event('initialized');
    if (breakpointAnchors.length > 0) {
      assert.equal(
        (
          await this.request('setBreakpoints', {
            source: { path: fixture.uri.fsPath },
            breakpoints: breakpointAnchors.map((anchor) => ({
              line: fixture.source.dapLine(anchor),
            })),
          })
        ).success,
        true,
      );
    }
    assert.equal((await this.request('setExceptionBreakpoints', { filters: [] })).success, true);
    assert.equal((await this.request('configurationDone')).success, true);
    assert.equal((await launched).success, true);
  }

  async exceptionStop(): Promise<number> {
    const event = await this.stopped(1, 'exception');
    assert.equal(typeof event.threadId, 'number');
    return Number(event.threadId);
  }

  dispose(): void {
    this.subscription.dispose();
    this.router.dispose();
  }
}

/** Runs `body` against a fresh router, disposed however the body ends. */
export async function withRouter(body: (driver: LiveRouter) => Promise<void>): Promise<void> {
  const driver = new LiveRouter();
  try {
    await body(driver);
  } finally {
    driver.dispose();
  }
}
