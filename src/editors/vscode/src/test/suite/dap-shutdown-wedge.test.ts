// An adapter that answers the request to stop and then goes silent.
//
// netcoredbg does exactly this: it answers `terminate`, then sends neither
// `exited` nor `terminated` and does not exit (issue #260, the non-crash side).
// The router's adapter-death path never runs, because the adapter is not dead.
// Nothing fires `terminated`, so VS Code keeps the session in the debug toolbar
// with no way to close it and the debuggee outlives the session that owned it.
//
// Driven against a STUB adapter rather than netcoredbg: the wedge is a race
// that reproduces roughly one run in six against the real thing, and a test for
// it has to be deterministic. The stub speaks the same DAP framing and wedges
// on demand, every time.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle".
import * as assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DapRouter } from '../../dap-router';
import { SHUTDOWN_DEADLINE_MS } from '../../dap-shutdown';
import { isRecord, type DapMessage } from '../../dap-emulate';
import { DEBUG_SESSION_MS } from './test-timeouts';
import { eq, pollUntilResult } from './test-helpers';

/** How long this test gives the router's own deadline to fire. */
const TEST_DEADLINE_MS = 400;

/**
 * A DAP adapter that answers every request and then never ends the session.
 *
 * Run through the extension host's own binary with `ELECTRON_RUN_AS_NODE`, so
 * the test depends on no `node` being on PATH — the Windows CI runners for the
 * VS Code legs set up no Node of their own ([DIST-CI-WIN-VSIX]).
 */
const STUB_SOURCE = `
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
  process.stdout.write(body);
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString('utf8');
    const length = Number(/Content-Length: *(\\d+)/i.exec(header)?.[1] ?? NaN);
    if (!Number.isInteger(length) || buffer.length < end + 4 + length) return;
    const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    if (request.type !== 'request') continue;
    send({ type: 'response', seq: 0, request_seq: request.seq, command: request.command, success: true, body: {} });
    // and then nothing: no \`exited\`, no \`terminated\`, and the process stays up.
  }
});
// Hold the event loop open forever, exactly as a wedged adapter does.
setInterval(() => undefined, 1000);
`;

/** Write the stub and the launcher that runs it, returning the adapter path. */
function wedgedAdapter(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sharplsp-wedge-'));
  const script = join(dir, 'wedged-adapter.js');
  writeFileSync(script, STUB_SOURCE, 'utf8');
  const windows = process.platform === 'win32';
  const launcher = join(dir, windows ? 'adapter.cmd' : 'adapter.sh');
  writeFileSync(
    launcher,
    windows
      ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}"\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${script}"\n`,
    'utf8',
  );
  if (!windows) chmodSync(launcher, 0o755);
  return launcher;
}

/** Drive one router against the stub, collecting everything it emits. */
class WedgeDriver {
  public readonly emitted: DapMessage[] = [];
  private readonly router: DapRouter;
  private seq = 0;

  constructor(deadlineMs: number) {
    this.router = new DapRouter(wedgedAdapter(), deadlineMs);
    this.router.onDidSendMessage((message) => {
      this.emitted.push({ ...(message as DapMessage) });
    });
  }

  /** Send a request and wait for the stub's response to come back through. */
  public async request(command: string): Promise<DapMessage> {
    const seq = ++this.seq;
    this.router.handleMessage({ type: 'request', seq, command, arguments: {} });
    const answer = await pollUntilResult(
      async () => this.emitted.find((m) => m.type === 'response' && m.request_seq === seq),
      (m) => m !== undefined,
      DEBUG_SESSION_MS,
      10,
    );
    assert.ok(answer, `the stub answered ${command}`);
    return answer;
  }

  /** Every event of one name the router has fired so far. */
  public events(name: string): DapMessage[] {
    return this.emitted.filter((m) => m.type === 'event' && m.event === name);
  }

  /** Wait for the router to end the session itself. */
  public async awaitTerminated(): Promise<DapMessage[]> {
    return await pollUntilResult(
      async () => this.events('terminated'),
      (found) => found.length > 0,
      DEBUG_SESSION_MS,
      10,
    );
  }

  public dispose(): void {
    this.router.dispose();
  }
}

suite('An adapter that stops answering the request to stop', () => {
  test('terminate that is answered but never honoured still ends the session', async () => {
    const driver = new WedgeDriver(TEST_DEADLINE_MS);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq(driver.events('terminated').length, 0, 'nothing has ended the session yet');

      const stop = await driver.request('terminate');
      eq(stop.success, true, 'the adapter ANSWERS terminate — that is the whole trap');
      eq(
        driver.events('terminated').length,
        0,
        'and answering it is not ending it: no terminated event yet',
      );

      const ended = await driver.awaitTerminated();
      eq(ended.length, 1, 'the router ended the session exactly once');
      const told = driver
        .events('output')
        .map((m) => (isRecord(m.body) ? String(m.body.output ?? '') : ''))
        .join('');
      assert.ok(
        told.includes('netcoredbg'),
        `the user is told which component stopped answering, got: ${told}`,
      );
      assert.ok(told.includes('stop'), `the user is told what it stopped answering, got: ${told}`);
    } finally {
      driver.dispose();
    }
  });

  test('disconnect is owed an end on the same deadline as terminate', async () => {
    const driver = new WedgeDriver(TEST_DEADLINE_MS);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('disconnect')).success, true, 'the adapter answers disconnect too');
      eq(driver.events('terminated').length, 0, 'answering disconnect did not end the session');

      const ended = await driver.awaitTerminated();
      eq(ended.length, 1, 'the router ended the session after disconnect went unhonoured');
    } finally {
      driver.dispose();
    }
  });

  test('a request that is not a stop request arms nothing', async () => {
    const driver = new WedgeDriver(TEST_DEADLINE_MS);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('threads')).success, true, 'an ordinary request is answered');
      await new Promise((resolve) => setTimeout(resolve, TEST_DEADLINE_MS * 4));
      eq(
        driver.events('terminated').length,
        0,
        'a live session that nobody asked to stop is never ended by the deadline',
      );
    } finally {
      driver.dispose();
    }
  });

  test('the shipped deadline leaves the teardown poll room to observe the end', () => {
    assert.ok(
      SHUTDOWN_DEADLINE_MS < DEBUG_SESSION_MS,
      `the router must give up before the teardown poll does: ${String(SHUTDOWN_DEADLINE_MS)} vs ${String(DEBUG_SESSION_MS)}`,
    );
    assert.ok(
      DEBUG_SESSION_MS - SHUTDOWN_DEADLINE_MS >= SHUTDOWN_DEADLINE_MS,
      'and leave at least another full deadline for the workbench to drop the session',
    );
    assert.ok(
      SHUTDOWN_DEADLINE_MS >= 10_000,
      `a healthy teardown must never be mistaken for a wedge: ${String(SHUTDOWN_DEADLINE_MS)}`,
    );
  });
});
