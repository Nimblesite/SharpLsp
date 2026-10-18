// Tests for [PROFILER-SHARED-LIBRARY-VSCODE], [PROF-MEMORY-COMPARE],
// [PROF-DOTNET-SOURCE] and [PROF-DOTNET-HEAP-GRAPH] over the real F# LSP.
import * as assert from 'node:assert/strict';
import type { MemoryStep } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import { completed, execute, executeError, profilingSuite } from './profiler-kit';
import { command, count, endProfiling, isFile, LEDGER, STOP_MS } from './profiler-fsharp-kit';
import { CODE } from './profiler-fsharp-soak-kit';
suite('LSP-level F# memory protocol — FsOrderLedger', () => {
  const live = profilingSuite('profiler-lsp-memory-', LEDGER, { stopping: endProfiling });

  test('memory over the wire on F#: the baseline anchors every shape, objects respect the limit, refs reach the module root, a growth is Low, GC is observed, and a stopped session refuses every step', async function () {
    this.timeout(STOP_MS * 5);
    const { target } = live;
    await command(target, 'release all');
    const seeded = await command(target, 'place 250');
    assert.equal(count(seeded, 'orders'), 250, 'a known live heap');

    // ── [PROF-MEMORY-START] + [PROF-MEMORY-STEP] the baseline completes in Direct mode.
    const started = await execute<{ memory_session_id: string; mode: { kind: string } }>(
      'memory.start',
      { pid: target.pid, traceback_depth: 4 },
    );
    assert.ok(started.memory_session_id.length > 0, 'a memory session id');
    assert.equal(started.mode.kind, 'Direct', '[PROF-MEMORY-MODE] .NET reads its own heap');
    const session = { memory_session_id: started.memory_session_id };
    const baseline = completed(await execute<MemoryStep>('memory.snapshot', session));
    assert.equal(baseline.outcome.kind, 'Snapshot', '[PROF-MEMORY-OUTCOME] snapshot');
    assert.ok(baseline.outcome.kind === 'Snapshot', 'narrowed');
    const snapshot = baseline.outcome.snapshot;
    assert.ok(snapshot.current_bytes > 0, 'live bytes are measured');
    assert.ok(snapshot.object_count > 0, 'live objects are counted');
    assert.equal(snapshot.gc_generations.length, 0, '[PROF-UI-MEMORY] counts are not bytes');
    for (const [type, line, live] of [
      ['FsOrderLedger.Order', 43, 250],
      ['FsOrderLedger.OrderLine', 41, 250],
      ['FsOrderLedger.CustomerId', 33, 250],
      ['FsOrderLedger.OrderStatus+Paid', 37, count(seeded, 'paid')],
      ['FsOrderLedger.OrderStatus+Shipped', 38, count(seeded, 'shipped')],
      ['FsOrderLedger.OrderStatus+Cancelled', 39, count(seeded, 'cancelled')],
    ] as const) {
      const site = snapshot.sites.find((entry) => entry.type_name === type);
      assert.ok(site, `${type} is a site: ${snapshot.sites.map((s) => s.type_name).join(', ')}`);
      assert.ok(isFile(site.file, 'Ledger.fs'), `${type} anchors in Ledger.fs: ${site.file}`);
      assert.equal(site.line, line, `${type} anchors where it is built`);
      assert.equal(site.count, live, `${type}: every live instance`);
      assert.ok(site.size_bytes > 0, `${type} has bytes`);
      assert.ok((site.traceback ?? []).length <= 4, 'traceback_depth caps the stack');
    }

    // ── [PROF-DOTNET-MEMORY] objectsByType honours its limit and ranks the heap.
    const objects = completed(
      await execute<MemoryStep>('memory.objectsByType', {
        ...session,
        type_name: 'FsOrderLedger.Order',
        limit: 3,
      }),
    );
    assert.equal(objects.outcome.kind, 'Objects', 'objectsByType');
    assert.ok(objects.outcome.kind === 'Objects', 'narrowed');
    assert.equal(objects.outcome.objects.total_count, 250, 'the snapshot count is echoed');
    assert.equal(objects.outcome.objects.objects.length, 3, 'the limit is honoured');
    assert.ok(
      objects.outcome.objects.objects.every(
        (entry) => entry.type_name === 'FsOrderLedger.Order' && entry.size_bytes > 0,
      ),
      'every sample is the requested type',
    );
    const summary = objects.outcome.objects.type_summary.map((stat) => stat.size_bytes);
    assert.deepEqual(
      summary,
      [...summary].sort((a, b) => b - a),
      'largest types first',
    );

    // ── [PROF-DOTNET-HEAP-GRAPH] the retention path ends at the module value `orders`.
    const refs = completed(
      await execute<MemoryStep>('memory.references', {
        ...session,
        type_name: 'FsOrderLedger.Order',
        limit: 30,
        max_depth: 6,
      }),
    );
    assert.equal(refs.outcome.kind, 'Refs', 'references');
    assert.ok(refs.outcome.kind === 'Refs', 'narrowed');
    assert.ok(
      refs.outcome.graph.nodes.some(
        (node) => node.is_target && node.type_name === 'FsOrderLedger.Order',
      ),
      'the requested type is the target',
    );
    assert.ok(
      refs.outcome.graph.nodes.some(
        (node) => node.is_root && node.root_kind === 'Static' && node.label === 'static orders',
      ),
      `the module value roots the leak: ${JSON.stringify(refs.outcome.graph.nodes.filter((n) => n.is_root))}`,
    );
    assert.ok(refs.outcome.graph.edges.length > 0, 'the graph holds edges');
    assert.ok(refs.outcome.graph.nodes.length <= 30, 'the node budget is honoured');

    // ── [PROF-MEMORY-CONFIDENCE] one growth is Low, and [PROF-DOTNET-GC] a collection is observed.
    await command(target, 'place 100');
    const diff = completed(await execute<MemoryStep>('memory.diff', session));
    assert.equal(diff.outcome.kind, 'Diff', 'a diff answers with a diff');
    assert.ok(diff.outcome.kind === 'Diff', 'narrowed');
    assert.equal(
      diff.outcome.diff.net_growth,
      diff.outcome.diff.total_growth - diff.outcome.diff.total_freed,
      'net = grown - freed',
    );
    const leak = diff.outcome.leaks.find((entry) => entry.type_name === 'FsOrderLedger.Order');
    assert.ok(leak, `the order growth is a suspected leak: ${JSON.stringify(diff.outcome.leaks)}`);
    assert.equal(leak.confidence.kind, 'Low', '[PROF-MEMORY-CONFIDENCE] one growth is Low');
    assert.equal(leak.count_growth, 100, '[PROF-MEMORY-COMPARE] exactly the new F# Orders grew');
    assert.equal(leak.current_count, 350, 'every retained Order is counted after the growth');
    assert.ok(leak.size_growth > 0, 'the new F# records grew in bytes');
    const gc = completed(await execute<MemoryStep>('memory.gcCollect', session));
    assert.equal(gc.outcome.kind, 'Gc', 'gcCollect');
    assert.ok(gc.outcome.kind === 'Gc', 'narrowed');
    assert.equal(gc.outcome.gc.collected, 1, '[PROF-DOTNET-GC] a collection is observed');

    // ── [PROF-ERRORS] stop, then every step on the stopped session is OTHER.
    const stopped = completed(await execute<MemoryStep>('memory.stop', session));
    assert.equal(stopped.outcome.kind, 'Ack', 'stop acknowledges');
    for (const name of [
      'memory.snapshot',
      'memory.diff',
      'memory.references',
      'memory.objectsByType',
      'memory.gcCollect',
      'memory.stop',
    ]) {
      const refused = await executeError(name, { ...session, type_name: 'FsOrderLedger.Order' });
      assert.ok(refused, `${name} on a stopped session fails`);
      assert.equal(refused.code, CODE.OTHER, `[PROF-ERRORS] ${name} is OTHER: ${refused.message}`);
    }
    await command(target, 'release all');
  });
});
