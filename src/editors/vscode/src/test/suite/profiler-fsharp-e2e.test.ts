// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on F#. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// F# profiling, real end-to-end: the one-click CPU and memory flows the C#
// suites prove (profiler-cpu-e2e, memory-e2e), against lspkit's F# target
// `HotLeakAppFs`. It burns CPU in `Hot.spin` and leaks records that hold a union
// case and a generic record into the module value `LeakCache.items`. F# compiles
// those to IL C# never emits: members with only hidden sequence points, union
// cases as nested classes, and a module value in an `items@<line>` field. So
// only an F# program proves that its heat map, its memory track, its type names
// and its retention roots reach the editor ([PROF-TESTING]).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  appliedMemoryDecorations,
  appliedProfileDecorations,
  flamegraphPanelOpen,
  lastMemorySnapshot,
  memoryDashboardState,
  memoryStatusText,
} from '@nimblesite/lsp-profiler-ui';
import type { MemoryStep, ProfileReport } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  completed,
  embeddedLeaks,
  execute,
  fixtureSource,
  openSource,
  profileFromRowFor,
  profilingSuite,
  retentionGraph,
  snapshotSession,
  stopTracking,
  trackMemory,
  uiCommand,
  waitFor,
} from './profiler-kit';

const FIXTURE = 'HotLeakAppFs';
const SAMPLE_WINDOW_MS = 3_000;
const STEP_MS = 90_000;
const GROWTH_MS = 2_000;
const HOT_FUNCTION = 'HotLeakAppFs.Hot.spin';
/** `Hot.spin`'s body in lspkit's dotnet/fixtures/HotLeakAppFs/Program.fs. */
const SPIN_LINES = { first: 26, last: 31 };
/** Each leaked type and the Program.fs line that constructs it, where it anchors. */
const RECORD = { type: 'HotLeakAppFs.LeakedPayload', line: 23 };
const UNION_CASE = { type: 'HotLeakAppFs.PayloadKind+Small', line: 21 };
const GENERIC_RECORD = { type: 'HotLeakAppFs.Tagged`1[System.Int32]', line: 22 };
/** The rest of lspkit's F# heap zoo, each at the line that constructs it. */
const ORDER = { type: 'HotLeakAppFs.Order', line: 77 };
const ORDER_LINE = { type: 'HotLeakAppFs.OrderLine', line: 75 };
const CUSTOMER = { type: 'HotLeakAppFs.CustomerId', line: 73 };
const EXPRESS = { type: 'HotLeakAppFs.Priority+Express', line: 76 };
const QUOTE = { type: 'HotLeakAppFs.Quote', line: 82 };
const NODE = { type: 'HotLeakAppFs.Node', line: 88 };
/** The subscription closure F# builds for `Event.Publish.Add`. */
const CLOSURE_LINE = 97;
type DashboardSite = NonNullable<ReturnType<typeof lastMemorySnapshot>>['topAllocations'][number];

const inSpin = (line: number): boolean => line >= SPIN_LINES.first && line <= SPIN_LINES.last;
const isProgramFs = (file: string | undefined): boolean => file?.endsWith('Program.fs') ?? false;

suite('F# profiling — real end-to-end', () => {
  const live = profilingSuite('profiler-fsharp-', FIXTURE);

  test('Profile CPU on an F# program → the heat map paints Hot.spin in Program.fs → the report names the F# function at its lines', async function () {
    this.timeout(STEP_MS * 2);
    const { target } = live;
    await openSource(fixtureSource(FIXTURE));
    await profileFromRowFor(target.pid, SAMPLE_WINDOW_MS, STEP_MS);
    const painted = appliedProfileDecorations().filter((entry) => isProgramFs(entry.file));
    assert.ok(
      painted.some((entry) => inSpin(entry.line)),
      `the heat map paints Hot.spin's lines: ${JSON.stringify(painted.map((e) => e.line))}`,
    );
    assert.ok(flamegraphPanelOpen(), 'the results panel opens on stop');

    const started = await execute<{ session_id: string; runtime: string }>('cpu.start', {
      pid: target.pid,
    });
    assert.equal(started.runtime, 'dotnet');
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_WINDOW_MS));
    const report = await execute<ProfileReport>('cpu.stop', { session_id: started.session_id });
    assert.ok(report.total_samples > 100, `samples: ${report.total_samples}`);
    const spin = report.hot_functions.find((fn) => fn.name.startsWith(HOT_FUNCTION));
    assert.ok(
      spin,
      `${HOT_FUNCTION} is hot: ${report.hot_functions.map((f) => f.name).join(', ')}`,
    );
    assert.ok(isProgramFs(spin.file), `the F# function resolves to Program.fs: ${spin.file}`);
    assert.ok(
      report.hot_lines.some((line) => isProgramFs(line.file) && inSpin(line.line)),
      'a hot line sits inside Hot.spin',
    );
  });

  test('Track Memory on an F# program → the memory track paints the lines that build the record, the union case and the generic record → diff scores the record as a leak → stop', async function () {
    this.timeout(STEP_MS * 3);
    const { target } = live;
    await openSource(fixtureSource(FIXTURE));
    await trackMemory(target.pid);
    assert.ok(
      memoryStatusText()?.includes('tracking'),
      `status bar follows the session: ${memoryStatusText()}`,
    );

    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    const snapshot = await waitFor(
      () => lastMemorySnapshot(),
      (snap) => snap?.topAllocations.some((site) => site.typeName === RECORD.type) ?? false,
      STEP_MS,
      'a snapshot naming the leaked record',
    );
    for (const { type, line } of [RECORD, UNION_CASE, GENERIC_RECORD]) {
      const site = snapshot?.topAllocations.find((s) => s.typeName === type);
      assert.ok(
        site,
        `${type} is a site: ${snapshot?.topAllocations.map((s) => s.typeName).join(', ')}`,
      );
      assert.ok(isProgramFs(site.file), `${type} resolves to Program.fs: ${site.file}`);
      assert.equal(site.line, line, `${type} anchors where the program constructs it`);
    }
    const painted = appliedMemoryDecorations()
      .filter((d) => isProgramFs(d.file))
      .map((d) => d.line);
    for (const { line } of [RECORD, UNION_CASE, GENERIC_RECORD]) {
      assert.ok(
        painted.includes(line),
        `the memory track paints line ${line}: ${JSON.stringify(painted)}`,
      );
    }
    assert.ok(
      memoryDashboardState()?.html.includes(UNION_CASE.type),
      'the dashboard names the union case with its union and namespace',
    );

    await new Promise((resolve) => setTimeout(resolve, GROWTH_MS));
    await vscode.commands.executeCommand(uiCommand('memoryDiff'));
    const leaks = await waitFor(
      () => embeddedLeaks(memoryDashboardState()?.html ?? ''),
      (found) => found.length > 0,
      STEP_MS,
      'suspected leaks in the dashboard',
    );
    assert.ok(
      leaks.some((leak) => leak.typeName === RECORD.type),
      `the growing F# record is a suspected leak: ${JSON.stringify(leaks)}`,
    );
    await stopTracking();
    assert.equal(memoryStatusText(), undefined, 'the status bar hides once idle');
  });

  test('the F# heap zoo: grow orders, quotes, closures, a cycle and arrays → every shape anchors at its constructing line, arrays never do → the growing record reaches Low → stop clears the track', async function () {
    this.timeout(STEP_MS * 3);
    const { target } = live;
    // A fresh, deterministic heap: no background growth, then one shape at a time.
    for (const line of ['work off', 'release all', 'payload 100', 'grow 200', 'blob 4']) {
      const reply = await target.send(line);
      assert.ok(reply.startsWith(`OK ${line}`), `the fixture accepts "${line}": ${reply}`);
    }
    await openSource(fixtureSource(FIXTURE));
    await trackMemory(target.pid);
    await vscode.commands.executeCommand(uiCommand('memorySnapshot'));
    const snapshot = await waitFor(
      () => lastMemorySnapshot(),
      (snap) => snap?.topAllocations.some((site) => site.typeName === ORDER.type) ?? false,
      STEP_MS,
      'a snapshot naming the F# order record',
    );
    assert.ok(snapshot, 'the dashboard holds the snapshot');
    for (const { type, line } of [
      RECORD,
      UNION_CASE,
      GENERIC_RECORD,
      ORDER,
      ORDER_LINE,
      CUSTOMER,
      EXPRESS,
      QUOTE,
      NODE,
    ]) {
      const foundSite: DashboardSite | undefined = snapshot.topAllocations.find(
        (entry) => entry.typeName === type,
      );
      assert.ok(
        foundSite,
        `${type} is a site: ${snapshot.topAllocations.map((entry) => entry.typeName).join(', ')}`,
      );
      assert.equal(foundSite.line, line, `${type} anchors where the program constructs it`);
      assert.ok(isProgramFs(foundSite.file), `${type} resolves to Program.fs: ${foundSite.file}`);
      assert.ok(foundSite.size > 0, `${type} has bytes`);
      assert.ok(foundSite.count > 0, `${type} has live instances`);
    }
    assert.equal(
      snapshot.topAllocations.find((site) => site.typeName === ORDER.type)?.count,
      200,
      'every live order is counted',
    );
    assert.equal(
      snapshot.topAllocations.find((site) => site.typeName === NODE.type)?.count,
      202,
      'the cycle plus one node per order',
    );
    assert.ok(
      snapshot.topAllocations.some(
        (site) => site.line === CLOSURE_LINE && site.typeName?.startsWith('HotLeakAppFs.Shapes'),
      ),
      'the event-handler closure is a site at its own line',
    );
    // [PROF-DOTNET-SOURCE] an array is the runtime's own type and is never anchored.
    for (const type of ['System.Byte[]', 'HotLeakAppFs.Order[]', 'HotLeakAppFs.LeakedPayload[]']) {
      const foundSite: DashboardSite | undefined = snapshot.topAllocations.find(
        (entry) => entry.typeName === type,
      );
      assert.ok(foundSite, `${type} is a site`);
      assert.equal(foundSite.file, undefined, `${type} has no source file`);
      assert.equal(foundSite.line, undefined, `${type} has no line`);
    }
    const painted = appliedMemoryDecorations().filter((entry) => isProgramFs(entry.file));
    for (const { line } of [ORDER, ORDER_LINE, CUSTOMER, EXPRESS, QUOTE, NODE]) {
      assert.ok(
        painted.some((entry) => entry.line === line),
        `the memory track paints line ${line}`,
      );
    }
    assert.ok(
      memoryDashboardState()?.html.includes('HotLeakAppFs.Order'),
      'the dashboard names the F# record',
    );

    await target.send('payload 100');
    await vscode.commands.executeCommand(uiCommand('memoryDiff'));
    const leaks = await waitFor(
      () => embeddedLeaks(memoryDashboardState()?.html ?? ''),
      (found) => found.length > 0,
      STEP_MS,
      'suspected leaks after the growth',
    );
    const record = leaks.find((leak) => leak.typeName === RECORD.type);
    assert.ok(record, `the growing F# record is a leak: ${JSON.stringify(leaks)}`);
    assert.equal(record.confidence, 'low', '[PROF-MEMORY-CONFIDENCE] one growth is Low');
    await stopTracking();
    assert.deepEqual(appliedMemoryDecorations(), [], 'stop clears the memory track');
  });

  test('the leaked F# record is held by the module value `static items`, and its union case is found by its full name', async function () {
    this.timeout(STEP_MS * 3);
    const { target } = live;
    const session = await snapshotSession(target.pid);
    const graph = await retentionGraph(session, RECORD.type);
    const roots = graph.nodes.filter((node) => node.is_root);
    assert.ok(
      roots.some((node) => node.root_kind === 'Static' && node.label === 'static items'),
      `the module value holds the leak under its source name: ${JSON.stringify(roots)}`,
    );
    assert.ok(
      roots.every((node) => !node.label.includes('@')),
      `no compiler-mangled field name reaches a root: ${JSON.stringify(roots.map((r) => r.label))}`,
    );

    const found = completed(
      await execute<MemoryStep>('memory.objectsByType', {
        ...session,
        type_name: UNION_CASE.type,
        limit: 5,
      }),
    );
    assert.equal(found.outcome.kind, 'Objects');
    if (found.outcome.kind === 'Objects') {
      assert.equal(found.outcome.objects.type_name, UNION_CASE.type);
      assert.ok(
        found.outcome.objects.total_count > 0,
        `live union cases: ${found.outcome.objects.total_count}`,
      );
      assert.equal(found.outcome.objects.objects.length, 5, 'the limit is honoured');
    }
    completed(await execute<MemoryStep>('memory.stop', session));
  });
});
