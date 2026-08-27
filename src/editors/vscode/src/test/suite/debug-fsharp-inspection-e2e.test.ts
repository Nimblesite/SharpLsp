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
import { BUILD_TIMEOUT_MS } from './run-debug-kit';
import { deepEq, eq } from './test-helpers';

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
    this.timeout(BUILD_TIMEOUT_MS);
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
  });

  // Implements the "F# record/tuple inspection | variables | P1" row.
  test('records, tuples and F# lists are inspectable in F# form', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
  });

  // Implements [DEBUG-FSHARP-STEPPING] and [DEBUG-FEATURES-STACK-ASYNC] for F#.
  test('an F# task {} chain reports the logical await stack', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
  });

  // Implements [DEBUG-FSHARP-PDB]: the `StateMachineMethod` gap and its cost.
  test('stepping into a task {} takes ONE F11, not two', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
    eq(
      stepped.frame.line,
      fixture.source.dapLine('root-await'),
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
  });
});
