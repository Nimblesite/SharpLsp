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
  CMD_CONTINUE,
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
import { DEBUG_TEST_MS } from './test-timeouts';

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
    this.timeout(DEBUG_TEST_MS);
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
    this.timeout(DEBUG_TEST_MS);
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
    this.timeout(DEBUG_TEST_MS);
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

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Conditional breakpoints (C#
  // expression)" with a condition over MORE THAN ONE local, and a condition
  // that is never true. The T1/T2 evaluation tiers apply to a breakpoint
  // condition exactly as they do to a watch: it is the same evaluator.
  test('a condition over several locals selects exactly the visit it names', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a condition combining the loop variable and the running
    // total. It is true on exactly one of the three passes.
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { condition: 'index == 2 && running > 1' }),
    ]);
    eq(vscode.debug.breakpoints.length, 1, 'one conditional breakpoint is armed');
    const armed = requireAt(vscode.debug.breakpoints, 0, 'the conditional breakpoint');
    assert.ok(armed instanceof vscode.SourceBreakpoint, 'armed as a source breakpoint');
    eq(armed.condition, 'index == 2 && running > 1', 'carrying the expression the user typed');
    eq(armed.hitCondition, undefined, 'and no hit count - this is an expression condition');

    // Interaction 2 — the condition must reach the ADAPTER verbatim. A
    // condition the workbench evaluates itself would stop and resume on every
    // pass, which is visible as a stutter and wrong on any hot loop.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the condition holds on one pass, so the debuggee must stop once');
    const sent = sentBreakpoints(recorder.requests('setBreakpoints'));
    eq(sent.length, 1, 'one breakpoint was synced');
    eq(
      String(sent[0]?.['condition'] ?? ''),
      'index == 2 && running > 1',
      'and its condition travelled to the adapter unchanged',
    );
    eq(
      recorder.capabilities()['supportsConditionalBreakpoints'],
      true,
      'supportsConditionalBreakpoints is a Phase 4 Yes; without it VS Code never sends one',
    );

    // Interaction 3 — the stop really is the pass the condition names, and it
    // is the ONLY stop the run produces.
    assertStopReason(stop, 'breakpoint', 'a multi-local conditional breakpoint');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'accumulate-call', 'Accumulate', 'the selected pass');
    const locals = await localsOf(session, frame.id);
    eq(variableNamed(locals, 'index').value, '2', 'stopped on the pass the condition selects');
    eq(variableNamed(locals, 'running').value, '3', 'with the accumulator the condition required');
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a multi-local conditional breakpoint');
    eq(
      recorder.stops().length,
      1,
      'the loop runs ' +
        String(LOOP_ITERATIONS) +
        ' times and the condition holds on ONE of ' +
        'them, so exactly one stop',
    );
    assertCleanSession(debuggee(), 'a multi-local condition');
  });

  // The negative half of the same row: a condition that can never hold must
  // leave the program running. A debugger that stops anyway has turned a
  // conditional breakpoint into a plain one, silently.
  test('a condition that never holds never stops, and never errors the session', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a condition over a real local that is never true.
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { condition: 'index == 99' }),
      breakpointAt(fixture, 'main-done'),
    ]);
    eq(vscode.debug.breakpoints.length, 2, 'one impossible condition, one plain gate at the end');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const sent = sentBreakpoints(recorder.requests('setBreakpoints'));
    eq(sent.length, 2, 'both breakpoints are synced in one request');
    eq(
      sent.filter((entry) => String(entry['condition'] ?? '') !== '').length,
      1,
      'exactly one of them carries a condition; the plain gate must not inherit it',
    );

    // Interaction 2 — the run must reach the LATER, unconditional gate, which
    // proves the loop really executed and the condition really was evaluated.
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the run must reach the unconditional gate at the end of the program');
    assertStopReason(stop, 'breakpoint', 'the unconditional gate');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-done',
      'Main',
      'the first stop of the run is the UNCONDITIONAL gate; stopping in the loop first means ' +
        'the condition was ignored and the breakpoint is really unconditional',
    );

    // Interaction 3 — and nothing else stopped on the way.
    eq(
      recorder.stops().length,
      1,
      'a condition that never holds must produce no stop at all, however many times its line ' +
        'is reached',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session with an impossible condition');
    eq(recorder.stops().length, 1, 'and no stop after the gate either');
    deepEq(
      recorder.errors,
      [],
      'an expression that is merely FALSE is not an evaluation failure, and must not error ' +
        'the transport',
    );
    assertCleanSession(debuggee(), 'an impossible condition');
  });

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Hit-count breakpoints" across the
  // operator set the section names: ">", ">=", "<", "<=", "==" and "%". A hit
  // condition that only understands a bare number is half the feature.
  test('a hit condition using a relational operator selects the passes it names', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — ">= 2" over a line reached three times: passes two and
    // three must stop, pass one must not.
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'accumulate-call', { hitCondition: '>= 2' }),
    ]);
    const armed = requireAt(vscode.debug.breakpoints, 0, 'the hit-count breakpoint');
    assert.ok(armed instanceof vscode.SourceBreakpoint, 'armed as a source breakpoint');
    eq(armed.hitCondition, '>= 2', 'carrying the relational hit condition the user typed');
    eq(armed.condition, undefined, 'a hit count is not an expression condition');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });

    // Interaction 2 — the condition reaches the adapter, and the FIRST stop is
    // the second pass, not the first.
    const [first] = await recorder.waitForStops(1);
    assert.ok(first, 'the debuggee must stop on the second pass');
    const sent = sentBreakpoints(recorder.requests('setBreakpoints'));
    eq(String(sent[0]?.['hitCondition'] ?? ''), '>= 2', 'the hit condition travelled verbatim');
    eq(
      recorder.capabilities()['supportsHitConditionalBreakpoints'],
      true,
      'and the adapter advertises the capability that carries it',
    );
    const firstFrame = await topFrame(session, first.threadId);
    eq(
      variableNamed(await localsOf(session, firstFrame.id), 'index').value,
      '2',
      '">= 2" must skip the FIRST pass; stopping on it means the operator was ignored and the ' +
        'condition read as a plain "stop always"',
    );

    // Interaction 3 — and the third pass stops too, because ">= 2" selects
    // every pass from the second onward, not only the second.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    const second = requireAt(await recorder.waitForStops(2), 1, 'the third-pass stop');
    assertStopReason(second, 'breakpoint', 'the third pass');
    const secondFrame = await topFrame(session, second.threadId);
    eq(
      variableNamed(await localsOf(session, secondFrame.id), 'index').value,
      '3',
      'the third pass stops as well - ">= 2" is a RANGE, not an equality',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a relational hit condition');
    eq(
      recorder.stops().length,
      2,
      'the line is reached ' + String(LOOP_ITERATIONS) + ' times and ">= 2" selects two of them',
    );
    assertCleanSession(debuggee(), 'a relational hit condition');
  });
});
