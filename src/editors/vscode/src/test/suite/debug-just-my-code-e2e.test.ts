// Implements [CONFIG-DEBUG-EXCEPTIONS], [DEBUG-FEATURES-STEPPING].
import * as assert from 'node:assert/strict';
import { isRecord } from '../../dap-emulate';
import { MODE, CAUGHT_TYPE } from './debug-fixture-programs';
import { useDebuggee } from './debug-suite-kit';
import { withRouter } from './debug-router-kit';
import { DEBUG_TEST_MS } from './test-timeouts';

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`Just My Code exceptions on ${language}`, () => {
    const debuggee = useDebuggee(`debug-jmc-${language}-`, language);

    test('F10 at a deep first-chance exception executes its handler and returns to user code', async function () {
      this.timeout(DEBUG_TEST_MS);
      await withRouter(async (driver) => {
        const fixture = debuggee().fixture;
        await driver.launch(fixture, MODE.libraryCaught, { break_on: 'all', just_my_code: false });
        const threadId = await driver.exceptionStop();
        const info = await driver.request('exceptionInfo', { threadId });
        assert.ok(isRecord(info.body));
        assert.equal(info.body.breakMode, 'always');
        assert.match(String(info.body.description), /library-internal/);
        const response = await driver.request('next', { threadId });
        assert.equal(response.success, true, String(response.message));
        await driver.stopped(2, 'step');
        assert.equal(
          (await driver.topStack(threadId)).line,
          fixture.source.dapLine('after-library'),
        );
      });
    });

    test('F10 across a library-handled exception stops on the next user statement', async function () {
      this.timeout(DEBUG_TEST_MS);
      await withRouter(async (driver) => {
        const fixture = debuggee().fixture;
        await driver.launch(fixture, MODE.libraryCaught, { break_on: 'all', just_my_code: true }, [
          'before-library',
        ]);
        const stopped = await driver.stopped(1, 'breakpoint');
        const threadId = Number(stopped.threadId);
        assert.equal((await driver.request('next', { threadId })).success, true);
        await driver.stopped(2, 'step', 'ignoring the library throw must preserve the pending F10');
        assert.equal(
          (await driver.topStack(threadId)).line,
          fixture.source.dapLine('after-library'),
        );
      });
    });

    test('Just My Code skips library-handled exceptions and still breaks on user throws', async function () {
      this.timeout(DEBUG_TEST_MS);
      await withRouter(async (driver) => {
        const fixture = debuggee().fixture;
        await driver.launch(fixture, MODE.libraryCaught, { break_on: 'all', just_my_code: true }, [
          'after-library',
        ]);
        const stop = await driver.stopped(
          1,
          'breakpoint',
          'the library caught its own exception; the first visible stop must be the user breakpoint',
        );
        const threadId = Number(stop.threadId);
        assert.equal((await driver.request('next', { threadId })).success, true);
        await driver.stopped(2, 'step');
        assert.equal(
          (await driver.topStack(threadId)).line,
          fixture.source.dapLine('step-after-library'),
        );
        assert.equal((await driver.request('continue', { threadId })).success, true);
        const userThrow = await driver.stopped(3, 'exception');
        const info = await driver.request('exceptionInfo', { threadId: userThrow.threadId });
        assert.ok(isRecord(info.body));
        assert.equal(info.body.exceptionId, `CLR/${CAUGHT_TYPE}`);
        assert.equal(info.body.breakMode, 'always');
        assert.equal(
          (await driver.request('continue', { threadId: userThrow.threadId })).success,
          true,
        );
        assert.deepEqual((await driver.event('exited')).body, { exitCode: 0 });
      });
    });

    test('break on all permits continuing a deep exception through its library handler', async function () {
      this.timeout(DEBUG_TEST_MS);
      await withRouter(async (driver) => {
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
        await driver.stopped(
          2,
          'breakpoint',
          'continue must execute the library handler and return to our code',
        );
        assert.equal(
          (await driver.request('setExceptionBreakpoints', { filters: [] })).success,
          true,
        );
      });
    });
  });
}
