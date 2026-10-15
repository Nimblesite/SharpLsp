// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// Memory sessions against a live, leaking .NET target. Over the wire: every
// refusal carries its protocol code and leaves no session behind, objects of a
// type are listed largest first, the timeline grows per snapshot, a stopped
// session is gone, and a cancelled request answers -32800 while the next one
// works. Through the UI: start, snapshot, the branded dashboard showing the
// runtime's own type names, diff, a reference graph picked from the types the
// runtime reported, an induced GC, a second start refused, and stop clearing
// every overlay. Ported from Basilisk's memory-e2e, memory-introspection-e2e,
// memory-dashboard and profiler-memory-integration suites; the courier and
// tracemalloc specifics are Python's and have no direct-mode analogue.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode-languageclient/node';
import {
  appliedMemoryDecorations,
  contextKeyValues,
  lastMemorySnapshot,
  memoryDashboardState,
  memoryStatusText,
  processesViewState,
  refGraphState,
} from '@nimblesite/lsp-profiler-ui';
import type {
  MemoryStartResult,
  MemoryStep,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  execute,
  executeError,
  fixtureSource,
  lspClient,
  lspCommand,
  openSource,
  profilerStore,
  Target,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { closeAllEditors, setupLspTestSuite, teardownLspTestSuite } from './test-helpers';
import { ACTIVATION_MS, COMMAND_MS, LSP_RESPONSE_MS, PROCESS_START_MS } from './test-timeouts';

const LEAK_TYPE = 'ProfileLeakTarget.LeakedPayload';
const STEP_MS = 90_000;

/** The suspected leaks the dashboard embedded for its script (`const leaks = [...]`). */
function embeddedLeaks(html: string): { typeName?: string }[] {
  const marker = 'const leaks = ';
  const at = html.indexOf(marker);
  if (at < 0) return [];
  const end = html.indexOf(';\n', at);
  try {
    return JSON.parse(html.slice(at + marker.length, end)) as { typeName?: string }[];
  } catch {
    return [];
  }
}

function completed(step: MemoryStep): Extract<MemoryStep, { kind: 'Completed' }>['result'] {
  if (step.kind !== 'Completed') {
    throw new Error(`direct mode completes every step: ${JSON.stringify(step)}`);
  }
  return step.result;
}

suite('Memory sessions — wire refusals and lifecycle', () => {
  let tmpDir = '';
  let target: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-mem-wire-'));
    target = await Target.start('ProfileLeakTarget');
  });
  suiteTeardown(() => {
    target?.stop();
    teardownLspTestSuite(tmpDir);
  });

  test('memory.start on a PID that names no process is PROCESS_NOT_FOUND', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const error = await executeError('memory.start', { pid: 999_999 });
    assert.equal(error?.code, -32001, error?.message ?? 'no error');
  });

  test('memory.start on a live non-.NET process is UNSUPPORTED_RUNTIME', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const error = await executeError('memory.start', { pid: process.pid });
    assert.equal(error?.code, -32002, error?.message ?? 'no error');
  });

  test('memory.start without a PID is INVALID_PARAMS; a step without a session id too', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.equal((await executeError('memory.start', {}))?.code, -32602);
    assert.equal((await executeError('memory.snapshot', {}))?.code, -32602);
  });

  test('a direct-mode start completes at once with the runtime and mode named', async function () {
    this.timeout(STEP_MS);
    assert.ok(target);
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    assert.equal(started.runtime, 'dotnet');
    assert.deepEqual(started.mode, { kind: 'Direct' });
    assert.equal(completed(started.step).outcome.kind, 'Ack');
    completed(
      await execute<MemoryStep>('memory.stop', { memory_session_id: started.memory_session_id }),
    );
  });

  test('snapshot sites carry the runtime’s type names and resolve the leak to its source', async function () {
    this.timeout(STEP_MS);
    assert.ok(target);
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    const session = { memory_session_id: started.memory_session_id };
    const snap = completed(await execute<MemoryStep>('memory.snapshot', session));
    assert.equal(snap.outcome.kind, 'Snapshot');
    if (snap.outcome.kind === 'Snapshot') {
      const leak = snap.outcome.snapshot.sites.find((site) => site.type_name === LEAK_TYPE);
      assert.ok(
        leak,
        `the leak type is a site: ${snap.outcome.snapshot.sites.map((s) => s.type_name).join(', ')}`,
      );
      assert.ok(leak.count > 0 && leak.size_bytes > 0, 'it has live objects and bytes');
      assert.ok(leak.file?.endsWith('Program.cs'), `resolved to the fixture source: ${leak.file}`);
      assert.ok(snap.outcome.snapshot.current_bytes > 0, 'the heap has a size');
    }
    const second = completed(await execute<MemoryStep>('memory.snapshot', session));
    assert.ok(
      second.outcome.kind === 'Snapshot' && second.outcome.timeline.length >= 2,
      'the timeline grows by one point per snapshot',
    );
    completed(await execute<MemoryStep>('memory.stop', session));
  });

  test('objectsByType lists the leaked objects largest first; an absent type lists none', async function () {
    this.timeout(STEP_MS * 2);
    assert.ok(target);
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    const session = { memory_session_id: started.memory_session_id };
    completed(await execute<MemoryStep>('memory.snapshot', session));
    const found = completed(
      await execute<MemoryStep>('memory.objectsByType', {
        ...session,
        type_name: LEAK_TYPE,
        limit: 20,
      }),
    );
    assert.equal(found.outcome.kind, 'Objects');
    if (found.outcome.kind === 'Objects') {
      const { objects } = found.outcome;
      assert.equal(objects.type_name, LEAK_TYPE);
      assert.ok(objects.total_count > 0, `live objects: ${objects.total_count}`);
      assert.ok(
        objects.objects.length > 0 && objects.objects.length <= 20,
        'the limit is honoured',
      );
      const sizes = objects.objects.map((o) => o.size_bytes);
      assert.deepEqual(
        sizes,
        [...sizes].sort((a, b) => b - a),
        'largest first',
      );
      assert.ok(
        objects.type_summary.some((t) => t.type_name === LEAK_TYPE),
        'the type is in the summary',
      );
    }
    const absent = completed(
      await execute<MemoryStep>('memory.objectsByType', {
        ...session,
        type_name: 'No.Such.Type',
        limit: 5,
      }),
    );
    assert.ok(
      absent.outcome.kind === 'Objects' &&
        absent.outcome.objects.total_count === 0 &&
        absent.outcome.objects.objects.length === 0,
      'an absent type lists nothing',
    );
    completed(await execute<MemoryStep>('memory.stop', session));
  });

  test('heap inspection before any snapshot is refused and says to take one', async function () {
    this.timeout(STEP_MS);
    assert.ok(target);
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    const session = { memory_session_id: started.memory_session_id };
    for (const step of ['memory.references', 'memory.objectsByType']) {
      const error = await executeError(step, {
        ...session,
        type_name: LEAK_TYPE,
        limit: 5,
        max_depth: 3,
      });
      assert.equal(error?.code, -32000, `${step}: ${error?.message ?? 'no error'}`);
      assert.ok(
        error.message.includes('take a snapshot'),
        `${step} explains itself: ${error.message}`,
      );
    }
    completed(await execute<MemoryStep>('memory.stop', session));
  });

  test('a retention walk for a type the heap does not hold is an honest empty graph', async function () {
    this.timeout(STEP_MS);
    assert.ok(target);
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    const session = { memory_session_id: started.memory_session_id };
    completed(await execute<MemoryStep>('memory.snapshot', session));
    const refs = completed(
      await execute<MemoryStep>('memory.references', {
        ...session,
        type_name: 'No.Such.Type',
        limit: 10,
        max_depth: 3,
      }),
    );
    assert.ok(
      refs.outcome.kind === 'Refs' && !refs.outcome.graph.nodes.some((n) => n.is_target),
      'no target nodes are invented',
    );
    completed(await execute<MemoryStep>('memory.stop', session));
  });

  test('a stopped session is gone: every later step is refused', async function () {
    this.timeout(STEP_MS);
    assert.ok(target);
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    const session = { memory_session_id: started.memory_session_id };
    completed(await execute<MemoryStep>('memory.stop', session));
    for (const step of ['memory.snapshot', 'memory.diff', 'memory.gcCollect', 'memory.stop']) {
      assert.equal((await executeError(step, session))?.code, -32000, `${step} after stop`);
    }
  });

  test('a cancelled snapshot answers REQUEST_CANCELLED and the next request works', async function () {
    this.timeout(STEP_MS * 2);
    assert.ok(target);
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    const session = { memory_session_id: started.memory_session_id };
    const source = new CancellationTokenSource();
    const pending = lspClient().sendRequest(
      'workspace/executeCommand',
      { command: lspCommand('memory.snapshot'), arguments: [session] },
      source.token,
    );
    setTimeout(() => {
      source.cancel();
    }, 50);
    const code = await pending.then(
      () => undefined,
      (error: unknown) => (error as { code?: unknown }).code,
    );
    assert.equal(code, -32800, 'the cancelled request is answered as cancelled');
    const after = completed(await execute<MemoryStep>('memory.snapshot', session));
    assert.equal(after.outcome.kind, 'Snapshot', 'the session still works after a cancel');
    completed(await execute<MemoryStep>('memory.stop', session));
  });
});

suite('Memory sessions — the UI flow on a live target', () => {
  let tmpDir = '';
  let target: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-mem-ui-'));
    target = await Target.start('ProfileLeakTarget');
  });
  suiteTeardown(async () => {
    if (profilerStore().profiler.value.memory !== 'idle') {
      await vscode.commands.executeCommand(uiCommand('memoryStop'));
    }
    target?.stop();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  test('without a session, snapshot and references change nothing', async function () {
    this.timeout(COMMAND_MS);
    const dashboard = memoryDashboardState();
    const graph = refGraphState();
    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    await vscode.commands.executeCommand(uiCommand('memoryReferences'));
    assert.equal(profilerStore().profiler.value.memory, 'idle');
    assert.deepEqual(memoryDashboardState(), dashboard);
    assert.deepEqual(refGraphState(), graph);
  });

  test('start: tracking state, status bar, panel chrome and context key follow the session', async function () {
    this.timeout(STEP_MS);
    assert.ok(target);
    const store = profilerStore();
    await openSource(fixtureSource('ProfileLeakTarget'));
    await vscode.commands.executeCommand(uiCommand('memoryStart'), target.pid);
    await waitFor(
      () => store.profiler.value.memory,
      (m) => m === 'active',
      PROCESS_START_MS,
      'tracking',
    );
    assert.ok(memoryStatusText()?.includes('tracking'), `status: ${memoryStatusText()}`);
    assert.equal(contextKeyValues().get('sharplsp.profiler.memoryTracking'), true);
    assert.deepEqual(processesViewState(), {
      message: '🗄️ Tracking memory allocations…',
      badge: 1,
    });
  });

  test('a second start while tracking is refused and keeps the running session', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    const store = profilerStore();
    const running = store.profiler.value.memorySessionId;
    await vscode.commands.executeCommand(uiCommand('memoryStart'), target.pid);
    assert.equal(store.profiler.value.memorySessionId, running);
  });

  test('snapshot opens the SharpLsp dashboard carrying the runtime’s own type names', async function () {
    this.timeout(STEP_MS);
    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    const dashboard = await waitFor(
      () => memoryDashboardState(),
      (d) => d !== undefined,
      STEP_MS,
      'dashboard',
    );
    assert.ok(dashboard);
    assert.equal(dashboard.title, 'SharpLsp Memory Dashboard');
    assert.ok(
      dashboard.html.includes('<span class="accent">SHARPLSP</span> MEMORY'),
      'brand heading',
    );
    assert.ok(!/basilisk/i.test(dashboard.html), 'no other product named');
    assert.ok(dashboard.html.includes(LEAK_TYPE), 'the dashboard shows the leaking type by name');
    const snap = lastMemorySnapshot();
    assert.ok(
      snap?.topAllocations.some((site) => site.typeName === LEAK_TYPE),
      'the snapshot kept type names',
    );
    assert.ok(
      appliedMemoryDecorations().some((d) => d.file.endsWith('Program.cs')),
      'the memory track paints the fixture source',
    );
  });

  test('a second snapshot extends the dashboard timeline', async function () {
    this.timeout(STEP_MS);
    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    const snap = await waitFor(
      () => lastMemorySnapshot(),
      (s) => (s?.timeline.length ?? 0) >= 2,
      STEP_MS,
      'two timeline points',
    );
    const [firstPoint, secondPoint] = snap?.timeline ?? [];
    assert.ok(firstPoint && secondPoint, 'two points');
    assert.ok(secondPoint.timestamp >= firstPoint.timestamp, 'points are in time order');
  });

  test('diff scores the growing type as a suspected leak in the dashboard', async function () {
    this.timeout(STEP_MS);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await vscode.commands.executeCommand(uiCommand('memoryDiff'));
    const leaks = await waitFor(
      () => embeddedLeaks(memoryDashboardState()?.html ?? ''),
      (found) => found.length > 0,
      STEP_MS,
      'suspected leaks in the dashboard',
    );
    assert.ok(
      leaks.some((leak) => leak.typeName === LEAK_TYPE),
      `the growing type is a suspected leak, named by type: ${JSON.stringify(leaks)}`,
    );
  });

  test('Show Reference Graph offers the snapshot’s own types and walks the one picked', async function () {
    this.timeout(STEP_MS);
    const expected = lastMemorySnapshot()?.topAllocations.find(
      (site) => site.typeName !== undefined,
    )?.typeName;
    assert.ok(expected, 'the snapshot reported at least one type');
    const walk = vscode.commands.executeCommand(uiCommand('memoryReferences'));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await walk;
    const graph = await waitFor(
      () => refGraphState(),
      (g) => g !== undefined,
      STEP_MS,
      'retention graph',
    );
    assert.equal(
      graph?.title,
      `Retention Graph — ${expected}`,
      'the first offered type is the runtime’s largest',
    );
  });

  test('an induced GC keeps the session tracking', async function () {
    this.timeout(STEP_MS);
    await vscode.commands.executeCommand(uiCommand('memoryGcCollect'));
    assert.equal(profilerStore().profiler.value.memory, 'active');
  });

  test('stop returns to idle and clears the status bar, chrome, key and memory track', async function () {
    this.timeout(STEP_MS);
    const store = profilerStore();
    await vscode.commands.executeCommand(uiCommand('memoryStop'));
    await waitFor(
      () => store.profiler.value.memory,
      (m) => m === 'idle',
      PROCESS_START_MS,
      'idle',
    );
    assert.equal(memoryStatusText(), undefined);
    assert.equal(contextKeyValues().get('sharplsp.profiler.memoryTracking'), false);
    assert.deepEqual(processesViewState(), { message: undefined, badge: undefined });
    assert.deepEqual(appliedMemoryDecorations(), [], 'the memory track is cleared');
    assert.equal(lastMemorySnapshot(), undefined, 'per-session presentation state is dropped');
  });
});
