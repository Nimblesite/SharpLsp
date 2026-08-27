// Expression evaluation and value editing: hover, the Watch panel, the Debug
// Console, `setVariable`, and `[DebuggerDisplay]`.
//
// Implements the evaluation rows of [DEBUG-FEATURES-VARIABLES] — "Modify
// variable value at runtime | setVariable | P1", "Hover expression evaluation |
// evaluate (hover) | P1", "Watch window evaluation | evaluate (watch) | P1",
// "Immediate window / REPL | evaluate (repl) | P2", "[DebuggerDisplay]
// attribute rendering | P1" — together with the T1/T2 rows of that section's
// "Expression evaluation quality tiers" table, which Phase 4 must already serve.
//
// The tier table is the reason each expression here is labelled: T1 (field
// access, arithmetic, casts, null checks) and T2 (method calls on locals) are
// marked "Works" for Phase 4 (netcoredbg). T3 — LINQ, multi-statement lambdas —
// is marked "Fails" for Phase 4 and is therefore NOT asserted here.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  assertStoppedAt,
  evaluate,
  localsOf,
  localsScopeOf,
  topFrame,
  variableNamed,
} from './debug-drive-kit';
import { dap, tryDap } from './debug-dap-kit';
import {
  armBreakpoints,
  assertCleanSession,
  assertRanToCompletion,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { BUILD_TIMEOUT_MS } from './run-debug-kit';
import { deepEq, eq } from './test-helpers';

/** T1 expressions: field access, arithmetic, casts, null checks. All "Works". */
const TIER_ONE: readonly { expression: string; expected: string; kind: string }[] = [
  { expression: 'box.Value', expected: '8', kind: 'T1 simple field/property access' },
  { expression: 'numbers.Count', expected: '3', kind: 'T1 simple field/property access' },
  { expression: 'box.Value + 1', expected: '9', kind: 'T1 arithmetic' },
  { expression: 'text == null', expected: 'false', kind: 'T1 null check' },
  { expression: '(long)box.Value', expected: '8', kind: 'T1 type cast' },
];

suite('Debug evaluation — hover, watch, REPL, setVariable and DebuggerDisplay', () => {
  const debuggee = useDebuggee('debug-eval-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-VARIABLES] "Hover expression evaluation" (P1),
  // "Watch window evaluation" (P1) and "Immediate window / REPL" (P2).
  test('the same expression answers identically in hover, watch and the REPL', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop where every operand is in scope.
    armBreakpoints(fixture, 'inspect-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the print statement');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'inspect-print', 'Inspect', 'the evaluation frame');
    eq(
      recorder.capabilities()['supportsEvaluateForHovers'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsEvaluateForHovers as Yes for Phase 4; ' +
        'without it VS Code never asks the adapter and hovering a variable shows nothing',
    );

    // Interaction 2 — every T1 expression, in the WATCH context.
    for (const { expression, expected, kind } of TIER_ONE) {
      const watched = await evaluate(session, expression, frame.id, 'watch');
      eq(
        watched.value,
        expected,
        `${kind}: the "Expression evaluation quality tiers" table marks this row "Works" for ` +
          `Phase 4, so \`${expression}\` must evaluate to ${expected}; got '${watched.value}'`,
      );
    }

    // Interaction 3 — hover must agree with watch, expression for expression.
    const hovered: string[] = [];
    for (const { expression } of TIER_ONE) {
      hovered.push((await evaluate(session, expression, frame.id, 'hover')).value);
    }
    deepEq(
      hovered,
      TIER_ONE.map((entry) => entry.expected),
      'hover and watch must not disagree: they are the same `evaluate` request with a ' +
        'different `context`, and a divergence means one of the two is reading a stale frame',
    );

    // Interaction 4 — the REPL must serve the same frame (P2 row).
    const repl = await evaluate(session, 'box.Value', frame.id, 'repl');
    eq(
      repl.value,
      '8',
      '"Immediate window / REPL | evaluate (repl)" is a specified row: the Debug Console must ' +
        'evaluate against the SELECTED frame, not against a fresh one',
    );

    // Interaction 5 — a T2 method call on a local.
    const called = await evaluate(session, 'box.Describe()', frame.id, 'watch');
    assert.ok(
      called.value.includes('boxed=8'),
      '"T2 | Method calls on locals" is marked "Works" for Phase 4: `box.Describe()` must ' +
        `return the rendered string; got '${called.value}'`,
    );
    assertCleanSession(debuggee(), 'evaluating expressions');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "Modify variable value at runtime |
  // setVariable | P1".
  test('setVariable changes the value the running program then uses', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop before the loop consumes the seed.
    armBreakpoints(fixture, 'accumulate-loop', 'main-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the loop header');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'accumulate-loop', 'Accumulate', 'before the loop runs');
    eq(
      recorder.capabilities()['supportsSetVariable'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsSetVariable as Yes for Phase 4 — without ' +
        'it the Variables panel offers no edit affordance at all',
    );
    eq(variableNamed(await localsOf(session, frame.id), 'running').value, '2', 'the seed is 2');

    // Interaction 2 — edit the local through the panel's own request.
    const scope = await localsScopeOf(session, frame.id);
    const written = await dap(session, 'setVariable', {
      variablesReference: scope.reference,
      name: 'running',
      value: '100',
    });
    eq(
      String(written['value']),
      '100',
      '`setVariable` must answer with the NEW value; echoing the old one leaves the panel ' +
        'showing a number the debuggee no longer holds',
    );

    // Interaction 3 — re-reading the panel must show the edit.
    eq(
      variableNamed(await localsOf(session, frame.id), 'running').value,
      '100',
      'the edit must be visible on the very next `variables` request',
    );

    // Interaction 4 — the PROGRAM must use the edited value: 100+1+2+3 = 106.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    const stops = await recorder.waitForStops(2);
    assert.ok(stops[1], 'the debuggee must reach the print statement');
    await recorder.waitForOutput('total=106');
    eq(
      recorder.outputText().includes('total=8'),
      false,
      'the ORIGINAL value must not have been used: a `setVariable` that only updates the ' +
        'panel, and not the debuggee, is the defect this row exists to prevent',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session whose local was edited');
    assertCleanSession(debuggee(), 'editing a variable at runtime');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "[DebuggerDisplay] attribute rendering
  // | variables | P1" and its Phase-4 emulation paragraph.
  test('[DebuggerDisplay] decides how an object renders in the panel', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop with the decorated object in scope.
    armBreakpoints(fixture, 'main-inspect');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the call to Inspect');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'main-inspect', 'Main', 'the DebuggerDisplay frame');

    // Interaction 2 — the panel must render the ATTRIBUTE's format.
    const box = variableNamed(await localsOf(session, frame.id), 'box');
    eq(
      box.value,
      'Box(boxed,8)',
      'the fixture type carries [DebuggerDisplay("Box({Label},{Value})")]. ' +
        '[DEBUG-ADAPTER-GAPS] records that netcoredbg does not render the attribute, and the ' +
        'Phase-4 emulation paragraph of [DEBUG-FEATURES-VARIABLES] makes the DapRouter + C# ' +
        `sidecar responsible for evaluating it and REPLACING the default value. Got '${box.value}'`,
    );
    assert.ok(
      box.reference > 0,
      'a DebuggerDisplay value must still be expandable — the attribute changes the summary ' +
        'line, it does not turn the object into a leaf',
    );

    // Interaction 3 — the raw members must still be reachable underneath.
    const members = await evaluate(session, 'box.Label', frame.id, 'watch');
    assert.ok(
      members.value.includes('boxed'),
      `the underlying members must stay evaluable; got '${members.value}'`,
    );

    // Interaction 4 — an expression the tier table marks "Fails" for Phase 4
    // must fail cleanly, never crash the session.
    const linq = await tryDap(session, 'evaluate', {
      expression: 'numbers.Where(n => n > 10).Count()',
      frameId: frame.id,
      context: 'watch',
    });
    eq(
      recorder.errors.length,
      0,
      'a T3 expression is marked "Fails" for Phase 4 and may be refused — but the refusal must ' +
        `be a DAP error response, not a transport failure. Adapter errors: ${JSON.stringify(
          recorder.errors,
        )}; evaluate reported: ${linq.failure}`,
    );
    eq(
      vscode.debug.activeDebugSession?.id,
      session.id,
      'a refused expression must leave the session alive and the debuggee still paused',
    );
    assertCleanSession(debuggee(), 'DebuggerDisplay rendering');
  });
});
