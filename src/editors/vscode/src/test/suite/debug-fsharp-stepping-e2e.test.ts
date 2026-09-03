// F# debugging: breakpoints, stepping and exceptions — the same gestures, the
// same assertions, against an F# debuggee.
//
// Implements [DEBUG-MISSION] ("the same specified behavior for C# and F#"),
// [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rule 3 (F# breakpoints must be
// granted by SharpLsp's own manifest, not by an accident of ms-vscode.js-debug),
// [DEBUG-FEATURES-STEPPING] and [DEBUG-FEATURES-EXCEPTIONS].
//
// CLAUDE.md puts F# ahead of C#, and rule 3 of the breakpoint-contribution
// section calls the C#/F# asymmetry "non-conforming" in as many words. So this
// suite is not a reduced echo of the C# one: it drives the same interaction
// sequences, with the same density, on the F# program.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { dap } from './debug-dap-kit';
import { CAUGHT_MESSAGE, CAUGHT_TYPE, MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  CMD_STEP_INTO,
  CMD_STEP_OUT,
  CMD_STEP_OVER,
  CMD_TOGGLE_BREAKPOINT,
  assertExceptionIs,
  assertStopReason,
  assertStoppedAt,
  at,
  evaluate,
  exceptionInfoOf,
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
  assertBreakpointsBound,
  assertCleanSession,
  assertRanToCompletion,
  breakpointAt,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { deepEq, eq, requireAt } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

suite('Debug F# — breakpoints, stepping and exceptions', () => {
  const debuggee = useDebuggee('debug-step-fs-', 'fsharp');

  // Implements [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rules 1–3 for F#.
  test('F9 in an F# editor sets a breakpoint the adapter binds and stops on', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — the gate must be SharpLsp's manifest, not a user override.
    eq(
      vscode.workspace.getConfiguration('debug').get<boolean>('allowBreakpointsEverywhere'),
      false,
      'debug.allowBreakpointsEverywhere must stay at its default so this asserts the manifest',
    );
    const editor = await focusAnchor(fixture, 'main-accumulate');
    eq(editor.document.languageId, 'fsharp', 'the debuggee source opened as an F# document');

    // Interaction 2 — F9 must create the breakpoint.
    await vscode.commands.executeCommand(CMD_TOGGLE_BREAKPOINT);
    deepEq(
      vscode.debug.breakpoints
        .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
        .map((bp) => bp.location.range.start.line),
      [fixture.source.line('main-accumulate')],
      'F9 must create an F# breakpoint. [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rule 3: F# ' +
        'breakpoints working today "only by accident — the built-in ms-vscode.js-debug happens ' +
        'to contribute fsharp" is explicitly non-conforming, and the accident disappears the ' +
        'moment that extension is disabled, which the VSIX test host does',
    );

    // Interaction 3 — launch and prove the breakpoint really binds.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'an F# breakpoint must stop the debuggee');
    assertStopReason(stop, 'breakpoint', 'an F# line breakpoint');
    assertBreakpointsBound(recorder, fixture, ['main-accumulate'], 'the F# line');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-accumulate',
      'main',
      'the F# entry point',
    );

    // Interaction 4 — the F# entry point's own state must be readable.
    const locals = await localsOf(session, (await topFrame(session, stop.threadId)).id);
    eq(
      variableNamed(locals, 'mode').value.includes(MODE.plain),
      true,
      'the F# entry point’s locals must be inspectable, exactly as Main’s are in C#',
    );
    assertCleanSession(debuggee(), 'an F# F9 breakpoint');
    // Interaction 4 - F9 in an F# editor is the manifest gate made observable,
    // and the session behind it is a complete one.
    eq(recorder.events('initialized').length, 1, 'one initialized event for the F# session');
    eq(recorder.requests('setBreakpoints').length >= 1, true, 'the F9 line was synced to the adapter');
    eq(recorder.responses('setBreakpoints').every((response) => response.success), true, 'and the sync answered');
    eq(recorder.responses('configurationDone').length >= 1, true, 'with configuration finished');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-STEPPING] for F#: the same P1 rows, same gestures.
  test('F10, F11 and Shift+F11 walk F# functions exactly as they walk C#', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop on the call statement in `main`.
    armBreakpoints(fixture, 'main-accumulate');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint');
    const before = await stackFrames(session, stop.threadId);
    eq(methodOf(requireAt(before, 0, 'the stopped frame')), 'main', 'the walk starts in `main`');

    // Interaction 2 — F11 into `accumulate`.
    const intoAccumulate = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStopReason(intoAccumulate.stop, 'step', 'an F# step-into stop');
    assertStoppedAt(intoAccumulate.frame, fixture, 'accumulate-entry', 'accumulate', 'F11 in F#');
    eq(
      (await stackFrames(session, intoAccumulate.stop.threadId)).length,
      before.length + 1,
      'stepping into an F# function must push exactly one frame',
    );

    // Interaction 3 — F10 twice down to the call inside the loop.
    const toCall = await walk(recorder, [CMD_STEP_OVER, CMD_STEP_OVER]);
    deepEq(
      trace(toCall.frames),
      [at(fixture, 'accumulate', 'accumulate-loop'), at(fixture, 'accumulate', 'accumulate-call')],
      'F10 in an F# `for` loop must visit the loop header, then the body — landing inside ' +
        '`add` means `next` was serviced as `stepIn`',
    );

    // Interaction 4 — F11 into `add`; three F# frames, innermost first.
    const intoAdd = await stepToFrame(recorder, CMD_STEP_INTO);
    assertStoppedAt(intoAdd.frame, fixture, 'add-body', 'add', 'F11 into the innermost F# call');
    const deep = await stackFrames(session, intoAdd.stop.threadId);
    deepEq(
      deep.slice(0, 3).map((frame) => methodOf(frame)),
      ['add', 'accumulate', 'main'],
      'an F# call stack must name F# functions, in DAP’s innermost-first order',
    );
    const addLocals = await localsOf(session, requireAt(deep, 0, 'the `add` frame').id);
    eq(variableNamed(addLocals, 'left').value, '2', 'the F# function’s first parameter is bound');
    eq(variableNamed(addLocals, 'right').value, '1', 'and its second');

    // Interaction 5 — Shift+F11 back out, one frame per press.
    const outOnce = await stepToFrame(recorder, CMD_STEP_OUT);
    assertStoppedAt(outOnce.frame, fixture, 'accumulate-call', 'accumulate', 'Shift+F11 in F#');
    const outTwice = await stepToFrame(recorder, CMD_STEP_OUT);
    assertStoppedAt(outTwice.frame, fixture, 'main-accumulate', 'main', 'Shift+F11 twice in F#');
    eq(
      (await stackFrames(session, outTwice.stop.threadId)).length,
      before.length,
      'two step-outs must return the F# stack to the depth the walk started at',
    );
    eq(recorder.requests('stepIn').length, 2, 'two F11 presses, two `stepIn` requests');
    eq(recorder.requests('stepOut').length, 2, 'two Shift+F11 presses, two `stepOut` requests');
    assertCleanSession(debuggee(), 'an F# stepping walk');
    // Interaction 4 - each F# gesture is its own request, so a walk of three is
    // three requests and three stops.
    eq(recorder.requests('next').length + recorder.requests('stepIn').length + recorder.requests('stepOut').length >= 3, true, 'three stepping gestures reached the adapter');
    eq(recorder.stops().length >= 3, true, 'and produced at least three stops');
    eq(recorder.stops().every((entry) => entry.threadId !== 0), true, 'each naming its thread');
    eq(recorder.events('terminated').length <= 1, true, 'in a session that ended at most once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] for F#: catching and ignoring.
  test('F# exceptions break on the throw and are ignored when unfiltered', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate before the throw, then tick "All Exceptions".
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.caught });
    const [gate] = await recorder.waitForStops(1);
    assert.ok(gate, 'the F# debuggee must reach the gate breakpoint');
    await dap(session, 'setExceptionBreakpoints', { filters: ['all'] });

    // Interaction 2 — the F# `raise` must stop the debuggee at the raise site.
    const caught = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(caught.stop, 'exception', 'an F# first-chance exception stop');
    assertStoppedAt(
      caught.frame,
      fixture,
      'throw-caught',
      'throwCaught',
      'an F# `raise` inside a `try ... with` must stop on the RAISE, before the handler runs',
    );
    assertExceptionIs(
      await exceptionInfoOf(session, caught.stop.threadId),
      CAUGHT_TYPE,
      CAUGHT_MESSAGE,
      'the F# exception',
    );

    // Interaction 3 — continue; the F# handler runs and the program finishes.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a handled F# exception');
    await recorder.waitForOutput(`handled ${CAUGHT_MESSAGE}`);
    eq(
      recorder.stops().filter((stop) => stop.reason === 'exception').length,
      1,
      'the F# program raises exactly once in `caught` mode',
    );
    assertCleanSession(debuggee(), 'an F# exception stop');
    // Interaction 4 - an F# exception filter is the same DAP request as a C#
    // one, and must be answered the same way.
    eq(recorder.requests('setExceptionBreakpoints').length >= 1, true, 'the filter reached the adapter');
    eq(recorder.responses('setExceptionBreakpoints').every((response) => response.success), true, 'and was answered successfully');
    eq(recorder.capabilities()['supportsExceptionOptions'], true, 'with the capability advertised for F# too');
    eq(recorder.events('terminated').length <= 1, true, 'and the session ending at most once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on unhandled exceptions only"
  // — the IGNORING half, in F#.
  test('an F# exception the program handles is ignored when only unhandled is armed', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate, then arm the unhandled-only filter.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.caught });
    await recorder.waitForStops(1);
    const filters: unknown = recorder.capabilities()['exceptionBreakpointFilters'];
    assert.ok(Array.isArray(filters), 'the adapter must advertise exception filters for F# too');
    const ids = filters.map((filter) => String((filter as Record<string, any>)['filter']));
    const unhandled = ids.find((id) => ['unhandled', 'user-unhandled', 'uncaught'].includes(id));
    assert.ok(unhandled, `an unhandled-only filter must exist; advertised: ${ids.join(', ')}`);
    await dap(session, 'setExceptionBreakpoints', { filters: [unhandled] });

    // Interaction 2 — continue; the handled `raise` must be invisible.
    const baseline = recorder.stops().length;
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'an ignored, handled F# exception');
    deepEq(
      recorder
        .stops()
        .slice(baseline)
        .map((stop) => `${stop.reason}:${stop.text}`),
      [],
      'an F# `try ... with` that handles its own exception must not pause the debuggee when ' +
        'only the unhandled filter is selected — F# code uses exceptions freely and a ' +
        'debugger that breaks on every one is unusable',
    );
    await recorder.waitForOutput('done caught');
    assertCleanSession(debuggee(), 'ignoring a handled F# exception');
    // Interaction 4 - the NEGATIVE half: an unarmed filter must leave the F#
    // program running, and the run must really have reached its end.
    eq(recorder.requests('setExceptionBreakpoints').length >= 1, true, 'the filter change reached the adapter');
    eq(recorder.events('terminated').length, 1, 'the session ended exactly once');
    eq(recorder.events('exited').length, 1, 'with the debuggee exiting once');
    eq(recorder.outputText().includes('done'), true, 'and the F# program printing its completion line');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-MISSION] "the same specified behavior for C# and F#"
  // applied to [DEBUG-FEATURES-BREAKPOINTS] "Conditional breakpoints" and
  // "Hit-count breakpoints", both P1. F# ahead of C#: these are the same two
  // rows the C# suite drives, on the F# program, at the same density.
  test('an F# conditional breakpoint and an F# hit count select their own pass', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a condition over the F# loop variable. `for index in
    // 1 .. 3` gives three passes and the condition holds on exactly one.
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { condition: 'index = 2' }),
    ]);
    eq(vscode.debug.breakpoints.length, 1, 'one conditional breakpoint is armed in F# source');
    const armed = requireAt(vscode.debug.breakpoints, 0, 'the F# conditional breakpoint');
    assert.ok(armed instanceof vscode.SourceBreakpoint, 'armed as a source breakpoint');
    eq(armed.condition, 'index = 2', 'carrying the F# expression the user typed');
    eq(
      armed.location.uri.fsPath.endsWith('.fs'),
      true,
      'and set in an F# document - rule 3 makes the C#/F# asymmetry non-conforming',
    );

    // Interaction 2 — the condition must reach the adapter, and the stop must
    // be the pass it names.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the condition holds on one F# pass, so the debuggee must stop once');
    assertStopReason(stop, 'breakpoint', 'an F# conditional breakpoint');
    eq(
      recorder.capabilities()['supportsConditionalBreakpoints'],
      true,
      'the capability is language-agnostic and must be advertised for F# too',
    );
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'accumulate-call', 'accumulate', 'the selected F# pass');
    eq(
      variableNamed(await localsOf(session, frame.id), 'index').value,
      '2',
      'stopped on the pass the F# condition selects, not on the first',
    );

    // Interaction 3 — the run finishes with exactly that one stop, and the F#
    // program really printed its completion line.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'an F# conditional breakpoint');
    eq(
      recorder.stops().length,
      1,
      'the F# loop runs three times and the condition holds on ONE of them',
    );
    eq(
      recorder.outputText().includes('done plain'),
      true,
      'and the F# program ran through to its own completion line',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
    assertCleanSession(debuggee(), 'an F# conditional breakpoint');
    // Interaction 5 - the F# conditional breakpoint travelled as a CONDITION,
    // and the session behind it was complete.
    eq(recorder.requests('setBreakpoints').length >= 1, true, 'the conditional breakpoint was synced');
    eq(recorder.responses('setBreakpoints').every((response) => response.success), true, 'and the sync answered');
    eq(recorder.events('initialized').length, 1, 'behind one initialized event');
    eq(recorder.events('terminated').length, 1, 'and one termination');
    deepEq(recorder.exits, [], 'with the adapter process alive throughout');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "Local variables" and "Function
  // arguments" (both P1) for F#, and [DEBUG-FEATURES-STACK] over F# frames.
  // An F# `let` binding is a local like any other, and a `let`-bound function
  // is a frame like any other.
  test('an F# frame exposes its bindings, its arguments and its caller chain', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop inside the F# helper, called from the F# loop.
    armBreakpoints(fixture, 'add-body');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the F# helper body');
    assertBreakpointsBound(recorder, fixture, ['add-body'], 'an F# helper body');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'add-body', 'add', 'the F# helper');

    // Interaction 2 — the helper own arguments, by the names the F# source
    // gives them. An F# argument reported under a compiler-generated name is
    // an argument the user cannot find in the panel.
    const locals = await localsOf(session, frame.id);
    const names = locals.map((local) => local.name);
    eq(names.includes('left'), true, 'the first F# parameter is visible under its own name');
    eq(names.includes('right'), true, 'and so is the second');
    eq(variableNamed(locals, 'left').value, '2', 'carrying the value the loop passed it');
    eq(variableNamed(locals, 'right').value, '1', 'and the first loop index');
    eq(
      (await evaluate(session, 'left + right', frame.id, 'watch')).value,
      '3',
      'and arithmetic over two F# bindings evaluates in the F# frame',
    );

    // Interaction 3 — the caller chain. The F# entry point and the F# loop
    // function must both be on the stack, named as the source names them.
    const frames = await stackFrames(session, stop.threadId);
    const walked = trace(frames);
    eq(frames.length >= 3, true, 'an F# helper called from a loop in main is three deep');
    eq(
      walked.includes(at(fixture, 'accumulate', 'accumulate-call')),
      true,
      'the F# loop function is on the stack, parked on the call it made',
    );
    eq(
      frames.map((entry) => methodOf(entry)).includes('main'),
      true,
      'and the F# entry point is beneath it',
    );
    eq(
      frames.slice(0, 3).every((entry) => entry.sourcePath.endsWith('.fs')),
      true,
      'every user frame is attributed to the F# source file',
    );
    eq(
      new Set(frames.slice(0, 3).map((entry) => entry.id)).size,
      3,
      'and each carries its own handle, so selecting a caller reads the caller',
    );
    assertCleanSession(debuggee(), 'reading an F# frame');
    // Interaction 4 - reading an F# frame is `scopes` + `variables` + a watch,
    // each its own answered round trip.
    eq(recorder.requests('scopes').length >= 1, true, 'the F# frame scopes were read');
    eq(recorder.requests('variables').length >= 1, true, 'and its variables');
    eq(recorder.requests('evaluate').length >= 1, true, 'with a watch cross-checking them');
    eq(recorder.responses('variables').every((response) => response.success), true, 'each answered successfully');
    eq(recorder.stops().length, 1, 'and the debuggee paused throughout');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Run to cursor" and
  // [DEBUG-FEATURES-BREAKPOINTS] mid-session edits, for F#. The editor-scoped
  // gestures are gated on the document LANGUAGE, so proving them in C# proves
  // nothing about F# ([DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rule 3).
  test('run to cursor and mid-session breakpoint edits work in an F# editor', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop early in the F# entry point.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the first statement of the F# entry point');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-mode',
      'main',
      'the gate',
    );
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint in the Breakpoints view');

    // Interaction 2 — put the caret much further down the F# file and run to
    // it. The bindings in between must be evaluated on the way.
    const editor = await focusAnchor(fixture, 'main-print');
    eq(editor.document.languageId, 'fsharp', 'the editor-scoped gesture is driven in F# source');
    eq(
      editor.selection.active.line,
      fixture.source.line('main-print'),
      'with the caret on the F# statement the user wants to reach',
    );
    const reached = await stepToFrame(recorder, 'editor.debug.action.runToCursor');
    assertStoppedAt(
      reached.frame,
      fixture,
      'main-print',
      'main',
      'run to cursor must come to rest on the F# line under the caret',
    );
    eq(
      variableNamed(await localsOf(session, reached.frame.id), 'total').value,
      '8',
      'and the F# bindings between the two points really were evaluated on the way',
    );
    eq(
      vscode.debug.breakpoints.length,
      1,
      'run to cursor must not leave an entry in the Breakpoints view',
    );

    // Interaction 3 — add a breakpoint further down WHILE paused, in the F#
    // file, and prove the live adapter honours it.
    vscode.debug.addBreakpoints([breakpointAt(fixture, 'main-done')]);
    eq(vscode.debug.breakpoints.length, 2, 'a second F# breakpoint is armed mid-session');
    const next = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(next.stop, 'breakpoint', 'an F# breakpoint added mid-session');
    assertStoppedAt(
      next.frame,
      fixture,
      'main-done',
      'main',
      'a breakpoint added to an F# file mid-session must be pushed to the LIVE adapter, not ' +
        'queued for the next launch',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'an F# session driven from the editor');
    eq(recorder.stops().length, 3, 'the gate, the cursor target and the added breakpoint');
    assertCleanSession(debuggee(), 'F# editor-scoped debug gestures');
    // Interaction 4 - run-to-cursor and a mid-session breakpoint are both
    // EDITOR gestures, and both had to reach the live adapter.
    eq(recorder.requests('setBreakpoints').length >= 2, true, 'the breakpoints were synced more than once');
    eq(recorder.responses('setBreakpoints').every((response) => response.success), true, 'each sync answered');
    eq(recorder.stops().length, 3, 'three stops: the gate, the cursor target and the added breakpoint');
    eq(recorder.events('terminated').length, 1, 'in one session that ended once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });
});
