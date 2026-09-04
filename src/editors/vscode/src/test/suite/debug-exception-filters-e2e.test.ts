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
import { filterOptionsFrom } from '../../dap-exceptions.js';
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
import { deepEq, eq, neq } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

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
    this.timeout(DEBUG_TEST_MS);
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
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate, then select a type the program NEVER throws.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.caught });
    await recorder.waitForStops(1);
    const beforeFilter = recorder.requests('setExceptionBreakpoints').length;
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

    // Interaction 3 — the program really RAN. A filter that silences a stop by
    // killing the session would satisfy "no stops" while proving the opposite
    // of what this test is about.
    eq(recorder.stops().length, baseline, 'no stop was added by the excluded type');
    assert.ok(
      recorder.outputText().includes(`handled ${CAUGHT_MESSAGE}`),
      'the debuggee handled the exception itself, which is why the filter had to ignore it',
    );
    assert.ok(recorder.outputText().includes('done caught 45'), 'and ran through to its own end');

    // Interaction 4 — the filter that WAS set is the one that was asked for.
    // A `setExceptionBreakpoints` whose type list is dropped on the way to the
    // adapter produces exactly this test's passing result for the wrong reason:
    // no filter at all also breaks on nothing.
    const sent = await recorder.requestAfter('setExceptionBreakpoints', beforeFilter);
    assert.ok(
      Array.isArray(sent.args['exceptionOptions']),
      'the request carries the per-type selection VS Code spells as exceptionOptions',
    );
    // The router rewrites that selection into the `filterOptions` netcoredbg
    // applies; the translation decides which type the adapter is told about.
    const applied = filterOptionsFrom(sent.args['exceptionOptions']);
    eq(applied.length, 1, 'naming exactly one filter');
    assert.ok(
      JSON.stringify(applied).includes(NEVER_THROWN_TYPE),
      `the request names ${NEVER_THROWN_TYPE}`,
    );
    eq(
      JSON.stringify(applied).includes(CAUGHT_TYPE),
      false,
      `and must not name ${CAUGHT_TYPE}, which the program does throw`,
    );

    assertCleanSession(debuggee(), 'an exclude-type exception filter');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] with the reactivity the Breakpoints
  // view promises: unticking and re-ticking a filter must affect the NEXT throw.
  test('exception filters changed mid-session take effect on the next throw', async function () {
    this.timeout(DEBUG_TEST_MS);
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

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on specific exception types
  // (include/exclude filter) | P1" with MORE THAN ONE type selected. A filter
  // list that only ever honours its first entry passes every single-type test
  // and fails the user the moment they tick a second box.
  test('two selected types both break, and a third still does not', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate before any throw, in the mode that throws BOTH types.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.both });
    const [gate] = await recorder.waitForStops(1);
    assert.ok(gate, 'the debuggee must reach the gate breakpoint');
    neq(CAUGHT_TYPE, UNHANDLED_TYPE, 'the fixture really throws two DIFFERENT types');

    // Interaction 2 — select both thrown types AND one that is never thrown.
    const before = recorder.requests('setExceptionBreakpoints').length;
    await dap(session, 'setExceptionBreakpoints', {
      filters: [],
      exceptionOptions: [CAUGHT_TYPE, UNHANDLED_TYPE, NEVER_THROWN_TYPE].map((typeName) => ({
        path: [{ names: [typeName], negate: false }],
        breakMode: 'always',
      })),
    });
    const sent = await recorder.requestAfter('setExceptionBreakpoints', before);
    deepEq(sent.args['filters'], [], 'the blanket filters stay OFF');
    const options: unknown = sent.args['exceptionOptions'];
    assert.ok(Array.isArray(options), 'the request carries exceptionOptions');
    eq(options.length, 3, 'all three selections are sent, not just the first');

    // Interaction 3 — the FIRST selected type stops.
    const first = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(first.stop, 'exception', 'the first selected type');
    assertStoppedAt(
      first.frame,
      fixture,
      'throw-caught',
      'ThrowCaught',
      'a list naming ' + CAUGHT_TYPE + ' must stop on the statement that throws it',
    );
    assertExceptionIs(
      await exceptionInfoOf(session, first.stop.threadId),
      CAUGHT_TYPE,
      CAUGHT_MESSAGE,
      'the first selected type',
    );

    // Interaction 4 — and so does the SECOND, which is the half a first-entry
    // implementation gets wrong.
    const second = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(second.stop, 'exception', 'the second selected type');
    assertStoppedAt(
      second.frame,
      fixture,
      'throw-unhandled',
      'ThrowUnhandled',
      'the SECOND entry of the type list must arm too - honouring only the first is how a ' +
        'multi-type filter silently degrades to a single-type one',
    );
    assertExceptionIs(
      await exceptionInfoOf(session, second.stop.threadId),
      UNHANDLED_TYPE,
      UNHANDLED_MESSAGE,
      'the second selected type',
    );
    eq(
      recorder.stops().filter((stop) => stop.reason === 'exception').length,
      2,
      'exactly two exception stops: the fixture throws each selected type once, and the ' +
        'third selection is never thrown at all',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements the EXCLUDE half of the same row through the DAP mechanism the
  // section names: a `negate: true` path. "Break on everything except X" is the
  // shape a user reaches for when one noisy exception type is drowning a run.
  test('a negated type path breaks on everything except the type it names', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate, in the mode that throws both types.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.both });
    await recorder.waitForStops(1);
    eq(
      recorder.capabilities()['supportsExceptionOptions'],
      true,
      'a negated path travels in `exceptionOptions`, so the capability must be advertised',
    );

    // Interaction 2 — exclude the type the program throws FIRST.
    const before = recorder.requests('setExceptionBreakpoints').length;
    await dap(session, 'setExceptionBreakpoints', {
      filters: [],
      exceptionOptions: [{ path: [{ names: [CAUGHT_TYPE], negate: true }], breakMode: 'always' }],
    });
    const sent = await recorder.requestAfter('setExceptionBreakpoints', before);
    const options: unknown = sent.args['exceptionOptions'];
    assert.ok(Array.isArray(options), 'the request carries exceptionOptions');
    eq(options.length, 1, 'one option, carrying one negated path');
    const path: unknown = (options[0] as Record<string, any>)['path'];
    assert.ok(Array.isArray(path), 'the option carries a path');
    eq(
      (path[0] as Record<string, any>)['negate'],
      true,
      'and the negate flag reaches the adapter - dropped, the filter INCLUDES what the user ' +
        'asked to exclude, which is the exact opposite of the gesture',
    );

    // Interaction 3 — continue. The excluded type must pass straight through,
    // and the run must reach the type that is NOT excluded.
    const stop = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(stop.stop, 'exception', 'the type the negated path does not exclude');
    assertStoppedAt(
      stop.frame,
      fixture,
      'throw-unhandled',
      'ThrowUnhandled',
      'excluding ' +
        CAUGHT_TYPE +
        ' must skip its throw entirely and come to rest on the ' +
        'NEXT throw, which the exclusion does not name',
    );
    assertExceptionIs(
      await exceptionInfoOf(session, stop.stop.threadId),
      UNHANDLED_TYPE,
      UNHANDLED_MESSAGE,
      'the exception a negated path let through',
    );
    eq(
      recorder.stops().filter((entry) => entry.reason === 'exception').length,
      1,
      'exactly ONE exception stop: the excluded throw produced none',
    );
    eq(
      recorder.outputText().includes('handled ' + CAUGHT_MESSAGE),
      true,
      'and the excluded exception really was thrown and handled on the way past',
    );
  });
});
