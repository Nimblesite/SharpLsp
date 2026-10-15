// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// CPU sessions against live .NET targets: what `cpu.list` reports while a
// session runs, a snapshot that reports without ending the session, the named
// presets and their explicit overrides, the refusals (a second session on one
// PID, an unknown preset, an out-of-range rate), two sessions on two targets at
// once, a duration that ends a session by itself, a target that dies
// mid-session, and the live chrome (status bar, panel message, badge, the
// flaming row) the library paints from the server's progress. Ported from
// Basilisk's profiler-cpu-e2e, profiler-ux and process-reactive-store suites.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  flamegraphPanelState,
  lastProfileResult,
  profilerStatusText,
  processesViewState,
} from '@nimblesite/lsp-profiler-ui';
import type {
  ProfileReport,
  ProfileSessionList,
  StartProfileResult,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  execute,
  executeError,
  profilerStore,
  rowOf,
  Target,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { closeAllEditors, setupLspTestSuite, teardownLspTestSuite } from './test-helpers';
import { ACTIVATION_MS, LSP_RESPONSE_MS, PROCESS_START_MS } from './test-timeouts';

const SAMPLE_WINDOW_MS = 2_000;
const HOT_FUNCTIONS = [
  'SlowJsonParsing',
  'DeepCallStack',
  'StringBuilderAllocation',
  'LockContention',
];
const STOP_MS = 60_000;

async function start(
  pid: number,
  extra: Record<string, unknown> = {},
): Promise<StartProfileResult> {
  return execute<StartProfileResult>('cpu.start', { pid, ...extra });
}

async function stop(sessionId: string): Promise<ProfileReport> {
  return execute<ProfileReport>('cpu.stop', { session_id: sessionId });
}

async function sessions(): Promise<ProfileSessionList['sessions']> {
  return (await execute<ProfileSessionList>('cpu.list', {})).sessions;
}

/** The CPU capabilities the server advertised for the .NET runtime. */
function dotnetCpu(): { live_progress: boolean } | undefined {
  return profilerStore().capabilities.value?.runtimes.find((r) => r.id === 'dotnet')?.cpu;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

suite('CPU sessions — list, snapshot and presets over the wire', () => {
  let tmpDir = '';
  let target: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-cpu-sessions-'));
    target = await Target.start('ProfileTarget');
  });
  // A test that fails mid-way must not leave its session running into the next
  // one: every test starts from an empty session list.
  teardown(async function () {
    this.timeout(STOP_MS);
    for (const session of await sessions()) {
      await stop(session.session_id);
    }
  });
  suiteTeardown(() => {
    target?.stop();
    teardownLspTestSuite(tmpDir);
  });

  test('a running session is listed with its PID, runtime, version, start time and growing counts', async function () {
    this.timeout(STOP_MS);
    assert.ok(target);
    const started = await start(target.pid);
    assert.equal(started.pid, target.pid);
    assert.ok(started.runtime_version.length > 0, 'the backend reports the runtime version');
    const listed = (await sessions()).find((s) => s.session_id === started.session_id);
    assert.ok(listed, 'the session is listed');
    assert.equal(listed.pid, target.pid);
    assert.equal(listed.runtime, 'dotnet');
    assert.equal(listed.runtime_version, started.runtime_version);
    assert.ok(!Number.isNaN(Date.parse(listed.started_at)), `RFC 3339 start: ${listed.started_at}`);
    await sleep(SAMPLE_WINDOW_MS);
    const later = (await sessions()).find((s) => s.session_id === started.session_id);
    assert.ok(later, 'still listed');
    assert.ok(later.duration_secs >= 1, `duration advances: ${later.duration_secs}`);
    // The .NET backend has no live progress ([PROFILER-SHARED-LIBRARY-VSCODE];
    // lsp-profiler's PROF-CPU-PROGRESS): its count
    // is never invented mid-session, and the report carries the real one.
    assert.equal(dotnetCpu()?.live_progress, false, 'the capability the count follows');
    assert.equal(later.sample_count, 0, 'no live count without live progress');
    const report = await stop(started.session_id);
    assert.ok(
      report.total_samples > 0,
      `the stop report carries the samples: ${report.total_samples}`,
    );
    assert.deepEqual(
      (await sessions()).filter((s) => s.session_id === started.session_id),
      [],
      'a stopped session leaves the list',
    );
  });

  test('a snapshot reports the data so far and the session keeps running', async function () {
    this.timeout(STOP_MS);
    assert.ok(target);
    const started = await start(target.pid);
    await sleep(SAMPLE_WINDOW_MS);
    const snap = await execute<ProfileReport>('cpu.snapshot', { session_id: started.session_id });
    assert.equal(snap.session_id, started.session_id);
    assert.ok(snap.total_samples > 0, `snapshot has samples: ${snap.total_samples}`);
    assert.ok(snap.hot_functions.length > 0, 'snapshot has hot functions');
    assert.ok(
      (await sessions()).some((s) => s.session_id === started.session_id),
      'the session is still listed after a snapshot',
    );
    await sleep(SAMPLE_WINDOW_MS);
    const report = await stop(started.session_id);
    assert.ok(
      report.total_samples > snap.total_samples,
      `the final report keeps sampling past the snapshot: ${report.total_samples} > ${snap.total_samples}`,
    );
  });

  test('a second session on the same PID is ALREADY_PROFILING; the first is untouched', async function () {
    this.timeout(STOP_MS);
    assert.ok(target);
    const started = await start(target.pid);
    const error = await executeError('cpu.start', { pid: target.pid });
    assert.equal(error?.code, -32004, error?.message ?? 'no error');
    assert.ok(
      (await sessions()).some((s) => s.session_id === started.session_id),
      'the original session survives the refused start',
    );
    await stop(started.session_id);
  });

  for (const [preset, rate] of [
    ['quick', 100],
    ['detailed', 200],
    ['longRunning', 50],
    ['default', 100],
  ] as const) {
    test(`preset ${preset} samples at ${rate} Hz`, async function () {
      this.timeout(STOP_MS);
      assert.ok(target);
      const started = await start(target.pid, { preset });
      await sleep(SAMPLE_WINDOW_MS / 2);
      const report = await stop(started.session_id);
      assert.equal(report.sample_rate, rate);
    });
  }

  test('an explicit sample rate overrides the preset', async function () {
    this.timeout(STOP_MS);
    assert.ok(target);
    const started = await start(target.pid, { preset: 'detailed', sample_rate: 77 });
    await sleep(SAMPLE_WINDOW_MS / 2);
    assert.equal((await stop(started.session_id)).sample_rate, 77);
  });

  test('an unknown preset is INVALID_PARAMS and names the accepted ones', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    const error = await executeError('cpu.start', { pid: target.pid, preset: 'turbo' });
    assert.equal(error?.code, -32602, error?.message ?? 'no error');
    for (const name of ['quick', 'detailed', 'longRunning']) {
      assert.ok(error.message.includes(name), `the error lists ${name}: ${error.message}`);
    }
  });

  test('a sample rate outside 1..10000 Hz is INVALID_PARAMS', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    for (const rate of [0, 10_001]) {
      const error = await executeError('cpu.start', { pid: target.pid, sample_rate: rate });
      assert.equal(error?.code, -32602, `${rate} Hz: ${error?.message ?? 'no error'}`);
    }
    assert.deepEqual(await sessions(), [], 'a refused start leaves no session behind');
  });

  test('a duration ends the session by itself and its report is kept for stop', async function () {
    this.timeout(STOP_MS);
    assert.ok(target);
    const started = await start(target.pid, { duration_secs: 1 });
    await sleep(SAMPLE_WINDOW_MS * 2);
    const report = await stop(started.session_id);
    assert.equal(report.session_id, started.session_id);
    assert.ok(report.total_samples > 0, 'the kept report has the samples it took');
    assert.ok(
      report.duration_secs < 3,
      `the session ended near its limit: ${report.duration_secs}s`,
    );
  });
});

suite('CPU sessions — concurrency and a target that dies', () => {
  let tmpDir = '';
  let first: Target | undefined;
  let second: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS * 2);
    ({ tmpDir } = await setupLspTestSuite('profiler-cpu-conc-'));
    first = await Target.start('ProfileTarget');
    second = await Target.start('ProfileLeakTarget');
  });
  suiteTeardown(() => {
    first?.stop();
    second?.stop();
    teardownLspTestSuite(tmpDir);
  });

  test('two targets profile at once and stopping one leaves the other running', async function () {
    this.timeout(STOP_MS * 2);
    assert.ok(first && second);
    const a = await start(first.pid);
    const b = await start(second.pid);
    assert.notEqual(a.session_id, b.session_id);
    const both = await sessions();
    assert.deepEqual(
      both.map((s) => s.pid).sort((x, y) => x - y),
      [first.pid, second.pid].sort((x, y) => x - y),
    );
    await sleep(SAMPLE_WINDOW_MS);
    const reportA = await stop(a.session_id);
    assert.equal(reportA.pid, first.pid);
    assert.deepEqual(
      (await sessions()).map((s) => s.session_id),
      [b.session_id],
    );
    const reportB = await stop(b.session_id);
    assert.equal(reportB.pid, second.pid);
    assert.ok(
      reportB.hot_functions.some((fn) => fn.name.includes('Spin')),
      `each report is its own target's: ${reportB.hot_functions.map((f) => f.name).join(', ')}`,
    );
  });

  test('a target killed mid-session still yields the samples taken before it died', async function () {
    this.timeout(STOP_MS + PROCESS_START_MS);
    const victim = await Target.start('ProfileTarget');
    const started = await start(victim.pid);
    await sleep(SAMPLE_WINDOW_MS);
    victim.stop();
    await sleep(1_000);
    const report = await stop(started.session_id);
    assert.equal(report.pid, victim.pid);
    assert.ok(report.total_samples > 0, `samples before death are kept: ${report.total_samples}`);
    assert.deepEqual(
      (await sessions()).filter((s) => s.session_id === started.session_id),
      [],
      'the dead session is gone from the list',
    );
  });
});

suite('CPU sessions — live chrome through the UI', () => {
  let tmpDir = '';
  let target: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-cpu-ui-'));
    target = await Target.start('ProfileTarget');
    await vscode.commands.executeCommand(uiCommand('refreshProcesses'));
  });
  suiteTeardown(async () => {
    if (profilerStore().profiler.value.cpu === 'active') {
      await vscode.commands.executeCommand(uiCommand('profileStop'));
    }
    target?.stop();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  test('Stop and Snapshot with no session change nothing', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const before = lastProfileResult();
    await vscode.commands.executeCommand(uiCommand('profileStop'));
    await vscode.commands.executeCommand(uiCommand('profileSnapshot'));
    assert.equal(profilerStore().profiler.value.cpu, 'idle');
    assert.equal(lastProfileResult(), before, 'no result is invented');
  });

  test('while profiling: elapsed time ticks, no sample count is claimed without live progress, the panel and badge follow, and the row flames', async function () {
    this.timeout(STOP_MS);
    assert.ok(target);
    const store = profilerStore();
    await vscode.commands.executeCommand(uiCommand('profileProcess'), {
      process: { pid: target.pid, debuggable: true, runtime: 'dotnet' },
    });
    await waitFor(
      () => store.profiler.value.cpu,
      (cpu) => cpu === 'active',
      PROCESS_START_MS,
      'active',
    );
    await waitFor(
      () => store.profiler.value.durationSecs,
      (secs) => secs >= 1,
      LSP_RESPONSE_MS,
      'progress ticks',
    );
    assert.equal(dotnetCpu()?.live_progress, false);
    assert.equal(store.profiler.value.sampleCount, 0, 'no invented live count');
    assert.ok(profilerStatusText()?.includes('Profiling'), `status bar: ${profilerStatusText()}`);
    assert.ok(
      !profilerStatusText()?.includes('samples'),
      `no sample claim: ${profilerStatusText()}`,
    );
    const chrome = processesViewState();
    assert.equal(chrome.message, `🔥 Profiling PID ${target.pid}…`);
    assert.equal(chrome.badge, 1);
    const row = await waitFor(
      () => rowOf(target?.pid ?? 0),
      (item) => item?.contextValue === 'processProfiling',
      LSP_RESPONSE_MS,
      'flaming row',
    );
    assert.ok(
      row?.iconPath instanceof vscode.ThemeIcon && row.iconPath.id === 'flame',
      'the row flames',
    );
  });

  test('a second Profile CPU while one runs is refused and starts nothing', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    const store = profilerStore();
    const running = store.profiler.value.cpuSessionId;
    await vscode.commands.executeCommand(uiCommand('profileProcess'), {
      process: { pid: target.pid, debuggable: true, runtime: 'dotnet' },
    });
    assert.equal(store.profiler.value.cpuSessionId, running, 'the running session is kept');
    assert.equal((await sessions()).length, 1, 'no second server session');
  });

  test('a UI snapshot lands this session’s result and keeps profiling', async function () {
    this.timeout(STOP_MS);
    const running = profilerStore().profiler.value.cpuSessionId;
    await vscode.commands.executeCommand(uiCommand('profileSnapshot'));
    const snap = await waitFor(
      () => lastProfileResult(),
      (result) => result?.sessionId === running,
      STOP_MS,
      'snapshot result',
    );
    assert.ok(snap);
    assert.equal(profilerStore().profiler.value.cpu, 'active', 'profiling continues');
  });

  test('stop lands the results panel under the SharpLsp brand with the hot functions', async function () {
    this.timeout(STOP_MS);
    await vscode.commands.executeCommand(uiCommand('profileStop'));
    await waitFor(
      () => profilerStore().profiler.value.cpu,
      (cpu) => cpu === 'idle',
      STOP_MS,
      'idle',
    );
    const panel = flamegraphPanelState();
    assert.ok(panel, 'the results panel is open');
    assert.equal(panel.title, 'SharpLsp Profiler');
    assert.ok(
      panel.html.includes('<span class="accent">SHARPLSP</span> PROFILER'),
      'brand heading',
    );
    assert.ok(!/basilisk/i.test(panel.html), 'no other product named');
    assert.ok(
      HOT_FUNCTIONS.some((name) => panel.html.includes(name)),
      "ProfileTarget's hot functions are in the panel data",
    );
    assert.deepEqual(
      processesViewState(),
      { message: undefined, badge: undefined },
      'chrome clears',
    );
    assert.equal(profilerStatusText(), undefined);
  });
});
