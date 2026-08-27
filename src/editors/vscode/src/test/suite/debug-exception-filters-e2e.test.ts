// Per-type exception filters, and changing them while the debuggee is paused.
//
// Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on specific exception types
// (include/exclude filter) | P1", configured through the `exceptionOptions`
// member of `setExceptionBreakpoints` that the section names, and the
// `supportsExceptionOptions` row of [DEBUG-PROTOCOL-CAPABILITIES] ("Filter by
// type, user code, etc.").
//
// An include filter is only meaningful if the exclude half works: a debugger
// that breaks on `System.InvalidOperationException` AND on everything else has
// not implemented a filter, it has implemented "break on all" with extra
// ceremony. So each filter is driven against a program that throws two DIFFERENT
// types, and both the hit and the miss are asserted.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { dap } from './debug-dap-kit';
import {
  CAUGHT_MESSAGE,
  CAUGHT_TYPE,
  MODE,
  UNHANDLED_MESSAGE,
  UNHANDLED_TYPE,
} from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  assertExceptionIs,
  assertStopReason,
  assertStoppedAt,
  exceptionInfoOf,
  stepToFrame,
} from './debug-drive-kit';
import {
  armBreakpoints,
  assertCleanSession,
  assertRanToCompletion,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { BUILD_TIMEOUT_MS } from './run-debug-kit';
import { deepEq, eq } from './test-helpers';

/** A type the fixture never throws — the exclude half of every filter case. */
const NEVER_THROWN_TYPE = 'System.DivideByZeroException';

/** Build the DAP `exceptionOptions` bag that selects exactly `typeName`. */
function onlyType(typeName: string): Record<string, unknown> {
  return {
    filters: [],
    exceptionOptions: [{ path: [{ names: [typeName], negate: false }], breakMode: 'always' }],
  };
}

suite('Debug exceptions — per-type include and exclude filters', () => {
  const debuggee = useDebuggee('debug-excfilter-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on specific exception types
  // (include/exclude filter) | P1" — the INCLUDE half.
  test('a type filter breaks on the named type it selects', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate before any throw.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.caught });
    const [gate] = await recorder.waitForStops(1);
    assert.ok(gate, 'the debuggee must reach the gate breakpoint');
    eq(
      recorder.capabilities()['supportsExceptionOptions'],
      true,
      'a per-type filter is carried by `exceptionOptions`; without the capability VS Code ' +
        'never sends one and "Break on specific exception types" is unreachable',
    );

    // Interaction 2 — select the type the program is about to throw.
    const before = recorder.requests('setExceptionBreakpoints').length;
    await dap(session, 'setExceptionBreakpoints', onlyType(CAUGHT_TYPE));
    const sent = await recorder.requestAfter('setExceptionBreakpoints', before);
    deepEq(sent.args['filters'], [], 'the blanket filters are OFF — only the type filter is on');
    const options: unknown = sent.args['exceptionOptions'];
    assert.ok(Array.isArray(options), 'the request must carry exceptionOptions');
    eq(options.length, 1, 'exactly one type is selected');

    // Interaction 3 — continue: the selected type must stop the debuggee.
    const hit = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(hit.stop, 'exception', 'a type-filtered exception stop');
    assertStoppedAt(
      hit.frame,
      fixture,
      'throw-caught',
      'ThrowCaught',
      `a filter naming ${CAUGHT_TYPE} must stop on the statement that throws it`,
    );
    assertExceptionIs(
      await exceptionInfoOf(session, hit.stop.threadId),
      CAUGHT_TYPE,
      CAUGHT_MESSAGE,
      'the type-filtered exception',
    );

    // Interaction 4 — continue out; the program handles it and finishes.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a type-filtered session');
    eq(
      recorder.stops().filter((stop) => stop.reason === 'exception').length,
      1,
      'the selected type is thrown exactly once, so exactly one exception stop',
    );
    assertCleanSession(debuggee(), 'an include-type exception filter');
  });

  // Implements the EXCLUDE half of the same row.
  test('a type filter ignores every exception type it does not name', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate, then select a type the program NEVER throws.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.caught });
    await recorder.waitForStops(1);
    await dap(session, 'setExceptionBreakpoints', onlyType(NEVER_THROWN_TYPE));
    const baseline = recorder.stops().length;

    // Interaction 2 — continue. The InvalidOperationException the program DOES
    // throw must pass straight through the filter.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'an exception the filter excludes');
    await recorder.waitForOutput(`handled ${CAUGHT_MESSAGE}`);
    deepEq(
      recorder
        .stops()
        .slice(baseline)
        .map((stop) => `${stop.reason}:${stop.text}`),
      [],
      `a filter naming only ${NEVER_THROWN_TYPE} must ignore ${CAUGHT_TYPE} entirely. ` +
        'Breaking anyway means the type list is decorative and the filter is really "break ' +
        'on all", which [DEBUG-FEATURES-EXCEPTIONS] lists as a SEPARATE row',
    );
    await recorder.waitForOutput('done caught 45');
    assertCleanSession(debuggee(), 'an exclude-type exception filter');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] with the reactivity the Breakpoints
  // view promises: unticking and re-ticking a filter must affect the NEXT throw.
  test('exception filters changed mid-session take effect on the next throw', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate, arm a breakpoint after the FIRST throw, and turn
    // every exception filter OFF.
    armBreakpoints(fixture, 'main-mode', 'main-unhandled');
    const session = await startDebuggee(debuggee(), { mode: MODE.both });
    await recorder.waitForStops(1);
    await dap(session, 'setExceptionBreakpoints', { filters: [] });
    const beforeFirstThrow = recorder.stops().length;

    // Interaction 2 — continue past the handled throw. With no filter selected
    // it must be invisible, and the run must reach the second breakpoint.
    const gate = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(gate.stop, 'breakpoint', 'the second gate');
    assertStoppedAt(gate.frame, fixture, 'main-unhandled', 'Main', 'the second gate');
    deepEq(
      recorder
        .stops()
        .slice(beforeFirstThrow, -1)
        .map((stop) => stop.reason),
      [],
      `with no filters selected, ${CAUGHT_TYPE} must not produce a stop of any kind`,
    );
    await recorder.waitForOutput(`handled ${CAUGHT_MESSAGE}`);

    // Interaction 3 — now tick "All Exceptions" WHILE paused.
    const beforeChange = recorder.requests('setExceptionBreakpoints').length;
    await dap(session, 'setExceptionBreakpoints', { filters: ['all'] });
    deepEq(
      (await recorder.requestAfter('setExceptionBreakpoints', beforeChange)).args['filters'],
      ['all'],
      'a filter change made while the debuggee is paused must be pushed to the adapter, not ' +
        'stored for the next launch',
    );

    // Interaction 4 — continue: the second throw must now stop the debuggee.
    const caught = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(caught.stop, 'exception', 'the stop after the filter was re-enabled');
    assertStoppedAt(
      caught.frame,
      fixture,
      'throw-unhandled',
      'ThrowUnhandled',
      'a filter ticked mid-session must arm the very next throw',
    );
    assertExceptionIs(
      await exceptionInfoOf(session, caught.stop.threadId),
      UNHANDLED_TYPE,
      UNHANDLED_MESSAGE,
      'the exception caught after the filter change',
    );
    assertCleanSession(debuggee(), 'a mid-session exception filter change');
  });
});
