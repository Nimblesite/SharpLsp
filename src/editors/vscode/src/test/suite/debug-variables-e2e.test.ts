// The Variables panel: locals, arguments, `this`, statics and structured
// expansion, read off a debuggee paused on a real statement.
//
// Implements the P1 rows of [DEBUG-FEATURES-VARIABLES]: "Local variables",
// "Function arguments", "`this` / instance members", "Static fields" and
// "Collection/array expansion", plus the `supportsVariableType` row of
// [DEBUG-PROTOCOL-CAPABILITIES].
//
// [DEBUG-ADAPTER-GAPS] records `Nullable<T>` expansion as broken upstream
// (netcoredbg issue #213). That is a gap to CLOSE, not an exemption: the row
// "Local variables | variables | P1" says nothing about excluding `int?`, so the
// nullable local is asserted like any other and this suite reports the gap.
import * as assert from 'node:assert/strict';
import { MODE } from './debug-fixture-programs';
import {
  assertStoppedAt,
  localsOf,
  scopesOf,
  topFrame,
  variableNamed,
  variablesOf,
  type Variable,
} from './debug-drive-kit';
import { armBreakpoints, assertCleanSession, startDebuggee, useDebuggee } from './debug-suite-kit';
import { deepEq, eq, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS } from './test-timeouts';

/** Assert a variable's rendered value CONTAINS `needle`, naming what it was. */
function assertValueHas(variable: Variable, needle: string, why: string): void {
  assert.ok(
    variable.value.includes(needle),
    `${why}: '${variable.name}' must render '${needle}'; the panel shows '${variable.value}' ` +
      `(type '${variable.type}')`,
  );
}

/** Assert a variable declares a type — the `supportsVariableType` contract. */
function assertTyped(variable: Variable, needle: string, why: string): void {
  assert.notStrictEqual(
    variable.type,
    '',
    `${why}: '${variable.name}' must carry a type. [DEBUG-PROTOCOL-CAPABILITIES] lists ` +
      'supportsVariableType as Yes for Phase 4, and the Variables panel shows the type as the ' +
      'tooltip — an untyped entry leaves the user guessing',
  );
  assert.ok(
    variable.type.includes(needle),
    `${why}: '${variable.name}' must be typed as ${needle}; it reported '${variable.type}'`,
  );
}

/** Every variable reachable from every scope of `frameId`, flattened. */
async function allScopeVariables(session: import('vscode').DebugSession, frameId: number) {
  const scopes = await scopesOf(session, frameId);
  const collected: Variable[] = [];
  for (const scope of scopes) {
    if (scope.reference === 0) continue;
    collected.push(...(await variablesOf(session, scope.reference)));
  }
  return { scopes, variables: collected };
}

suite('Debug variables — locals, arguments, this, statics and expansion', () => {
  const debuggee = useDebuggee('debug-vars-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-VARIABLES] "Local variables" and
  // "Function arguments", both P1.
  test('a paused frame exposes its arguments and its locals, correctly typed', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop inside a two-argument method, after its local is set.
    armBreakpoints(fixture, 'add-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint inside Add');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'add-return', 'Add', 'the return statement of Add');

    // Interaction 2 — both arguments must be there, with their real values.
    const locals = await localsOf(session, frame.id);
    const names = locals.map((local) => local.name).sort();
    eq(
      ['left', 'right', 'sum'].every((wanted) => names.includes(wanted)),
      true,
      '"Function arguments" and "Local variables" are separate P1 rows: `left`, `right` and ' +
        `\`sum\` must all be inspectable. The frame offered: ${names.join(', ')}`,
    );
    eq(variableNamed(locals, 'left').value, '2', 'the first call passes the seed, 2');
    eq(variableNamed(locals, 'right').value, '1', 'and the loop index, 1');
    eq(variableNamed(locals, 'sum').value, '3', 'the local has already been assigned 2 + 1');
    assertTyped(variableNamed(locals, 'left'), 'int', 'the first argument');
    assertTyped(variableNamed(locals, 'sum'), 'int', 'the local');

    // Interaction 3 — a scalar has no children; a bogus expansion is a bug.
    deepEq(
      locals.map((local) => local.reference),
      locals.map(() => 0),
      'an `int` must report variablesReference 0; a non-zero reference puts an expander ' +
        'arrow on a value that has nothing inside it',
    );
    eq(
      recorder.capabilities()['supportsVariableType'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsVariableType as Yes for Phase 4',
    );
    assertCleanSession(debuggee(), 'reading arguments and locals');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "`this` / instance members | P1".
  test('an instance method exposes `this` and its members', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop inside an INSTANCE method.
    armBreakpoints(fixture, 'box-describe-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint inside Box.Describe');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(
      frame,
      fixture,
      'box-describe-return',
      'Describe',
      'inside the instance method',
    );

    // Interaction 2 — `this` must be present and expandable.
    const locals = await localsOf(session, frame.id);
    const self = variableNamed(locals, 'this');
    assert.ok(
      self.reference > 0,
      '"`this` / instance members" is P1: `this` must be EXPANDABLE. A reference of 0 renders ' +
        'the object as a leaf and the user can never reach its fields',
    );
    assertTyped(self, 'Box', 'the instance under inspection');

    // Interaction 3 — its members must carry the constructor's arguments.
    const members = await variablesOf(session, self.reference);
    const memberNames = members.map((member) => member.name);
    eq(
      ['Value', 'Label'].every((wanted) => memberNames.includes(wanted)),
      true,
      `both auto-properties must be inspectable; \`this\` offered: ${memberNames.join(', ')}`,
    );
    eq(variableNamed(members, 'Value').value, '8', 'Accumulate produced 8, so Box.Value is 8');
    assertValueHas(variableNamed(members, 'Label'), 'boxed', 'the string member');

    // Interaction 4 — the method's own local is there too, already assigned.
    assertValueHas(
      variableNamed(locals, 'rendered'),
      'boxed=8',
      'the local of the instance method',
    );
    assertCleanSession(debuggee(), 'inspecting `this`');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "Collection/array expansion | P1" and
  // the `Nullable<T>` row of [DEBUG-ADAPTER-GAPS].
  test('collections, dictionaries, arrays and nullables all expand', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop where every container is populated.
    armBreakpoints(fixture, 'inspect-print');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the print statement in Inspect');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'inspect-print', 'Inspect', 'the fully populated frame');
    const locals = await localsOf(session, frame.id);
    const names = locals.map((local) => local.name).sort();
    eq(
      ['box', 'letters', 'lookup', 'maybe', 'numbers', 'text'].every((w) => names.includes(w)),
      true,
      `every local of Inspect must be listed; the panel offered: ${names.join(', ')}`,
    );

    // Interaction 2 — a List<int> must expand to its three elements.
    const numbers = variableNamed(locals, 'numbers');
    assert.ok(numbers.reference > 0, 'a List<int> must be expandable');
    const elements = await variablesOf(session, numbers.reference);
    eq(
      elements.some((element) => element.value === '10'),
      true,
      `the list's elements must be reachable; expansion produced: ${elements
        .map((element) => `${element.name}=${element.value}`)
        .join(', ')}`,
    );
    deepEq(
      ['10', '20', '30'].filter((value) => elements.some((element) => element.value === value)),
      ['10', '20', '30'],
      'ALL three elements must be present: a truncated expansion hides data the user is ' +
        'debugging for',
    );

    // Interaction 3 — a char[] and a Dictionary must expand too.
    const letters = variableNamed(locals, 'letters');
    assert.ok(letters.reference > 0, 'a char[] must be expandable');
    const chars = await variablesOf(session, letters.reference);
    eq(
      chars.filter((entry) => entry.value.includes("'a'") || entry.value.includes('a')).length > 0,
      true,
      `the array elements must be reachable; expansion produced: ${chars
        .map((entry) => entry.value)
        .join(', ')}`,
    );
    const lookup = variableNamed(locals, 'lookup');
    assert.ok(
      lookup.reference > 0,
      '"Collection/array expansion" is P1 and a Dictionary is the collection users hit first; ' +
        `it rendered as '${lookup.value}' with no children`,
    );

    // Interaction 4 — the nullable must show its VALUE, not a raw struct.
    const maybe = variableNamed(locals, 'maybe');
    assertValueHas(
      maybe,
      '42',
      '`int?` holding 42 must render 42. [DEBUG-ADAPTER-GAPS] records `Nullable<T>` expansion ' +
        'as broken in netcoredbg (issue #213) and [DEBUG-GAPS] makes closing gaps the ' +
        'project’s job — the P1 "Local variables" row admits no exception for nullables',
    );
    assertValueHas(variableNamed(locals, 'text'), 'boxed=8', 'the string local');
    assertCleanSession(debuggee(), 'expanding containers');
  });

  // Implements [DEBUG-FEATURES-VARIABLES] "Static fields | variables | P1".
  test('a static field is reachable from the variables panel', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop after the static has been assigned.
    armBreakpoints(fixture, 'accumulate-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the return statement of Accumulate');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'accumulate-return', 'Accumulate', 'after the static is set');

    // Interaction 2 — every scope the adapter offers must be usable.
    const { scopes, variables } = await allScopeVariables(session, frame.id);
    assert.ok(scopes.length > 0, 'a stopped frame must offer at least one scope');
    deepEq(
      scopes.map((scope) => scope.name.trim() === ''),
      scopes.map(() => false),
      'an unnamed scope cannot be labelled in the Variables panel',
    );

    // Interaction 3 — the static field must be among them.
    const offered = variables.map((variable) => variable.name).sort();
    eq(
      offered.includes('Total'),
      true,
      '"Static fields | `variables` | P1": `Program.Total` was assigned on the previous ' +
        'statement and must be inspectable from the paused frame. Scopes offered ' +
        `[${scopes.map((scope) => scope.name).join(', ')}] holding [${offered.join(', ')}]`,
    );
    eq(
      variableNamed(variables, 'Total').value,
      '8',
      'the static must show the value the program just stored, not its default of 0',
    );

    // Interaction 4 — the frame's own local agrees with the static.
    const locals = await localsOf(session, frame.id);
    eq(
      variableNamed(locals, 'running').value,
      '8',
      'the local the static was copied from must read the same',
    );
    eq(
      requireAt(scopes, 0, 'the first scope').expensive,
      false,
      'the first scope must not be flagged expensive; VS Code refuses to auto-expand one, so ' +
        'the user sees an empty Variables panel until they click',
    );
    assertCleanSession(debuggee(), 'reading a static field');
  });
});
