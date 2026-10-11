// The per-test lifecycle of the Run/Debug suites: a fresh scratch directory and
// the observers every negative assertion needs — UI stubs, the debug sessions
// and the tasks a gesture starts — torn down in one safe order afterwards.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DebugSessionRecorder, TaskRecorder, stopAnyDebugSession } from './run-debug-kit';
import type { Quiet } from './run-debug-target-kit';
import { closeAllEditors, removeDirRecursive } from './test-helpers';
import { installUiStubs } from './ui-stubs';

/** One test's scratch directory, beside the observers armed around it. */
export interface RunDebugCase extends Quiet {
  readonly tmpDir: string;
}

/** Arm a fresh {@link RunDebugCase} (temp dir named `prefix…`) around every test. */
export function useRunDebugCase(prefix: string): () => RunDebugCase {
  let current: RunDebugCase | undefined;
  setup(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const stubs = installUiStubs();
    current = { tmpDir, stubs, sessions: new DebugSessionRecorder(), tasks: new TaskRecorder() };
  });
  teardown(async () => {
    const active = current;
    current = undefined;
    if (active === undefined) return;
    active.stubs.restore();
    await stopAnyDebugSession();
    active.sessions.dispose();
    active.tasks.dispose();
    await closeAllEditors();
    removeDirRecursive(active.tmpDir);
  });
  return () => {
    assert.ok(current, 'the run/debug case must be armed in setup');
    return current;
  };
}
