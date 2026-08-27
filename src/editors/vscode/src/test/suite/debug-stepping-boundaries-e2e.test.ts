// Where stepping meets its boundaries: a breakpoint inside a stepped-over call,
// a step off the end of a method, and a step off the end of the program.
//
// Implements [DEBUG-FEATURES-STEPPING] ("Step over | next | P1", "Step out |
// stepOut | P1") together with [DEBUG-FEATURES-BREAKPOINTS] "Line breakpoints".
//
// These are the cases a stepping implementation gets wrong FIRST, and they are
// invisible to a happy-path suite: a `next` that swallows breakpoints looks
// perfect until a user puts a breakpoint in a helper, and a `next` on the last
// statement of a method is the one place where "step over" must actually pop a
// frame.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  CMD_STEP_OVER,
  assertStopReason,
  assertStoppedAt,
  methodOf,
  stackFrames,
  stepToFrame,
  topFrame,
} from './debug-drive-kit';
import {
  armBreakpoints,
  assertCleanSession,
  assertRanToCompletion,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { BUILD_TIMEOUT_MS } from './run-debug-kit';
import { deepEq, eq, requireAt } from './test-helpers';

suite('Debug stepping — breakpoints inside steps, and stepping off the end', () => {
  const debuggee = useDebuggee('debug-stepedge-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-STEPPING] + [DEBUG-FEATURES-BREAKPOINTS]: a
  // breakpoint outranks a step in progress.
  test('a breakpoint inside a stepped-over call still stops the debuggee', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — one breakpoint on the call, one INSIDE the callee.
    armBreakpoints(fixture, 'main-accumulate', 'add-body');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [first] = await recorder.waitForStops(1);
    assert.ok(first, 'the debuggee must reach the call statement');
    assertStoppedAt(
      await topFrame(session, first.threadId),
      fixture,
      'main-accumulate',
      'Main',
      'the call statement',
    );

    // Interaction 2 — F10 OVER the call. The breakpoint two frames down must win.
    const interrupted = await stepToFrame(recorder, CMD_STEP_OVER);
    assertStopReason(
      interrupted.stop,
      'breakpoint',
      'a breakpoint reached during a step must be reported as a BREAKPOINT stop, not a step',
    );
    assertStoppedAt(
      interrupted.frame,
      fixture,
      'add-body',
      'Add',
      'a step over must not suppress breakpoints in the code it steps over. Swallowing them ' +
        'means a user who sets a breakpoint in a helper can never reach it from a caller they ' +
        'are stepping through',
    );
    const frames = await stackFrames(session, interrupted.stop.threadId);
    deepEq(
      frames.slice(0, 3).map((frame) => methodOf(frame)),
      ['Add', 'Accumulate', 'Main'],
      'the interrupted step must leave the real, deeper stack in place',
    );

    // Interaction 3 — the pending step must be CANCELLED, not resumed. Continue
    // twice: the remaining two calls to Add must each stop.
    const secondHit = await stepToFrame(recorder, CMD_CONTINUE);
    assertStoppedAt(secondHit.frame, fixture, 'add-body', 'Add', 'the second call to Add');
    const thirdHit = await stepToFrame(recorder, CMD_CONTINUE);
    assertStoppedAt(thirdHit.frame, fixture, 'add-body', 'Add', 'the third call to Add');
    eq(recorder.stops().length, 4, 'one call-site stop plus three breakpoint hits inside Add');

    // Interaction 4 — the last continue runs the program out.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a step interrupted by a breakpoint');
    await recorder.waitForOutput('done plain 45');
    eq(recorder.stops().length, 4, 'no fifth stop: the interrupted step must not resume later');
    assertCleanSession(debuggee(), 'a breakpoint inside a stepped-over call');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Step over | next | P1" at a method's
  // last statement, where `next` must pop a frame.
  test('stepping over the last statement of a method returns to the caller', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop on the `return` of the innermost method.
    armBreakpoints(fixture, 'add-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the return statement');
    const deep = await stackFrames(session, stop.threadId);
    eq(methodOf(requireAt(deep, 0, 'the stopped frame')), 'Add', 'the walk starts in Add');

    // Interaction 2 — F10 on `return`: the frame must pop.
    const returned = await stepToFrame(recorder, CMD_STEP_OVER);
    assertStopReason(returned.stop, 'step', 'a step off the end of a method');
    eq(
      methodOf(returned.frame),
      'Accumulate',
      'stepping over the LAST statement of a method executes the return, so the debuggee must ' +
        `come to rest in the CALLER; it came to rest in '${returned.frame.name}'`,
    );
    assertStoppedAt(
      returned.frame,
      fixture,
      'accumulate-call',
      'Accumulate',
      'the caller must be parked on the call statement it is completing',
    );
    eq(
      (await stackFrames(session, returned.stop.threadId)).length,
      deep.length - 1,
      'exactly one frame must have been popped',
    );

    // Interaction 3 — the loop must continue normally afterwards.
    const nextStop = await stepToFrame(recorder, CMD_STEP_OVER);
    assertStoppedAt(
      nextStop.frame,
      fixture,
      'accumulate-loop',
      'Accumulate',
      'the loop header follows the body statement',
    );

    // Interaction 4 — continue: the next breakpoint hit is Add's return again.
    const again = await stepToFrame(recorder, CMD_CONTINUE);
    assertStoppedAt(again.frame, fixture, 'add-return', 'Add', 'the second call to Add');
    assertCleanSession(debuggee(), 'stepping off the end of a method');
  });

  // Implements [DEBUG-FEATURES-STEPPING] at the outermost boundary: stepping off
  // the end of the entry point ends the debuggee.
  test('stepping over the last statement of the program terminates the session', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop on the entry point's `return`.
    armBreakpoints(fixture, 'main-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the final return');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-return',
      'Main',
      'the last statement of the program',
    );
    await recorder.waitForOutput('done plain 45');

    // Interaction 2 — F10 off the end. The process must exit, not hang.
    await vscode.commands.executeCommand(CMD_STEP_OVER);
    await assertRanToCompletion(recorder, 0, 'a step off the end of the program');

    // Interaction 3 — nothing may remain behind.
    eq(
      recorder.stops().length,
      1,
      'stepping past the end of Main must not produce a phantom stop in runtime startup code ' +
        `— that is exactly what justMyCode exists to prevent. Stops: ${recorder
          .stops()
          .map((entry) => entry.reason)
          .join(', ')}`,
    );
    eq(recorder.events('exited').length, 1, 'the debuggee must report its exit exactly once');
    deepEq(recorder.errors, [], 'a program that ran to its end is not a transport failure');
  });
});
