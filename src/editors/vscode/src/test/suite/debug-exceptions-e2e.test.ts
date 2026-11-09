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
import { methodOf, stackFrames } from './debug-drive-kit';
import {
  armBreakpoints,
  assertCleanSession,
  startDebuggee,
  useDebuggee,
  runToFirstStop,
  type Debuggee,
  stopInFrame,
  debugTest,
} from './debug-suite-kit';
import { deepEq, eq, neq, requireAt } from './test-helpers';
import {
  assertRunsPastHandledThrow,
  advertisedExceptionFilters,
  continueToCompletion,
  pushExceptionFilters,
  requireUnhandledFilterId,
  stopOnThrow,
  UNHANDLED_FILTER_IDS,
} from './debug-inspect-kit';

/** The filter id every DAP adapter uses for "break on every throw". */
const FILTER_ALL = 'all';

/** Stop at the start of the twice-throwing mode with "All Exceptions" ticked. */
async function stopWithAllFilter(debuggee: Debuggee): Promise<vscode.DebugSession> {
  const { session } = await runToFirstStop(debuggee, 'main-mode', { mode: MODE.both });
  await pushExceptionFilters(
    session,
    debuggee.recorder,
    [FILTER_ALL],
    'the filter change must reach the adapter carrying the ticked filter',
  );
  return session;
}

suite('Debug exceptions — breaking on them, and ignoring them', () => {
  const debuggee = useDebuggee('debug-exc-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-EXCEPTIONS] and the exception rows of
  // [DEBUG-PROTOCOL-CAPABILITIES].
  debugTest(
    'the adapter advertises every exception facility the specification requires',
    debuggee,
    async ({ fixture, recorder }) => {
      // Interaction 1 — reach a stop so the whole initialize handshake is on the wire.
      armBreakpoints(fixture, 'main-mode');
      await startDebuggee(debuggee(), { mode: MODE.plain });
      await recorder.waitForStops(1);
      const capabilities = recorder.capabilities();

      // Interaction 2 — the filter set: "all" plus an unhandled-only filter.
      const filters = advertisedExceptionFilters(capabilities);
      assert.ok(
        filters.includes(FILTER_ALL),
        `"Break on all CLR exceptions" is P1; an '${FILTER_ALL}' filter must be advertised. ` +
          `Advertised: ${filters.join(', ') || '<none>'}`,
      );
      assert.ok(
        filters.some((filter) => UNHANDLED_FILTER_IDS.includes(filter)),
        '"Break on unhandled exceptions only" is P1; one of ' +
          `${UNHANDLED_FILTER_IDS.join('/')} must be advertised. Advertised: ${filters.join(', ')}`,
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
    },
  );

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on all CLR exceptions | P1".
  debugTest(
    'breaking on ALL exceptions catches a throw the program handles itself',
    debuggee,
    async ({ fixture, recorder }) => {
      // Interaction 1 — stop early so the filters can be configured before the throw.
      const { session } = await stopInFrame(
        debuggee(),
        'main-mode',
        'Main',
        'the gate breakpoint',
        {
          mode: MODE.caught,
        },
      );

      // Interaction 2 — tick "All Exceptions".
      const response = await dap(session, 'setExceptionBreakpoints', { filters: [FILTER_ALL] });
      eq(typeof response, 'object', '`setExceptionBreakpoints` must answer');
      await pushExceptionFilters(
        session,
        recorder,
        [FILTER_ALL],
        'the filter change must reach the adapter carrying the ticked filter. Counting the ' +
          'requests instead cannot see that: the workbench opens every session with a ' +
          '`setExceptionBreakpoints` of its own, so a count is satisfied before the suite ' +
          'has sent anything at all',
      );

      // Interaction 3 — continue. The FIRST-CHANCE throw must stop the debuggee,
      // even though the program catches it two lines later, and the panel must
      // identify what was thrown.
      const { stop, info } = await stopOnThrow(
        recorder,
        session,
        fixture,
        'throw-caught',
        'ThrowCaught',
        CAUGHT_TYPE,
        CAUGHT_MESSAGE,
        '"Break on all CLR exceptions" must stop on the THROW statement, before the catch ' +
          'block runs — stopping in the catch, or not at all, is the non-conforming behaviour',
      );
      eq(
        info.breakMode,
        'always',
        'a stop produced by the "all" filter must report breakMode `always`; `unhandled` here ' +
          'means the adapter broke for a different reason than the one the user selected',
      );
      const frames = await stackFrames(session, stop.threadId);
      deepEq(
        frames.slice(0, 2).map((frame) => methodOf(frame)),
        ['ThrowCaught', 'Main'],
        'the call stack at an exception stop must be the throwing stack, not the catch site',
      );

      // Interaction 5 — continue: the program handles it and finishes normally.
      await continueToCompletion(recorder, 'a handled exception');
      await recorder.waitForOutput(`handled ${CAUGHT_MESSAGE}`);
      eq(
        recorder.stops().filter((stop) => stop.reason === 'exception').length,
        1,
        'the program throws exactly once in `caught` mode, so exactly one exception stop',
      );
      assertCleanSession(debuggee(), 'break on all exceptions');
    },
  );

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on unhandled exceptions only"
  // and "Break on exceptions from user code only" — the IGNORING half.
  debugTest(
    'with only the unhandled filter, a handled throw is ignored completely',
    debuggee,
    async ({ recorder }) => {
      // Interaction 1 — gate, then select ONLY the unhandled-style filter.
      const { session } = await runToFirstStop(debuggee(), 'main-mode', { mode: MODE.caught });
      const unhandled = requireUnhandledFilterId(recorder);
      await pushExceptionFilters(
        session,
        recorder,
        [unhandled],
        'exactly the selected filter is sent; sending `all` alongside it would break on ' +
          'everything and the user would have no way to get the behaviour they asked for',
      );

      // Interaction 2 — continue. The handled throw must NOT stop the debuggee,
      // and the program RAN, to its own end, through the catch block and past it.
      await assertRunsPastHandledThrow(
        recorder,
        'an ignored, handled exception',
        'a throw the program CATCHES must be invisible when only the unhandled filter is ' +
          'selected. Breaking here is the defect that makes a debugger useless on any codebase ' +
          'that uses exceptions for control flow',
      );

      // Interaction 5 - the SELECTION is still the one that was asked for. A
      // later `setExceptionBreakpoints` that quietly re-adds `all` would produce
      // this test's result only until the next continue, and nothing else can see
      // it ([DEBUG-FEATURES-EXCEPTIONS]).
      const requests = recorder.requests('setExceptionBreakpoints');
      const last = requests[requests.length - 1];
      assert.ok(last, 'at least one setExceptionBreakpoints reached the adapter');
      deepEq(last.args['filters'], [unhandled], 'and the last one still names only that filter');
      assert.ok(
        !JSON.stringify(last.args['filters']).includes('"all"'),
        'with `all` never smuggled back in alongside it',
      );

      assertCleanSession(debuggee(), 'ignoring a handled exception');
    },
  );

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Exception info panel (type, message,
  // stack)" P1 and "Inner exception chain traversal" P2.
  debugTest(
    'an unhandled exception breaks with its type, message, stack and inner cause',
    debuggee,
    async ({ fixture, recorder }) => {
      // Interaction 1 — gate, then select the unhandled filter and run into the throw.
      const { session } = await runToFirstStop(debuggee(), 'main-mode', { mode: MODE.unhandled });
      const unhandled = requireUnhandledFilterId(recorder);
      await pushExceptionFilters(session, recorder, [unhandled], 'the selected filter is sent');

      // Interaction 2 — continue into the unhandled throw; the panel must carry
      // type and message.
      const { stop, info } = await stopOnThrow(
        recorder,
        session,
        fixture,
        'throw-unhandled',
        'ThrowUnhandled',
        UNHANDLED_TYPE,
        UNHANDLED_MESSAGE,
        'an unhandled exception must stop the debuggee at the throw, with the stack intact — ' +
          'letting the process die first leaves nothing to inspect',
      );
      assert.ok(
        info.stackTrace.includes('ThrowUnhandled'),
        `the panel's stackTrace must name the throwing method; got: ${info.stackTrace}`,
      );
      assert.ok(
        info.breakMode.length > 0,
        'DAP requires a breakMode on every exceptionInfo response',
      );

      // Interaction 4 — the inner exception chain (P2).
      deepEq(
        info.innerMessages,
        [INNER_MESSAGE],
        '"Inner exception chain traversal" is a specified row: the `ApplicationException` was ' +
          'constructed with a `FormatException` cause, and an empty chain means the user cannot ' +
          'see WHY the outer exception was thrown',
      );

      // Interaction 5 — the stack must show who called the throwing method.
      const frames = await stackFrames(session, stop.threadId);
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
    },
  );

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Exception info panel (type,
  // message, stack) | P1" and "Inner exception chain traversal | P2" together
  // with [DEBUG-FEATURES-STACK]: the panel is only useful if the STACK behind
  // the exception is the user own, at the throw site.
  debugTest(
    'an exception stop carries the throwing frame and the whole user stack',
    debuggee,
    async ({ fixture, recorder }) => {
      // Interaction 1 — break on every throw, in the mode that throws twice.
      const session = await stopWithAllFilter(debuggee());
      assert.ok(
        advertisedExceptionFilters(recorder.capabilities()).includes(FILTER_ALL),
        'the "all exceptions" checkbox must be offered before it can be ticked',
      );

      // Interaction 2 — the first throw. The panel fields, and the frame the
      // throw happened in.
      const { stop, info } = await stopOnThrow(
        recorder,
        session,
        fixture,
        'throw-caught',
        'ThrowCaught',
        CAUGHT_TYPE,
        CAUGHT_MESSAGE,
        'an exception stop must park on the THROW, not on the catch that follows it',
      );
      neq(info.description, '', 'the panel needs a description to render');
      const frames = await stackFrames(session, stop.threadId);
      assert.ok(frames.length >= 2, 'the throwing method was called from somewhere');
      eq(
        methodOf(requireAt(frames, 0, 'the throwing frame')),
        'ThrowCaught',
        'the innermost frame is the method that threw',
      );
      assert.ok(
        frames.map((frame) => methodOf(frame)).includes('Main'),
        'and the caller chain up to Main is intact, which is how the user finds the cause',
      );

      // Interaction 3 — the SECOND throw carries its own type, its own message
      // and its own inner cause. Reporting the first exception again is the
      // failure a single-throw fixture cannot see.
      const { info: secondInfo } = await stopOnThrow(
        recorder,
        session,
        fixture,
        'throw-unhandled',
        'ThrowUnhandled',
        UNHANDLED_TYPE,
        UNHANDLED_MESSAGE,
        'the second throw parks on its own statement and the panel reports IT, not the first',
      );
      neq(
        secondInfo.exceptionId,
        info.exceptionId,
        'the two throws are different exceptions and must report different ids',
      );
      assert.ok(
        secondInfo.description.includes(INNER_MESSAGE) ||
          secondInfo.description.includes(UNHANDLED_MESSAGE),
        '"Inner exception chain traversal" is a specified row: the panel must carry the cause, ' +
          'or the user sees a wrapper and never the real failure',
      );
      eq(
        recorder.stops().filter((entry) => entry.reason === 'exception').length,
        2,
        'exactly two exception stops for two throws',
      );
    },
  );

  // Implements [DEBUG-FEATURES-EXCEPTIONS] with the reactivity every screen in
  // this project owes: unticking "All Exceptions" mid-session must reach the
  // LIVE adapter, not wait for the next launch - and no filter can silence an
  // UNHANDLED throw, because there is nothing after it to continue to.
  debugTest(
    'unticking every exception filter mid-session reaches the adapter, and only the crash still stops',
    debuggee,
    async ({ fixture, recorder }) => {
      // Interaction 1 — break on all, and prove it by catching the first throw.
      const session = await stopWithAllFilter(debuggee());
      await stopOnThrow(
        recorder,
        session,
        fixture,
        'throw-caught',
        'ThrowCaught',
        CAUGHT_TYPE,
        CAUGHT_MESSAGE,
        'the first throw with the filter on',
      );

      // Interaction 2 — untick everything WHILE paused, and prove the change
      // reached the adapter rather than being stored for the next launch.
      await pushExceptionFilters(
        session,
        recorder,
        [],
        'an empty filter list must be pushed to the LIVE adapter, sent and not merely remembered',
      );

      // Interaction 3 — continue. The handled throw is behind us and runs to its
      // catch; the UNHANDLED throw that follows stops whatever the filters say,
      // and it must be the ONLY further stop.
      const exceptionsSoFar = recorder
        .stops()
        .filter((entry) => entry.reason === 'exception').length;
      await stopOnThrow(
        recorder,
        session,
        fixture,
        'throw-unhandled',
        'ThrowUnhandled',
        UNHANDLED_TYPE,
        UNHANDLED_MESSAGE,
        'the only stop after unticking is the unhandled throw itself',
      );
      eq(
        recorder.stops().filter((entry) => entry.reason === 'exception').length,
        exceptionsSoFar + 1,
        'nothing but the crash may stop the debuggee once every filter is unticked',
      );
      assert.ok(
        recorder.outputText().includes('handled ' + CAUGHT_MESSAGE),
        'and the program really did carry on running past the handled throw',
      );
      deepEq(recorder.errors, [], 'with no adapter transport error');
    },
  );

  // Implements [DEBUG-FEATURES-EXCEPTIONS] "Break on all CLR exceptions" as the
  // NEGATIVE the section is really about: a program that throws nothing must
  // run to completion with the filter fully armed. A debugger that stops
  // anyway has made every clean run unusable.
  debugTest(
    'with every filter armed, a program that throws nothing still runs clean',
    debuggee,
    async ({ recorder }) => {
      // Interaction 1 — arm every advertised filter at once.
      const { session } = await runToFirstStop(debuggee(), 'main-mode');
      const filters = advertisedExceptionFilters(recorder.capabilities());
      assert.ok(
        filters.length >= 2,
        'at least an all filter and an unhandled-only one are offered',
      );
      assert.ok(filters.includes(FILTER_ALL), 'including "break on all"');
      assert.ok(
        filters.some((filter) => UNHANDLED_FILTER_IDS.includes(filter)),
        'and an unhandled-only filter under one of the names adapters use',
      );

      // Interaction 2 — send them all, and check the request really carried them.
      await pushExceptionFilters(
        session,
        recorder,
        filters,
        'every advertised filter is armed at once',
      );

      // Interaction 3 — the clean run must stay clean.
      const stopsBefore = recorder.stops().length;
      await continueToCompletion(recorder, 'a clean run with every exception filter armed');
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
    },
  );
});
