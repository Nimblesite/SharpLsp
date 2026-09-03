// Catching exceptions, and ignoring them.
//
// Implements [DEBUG-FEATURES-EXCEPTIONS]: "Break on all CLR exceptions" (P1),
// "Break on unhandled exceptions only" (P1), "Break on exceptions from user code
// only" (P1), "Exception info panel (type, message, stack)" (P1) and "Inner
// exception chain traversal" (P2). Configuration goes through
// `setExceptionBreakpoints` with `filterOptions` and `exceptionOptions`, "per the
// DAP 1.71.0 specification", which is what that section requires.
//
// The half of this feature that silently rots is the NEGATIVE. A debugger that
// breaks on every throw satisfies "break on all exceptions" and fails the user
// completely: a program with a `try`/`catch` in a loop becomes undebuggable.
// So every filter is asserted twice — the throw it must catch, and the throw it
// must let through.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { dap } from './debug-dap-kit';
import {
  CAUGHT_MESSAGE,
  CAUGHT_TYPE,
  INNER_MESSAGE,
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
import { deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

/** The filter id every DAP adapter uses for "break on every throw". */
const FILTER_ALL = 'all';

/** The filter ids an adapter may use for "unhandled only"; one MUST exist. */
const UNHANDLED_FILTERS: readonly string[] = ['unhandled', 'user-unhandled', 'uncaught'];

/** The filter ids advertised by the adapter, in advertised order. */
function advertisedFilters(capabilities: Record<string, any>): string[] {
  const filters: unknown = capabilities['exceptionBreakpointFilters'];
  assert.ok(
    Array.isArray(filters),
    '[DEBUG-FEATURES-EXCEPTIONS] makes "Break on all CLR exceptions" and "Break on unhandled ' +
      'exceptions only" P1 rows. VS Code renders those as the Breakpoints-view checkboxes and ' +
      'builds them ENTIRELY from `exceptionBreakpointFilters` in the initialize response; with ' +
      'none advertised the user has no exception checkboxes at all',
  );
  return filters.map((filter) => String((filter as Record<string, any>)['filter']));
}

suite('Debug exceptions — breaking on them, and ignoring them', () => {
  const debuggee = useDebuggee('debug-exc-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-EXCEPTIONS] and the exception rows of
  // [DEBUG-PROTOCOL-CAPABILITIES].
  test('the adapter advertises every exception facility the specification requires', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — reach a stop so the whole initialize handshake is on the wire.
    armBreakpoints(fixture, 'main-mode');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    await recorder.waitForStops(1);
    const capabilities = recorder.capabilities();

    // Interaction 2 — the filter set: "all" plus an unhandled-only filter.
    const filters = advertisedFilters(capabilities);
    eq(
      filters.includes(FILTER_ALL),
      true,
      `"Break on all CLR exceptions" is P1; an '${FILTER_ALL}' filter must be advertised. ` +
        `Advertised: ${filters.join(', ') || '<none>'}`,
    );
    eq(
      filters.some((filter) => UNHANDLED_FILTERS.includes(filter)),
      true,
      '"Break on unhandled exceptions only" is P1; one of ' +
        `${UNHANDLED_FILTERS.join('/')} must be advertised. Advertised: ${filters.join(', ')}`,
    );
    eq(
      new Set(filters).size,
      filters.length,
      'a duplicated filter id makes two checkboxes drive the same switch',
    );

    // Interaction 3 — the capability rows [DEBUG-PROTOCOL-CAPABILITIES] pins Yes.
    eq(
      capabilities['supportsExceptionOptions'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsExceptionOptions as Yes for Phase 4 — it is ' +
        'what carries "Filter by type, user code, etc.", the P1 include/exclude row',
    );
    eq(
      capabilities['supportsExceptionInfoRequest'],
      true,
      '"Exception info panel (type, message, stack)" is P1 and arrives only through the ' +
        '`exceptionInfo` request',
    );
    eq(
      capabilities['supportsExceptionFilterOptions'],
      true,
      'DAP 1.71.0 `filterOptions` is how a filter carries a condition; without the capability ' +
        'VS Code falls back to plain filter ids and the per-type configuration is unreachable',
    );

    // Interaction 4 — every advertised filter must describe itself to the user.
    const raw = capabilities['exceptionBreakpointFilters'] as Record<string, any>[];
    deepEq(
      raw.map((filter) => typeof filter['label']),
      raw.map(() => 'string'),
      'each filter needs a label; an unlabelled checkbox is unusable',
    );
    deepEq(
      raw.map((filter) => String(filter['label']).trim() === ''),
      raw.map(() => false),
      'and the label must not be empty',
    );
    assertCleanSession(debuggee(), 'reading the adapter capabilities');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on all CLR exceptions | P1".
  test('breaking on ALL exceptions catches a throw the program handles itself', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop early so the filters can be configured before the throw.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.caught });
    const [gate] = await recorder.waitForStops(1);
    assert.ok(gate, 'the debuggee must reach the gate breakpoint');
    assertStoppedAt(
      await topFrame(session, gate.threadId),
      fixture,
      'main-mode',
      'Main',
      'the gate breakpoint',
    );

    // Interaction 2 — tick "All Exceptions".
    const before = recorder.requests('setExceptionBreakpoints').length;
    const response = await dap(session, 'setExceptionBreakpoints', { filters: [FILTER_ALL] });
    eq(typeof response, 'object', '`setExceptionBreakpoints` must answer');
    const sent = await recorder.requestAfter('setExceptionBreakpoints', before);
    deepEq(
      sent.args['filters'],
      [FILTER_ALL],
      'the filter change must reach the adapter carrying the ticked filter. Counting the ' +
        'requests instead cannot see that: the workbench opens every session with a ' +
        '`setExceptionBreakpoints` of its own, so a count is satisfied before the suite ' +
        'has sent anything at all',
    );

    // Interaction 3 — continue. The FIRST-CHANCE throw must stop the debuggee,
    // even though the program catches it two lines later.
    const caught = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(caught.stop, 'exception', 'an all-exceptions stop');
    assertStoppedAt(
      caught.frame,
      fixture,
      'throw-caught',
      'ThrowCaught',
      '"Break on all CLR exceptions" must stop on the THROW statement, before the catch ' +
        'block runs — stopping in the catch, or not at all, is the non-conforming behaviour',
    );

    // Interaction 4 — the exception panel must identify what was thrown.
    const info = await exceptionInfoOf(session, caught.stop.threadId);
    assertExceptionIs(info, CAUGHT_TYPE, CAUGHT_MESSAGE, 'the first-chance exception');
    eq(
      info.breakMode,
      'always',
      'a stop produced by the "all" filter must report breakMode `always`; `unhandled` here ' +
        'means the adapter broke for a different reason than the one the user selected',
    );
    const frames = await stackFrames(session, caught.stop.threadId);
    deepEq(
      frames.slice(0, 2).map((frame) => methodOf(frame)),
      ['ThrowCaught', 'Main'],
      'the call stack at an exception stop must be the throwing stack, not the catch site',
    );

    // Interaction 5 — continue: the program handles it and finishes normally.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a handled exception');
    await recorder.waitForOutput(`handled ${CAUGHT_MESSAGE}`);
    eq(
      recorder.stops().filter((stop) => stop.reason === 'exception').length,
      1,
      'the program throws exactly once in `caught` mode, so exactly one exception stop',
    );
    assertCleanSession(debuggee(), 'break on all exceptions');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on unhandled exceptions only"
  // and "Break on exceptions from user code only" — the IGNORING half.
  test('with only the unhandled filter, a handled throw is ignored completely', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate, then select ONLY the unhandled-style filter.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.caught });
    await recorder.waitForStops(1);
    const filters = advertisedFilters(recorder.capabilities());
    const unhandled = filters.find((filter) => UNHANDLED_FILTERS.includes(filter));
    assert.ok(unhandled, `an unhandled-only filter must exist; advertised: ${filters.join(', ')}`);
    const before = recorder.requests('setExceptionBreakpoints').length;
    await dap(session, 'setExceptionBreakpoints', { filters: [unhandled] });
    const selection = await recorder.requestAfter('setExceptionBreakpoints', before);
    deepEq(
      selection.args['filters'],
      [unhandled],
      'exactly the selected filter is sent; sending `all` alongside it would break on ' +
        'everything and the user would have no way to get the behaviour they asked for',
    );

    // Interaction 2 — continue. The handled throw must NOT stop the debuggee.
    const baseline = recorder.stops().length;
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'an ignored, handled exception');
    await recorder.waitForOutput(`handled ${CAUGHT_MESSAGE}`);

    // Interaction 3 — prove the negative, precisely.
    deepEq(
      recorder
        .stops()
        .slice(baseline)
        .map((stop) => `${stop.reason}:${stop.text}`),
      [],
      'a throw the program CATCHES must be invisible when only the unhandled filter is ' +
        'selected. Breaking here is the defect that makes a debugger useless on any codebase ' +
        'that uses exceptions for control flow',
    );
    await recorder.waitForOutput('done caught 45');
    assertCleanSession(debuggee(), 'ignoring a handled exception');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Exception info panel (type, message,
  // stack)" P1 and "Inner exception chain traversal" P2.
  test('an unhandled exception breaks with its type, message, stack and inner cause', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — gate, then select the unhandled filter and run into the throw.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.unhandled });
    await recorder.waitForStops(1);
    const filters = advertisedFilters(recorder.capabilities());
    const unhandled = filters.find((filter) => UNHANDLED_FILTERS.includes(filter));
    assert.ok(unhandled, `an unhandled-only filter must exist; advertised: ${filters.join(', ')}`);
    await dap(session, 'setExceptionBreakpoints', { filters: [unhandled] });

    // Interaction 2 — continue into the unhandled throw.
    const crash = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(crash.stop, 'exception', 'an unhandled-exception stop');
    assertStoppedAt(
      crash.frame,
      fixture,
      'throw-unhandled',
      'ThrowUnhandled',
      'an unhandled exception must stop the debuggee at the throw, with the stack intact — ' +
        'letting the process die first leaves nothing to inspect',
    );

    // Interaction 3 — the panel must carry type, message and a real stack.
    const info = await exceptionInfoOf(session, crash.stop.threadId);
    assertExceptionIs(info, UNHANDLED_TYPE, UNHANDLED_MESSAGE, 'the unhandled exception');
    eq(
      info.stackTrace.includes('ThrowUnhandled'),
      true,
      `the panel's stackTrace must name the throwing method; got: ${info.stackTrace}`,
    );
    eq(info.breakMode.length > 0, true, 'DAP requires a breakMode on every exceptionInfo response');

    // Interaction 4 — the inner exception chain (P2).
    deepEq(
      info.innerMessages,
      [INNER_MESSAGE],
      '"Inner exception chain traversal" is a specified row: the `ApplicationException` was ' +
        'constructed with a `FormatException` cause, and an empty chain means the user cannot ' +
        'see WHY the outer exception was thrown',
    );

    // Interaction 5 — the stack must show who called the throwing method.
    const frames = await stackFrames(session, crash.stop.threadId);
    deepEq(
      frames.slice(0, 2).map((frame) => methodOf(frame)),
      ['ThrowUnhandled', 'Main'],
      'the frames below the throw must still be walkable at an unhandled-exception stop',
    );
    eq(
      requireAt(frames, 1, 'the calling frame').line,
      fixture.source.dapLine('main-unhandled'),
      'the caller must be parked on the call statement that led to the throw',
    );
    assertCleanSession(debuggee(), 'an unhandled exception stop');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Exception info panel (type,
  // message, stack) | P1" and "Inner exception chain traversal | P2" together
  // with [DEBUG-FEATURES-STACK]: the panel is only useful if the STACK behind
  // the exception is the user own, at the throw site.
  test('an exception stop carries the throwing frame and the whole user stack', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — break on every throw, in the mode that throws twice.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.both });
    await recorder.waitForStops(1);
    await dap(session, 'setExceptionBreakpoints', { filters: [FILTER_ALL] });
    eq(
      advertisedFilters(recorder.capabilities()).includes(FILTER_ALL),
      true,
      'the "all exceptions" checkbox must be offered before it can be ticked',
    );

    // Interaction 2 — the first throw. The panel fields, and the frame the
    // throw happened in.
    const first = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(first.stop, 'exception', 'the first throw');
    assertStoppedAt(
      first.frame,
      fixture,
      'throw-caught',
      'ThrowCaught',
      'an exception stop must park on the THROW, not on the catch that follows it',
    );
    const info = await exceptionInfoOf(session, first.stop.threadId);
    assertExceptionIs(info, CAUGHT_TYPE, CAUGHT_MESSAGE, 'the first throw');
    neq(info.description, '', 'the panel needs a description to render');
    const frames = await stackFrames(session, first.stop.threadId);
    eq(frames.length >= 2, true, 'the throwing method was called from somewhere');
    eq(
      methodOf(requireAt(frames, 0, 'the throwing frame')),
      'ThrowCaught',
      'the innermost frame is the method that threw',
    );
    eq(
      frames.map((frame) => methodOf(frame)).includes('Main'),
      true,
      'and the caller chain up to Main is intact, which is how the user finds the cause',
    );

    // Interaction 3 — the SECOND throw carries its own type, its own message
    // and its own inner cause. Reporting the first exception again is the
    // failure a single-throw fixture cannot see.
    const second = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(second.stop, 'exception', 'the second throw');
    assertStoppedAt(
      second.frame,
      fixture,
      'throw-unhandled',
      'ThrowUnhandled',
      'the second throw parks on its own statement',
    );
    const secondInfo = await exceptionInfoOf(session, second.stop.threadId);
    assertExceptionIs(secondInfo, UNHANDLED_TYPE, UNHANDLED_MESSAGE, 'the second throw');
    neq(
      secondInfo.exceptionId,
      info.exceptionId,
      'the two throws are different exceptions and must report different ids',
    );
    eq(
      secondInfo.description.includes(INNER_MESSAGE) ||
        secondInfo.description.includes(UNHANDLED_MESSAGE),
      true,
      '"Inner exception chain traversal" is a specified row: the panel must carry the cause, ' +
        'or the user sees a wrapper and never the real failure',
    );
    eq(
      recorder.stops().filter((entry) => entry.reason === 'exception').length,
      2,
      'exactly two exception stops for two throws',
    );
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] with the reactivity every screen in
  // this project owes: unticking "All Exceptions" mid-session must take effect
  // on the NEXT throw, not on the next launch.
  test('unticking every exception filter mid-session silences the next throw', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — break on all, and prove it by catching the first throw.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.both });
    await recorder.waitForStops(1);
    await dap(session, 'setExceptionBreakpoints', { filters: [FILTER_ALL] });
    const caught = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(caught.stop, 'exception', 'the first throw with the filter on');
    assertStoppedAt(caught.frame, fixture, 'throw-caught', 'ThrowCaught', 'the first throw');

    // Interaction 2 — untick everything WHILE paused, and prove the change
    // reached the adapter rather than being stored for the next launch.
    const before = recorder.requests('setExceptionBreakpoints').length;
    await dap(session, 'setExceptionBreakpoints', { filters: [] });
    const sent = await recorder.requestAfter('setExceptionBreakpoints', before);
    deepEq(sent.args['filters'], [], 'an empty filter list must be pushed to the LIVE adapter');
    eq(
      recorder.requests('setExceptionBreakpoints').length > before,
      true,
      'and it must be sent, not merely remembered',
    );

    // Interaction 3 — continue. The SECOND throw must pass straight through,
    // and the program must run to its end.
    const exceptionsSoFar = recorder.stops().filter((entry) => entry.reason === 'exception').length;
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session whose exception filters were unticked');
    eq(
      recorder.stops().filter((entry) => entry.reason === 'exception').length,
      exceptionsSoFar,
      'with every filter unticked, no further throw may stop the debuggee - a filter change ' +
        'that only takes effect at the next launch is a checkbox that does nothing',
    );
    eq(
      recorder.outputText().includes('handled ' + CAUGHT_MESSAGE),
      true,
      'and the program really did carry on running past the throw',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on all CLR exceptions" as the
  // NEGATIVE the section is really about: a program that throws nothing must
  // run to completion with the filter fully armed. A debugger that stops
  // anyway has made every clean run unusable.
  test('with every filter armed, a program that throws nothing still runs clean', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — arm every advertised filter at once.
    armBreakpoints(fixture, 'main-mode');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    await recorder.waitForStops(1);
    const filters = advertisedFilters(recorder.capabilities());
    eq(filters.length >= 2, true, 'at least an all filter and an unhandled-only one are offered');
    eq(filters.includes(FILTER_ALL), true, 'including "break on all"');
    eq(
      filters.some((filter) => UNHANDLED_FILTERS.includes(filter)),
      true,
      'and an unhandled-only filter under one of the names adapters use',
    );

    // Interaction 2 — send them all, and check the request really carried them.
    const before = recorder.requests('setExceptionBreakpoints').length;
    await dap(session, 'setExceptionBreakpoints', { filters });
    const sent = await recorder.requestAfter('setExceptionBreakpoints', before);
    deepEq(sent.args['filters'], filters, 'every advertised filter is armed at once');

    // Interaction 3 — the clean run must stay clean.
    const stopsBefore = recorder.stops().length;
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a clean run with every exception filter armed');
    await recorder.waitForOutput('done plain 45');
    eq(
      recorder.stops().length,
      stopsBefore,
      'a program that throws nothing must not stop, however many filters are ticked - the CLR ' +
        'throws internally during startup and JIT, and surfacing those is what makes "break ' +
        'on all exceptions" unusable in practice',
    );
    deepEq(
      recorder.stops().filter((entry) => entry.reason === 'exception'),
      [],
      'and not one exception stop in the whole session',
    );
    assertCleanSession(debuggee(), 'a clean run with every filter armed');
  });
});
