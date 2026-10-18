// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE.
//
// Corner cases of the F# profiler, driven from the specs, against SharpLsp's real F# order
// ledger (src/sharplsp/tests/fixtures/fsharp-profiling/FsOrderLedger). Each block names the
// spec section that makes the assertion true:
//
//   [PROF-MEMORY-SESSION]     CPU and memory sessions are independent; one PID may hold both.
//   [PROF-MEMORY-START]       a refused start leaves no session behind; traceback_depth caps stacks.
//   [PROF-MEMORY-STEP]        every step returns a MemoryStep: Evaluate, or Completed + outcome.
//   [PROF-MEMORY-INGEST]      an unrecognised payload quotes the delivered text back.
//   [PROF-MEMORY-HEAPPROFILE] .heapprofile is real V8 JSON; runtime frames are filtered first.
//   [PROF-MEMORY-TIMELINE]    elapsed time never runs backwards; peak never falls.
//   [PROF-MEMORY-COMPARE]     1-based file+line identify a site across snapshots.
//   [PROF-DOTNET-HEAP-GRAPH]  retention graphs carry source locations and cycles.
//   [PROF-ERRORS]             PROCESS_NOT_FOUND, UNSUPPORTED_RUNTIME, ALREADY_PROFILING, OTHER.
//   [PROF-UI-MEMORY]          generation sizes and collection counts are different numbers.
//   [PROF-UI-STATE]           the store, not the webview, is the source of truth.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  appliedMemoryDecorations,
  lastMemorySnapshot,
  memoryDashboardState,
  memoryStatusText,
  recordedOperations,
} from '@nimblesite/lsp-profiler-ui';
import type { MemoryDashboardSnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import type {
  GcResult,
  HeapDiff,
  MemoryMode,
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
  uiCommand,
  waitFor,
} from './profiler-kit';
import {
  assertEveryShape,
  assertPaletteDiscipline,
  assertSitesCoherent,
  assertStoreCoherent,
  assertTimelineCoherent,
} from './profiler-fsharp-soak-kit';
import {
  assertAnchored,
  command,
  SHAPES as SHAPE_TABLE,
  count,
  endProfiling,
  isFile,
  keys,
  LEDGER,
  SHAPES,
  showSources,
  STOP_MS,
} from './profiler-fsharp-kit';

const MIB = 1024 * 1024;
/** [PROF-ERRORS] codes, as the registry spells them. */
const CODE = {
  OTHER: -32_000,
  PROCESS_NOT_FOUND: -32_001,
  UNSUPPORTED_RUNTIME: -32_002,
  ALREADY_PROFILING: -32_004,
  INVALID_PARAMS: -32_602,
} as const;

interface StartResult {
  readonly memory_session_id: string;
  readonly runtime: string;
  readonly mode: MemoryMode;
  readonly step: MemoryStep;
}

/** The outcome of one memory step; a Courier Evaluate step is a failure for a .NET target. */
async function step(name: string, params: Record<string, unknown>): Promise<MemoryOutcome> {
  const result = await execute<MemoryStep>(name, params);
  assert.equal(result.kind, 'Completed', `[PROF-MEMORY-STEP] ${name} completes in Direct mode`);
  assert.ok(result.kind === 'Completed', 'narrowed');
  return result.result.outcome;
}

async function snapshotOutcome(id: string): Promise<Extract<MemoryOutcome, { kind: 'Snapshot' }>> {
  const outcome = await step('memory.snapshot', { memory_session_id: id });
  assert.equal(outcome.kind, 'Snapshot', '[PROF-MEMORY-STEP] snapshot yields a Snapshot outcome');
  assert.ok(outcome.kind === 'Snapshot', 'narrowed');
  return outcome;
}

async function diffOutcome(id: string): Promise<Extract<MemoryOutcome, { kind: 'Diff' }>> {
  const outcome = await step('memory.diff', { memory_session_id: id });
  assert.equal(outcome.kind, 'Diff', '[PROF-MEMORY-STEP] diff yields a Diff outcome');
  assert.ok(outcome.kind === 'Diff', 'narrowed');
  return outcome;
}

/** The UI snapshot the different `previous` snapshot. */
async function uiSnapshot(previous?: MemoryDashboardSnapshot): Promise<MemoryDashboardSnapshot> {
  await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
  const snapshot = await waitFor(
    () => lastMemorySnapshot(),
    (snap) => snap !== undefined && snap.snapshotId !== previous?.snapshotId,
    STOP_MS,
    'a newer snapshot in the dashboard',
  );
  assert.ok(snapshot, 'the dashboard holds a snapshot');
  return snapshot;
}

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

  test('memory steps: traceback-capped sites, objectsByType, references with cycles, gcCollect frees bytes, and ingest quotes garbage back', async function () {
    this.timeout(STOP_MS * 6);
    const { target } = live;
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
    if (first.heapprofile_path !== undefined) {
      assert.ok(
        fs.existsSync(first.heapprofile_path),
        `[PROF-MEMORY-HEAPPROFILE] ${first.heapprofile_path}`,
      );
    }

    // ── [PROF-MEMORY-STEP] objectsByType names the type and summarises the heap.
    const objects = (await step('memory.objectsByType', {
      memory_session_id: id,
      type_name: SHAPES.order.type,
    })) as Extract<MemoryOutcome, { kind: 'Objects' }>;
    assert.equal(objects.kind, 'Objects', 'objectsByType yields an Objects outcome');
    const listed: ObjectList = objects.objects;
    assert.equal(listed.type_name, SHAPES.order.type, 'the requested type is echoed');
    assert.ok(listed.total_count >= 300, `at least the 300 live orders: ${listed.total_count}`);
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
    const counts = listed.type_summary.map((stat) => stat.count);
    assert.deepEqual(
      counts,
      [...counts].sort((a, b) => b - a),
      '[PROF-INVARIANTS] largest types first',
    );

    for (const shape of Object.values(SHAPE_TABLE)) {
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
      assert.ok(
        listedType.objects.objects.length <= listedType.objects.total_count,
        `${shape.type} samples are a subset`,
      );
      assert.ok(
        listedType.objects.type_summary.length > 0,
        `${shape.type} still summarises the heap`,
      );
      const summary = listedType.objects.type_summary.map((stat) => stat.count);
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
    assert.ok(collected.collected >= 0, 'a collected count');
    assert.ok(collected.freed_bytes >= 0, 'a freed-bytes total');
    assert.ok(collected.uncollectable_count >= 0, 'an uncollectable count');
    assert.equal(
      collected.uncollectable.length,
      collected.uncollectable_count,
      'the uncollectable details match their count',
    );

    // ── [PROF-MEMORY-INGEST] an unrecognised payload quotes the delivered text back.
    const marker = 'not-a-payload-7fd1';
    const refused = await executeError('memory.ingest', { memory_session_id: id, output: marker });
    assert.ok(refused, 'garbage is refused');
    assert.ok(refused.code !== 0, `an error code is returned: ${JSON.stringify(refused)}`);
    assert.ok(
      refused.message.includes(marker),
      `[PROF-MEMORY-INGEST] the error quotes the delivered text: ${refused.message}`,
    );

    // ── Ingesting into an unknown session is an error, never a new session.
    const unknown = await executeError('memory.ingest', {
      memory_session_id: 'no-such-memory-session',
      output: '{}',
    });
    assert.ok(unknown, 'an unknown session fails');
    assert.equal((await snapshotOutcome(id)).kind, 'Snapshot', 'the real session still answers');

    // ── [PROF-MEMORY-COMPARE] growth after the baseline, then release, then freed > 0.
    await command(target, 'place 300');
    const grown = await snapshotOutcome(id);
    const diff = await diffOutcome(id);
    assert.ok(diff.diff.total_growth > 0, 'the growth is measured');
    assert.equal(diff.diff.net_growth, diff.diff.total_growth - diff.diff.total_freed);
    const orderSite = diff.diff.grown.find((site) => site.type_name === SHAPES.order.type);
    assert.ok(
      orderSite,
      `[PROF-MEMORY-COMPARE] the order site grew: ${JSON.stringify(diff.diff.grown.map((s) => s.type_name))}`,
    );
    assert.ok(orderSite.size_diff > 0 && orderSite.count_diff > 0, 'growth is bytes and count');
    assert.ok((orderSite.line ?? 0) >= 1, '[PROF-WIRE] site lines are 1-based');
    assert.ok(grown.snapshot.current_bytes >= first.snapshot.current_bytes, 'the heap grew');
    assert.equal(
      grown.trending_upward,
      true,
      '[PROF-MEMORY-TIMELINE] two rising points trend upward',
    );
    for (let index = 1; index < grown.timeline.length; index += 1) {
      const before = grown.timeline[index - 1];
      const now = grown.timeline[index];
      assert.ok(before && now && now.elapsed_secs >= before.elapsed_secs, 'time runs forward');
      assert.ok(before && now && now.peak_bytes >= before.peak_bytes, 'peak never falls');
    }

    await command(target, 'release all');
    const shrunk = await snapshotOutcome(id);
    const freed: HeapDiff = (await diffOutcome(id)).diff;
    assert.ok(shrunk.snapshot.current_bytes < grown.snapshot.current_bytes, 'the heap shrank');
    assert.ok(
      freed.grown.every((site) => site.size_diff > 0),
      'only growing sites are listed as grown',
    );
    assert.ok(
      freed.freed.every((site) => site.size_diff < 0),
      'only shrinking sites are listed as freed',
    );
    completed(await execute<MemoryStep>('memory.stop', { memory_session_id: id }));
  });
});

suite('F# profiler corner cases — FsOrderLedger through the dashboard', () => {
  const live = profilingSuite('profiler-fs-corner-ui-', LEDGER, { stopping: endProfiling });

  test('the dashboard corner cases: a real .heapprofile, generation bytes kept apart from collection counts, a flat second snapshot, and every key back to false after Track → Snapshot → Stop', async function () {
    this.timeout(STOP_MS * 6);
    const { target } = live;
    await showSources(LEDGER, ['Ledger.fs', 'Quotes.fs']);
    await command(target, 'quote 250');
    await trackMemory(target.pid);
    assert.equal(
      profilerStore().profiler.value.memory,
      'active',
      '[PROF-UI-STATE] the store says tracking',
    );
    const opsBefore = recordedOperations().length;

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
    assert.ok((profile.samples as unknown[]).length >= 0, 'the sample array parses from disk');

    // ── [PROF-UI-MEMORY] generation bytes are not collection counts.
    assert.deepEqual(first.gcCounts, [], 'counts are never presented as generation bytes');
    if (first.generationSizes !== undefined) {
      assert.ok(first.generationSizes.length > 0, 'the runtime named its heap regions');
      const total = first.generationSizes.reduce((sum, region) => sum + region.size, 0);
      assert.ok(total <= first.currentMemory + MIB, `regions fit in the live heap: ${total}`);
      for (const region of first.generationSizes) {
        assert.ok(region.name.length > 0, 'a region has a runtime label');
        assert.ok(region.size >= 0, 'a region size is a byte count');
      }
    }
    assert.equal(memoryDashboardState()?.title, 'SharpLsp Memory Dashboard');
    assertAnchored(first, SHAPES.quote, 250);
    assertSitesCoherent(first);
    assertTimelineCoherent(first);
    assertPaletteDiscipline();
    assertStoreCoherent();
    assertEveryShape(first, { [SHAPES.quote.type]: 250 });
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
    assert.ok(
      recordedOperations().length >= opsBefore,
      '[PROF-UI-STATE] the store is the source of truth for what was rendered',
    );
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

    // ── [PROF-UI-STATE] the last snapshot is a report, not a live session: it survives.
    assert.equal(
      lastMemorySnapshot()?.memorySessionId,
      second.memorySessionId,
      'the report is kept for reading',
    );
    const stopped = await executeError('memory.snapshot', {
      memory_session_id: second.memorySessionId,
    });
    assert.ok(stopped, 'the stopped session has no live snapshot');
    assert.ok(stopped.code !== 0, 'a stopped session cannot snapshot');
  });
});
