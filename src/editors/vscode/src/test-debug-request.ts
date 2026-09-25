/**
 * The Debug profile's request: refuse what no bundled debugger can attach to,
 * then hand the rest to the test-debug flow ([DEBUG-FEATURES-TESTS]).
 *
 * netcoredbg attaches to .NET only. A test host started for a .NET Framework
 * build under `VSTEST_HOST_DEBUG=1` waits for a debugger that never comes, so a
 * test built ONLY for .NET Framework is refused before anything starts, and a
 * test also built for .NET is debugged under its .NET frameworks alone.
 *
 * Implements [NETFX-DEBUG].
 */

import * as vscode from 'vscode';
import { info } from './log';
import { debugSelectedTests, type TestDebugHost } from './test-debug';
import { cancelled, type TestRunOptions, type TestRunOutcome } from './test-execution';
import { debugPlan, netFrameworkDebugRefusal, type FrameworkIndex } from './test-frameworks';
import { assembliesOf, runAssemblies } from './test-framework-runs';
import type { MtpRunPlan } from './test-listing-model';
import { reportAll, reportDebugOutcome } from './test-reporting';
import { filterIdsFor, runCwd } from './test-targets';

/** What a Debug request needs from the controller, read at request time. */
export interface DebugRequestHost {
  readonly controller: vscode.TestController;
  readonly frameworks: FrameworkIndex;
  readonly mtp: MtpRunPlan | undefined;
  collect(request: vscode.TestRunRequest): vscode.TestItem[];
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  dispatch(ids: readonly string[], cwd: string, options: TestRunOptions): Promise<TestRunOutcome>;
}

/** Run one Debug request end to end. */
export async function debugRequest(
  host: DebugRequestHost,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const selected = host.collect(request);
  if (selected.length === 0 || cancelled(token)) return;
  const run = host.controller.createTestRun(request);
  const plan = debugPlan(
    selected.map((test) => test.id),
    host.frameworks,
  );
  const tests = refuseNetFrameworkOnly(run, selected, plan.refused);
  const cwd = runCwd();
  if (cwd === undefined || tests.length === 0) {
    // No cache writes: a debug gesture must never fabricate a run result.
    if (cwd === undefined) reportAll(run, tests, 'No workspace folder or solution', () => undefined);
    run.end();
    return;
  }
  for (const test of tests) run.started(test);
  const ids = plan.refused.length > 0 ? tests.map((test) => test.id) : filterIdsFor(request, tests);
  await debugSelectedTests(debugHost(host, plan.frameworks), run, tests, token, cwd, ids);
}

/** Mark every refused test errored with the reason; return the rest. */
function refuseNetFrameworkOnly(
  run: vscode.TestRun,
  selected: readonly vscode.TestItem[],
  refused: readonly string[],
): vscode.TestItem[] {
  for (const test of selected.filter((each) => refused.includes(each.id))) {
    const refusal = netFrameworkDebugRefusal(test.id);
    info(`Test debug: ${refusal}`);
    run.errored(test, new vscode.TestMessage(refusal));
  }
  return selected.filter((test) => !refused.includes(test.id));
}

/**
 * The test-debug flow's host. With `frameworks` set the selection runs in
 * those .NET frameworks' built assemblies only, never starting a .NET
 * Framework host; otherwise each test goes to the runner that discovered it.
 */
function debugHost(host: DebugRequestHost, frameworks: readonly string[] | undefined): TestDebugHost {
  const assemblies = frameworks === undefined ? [] : assembliesOf(host.frameworks, frameworks);
  return {
    enqueue: async (work) => await host.enqueue(work),
    runSelection: async (ids, cwd, options) =>
      frameworks === undefined
        ? await host.dispatch(ids, cwd, options)
        : await runAssemblies(assemblies, ids, cwd, { ...options, debug: true }),
    // Run-only reporting: a debug run neither caches results nor announces a
    // results change — the last real run's outcome stands.
    finish: (run, tests, outcome) => {
      reportDebugOutcome(run, tests, outcome, host.mtp);
    },
  };
}
