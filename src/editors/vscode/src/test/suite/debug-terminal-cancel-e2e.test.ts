// Implements [DEBUG-FEATURES-LAUNCH-OUTPUT]: Stop cancels a pending terminal launch.
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isRecord } from '../../dap-emulate';
import { signalChild } from '../../child-signal';
import { MODE } from './debug-fixture-programs';
import { LiveRouter } from './debug-router-kit';
import { useDebuggee } from './debug-suite-kit';
import { pollUntilResult } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS } from './test-timeouts';

/** A cancelled launch ends once and never starts a replacement program. */
function assertCancelledSession(driver: LiveRouter): void {
  assert.equal(driver.traffic().filter((message) => message.event === 'terminated').length, 1);
  assert.equal(
    driver.traffic().filter((message) => message.event === 'process').length,
    0,
    'a late terminal response must not launch a new program after Stop',
  );
}

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`Pending terminal cancellation — ${language}`, () => {
    const debuggee = useDebuggee(`debug-cancel-${language}-`, language);
    for (const console of ['externalTerminal', 'integratedTerminal']) {
      for (const command of ['terminate', 'disconnect']) {
        test(`${command} ends ${console} before its client responds`, async function () {
          this.timeout(DEBUG_TEST_MS);
          const driver = new LiveRouter();
          const { fixture } = debuggee();
          try {
            assert.equal(
              (
                await driver.request('initialize', {
                  adapterID: 'coreclr',
                  supportsRunInTerminalRequest: true,
                })
              ).success,
              true,
            );
            await driver.event('initialized');
            assert.equal(
              (
                await driver.request('launch', {
                  program: fixture.dll,
                  cwd: fixture.dir,
                  args: [MODE.wait],
                  console,
                })
              ).success,
              true,
            );
            const reverse = driver.traffic().find((message) => message.command === 'runInTerminal');
            assert.ok(reverse, 'the real router asked this client to start a terminal');
            assert.ok(isRecord(reverse.arguments));
            assert.equal(
              reverse.arguments.kind,
              console === 'externalTerminal' ? 'external' : 'integrated',
            );

            assert.equal(
              (await driver.request(command, { terminateDebuggee: true })).success,
              true,
            );
            assert.equal(
              (await driver.event('terminated')).event,
              'terminated',
              'Stop must end the session even when runInTerminal has not answered',
            );
            driver.answerReverse(reverse, false);
            assert.equal((await driver.request('disconnect')).success, true);
            assert.deepEqual((await driver.request('threads')).body, { threads: [] });
            assertCancelledSession(driver);
          } finally {
            driver.dispose();
          }
        });
      }
    }

    test('a late terminal PID is ended without resurrecting a disposed session', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      const { fixture } = debuggee();
      const child = spawn('dotnet', [fixture.dll, MODE.wait], {
        cwd: fixture.dir,
        stdio: 'ignore',
      });
      try {
        await once(child, 'spawn');
        assert.ok(child.pid && child.pid > 0, 'this client owns a real fixture process');
        await driver.request('initialize', { supportsRunInTerminalRequest: true });
        await driver.request('launch', { program: fixture.dll, console: 'integratedTerminal' });
        const reverse = driver.traffic().find((message) => message.command === 'runInTerminal');
        assert.ok(reverse);
        await driver.request('terminate');
        await driver.event('terminated');
        driver.dispose();
        assert.equal(child.exitCode, null, 'the client has not yet identified its running process');
        assert.equal(child.signalCode, null);
        driver.answerReverse(
          reverse,
          true,
          process.platform === 'win32' ? { processId: child.pid } : { shellProcessId: child.pid },
        );
        await pollUntilResult(
          async () => child.exitCode !== null || child.signalCode !== null,
          (ended) => ended,
          DEBUG_SESSION_MS,
          20,
        );
        assertCancelledSession(driver);
      } finally {
        signalChild(child, 'SIGKILL');
        driver.dispose();
      }
    });
  });
}
