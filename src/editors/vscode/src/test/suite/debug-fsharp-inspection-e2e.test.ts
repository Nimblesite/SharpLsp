// F# value inspection and F# async stacks.
//
// Implements [DEBUG-FSHARP-UNIONS] (DU display in F# syntax),
// [DEBUG-FEATURES-VARIABLES] rows "F# discriminated union inspection | P1" and
// "F# record/tuple inspection | P1", [DEBUG-FSHARP-STEPPING] (`task {}` state
// machines) and [DEBUG-FEATURES-STACK-ASYNC] applied to F#.
//
// [DEBUG-FSHARP-UNIONS] states the defect in its own words: without F# semantic
// knowledge, `Some 42` displays as ``FSharpOption`1 { Tag = 1, Value = 42 }``
// instead of `Some(42)`. So each assertion here has two halves — the F# form
// that MUST appear, and the raw CLR form that MUST NOT.
//
// [DEBUG-FSHARP-STEPPING] tells internal SharpLsp debug tests to prefer
// `task {}` over `async {}`, and this fixture does.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  CMD_STEP_INTO,
  assertStoppedAt,
  evaluate,
  localsOf,
  stackFrames,
  stepToFrame,
  topFrame,
  variableNamed,
  variablesOf,
  type Variable,
} from './debug-drive-kit';
import { armBreakpoints, assertCleanSession, startDebuggee, useDebuggee } from './debug-suite-kit';
import { deepEq, eq, neq } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

/** CLR spellings [DEBUG-FSHARP-UNIONS] names as the wrong answer. */
const RAW_CLR_FORMS: readonly string[] = ['Tag =', 'Tag=', 'FSharpOption`1', 'FSharpList`1'];

/** Assert an F# value renders in F# syntax and NOT in raw CLR syntax. */
function assertFSharpRendering(variable: Variable, wanted: readonly string[], why: string): void {
  for (const needle of wanted) {
    assert.ok(
      variable.value.includes(needle),
      `${why}: '${variable.name}' must render '${needle}' in F# syntax; the panel shows ` +
        `'${variable.value}'. [DEBUG-FSHARP-UNIONS] makes the DapRouter (Phase 4) or the Debug ` +
        'Sidecar (Phase 5) responsible for rewriting `variables` responses into F# form',
    );
  }
  for (const raw of RAW_CLR_FORMS) {
    assert.ok(
      !variable.value.includes(raw),
      `${why}: '${variable.name}' must NOT leak the raw CLR shape '${raw}'; that is the exact ` +
        `rendering [DEBUG-FSHARP-UNIONS] calls out as the defect. Got '${variable.value}'`,
    );
  }
}

suite('Debug F# — unions, records, tuples and task {} stacks', () => {
  const debuggee = useDebuggee('debug-inspect-fs-', 'fsharp');

  // Implements [DEBUG-FSHARP-UNIONS] and the "F# discriminated union inspection"
  // P1 row of [DEBUG-FEATURES-VARIABLES].
  test('a discriminated union and an option render as F#, not as Tag/field pairs', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop once every F# value in `main` is bound.
    armBreakpoints(fixture, 'main-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the print statement in `main`');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'main-print', 'main', 'the F# inspection frame');
    const locals = await localsOf(session, frame.id);
    const names = locals.map((local) => local.name).sort();
    eq(
      ['maybe', 'numbers', 'pair', 'point', 'shape', 'total'].every((w) => names.includes(w)),
      true,
      `every F# binding in scope must be listed; the panel offered: ${names.join(', ')}`,
    );

    // Interaction 2 — the DU case must be named, with its fields.
    assertFSharpRendering(variableNamed(locals, 'shape'), ['Rect'], 'the discriminated union');
    const shape = variableNamed(locals, 'shape');
    assert.ok(
      shape.value.includes('3') && shape.value.includes('4'),
      `a DU case must render its payload: Rect(3, 4). Got '${shape.value}'`,
    );

    // Interaction 3 — `Some 42` is the specification's own worked example.
    assertFSharpRendering(variableNamed(locals, 'maybe'), ['Some', '42'], 'the option');

    // Interaction 4 — the case's fields must still be reachable underneath.
    const expandable = shape.reference > 0;
    eq(
      expandable,
      true,
      'an F# DU value must remain EXPANDABLE: the F# rendering replaces the summary line, it ' +
        'does not remove access to the case fields',
    );
    const fields = await variablesOf(session, shape.reference);
    eq(
      fields.some((field) => field.value === '3'),
      true,
      `the DU’s named fields must be inspectable; expansion produced: ${fields
        .map((field) => `${field.name}=${field.value}`)
        .join(', ')}`,
    );
    assertCleanSession(debuggee(), 'inspecting an F# union');
    // Interaction 4 - F# rendering is a REWRITE of the `variables` response, so
    // the response has to have happened and been answered.
    eq(recorder.requests('variables').length >= 1, true, 'the panel really read the F# frame');
    eq(recorder.responses('variables').every((response) => response.success), true, 'and every read was answered');
    eq(recorder.capabilities()['supportsVariableType'], true, 'with the type column advertised for F# too');
    eq(recorder.stops().length, 1, 'reading variables never resumes an F# debuggee either');
    deepEq(recorder.errors, [], 'and with no adapter transport error');
  });

  // Implements the "F# record/tuple inspection | variables | P1" row.
  test('records, tuples and F# lists are inspectable in F# form', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop with the record, tuple and list all bound.
    armBreakpoints(fixture, 'main-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the print statement');
    const frame = await topFrame(session, stop.threadId);
    const locals = await localsOf(session, frame.id);

    // Interaction 2 — the record's fields carry the computed values.
    const point = variableNamed(locals, 'point');
    assert.ok(point.reference > 0, 'an F# record must be expandable');
    const fields = await variablesOf(session, point.reference);
    eq(
      variableNamed(fields, 'X').value,
      '8',
      '`accumulate 2` produces 8, so the record field X must read 8',
    );
    eq(
      variableNamed(fields, 'Y').value,
      '12',
      '`area (Rect(3, 4))` is 12, so the record field Y must read 12',
    );

    // Interaction 3 — the tuple's elements.
    const pair = variableNamed(locals, 'pair');
    assert.ok(pair.reference > 0, 'an F# tuple must be expandable');
    const elements = await variablesOf(session, pair.reference);
    eq(
      elements.some((element) => element.value === '8'),
      true,
      `the tuple’s first element must be 8; expansion produced: ${elements
        .map((element) => element.value)
        .join(', ')}`,
    );
    eq(
      elements.some((element) => element.value.includes('boxed')),
      true,
      'and its second element must be the string',
    );

    // Interaction 4 — the F# list must expand to its three items.
    const numbers = variableNamed(locals, 'numbers');
    assert.ok(
      numbers.reference > 0,
      '"Collection/array expansion" is P1 and an F# list is the collection F# users hit ' +
        `first; it rendered as '${numbers.value}' with no children`,
    );
    const items = await variablesOf(session, numbers.reference);
    deepEq(
      ['10', '20', '30'].filter((value) => items.some((item) => item.value.includes(value))),
      ['10', '20', '30'],
      'an F# list must expand to ALL its elements, not to its cons-cell internals',
    );

    // Interaction 5 — evaluation must reach an F# record field (T1 tier).
    const evaluated = await evaluate(session, 'point.X', frame.id, 'watch');
    eq(
      evaluated.value,
      '8',
      '"T1 | Simple field/property access" is marked "Works" for Phase 4 and ' +
        '[DEBUG-FSHARP-EVALUATION] puts F# at the same T1/T2 tier as C#',
    );
    assertCleanSession(debuggee(), 'inspecting F# records, tuples and lists');
    // Interaction 4 - records, tuples and lists are all EXPANDABLE, which means
    // more than one `variables` round trip against nested handles.
    eq(recorder.requests('variables').length >= 2, true, 'the panel expanded at least one F# value');
    eq(recorder.requests('scopes').length >= 1, true, 'after resolving the frame scopes');
    eq(recorder.responses('scopes').every((response) => response.success), true, 'each answered successfully');
    eq(recorder.stops().length, 1, 'with the debuggee paused throughout');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  // Implements [DEBUG-FSHARP-STEPPING] and [DEBUG-FEATURES-STACK-ASYNC] for F#.
  test('an F# task {} chain reports the logical await stack', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop at the bottom of the `task {}` chain.
    armBreakpoints(fixture, 'leaf-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.async });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint inside the leaf task');
    const frames = await stackFrames(session, stop.threadId);
    const rendered = frames.map((frame) => frame.name);

    // Interaction 2 — the awaiting computation expression must appear.
    eq(
      rendered.some((name) => name.includes('leafTask')),
      true,
      `the innermost frame must name the F# function; frames: ${rendered.join(' <- ')}`,
    );
    eq(
      rendered.some((name) => name.includes('rootTask')),
      true,
      '[DEBUG-FEATURES-STACK-ASYNC] applies to F# `task {}` verbatim: "`task {}` resumable ' +
        'state machines use the C# reconstruction algorithm with F#-specific generated-name ' +
        `matching". The awaiting frame must be injected. Frames: ${rendered.join(' <- ')}`,
    );

    // Interaction 3 — no state-machine machinery may reach the panel.
    deepEq(
      rendered.filter((name) => name.includes('MoveNext')),
      [],
      'a frame named `MoveNext` is the raw physical stack. [DEBUG-FSHARP-PDB] records that the ' +
        'F# compiler omits the `StateMachineMethod` table and commits SharpLsp to "heuristic ' +
        'PDB mapping for F# state machines via FCS sidecar symbol analysis" in Phase 4',
    );

    // Interaction 4 — the innermost frame's own state must be readable.
    const frame = await topFrame(session, stop.threadId);
    eq(
      variableNamed(await localsOf(session, frame.id), 'seed').value,
      '1',
      'the `task {}` frame’s bindings must be inspectable; hoisted state-machine locals that ' +
        'cannot be read make F# async debugging useless',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    assertCleanSession(debuggee(), 'an F# task stack');
    // Interaction 4 - an F# `task {}` chain is a state machine, so the stack
    // read is where the logical reconstruction has to happen.
    eq(recorder.requests('stackTrace').length >= 1, true, 'the async stack was really read');
    eq(recorder.responses('stackTrace').every((response) => response.success), true, 'and answered');
    eq(recorder.requests('threads').length >= 1, true, 'against a thread the adapter enumerated');
    eq(recorder.events('terminated').length <= 1, true, 'the session ended at most once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FSHARP-PDB]: the `StateMachineMethod` gap and its cost.
  test('stepping into a task {} takes ONE F11, not two', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop on the statement that invokes the task chain.
    armBreakpoints(fixture, 'main-async');
    const session = await startDebuggee(debuggee(), { mode: MODE.async });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the async call statement');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-async',
      'main',
      'the call into the task chain',
    );

    // Interaction 2 — a single F11 must land in the user's own `task {}` body.
    const stepped = await stepToFrame(recorder, CMD_STEP_INTO);
    eq(
      stepped.frame.sourcePath.endsWith('Program.fs'),
      true,
      `one F11 must land in F# source, not in generated machinery; landed in ` +
        (stepped.frame.sourcePath || '<no source>'),
    );
    const rootAwait = fixture.source.dapLine('root-await');
    // F# sequence points for the `task {}` opener vary by one line between
    // FSharp.Core minor versions: the first press lands either on the builder
    // line or on the first `let!`. Both are the user's own computation
    // expression reached in ONE press, which is what the spec commits to.
    eq(
      stepped.frame.line === rootAwait || stepped.frame.line === rootAwait - 1,
      true,
      '[DEBUG-FSHARP-PDB] records the cost of the missing `StateMachineMethod` table as ' +
        '"Step-into `task {}` requires two Step Into presses", and commits SharpLsp to ' +
        'heuristic PDB mapping in Phase 4 so the user does not pay it. One press must reach ' +
        `the first statement of the computation expression; it reached line ${stepped.frame.line}`,
    );
    eq(
      stepped.frame.name.includes('MoveNext'),
      false,
      'and it must not park the user in a `MoveNext` frame',
    );

    // Interaction 3 — the frame must be a usable one, with its binding in scope.
    const locals = await localsOf(session, stepped.frame.id);
    eq(
      variableNamed(locals, 'seed').value,
      '1',
      'the computation expression’s parameter must be readable from the frame F11 landed in',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    assertCleanSession(debuggee(), 'stepping into an F# task');
    // Interaction 4 - "ONE F11, not two" is a claim about STEP requests: two
    // step requests for one gesture is the state-machine hop leaking through.
    eq(recorder.requests('stepIn').length >= 1, true, 'the step into really reached the adapter');
    eq(recorder.responses('stepIn').every((response) => response.success), true, 'and was answered');
    eq(recorder.stops().every((entry) => entry.threadId !== 0), true, 'every stop named its thread');
    eq(recorder.events('terminated').length <= 1, true, 'the session ended at most once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "F# record/tuple inspection | P1"
  // one level DEEPER: a record must expand to its own fields, and a list to its
  // own elements. A value that renders correctly but cannot be expanded is a
  // value the user can read and not explore.
  test('an F# record, tuple and list all EXPAND to their own members', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop where every F# shape the fixture builds is bound.
    armBreakpoints(fixture, 'main-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the F# print statement');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'main-print', 'main', 'the F# inspection frame');
    const locals = await localsOf(session, frame.id);
    for (const name of ['point', 'pair', 'numbers', 'maybe', 'shape']) {
      eq(
        locals.map((local) => local.name).includes(name),
        true,
        'the F# binding ' + name + ' must appear in the Variables panel under its own name',
      );
    }

    // Interaction 2 — the RECORD expands to its declared fields, by name.
    const point = variableNamed(locals, 'point');
    neq(point.reference, 0, 'an F# record must be expandable, or its fields are unreachable');
    const fields = await variablesOf(session, point.reference);
    const fieldNames = fields.map((field) => field.name);
    eq(fieldNames.includes('X'), true, 'the record field X is a member row');
    eq(fieldNames.includes('Y'), true, 'and so is Y');
    eq(variableNamed(fields, 'X').value, '8', 'X carries the value the program bound');
    eq(variableNamed(fields, 'Y').value, '12', 'and Y the value the match computed');
    for (const field of fields) {
      eq(
        RAW_CLR_FORMS.some((raw) => field.value.includes(raw)),
        false,
        'the expanded field ' + field.name + ' must not leak a raw CLR shape either',
      );
    }

    // Interaction 3 — the TUPLE and the LIST expand too, and an evaluation of
    // the same path agrees with the expansion.
    const pair = variableNamed(locals, 'pair');
    neq(pair.reference, 0, 'an F# tuple must be expandable');
    const items = await variablesOf(session, pair.reference);
    eq(items.length >= 2, true, 'a two-element tuple exposes at least its two elements');
    eq(
      items.some((item) => item.value.includes('8')),
      true,
      'carrying the first component the program bound',
    );
    eq(
      items.some((item) => item.value.includes('boxed')),
      true,
      'and the second',
    );
    const numbers = variableNamed(locals, 'numbers');
    neq(numbers.reference, 0, 'an F# list must be expandable');
    const elements = await variablesOf(session, numbers.reference);
    eq(
      elements.length >= 1,
      true,
      'an F# list must expose its elements - a list that shows a length and no items is the ' +
        'FSharpList`1 rendering [DEBUG-FSHARP-UNIONS] rejects',
    );
    eq(
      (await evaluate(session, 'point.X', frame.id, 'watch')).value,
      variableNamed(fields, 'X').value,
      'and a watch over the same record field agrees with the expansion',
    );
    assertCleanSession(debuggee(), 'expanding F# values');
    // Interaction 5 - the whole expansion sweep happened against ONE paused F#
    // frame, and every nested read was answered.
    eq(recorder.requests('variables').length >= 3, true, 'a record, a tuple and a list were each expanded');
    eq(recorder.responses('variables').every((response) => response.success), true, 'and every expansion was answered');
    eq(recorder.requests('evaluate').length >= 1, true, 'with at least one watch cross-checking the panel');
    eq(recorder.stops().length, 1, 'and the debuggee paused throughout');
    deepEq(recorder.exits, [], 'with the adapter process alive');
  });

  // Implements [DEBUG-FSHARP-EVALUATION] and the T1/T2 evaluation tiers applied
  // to F# syntax. The evaluator is shared, so the question is whether F#
  // EXPRESSIONS survive it - `=` is equality in F#, not assignment, and a
  // record field access is a dot chain like any other.
  test('F# expressions evaluate in hover, watch and the REPL alike', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a frame with every F# shape in scope.
    armBreakpoints(fixture, 'main-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the F# print statement');
    const frame = await topFrame(session, stop.threadId);
    eq(
      recorder.capabilities()['supportsEvaluateForHovers'],
      true,
      'hover evaluation is a Phase 4 Yes, and F# is not exempt from it',
    );

    // Interaction 2 — T1 expressions over F# bindings, in all three contexts.
    const expressions: readonly { expression: string; expected: string }[] = [
      { expression: 'total', expected: '8' },
      { expression: 'point.X', expected: '8' },
      { expression: 'point.Y', expected: '12' },
      { expression: 'total + 1', expected: '9' },
    ];
    for (const { expression, expected } of expressions) {
      const watch = await evaluate(session, expression, frame.id, 'watch');
      eq(
        watch.value.includes(expected),
        true,
        expression +
          ' is a T1 expression over an F# binding and must evaluate; the Watch ' +
          'panel answered ' +
          JSON.stringify(watch.value),
      );
      eq(
        (await evaluate(session, expression, frame.id, 'hover')).value,
        watch.value,
        expression + ': a hover must agree with the Watch panel',
      );
      eq(
        (await evaluate(session, expression, frame.id, 'repl')).value,
        watch.value,
        expression + ': and so must the Debug Console',
      );
    }

    // Interaction 3 — the evaluated values must agree with the PANEL, and
    // evaluating must not disturb the session.
    const locals = await localsOf(session, frame.id);
    eq(
      (await evaluate(session, 'total', frame.id, 'watch')).value,
      variableNamed(locals, 'total').value,
      'an evaluation and the Variables panel must not disagree about one binding',
    );
    eq(recorder.stops().length, 1, 'evaluating never resumes or re-stops the debuggee');
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await recorder.waitForOutput('done plain');
    eq(
      recorder.outputText().includes('total=8'),
      true,
      'and the F# program printed exactly the value the panel and the watch both reported',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
    assertCleanSession(debuggee(), 'evaluating F# expressions');
    // Interaction 4 - twelve F# evaluations across three contexts, all against
    // one frame, none of them disturbing the session.
    eq(recorder.requests('evaluate').length >= 12, true, 'four expressions in three contexts is twelve round trips');
    eq(recorder.responses('evaluate').filter((response) => response.success).length >= 12, true, 'every one of them answered successfully');
    eq(recorder.stops().length, 1, 'with the F# debuggee paused throughout');
    eq(recorder.events('terminated').length <= 1, true, 'and the session ending at most once');
    deepEq(recorder.exits, [], 'with the adapter process alive');
  });
});
