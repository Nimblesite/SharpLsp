// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: memory introspection of a
// debug-launched program, ported from Basilisk's memory-introspection-e2e suite
// onto .NET.
//
// The user asks what holds their objects, or forces a collection, on the
// program they are debugging. Basilisk did both at a breakpoint, through the
// debugger. A .NET heap is read directly and cannot be read while the debugger
// holds the program paused, so both run while it runs, and a step asked for at
// a breakpoint is refused at once with the reason instead of hanging until the
// program continues (lsp-profiler's PROF-MEMORY-MODE).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { lastMemorySnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-capture';
import { isDebuggeePaused } from '@nimblesite/lsp-profiler-ui/out/src/debuggee-pause';
import { delay } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';
import type { MemoryStep, RefGraph } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import { completed, execute, trackMemory } from './profiler-kit';
import { captureWarnings, pollUntilResult } from './profiler-ui-helpers';
import {
  LOOP_LINE,
  debuggeePid,
  launch,
  launchConfig,
  resume,
  setBreakpoints,
  waitForPause,
  useDebuggee,
} from './profiler-ui-debuggee';

const WIDGET_TYPE = 'LoopLeak.Widget';
const REFUSAL_MS = 5_000;

suite('Memory introspection — real end-to-end', () => {
  const harness = useDebuggee('mem-introspect-', async () =>
    vscode.commands.executeCommand('sharplsp.profiler.memoryStop'),
  );

  /** Launch the program under the debugger and start a memory session on it. */
  async function debuggedSession(): Promise<{ memory_session_id: string }> {
    const debuggee = harness.debuggee();
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    const session = await launch(debuggee, launchConfig(debuggee, 'Memory introspection'));
    const started = await execute<{ memory_session_id: string }>('memory.start', {
      pid: await debuggeePid(session),
    });
    assert.ok(started.memory_session_id.length > 0, 'a memory session must be minted');
    return { memory_session_id: started.memory_session_id };
  }

  test('reference graph: walking a retained custom type yields real target nodes + edges', async function () {
    this.timeout(120_000);
    const session = await debuggedSession();
    completed(await execute<MemoryStep>('memory.snapshot', session));
    const refs = completed(
      await execute<MemoryStep>('memory.references', {
        ...session,
        type_name: WIDGET_TYPE,
        limit: 40,
        max_depth: 4,
      }),
    );
    assert.equal(refs.outcome.kind, 'Refs', 'references must answer with a graph');
    const graph = (refs.outcome as { graph: RefGraph }).graph;
    assert.ok(
      graph.nodes.some((node) => node.is_target && node.type_name === WIDGET_TYPE),
      `the retained Widget instances must appear as target nodes, got types: ${graph.nodes
        .map((node) => node.type_name)
        .join(', ')}`,
    );
    assert.ok(graph.edges.length > 0, 'the graph must carry the retaining edges');
    assert.ok(
      graph.nodes.some((node) => node.is_root && node.label === 'static Cache'),
      `the static Cache root holds them: ${JSON.stringify(graph.nodes.filter((n) => n.is_root))}`,
    );
    completed(await execute<MemoryStep>('memory.stop', session));
  });

  test('gc collect: a dropped finalizer cycle is really collected and surfaced', async function () {
    this.timeout(120_000);
    const session = await debuggedSession();
    const gc = completed(await execute<MemoryStep>('memory.gcCollect', session));
    assert.equal(gc.outcome.kind, 'Gc', 'gcCollect must answer with a collection result');
    assert.ok(
      (gc.outcome as { gc: { collected: number } }).gc.collected > 0,
      `a forced collection on the debugged program must be reported: ${JSON.stringify(gc.outcome)}`,
    );
    completed(await execute<MemoryStep>('memory.stop', session));
  });

  test('at a breakpoint a memory step is refused at once with the reason, and works after Continue', async function () {
    this.timeout(120_000);
    const debuggee = harness.debuggee();
    setBreakpoints(debuggee, [LOOP_LINE]);
    const session = await launch(debuggee, launchConfig(debuggee, 'Paused introspection'));
    await waitForPause(harness.recorder(), 1);
    await trackMemory(await debuggeePid(session));

    const asked = Date.now();
    const warnings = await captureWarnings(async () =>
      vscode.commands.executeCommand('sharplsp.profiler.memorySnapshot'),
    );
    assert.ok(Date.now() - asked < REFUSAL_MS, 'the refusal is immediate, never a hang');
    assert.ok(
      warnings.some((warning) => warning.includes('Continue the program to read its memory')),
      `the user is told why and what to do: ${JSON.stringify(warnings)}`,
    );
    assert.equal(lastMemorySnapshot(), undefined, 'nothing was captured while paused');

    // A tight loop pauses again until the adapter has dropped the breakpoint;
    // a heap read started before then would block at that pause.
    const acknowledged = harness.recorder().responses('setBreakpoints').length;
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    await pollUntilResult({
      fn: () => harness.recorder().responses('setBreakpoints').length,
      until: (count) => count > acknowledged,
      timeoutMs: 30_000,
      description: 'the adapter to drop the breakpoint',
    });
    await pollUntilResult({
      fn: async () => {
        if (isDebuggeePaused(session.id)) await resume();
        await delay(500);
        return isDebuggeePaused(session.id);
      },
      until: (paused) => !paused,
      timeoutMs: 30_000,
      description: 'the program to run again after Continue',
    });
    await vscode.commands.executeCommand('sharplsp.profiler.memorySnapshot');
    await pollUntilResult({
      fn: () => lastMemorySnapshot()?.topAllocations.some((site) => site.typeName === WIDGET_TYPE),
      until: (found) => found === true,
      timeoutMs: 60_000,
      description: 'a snapshot of the running program once it continued',
    });
  });
});
