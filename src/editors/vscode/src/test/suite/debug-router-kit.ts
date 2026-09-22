// Live DAP driver independent of language-sidecar activation.
// Implements [DEBUG-ARCHITECTURE-ROUTER].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DapRouter } from '../../dap-router';
import { isRecord, type DapMessage } from '../../dap-emulate';
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
    const event = await this.event('stopped');
    assert.ok(isRecord(event.body));
    assert.equal(event.body.reason, 'exception');
    assert.equal(typeof event.body.threadId, 'number');
    return Number(event.body.threadId);
  }

  dispose(): void {
    this.subscription.dispose();
    this.router.dispose();
  }
}
