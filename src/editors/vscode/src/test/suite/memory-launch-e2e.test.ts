// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: memory profiling of a program
// running under the SharpLsp debugger, ported from Basilisk's memory-e2e suite
// onto a .NET debuggee.
//
// Basilisk read the heap through the debugger (tracemalloc over DAP evaluate),
// so its flows paused the program. The .NET runtime reads the heap directly and
// cannot read it while the debugger holds the program paused, so the same
// journeys run on the debugged program as it runs: it is snapshotted without a
// pause, Run & Track Memory ends in a visible result, and tracking survives
// every session but its own ending.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activeMemorySession,
  memoryStatusText,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-profiler';
import { lastMemorySnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-capture';
import { delay } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';
import { memoryDashboardState } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import {
  appliedMemoryDecorations,
  clearMemoryDecorations,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-decorations';
import type { MemoryStep, SuspectedLeak } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import { completed, execute, profilerStore } from './profiler-kit';
import { comparablePath } from './test-helpers';
import { pollUntilResult } from './profiler-ui-helpers';
import {
  LEAK_LINES,
  debuggeePid,
  launch,
  launchConfig,
  showProgram,
  useDebuggee,
} from './profiler-ui-debuggee';

const WIDGET_TYPE = 'LoopLeak.Widget';
/** The purple memory-allocation palette. */
const MEMORY_PALETTE = ['#c084fc', '#a78bfa', '#8b5cf6', '#7c3aed'];
const STEP_MS = 60_000;
/** Time for the program to leak more between passes. */
const GROWTH_MS = 2_000;

/** The suspected leaks of a wire diff. */
async function diffLeaks(memorySessionId: string): Promise<SuspectedLeak[]> {
  const result = completed(
    await execute<MemoryStep>('memory.diff', { memory_session_id: memorySessionId }),
  );
  assert.equal(result.outcome.kind, 'Diff', 'a diff answers with a diff');
  return (result.outcome as { leaks: SuspectedLeak[] }).leaks;
}

/** Start tracking `pid` through the real command and wait for the store to agree. */
async function startTracking(pid: number): Promise<string> {
  await vscode.commands.executeCommand('sharplsp.profiler.memoryStart', pid);
  const id = await pollUntilResult({
    fn: () => activeMemorySession(),
    until: (found) => found !== undefined,
    timeoutMs: STEP_MS,
    description: 'memory tracking to start',
  });
  assert.ok(id !== undefined);
  return id;
}

suite('Memory profiling — real end-to-end', () => {
  const { debuggee: built, recorder } = useDebuggee('mem-launch-', async () => {
    await vscode.commands.executeCommand('sharplsp.profiler.memoryStop');
    clearMemoryDecorations();
  });

  test('round-trip on a debug-launched program: snapshot real allocations, diff growth into leaks, paint the purple track', async function () {
    this.timeout(STEP_MS * 4);
    const target = built();
    await showProgram(target);
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    const session = await launch(target, launchConfig(target, 'Memory E2E'));

    // Pass 1: start tracking and seed the diff baseline.
    const memorySessionId = await startTracking(await debuggeePid(session));
    await diffLeaks(memorySessionId);
    await delay(GROWTH_MS);

    // Pass 2: snapshot real allocations and diff the growth into a leak.
    await vscode.commands.executeCommand('sharplsp.profiler.memorySnapshot');
    const snapshot = await pollUntilResult({
      fn: () => lastMemorySnapshot(),
      until: (snap) => snap?.topAllocations.some((site) => site.typeName === WIDGET_TYPE) === true,
      timeoutMs: STEP_MS,
      description: 'a snapshot naming the leaked Widget',
    });
    assert.ok(snapshot);
    const painted = appliedMemoryDecorations().filter(
      (entry) => comparablePath(entry.file) === comparablePath(target.program),
    );
    assert.ok(
      painted.some(
        (entry) => LEAK_LINES.includes(entry.line) && MEMORY_PALETTE.includes(entry.color),
      ),
      `the purple track must paint the leaked Widget: ${JSON.stringify(painted)}`,
    );
    const leaks = await diffLeaks(memorySessionId);
    assert.ok(
      leaks.some((leak) => leak.type_name === WIDGET_TYPE && leak.size_growth > 0),
      `the growing Widget must be a suspected leak: ${JSON.stringify(leaks)}`,
    );
    await delay(GROWTH_MS);

    // Pass 3: consecutive growth keeps the site suspected.
    const again = await diffLeaks(memorySessionId);
    assert.ok(
      again.some((leak) => leak.type_name === WIDGET_TYPE),
      `consecutive growth must keep the leak suspected: ${JSON.stringify(again)}`,
    );
  });

  test('a running (not paused) debuggee needs no evaluable frame — a snapshot completes without pausing it', async function () {
    this.timeout(STEP_MS * 2);
    const target = built();
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    const session = await launch(target, launchConfig(target, 'Running snapshot'));
    const started = await execute<{ memory_session_id: string }>('memory.start', {
      pid: await debuggeePid(session),
    });
    const result = completed(
      await execute<MemoryStep>('memory.snapshot', {
        memory_session_id: started.memory_session_id,
      }),
    );
    assert.equal(result.outcome.kind, 'Snapshot', 'the running program is snapshotted as it runs');
    assert.deepEqual(recorder().stops(), [], 'the debuggee is never paused to take it');
    completed(
      await execute<MemoryStep>('memory.stop', { memory_session_id: started.memory_session_id }),
    );
  });

  test('memory ops on a RUNNING program: snapshot real allocations, and it keeps running', async function () {
    this.timeout(STEP_MS * 2);
    const target = built();
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    await showProgram(target);
    const session = await launch(target, launchConfig(target, 'Running memory ops'));
    await startTracking(await debuggeePid(session));
    await vscode.commands.executeCommand('sharplsp.profiler.memorySnapshot');
    const snapshot = await pollUntilResult({
      fn: () => lastMemorySnapshot(),
      until: (snap) => snap !== undefined,
      timeoutMs: STEP_MS,
      description: 'a snapshot of the running program',
    });
    assert.ok(
      snapshot?.topAllocations.some((site) => site.typeName === WIDGET_TYPE),
      `the snapshot must hold the real Widget allocations: ${JSON.stringify(snapshot?.topAllocations)}`,
    );
    assert.deepEqual(recorder().stops(), [], 'the program is never paused');
    assert.equal(vscode.debug.activeDebugSession?.id, session.id, 'and it is still running');
  });

  test('Run & Track Memory (Current File): the run finalises into a visible memory result on session end (#146)', async function () {
    this.timeout(STEP_MS * 3);
    const target = built();
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    await showProgram(target);
    await vscode.commands.executeCommand('sharplsp.profiler.trackMemoryCurrentFile');
    await pollUntilResult({
      fn: () => activeMemorySession(),
      until: (found) => found !== undefined,
      timeoutMs: STEP_MS,
      description: 'Run & Track Memory to start tracking the launched program',
    });
    // The program's default run ends by itself; tracking must end with it.
    await pollUntilResult({
      fn: () => vscode.debug.activeDebugSession,
      until: (active) => active === undefined,
      timeoutMs: STEP_MS,
      description: 'the tracked program to finish',
    });
    await pollUntilResult({
      fn: () => profilerStore().profiler.value.memory,
      until: (state) => state === 'idle',
      timeoutMs: 10_000,
      description: 'tracking to finalise on session end',
    });
    assert.ok(
      memoryDashboardState() !== undefined,
      'a run that ended must leave a visible memory result, never nothing (#146)',
    );
  });

  test('the memory status bar follows the whole session lifecycle — never stale, never silent', async function () {
    this.timeout(STEP_MS * 3);
    const target = built();
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    assert.equal(memoryStatusText(), undefined, 'hidden before tracking');
    const session = await launch(target, launchConfig(target, 'Memory status bar'));
    await startTracking(await debuggeePid(session));
    assert.ok(
      memoryStatusText()?.includes('tracking'),
      `tracking shows: ${String(memoryStatusText())}`,
    );
    await vscode.commands.executeCommand('sharplsp.profiler.memorySnapshot');
    assert.ok(memoryStatusText() !== undefined, 'still shown after a snapshot');
    await vscode.debug.stopDebugging(session);
    await pollUntilResult({
      fn: () => memoryStatusText(),
      until: (text) => text === undefined,
      timeoutMs: 20_000,
      description: 'the status bar to clear when the tracked session ends',
    });
  });

  test('an unrelated debug session ending does not tear down live memory tracking (#146)', async function () {
    this.timeout(STEP_MS * 3);
    const target = built();
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    const tracked = await launch(target, launchConfig(target, 'Tracked run'));
    const memorySessionId = await startTracking(await debuggeePid(tracked));

    const started = await vscode.debug.startDebugging(
      target.folder,
      launchConfig(target, 'Unrelated run', 2),
    );
    assert.ok(started, 'the unrelated session must launch');
    await pollUntilResult({
      fn: () => vscode.debug.activeDebugSession?.name,
      until: (name) => name !== 'Unrelated run',
      timeoutMs: STEP_MS,
      description: 'the unrelated session to end',
    });
    assert.equal(
      activeMemorySession(),
      memorySessionId,
      'only the tracked session ending may finalise tracking',
    );
  });
});
