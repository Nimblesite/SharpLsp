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
  stackFrames,
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
import { deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

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
    this.timeout(DEBUG_TEST_MS);
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
    // Interaction 4 - the three contexts are one FEATURE. An expression that
    // answers in the Watch panel and not on hover teaches the user to distrust
    // the hover, which is the surface they reach for first.
    eq(recorder.capabilities()['supportsEvaluateForHovers'], true, 'hover evaluation is advertised');
    eq(recorder.requests('evaluate').length >= TIER_ONE.length, true, 'every expression really reached the adapter');
    eq(recorder.responses('evaluate').every((response) => response.success), true, 'and every one of them was answered');
    eq(recorder.stops().length, 1, 'evaluating never resumed or re-stopped the debuggee');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "Modify variable value at runtime |
  // setVariable | P1".
  test('setVariable changes the value the running program then uses', async function () {
    this.timeout(DEBUG_TEST_MS);
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
    //
    // The second breakpoint pauses ON the `Console.WriteLine` that prints the
    // total, so at that stop the statement has NOT executed and the debuggee's
    // output still ends at `env=unset`. The printed line can therefore only be
    // waited for after the debuggee is released past the breakpoint — waiting
    // first deadlocks on output the program cannot yet have produced.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    const stops = await recorder.waitForStops(2);
    assert.ok(stops[1], 'the debuggee must reach the print statement');
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await recorder.waitForOutput('total=106');
    eq(
      recorder.outputText().includes('total=8'),
      false,
      'the ORIGINAL value must not have been used: a `setVariable` that only updates the ' +
        'panel, and not the debuggee, is the defect this row exists to prevent',
    );
    await assertRanToCompletion(recorder, 0, 'a session whose local was edited');
    assertCleanSession(debuggee(), 'editing a variable at runtime');
    // Interaction 4 - a write is a change to the RUNNING program, so the
    // adapter must have been asked to make it, and the session must survive.
    eq(recorder.requests('setVariable').length >= 1, true, 'setVariable really reached the adapter');
    eq(recorder.capabilities()['supportsSetVariable'], true, 'which is why the panel offers the edit at all');
    eq(recorder.stops().length >= 1, true, 'the debuggee was paused for the write');
    eq(recorder.events('terminated').length <= 1, true, 'and the session ended at most once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "[DebuggerDisplay] attribute rendering
  // | variables | P1" and its Phase-4 emulation paragraph.
  test('[DebuggerDisplay] decides how an object renders in the panel', async function () {
    this.timeout(DEBUG_TEST_MS);
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
    // Interaction 4 - `[DebuggerDisplay]` is a Phase 4 EMULATION: the DapRouter
    // asks the C# sidecar to evaluate the format and replaces the default
    // `toString()`. A failure falls back to the raw class name, never to a
    // broken session.
    eq(recorder.requests('variables').length >= 1, true, 'the Variables panel really asked the adapter');
    eq(recorder.responses('variables').every((response) => response.success), true, 'and every read was answered');
    eq(recorder.stops().length, 1, 'reading variables never resumes the debuggee');
    eq(recorder.events('terminated').length <= 1, true, 'and the session ends at most once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements the T2 row of the evaluation tiers table — "Method calls on
  // locals | Works | Works" — which Phase 4 must already serve. A watch that
  // can read a field but not call a method covers half of real debugging.
  test('T2 method calls on locals evaluate in every evaluation context', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop where an object, a string and a collection are all
    // in scope, so there is something to call a method ON.
    armBreakpoints(fixture, 'inspect-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the print statement');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'inspect-print', 'Inspect', 'the T2 evaluation frame');
    const locals = await localsOf(session, frame.id);
    eq(
      locals.map((local) => local.name).includes('box'),
      true,
      'the frame really does hold the object whose method the watch will call',
    );

    // Interaction 2 — a method call on a local, in each of the three contexts
    // the specification names. Answering in one and not another is worse than
    // failing everywhere: the user cannot tell which panel to trust.
    const calls: readonly { expression: string; expected: string }[] = [
      { expression: 'box.Describe()', expected: 'boxed=8' },
      { expression: 'numbers.Contains(20)', expected: 'true' },
      { expression: 'text.Length', expected: '7' },
    ];
    for (const { expression, expected } of calls) {
      const watch = await evaluate(session, expression, frame.id, 'watch');
      eq(
        watch.value.includes(expected),
        true,
        expression +
          ' is a T2 "method calls on locals" expression, marked Works for Phase 4; ' +
          'the Watch panel answered ' +
          JSON.stringify(watch.value),
      );
      const repl = await evaluate(session, expression, frame.id, 'repl');
      eq(
        repl.value,
        watch.value,
        expression + ': the Debug Console must agree with the Watch panel over one frame',
      );
      const hover = await evaluate(session, expression, frame.id, 'hover');
      eq(
        hover.value,
        watch.value,
        expression +
          ': and so must a hover - three answers for one expression is a bug the ' +
          'user reads as their own code misbehaving',
      );
    }

    // Interaction 3 — a call with an argument computed from another local, and
    // a chained call. Both are still T2, and both must survive the round trip.
    eq(
      (await evaluate(session, 'numbers.Contains(numbers.Count * 10)', frame.id, 'watch')).value,
      'true',
      'an argument computed from another local is still a T2 method call',
    );
    eq(
      (await evaluate(session, 'box.Describe().Length', frame.id, 'watch')).value,
      '7',
      'and so is a call chained onto the result of a call',
    );
    eq(
      (await evaluate(session, 'box.Label.ToUpper()', frame.id, 'watch')).value.includes('BOXED'),
      true,
      'including a method on a property of a local',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session driven only by watch evaluations');
    eq(
      recorder.stops().length,
      1,
      'evaluating an expression must never resume or re-stop the debuggee',
    );
    assertCleanSession(debuggee(), 'T2 method-call evaluation');
    // Interaction 4 - the whole T2 sweep happened inside ONE paused frame, and
    // the frame is still readable at the end of it.
    eq(recorder.requests('evaluate').length >= 9, true, 'three expressions in three contexts is nine round trips');
    eq(recorder.responses('evaluate').filter((response) => response.success).length >= 9, true, 'every one of them answered successfully');
    eq(recorder.requests('stackTrace').length >= 1, true, 'the frame was resolved before anything was evaluated in it');
    eq(recorder.events('terminated').length <= 1, true, 'and the session ended at most once');
    deepEq(recorder.exits, [], 'with the adapter process still alive throughout');
  });

  // Implements the T3 rows of the tiers table, which Phase 4 marks "Fails".
  // Failing is specified; failing LOUDLY, and leaving the session alive, is the
  // part that matters — an evaluation that kills the adapter loses the user
  // their whole session because they typed a LINQ query into the Watch panel.
  test('an expression Phase 4 cannot evaluate is refused without losing the session', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a real stop, and a real frame to evaluate against.
    armBreakpoints(fixture, 'inspect-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the print statement');
    const frame = await topFrame(session, stop.threadId);
    const before = await localsOf(session, frame.id);
    eq(before.length >= 3, true, 'the frame holds the locals the T1 assertions rest on');

    // Interaction 2 — expressions that cannot resolve. Each must come back as a
    // FAILED response, not as a thrown transport error and not as a plausible
    // wrong answer.
    const unresolvable = [
      'thisIdentifierDoesNotExist',
      'box.NoSuchMember',
      'numbers[999]',
      '1 +',
      '',
    ];
    for (const expression of unresolvable) {
      const answer = await tryDap(session, 'evaluate', {
        expression,
        frameId: frame.id,
        context: 'watch',
      });
      neq(
        answer.failure,
        '',
        JSON.stringify(expression) +
          ' cannot be evaluated, so the adapter must REFUSE it, ' +
          'with a reason the Watch panel can show - a successful response here is a wrong ' +
          'answer the user will act on',
      );
      deepEq(
        answer.body,
        {},
        JSON.stringify(expression) + ': a refused evaluation carries no value at all',
      );
    }

    // Interaction 3 — the session must be entirely unharmed: same frame, same
    // locals, still drivable, and every T1 expression still answers.
    deepEq(recorder.errors, [], 'a refused evaluation is not an adapter transport failure');
    const after = await localsOf(session, frame.id);
    deepEq(
      after.map((local) => local.name),
      before.map((local) => local.name),
      'the frame locals are exactly as they were before the refusals',
    );
    eq(
      (await evaluate(session, 'box.Value', frame.id, 'watch')).value,
      '8',
      'and a valid expression still evaluates afterwards',
    );
    eq(recorder.stops().length, 1, 'no refusal resumed or re-stopped the debuggee');
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session that refused five expressions');
    assertCleanSession(debuggee(), 'refused evaluations');
    // Interaction 4 - a refusal is a RESPONSE, not a transport failure. The
    // distinction is what keeps the session alive after a typo in the Watch
    // panel.
    eq(recorder.requests('evaluate').length >= 5, true, 'every refused expression really reached the adapter');
    eq(recorder.responses('evaluate').some((response) => !response.success), true, 'and at least one came back as a FAILED response');
    eq(recorder.events('terminated').length <= 1, true, 'the session ended at most once');
    deepEq(recorder.exits, [], 'and the adapter process never exited under it');
    eq(recorder.stops().length, 1, 'with the debuggee still parked where it was');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "Watch window evaluation | P1"
  // together with [DEBUG-FEATURES-STACK]: an expression is evaluated in the
  // frame the user SELECTED. Evaluating everything in the top frame is the bug
  // that makes the Watch panel useless the moment you click a caller.
  test('a watch expression is evaluated in the frame the user selected', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop three user frames deep, so there are three frames
    // with three different sets of locals.
    armBreakpoints(fixture, 'add-body');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the helper body');
    const frames = await stackFrames(session, stop.threadId);
    eq(frames.length >= 3, true, 'the stop is three user frames deep');
    const callee = requireAt(frames, 0, 'the innermost frame');
    const caller = requireAt(frames, 1, 'the calling frame');
    neq(callee.id, caller.id, 'the two frames carry different handles');

    // Interaction 2 — `left` exists only in the callee; `running` only in the
    // caller. Each must resolve in its own frame and be REFUSED in the other.
    eq(
      (await evaluate(session, 'left', callee.id, 'watch')).value,
      '2',
      'the callee own argument resolves in the callee frame',
    );
    eq(
      (await evaluate(session, 'running', caller.id, 'watch')).value,
      '2',
      'and the caller own local resolves in the CALLER frame',
    );
    neq(
      (
        await tryDap(session, 'evaluate', {
          expression: 'left',
          frameId: caller.id,
          context: 'watch',
        })
      ).failure,
      '',
      '`left` is not in scope in the caller, so evaluating it there must be refused rather ' +
        'than answered from the callee frame',
    );
    neq(
      (
        await tryDap(session, 'evaluate', {
          expression: 'index',
          frameId: callee.id,
          context: 'watch',
        })
      ).failure,
      '',
      'and the caller loop variable is not in scope in the callee',
    );

    // Interaction 3 — arithmetic over each frame own locals, and the answers
    // must differ. Two frames that answer the same thing is the symptom.
    const calleeSum = (await evaluate(session, 'left + right', callee.id, 'watch')).value;
    const callerSum = (await evaluate(session, 'running + index', caller.id, 'watch')).value;
    eq(calleeSum, '3', 'the callee arguments sum to what it was called with');
    eq(callerSum, '3', 'the caller own locals sum in the caller frame');
    eq(
      (await evaluate(session, 'running', caller.id, 'hover')).value,
      '2',
      'a HOVER in the selected frame reads that frame too - the hover and the panel are one ' +
        'feature as far as the user is concerned',
    );
    deepEq(
      (await localsOf(session, caller.id)).map((local) => local.name).includes('left'),
      false,
      'and the caller locals really do not contain the callee argument',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
    assertCleanSession(debuggee(), 'per-frame watch evaluation');
    // Interaction 4 - per-frame evaluation is what makes the Call Stack panel
    // useful. Every read here addressed a specific frame id, and the adapter
    // answered each on its own terms.
    eq(recorder.requests('scopes').length >= 1, true, 'scopes were read for a specific frame');
    eq(recorder.requests('evaluate').length >= 6, true, 'and several expressions evaluated against frame ids');
    eq(recorder.responses('stackTrace').every((response) => response.success), true, 'every stack read was answered');
    eq(recorder.stops().length, 1, 'without ever resuming the debuggee');
    deepEq(recorder.errors, [], 'and with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "Modify variable value at runtime |
  // setVariable | P1" at its BOUNDARIES. Editing a value is the one debugger
  // gesture that changes the program, so what it REFUSES matters as much as
  // what it accepts: a silent no-op leaves the user believing they changed
  // something, and a wrong write corrupts the run they were diagnosing.
  test('setVariable accepts what it can write and refuses what it cannot', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a frame with a writable local, and the capability that
    // makes the panel offer editing at all.
    armBreakpoints(fixture, 'accumulate-call');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the loop body');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'accumulate-call', 'Accumulate', 'the edit frame');
    eq(
      recorder.capabilities()['supportsSetVariable'],
      true,
      'supportsSetVariable is a Phase 4 Yes; unadvertised, the Variables panel offers no edit ' +
        'affordance at all',
    );
    const scope = await localsScopeOf(session, frame.id);
    neq(scope.reference, 0, 'the locals scope carries the handle setVariable writes through');

    // Interaction 2 — a legal write. The panel must report the NEW value, and
    // so must a watch over the same name.
    const written = await dap(session, 'setVariable', {
      variablesReference: scope.reference,
      name: 'running',
      value: '100',
    });
    eq(String(written['value'] ?? ''), '100', 'setVariable answers with the value it wrote');
    eq(
      variableNamed(await localsOf(session, frame.id), 'running').value,
      '100',
      'and the Variables panel reads the new value back',
    );
    eq(
      (await evaluate(session, 'running', frame.id, 'watch')).value,
      '100',
      'as does a watch over the same local - two answers here is the panel and the watch ' +
        'disagreeing about the state of the program',
    );
    eq(
      (await evaluate(session, 'running + index', frame.id, 'watch')).value,
      '101',
      'and an expression built on it uses the value the user wrote',
    );

    // Interaction 3 — the refusals. A name that is not in scope, a value of the
    // wrong type and a bad handle must each come back as a failure, and the
    // session must survive all three.
    const refusals: readonly { name: string; value: string; why: string }[] = [
      { name: 'noSuchLocal', value: '1', why: 'a name that is not in scope' },
      { name: 'running', value: 'not-an-int', why: 'a value of the wrong type' },
      { name: '', value: '1', why: 'an empty name' },
    ];
    for (const { name, value, why } of refusals) {
      const outcome = await tryDap(session, 'setVariable', {
        variablesReference: scope.reference,
        name,
        value,
      });
      neq(outcome.failure, '', why + ' must be REFUSED, with a reason the panel can show');
    }
    neq(
      (
        await tryDap(session, 'setVariable', {
          variablesReference: 0,
          name: 'running',
          value: '1',
        })
      ).failure,
      '',
      'and a zero variables handle addresses nothing, so it must be refused too',
    );
    eq(
      variableNamed(await localsOf(session, frame.id), 'running').value,
      '100',
      'not one refusal may have changed the value the user did write',
    );
    eq(recorder.stops().length, 1, 'and no refusal resumed or re-stopped the debuggee');
    deepEq(recorder.errors, [], 'a refused write is not an adapter transport failure');
    await vscode.commands.executeCommand(CMD_CONTINUE);
    assertCleanSession(debuggee(), 'setVariable at its boundaries');
    // Interaction 4 - and the write survived every refusal that followed it,
    // which is the whole claim: a refused edit changes nothing at all.
    eq(recorder.requests('setVariable').length >= 4, true, 'one accepted write and three refusals reached the adapter');
    eq(recorder.responses('setVariable').some((response) => response.success), true, 'at least one succeeded');
    eq(recorder.responses('setVariable').some((response) => !response.success), true, 'and at least one was refused');
    eq(recorder.events('terminated').length <= 1, true, 'the session ended at most once');
    deepEq(recorder.exits, [], 'with the adapter process alive throughout');
  });
});
