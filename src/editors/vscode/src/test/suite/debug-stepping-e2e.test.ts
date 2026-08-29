// Step over, step into, step out, continue and run-to-cursor, against a live
// netcoredbg session on a real, built C# assembly.
//
// Implements [DEBUG-FEATURES-STEPPING]. Every row of that table with priority P1
// is driven here: `next`, `stepIn`, `stepOut` and Just My Code. Run to cursor
// (P2, `goto`) is driven too, because it is the gesture users reach for most
// after F10.
//
// Related: [DEBUG-FEATURES-BREAKPOINTS] (the stop that starts every walk),
// [DEBUG-FEATURES-STACK] (what `stackTrace` must report at each stop),
// [DEBUG-PROTOCOL-CAPABILITIES] (which requests the adapter claims to serve).
//
// The assertions are about LINES and FRAME DEPTH, because that is what stepping
// IS. Asserting only "a stopped event arrived" would pass for an adapter that
// answers every step by stopping in the same place forever.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  CMD_STEP_INTO,
  CMD_STEP_OUT,
  CMD_STEP_OVER,
  activeSession,
  assertStopReason,
  assertStoppedAt,
  at,
  focusAnchor,
  methodOf,
  openFixture,
  stackFrames,
  stepToFrame,
  topFrame,
  trace,
  walk,
} from './debug-drive-kit';
import {
  armBreakpoints,
  assertBreakpointsBound,
  assertCleanSession,
  assertRanToCompletion,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS } from './test-timeouts';

/** The framework directory a Just-My-Code step must never surface. */
const FRAMEWORK_HINTS: readonly string[] = ['Microsoft.NETCore.App', 'System.Private.CoreLib'];

suite('Debug stepping — F10 / F11 / Shift+F11 over a live session', () => {
  const debuggee = useDebuggee('debug-step-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-STEPPING] "Step over | next | P1".
  test('F10 walks statement by statement and never enters the callee', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder, sessions } = debuggee();

    // Interaction 1 — arm one breakpoint on the call statement and open the file.
    armBreakpoints(fixture, 'main-accumulate');
    const editor = await openFixture(fixture);
    eq(vscode.debug.breakpoints.length, 1, 'exactly one breakpoint is armed');
    const armed = requireAt(vscode.debug.breakpoints, 0, 'the armed breakpoint');
    eq(armed instanceof vscode.SourceBreakpoint, true, 'a line breakpoint is a SourceBreakpoint');
    eq(armed.enabled, true, 'an armed breakpoint is enabled');
    eq(armed.condition, undefined, 'an unconditional breakpoint carries no condition');
    eq(armed.hitCondition, undefined, 'and no hit condition');
    eq(armed.logMessage, undefined, 'and no log message — this one must PAUSE');
    eq(editor.document.languageId, 'csharp', 'the debuggee source opened as C#');

    // Interaction 2 — F5. The session must reach the breakpoint.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    eq(session.configuration['justMyCode'], true, 'justMyCode defaults on for a launch');
    eq(sessions.ours.length, 1, 'one gesture starts exactly one session');
    const [first] = await recorder.waitForStops(1);
    assert.ok(first, 'the debuggee must stop at the armed breakpoint');
    assertStopReason(first, 'breakpoint', 'a line breakpoint stop');
    neq(first.hitBreakpointIds.length, 0, 'a breakpoint stop must name the breakpoint it hit');
    assertBreakpointsBound(recorder, fixture, ['main-accumulate'], 'the armed line');
    const entry = await topFrame(activeSession(), first.threadId);
    assertStoppedAt(entry, fixture, 'main-accumulate', 'Main', 'the first stop');

    // Interaction 3 — F10 three times. The callee must never appear.
    const stepped = await walk(recorder, [CMD_STEP_OVER, CMD_STEP_OVER, CMD_STEP_OVER]);
    deepEq(
      trace(stepped.frames),
      [
        at(fixture, 'Main', 'main-box'),
        at(fixture, 'Main', 'main-print'),
        at(fixture, 'Main', 'main-inspect'),
      ],
      'F10 must advance ONE statement per press and stay in Main — landing inside ' +
        'Accumulate, Box..ctor or Inspect means `next` was serviced as `stepIn`',
    );
    deepEq(
      stepped.stops.map((stop) => stop.reason),
      ['step', 'step', 'step'],
      'every F10 stop must report the DAP reason `step`, never `breakpoint`',
    );
    deepEq(
      stepped.frames.map((frame) => methodOf(frame)),
      ['Main', 'Main', 'Main'],
      'stepping OVER keeps the frame; a changed frame is a step INTO',
    );

    // Interaction 4 — the wire must show the right request, aimed at the thread.
    const nexts = recorder.requests('next');
    eq(nexts.length, 3, 'three F10 presses must produce exactly three DAP `next` requests');
    deepEq(
      nexts.map((request) => Number(request.args['threadId'])),
      [first.threadId, first.threadId, first.threadId],
      'each `next` must target the stopped thread',
    );
    deepEq(recorder.requests('stepIn'), [], 'F10 must never send `stepIn`');
    deepEq(recorder.requests('stepOut'), [], 'and never `stepOut`');
    deepEq(recorder.events('exception').length, 0, 'a clean walk raises no exception event');
    assertCleanSession(debuggee(), 'three F10 presses');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Step into | stepIn | P1" and
  // "Step out | stepOut | P1", plus [DEBUG-FEATURES-STACK] frame ordering.
  test('F11 descends into the callee and Shift+F11 climbs back out', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop on the call statement in Main.
    armBreakpoints(fixture, 'main-accumulate');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint');
    const session = activeSession();
    const before = await stackFrames(session, stop.threadId);
    eq(methodOf(requireAt(before, 0, 'the stopped frame')), 'Main', 'the walk starts in Main');

    // Interaction 2 — F11 into Accumulate. The stack must grow by exactly one.
    const intoAccumulate = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStopReason(intoAccumulate.stop, 'step', 'a step-into stop');
    assertStoppedAt(intoAccumulate.frame, fixture, 'accumulate-entry', 'Accumulate', 'F11 once');
    const inAccumulate = await stackFrames(session, intoAccumulate.stop.threadId);
    eq(
      inAccumulate.length,
      before.length + 1,
      'stepping INTO pushes exactly one frame; an unchanged depth means the adapter stepped over',
    );
    eq(
      methodOf(requireAt(inAccumulate, 1, 'the caller frame')),
      'Main',
      'the caller is still Main',
    );
    eq(
      requireAt(inAccumulate, 1, 'the caller frame').line,
      fixture.source.dapLine('main-accumulate'),
      'the caller frame must still be parked on the call statement',
    );

    // Interaction 3 — F10 twice to reach the call inside the loop.
    const toCall = await walk(recorder, [CMD_STEP_OVER, CMD_STEP_OVER]);
    deepEq(
      trace(toCall.frames),
      [at(fixture, 'Accumulate', 'accumulate-loop'), at(fixture, 'Accumulate', 'accumulate-call')],
      'F10 inside a for-loop visits the loop header, then the body statement',
    );

    // Interaction 4 — F11 into Add: three user frames, innermost first.
    const intoAdd = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStoppedAt(intoAdd.frame, fixture, 'add-body', 'Add', 'F11 into the innermost callee');
    const deep = await stackFrames(session, intoAdd.stop.threadId);
    deepEq(
      deep.slice(0, 3).map((frame) => methodOf(frame)),
      ['Add', 'Accumulate', 'Main'],
      '[DEBUG-FEATURES-STACK]: `stackTrace` reports physical frames innermost-first',
    );
    deepEq(
      deep.slice(0, 3).map((frame) => frame.line),
      [
        fixture.source.dapLine('add-body'),
        fixture.source.dapLine('accumulate-call'),
        fixture.source.dapLine('main-accumulate'),
      ],
      'every frame must be parked on the statement that is executing in it',
    );

    // Interaction 5 — Shift+F11 back to Accumulate, then to Main.
    const outToAccumulate = await stepToFrame(recorder, CMD_STEP_OUT);
    assertStopReason(outToAccumulate.stop, 'step', 'a step-out stop');
    assertStoppedAt(outToAccumulate.frame, fixture, 'accumulate-call', 'Accumulate', 'Shift+F11');
    eq(
      (await stackFrames(session, outToAccumulate.stop.threadId)).length,
      deep.length - 1,
      'stepping OUT pops exactly one frame',
    );
    const outToMain = await stepToFrame(recorder, CMD_STEP_OUT);
    assertStoppedAt(outToMain.frame, fixture, 'main-accumulate', 'Main', 'Shift+F11 twice');
    eq(
      (await stackFrames(session, outToMain.stop.threadId)).length,
      before.length,
      'two step-outs from Add must return the stack to the depth the walk started at',
    );

    // Interaction 6 — the wire agrees with the gestures.
    eq(recorder.requests('stepIn').length, 2, 'two F11 presses, two `stepIn` requests');
    eq(recorder.requests('stepOut').length, 2, 'two Shift+F11 presses, two `stepOut` requests');
    eq(recorder.requests('next').length, 2, 'and exactly two `next` requests');
    assertCleanSession(debuggee(), 'a six-gesture walk');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Just My Code (skip non-user code) | P1".
  test('Just My Code refuses to step into framework code', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop on a statement whose only call is Console.WriteLine.
    armBreakpoints(fixture, 'main-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain, justMyCode: true });
    eq(session.configuration['justMyCode'], true, 'the launch requested Just My Code');
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the print statement');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-print',
      'Main',
      'the print statement',
    );

    // Interaction 2 — F11. With Just My Code on, this is a step OVER.
    const stepped = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStoppedAt(
      stepped.frame,
      fixture,
      'main-inspect',
      'Main',
      'F11 on a framework call under justMyCode must behave as a step over, not open ' +
        'System.Console decompiled or a "source not available" tab',
    );
    for (const hint of FRAMEWORK_HINTS) {
      eq(
        stepped.frame.sourcePath.includes(hint),
        false,
        `Just My Code must never land the user in ${hint}`,
      );
    }

    // Interaction 3 — the whole stack must still be user code.
    const frames = await stackFrames(session, stepped.stop.threadId);
    deepEq(
      frames.filter((frame) => FRAMEWORK_HINTS.some((hint) => frame.sourcePath.includes(hint))),
      [],
      'no frame in a Just-My-Code stack may be attributed to framework source',
    );
    eq(methodOf(requireAt(frames, 0, 'the stopped frame')), 'Main', 'still in user code');

    // Interaction 4 — F11 into the user method on the next statement DOES descend.
    const intoInspect = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStoppedAt(
      intoInspect.frame,
      fixture,
      'inspect-list',
      'Inspect',
      'Just My Code skips framework code but must never block a step into USER code',
    );
    assertCleanSession(debuggee(), 'a Just-My-Code walk');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Run to cursor (temporary breakpoint) | goto | P2".
  test('Run to cursor stops at the caret and leaves no breakpoint behind', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — reach the first breakpoint, well before the target.
    armBreakpoints(fixture, 'main-accumulate');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint');
    eq(vscode.debug.breakpoints.length, 1, 'one real breakpoint exists before the gesture');

    // Interaction 2 — the adapter must actually claim the capability the spec
    // maps this gesture onto.
    eq(
      recorder.capabilities()['supportsGotoTargetsRequest'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsGotoTargetsRequest as Yes in Phase 4 — ' +
        'it is the row that carries "Run to cursor via goto"',
    );

    // Interaction 3 — put the caret deep inside a callee and run to it. The
    // workbench gesture resolves its target editor from UI FOCUS, which a
    // headless host never grants; `gotoTargets` + `goto` are the exact DAP
    // requests the gesture issues once focused, so they are driven directly.
    await focusAnchor(fixture, 'inspect-return');
    const baseline = recorder.stops().length;
    const caret = fixture.source.dapLine('inspect-return');
    const targets = await session.customRequest('gotoTargets', {
      source: { path: fixture.uri.fsPath },
      line: caret,
    });
    const target = Array.isArray(targets?.targets) ? targets.targets[0] : undefined;
    assert.ok(target, 'the adapter must synthesize a target for the caret line');
    await session.customRequest('goto', {
      threadId: stop.threadId,
      targetId: target.id,
    });
    const stops = await recorder.waitForStops(baseline + 1);
    const landed = requireAt(stops, stops.length - 1, 'the run-to-cursor stop');
    neq(landed.reason, 'exception', 'run to cursor must not be reported as an exception stop');
    assertStoppedAt(
      await topFrame(session, landed.threadId),
      fixture,
      'inspect-return',
      'Inspect',
      'run to cursor must stop exactly where the caret is, inside the callee',
    );

    // Interaction 4 — the temporary breakpoint must not have been persisted.
    deepEq(
      vscode.debug.breakpoints.map((breakpoint) =>
        breakpoint instanceof vscode.SourceBreakpoint ? breakpoint.location.range.start.line : -1,
      ),
      [fixture.source.line('main-accumulate')],
      'run to cursor uses a TEMPORARY breakpoint; leaving it in the Breakpoints view is a ' +
        'stale stop the user never asked for',
    );

    // Interaction 5 — continue out; the program completes normally.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a run-to-cursor session resumed to the end');
    await recorder.waitForOutput('done plain 45');
    assertCleanSession(debuggee(), 'run to cursor then continue');
  });

  // Implements [DEBUG-FEATURES-STEPPING] with [DEBUG-FEATURES-BREAKPOINTS]:
  // continue is the gesture that ties a sequence of breakpoints together.
  test('Continue walks breakpoint to breakpoint and the last one runs the program out', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — three breakpoints in source order.
    const anchors = ['main-accumulate', 'main-inspect', 'main-done'];
    armBreakpoints(fixture, ...anchors);
    deepEq(
      vscode.debug.breakpoints.map((breakpoint) =>
        breakpoint instanceof vscode.SourceBreakpoint ? breakpoint.location.range.start.line : -1,
      ),
      anchors.map((anchor) => fixture.source.line(anchor)),
      'the workbench holds all three breakpoints, on the lines they were set on',
    );

    // Interaction 2 — launch; all three must bind in ONE setBreakpoints round-trip.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [first] = await recorder.waitForStops(1);
    assert.ok(first, 'the debuggee must reach the first breakpoint');
    assertBreakpointsBound(recorder, fixture, anchors, 'three armed lines');
    assertStoppedAt(
      await topFrame(session, first.threadId),
      fixture,
      'main-accumulate',
      'Main',
      'the first stop is the FIRST breakpoint in source order',
    );
    eq(recorder.outputText().includes('total='), false, 'nothing has been printed yet');

    // Interaction 3 — continue to the second breakpoint.
    const second = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(second.stop, 'breakpoint', 'the second stop');
    assertStoppedAt(second.frame, fixture, 'main-inspect', 'Main', 'the second breakpoint');
    await recorder.waitForOutput('total=8');
    eq(
      recorder.outputText().includes('boxed=8'),
      false,
      'Inspect has not run yet, so its output must not have appeared',
    );

    // Interaction 4 — continue to the third.
    const third = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(third.stop, 'breakpoint', 'the third stop');
    assertStoppedAt(third.frame, fixture, 'main-done', 'Main', 'the third breakpoint');
    await recorder.waitForOutput('boxed=8 1 2');
    eq(recorder.stops().length, 3, 'three breakpoints produce exactly three stops');

    // Interaction 5 — the final continue runs the program to exit.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'the last continue');
    await recorder.waitForOutput('done plain 45');
    eq(
      recorder.stops().length,
      3,
      'continuing past the last breakpoint must NOT produce a fourth stop',
    );
    eq(recorder.requests('continue').length, 3, 'three continue gestures, three DAP requests');
    assertCleanSession(debuggee(), 'a three-breakpoint continue walk');
  });
});
