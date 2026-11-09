// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. The suite scaffolding the
// profiler concurrency suites share: the CPU and leak .NET fixtures running
// side by side in one scratch directory, and the wire kill they verify.
import * as assert from 'node:assert/strict';
import { setupLspTestSuite, teardownLspTestSuite } from './test-helpers';
import { ACTIVATION_MS, PROCESS_START_MS } from './test-timeouts';
import { execute, Target } from './profiler-kit';

/** Two live fixtures of a suite: the CPU target and the leak target. */
export interface TwoTargetsSuite {
  readonly first: Target;
  readonly second: Target;
}

/**
 * The suite lifecycle of the CPU and leak fixtures side by side: a scratch dir
 * under `prefix`, both targets started before `started` runs, and everything
 * torn down (`stopped` first) with the suite.
 */
export function twoTargetsSuite(
  prefix: string,
  started?: () => PromiseLike<unknown>,
  stopped?: () => unknown,
): TwoTargetsSuite {
  let tmpDir = '';
  let first: Target | undefined;
  let second: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS * 2);
    // Each target is kept the moment it starts, so a second that fails to
    // start still leaves the first for the teardown to stop.
    ({ tmpDir } = await setupLspTestSuite(prefix));
    first = await Target.start('ProfileTarget');
    second = await Target.start('ProfileLeakTarget');
    await started?.();
  });
  suiteTeardown(() => {
    stopped?.();
    first?.stop();
    second?.stop();
    teardownLspTestSuite(tmpDir);
  });
  return {
    get first() {
      assert.ok(first, 'the CPU fixture must be running');
      return first;
    },
    get second() {
      assert.ok(second, 'the leak fixture must be running');
      return second;
    },
  };
}

/** Kill `victim` over the wire and assert the server confirms the kill. */
export async function killOnWire(victim: Target): Promise<void> {
  const result = await execute<{ pid: number; killed: boolean }>('kill', { pid: victim.pid });
  assert.deepEqual(result, { pid: victim.pid, killed: true });
}
