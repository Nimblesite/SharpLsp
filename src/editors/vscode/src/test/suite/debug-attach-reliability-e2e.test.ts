// Attach reliability: twenty consecutive attaches to ONE long-running process.
// netcoredbg's attach is known to refuse intermittently (Samsung/netcoredbg
// #205, `0x80070057`), and [DEBUG-GAPS] commits SharpLsp to absorb that with
// retries. Each attach must be accepted, pause the live thread, and detach
// without killing the process, so the twenty-first attach finds it alive.
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
import { startAttached } from './debug-flow-kit';
import { assertCleanSession, stopDebuggee, useDebuggee } from './debug-suite-kit';
import { eq, sleep } from './test-helpers';
import { DEBUG_TEST_MS, QUIET_MS } from './test-timeouts';

/** Consecutive attaches the plan's reliability row asks for. */
const ATTEMPTS = 20;

/** At least 95% of them must succeed. */
const REQUIRED = Math.ceil(ATTEMPTS * 0.95);

/** Why one attach failed, or `undefined` when it attached, paused and detached. */
async function attachOnce(
  folder: vscode.WorkspaceFolder,
  pid: number,
  recorder: DapRecorder,
): Promise<string | undefined> {
  const before = recorder.stops().length;
  try {
    const session = await startAttached(
      folder,
      attachConfig({ processId: pid }),
      'refused',
      'no session',
    );
    eq(Number(session.configuration['processId']), pid, 'each attach aims at the same pid');
    await pauseAttached(session);
    await recorder.waitForStops(before + 1);
    return undefined;
  } catch (error) {
    return String(error);
  } finally {
    await vscode.commands.executeCommand(CMD_STOP);
    await stopDebuggee();
  }
}

suite('Debug attach — twenty consecutive attaches to one running process', () => {
  const debuggee = useDebuggee('debug-attach-twenty-', 'csharp');

  teardown(async function () {
    this.timeout(DEBUG_TEST_MS);
    await killSpawned();
  });

  test('at least 19 of 20 attaches pause the live process, and every detach leaves it running', async function () {
    this.timeout(DEBUG_TEST_MS * ATTEMPTS);
    const { fixture, folder, recorder } = debuggee();
    const running = await startAliveOutside(
      fixture,
      'the process is alive before the first attach',
    );

    const failures: string[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const failure = await attachOnce(folder, running.pid, recorder);
      if (failure !== undefined) failures.push(`attempt ${String(attempt)}: ${failure}`);
      assert.ok(
        isAlive(running.pid),
        `attempt ${String(attempt)} detached without killing the process`,
      );
      eq(
        vscode.debug.activeDebugSession,
        undefined,
        `attempt ${String(attempt)} left no session behind`,
      );
    }

    assert.ok(
      ATTEMPTS - failures.length >= REQUIRED,
      `${String(REQUIRED)} of ${String(ATTEMPTS)} attaches must succeed; failures: ${failures.join(' | ')}`,
    );
    const stops = recorder.stops();
    assert.ok(stops.length >= REQUIRED, 'every successful attach recorded its own pause');
    for (const stop of stops) assertStopReason(stop, 'pause', 'an attach pause');
    await sleep(QUIET_MS);
    assert.ok(isAlive(running.pid), 'twenty detaches later, the process is still the user’s');
    assertCleanSession(debuggee(), 'twenty consecutive attaches');
  });
});
