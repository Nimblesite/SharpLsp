// Two debuggees at once: independent sessions, independent stacks, independent
// lifetimes.
//
// Implements [DEBUG-FEATURES-MULTIPROCESS] "Multiple simultaneous debug sessions
// | P2" and the architecture note behind it — "`DapRouter` indexes independent
// adapter processes by session ID. Session-prefixed DAP messages multiplex
// them" — which is precisely the machinery that breaks when a second session
// starts and the first one's state is served for both.
//
// Every read here is addressed to a SPECIFIC `vscode.DebugSession` object rather
// than to `vscode.debug.activeDebugSession`, because the failure this suite
// exists to catch is exactly "the second session answered for the first".
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  assertStopReason,
  assertStoppedAt,
  localsOf,
  methodOf,
  stackFrames,
  topFrame,
  variableNamed,
} from './debug-drive-kit';
import {
  armBreakpoints,
  breakpointAt,
  clearAllBreakpoints,
  launchConfigFor,
  startDebuggee,
  stopDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { BUILD_TIMEOUT_MS, DEBUG_TYPE_ID, DebugSessionRecorder } from './run-debug-kit';
import { deepEq, eq, neq, pollUntilResult, requireAt } from './test-helpers';

/** Wait for a second live session and hand back the one that is not `first`. */
async function waitForSecondSession(
  sessions: DebugSessionRecorder,
  firstId: string,
): Promise<vscode.DebugSession> {
  // `activeDebugSession` follows the debug view's FOCUS, which a headless host
  // never moves when a second launch starts while the first is paused. The
  // workbench's own start events are the source of truth for "a second session
  // exists" — and they hand back the live session object the rest of the test
  // drives.
  const session = await pollUntilResult(
    async () => sessions.liveOurs.find((live) => live.id !== firstId),
    (current) => current !== undefined,
    60_000,
    50,
  );
  assert.ok(
    session && session.id !== firstId,
    '[DEBUG-FEATURES-MULTIPROCESS] makes "Multiple simultaneous debug sessions" a specified ' +
      'row: starting a second launch while one is paused must produce a SECOND session, not ' +
      'replace or reuse the first',
  );
  return session;
}

suite('Debug multi-session — two debuggees paused at once', () => {
  const debuggee = useDebuggee('debug-multi-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-MULTIPROCESS] "Multiple simultaneous debug sessions".
  test('two sessions run side by side with their own stacks and their own state', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, folder, recorder, sessions } = debuggee();

    // Interaction 1 — session one stops deep inside the loop.
    armBreakpoints(fixture, 'add-body');
    const first = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [firstStop] = await recorder.waitForStops(1);
    assert.ok(firstStop, 'the first debuggee must reach its breakpoint');
    assertStoppedAt(
      await topFrame(first, firstStop.threadId),
      fixture,
      'add-body',
      'Add',
      'the first session',
    );

    // Interaction 2 — arm a DIFFERENT breakpoint and start a second session.
    clearAllBreakpoints();
    vscode.debug.addBreakpoints([breakpointAt(fixture, 'inspect-list')]);
    const started = await vscode.debug.startDebugging(
      folder,
      launchConfigFor(fixture, { mode: MODE.caught }),
    );
    eq(started, true, 'a second launch must be accepted while the first session is paused');
    const second = await waitForSecondSession(sessions, first.id);
    neq(second.id, first.id, 'the two sessions must be distinct objects');
    eq(second.type, DEBUG_TYPE_ID, 'both are SharpLsp sessions');
    deepEq(
      second.configuration['args'],
      [MODE.caught],
      'the second session must carry ITS OWN configuration, not the first one’s',
    );
    eq(sessions.ours.length, 2, 'the workbench reported exactly two SharpLsp sessions');

    // Interaction 3 — each session must answer for ITSELF.
    const stops = await recorder.waitForStops(2);
    const secondStop = requireAt(stops, 1, 'the second session’s stop');
    assertStopReason(secondStop, 'breakpoint', 'the second session’s breakpoint');
    const secondFrame = await topFrame(second, secondStop.threadId);
    assertStoppedAt(secondFrame, fixture, 'inspect-list', 'Inspect', 'the second session');
    const firstFrame = await topFrame(first, firstStop.threadId);
    assertStoppedAt(
      firstFrame,
      fixture,
      'add-body',
      'Add',
      'the FIRST session must still report its own frame; serving the second session’s state ' +
        'here is the multiplexing bug "indexes independent adapter processes by session ID" ' +
        'exists to prevent',
    );
    neq(firstFrame.id, secondFrame.id, 'two sessions must not share frame handles');
    eq(
      methodOf(firstFrame),
      'Add',
      'the first session is three frames deep; the second is two, in a different method',
    );

    // Interaction 4 — their locals must not bleed into one another.
    eq(
      variableNamed(await localsOf(first, firstFrame.id), 'left').value,
      '2',
      'the first session’s frame carries its own arguments',
    );
    const secondLocals = await localsOf(second, secondFrame.id);
    deepEq(
      secondLocals.map((local) => local.name).includes('left'),
      false,
      'the second session is in a method with no `left`; seeing one means the adapter answered ' +
        'from the wrong session',
    );
    eq(
      (await stackFrames(first, firstStop.threadId)).length >
        (await stackFrames(second, secondStop.threadId)).length,
      true,
      'the two call stacks must be genuinely different depths',
    );

    // Interaction 5 — finishing one must leave the other paused and alive.
    await vscode.debug.stopDebugging(second);
    await pollUntilResult(
      async () => vscode.debug.activeDebugSession?.id,
      (id) => id === first.id,
      60_000,
      50,
    );
    eq(
      vscode.debug.activeDebugSession?.id,
      first.id,
      'stopping the second session must hand focus back to the first, not clear the debugger',
    );
    assertStoppedAt(
      await topFrame(first, firstStop.threadId),
      fixture,
      'add-body',
      'Add',
      'the surviving session must still be paused exactly where it was',
    );

    // Interaction 6 — the survivor must still be drivable.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    const resumed = await recorder.waitForStops(3);
    assertStoppedAt(
      await topFrame(first, requireAt(resumed, 2, 'the survivor’s next stop').threadId),
      fixture,
      'add-body',
      'Add',
      'continuing the surviving session must reach its next breakpoint hit',
    );
    await stopDebuggee();
    deepEq(recorder.errors, [], 'multiplexing two sessions must not error the transport');
  });
});
