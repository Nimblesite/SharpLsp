// The session itself: stopAtEntry, pause, restart, stop, run-without-debugging,
// and the `args`/`env` a launch configuration carries into the debuggee.
//
// Implements [DEBUG-FEATURES-LAUNCH] ("Launch .NET app", "Launch with
// environment variables", "Launch with custom working directory", all P1),
// [DEBUG-FEATURES-LAUNCH-NODEBUG] (Ctrl/Cmd+F5 semantics),
// [DEBUG-FEATURES-LAUNCH-OUTPUT] (where the debuggee's stdout goes) and the
// `supportsTerminateRequest` / `supportsRestartRequest` rows of
// [DEBUG-PROTOCOL-CAPABILITIES].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ENV_PROBE, ENV_UNSET, MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  CMD_RESTART,
  CMD_STOP,
  assertStopReason,
  assertStoppedAt,
  methodOf,
  topFrame,
} from './debug-drive-kit';
import {
  armBreakpoints,
  assertCleanSession,
  assertRanToCompletion,
  launchConfigFor,
  startDebuggee,
  stopDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { DEBUG_TYPE_ID } from './run-debug-kit';
import { comparablePath, deepEq, eq, neq, pollUntilResult, requireAt, sleep } from './test-helpers';
import { DEBUG_TEST_MS, QUIET_MS } from './test-timeouts';

suite('Debug session lifecycle — entry, pause, restart, stop and no-debug runs', () => {
  const debuggee = useDebuggee('debug-life-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-LAUNCH] and its declared `stopAtEntry` attribute.
  test('stopAtEntry pauses before the program has done anything', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { recorder } = debuggee();

    // Interaction 1 — launch with stopAtEntry and NO breakpoints at all.
    deepEq(
      vscode.debug.breakpoints.map((bp) => bp.id),
      [],
      'no breakpoint is armed',
    );
    const session = await startDebuggee(debuggee(), { mode: MODE.plain, stopAtEntry: true });
    eq(
      session.configuration['stopAtEntry'],
      true,
      '`stopAtEntry` is a declared launch attribute and must survive into the session config',
    );

    // Interaction 2 — the debuggee must stop with NOTHING executed.
    const [stop] = await recorder.waitForStops(1);
    assert.ok(
      stop,
      '`stopAtEntry: true` must pause the debuggee at its entry point. Running to completion ' +
        'means the attribute is declared in the manifest and ignored by the adapter',
    );
    neq(stop.reason, 'breakpoint', 'no breakpoint was armed, so this is not a breakpoint stop');
    const frame = await topFrame(session, stop.threadId);
    eq(methodOf(frame), 'Main', 'the entry stop must be in the entry point');
    eq(
      recorder.outputText().includes(ENV_UNSET),
      false,
      'stopping at ENTRY means before the first statement: any output already emitted proves ' +
        'the program ran first and the stop came too late to be useful',
    );

    // Interaction 3 — continue: the program then runs normally.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a stopAtEntry session, resumed');
    await recorder.waitForOutput('done plain 45');
    eq(recorder.stops().length, 1, 'stopAtEntry produces exactly one stop, not one per statement');
    assertCleanSession(debuggee(), 'a stopAtEntry launch');
  });

  // Implements [DEBUG-FEATURES-LAUNCH] "Launch with environment variables | P1"
  // and "Launch with custom working directory | P1".
  test('args, env and cwd from the configuration reach the debuggee', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — the configuration under test.
    const probeValue = 'sharplsp-env-probe-value';
    const config = launchConfigFor(fixture, { mode: MODE.plain, env: { [ENV_PROBE]: probeValue } });
    deepEq(config['args'], [MODE.plain], 'the mode is passed as argv[0]');
    eq(
      comparablePath(String(config['cwd'])),
      comparablePath(fixture.dir),
      'the working directory must be the project directory',
    );

    // Interaction 2 — launch and let it run.
    const session = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      env: { [ENV_PROBE]: probeValue },
    });
    deepEq(
      session.configuration['args'],
      [MODE.plain],
      'the session must carry the args the configuration named',
    );
    eq(
      (session.configuration['env'] as Record<string, string>)[ENV_PROBE],
      probeValue,
      'and the env block',
    );

    // Interaction 3 — the DEBUGGEE must observe both.
    await recorder.waitForOutput(`env=${probeValue}`);
    eq(
      recorder.outputText().includes(ENV_UNSET),
      false,
      '"Launch with environment variables" is P1: a configured variable that never reaches the ' +
        'debuggee makes every ASPNETCORE_* / DOTNET_* workflow impossible to debug',
    );
    await recorder.waitForOutput('done plain 45');
    eq(
      recorder.outputText().includes('total=8'),
      true,
      'argv[0] selected the `plain` branch, so the program ran its full body',
    );
    await assertRanToCompletion(recorder, 0, 'an env-carrying launch');
    assertCleanSession(debuggee(), 'args, env and cwd');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-NODEBUG] rules 1–3.
  test('Run without debugging ignores every armed breakpoint', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — arm three breakpoints a debug run would certainly hit.
    armBreakpoints(fixture, 'main-accumulate', 'main-inspect', 'main-done');
    eq(vscode.debug.breakpoints.length, 3, 'three breakpoints are armed before the run');

    // Interaction 2 — start with noDebug, the Ctrl/Cmd+F5 semantics.
    const session = await startDebuggee(debuggee(), { mode: MODE.plain, noDebug: true });
    eq(
      session.configuration['noDebug'],
      true,
      '[DEBUG-FEATURES-LAUNCH-NODEBUG]: VS Code stamps `noDebug` before the provider chain and ' +
        'the value survives into `session.configuration.noDebug`',
    );
    eq(session.type, DEBUG_TYPE_ID, 'a no-debug run is still a SharpLsp debug session');

    // Interaction 3 — the program must run straight through.
    await assertRanToCompletion(recorder, 0, 'a run without debugging');
    await recorder.waitForOutput('done plain 45');
    deepEq(
      recorder.stops().map((stop) => stop.reason),
      [],
      'rule 2: a run started through `startDebugging` with `noDebug: true` must run WITHOUT ' +
        'breakpoints. Stopping means the flag was dropped somewhere between the gesture and ' +
        'the adapter, and Ctrl+F5 has become a second F5',
    );
    eq(
      vscode.debug.breakpoints.length,
      3,
      'a no-debug run must not delete the user’s breakpoints — they apply to the NEXT debug run',
    );
    assertCleanSession(debuggee(), 'a no-debug run');
  });

  // Implements [DEBUG-PROTOCOL-CAPABILITIES] `supportsRestartRequest` and
  // [DEBUG-FEATURES-LAUNCH]: a restart is a fresh launch of the same config.
  test('Restart relaunches the same configuration and re-arms the breakpoints', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder, sessions } = debuggee();

    // Interaction 1 — reach a breakpoint in the first run.
    armBreakpoints(fixture, 'main-accumulate');
    const first = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [firstStop] = await recorder.waitForStops(1);
    assert.ok(firstStop, 'the first run must reach the breakpoint');
    assertStoppedAt(
      await topFrame(first, firstStop.threadId),
      fixture,
      'main-accumulate',
      'Main',
      'the first run',
    );
    eq(
      recorder.capabilities()['supportsRestartRequest'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsRestartRequest as Yes for Phase 4',
    );

    // Interaction 2 — Restart.
    await vscode.commands.executeCommand(CMD_RESTART);
    const stops = await recorder.waitForStops(2);
    const second = requireAt(stops, 1, 'the stop after the restart');
    assertStopReason(second, 'breakpoint', 'the restarted run');

    // Interaction 3 — the SAME breakpoints must be armed in the new run.
    const active = vscode.debug.activeDebugSession;
    assert.ok(active, 'a restart must leave a live session');
    eq(active.type, DEBUG_TYPE_ID, 'the restarted session is still ours');
    deepEq(
      active.configuration['args'],
      [MODE.plain],
      'a restart must reuse the configuration, not synthesise a new one',
    );
    assertStoppedAt(
      await topFrame(active, second.threadId),
      fixture,
      'main-accumulate',
      'Main',
      'the restarted run must stop on the same breakpoint',
    );
    eq(
      vscode.debug.breakpoints.length,
      1,
      'the breakpoint must survive the restart; a restart that clears breakpoints makes the ' +
        'gesture useless for the edit-run-inspect loop it exists for',
    );
    assert.ok(sessions.ours.length >= 1, 'the workbench reported the session lifecycle');

    // Interaction 4 — finish the restarted run cleanly.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await recorder.waitForOutput('done plain 45');
    assertCleanSession(debuggee(), 'a restart');
  });

  // Implements [DEBUG-PROTOCOL-CAPABILITIES] `supportsTerminateRequest` and the
  // "pause" half of [DEBUG-FEATURES-STEPPING]'s gesture set.
  test('Pause interrupts a running debuggee and Stop terminates the session', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { recorder } = debuggee();

    // Interaction 1 — launch a debuggee that is genuinely busy, with no breakpoints.
    const session = await startDebuggee(debuggee(), { mode: MODE.wait });
    await recorder.waitForOutput('boxed=8');
    deepEq(
      recorder.stops().map((stop) => stop.reason),
      [],
      'nothing has stopped it yet',
    );
    eq(
      recorder.capabilities()['supportsTerminateRequest'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] lists supportsTerminateRequest as Yes for Phase 4 — it is ' +
        'what lets the toolbar stop a debuggee gracefully instead of killing the process',
    );

    // Interaction 2 — Pause. A running debuggee must come to rest. The
    // workbench gesture resolves its target thread from the call-stack FOCUS,
    // which never exists in a headless host — `session.pause(threadId)` drives
    // the identical DAP `pause` request the gesture would send once focused.
    const threads = await session.customRequest('threads');
    const pausedThread = Array.isArray(threads?.threads) ? Number(threads.threads[0]?.id ?? 0) : 0;
    assert.ok(pausedThread > 0, 'a running session must expose a thread to pause');
    await session.customRequest('pause', { threadId: pausedThread });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(
      stop,
      'Pause must interrupt a RUNNING debuggee. A pause that never lands leaves the user with ' +
        'no way to inspect a program that is stuck',
    );
    assertStopReason(stop, 'pause', 'a pause stop');
    eq(recorder.requests('pause').length, 1, 'one Pause gesture, one DAP `pause` request');
    const frames = await topFrame(session, stop.threadId);
    assert.ok(frames.id > 0, 'a paused thread must still produce an inspectable frame');

    // Interaction 3 — continue, then Stop while it is still running.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await sleep(QUIET_MS);
    eq(vscode.debug.activeDebugSession?.id, session.id, 'the session is still alive');
    await vscode.commands.executeCommand(CMD_STOP);

    // Interaction 4 — the workbench must forget the session, promptly.
    const cleared = await pollUntilResult(
      async () => vscode.debug.activeDebugSession,
      (current) => current === undefined,
      30_000,
      50,
    );
    eq(
      cleared,
      undefined,
      'Stop must terminate the session and clear `activeDebugSession`; a session the workbench ' +
        'still believes is running leaves the debug toolbar stuck and blocks the next F5',
    );
    eq(
      recorder.events('terminated').length >= 1,
      true,
      'the adapter must report `terminated` so the workbench can tear the session down',
    );
    await stopDebuggee();
    assertCleanSession(debuggee(), 'pause and stop');
  });
});
