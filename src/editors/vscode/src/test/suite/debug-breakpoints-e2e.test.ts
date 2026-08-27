// Breakpoints as a user sets them: F9 in the editor, the Breakpoints view, and
// function breakpoints — all against a live netcoredbg session.
//
// Implements [DEBUG-FEATURES-BREAKPOINTS] ("Line breakpoints", "Function/method
// breakpoints") and the RUNTIME half of [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION].
//
// Rule 4 of that section is the reason this suite exists separately from
// run-debug-contributions: `vscode.debug.addBreakpoints()` bypasses the
// `canSetBreakpointsIn` gate, so a test that only calls the API passes while the
// product is broken. The gate is only observable through a gesture the EDITOR
// performs — `editor.debug.action.toggleBreakpoint`, which is F9 — and that is
// what interaction 1 of the first test drives.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  CMD_TOGGLE_BREAKPOINT,
  assertStopReason,
  assertStoppedAt,
  focusAnchor,
  methodOf,
  stepToFrame,
  topFrame,
} from './debug-drive-kit';
import {
  armBreakpoints,
  assertBreakpointsBound,
  assertCleanSession,
  assertRanToCompletion,
  breakpointAt,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { BUILD_TIMEOUT_MS } from './run-debug-kit';
import { deepEq, eq, pollUntilResult, requireAt } from './test-helpers';

/** The 0-based lines the workbench currently holds source breakpoints on. */
function armedLines(): number[] {
  return vscode.debug.breakpoints
    .filter((breakpoint): breakpoint is vscode.SourceBreakpoint => {
      return breakpoint instanceof vscode.SourceBreakpoint;
    })
    .map((breakpoint) => breakpoint.location.range.start.line)
    .sort((left, right) => left - right);
}

/** The 1-based lines of the most recent `setBreakpoints` request, sorted. */
function lastRequestedLines(requests: readonly { args: Record<string, any> }[]): number[] {
  const last = requests[requests.length - 1]?.args ?? {};
  const list: unknown = last['breakpoints'];
  assert.ok(Array.isArray(list), '`setBreakpoints` must carry a breakpoints array');
  return list.map((entry) => Number((entry as Record<string, any>)['line'])).sort((a, b) => a - b);
}

/** Wait until the workbench has sent at least `count` `setBreakpoints` requests. */
async function waitForBreakpointSyncs(
  requests: () => readonly { args: Record<string, any> }[],
  count: number,
): Promise<readonly { args: Record<string, any> }[]> {
  const seen = await pollUntilResult(
    async () => requests(),
    (all) => all.length >= count,
    20_000,
    50,
  );
  assert.ok(
    seen.length >= count,
    `the workbench must re-send \`setBreakpoints\` ${String(count)} time(s); it sent ` +
      `${String(seen.length)}. A breakpoint change that never reaches the adapter is a ` +
      'breakpoint the running debuggee will not honour',
  );
  return seen;
}

suite('Debug breakpoints — F9, the Breakpoints view, and function breakpoints', () => {
  const debuggee = useDebuggee('debug-bp-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rules 1–4 at runtime.
  test('F9 in a C# editor sets a breakpoint the adapter binds and stops on', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — the gate must be the manifest, not a user override. If
    // `allowBreakpointsEverywhere` were on, F9 would work for the wrong reason
    // and this suite would report green on a non-conforming manifest.
    eq(
      vscode.workspace.getConfiguration('debug').get<boolean>('allowBreakpointsEverywhere'),
      false,
      'debug.allowBreakpointsEverywhere must stay at its default; with it on, F9 succeeds ' +
        'even when contributes.breakpoints omits csharp, and rule 3 goes untested',
    );
    deepEq(armedLines(), [], 'no test may inherit a breakpoint from its neighbour');

    // Interaction 2 — put the caret on a statement and press F9.
    const editor = await focusAnchor(fixture, 'main-accumulate');
    eq(editor.document.languageId, 'csharp', 'F9 is being pressed in a C# document');
    await vscode.commands.executeCommand(CMD_TOGGLE_BREAKPOINT);
    deepEq(
      armedLines(),
      [fixture.source.line('main-accumulate')],
      'F9 must create a breakpoint. VS Code gates every breakpoint UI entry point on ' +
        'canSetBreakpointsIn, which consults contributes.breakpoints; with no `csharp` entry ' +
        'and the default allowBreakpointsEverywhere of false, C# breakpoints are IMPOSSIBLE ' +
        '([DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rules 1 and 3)',
    );
    const created = requireAt(vscode.debug.breakpoints, 0, 'the breakpoint F9 created');
    eq(created.enabled, true, 'a breakpoint created by F9 is enabled');
    eq(created instanceof vscode.SourceBreakpoint, true, 'F9 creates a SOURCE breakpoint');

    // Interaction 3 — F9 again on the same line must REMOVE it. A toggle that
    // only ever adds leaves the user unable to clear a breakpoint from the editor.
    await vscode.commands.executeCommand(CMD_TOGGLE_BREAKPOINT);
    deepEq(armedLines(), [], 'F9 on an existing breakpoint must toggle it off');

    // Interaction 4 — F9 once more, then launch and prove it really stops.
    await vscode.commands.executeCommand(CMD_TOGGLE_BREAKPOINT);
    deepEq(armedLines(), [fixture.source.line('main-accumulate')], 'the third F9 re-arms it');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'a breakpoint set through the editor must stop the debuggee');
    assertStopReason(stop, 'breakpoint', 'an F9-set breakpoint');
    assertBreakpointsBound(recorder, fixture, ['main-accumulate'], 'the F9 line');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'main-accumulate',
      'Main',
      'the F9 breakpoint',
    );
    assertCleanSession(debuggee(), 'an F9 breakpoint');
  });

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Line breakpoints", plus the
  // reactivity [VSCODE-REACTIVITY] demands: a change must reach the RUNNING adapter.
  test('breakpoints added and removed mid-session reach the running adapter', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — launch with a single breakpoint and stop on it.
    armBreakpoints(fixture, 'main-accumulate');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    const [first] = await recorder.waitForStops(1);
    assert.ok(first, 'the debuggee must reach the only armed breakpoint');
    const initialSyncs = recorder.requests('setBreakpoints').length;
    assert.ok(initialSyncs >= 1, 'the launch must have synced the armed breakpoint');
    deepEq(
      lastRequestedLines(recorder.requests('setBreakpoints')),
      [fixture.source.dapLine('main-accumulate')],
      'only the armed line may be sent to the adapter',
    );

    // Interaction 2 — add a SECOND breakpoint while the debuggee is paused.
    vscode.debug.addBreakpoints([breakpointAt(fixture, 'main-done')]);
    const afterAdd = await waitForBreakpointSyncs(
      () => recorder.requests('setBreakpoints'),
      initialSyncs + 1,
    );
    deepEq(
      lastRequestedLines(afterAdd),
      [fixture.source.dapLine('main-accumulate'), fixture.source.dapLine('main-done')].sort(
        (left, right) => left - right,
      ),
      'a breakpoint added mid-session must be pushed to the live adapter, not queued for the ' +
        'next launch — otherwise the user sets a breakpoint and the debuggee runs straight past',
    );

    // Interaction 3 — continue. The newly added breakpoint must stop the program.
    const second = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(second.stop, 'breakpoint', 'the mid-session breakpoint');
    assertStoppedAt(second.frame, fixture, 'main-done', 'Main', 'the breakpoint added mid-session');
    eq(recorder.stops().length, 2, 'exactly two stops: the original and the added one');

    // Interaction 4 — remove BOTH and continue; nothing may stop the program again.
    const beforeRemoval = recorder.requests('setBreakpoints').length;
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    const afterRemoval = await waitForBreakpointSyncs(
      () => recorder.requests('setBreakpoints'),
      beforeRemoval + 1,
    );
    deepEq(
      lastRequestedLines(afterRemoval),
      [],
      'removing every breakpoint must send an EMPTY breakpoints array; a removal that is ' +
        'never sent leaves the debuggee stopping on a breakpoint the user has deleted',
    );
    const stopsBefore = recorder.stops().length;
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session whose breakpoints were all removed');
    eq(recorder.stops().length, stopsBefore, 'a removed breakpoint must never stop the debuggee');
    assertCleanSession(debuggee(), 'add and remove mid-session');
  });

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Line breakpoints" — the enabled flag.
  test('a disabled breakpoint is never armed, and re-enabling it re-arms it', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — one enabled breakpoint, one disabled breakpoint.
    vscode.debug.addBreakpoints([
      breakpointAt(fixture, 'main-accumulate'),
      breakpointAt(fixture, 'main-inspect', { enabled: false }),
    ]);
    eq(vscode.debug.breakpoints.length, 2, 'the view holds both, enabled and disabled alike');
    deepEq(
      vscode.debug.breakpoints.map((breakpoint) => breakpoint.enabled),
      [true, false],
      'the disabled breakpoint keeps its disabled state in the Breakpoints view',
    );

    // Interaction 2 — launch. Only the ENABLED line may reach the adapter.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [first] = await recorder.waitForStops(1);
    assert.ok(first, 'the enabled breakpoint must stop the debuggee');
    deepEq(
      lastRequestedLines(recorder.requests('setBreakpoints')),
      [fixture.source.dapLine('main-accumulate')],
      'a DISABLED breakpoint must not be sent to the adapter — the Breakpoints view shows it ' +
        'greyed out precisely because it is inert',
    );
    assertStoppedAt(
      await topFrame(session, first.threadId),
      fixture,
      'main-accumulate',
      'Main',
      'the enabled breakpoint',
    );

    // Interaction 3 — enable it (remove + re-add, which is what the checkbox does).
    const disabled = vscode.debug.breakpoints.filter((breakpoint) => !breakpoint.enabled);
    eq(disabled.length, 1, 'exactly one breakpoint is disabled before the toggle');
    const syncs = recorder.requests('setBreakpoints').length;
    vscode.debug.removeBreakpoints(disabled);
    vscode.debug.addBreakpoints([breakpointAt(fixture, 'main-inspect')]);
    const afterEnable = await waitForBreakpointSyncs(
      () => recorder.requests('setBreakpoints'),
      syncs + 1,
    );
    deepEq(
      lastRequestedLines(afterEnable),
      [fixture.source.dapLine('main-accumulate'), fixture.source.dapLine('main-inspect')].sort(
        (left, right) => left - right,
      ),
      'enabling a breakpoint mid-session must arm it on the live adapter',
    );

    // Interaction 4 — continue: the newly enabled breakpoint must now stop.
    const second = await stepToFrame(recorder, CMD_CONTINUE);
    assertStopReason(second.stop, 'breakpoint', 'the re-enabled breakpoint');
    assertStoppedAt(second.frame, fixture, 'main-inspect', 'Main', 'the re-enabled breakpoint');
    assertCleanSession(debuggee(), 'disable then enable');
  });

  // Implements [DEBUG-FEATURES-BREAKPOINTS] "Function/method breakpoints |
  // setFunctionBreakpoints | P1 | Native".
  test('a function breakpoint stops on entry to the named method', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — arm a function breakpoint and nothing else.
    const functionName = 'StepTarget.Program.Add';
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(functionName)]);
    eq(vscode.debug.breakpoints.length, 1, 'one function breakpoint is armed');
    const armed = requireAt(vscode.debug.breakpoints, 0, 'the function breakpoint');
    eq(armed instanceof vscode.FunctionBreakpoint, true, 'it is a FunctionBreakpoint');
    deepEq(armedLines(), [], 'a function breakpoint is not a source breakpoint');

    // Interaction 2 — launch. The adapter must be asked, and must say yes.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const requested = recorder.requests('setFunctionBreakpoints');
    eq(
      requested.length >= 1,
      true,
      '[DEBUG-FEATURES-BREAKPOINTS] makes function breakpoints P1 and native: the workbench ' +
        'must send `setFunctionBreakpoints`, and the adapter must advertise ' +
        'supportsFunctionBreakpoints for it to be sent at all',
    );
    eq(
      recorder.capabilities()['supportsFunctionBreakpoints'],
      true,
      'the adapter must advertise supportsFunctionBreakpoints',
    );
    const names: unknown = requested[requested.length - 1]?.args['breakpoints'];
    assert.ok(Array.isArray(names), '`setFunctionBreakpoints` carries a breakpoints array');
    deepEq(
      names.map((entry) => String((entry as Record<string, any>)['name'])),
      [functionName],
      'the fully-qualified method name must be forwarded verbatim',
    );

    // Interaction 3 — the debuggee must stop on entry to Add, three frames deep.
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'a function breakpoint must stop the debuggee on entry to the method');
    assertStopReason(stop, 'function breakpoint', 'a function-breakpoint stop');
    const frame = await topFrame(session, stop.threadId);
    eq(methodOf(frame), 'Add', 'the stop must be inside the named method');
    assertStoppedAt(frame, fixture, 'add-body', 'Add', 'the function breakpoint');

    // Interaction 4 — continue twice: the loop calls Add three times in all.
    const secondHit = await stepToFrame(recorder, CMD_CONTINUE);
    assertStoppedAt(secondHit.frame, fixture, 'add-body', 'Add', 'the second call to Add');
    const thirdHit = await stepToFrame(recorder, CMD_CONTINUE);
    assertStoppedAt(thirdHit.frame, fixture, 'add-body', 'Add', 'the third call to Add');
    eq(recorder.stops().length, 3, 'Accumulate calls Add exactly three times, so three stops');
    assertCleanSession(debuggee(), 'a function breakpoint hit three times');
  });
});
