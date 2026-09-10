// Implements [CONFIG-DEBUG-EXCEPTIONS], [DEBUG-FEATURES-STEPPING].
import * as assert from 'node:assert/strict';
import { isRecord, recordList } from '../../dap-emulate';
import { MODE, CAUGHT_TYPE } from './debug-fixture-programs';
import { useDebuggee } from './debug-suite-kit';
import { LiveRouter } from './debug-router-kit';
import { DEBUG_TEST_MS } from './test-timeouts';

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`Just My Code exceptions on ${language}`, () => {
    const debuggee = useDebuggee(`debug-jmc-${language}-`, language);

    test('F10 at a deep first-chance exception executes its handler and returns to user code', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      try {
        const fixture = debuggee().fixture;
        await driver.launch(fixture, MODE.libraryCaught, { break_on: 'all', just_my_code: false });
        const threadId = await driver.exceptionStop();
        const info = await driver.request('exceptionInfo', { threadId });
        assert.ok(isRecord(info.body));
        assert.equal(info.body.breakMode, 'always');
        assert.match(String(info.body.description), /library-internal/);
        const response = await driver.request('next', { threadId });
        assert.equal(response.success, true, String(response.message));
        const stopped = await driver.event('stopped', 2);
        assert.ok(isRecord(stopped.body));
        assert.equal(stopped.body.reason, 'step');
        const stack = await driver.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
        assert.ok(isRecord(stack.body));
        assert.equal(
          recordList(stack.body.stackFrames)[0]?.line,
          fixture.source.dapLine('after-library'),
        );
      } finally {
        driver.dispose();
      }
    });

    test('F10 across a library-handled exception stops on the next user statement', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      try {
        const fixture = debuggee().fixture;
        await driver.launch(fixture, MODE.libraryCaught, { break_on: 'all', just_my_code: true }, [
          'before-library',
        ]);
        const stopped = await driver.event('stopped');
        assert.ok(isRecord(stopped.body));
        assert.equal(stopped.body.reason, 'breakpoint');
        const threadId = Number(stopped.body.threadId);
        assert.equal((await driver.request('next', { threadId })).success, true);
        const next = await driver.event('stopped', 2);
        assert.ok(isRecord(next.body));
        assert.equal(
          next.body.reason,
          'step',
          'ignoring the library throw must preserve the pending F10',
        );
        const stack = await driver.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
        assert.ok(isRecord(stack.body));
        assert.equal(
          recordList(stack.body.stackFrames)[0]?.line,
          fixture.source.dapLine('after-library'),
        );
      } finally {
        driver.dispose();
      }
    });

    test('Just My Code skips library-handled exceptions and still breaks on user throws', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      try {
        const fixture = debuggee().fixture;
        await driver.launch(fixture, MODE.libraryCaught, { break_on: 'all', just_my_code: true }, [
          'after-library',
        ]);
        const stop = await driver.event('stopped');
        assert.ok(isRecord(stop.body));
        assert.equal(
          stop.body.reason,
          'breakpoint',
          'the library caught its own exception; the first visible stop must be the user breakpoint',
        );
        const threadId = Number(stop.body.threadId);
        assert.equal((await driver.request('next', { threadId })).success, true);
        const stepped = await driver.event('stopped', 2);
        assert.ok(isRecord(stepped.body));
        assert.equal(stepped.body.reason, 'step');
        const stack = await driver.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
        assert.ok(isRecord(stack.body));
        assert.equal(
          recordList(stack.body.stackFrames)[0]?.line,
          fixture.source.dapLine('step-after-library'),
        );
        assert.equal((await driver.request('continue', { threadId })).success, true);
        const userThrow = await driver.event('stopped', 3);
        assert.ok(isRecord(userThrow.body));
        assert.equal(userThrow.body.reason, 'exception');
        const info = await driver.request('exceptionInfo', { threadId: userThrow.body.threadId });
        assert.ok(isRecord(info.body));
        assert.equal(info.body.exceptionId, `CLR/${CAUGHT_TYPE}`);
        assert.equal(info.body.breakMode, 'always');
        assert.equal(
          (await driver.request('continue', { threadId: userThrow.body.threadId })).success,
          true,
        );
        assert.deepEqual((await driver.event('exited')).body, { exitCode: 0 });
      } finally {
        driver.dispose();
      }
    });

    test('break on all permits continuing a deep exception through its library handler', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      try {
        await driver.launch(
          debuggee().fixture,
          MODE.libraryCaught,
          { break_on: 'all', just_my_code: false },
          ['after-library'],
        );
        const threadId = await driver.exceptionStop();
        const info = await driver.request('exceptionInfo', { threadId });
        assert.ok(isRecord(info.body));
        assert.equal(
          info.body.breakMode,
          'always',
          'this exception has a handler; it is not a terminal crash',
        );
        assert.match(String(info.body.description), /library-internal/);
        assert.equal((await driver.request('continue', { threadId })).success, true);
        const stop = await driver.event('stopped', 2);
        assert.ok(isRecord(stop.body));
        assert.equal(
          stop.body.reason,
          'breakpoint',
          'continue must execute the library handler and return to our code',
        );
        assert.equal(
          (await driver.request('setExceptionBreakpoints', { filters: [] })).success,
          true,
        );
      } finally {
        driver.dispose();
      }
    });
  });
}
