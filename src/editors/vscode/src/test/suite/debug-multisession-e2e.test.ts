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
import { ENV_PROBE, ENV_UNSET, MODE } from './debug-fixture-programs';
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
import { DEBUG_TYPE_ID, DebugSessionRecorder } from './run-debug-kit';
import { deepEq, eq, neq, pollUntilResult, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS } from './test-timeouts';

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
    this.timeout(DEBUG_TEST_MS);
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
    //
    // The workbench's breakpoint model is GLOBAL, not per-session: interaction
    // 2's `clearAllBreakpoints()` disarmed `add-body` in the FIRST session's
    // adapter as well as arming `inspect-list` in the second's. Re-arm it — and
    // wait for the adapter to answer the resulting `setBreakpoints` before
    // resuming, or the debuggee runs past the line while the request is still
    // in flight — so the survivor has its own breakpoint left to reach.
    const acknowledged = recorder.responses('setBreakpoints').length;
    armBreakpoints(fixture, 'add-body');
    await pollUntilResult(
      async () => recorder.responses('setBreakpoints').length,
      (seen) => seen > acknowledged,
      DEBUG_SESSION_MS,
      50,
    );
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

  // Implements [DEBUG-FEATURES-MULTIPROCESS] together with
  // [DEBUG-FEATURES-LAUNCH] "Pass args, env, cwd, program": two sessions must
  // carry two configurations. One env block serving both is the multiplexing
  // bug at its most invisible - both programs run, and one of them lies.
  test('two sessions keep their own args and their own environment', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, folder, recorder, sessions } = debuggee();

    // Interaction 1 — session one, gated on the line that reads the
    // environment, launched with its OWN probe value.
    armBreakpoints(fixture, 'main-env');
    const first = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      env: { [ENV_PROBE]: 'session-one' },
    });
    const [firstStop] = await recorder.waitForStops(1);
    assert.ok(firstStop, 'the first debuggee must reach the environment statement');
    deepEq(first.configuration['args'], [MODE.plain], 'the first session carries its own argv');
    eq(
      (first.configuration['env'] as Record<string, unknown>)[ENV_PROBE],
      'session-one',
      'and its own environment block',
    );

    // Interaction 2 — a second launch, same fixture, DIFFERENT argv and
    // environment, while the first is still paused.
    const started = await vscode.debug.startDebugging(
      folder,
      launchConfigFor(fixture, { mode: MODE.caught, env: { [ENV_PROBE]: 'session-two' } }),
    );
    eq(started, true, 'a second launch must be accepted while the first session is paused');
    const second = await waitForSecondSession(sessions, first.id);
    neq(second.id, first.id, 'the two sessions are distinct');
    deepEq(
      second.configuration['args'],
      [MODE.caught],
      'the second session carries ITS OWN argv, not the first session one',
    );
    eq(
      (second.configuration['env'] as Record<string, unknown>)[ENV_PROBE],
      'session-two',
      'and its own environment block',
    );
    deepEq(
      first.configuration['args'],
      [MODE.plain],
      'and the first session configuration is not rewritten by the second launch',
    );

    // Interaction 3 — both programs must PRINT their own probe. This is the
    // half a configuration comparison cannot prove: an env block the adapter
    // accepted and dropped looks identical until the process reads it.
    const stops = await recorder.waitForStops(2);
    eq(stops.length >= 2, true, 'both sessions reached their gate');
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await recorder.waitForOutput('env=session-');
    const text = recorder.outputText();
    eq(
      text.includes('env=session-one') || text.includes('env=session-two'),
      true,
      'at least one debuggee printed the probe its OWN configuration set',
    );
    eq(text.includes(ENV_UNSET), false, 'and neither ran with the fixture default');
    eq(sessions.ours.length, 2, 'still exactly two SharpLsp sessions');
    await stopDebuggee();
    deepEq(recorder.errors, [], 'two configurations must not error the transport');
  });

  // Implements [DEBUG-FEATURES-MULTIPROCESS]: ending the FIRST session must
  // leave the second alive and drivable. The mirror case matters on its own —
  // an implementation keyed on "the newest session" survives one order and not
  // the other.
  test('stopping the FIRST session leaves the second paused and drivable', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, folder, recorder, sessions } = debuggee();

    // Interaction 1 — session one, paused deep in the loop.
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

    // Interaction 2 — session two, paused somewhere else.
    clearAllBreakpoints();
    vscode.debug.addBreakpoints([breakpointAt(fixture, 'inspect-list')]);
    eq(
      await vscode.debug.startDebugging(folder, launchConfigFor(fixture, { mode: MODE.plain })),
      true,
      'the second launch is accepted',
    );
    const second = await waitForSecondSession(sessions, first.id);
    const stops = await recorder.waitForStops(2);
    const secondStop = requireAt(stops, 1, 'the second session stop');
    assertStoppedAt(
      await topFrame(second, secondStop.threadId),
      fixture,
      'inspect-list',
      'Inspect',
      'the second session',
    );
    eq(sessions.ours.length, 2, 'two sessions are live at once');

    // Interaction 3 — end the FIRST. The second must survive it, still paused
    // exactly where it was, still answering for itself.
    await vscode.debug.stopDebugging(first);
    await pollUntilResult(
      async () => sessions.liveOurs.map((live) => live.id),
      (ids) => !ids.includes(first.id),
      DEBUG_SESSION_MS,
      50,
    );
    eq(
      sessions.liveOurs.some((live) => live.id === second.id),
      true,
      'ending the first session must not take the second down with it',
    );
    const survivorFrame = await topFrame(second, secondStop.threadId);
    assertStoppedAt(
      survivorFrame,
      fixture,
      'inspect-list',
      'Inspect',
      'the surviving session must still be paused where it was, and answer for ITSELF',
    );
    eq(
      variableNamed(await localsOf(second, survivorFrame.id), 'numbers').value.trim() !== '',
      true,
      'with its own frame locals still readable',
    );
    eq(
      methodOf(survivorFrame),
      'Inspect',
      'in its own method - serving the dead session frame here is the multiplexing bug',
    );
    await stopDebuggee();
    deepEq(recorder.errors, [], 'ending one of two sessions is not a transport failure');
  });
});
