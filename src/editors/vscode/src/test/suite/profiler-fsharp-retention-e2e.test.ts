// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// What keeps each F# leak alive, on FsOrderLedger. Each leak has its own root,
// and each root is an F# module value, which the compiler stores in a mangled
// `name@line` field. The tests check:
//   - the retention graph names every root by its source name, under every
//     depth and node budget, keeping the budget rules of lspkit's
//     [PROF-DOTNET-HEAP-MARK];
//   - objects-by-type counts every live F# instance exactly, largest first,
//     from the snapshot it was asked about ([PROF-DOTNET-MEMORY]);
//   - the UI's retention graph and type picker show the same F# names;
//   - an induced GC frees what the program released;
//   - a cancelled request, a dead target and steps with no snapshot fail
//     honestly ([PROF-HOST-CANCEL], [PROF-ERRORS]).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode-languageclient/node';
import {
  lastMemorySnapshot,
  memoryDashboardState,
  refGraphState,
} from '@nimblesite/lsp-profiler-ui';
import {
  referenceTypeCandidates,
  walkReferences,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-ref-picker';
import type {
  GcResult,
  MemoryStartResult,
  MemoryStep,
  ObjectList,
  RefGraph,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  execute,
  executeError,
  lspClient,
  lspCommand,
  profilerStore,
  profilingSuite,
  retentionGraph,
  snapshotSession,
  stopTracking,
  Target,
  trackMemory,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { captureToasts } from './profiler-ui-helpers';
import { installUiStubs } from './ui-stubs';
import {
  command,
  count,
  type Counts,
  endProfiling,
  handlerSite,
  LEDGER,
  processRow,
  settleLedger,
  SHAPES,
  STOP_MS,
  VERSIONED,
} from './profiler-fsharp-kit';

interface Session {
  readonly memory_session_id: string;
}

/** Each leak's type, the module value that roots it, and the depth its path needs. */
const ROOTS = [
  { type: SHAPES.order.type, root: 'static orders', depth: 6 },
  { type: SHAPES.quote.type, root: 'static quote', depth: 8 },
  { type: SHAPES.audit.type, root: 'static auditor', depth: 10 },
  { type: SHAPES.rejected.type, root: 'static rejected', depth: 6 },
  { type: VERSIONED, root: 'static snapshots', depth: 6 },
] as const;

/** Budgets the graph must respect: a deep, roomy walk and a tight one. */
const BUDGETS = [
  { maxDepth: 10, limit: 80 },
  { maxDepth: 3, limit: 12 },
] as const;

/** [PROF-DOTNET-HEAP-MARK] + [PROF-DOTNET-HEAP-GRAPH]: every rule of a retention graph. */
function assertGraphRules(graph: RefGraph, type: string, maxDepth: number, limit: number): void {
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.equal(ids.size, graph.nodes.length, 'node ids are unique');
  assert.ok(graph.nodes.length <= limit, `${graph.nodes.length} nodes within the budget ${limit}`);
  const targets = graph.nodes.filter((n) => n.is_target);
  assert.ok(targets.length > 0, `${type} has target nodes`);
  assert.ok(
    targets.every((n) => n.type_name === type),
    'targets are the type asked about',
  );
  assert.ok(targets.length <= Math.ceil(limit / 4), 'targets take at most a quarter of the budget');
  assert.ok(
    graph.nodes.every((n) => n.depth >= 0 && n.depth <= maxDepth),
    `depth ≤ ${maxDepth}`,
  );
  assert.ok(
    graph.nodes.every((n) => n.size_bytes >= 0),
    'sizes are bytes',
  );
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to), `edge ${edge.from}→${edge.to} joins nodes`);
  }
  for (const root of graph.nodes.filter((n) => n.is_root)) {
    assert.ok(root.root_kind, `root ${root.label} says what kind of root it is`);
    assert.ok(
      !root.label.includes('@'),
      `no compiler-mangled F# name reaches a root: ${root.label}`,
    );
  }
}

/** The objects of `type` in the session's latest snapshot. */
async function objectsOf(session: Session, type: string, limit: number): Promise<ObjectList> {
  const step = completed(
    await execute<MemoryStep>('memory.objectsByType', { ...session, type_name: type, limit }),
  );
  assert.equal(step.outcome.kind, 'Objects', 'objects answer with objects');
  return (step.outcome as { objects: ObjectList }).objects;
}

/** [PROF-DOTNET-MEMORY] objects: exact totals, the limit, largest first, one type. */
function assertObjects(objects: ObjectList, type: string, live: number, limit: number): void {
  assert.equal(objects.type_name, type);
  assert.equal(objects.total_count, live, `every live ${type} is counted`);
  assert.equal(objects.objects.length, Math.min(limit, live), `limit ${limit} is honoured`);
  const sizes = objects.objects.map((o) => o.size_bytes);
  assert.deepEqual(
    sizes,
    [...sizes].sort((a, b) => b - a),
    'largest first',
  );
  assert.ok(
    objects.objects.every((o) => o.type_name === type),
    'only objects of the type',
  );
  assert.ok(objects.total_bytes >= sizes.reduce((a, b) => a + b, 0), 'the total covers the listed');
  if (live > 0) {
    const own = objects.type_summary.find((entry) => entry.type_name === type);
    assert.ok(own, '[PROF-DOTNET-MEMORY] the summary always includes the requested live type');
    assert.equal(own.count, live, 'the requested summary row counts every live F# instance');
    assert.equal(
      own.size_bytes,
      objects.total_bytes,
      'its summary bytes match the full type total',
    );
  }
  if (live <= limit)
    assert.equal(
      objects.total_bytes,
      sizes.reduce((sum, size) => sum + size, 0),
      'an exhaustive object list accounts for every byte of the requested F# type',
    );
  const ranked = objects.type_summary.map((entry) => entry.size_bytes);
  assert.deepEqual(
    ranked,
    [...ranked].sort((a, b) => b - a),
    'the heap summary ranks by bytes',
  );
}

/** Seed one of every leak, deterministically. */
async function seed(target: Target): Promise<Counts> {
  await command(target, 'audit pause');
  await command(target, 'place 2000');
  await command(target, 'quote 600');
  await command(target, 'reject 300');
  await command(target, 'history');
  return command(target, 'history');
}

suite('F# retention, objects, GC and refusals — FsOrderLedger', () => {
  const live = profilingSuite('profiler-fs-retain-', LEDGER);
  teardown(async function () {
    this.timeout(STOP_MS * 2);
    await endProfiling();
    await settleLedger(live.target);
  });

  test('every F# leak is held by its module value under its source name, under every depth and node budget; the event-handler closure by `static published`, byte arrays by both the ledger and the blob store', async function () {
    this.timeout(STOP_MS * 6);
    const { target } = live;
    await seed(target);
    await command(target, 'blob 2');
    const session = await snapshotSession(target.pid);

    for (const { type, root, depth } of ROOTS) {
      const graph = await retentionGraph(session, type, depth, 80);
      assertGraphRules(graph, type, depth, 80);
      const roots = graph.nodes.filter((n) => n.is_root);
      assert.ok(
        roots.some((n) => n.label === root && n.root_kind === 'Static'),
        `${type} is held by ${root}: ${JSON.stringify(roots.map((r) => [r.label, r.root_kind]))}`,
      );
      assert.ok(graph.edges.length > 0, `${type}: the holders are linked`);
      for (const { maxDepth, limit } of BUDGETS) {
        const bounded = await retentionGraph(session, type, maxDepth, limit);
        assertGraphRules(bounded, type, maxDepth, limit);
      }
      const tight = await retentionGraph(session, type, 2, 8);
      assertGraphRules(tight, type, 2, 8);
      const exhausted = await retentionGraph(session, type, 2, 1);
      assertGraphRules(exhausted, type, 2, 1);
      assert.equal(
        exhausted.truncated,
        true,
        `${type}: one node cannot hold the target and its holder`,
      );
    }

    // The never-removed handler: an F# closure, rooted at the event's module value.
    const ui = await snapshotSession(target.pid);
    completed(await execute<MemoryStep>('memory.stop', ui));
    await trackMemory(target.pid);
    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    const snapshot = await waitFor(
      () => lastMemorySnapshot(),
      (s) => s !== undefined,
      STOP_MS,
      'snapshot',
    );
    const closure = handlerSite(snapshot).typeName ?? '';
    const handlers = await retentionGraph(session, closure, 12, 120);
    assertGraphRules(handlers, closure, 12, 120);
    assert.ok(
      handlers.nodes.some((n) => n.is_root && n.label === 'static published'),
      `the subscribe closures are kept alive by the Bus event: ${JSON.stringify(handlers.nodes.filter((n) => n.is_root).map((n) => n.label))}`,
    );

    // Byte arrays have two owners: each order's payload and the retained blob.
    const bytes = await retentionGraph(session, 'System.Byte[]', 6, 120);
    const byteRoots = bytes.nodes.filter((n) => n.is_root).map((n) => n.label);
    for (const root of ['static orders', 'static blobs']) {
      assert.ok(
        byteRoots.includes(root),
        `byte arrays are held by ${root}: ${byteRoots.join(', ')}`,
      );
    }
    await stopTracking();
    completed(await execute<MemoryStep>('memory.stop', session));
    await command(target, 'release all');
    await command(target, 'audit resume');
  });

  test('objects by type: every F# shape counted exactly at every limit, largest first; the count is the snapshot’s, not the live heap’s, until the next snapshot', async function () {
    this.timeout(STOP_MS * 5);
    const { target } = live;
    const counts = await seed(target);
    const session = await snapshotSession(target.pid);
    const exact: readonly [string, number][] = [
      [SHAPES.order.type, count(counts, 'orders')],
      [SHAPES.customer.type, count(counts, 'orders')],
      [SHAPES.line.type, count(counts, 'orders')],
      [SHAPES.paid.type, count(counts, 'paid')],
      [SHAPES.shipped.type, count(counts, 'shipped')],
      [SHAPES.cancelled.type, count(counts, 'cancelled')],
      [SHAPES.quote.type, count(counts, 'quotes')],
      [SHAPES.audit.type, count(counts, 'audits')],
      [SHAPES.rejected.type, count(counts, 'rejections')],
      [VERSIONED, count(counts, 'snapshots')],
    ];
    for (const [type, liveCount] of exact) {
      for (const limit of [1, 7, 50]) {
        assertObjects(await objectsOf(session, type, limit), type, liveCount, limit);
      }
    }
    // [PROF-DOTNET-MEMORY] every summary row agrees with that type's exhaustive totals.
    const summary = (await objectsOf(session, SHAPES.order.type, 1)).type_summary;
    assert.ok(summary.length > 0, 'the real heap produces a ranked type summary');
    for (const entry of summary) {
      const actual = await objectsOf(session, entry.type_name, 1);
      assert.equal(
        entry.count,
        actual.total_count,
        `${entry.type_name}: summary count matches objects`,
      );
      assert.equal(
        entry.size_bytes,
        actual.total_bytes,
        `${entry.type_name}: summary bytes match objects`,
      );
    }
    for (const absent of [
      'FsOrderLedger.OrderStatus+Pending',
      'FsOrderLedger.Address',
      'No.Such.Type',
    ]) {
      assertObjects(await objectsOf(session, absent, 5), absent, 0, 5);
    }

    // The live heap moves on; the answer stays the snapshot's until the next one.
    const more = await command(target, 'place 400');
    const stale = await objectsOf(session, SHAPES.order.type, 5);
    assert.equal(stale.total_count, count(counts, 'orders'), 'objects read the latest snapshot');
    completed(await execute<MemoryStep>('memory.snapshot', session));
    const fresh = await objectsOf(session, SHAPES.order.type, 5);
    assert.equal(fresh.total_count, count(more, 'orders'), 'a new snapshot sees the new orders');
    assert.equal(fresh.total_count - stale.total_count, 400);

    completed(await execute<MemoryStep>('memory.stop', session));
    await command(target, 'release all');
    await command(target, 'audit resume');
  });

  test('the UI retention graph and picker speak F#: walk Order, then a union case, in one panel; the picker’s first type opens; an induced GC after a release frees bytes and keeps tracking', async function () {
    this.timeout(STOP_MS * 5);
    const { target } = live;
    await seed(target);
    await processRow(target.pid);
    await trackMemory(target.pid);
    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    const snapshot = await waitFor(
      () => lastMemorySnapshot(),
      (s) => s !== undefined,
      STOP_MS,
      'snapshot',
    );
    const store = profilerStore();

    for (const [type, root] of [
      [SHAPES.order.type, 'static orders'],
      [SHAPES.shipped.type, 'static orders'],
    ] as const) {
      await walkReferences(store, type);
      const panel = await waitFor(
        () => refGraphState(),
        (state) => state?.title === `Retention Graph — ${type}`,
        STOP_MS,
        `the retention graph of ${type}`,
      );
      assert.ok(panel);
      assert.ok(panel.html.includes(type), `the graph names ${type}`);
      assert.ok(panel.html.includes(root), `the graph shows the module value ${root}`);
      assert.ok(panel.html.includes('<script nonce="'), 'a nonce-gated script');
      assert.ok(!/basilisk/i.test(panel.html), 'no other product named');
    }

    const offered = referenceTypeCandidates(snapshot);
    assert.ok(offered[0], 'the snapshot supplies a real first type to select');
    const input = installUiStubs().queuePick(0);
    try {
      await vscode.commands.executeCommand(uiCommand('memoryReferences'));
      await waitFor(
        () => refGraphState()?.title,
        (title) => title === `Retention Graph — ${offered[0]}`,
        STOP_MS,
        'the first runtime-ranked type opens through the real retention command',
      );
      assert.equal(input.log.quickPickItems.length, 1, 'one user choice');
      const items = input.log.quickPickItems[0] as vscode.QuickPickItem[];
      assert.deepEqual(
        items.slice(0, offered.length).map((item) => item.label),
        offered,
        '[PROF-UI-REFGRAPH] the actual picker preserves the server’s ranked runtime names',
      );
      assert.equal(items.length, offered.length + 1, 'reported types plus the free-text option');
      assert.equal(
        input.log.inputBoxOptions.length,
        0,
        'a reported type never needs guessed input',
      );
      assert.deepEqual(input.log.errorMessages, [], 'the real retention walk succeeds');
    } finally {
      input.restore();
    }

    // Release, then collect: the bytes come back and the session keeps tracking.
    const wire = await snapshotSession(target.pid);
    await command(target, 'release all');
    await command(target, 'audit resume');
    const gc = completed(await execute<MemoryStep>('memory.gcCollect', wire));
    assert.equal(gc.outcome.kind, 'Gc', 'a collection result');
    const { gc: collected } = gc.outcome as { gc: GcResult };
    assert.equal(collected.collected, 1, 'a collection was observed');
    assert.ok(collected.freed_bytes > 0, `the released ledger is freed: ${collected.freed_bytes}`);
    assert.equal(collected.uncollectable_count, 0, '.NET reports no uncollectable objects');
    assert.deepEqual(collected.uncollectable, []);
    completed(await execute<MemoryStep>('memory.stop', wire));

    const toasts = await captureToasts(() =>
      vscode.commands.executeCommand(uiCommand('memoryGcCollect')),
    );
    assert.equal(store.profiler.value.memory, 'active', 'an induced GC keeps tracking');
    const said = [
      ...toasts.info.map((t) => t.message),
      ...toasts.warning,
      memoryDashboardState()?.html ?? '',
    ];
    assert.ok(
      said.some((text) => /freed/i.test(text)),
      `the GC reports what it freed: ${JSON.stringify(toasts)}`,
    );
    assert.ok(
      !toasts.info.some((t) => /\b1 objects?\b/.test(t.message)),
      '`collected` is never an object count',
    );
    await stopTracking();
  });

  test('honest failures on F#: inspection before a snapshot says to take one; a cancelled snapshot answers -32800 and leaves the program alive; a killed program fails every later step and the UI says so', async function () {
    this.timeout(STOP_MS * 4);
    const { target } = live;
    const started = await execute<MemoryStartResult>('memory.start', { pid: target.pid });
    assert.equal(started.runtime, 'dotnet');
    assert.deepEqual(started.mode, { kind: 'Direct' });
    const session = { memory_session_id: started.memory_session_id };
    for (const step of ['memory.references', 'memory.objectsByType']) {
      const error = await executeError(step, {
        ...session,
        type_name: SHAPES.order.type,
        limit: 5,
        max_depth: 3,
      });
      assert.equal(error?.code, -32000, `${step}: ${error?.message}`);
      assert.ok(
        error.message.includes('take a snapshot'),
        `${step} says what to do: ${error.message}`,
      );
    }

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
      (e: unknown) => (e as { code?: unknown }).code,
    );
    assert.equal(code, -32800, 'the cancelled snapshot is answered as cancelled');
    assert.doesNotThrow(() => process.kill(target.pid, 0), 'the F# program survives the cancel');
    assert.ok((await command(target, 'place 10')).orders !== undefined, 'and still answers');
    assert.equal(
      completed(await execute<MemoryStep>('memory.snapshot', session)).outcome.kind,
      'Snapshot',
    );

    // A second program, tracked from the UI, then killed under it.
    const victim = await Target.start(LEDGER);
    await command(victim, 'place 200');
    await trackMemory(victim.pid);
    const doomed = await snapshotSession(victim.pid);
    const killed = await execute<{ pid: number; killed: boolean }>('kill', { pid: victim.pid });
    assert.deepEqual(killed, { pid: victim.pid, killed: true });
    await waitFor(
      () => {
        try {
          process.kill(victim.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      (gone) => gone,
      STOP_MS,
      'the program to die',
    );
    const before = lastMemorySnapshot();
    const toasts = await captureToasts(() =>
      vscode.commands.executeCommand(uiCommand('memorySnapshot')),
    );
    assert.ok(
      toasts.error.length + toasts.warning.length > 0,
      `the UI says the snapshot failed: ${JSON.stringify(toasts)}`,
    );
    assert.equal(lastMemorySnapshot(), before, 'no snapshot is invented for a dead program');
    assert.equal(
      (await executeError('memory.snapshot', doomed))?.code,
      -32001,
      'PROCESS_NOT_FOUND',
    );
    assert.equal((await executeError('memory.start', { pid: victim.pid }))?.code, -32001);
    assert.equal((await executeError('kill', { pid: victim.pid }))?.code, -32001);
    await stopTracking();
    victim.stop();
    completed(await execute<MemoryStep>('memory.stop', session));
  });
});
