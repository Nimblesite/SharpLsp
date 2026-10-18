// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// Memory profiling, real end-to-end in direct mode: the .NET engine snapshots
// the live heap of `ProfileLeakTarget` over EventPipe (no pause, no debugger),
// the diff scores the growing `LeakedPayload` as a leak, the retention graph
// reaches the static `Items` root, an induced collection is observed, and the
// memory track paints the fixture source, all on a plain running process. The
// debug-launched journeys of Basilisk's memory-e2e, memory-introspection-e2e and
// memory-autopilot-e2e live in the suites of those names, on a .NET debuggee.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  appliedMemoryDecorations,
  memoryStatusText,
  recordedAutopilotCaptures,
  recordedOperations,
} from '@nimblesite/lsp-profiler-ui';
import type { MemoryStep } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  execute,
  fixtureSource,
  openSource,
  profilerStore,
  profilingSuite,
  retentionGraph,
  snapshotSession,
  stopTracking,
  trackMemory,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { SETTINGS_WRITE_MS } from './test-timeouts';

const LEAK_TYPE = 'ProfileLeakTarget.LeakedPayload';
const STEP_MS = 90_000;
const GROWTH_MS = 2_000;

suite('Memory profiling — real end-to-end (direct mode)', () => {
  const live = profilingSuite('profiler-mem-', 'ProfileLeakTarget', {
    stopped: () =>
      vscode.workspace
        .getConfiguration('sharplsp')
        .update('profiler.autoSnapshot', undefined, vscode.ConfigurationTarget.Global),
  });

  test('Track Memory on a row → snapshot paints the memory track → diff scores the growing type as a leak → stop', async function () {
    this.timeout(STEP_MS * 3);
    const { target } = live;
    const store = profilerStore();
    await openSource(fixtureSource('ProfileLeakTarget'));

    await trackMemory(target.pid);
    assert.ok(
      memoryStatusText()?.includes('tracking'),
      `status bar follows the session: ${memoryStatusText()}`,
    );

    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    const painted = await waitFor(
      () => appliedMemoryDecorations(),
      (applied) => applied.some((d) => d.file.endsWith('Program.cs')),
      STEP_MS,
      'memory track painted',
    );
    assert.ok(painted.length > 0);

    await new Promise((resolve) => setTimeout(resolve, GROWTH_MS));
    const diff = completed(
      await execute<MemoryStep>('memory.diff', {
        memory_session_id: store.profiler.value.memorySessionId,
      }),
    );
    assert.equal(diff.outcome.kind, 'Diff');
    if (diff.outcome.kind === 'Diff') {
      const grown = diff.outcome.diff.grown.find((site) => site.type_name === LEAK_TYPE);
      assert.ok(
        grown && grown.count_diff > 0,
        `${LEAK_TYPE} grew: ${JSON.stringify(diff.outcome.diff.grown.map((g) => g.type_name))}`,
      );
      assert.ok(
        diff.outcome.leaks.some((leak) => leak.type_name === LEAK_TYPE),
        'the growing type is a suspected leak',
      );
    }

    await stopTracking();
    assert.equal(
      memoryStatusText(),
      undefined,
      'the status bar hides once idle with no debug session',
    );
    const operations = recordedOperations();
    assert.ok(
      operations.some((op) => op.startsWith('begin:SharpLsp: Starting memory tracking')),
      'start narrates progress',
    );
    assert.ok(
      operations.some((op) => op.startsWith('end:SharpLsp: Taking memory snapshot')),
      'snapshot narrates progress and closes it',
    );
  });

  test('reference graph: walking the leaked type reaches real targets and the static Items root; gc collect is observed', async function () {
    this.timeout(STEP_MS * 3);
    const { target } = live;
    const session = await snapshotSession(target.pid);
    const graph = await retentionGraph(session, LEAK_TYPE);
    assert.ok(
      graph.nodes.some(
        (node) => node.is_root && node.root_kind === 'Static' && node.label === 'static Items',
      ),
      `the static Items root holds the leak: ${JSON.stringify(graph.nodes.filter((n) => n.is_root))}`,
    );
    assert.ok(graph.edges.length > 0, 'edges present');

    const gc = completed(await execute<MemoryStep>('memory.gcCollect', session));
    assert.equal(gc.outcome.kind, 'Gc');
    assert.equal(
      (gc.outcome as { gc: { collected: number } }).gc.collected,
      1,
      'a collection completed',
    );
    completed(await execute<MemoryStep>('memory.stop', session));
  });

  test('interval autopilot: with autoSnapshot on, a running program is captured on a timer without any pause', async function () {
    this.timeout(STEP_MS * 2 + SETTINGS_WRITE_MS);
    const { target } = live;
    const config = vscode.workspace.getConfiguration('sharplsp');
    await config.update('profiler.autoSnapshot', true, vscode.ConfigurationTarget.Global);
    await config.update('profiler.autoSnapshotInterval', 1, vscode.ConfigurationTarget.Global);
    const before = recordedAutopilotCaptures().length;
    await trackMemory(target.pid);
    await waitFor(
      () => recordedAutopilotCaptures().length,
      (count) => count > before,
      STEP_MS,
      'an automatic capture',
    );
    await stopTracking();
    await config.update(
      'profiler.autoSnapshotInterval',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });
});
