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
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { BUILD_TIMEOUT_MS } from './run-debug-kit';
import { deepEq, eq, requireAt } from './test-helpers';

suite('Debug F# — breakpoints, stepping and exceptions', () => {
  const debuggee = useDebuggee('debug-step-fs-', 'fsharp');

  // Implements [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rules 1–3 for F#.
  test('F9 in an F# editor sets a breakpoint the adapter binds and stops on', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
  });

  // Implements [DEBUG-FEATURES-STEPPING] for F#: the same P1 rows, same gestures.
  test('F10, F11 and Shift+F11 walk F# functions exactly as they walk C#', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] for F#: catching and ignoring.
  test('F# exceptions break on the throw and are ignored when unfiltered', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on unhandled exceptions only"
  // — the IGNORING half, in F#.
  test('an F# exception the program handles is ignored when only unhandled is armed', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
  });
});
