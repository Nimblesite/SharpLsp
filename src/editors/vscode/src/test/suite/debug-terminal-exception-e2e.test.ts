// Implements [DEBUG-FEATURES-EXCEPTIONS] and [DEBUG-FEATURES-STEPPING].
import * as assert from 'node:assert/strict';
import { MODE } from './debug-fixture-programs';
import { useDebuggee } from './debug-suite-kit';
import { LiveRouter } from './debug-router-kit';
import { DEBUG_TEST_MS } from './test-timeouts';
import { isRecord } from '../../dap-emulate';

suite('Debug terminal exception visibility', () => {
  const debuggee = useDebuggee('debug-terminal-fs-', 'fsharp');

  test('Just My Code and exclusions preserve genuinely unhandled framework exceptions', async function () {
    this.timeout(DEBUG_TEST_MS);
    const driver = new LiveRouter();
    try {
      await driver.launch(debuggee().fixture, MODE.missingAssembly, {
        break_on: 'all',
        just_my_code: true,
        ignore: ['System.IO.FileNotFoundException'],
      });
      const threadId = await driver.exceptionStop();
      const info = await driver.request('exceptionInfo', { threadId });
      assert.ok(isRecord(info.body));
      assert.equal(info.body.breakMode, 'unhandled');
      assert.equal(info.body.exceptionId, 'CLR/System.IO.FileNotFoundException');
      assert.match(String(info.body.description), /FileNotFoundException/);
      assert.ok(isRecord(info.body.details));
      assert.equal(info.body.details.fullTypeName, 'System.IO.FileNotFoundException');
      assert.deepEqual((await driver.request('exceptionInfo', { threadId })).body, info.body);
    } finally {
      driver.dispose();
    }
  });
});
