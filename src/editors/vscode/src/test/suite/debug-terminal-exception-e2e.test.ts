// Implements [DEBUG-FEATURES-EXCEPTIONS] and [DEBUG-FEATURES-STEPPING].
import * as assert from 'node:assert/strict';
import { MODE } from './debug-fixture-programs';
import { useDebuggee } from './debug-suite-kit';
import { LiveRouter } from './debug-router-kit';
import { DEBUG_TEST_MS } from './test-timeouts';
import { isRecord } from '../../dap-emulate';

suite('Debug terminal exception recovery', () => {
  const debuggee = useDebuggee('debug-terminal-fs-', 'fsharp');

  test('F10 after an unhandled exception explains why stepping cannot resume and how to recover', async function () {
    this.timeout(DEBUG_TEST_MS);
    const driver = new LiveRouter();
    try {
      await driver.launch(debuggee().fixture, MODE.missingAssembly);
      const threadId = await driver.exceptionStop();
      const info = await driver.request('exceptionInfo', { threadId });
      assert.ok(isRecord(info.body));
      assert.equal(info.body.breakMode, 'unhandled');
      assert.equal(info.body.exceptionId, 'CLR/System.IO.FileNotFoundException');
      const result = await driver.request('next', { threadId });
      assert.equal(result.success, false);
      assert.match(
        String(result.message),
        /unhandled exception/i,
        'F10 must explain the terminal exception',
      );
      assert.match(String(result.message), /restart/i, 'F10 must explain how to recover');
      assert.deepEqual((await driver.request('exceptionInfo', { threadId })).body, info.body);
    } finally {
      driver.dispose();
    }
  });
});
