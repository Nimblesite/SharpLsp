// Implements [CONFIG-DEBUG-EXCEPTIONS] against a real F# project and netcoredbg.
import * as assert from 'node:assert/strict';
import { CAUGHT_TYPE, UNHANDLED_TYPE, MODE } from './debug-fixture-programs';
import { useDebuggee } from './debug-suite-kit';
import { LiveRouter } from './debug-router-kit';
import { DEBUG_TEST_MS } from './test-timeouts';
import { isRecord, recordList } from '../../dap-emulate';
import { comparablePath } from './test-helpers';

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`Shared debugger policy on ${language}`, () => {
    const debuggee = useDebuggee(`debug-policy-${language}-`, language);

    test('a framework exception can be inspected at the user boundary without losing exception details', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      try {
        const fixture = debuggee().fixture;
        await driver.launch(fixture, MODE.missingAssembly, {
          break_on: 'all',
          external_code: 'user-boundary',
        });
        const threadId = await driver.exceptionStop();
        const info = await driver.request('exceptionInfo', { threadId });
        const stack = await driver.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
        assert.ok(isRecord(stack.body));
        const frames = recordList(stack.body.stackFrames);
        assert.equal(frames.length, 1);
        const source = frames[0]?.source;
        assert.ok(isRecord(source));
        assert.equal(comparablePath(String(source.path)), comparablePath(fixture.uri.fsPath));
        assert.deepEqual((await driver.request('exceptionInfo', { threadId })).body, info.body);
        assert.ok(Number(stack.body.totalFrames) >= 1);
      } finally {
        driver.dispose();
      }
    });

    test('all breaks on a caught exception and continue still reaches normal exit', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      try {
        await driver.launch(debuggee().fixture, MODE.caught, { break_on: 'all' });
        const threadId = await driver.exceptionStop();
        const info = await driver.request('exceptionInfo', { threadId });
        assert.ok(isRecord(info.body));
        assert.equal(info.body.breakMode, 'always');
        assert.equal(info.body.exceptionId, `CLR/${CAUGHT_TYPE}`);
        assert.equal((await driver.request('continue', { threadId })).success, true);
        assert.deepEqual((await driver.event('exited')).body, { exitCode: 0 });
      } finally {
        driver.dispose();
      }
    });

    test('ignored caught exceptions run to completion under break on all', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      try {
        await driver.launch(debuggee().fixture, MODE.caught, {
          break_on: 'all',
          ignore: [UNHANDLED_TYPE, CAUGHT_TYPE],
        });
        assert.deepEqual((await driver.event('exited')).body, { exitCode: 0 });
        await driver.event('terminated');
      } finally {
        driver.dispose();
      }
    });
  });
}
