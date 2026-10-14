// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// Memory profiling, real end-to-end in direct mode: the .NET engine snapshots
// the live heap of `ProfileLeakTarget` over EventPipe (no pause, no debugger),
// the diff scores the growing `LeakedPayload` as a leak, the retention graph
// reaches the static `Items` root, an induced collection is observed, and the
// memory track paints the fixture source. Ported from Basilisk's memory-e2e,
// memory-introspection-e2e and the interval mode of memory-autopilot-e2e; the
// pause-driven courier flows are Python's and have no direct-mode analogue.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  appliedMemoryDecorations,
  memoryStatusText,
  recordedAutopilotCaptures,
  recordedOperations,
} from '@nimblesite/lsp-profiler-ui';
import type { MemoryStep, RefGraph } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  execute,
  fixtureSource,
  openSource,
  profilerStore,
  Target,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { closeAllEditors, setupLspTestSuite, teardownLspTestSuite } from './test-helpers';
import { ACTIVATION_MS, PROCESS_START_MS, SETTINGS_WRITE_MS } from './test-timeouts';

const LEAK_TYPE = 'ProfileLeakTarget.LeakedPayload';
const STEP_MS = 90_000;
const GROWTH_MS = 2_000;

function completed(step: MemoryStep): Extract<MemoryStep, { kind: 'Completed' }>['result'] {
  if (step.kind !== 'Completed') {
    throw new Error(`direct mode completes every step: ${JSON.stringify(step)}`);
  }
  return step.result;
}

suite('Memory profiling — real end-to-end (direct mode)', () => {
  let tmpDir = '';
  let target: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-mem-'));
    target = await Target.start('ProfileLeakTarget');
  });
  suiteTeardown(async () => {
    target?.stop();
    await vscode.workspace
      .getConfiguration('sharplsp')
      .update('profiler.autoSnapshot', undefined, vscode.ConfigurationTarget.Global);
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  test('Track Memory on a row → snapshot paints the memory track → diff scores the growing type as a leak → stop', async function () {
    this.timeout(STEP_MS * 3);
    assert.ok(target);
    const store = profilerStore();
    await openSource(fixtureSource('ProfileLeakTarget'));

    await vscode.commands.executeCommand(uiCommand('memoryStart'), target.pid);
    await waitFor(
      () => store.profiler.value.memory,
      (memory) => memory === 'active',
      PROCESS_START_MS,
      'memory session active',
    );
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

    await vscode.commands.executeCommand(uiCommand('memoryStop'));
    await waitFor(
      () => store.profiler.value.memory,
      (memory) => memory === 'idle',
      PROCESS_START_MS,
      'memory session stopped',
    );
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
    assert.ok(target);
    const started = await execute<{ memory_session_id: string }>('memory.start', {
      pid: target.pid,
    });
    const session = { memory_session_id: started.memory_session_id };
    completed(await execute<MemoryStep>('memory.snapshot', session));
    const refs = completed(
      await execute<MemoryStep>('memory.references', {
        ...session,
        type_name: LEAK_TYPE,
        limit: 40,
        max_depth: 6,
      }),
    );
    assert.equal(refs.outcome.kind, 'Refs');
    const graph = (refs.outcome as { graph: RefGraph }).graph;
    assert.ok(
      graph.nodes.some((node) => node.is_target && node.type_name === LEAK_TYPE),
      'target nodes present',
    );
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
    assert.ok(target);
    const store = profilerStore();
    const config = vscode.workspace.getConfiguration('sharplsp');
    await config.update('profiler.autoSnapshot', true, vscode.ConfigurationTarget.Global);
    await config.update('profiler.autoSnapshotInterval', 1, vscode.ConfigurationTarget.Global);
    const before = recordedAutopilotCaptures().length;
    await vscode.commands.executeCommand(uiCommand('memoryStart'), target.pid);
    await waitFor(
      () => store.profiler.value.memory,
      (memory) => memory === 'active',
      PROCESS_START_MS,
      'memory session active',
    );
    await waitFor(
      () => recordedAutopilotCaptures().length,
      (count) => count > before,
      STEP_MS,
      'an automatic capture',
    );
    await vscode.commands.executeCommand(uiCommand('memoryStop'));
    await waitFor(
      () => store.profiler.value.memory,
      (memory) => memory === 'idle',
      PROCESS_START_MS,
      'memory session stopped',
    );
    await config.update(
      'profiler.autoSnapshotInterval',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });
});
