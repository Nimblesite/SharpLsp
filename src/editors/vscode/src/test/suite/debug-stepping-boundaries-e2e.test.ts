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
  CMD_RUN_TO_CURSOR,
  CMD_STEP_INTO,
  CMD_STEP_OUT,
  CMD_STEP_OVER,
  assertFrameSource,
  assertStopReason,
  assertStoppedAt,
  focusAnchor,
  localsOf,
  methodOf,
  stackFrames,
  stepToFrame,
  topFrame,
  trace,
  variableNamed,
  walk,
} from './debug-drive-kit';
import {
  armBreakpoints,
  assertCleanSession,
  assertRanToCompletion,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { comparablePath, deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

suite('Debug stepping — breakpoints inside steps, and stepping off the end', () => {
  const debuggee = useDebuggee('debug-stepedge-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-STEPPING] + [DEBUG-FEATURES-BREAKPOINTS]: a
  // breakpoint outranks a step in progress.
  test('a breakpoint inside a stepped-over call still stops the debuggee', async function () {
    this.timeout(DEBUG_TEST_MS);
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
    this.timeout(DEBUG_TEST_MS);
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
    this.timeout(DEBUG_TEST_MS);
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

  // Implements [DEBUG-FEATURES-STEPPING] "Step into | stepIn | P1" and
  // "Step out | stepOut | P1" as the PAIR they are: whatever a step into
  // pushes, the matching step out must pop, and nothing else.
  test('a step into pushes exactly one frame and the matching step out pops it', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 - stop on the call statement inside the loop.
    armBreakpoints(fixture, 'accumulate-call');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the call inside the loop');
    assertStopReason(stop, 'breakpoint', 'the call statement');
    const before = await stackFrames(session, stop.threadId);
    assertStoppedAt(
      requireAt(before, 0, 'the stopped frame'),
      fixture,
      'accumulate-call',
      'Accumulate',
      'the call statement inside the loop',
    );
    eq(
      trace(before).includes('Main@' + String(fixture.source.dapLine('main-accumulate'))),
      true,
      'and Main is parked on the call that reached it',
    );

    // Interaction 2 - F11 INTO the callee. One frame deeper, in the user's own
    // helper, with the arguments the caller passed.
    const into = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStopReason(into.stop, 'step', 'a step into a called method');
    assertStoppedAt(into.frame, fixture, 'add-body', 'Add', 'a step into');
    const inside = await stackFrames(session, into.stop.threadId);
    eq(
      inside.length,
      before.length + 1,
      'a step INTO pushes exactly ONE frame; more means it entered runtime machinery, ' +
        'which is what justMyCode exists to prevent',
    );
    eq(
      methodOf(requireAt(inside, 1, 'the caller frame')),
      'Accumulate',
      'and the caller sits directly beneath it',
    );
    const locals = await localsOf(session, into.frame.id);
    eq(variableNamed(locals, 'left').value, '2', 'called with the seed the loop is carrying');
    eq(variableNamed(locals, 'right').value, '1', 'and the first loop index');

    // Interaction 3 - Shift+F11 OUT. Back in the caller, exactly one frame
    // shallower, on or past the statement that made the call.
    const out = await stepToFrame(recorder, CMD_STEP_OUT);
    assertStopReason(out.stop, 'step', 'a step out of a called method');
    eq(methodOf(out.frame), 'Accumulate', 'a step out returns to the CALLER');
    assertFrameSource(out.frame, fixture, 'a step out of a helper');
    eq(
      (await stackFrames(session, out.stop.threadId)).length,
      before.length,
      'popping exactly the frame the step into pushed, and no more',
    );
    eq(
      out.frame.line >= fixture.source.dapLine('accumulate-call'),
      true,
      'at or past the call it returned from, never before it',
    );
    eq(recorder.stops().length, 3, 'three stops: the breakpoint, the step in, the step out');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    assertCleanSession(debuggee(), 'a step into paired with a step out');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Step into | stepIn | P1" at its
  // quietest boundary: a line with nothing to step INTO. F11 there must behave
  // as F10, not stall and not dive into the runtime.
  test('a step into a line with no call behaves exactly as a step over', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 - stop on a plain assignment: no call on the line.
    armBreakpoints(fixture, 'accumulate-entry');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the assignment');
    const before = await stackFrames(session, stop.threadId);
    assertStoppedAt(
      requireAt(before, 0, 'the stopped frame'),
      fixture,
      'accumulate-entry',
      'Accumulate',
      'a statement with no call in it',
    );
    eq(
      fixture.source.code('accumulate-entry').includes('('),
      false,
      'the fixture line really does contain no call for a step into to enter',
    );

    // Interaction 2 - F11. Same method, same depth, next statement.
    const stepped = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStopReason(stepped.stop, 'step', 'a step into a call-free line');
    eq(methodOf(stepped.frame), 'Accumulate', 'F11 on a call-free line stays in the method');
    assertStoppedAt(
      stepped.frame,
      fixture,
      'accumulate-loop',
      'Accumulate',
      'a step into with nothing to enter advances one statement, exactly as a step over',
    );
    eq(
      (await stackFrames(session, stepped.stop.threadId)).length,
      before.length,
      'and pushes NO frame - a stall here is the F11 that appears to do nothing',
    );

    // Interaction 3 - two more F11s from the loop header do reach the call, and
    // the third really does enter the helper. The boundary is about the LINE,
    // never about the gesture being broken.
    const further = await walk(recorder, [CMD_STEP_INTO, CMD_STEP_INTO]);
    eq(further.frames.length, 2, 'both gestures landed somewhere');
    eq(
      further.frames.every((frame) => {
        return comparablePath(frame.sourcePath) === comparablePath(fixture.sourceFile);
      }),
      true,
      'every landing is in the user own file - Just My Code, [DEBUG-FEATURES-STEPPING] P1',
    );
    const last = requireAt(further.frames, 1, 'the second further step');
    eq(
      ['Accumulate', 'Add'].includes(methodOf(last)),
      true,
      'walking on from the loop header reaches the call and then the callee, and nothing else',
    );
    deepEq(
      further.stops.map((entry) => entry.reason),
      ['step', 'step'],
      'each one reported as a STEP, never as a breakpoint the user never set',
    );
    assertCleanSession(debuggee(), 'a step into a call-free line');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Run to cursor (temporary breakpoint) |
  // goto | P2" and [DEBUG-PROTOCOL-CAPABILITIES] `supportsGotoTargetsRequest`,
  // which is a Phase 4 "Yes".
  test('run to cursor stops at the caret and leaves no breakpoint behind', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 - stop early, so there is a running session for the
    // editor-scoped gesture to act on.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the first statement of Main');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-mode',
      'Main',
      'the first statement of the program',
    );
    eq(vscode.debug.breakpoints.length, 1, 'exactly one breakpoint is in the Breakpoints view');
    eq(
      recorder.capabilities()['supportsGotoTargetsRequest'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] makes supportsGotoTargetsRequest a Phase 4 Yes, and it ' +
        'is what run-to-cursor is specified to use',
    );

    // Interaction 2 - put the caret much further down Main and run to it. The
    // statements in between must EXECUTE, not be skipped.
    const editor = await focusAnchor(fixture, 'main-print');
    eq(
      editor.selection.active.line,
      fixture.source.line('main-print'),
      'the caret sits on the statement the user wants to reach',
    );
    const reached = await stepToFrame(recorder, CMD_RUN_TO_CURSOR);
    assertStoppedAt(
      reached.frame,
      fixture,
      'main-print',
      'Main',
      'run to cursor must come to rest on the line under the caret',
    );
    eq(
      recorder.outputText().includes('env='),
      true,
      'and the statements between the two points really ran on the way',
    );

    // Interaction 3 - the temporary breakpoint must be TEMPORARY. One left in
    // the view is one the user never set and cannot explain; one left armed on
    // the adapter stops the program again on the next pass.
    eq(
      vscode.debug.breakpoints.length,
      1,
      'run to cursor must not add an entry to the Breakpoints view',
    );
    deepEq(
      vscode.debug.breakpoints
        .filter((breakpoint): breakpoint is vscode.SourceBreakpoint => {
          return breakpoint instanceof vscode.SourceBreakpoint;
        })
        .map((breakpoint) => breakpoint.location.range.start.line),
      [fixture.source.line('main-mode')],
      'the only breakpoint left is the one the user armed themselves',
    );
    const stopsSoFar = recorder.stops().length;
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session after a run to cursor');
    eq(
      recorder.stops().length,
      stopsSoFar,
      'the temporary breakpoint must not fire a second time on the way out',
    );
    assertCleanSession(debuggee(), 'run to cursor');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Just My Code (skip non-user code) |
  // launch config | P1". A single step that lands in framework source is a
  // debugger that has lost the user inside code they did not write.
  test('a long walk of steps never comes to rest outside the user own source', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 - stop at the top of Main with Just My Code explicitly on.
    armBreakpoints(fixture, 'main-accumulate');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain, justMyCode: true });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the call in Main');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-accumulate',
      'Main',
      'the walk start',
    );
    deepEq(recorder.errors, [], 'a launch with justMyCode on is not a transport failure');

    // Interaction 2 - eight steps, mixing every gesture. Each must land in the
    // fixture file, in a method the fixture declares.
    const gestures = [
      CMD_STEP_INTO,
      CMD_STEP_OVER,
      CMD_STEP_INTO,
      CMD_STEP_OVER,
      CMD_STEP_OUT,
      CMD_STEP_OVER,
      CMD_STEP_OVER,
      CMD_STEP_INTO,
    ];
    const walked = await walk(recorder, gestures);
    eq(walked.frames.length, gestures.length, 'every gesture came to rest somewhere');
    const declared = ['Main', 'Accumulate', 'Add'];
    for (const frame of walked.frames) {
      eq(
        comparablePath(frame.sourcePath),
        comparablePath(fixture.sourceFile),
        'a step came to rest in ' + frame.name + ', which is not the user own file',
      );
      eq(
        declared.includes(methodOf(frame)),
        true,
        methodOf(frame) + ' is not a method this fixture declares',
      );
      eq(frame.line > 0, true, 'every landing carries a 1-based line the editor can point at');
      neq(frame.id, undefined, 'and a frame id its locals can be read from');
    }

    // Interaction 3 - every one of them was reported as a STEP, and the session
    // still runs out cleanly afterwards.
    deepEq(
      [...new Set(walked.stops.map((entry) => entry.reason))],
      ['step'],
      'a walk with no breakpoint armed ahead of it produces step stops and nothing else',
    );
    eq(
      walked.stops.every((entry) => entry.threadId !== 0),
      true,
      'each naming the thread it stopped',
    );
    eq(
      recorder.stops().length,
      gestures.length + 1,
      'exactly the breakpoint plus one stop per gesture - no phantom stop in runtime startup',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session walked through with Just My Code on');
    assertCleanSession(debuggee(), 'a long Just My Code walk');
  });
});
