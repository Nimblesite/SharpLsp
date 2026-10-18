// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on real F# processes.
// SharpLsp contract: docs/specs/PROFILER-SPEC.md.
// Shared contract: lspkit/docs/specs/LSP-PROFILER-SPEC.md.
// Each journey cites the specific protocol, CPU, memory and UI requirements it enforces.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  appliedMemoryDecorations,
  lastMemorySnapshot,
  memoryDashboardState,
  memoryStatusText,
} from '@nimblesite/lsp-profiler-ui';
import type {
  GcResult,
  HeapDiff,
  MemoryStartResult as StartResult,
  MemoryOutcome,
  MemoryStep,
  ObjectList,
  RefGraph,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  execute,
  executeError,
  profilerStore,
  profilingSuite,
  stopTracking,
  trackMemory,
} from './profiler-kit';
import {
  assertEveryShape,
  assertPaletteDiscipline,
  assertSitesCoherent,
  assertStoreCoherent,
  assertTimelineCoherent,
  step,
  snapshotOutcome,
  diffOutcome,
  uiSnapshot,
  CODE,
} from './profiler-fsharp-soak-kit';
import {
  assertAnchored,
  command,
  count,
  endProfiling,
  isFile,
  keys,
  LEDGER,
  SHAPES,
  showSources,
  STOP_MS,
} from './profiler-fsharp-kit';

suite('F# profiler corner cases — FsOrderLedger, wire first', () => {
  const live = profilingSuite('profiler-fs-corner-', LEDGER, { stopping: endProfiling });

  test('sessions: memory and CPU coexist on one PID, the second CPU session is ALREADY_PROFILING, and every refused start leaves no session behind', async function () {
    this.timeout(STOP_MS * 6);
    const { target } = live;
    await showSources(LEDGER, ['Ledger.fs', 'Bus.fs']);

    // ── [PROF-MEMORY-SESSION] CPU and memory sessions are independent: both on one PID.
    const memory = await execute<StartResult>('memory.start', { pid: target.pid });
    assert.ok(memory.memory_session_id.length > 0, 'a memory session id');
    assert.equal(memory.mode.kind, 'Direct', '[PROF-MEMORY-MODE] .NET reads its own heap');
    const cpu = await execute<{ session_id: string }>('cpu.start', { pid: target.pid });
    assert.ok(cpu.session_id.length > 0, 'a CPU session id on the same PID');
    assert.notEqual(cpu.session_id, memory.memory_session_id, 'the two ids never collide');
    assert.equal(
      (await execute<{ sessions: { pid: number }[] }>('cpu.list', {})).sessions.length,
      1,
      'the CPU session is listed while memory also runs',
    );

    // A memory step still works with a CPU session live on the same program.
    const after = await command(target, 'place 200');
    assert.equal(count(after, 'handlers'), 200, 'the ledger grew under both sessions');
    const snap = await snapshotOutcome(memory.memory_session_id);
    assert.ok(snap.snapshot.current_bytes > 0, 'the live heap is measured');
    assert.ok(
      snap.snapshot.sites.some((site) => isFile(site.file, 'Ledger.fs')),
      '[PROF-DOTNET-SOURCE] a site anchors in Ledger.fs',
    );

    // ── [PROF-CPU-START] a second CPU session on the same PID is ALREADY_PROFILING.
    const second = await executeError('cpu.start', { pid: target.pid });
    assert.ok(second, 'the second CPU start fails');
    assert.equal(
      second.code,
      CODE.ALREADY_PROFILING,
      `ALREADY_PROFILING: ${JSON.stringify(second)}`,
    );

    // ── [PROF-ERRORS] a missing PID is PROCESS_NOT_FOUND, and no session appears.
    for (const name of ['cpu.start', 'memory.start']) {
      const missing = await executeError(name, { pid: 2_147_483_647 });
      assert.ok(missing, `${name} on a missing PID fails`);
      assert.equal(
        missing.code,
        CODE.PROCESS_NOT_FOUND,
        `[PROF-ERRORS] ${name}: ${JSON.stringify(missing)}`,
      );
    }
    assert.equal(
      (await execute<{ sessions: unknown[] }>('cpu.list', {})).sessions.length,
      1,
      'still exactly the one session — a refused start never stacks one',
    );

    // ── [PROF-CPU-START] a named runtime that does not recognise the PID is UNSUPPORTED_RUNTIME.
    const wrongRuntime = await executeError('cpu.start', { pid: target.pid, runtime: 'python' });
    assert.ok(wrongRuntime, 'naming the wrong runtime fails');
    assert.equal(
      wrongRuntime.code,
      CODE.UNSUPPORTED_RUNTIME,
      `[PROF-ERRORS] named-runtime refusal: ${JSON.stringify(wrongRuntime)}`,
    );

    // ── [PROF-MEMORY-START] the real start after the refusals proves nothing leaked.
    const fresh = await execute<StartResult>('memory.start', { pid: target.pid });
    assert.ok(fresh.memory_session_id.length > 0, 'a fresh memory session still opens');

    // ── Stop everything; a second stop of the same id is OTHER, not a silent success.
    completed(
      await execute<MemoryStep>('memory.stop', { memory_session_id: memory.memory_session_id }),
    );
    const again = await executeError('memory.stop', {
      memory_session_id: memory.memory_session_id,
    });
    assert.ok(again, 'stopping a stopped session fails');
    assert.equal(
      again.code,
      CODE.OTHER,
      `[PROF-ERRORS] unknown session is OTHER: ${JSON.stringify(again)}`,
    );
    completed(
      await execute<MemoryStep>('memory.stop', { memory_session_id: fresh.memory_session_id }),
    );
    await execute<unknown>('cpu.stop', { session_id: cpu.session_id });
    assert.deepEqual(
      (await execute<{ sessions: unknown[] }>('cpu.list', {})).sessions,
      [],
      'no session survives, CPU or memory',
    );
    assert.equal(
      profilerStore().profiler.value.memory,
      'idle',
      '[PROF-UI-STATE] wire-only start leaves the UI idle',
    );
  });

  test('memory steps: traceback-capped F# sites, exact objectsByType counts, retention roots, growth and release, and Direct mode refuses courier ingest', async function () {
    this.timeout(STOP_MS * 6);
    const { target } = live;
    await command(target, 'release all');
    const seeded = await command(target, 'place 300');
    assert.equal(count(seeded, 'orders'), 300, '300 live orders');

    // ── [PROF-MEMORY-START] an explicit traceback_depth caps every site's stack.
    const start = await execute<StartResult>('memory.start', {
      pid: target.pid,
      traceback_depth: 5,
    });
    const id = start.memory_session_id;
    const first = await snapshotOutcome(id);
    assert.ok(first.snapshot.sites.length > 0, 'the baseline carries sites');
    for (const site of first.snapshot.sites) {
      assert.ok(
        site.traceback.length <= 5,
        `traceback_depth=5 caps ${site.traceback.length} frames`,
      );
      for (const frame of site.traceback) {
        assert.ok(frame.line >= 1, '[PROF-WIRE] traceback lines are 1-based');
        assert.ok(frame.file.length > 0, 'a traceback frame names a file');
      }
      if (site.line !== undefined) assert.ok(site.line >= 1, '[PROF-WIRE] site lines are 1-based');
      assert.ok(site.size_bytes > 0 && site.count > 0, 'a site has bytes and objects');
    }
    assert.ok(
      first.timeline.length === 1,
      '[PROF-MEMORY-TIMELINE] the first snapshot is the first point',
    );
    assert.equal(first.trending_upward, false, 'one point cannot trend upward');
    assert.ok(first.heapprofile_path, '[PROF-MEMORY-HEAPPROFILE] every snapshot exports');
    assert.ok(fs.existsSync(first.heapprofile_path), 'the exported heap profile exists');

    // ── [PROF-MEMORY-STEP] objectsByType names the type and summarises the heap.
    const objects = (await step('memory.objectsByType', {
      memory_session_id: id,
      type_name: SHAPES.order.type,
    })) as Extract<MemoryOutcome, { kind: 'Objects' }>;
    assert.equal(objects.kind, 'Objects', 'objectsByType yields an Objects outcome');
    const listed: ObjectList = objects.objects;
    assert.equal(listed.type_name, SHAPES.order.type, 'the requested type is echoed');
    assert.equal(
      listed.total_count,
      count(seeded, 'orders'),
      'every live F# Order, counted exactly',
    );
    assert.ok(listed.total_bytes > 0, 'the type has live bytes');
    assert.ok(
      listed.objects.length > 0 && listed.objects.length <= listed.total_count,
      'a capped slice of the largest objects',
    );
    for (const object of listed.objects) {
      assert.equal(object.type_name, SHAPES.order.type, 'every sample is the requested type');
      assert.ok(object.size_bytes > 0, 'a sample has a shallow size');
      assert.ok(object.label.length > 0, 'a sample has a label');
    }
    assert.ok(listed.type_summary.length > 0, 'a per-type summary is offered');
    const sizes = listed.type_summary.map((stat) => stat.size_bytes);
    assert.deepEqual(
      sizes,
      [...sizes].sort((a, b) => b - a),
      '[PROF-INVARIANTS] types ranked by live bytes, not instance count',
    );

    for (const shape of Object.values(SHAPES)) {
      const listedType = (await step('memory.objectsByType', {
        memory_session_id: id,
        type_name: shape.type,
      })) as Extract<MemoryOutcome, { kind: 'Objects' }>;
      assert.equal(listedType.kind, 'Objects', `objectsByType(${shape.type}) yields Objects`);
      assert.equal(
        listedType.objects.type_name,
        shape.type,
        `[PROF-MEMORY-STEP] echoes ${shape.type}`,
      );
      assert.ok(
        listedType.objects.objects.every((object) => object.type_name === shape.type),
        `only ${shape.type} samples`,
      );
      assert.ok(listedType.objects.total_bytes >= 0, `${shape.type} bytes are never negative`);
      assert.equal(
        listedType.objects.total_count,
        count(seeded, shape.live),
        `[PROF-DOTNET-HEAP-MARK] exactly the retained ${shape.type} instances`,
      );
      assert.ok(
        listedType.objects.objects.length <= listedType.objects.total_count,
        `${shape.type} samples are a subset`,
      );
      assert.ok(
        listedType.objects.type_summary.length > 0,
        `${shape.type} still summarises the heap`,
      );
      const summary = listedType.objects.type_summary.map((stat) => stat.size_bytes);
      assert.deepEqual(
        summary,
        [...summary].sort((a, b) => b - a),
        'the summary is ranked',
      );
      assert.ok(
        listedType.objects.type_summary.every((stat) => stat.count >= 0 && stat.size_bytes >= 0),
        'summary numbers are non-negative',
      );
      assert.ok(
        listedType.objects.type_summary.every((stat) => stat.type_name.length > 0),
        'every summary row names a runtime type',
      );
    }

    // ── [PROF-DOTNET-HEAP-GRAPH] references: a graph with locations, edges and cycles.
    const graph = (await step('memory.references', {
      memory_session_id: id,
      type_name: SHAPES.order.type,
      limit: 20,
    })) as Extract<MemoryOutcome, { kind: 'Refs' }>;
    assert.equal(graph.kind, 'Refs', 'references yields a Refs outcome');
    const refs: RefGraph = graph.graph;
    assert.ok(refs.nodes.length > 0, 'the retention graph has nodes');
    assert.ok(refs.nodes.length <= 20, 'the node budget is honoured');
    assert.ok(refs.edges.length > 0, 'the retention graph has edges');
    assert.ok(Array.isArray(refs.cycles), 'cycles are reported as paths');
    assert.equal(typeof refs.truncated, 'boolean', 'truncation is explicit');
    assert.ok(
      refs.nodes.some((node) => node.is_target),
      'the target objects are marked',
    );
    assert.ok(
      refs.truncated || refs.nodes.some((node) => node.is_root),
      'an untruncated graph reaches a GC root',
    );
    for (const node of refs.nodes) {
      assert.ok(node.depth >= 0, `a node has a depth: ${node.depth}`);
      assert.ok(node.size_bytes >= 0, 'a node reports bytes');
      assert.ok(node.label.length > 0, 'a node has a label');
      assert.ok(node.type_name.length > 0, 'a node names its runtime type');
    }
    for (const edge of refs.edges) {
      const ids = new Set(refs.nodes.map((node) => node.id));
      assert.ok(ids.has(edge.from) && ids.has(edge.to), 'every edge joins two known nodes');
    }

    // ── [PROF-MEMORY-STEP] gcCollect reports what it freed and never ends the session.
    const gc = (await step('memory.gcCollect', { memory_session_id: id })) as Extract<
      MemoryOutcome,
      { kind: 'Gc' }
    >;
    assert.equal(gc.kind, 'Gc', 'gcCollect yields a Gc outcome');
    const collected: GcResult = gc.gc;
    assert.equal(collected.collected, 1, '[PROF-DOTNET-GC] one induced collection was observed');
    assert.ok(collected.freed_bytes >= 0, 'a freed-bytes total');
    assert.equal(collected.uncollectable_count, 0, '.NET reports no uncollectable objects');
    assert.equal(
      collected.uncollectable.length,
      collected.uncollectable_count,
      'the uncollectable details match their count',
    );

    // ── [PROF-MEMORY-MODE] .NET is Direct: it never parses a courier's payload.
    const marker = 'not-a-payload-7fd1';
    const refused = await executeError('memory.ingest', { memory_session_id: id, output: marker });
    assert.ok(refused, 'garbage is refused');
    assert.equal(
      refused.code,
      CODE.OTHER,
      '[PROF-ERRORS] a recognised runtime refuses an unsupported backend operation',
    );
    assert.ok(
      refused.message.includes('captures directly'),
      `[PROF-MEMORY-MODE] the refusal explains Direct capture: ${refused.message}`,
    );

    // ── Ingesting into an unknown session is an error, never a new session.
    const unknown = await executeError('memory.ingest', {
      memory_session_id: 'no-such-memory-session',
      output: '{}',
    });
    assert.ok(unknown, 'an unknown session fails');
    assert.equal(unknown.code, CODE.OTHER, 'ingest never invents an unknown session');
    assert.equal((await snapshotOutcome(id)).kind, 'Snapshot', 'the real session still answers');

    // ── [PROF-MEMORY-COMPARE] growth after the baseline, then release, then freed > 0.
    const more = await command(target, 'place 300');
    const diff = await diffOutcome(id);
    assert.ok(diff.diff.total_growth > 0, 'the growth is measured');
    assert.equal(diff.diff.net_growth, diff.diff.total_growth - diff.diff.total_freed);
    const orderSite = diff.diff.grown.find((site) => site.type_name === SHAPES.order.type);
    assert.ok(
      orderSite,
      `[PROF-MEMORY-COMPARE] the order site grew: ${JSON.stringify(diff.diff.grown.map((s) => s.type_name))}`,
    );
    assert.equal(orderSite.count_diff, count(more, 'orders') - count(seeded, 'orders'));
    assert.ok(orderSite.size_diff > 0, 'the additional F# records grew in bytes');
    assert.ok(isFile(orderSite.file, SHAPES.order.file), 'Order growth resolves to Ledger.fs');
    assert.equal(orderSite.line, SHAPES.order.line, 'Order growth anchors where constructed');
    const grown = await snapshotOutcome(id);
    assert.ok(grown.snapshot.current_bytes >= first.snapshot.current_bytes, 'the heap grew');
    assert.equal(
      grown.snapshot.sites.find((site) => site.type_name === SHAPES.order.type)?.count,
      count(more, 'orders'),
      'the post-diff snapshot retains the exact new F# count',
    );
    for (let index = 1; index < grown.timeline.length; index += 1) {
      const before = grown.timeline[index - 1];
      const now = grown.timeline[index];
      assert.ok(before && now && now.elapsed_secs >= before.elapsed_secs, 'time runs forward');
      assert.ok(before && now && now.peak_bytes >= before.peak_bytes, 'peak never falls');
    }

    await command(target, 'release all');
    const freed: HeapDiff = (await diffOutcome(id)).diff;
    const shrunk = await snapshotOutcome(id);
    assert.ok(shrunk.snapshot.current_bytes < grown.snapshot.current_bytes, 'the heap shrank');
    assert.ok(
      freed.grown.every((site) => site.size_diff > 0),
      'only growing sites are listed as grown',
    );
    assert.ok(
      freed.freed.every((site) => site.size_diff < 0),
      'only shrinking sites are listed as freed',
    );
    assert.equal(
      freed.freed.find((site) => site.type_name === SHAPES.order.type)?.count_diff,
      -count(more, 'orders'),
      'every unrooted F# Order is freed',
    );
    assert.ok(freed.total_freed > 0, 'the released F# records contribute freed bytes');
    completed(await execute<MemoryStep>('memory.stop', { memory_session_id: id }));
  });
});

suite('F# profiler corner cases — FsOrderLedger through the dashboard', () => {
  const live = profilingSuite('profiler-fs-corner-ui-', LEDGER, { stopping: endProfiling });

  test('the dashboard corner cases: a real .heapprofile, generation bytes kept apart from collection counts, a flat second snapshot, and every key back to false after Track → Snapshot → Stop', async function () {
    this.timeout(STOP_MS * 6);
    const { target } = live;
    await showSources(LEDGER, ['Ledger.fs', 'Quotes.fs']);
    const seeded = await command(target, 'quote 250');
    await trackMemory(target.pid);
    assert.equal(
      profilerStore().profiler.value.memory,
      'active',
      '[PROF-UI-STATE] the store says tracking',
    );

    // ── [PROF-MEMORY-HEAPPROFILE] the .heapprofile is real V8 JSON.
    const first = await uiSnapshot();
    assert.ok(
      fs.existsSync(first.heapProfilePath),
      `[PROF-MEMORY-HEAPPROFILE] ${first.heapProfilePath}`,
    );
    const profile = JSON.parse(fs.readFileSync(first.heapProfilePath, 'utf8')) as {
      head?: unknown;
      samples?: unknown;
    };
    assert.ok(profile.head !== undefined, 'the profile has a call-tree root');
    assert.ok(Array.isArray(profile.samples), 'the profile has samples');
    assert.ok((profile.samples as unknown[]).length > 0, 'the live F# heap exports samples');

    // ── [PROF-UI-MEMORY] generation bytes are not collection counts.
    assert.deepEqual(first.gcCounts, [], 'counts are never presented as generation bytes');
    assert.ok(first.generationSizes, 'the .NET runtime reports generation bytes');
    assert.deepEqual(
      first.generationSizes.map((region) => region.name),
      ['Gen 0', 'Gen 1', 'Gen 2', 'LOH', 'POH'],
      'all five .NET heap regions are named',
    );
    for (const region of first.generationSizes) {
      assert.ok(region.name.length > 0, 'a region has a runtime label');
      assert.ok(region.size >= 0, 'a region size is a byte count');
    }
    assert.equal(memoryDashboardState()?.title, 'SharpLsp Memory Dashboard');
    assertAnchored(first, SHAPES.quote, 250);
    assertSitesCoherent(first);
    assertTimelineCoherent(first);
    assertPaletteDiscipline();
    assertStoreCoherent();
    assertEveryShape(first, seeded);
    for (const site of first.topAllocations) {
      assert.ok((site.typeName ?? '').length > 0, 'every top site names its runtime type');
      assert.ok(
        !isFile(site.file, 'Domain.fs'),
        '[PROF-DOTNET-SOURCE] built where it is allocated',
      );
    }

    // ── [PROF-MEMORY-TIMELINE] a second snapshot with no growth still adds one point and
    // never runs backwards; nothing is invented in between.
    const second = await uiSnapshot(first);
    assert.equal(second.timeline.length, 2, 'two snapshots, two points');
    const [p1, p2] = second.timeline;
    assert.ok(p1 && p2, 'both points exist');
    assert.ok(p2.timestamp >= p1.timestamp, '[PROF-MEMORY-TIMELINE] time runs forward');
    assert.ok(p2.peakMemory >= p1.peakMemory, 'peak never falls');
    assert.ok(second.peakMemory >= second.currentMemory, 'peak is at least current');
    assert.ok(second.gcObjects > 0, 'live objects are counted');
    assert.equal(
      second.topAllocations.filter((site) => site.typeName === SHAPES.quote.type).length,
      1,
      'one site per type, never a duplicate row',
    );
    assertAnchored(second, SHAPES.quote, count(seeded, 'quotes'));
    assert.equal(
      lastMemorySnapshot()?.snapshotId,
      second.snapshotId,
      'the second snapshot is current',
    );

    // ── [PROF-UI-MEMORY] stopping clears the dashboard's claim and every decoration.
    await stopTracking();
    assert.equal(
      profilerStore().profiler.value.memory,
      'idle',
      '[PROF-UI-STATE] the store says idle',
    );
    assert.equal(memoryStatusText(), undefined, 'the status bar hides');
    assert.deepEqual(appliedMemoryDecorations(), [], 'no memory decoration survives the stop');
    assert.deepEqual(keys(), {
      profiling: false,
      cpuBusy: false,
      memoryTracking: false,
      memoryBusy: false,
      profilerBusy: false,
    });

    // ── [PROF-UI-STATE] the session clears; [PROF-UI-MEMORY] the rendered report stays readable.
    assert.equal(lastMemorySnapshot(), undefined, 'no stale session snapshot survives stop');
    assert.ok(
      memoryDashboardState()?.html.includes(SHAPES.quote.type),
      'the F# report stays readable',
    );
    const stopped = await executeError('memory.snapshot', {
      memory_session_id: second.memorySessionId,
    });
    assert.ok(stopped, 'the stopped session has no live snapshot');
    assert.ok(stopped.code !== 0, 'a stopped session cannot snapshot');
  });
});
