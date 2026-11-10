// Implements [CONFIG-DEBUG-EXCEPTIONS], [DEBUG-FEATURES-STEPPING].
import * as assert from 'node:assert/strict';
import { isRecord } from '../../dap-emulate';
import { MODE, CAUGHT_TYPE, type DebugFixture } from './debug-fixture-programs';
import { useDebuggee, debugTest } from './debug-suite-kit';
import { withRouter, type LiveRouter } from './debug-router-kit';

/** Launch the library-caught fixture under Just My Code, optionally arming `anchor`. */
async function launchJmc(
  driver: LiveRouter,
  fixture: DebugFixture,
  justMyCode: boolean,
  anchor?: string,
): Promise<void> {
  await driver.launch(
    fixture,
    MODE.libraryCaught,
    { break_on: 'all', just_my_code: justMyCode },
    anchor === undefined ? [] : [anchor],
  );
}

/** Stop on the first-chance exception and read its `exceptionInfo` body. */
async function exceptionStopInfo(
  driver: LiveRouter,
): Promise<{ threadId: number; body: Record<string, unknown> }> {
  const threadId = await driver.exceptionStop();
  const info = await driver.request('exceptionInfo', { threadId });
  assert.ok(isRecord(info.body));
  return { threadId, body: info.body };
}

/** Assert `threadId`'s top frame is on the fixture's DAP line for `anchor`. */
async function assertTopLine(
  driver: LiveRouter,
  threadId: number,
  fixture: DebugFixture,
  anchor: string,
): Promise<void> {
  assert.equal((await driver.topStack(threadId)).line, fixture.source.dapLine(anchor));
}

/** Step once, then assert the step landed on the fixture's DAP line for `anchor`. */
async function assertStepLandsOn(
  driver: LiveRouter,
  threadId: number,
  fixture: DebugFixture,
  anchor: string,
): Promise<void> {
  await driver.stopped(2, 'step');
  await assertTopLine(driver, threadId, fixture, anchor);
}

/** Send `command`, then assert the next stop carries `reason` with `why`. */
async function assertRequestThenStop(
  driver: LiveRouter,
  threadId: number,
  command: 'next' | 'continue',
  reason: string,
  why: string,
): Promise<void> {
  assert.equal((await driver.request(command, { threadId })).success, true);
  await driver.stopped(2, reason, why);
}

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`Just My Code exceptions on ${language}`, () => {
    const debuggee = useDebuggee(`debug-jmc-${language}-`, language);

    debugTest(
      'F10 at a deep first-chance exception executes its handler and returns to user code',
      debuggee,
      async () => {
        await withRouter(async (driver) => {
          const fixture = debuggee().fixture;
          await launchJmc(driver, fixture, false);
          const { threadId, body } = await exceptionStopInfo(driver);
          assert.equal(body.breakMode, 'always');
          assert.match(String(body.description), /library-internal/);
          const response = await driver.request('next', { threadId });
          assert.equal(response.success, true, String(response.message));
          await assertStepLandsOn(driver, threadId, fixture, 'after-library');
        });
      },
    );

    debugTest(
      'F10 across a library-handled exception stops on the next user statement',
      debuggee,
      async () => {
        await withRouter(async (driver) => {
          const fixture = debuggee().fixture;
          await launchJmc(driver, fixture, true, 'before-library');
          const stopped = await driver.stopped(1, 'breakpoint');
          const threadId = Number(stopped.threadId);
          await assertRequestThenStop(
            driver,
            threadId,
            'next',
            'step',
            'ignoring the library throw must preserve the pending F10',
          );
          await assertTopLine(driver, threadId, fixture, 'after-library');
        });
      },
    );

    debugTest(
      'Just My Code skips library-handled exceptions and still breaks on user throws',
      debuggee,
      async () => {
        await withRouter(async (driver) => {
          const fixture = debuggee().fixture;
          await launchJmc(driver, fixture, true, 'after-library');
          const stop = await driver.stopped(
            1,
            'breakpoint',
            'the library caught its own exception; the first visible stop must be the user breakpoint',
          );
          const threadId = Number(stop.threadId);
          assert.equal((await driver.request('next', { threadId })).success, true);
          await assertStepLandsOn(driver, threadId, fixture, 'step-after-library');
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
      },
    );

    debugTest(
      'break on all permits continuing a deep exception through its library handler',
      debuggee,
      async () => {
        await withRouter(async (driver) => {
          await launchJmc(driver, debuggee().fixture, false, 'after-library');
          const { threadId, body } = await exceptionStopInfo(driver);
          assert.equal(
            body.breakMode,
            'always',
            'this exception has a handler; it is not a terminal crash',
          );
          assert.match(String(body.description), /library-internal/);
          await assertRequestThenStop(
            driver,
            threadId,
            'continue',
            'breakpoint',
            'continue must execute the library handler and return to our code',
          );
          assert.equal(
            (await driver.request('setExceptionBreakpoints', { filters: [] })).success,
            true,
          );
        });
      },
    );
  });
}
