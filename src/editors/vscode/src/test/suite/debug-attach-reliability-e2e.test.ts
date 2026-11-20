// Attach reliability: twenty consecutive attaches. netcoredbg's attach is known
// to refuse intermittently (Samsung/netcoredbg #205, `0x80070057`), and
// [DEBUG-GAPS] commits SharpLsp to absorb that with retries. Each attach must be
// accepted, pause the live thread, and detach without killing the process.
//
// Every attempt attaches to a FRESH process: the fixture waits 30 seconds and
// then exits, and twenty attaches on a slow runner outlast that. Each attempt's
// session is the one that STARTED for it, never `activeDebugSession`, which can
// still name the previous attempt's ending session.
//
// Implements the "Attach reliability" P1 row of [DEBUG-FEATURES-LAUNCH].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  attachConfig,
  isAlive,
  killSpawned,
  pauseAttached,
  startAliveOutside,
} from './debug-attach-kit';
import type { DapRecorder } from './debug-dap-kit';
import { CMD_STOP, assertStopReason } from './debug-drive-kit';
import type { DebugFixture } from './debug-fixture-programs';
import { assertCleanSession, stopDebuggee, useDebuggee } from './debug-suite-kit';
import { DebugSessionRecorder } from './run-debug-kit';
import { eq, requireAt } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

/** Consecutive attaches the plan's reliability row asks for. */
const ATTEMPTS = 20;

/** At least 95% of them must succeed. */
const REQUIRED = Math.ceil(ATTEMPTS * 0.95);

/** What one attempt needs: where to attach from, and what records it. */
interface Attempt {
  readonly fixture: DebugFixture;
  readonly folder: vscode.WorkspaceFolder;
  readonly recorder: DapRecorder;
  readonly sessions: DebugSessionRecorder;
}

/** Attach to `pid` and pause it; the session is the one this attach started. */
async function attachAndPause(attempt: Attempt, pid: number): Promise<void> {
  const started = attempt.sessions.ours.length;
  const stops = attempt.recorder.stops().length;
  assert.ok(await vscode.debug.startDebugging(attempt.folder, attachConfig({ processId: pid })));
  await attempt.sessions.waitForSessions(started + 1);
  const session = attempt.sessions.liveOurs.find(
    (live) => live.id === requireAt(attempt.sessions.ours, started, 'this attach').id,
  );
  assert.ok(session, 'the session this attach started is live');
  eq(Number(session.configuration['processId']), pid, 'the attach aims at this attempt’s pid');
  await pauseAttached(session);
  await attempt.recorder.waitForStops(stops + 1);
}

/** Why one attempt failed, or `undefined` when it attached, paused and detached. */
async function attachOnce(attempt: Attempt): Promise<string | undefined> {
  const running = await startAliveOutside(attempt.fixture, 'each attempt starts a live process');
  let failure: string | undefined;
  try {
    await attachAndPause(attempt, running.pid);
  } catch (error) {
    failure = String(error);
  }
  await vscode.commands.executeCommand(CMD_STOP);
  await stopDebuggee();
  assert.ok(isAlive(running.pid), 'stopping an attach detaches; the process keeps running');
  process.kill(running.pid);
  return failure;
}

suite('Debug attach — twenty consecutive attaches', () => {
  const debuggee = useDebuggee('debug-attach-twenty-', 'csharp');

  teardown(async function () {
    this.timeout(DEBUG_TEST_MS);
    await killSpawned();
  });

  test('at least 19 of 20 attaches pause a live process, and every detach leaves it running', async function () {
    this.timeout(DEBUG_TEST_MS * ATTEMPTS);
    const { fixture, folder, recorder } = debuggee();
    const sessions = new DebugSessionRecorder();
    try {
      const failures: string[] = [];
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        const failure = await attachOnce({ fixture, folder, recorder, sessions });
        if (failure !== undefined) failures.push(`attempt ${String(attempt)}: ${failure}`);
        eq(
          vscode.debug.activeDebugSession,
          undefined,
          `attempt ${String(attempt)} left no session`,
        );
      }
      assert.ok(
        ATTEMPTS - failures.length >= REQUIRED,
        `${String(REQUIRED)} of ${String(ATTEMPTS)} attaches must succeed; failures: ${failures.join(' | ')}`,
      );
      eq(sessions.ours.length, ATTEMPTS, 'every attempt started exactly one session');
      eq(sessions.liveOurs.length, 0, 'and every one of them ended');
      const stops = recorder.stops();
      assert.ok(stops.length >= REQUIRED, 'every successful attach recorded its own pause');
      for (const stop of stops) assertStopReason(stop, 'pause', 'an attach pause');
      assertCleanSession(debuggee(), 'twenty consecutive attaches');
    } finally {
      sessions.dispose();
    }
  });
});
