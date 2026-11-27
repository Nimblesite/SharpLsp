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
// The stub is a built F# console app, run through its apphost. That is the one
// executable shape that spawns on every platform under the router's fixed
// argv: the router passes `--interpreter=vscode` and no `shell`, so a `.cmd`
// launcher is refused outright on Windows (EINVAL since the BatBadBut fix) and
// a script host rejects the flag as a bad option. An apphost hands argv to
// `main`, which ignores it.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle".
import * as assert from 'node:assert/strict';
import { SHUTDOWN_DEADLINE_MS } from '../../dap-shutdown';
import { isRecord, type DapMessage } from '../../dap-emulate';
import { DEBUG_SESSION_MS } from './test-timeouts';
import { eq, pollUntilResult, assertContainsAll } from './test-helpers';
import { assertEndedOnce, endsAfterDeadline, withDriver } from './debug-flow-kit';
import {
  BEHAVIOUR,
  EXCEPTION_MESSAGE_RESULT,
  TEST_DEADLINE_MS,
  UNKNOWN_MODULE_DESCRIPTION,
  WAIT_MS,
  type WedgeDriver,
  assertAnswered,
  useStub,
} from './dap-stub-kit';

suite('An adapter that stops answering the request to stop', () => {
  const start = useStub('sharplsp-wedge-');

  test('terminate that is answered but never honoured still ends the session', () =>
    withDriver(start, BEHAVIOUR.wedge, async (driver) => {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq(driver.events('terminated').length, 0, 'nothing has ended the session yet');

      const stop = await driver.request('terminate');
      eq(stop.success, true, 'the adapter ANSWERS terminate — that is the whole trap');
      eq(driver.events('terminated').length, 0, 'answering it is not ending it: none yet');

      await assertEndedOnce(driver, 'the router ended the session exactly once');
      const told = driver.console();
      assertContainsAll(told, ['netcoredbg', 'stop'], 'told');
    }));

  test('disconnect is owed an end on the same deadline as terminate', () =>
    withDriver(start, BEHAVIOUR.wedge, async (driver) => {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('disconnect')).success, true, 'the adapter answers disconnect too');
      eq(driver.events('terminated').length, 0, 'answering disconnect did not end the session');

      await assertEndedOnce(
        driver,
        'the router ended the session after disconnect went unhonoured',
      );
    }));

  test('an adapter that honours the stop is never second-guessed', () =>
    withDriver(start, BEHAVIOUR.honest, async (driver) => {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('terminate')).success, true, 'terminate is answered');
      await assertEndedOnce(driver, "the adapter's own terminated reached the client");

      await endsAfterDeadline(
        driver,
        1,
        'and the deadline, disarmed, added no second one',
        TEST_DEADLINE_MS,
      );
      eq(driver.console(), '', 'nothing was said to the user: nothing went wrong');
    }));

  // VS Code replies to `terminated` with `disconnect` and holds the session
  // until that is answered: a launch made meanwhile found the dead session
  // still active, and a breakpoint edit reached an adapter that refused it.
  test('a disconnect the adapter exits on is answered for it', () =>
    withDriver(start, BEHAVIOUR.vanish, async (driver) => {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('terminate')).success, true, 'terminate is answered');
      eq((await driver.awaitTerminated()).length, 1, "the adapter's own terminated arrived");

      const reply = await driver.request('disconnect');
      eq(reply.success, true, 'a gone adapter IS the disconnected state: the router answers');
      eq(reply.command, 'disconnect', 'the answer is to the disconnect itself');
      eq(driver.events('terminated').length, 1, 'the end was announced once, not again');
      eq(driver.console(), '', 'a session that ended cleanly reports no failure');
    }));

  test('a restart inside the deadline retires it along with the adapter it was owed by', () =>
    withDriver(start, BEHAVIOUR.wedge, async (driver) => {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      await assertAnswered(driver, 'terminate', 'the first adapter answers the stop, then wedges');
      // Stop visibly did nothing, so the user's next click is Restart. The
      // wedged adapter is retired as `replaced` — its death is ordered, never
      // reported — and a fresh one takes over the session.
      eq((await driver.request('restart')).success, true, 'restart is accepted');

      await endsAfterDeadline(
        driver,
        0,
        'the deadline the RETIRED adapter owed did not end the session the restart began',
        TEST_DEADLINE_MS,
      );
      eq(driver.console(), '', 'and the user was not told a replaced adapter stopped answering');
      await assertAnswered(driver, 'threads', 'the restarted adapter is alive and answering');

      // Retired, not disabled: a stop the NEW adapter wedges on is owed its own end.
      await assertAnswered(
        driver,
        'terminate',
        'the restarted adapter answers a stop, then wedges',
      );
      await assertEndedOnce(
        driver,
        'the router ended the session exactly once, on the fresh deadline',
      );
    }));

  test('a request that is not a stop request arms nothing', () =>
    withDriver(start, BEHAVIOUR.wedge, async (driver) => {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('threads')).success, true, 'an ordinary request is answered');
      await endsAfterDeadline(
        driver,
        0,
        'a session nobody asked to stop is never ended',
        TEST_DEADLINE_MS,
      );
    }));

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

// netcoredbg aborts a `threads` request still in flight when the debuggee
// resumes — the router's own `continue` past its injected entry stop, or the
// user's — and answers it "The operation was canceled". The workbench asked for
// that list on its own, so the Call Stack panel logged an error for a list one
// round trip away (#508). Implements [DEBUG-ADAPTER-GAPS].
suite('An adapter that cancels a threads request under a resume', () => {
  const start = useStub('sharplsp-threads-');

  test('the cancelled threads request is asked again and the client gets the list', () =>
    withDriver(start, BEHAVIOUR.cancelThreads, async (driver) => {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');

      // Interaction 1 — the adapter cancels the client's threads request.
      const listed = await driver.request('threads');
      eq(listed.success, true, `the client gets the thread list: ${String(listed.message)}`);
      eq(listed.command, 'threads', 'as the answer to its own threads request');
      eq(
        driver.answers('threads').length,
        1,
        'exactly one answer reached the client, never the cancellation too',
      );

      // Interaction 2 — the adapter answers the next one itself.
      const again = await driver.request('threads');
      eq(again.success, true, 'a threads request the adapter answers is forwarded as it is');
      eq(again.request_seq, Number(listed.request_seq) + 1, 'answering the request that asked');
      eq(driver.events('terminated').length, 0, 'and nothing about this ends the session');
    }));
});

// netcoredbg sometimes cannot evaluate the exception object on a stop: every
// `exceptionInfo` reply then names the type but carries no message and no stack
// ("Exception thrown: 'System.ApplicationException' in <unknown module>"), and
// re-asking never fills it in (#496). The router must recover the message
// another way — `evaluate` of `$exception.Message` in the stopped thread's top
// frame — and splice it into the reply before the client sees it. Implements
// [DEBUG-ADAPTER-GAPS].
suite('An adapter that answers exceptionInfo without the message', () => {
  const start = useStub('sharplsp-exception-');

  /** The reply's `details`, the part of the reply the panel shows. */
  const detailsOf = (message: DapMessage): Record<string, unknown> =>
    isRecord(message.body) && isRecord(message.body.details) ? message.body.details : {};

  /** A router over a stub told to `behave`, once its exception stop reached the client. */
  const stoppedOnException = async (behave: string): Promise<WedgeDriver> => {
    const driver = start(behave);
    eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
    await pollUntilResult(
      async () => driver.events('stopped'),
      (stops) => stops.length === 1,
      WAIT_MS,
      10,
      'the exception stop to reach the client',
    );
    return driver;
  };

  /** The reply's description, the line the panel heads with. */
  const descriptionOf = (message: DapMessage): string =>
    isRecord(message.body) ? String(message.body.description ?? '') : '';

  /** The session keeps serving requests, and nothing ended it. */
  const assertSessionLives = async (driver: WedgeDriver, why: string): Promise<void> => {
    eq((await driver.request('threads')).success, true, `${why}: the session keeps serving`);
    eq(driver.events('terminated').length, 0, `${why}: and nothing ended it`);
  };

  test('the message is recovered from $exception.Message and reaches the client', async () => {
    const driver = await stoppedOnException(BEHAVIOUR.unknownModuleException);
    try {
      // Interaction 1 — the reply the client receives must carry the message.
      const info = await driver.request('exceptionInfo', { threadId: 7 });
      eq(info.success, true, 'exceptionInfo succeeds');
      eq(
        detailsOf(info).message,
        EXCEPTION_MESSAGE_RESULT,
        'details.message was recovered through evaluate',
      );
      assertContainsAll(
        descriptionOf(info),
        [UNKNOWN_MODULE_DESCRIPTION, EXCEPTION_MESSAGE_RESULT],
        'the description, carrying the message too',
      );
      eq(driver.answers('exceptionInfo').length, 1, 'exactly one exceptionInfo answer');

      // Interaction 2 — the session is unaffected by the rescue.
      await assertSessionLives(driver, 'after the rescue');
    } finally {
      driver.dispose();
    }
  });

  test('a fallback that fails forwards the original reply and the session continues', async () => {
    const driver = await stoppedOnException(BEHAVIOUR.unknownModuleExceptionSilent);
    try {
      // Interaction 1 — the original reply arrives unchanged: nothing invented.
      const info = await driver.request('exceptionInfo', { threadId: 7 });
      eq(info.success, true, 'the original reply was forwarded');
      eq(detailsOf(info).message, undefined, 'no message was invented for the panel');
      assertContainsAll(descriptionOf(info), [UNKNOWN_MODULE_DESCRIPTION], 'its description');

      // Interaction 2 — a retried ask behaves the same, and the session lives on.
      const retry = await driver.request('exceptionInfo', { threadId: 7 });
      eq(retry.success, true, 'the retry is answered too');
      eq(driver.answers('exceptionInfo').length, 2, 'one answer per ask, never a duplicate');
      await assertSessionLives(driver, 'after the gap');
    } finally {
      driver.dispose();
    }
  });
});
