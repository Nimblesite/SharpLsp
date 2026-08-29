// Conditional breakpoints, hit-count breakpoints and logpoints.
//
// Implements the three conditional rows of [DEBUG-FEATURES-BREAKPOINTS]:
// "Conditional breakpoints (C# expression) | setBreakpoints (condition) | P1",
// "Hit-count breakpoints | setBreakpoints (hitCondition) | P1" and
// "Logpoints (tracepoints) | setBreakpoints (logMessage) | P1", together with
// that section's logpoint-emulation rules and the `supportsConditionalBreakpoints`
// / `supportsHitConditionalBreakpoints` / `supportsLogPoints` rows of
// [DEBUG-PROTOCOL-CAPABILITIES].
//
// Half of what these features promise is a NEGATIVE: a condition that does not
// hold must leave the program running, and a logpoint must never pause it. Both
// are asserted by settling and finding no further stop — never by "a stop
// happened", which is satisfied by a debugger that ignores conditions entirely.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  assertStopReason,
  assertStoppedAt,
  localsOf,
  topFrame,
  variableNamed,
} from './debug-drive-kit';
import {
  assertCleanSession,
  assertRanToCompletion,
  breakpointAt,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { deepEq, eq, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS } from './test-timeouts';

/** The `breakpoints` entries of the most recent `setBreakpoints` request. */
function sentBreakpoints(
  requests: readonly { args: Record<string, any> }[],
): Record<string, any>[] {
  const last = requests[requests.length - 1]?.args ?? {};
  const list: unknown = last['breakpoints'];
  assert.ok(Array.isArray(list), '`setBreakpoints` must carry a breakpoints array');
  return list as Record<string, any>[];
}

/** How many times the fixture's `Add` call site is reached in one run. */
const LOOP_ITERATIONS = 3;

suite('Debug breakpoints — conditions, hit counts and logpoints', () => {
  const debuggee = useDebuggee('debug-bpcond-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Conditional breakpoints (C# expression)".
  test('a condition decides the stop: true stops once, false never stops', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — arm a condition that becomes true on the LAST iteration only.
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { condition: 'index == 3' }),
    ]);
    const armed = requireAt(vscode.debug.breakpoints, 0, 'the conditional breakpoint');
    eq(armed.condition, 'index == 3', 'the workbench holds the condition the user typed');
    eq(armed.hitCondition, undefined, 'a condition is not a hit count');
    eq(armed.logMessage, undefined, 'a condition is not a logpoint');

    // Interaction 2 — launch. The adapter must claim the capability, and the
    // condition must reach it: a condition dropped in transit turns a
    // conditional breakpoint into an unconditional one.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    eq(
      recorder.capabilities()['supportsConditionalBreakpoints'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsConditionalBreakpoints as Yes for Phase 4; ' +
        'without it VS Code never forwards the condition and the breakpoint stops every time',
    );
    deepEq(
      sentBreakpoints(recorder.requests('setBreakpoints')).map((entry) => entry['condition']),
      ['index == 3'],
      'the C# expression must be forwarded verbatim to the adapter',
    );

    // Interaction 3 — exactly ONE stop, on the iteration the condition selects.
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the condition becomes true on the third iteration, so the debuggee stops');
    assertStopReason(stop, 'breakpoint', 'a conditional-breakpoint stop');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'accumulate-call', 'Accumulate', 'the conditional breakpoint');
    const locals = await localsOf(session, frame.id);
    eq(
      variableNamed(locals, 'index').value,
      '3',
      'the stop must happen on the iteration the CONDITION names, not on the first one',
    );
    eq(
      variableNamed(locals, 'running').value,
      '5',
      'two iterations must already have run: 2 -> 3 -> 5, with 8 still to come',
    );
    await recorder.assertNoFurtherStop(1, 'a condition true on ONE iteration stops exactly once');

    // Interaction 4 — replace it with a condition that is never true.
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { condition: 'index == 99' }),
    ]);
    const baseline = recorder.stops().length;
    await vscode.commands.executeCommand('workbench.action.debug.continue');
    await assertRanToCompletion(recorder, 0, 'a never-true condition');
    await recorder.waitForOutput('done plain 45');
    eq(
      recorder.stops().length,
      baseline,
      'a condition that never holds must leave the program running to completion — this is ' +
        'the whole point of a conditional breakpoint and the half that silently regresses',
    );
    assertCleanSession(debuggee(), 'conditional breakpoints');
  });

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Hit-count breakpoints", including
  // the `>`, `>=`, `<`, `<=`, `==` and `%` operator set that section names.
  test('a hit count selects which visit stops, plainly and relationally', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a plain count: stop on the third visit only.
    vscode.debug.addBreakpoints([breakpointAt(fixture, 'accumulate-call', { hitCondition: '3' })]);
    eq(
      requireAt(vscode.debug.breakpoints, 0, 'the hit-count breakpoint').hitCondition,
      '3',
      'the workbench holds the hit count the user typed',
    );
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    eq(
      recorder.capabilities()['supportsHitConditionalBreakpoints'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsHitConditionalBreakpoints as Yes for Phase 4',
    );
    deepEq(
      sentBreakpoints(recorder.requests('setBreakpoints')).map((entry) => entry['hitCondition']),
      ['3'],
      'the hit condition must be forwarded to the adapter, not evaluated in the editor',
    );

    // Interaction 2 — the stop must be the THIRD visit, not the first.
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'a hit count of 3 must stop on the third visit to the line');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'accumulate-call', 'Accumulate', 'the hit-count breakpoint');
    const locals = await localsOf(session, frame.id);
    eq(
      variableNamed(locals, 'index').value,
      '3',
      'stopping on the FIRST visit means the hit count was ignored entirely',
    );
    await recorder.assertNoFurtherStop(1, 'a hit count of 3 stops once in a three-iteration loop');

    // Interaction 3 — run it out, then rearm relationally: `>= 2`.
    await vscode.commands.executeCommand('workbench.action.debug.continue');
    await assertRanToCompletion(recorder, 0, 'the plain hit-count run');
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { hitCondition: '>= 2' }),
    ]);

    // Interaction 4 — a second session: `>= 2` must stop on visits 2 and 3.
    // The recorder is per-TEST, so this interaction's stops sit AFTER the
    // plain-count run's on the same tape — wait past that baseline and read
    // only this session's stops.
    const relational = debuggee();
    const baseline = relational.recorder.stops().length;
    const secondSession = await startDebuggee(relational, { mode: MODE.plain });
    const firstVisit = (await relational.recorder.waitForStops(baseline + 1)).slice(baseline);
    const secondFrame = await topFrame(
      secondSession,
      requireAt(firstVisit, 0, 'the first stop').threadId,
    );
    eq(
      variableNamed(await localsOf(secondSession, secondFrame.id), 'index').value,
      '2',
      'the first `>= 2` stop is the SECOND visit',
    );

    // The SECOND of the two stops is only reachable once the debuggee is
    // resumed: a program paused on visit 2 can never reach visit 3 by itself.
    // Its frame is read above, before the resume invalidates it.
    await vscode.commands.executeCommand('workbench.action.debug.continue');
    const stops = await relational.recorder.waitForStops(baseline + 2);
    const sessionStops = stops.slice(baseline);
    eq(
      sessionStops.length,
      LOOP_ITERATIONS - 1,
      '`>= 2` must stop on every visit from the second on: two of three iterations',
    );
    assertCleanSession(relational, 'hit-count breakpoints');
  });

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Logpoints (tracepoints)" and its
  // Phase-4 emulation rules: evaluate, emit as an `output` event, never pause.
  test('a logpoint logs the interpolated message and never pauses the debuggee', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — arm a logpoint referencing two frame locals.
    const message = 'trace running={running} index={index}';
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { logMessage: message }),
    ]);
    const armed = requireAt(vscode.debug.breakpoints, 0, 'the logpoint');
    eq(armed.logMessage, message, 'the workbench holds the log message the user typed');
    eq(armed.condition, undefined, 'a logpoint is authored as a message, not a condition');

    // Interaction 2 — launch; the adapter must claim logpoint support and be
    // given the message.
    await startDebuggee(debuggee(), { mode: MODE.plain });
    eq(
      recorder.capabilities()['supportsLogPoints'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsLogPoints as Yes (emulated) for Phase 4. ' +
        '[DEBUG-ADAPTER-GAPS] records that netcoredbg has none, so [DEBUG-ARCHITECTURE-ROUTER] ' +
        'makes the DapRouter responsible for rewriting them — an unadvertised capability ' +
        'means VS Code silently downgrades the logpoint to a normal breakpoint',
    );
    deepEq(
      sentBreakpoints(recorder.requests('setBreakpoints')).map((entry) => entry['logMessage']),
      [message],
      'the log message must reach the adapter layer that emulates it',
    );

    // Interaction 3 — the program must run to completion WITHOUT ever pausing.
    await assertRanToCompletion(recorder, 0, 'a logpoint-only session');
    deepEq(
      recorder.stops().map((stop) => `${stop.reason}@${stop.description}`),
      [],
      'a logpoint MUST NOT pause: "Returns false so execution is never paused" is the ' +
        'literal Phase-4 emulation rule of [DEBUG-FEATURES-BREAKPOINTS]',
    );

    // Interaction 4 — the interpolated text must have been emitted as output,
    // once per visit, with the frame-local values substituted.
    const output = recorder.outputText();
    for (const expected of [
      'trace running=2 index=1',
      'trace running=3 index=2',
      'trace running=5 index=3',
    ]) {
      eq(
        output.includes(expected),
        true,
        `the logpoint must emit '${expected}' as a DAP output event; the emulation rule is to ` +
          'evaluate the interpolated string against frame locals and surface it as output. ' +
          `Output seen: ${JSON.stringify(output)}`,
      );
    }
    eq(
      output.includes('{running}'),
      false,
      'an un-interpolated placeholder means the message was logged verbatim instead of evaluated',
    );
    await recorder.waitForOutput('done plain 45');
    assertCleanSession(debuggee(), 'a logpoint run');
  });
});
