// Debugging an EXPECTO test through the Test Explorer's Debug profile.
//
// "Expecto/FsCheck test debugging | P1 (F# parity)" is a row of
// [DEBUG-FEATURES-TESTS]. An Expecto test is a VALUE: its body is a lambda
// inside `testList` / `testCase`, its id is a dotted path of list names with
// spaces, and the VSTest host that runs it is YoloDev.Expecto.TestSdk's. A
// breakpoint must bind inside that lambda and the debugger must stop there with
// the F# locals readable, exactly as it does in an xUnit [<Fact>].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { assertSessionEnded, type DapRecorder } from './debug-dap-kit';
import { CMD_CONTINUE, evaluate, gesture, localsOf, variableNamed } from './debug-drive-kit';
import {
  armAnchoredBreakpoints,
  debugRunOneSession,
  debuggableRow,
  stopInTestSource,
  useDebugTestFixture,
} from './debug-test-harness';
import { assertHandshakeOrder, type TestDebugFixture } from './debug-test-kit';
import { EXPECTO_ALL, EXPECTO_NESTED, EXPECTO_PASSING, EXPECTO_SOURCE } from './expecto-fixture';
import { DebugSessionRecorder } from './run-debug-kit';
import { deepEq, eq, neq } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS } from './test-timeouts';
import { type UiStubs } from './ui-stubs';

suite('Debug an Expecto test — a breakpoint inside a testCase lambda', () => {
  let fixture: TestDebugFixture;
  let recorder: DapRecorder;
  let sessions: DebugSessionRecorder;
  let stubs: UiStubs;

  const harness = useDebugTestFixture('debug-testex-', 'fsharp', 'expecto');
  setup(() => {
    ({ fixture, recorder, sessions, stubs } = harness());
  });

  test('a breakpoint in an Expecto testCase stops there with its F# locals readable', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the row: a dotted list path with spaces, as a leaf.
    const item = await debuggableRow(fixture, EXPECTO_ALL, EXPECTO_PASSING);
    eq(item.id, EXPECTO_PASSING, 'the tree carries the Expecto path verbatim as the id');
    assert.ok(item.id.includes(' '), 'and that path really does contain spaces');
    eq(item.children.size, 0, 'an Expecto testCase is a LEAF the Debug button applies to');

    // Interaction 2 — arm a breakpoint inside the lambda and debug the case.
    armAnchoredBreakpoints(
      EXPECTO_SOURCE,
      fixture.sourceUri,
      ['ex-call'],
      'one breakpoint armed inside the Expecto testCase',
    );
    await debugRunOneSession([item], sessions, 'debugging an Expecto test');
    assertHandshakeOrder(recorder, 'debugging an Expecto test');

    // Interaction 3 — it stops IN the lambda, in the fixture's own source.
    const { stop, active, frame } = await stopInTestSource(
      recorder,
      fixture,
      EXPECTO_SOURCE,
      'ex-call',
    );
    neq(stop.hitBreakpointIds.length, 0, 'naming the breakpoint it hit');
    eq(
      variableNamed(await localsOf(active, frame.id), 'seed').value,
      '20',
      "the lambda's `let` binding is a local the debugger can read",
    );
    eq(
      (await evaluate(active, 'seed + 1', frame.id, 'watch')).value,
      '21',
      'and the watch window evaluates in the Expecto frame',
    );

    // Interaction 4 — continue: the case finishes and the session ends cleanly.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    deepEq(stubs.log.errorMessages, [], 'a working Expecto debug run reports no error');
    eq(recorder.stops().length, 1, 'exactly one stop: the breakpoint the user armed');
    eq(recorder.events('terminated').length, 1, 'and exactly one termination');
    eq(sessions.ours.length, 1, 'one Expecto case, one session');
    eq(vscode.debug.breakpoints.length, 1, 'the breakpoint survives the session ending');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(recorder.exits, [], 'and no adapter process exiting under the session');
  });

  test('debugging a nested Expecto case with no breakpoint runs it to the end', async function () {
    this.timeout(DEBUG_TEST_MS);
    const item = await debuggableRow(fixture, EXPECTO_ALL, EXPECTO_NESTED);
    eq(item.id, EXPECTO_NESTED, 'a case two lists deep keeps its whole path');
    eq(vscode.debug.breakpoints.length, 0, 'the premise: nothing is armed');
    await debugRunOneSession([item], sessions, 'debugging a nested Expecto case');
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(recorder.stops().length, 0, 'with nothing armed, the debuggee never stops');
    eq(sessions.ours.length, 1, 'yet a real session attached and ran it');
    deepEq(stubs.log.errorMessages, [], 'and nothing was reported as an error');
    assertSessionEnded(recorder, 'the nested Expecto case');
  });
});
