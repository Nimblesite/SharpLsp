// Debug Test on a project whose VSTest adapter DECORATES test names (issue #233).
//
// xUnit's 2.2.0 adapter — pinned by FluentValidation, where #233 was reported —
// appends each test's unique ID to the name it reports. Taken verbatim, that id
// made the Debug profile's `--filter` match NO test: the host waited under
// `VSTEST_HOST_DEBUG=1`, SharpLsp attached, and the host then ran zero tests and
// exited. The user's breakpoint was never reached, and from their side "Debug
// Test did nothing". Every other debug suite pins a modern adapter that reports
// bare names, which is why none of them could see it.
//
// This suite presses Debug on that adapter and requires the stop, the test's
// own frame, and a clean finish. Implements [DEBUG-FEATURES-TESTS].
import * as vscode from 'vscode';
import { CMD_CONTINUE, gesture, methodOf, topFrame } from './debug-drive-kit';
import {
  CS_ADDS,
  CS_ALL,
  CS_SOURCE,
  assertOneTestSession,
  breakpointAt,
  requireActive,
} from './debug-test-kit';
import {
  debugRun,
  debuggableRow,
  firstBreakpointStop,
  useDebugTestFixture,
} from './debug-test-harness';
import { comparablePath, deepEq, eq } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS } from './test-timeouts';

suite('Debug Test — an adapter that decorates test names still stops on the breakpoint', () => {
  const harness = useDebugTestFixture('debug-decorated-', 'csharp', 'vstest-decorating');

  test('Debug attaches to the host, stops in the selected test, and ends cleanly', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder, sessions, stubs } = harness();

    // Interaction 1 — the row the user presses Debug on is the BARE test, not
    // the adapter's `Name (d87517d9…)`: that id is what the filter substitutes.
    const item = await debuggableRow(fixture, CS_ALL, CS_ADDS);
    eq(item.id, CS_ADDS, 'the row is identified by the bare fully-qualified name');
    eq(item.label, 'Adds_Two_Numbers', 'and labelled with its method, never a hex suffix');

    // Interaction 2 — arm a breakpoint in the test body and press Debug. The
    // session must ATTACH to the waiting test host.
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed')]);
    await debugRun([item]);
    const session = assertOneTestSession(sessions, 'debugging a test the adapter decorated');
    eq(session.configuration['request'], 'attach', 'the session attaches to the waiting host');

    // Interaction 3 — the breakpoint binds and the first stop is ON it, in the
    // selected test's own frame: the host really ran the test the user chose.
    const stop = await firstBreakpointStop(recorder, CS_SOURCE, 'adds-seed');
    const frame = await topFrame(requireActive('a stop in a decorated test'), stop.threadId);
    eq(methodOf(frame), 'Adds_Two_Numbers', 'stopped in the test the user selected');
    eq(frame.line, CS_SOURCE.dapLine('adds-seed'), 'on the armed line');
    eq(
      comparablePath(frame.sourcePath),
      comparablePath(fixture.sourceFile),
      'in the fixture source the user armed it in',
    );

    // Interaction 4 — continuing runs the test to the end and the session ends
    // on its own, with nothing reported to the user as a failure.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(recorder.stops().length, 1, 'one stop, the armed one: nothing else halted the host');
    deepEq(recorder.errors, [], 'no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and no SharpLsp error the user has to read');
  });
});
