// Tests for [PROF-UI-PROCESSES]. See docs/specs/LSP-PROFILER-SPEC.md
//
// The Processes panel must REACT to the profiling session: while a CPU
// or memory session is starting/running it shows live chrome (message + badge),
// hides the "Run & Profile" launches behind a Stop affordance, and marks the
// profiled row — so it never offers to start a second session on top of a
// running one. Three layers are asserted without spawning a real profiler:
//   1. the declarative button gating in package.json (`when` clauses);
//   2. the pure chrome builders (panelMessage/panelBadge);
//   3. the live wiring — driving the real store's signal and reading the live
//      tree-view chrome + status bar back through their e2e seams.

import * as assert from 'assert';
import { getStore, useLspSuite } from './profiler-ui-helpers';
import { profilerStatusText } from '@nimblesite/lsp-profiler-ui/out/src/profiler';
import {
  panelBadge,
  panelMessage,
  processesViewState,
} from '@nimblesite/lsp-profiler-ui/out/src/process-reactivity';
import {
  IDLE_PROFILER_SESSION,
  type ProfilerSession,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-state';

import { type MenuContribution, manifestMenu } from './profiler-ui-manifest';

/** Panel-scoped entries of a given menu. */
function panelMenu(menuId: string): MenuContribution[] {
  return manifestMenu(menuId).filter((entry) =>
    (entry.when ?? '').includes('sharplsp.profiler.processes'),
  );
}

/** Assert a menu entry exists and its `when` contains a clause. */
function assertWhenHas(entry: MenuContribution | undefined, command: string, clause: string): void {
  assert.ok(entry, `${command} must be declared in the panel menu`);
  assert.ok(
    (entry.when ?? '').includes(clause),
    `${command} when must contain "${clause}"; got: ${entry.when ?? '(none)'}`,
  );
}

/** Assert `command` is declared in `menu` with `clause` in its when. */
function assertGated(menu: MenuContribution[], command: string, clause: string): void {
  assertWhenHas(
    menu.find((item) => item.command === command),
    command,
    clause,
  );
}

/** Build a session by overriding the idle baseline. */
function session(partial: Partial<ProfilerSession>): ProfilerSession {
  return { ...IDLE_PROFILER_SESSION, ...partial };
}

/** Assert `text` is present and contains `needle`. */
function assertHas(text: string | undefined, needle: string): void {
  assert.ok(text?.includes(needle), `expected "${needle}" in: ${text ?? '(none)'}`);
}

/** Assert `text` does not contain `needle` (absent counts as not containing). */
function assertLacks(text: string | undefined, needle: string): void {
  assert.ok(!text?.includes(needle), `unexpected "${needle}" in: ${text ?? '(none)'}`);
}

suite('Processes panel — reactive button gating (manifest)', () => {
  test('the Run & Profile launches gate per activity — CPU on cpuBusy, memory on memoryBusy', () => {
    const title = panelMenu('view/title');
    assertGated(title, 'sharplsp.profiler.profileCurrentFileCpu', '!sharplsp.profiler.cpuBusy');
    assertGated(title, 'sharplsp.profiler.trackMemoryCurrentFile', '!sharplsp.profiler.memoryBusy');
  });

  test('the CPU launch does NOT gate on the memory activity, so it stays available during memory tracking', () => {
    const cpu = panelMenu('view/title').find(
      (item) => item.command === 'sharplsp.profiler.profileCurrentFileCpu',
    );
    assert.ok(cpu, 'the CPU launch must be declared');
    assert.ok(
      !(cpu.when ?? '').includes('memoryBusy'),
      `the CPU launch must not key off memoryBusy: ${cpu.when ?? '(none)'}`,
    );
    const mem = panelMenu('view/title').find(
      (item) => item.command === 'sharplsp.profiler.trackMemoryCurrentFile',
    );
    assert.ok(mem, 'the memory launch must be declared');
    assert.ok(
      !(mem.when ?? '').includes('cpuBusy'),
      `the memory launch must not key off cpuBusy: ${mem.when ?? '(none)'}`,
    );
  });

  test('the title bar reveals a Stop button keyed on the active metric', () => {
    const title = panelMenu('view/title');
    assertGated(title, 'sharplsp.profiler.profileStop', 'sharplsp.profiler.profiling');
    assertGated(title, 'sharplsp.profiler.memoryStop', 'sharplsp.profiler.memoryTracking');
  });

  test('the per-row Profile/Track inline actions gate per activity', () => {
    const inline = panelMenu('view/item/context').filter((entry) =>
      (entry.group ?? '').startsWith('inline'),
    );
    assertGated(inline, 'sharplsp.profiler.profileProcess', '!sharplsp.profiler.cpuBusy');
    assertGated(inline, 'sharplsp.profiler.memoryTrackProcess', '!sharplsp.profiler.memoryBusy');
  });

  test('Track Memory is offered only on the active-debuggee row, never an external process', () => {
    // Memory tracking can't target an external process, so its row action gates
    // on the debuggee-only contextValue ([PROF-UI-PROCESSES]).
    for (const entry of panelMenu('view/item/context').filter(
      (e) => e.command === 'sharplsp.profiler.memoryTrackProcess',
    )) {
      assertWhenHas(entry, 'sharplsp.profiler.memoryTrackProcess', 'viewItem == processDebuggee');
    }
    // The CPU Profile action, by contrast, stays available on every attachable
    // row — blocked (🚫) rows opt out via `blockedProcess`, which the
    // `/^process/` clause deliberately does not match (#266).
    const profile = panelMenu('view/item/context').find(
      (e) =>
        e.command === 'sharplsp.profiler.profileProcess' && (e.group ?? '').startsWith('inline'),
    );
    assertWhenHas(profile, 'sharplsp.profiler.profileProcess', '/^process/');
  });

  test('the actively-profiled row carries an inline Stop action', () => {
    const inlineStop = panelMenu('view/item/context').find(
      (entry) =>
        entry.command === 'sharplsp.profiler.profileStop' &&
        (entry.group ?? '').startsWith('inline'),
    );
    assert.ok(inlineStop, 'the profiled row must offer an inline Stop');
    assert.strictEqual(
      inlineStop.when,
      'view == sharplsp.profiler.processes && viewItem == processProfiling',
      'the inline Stop must target only the row whose contextValue marks it as profiling',
    );
  });
});

suite('Processes panel — reactive chrome builders (pure)', () => {
  test('idle renders neither a message nor a badge', () => {
    assert.strictEqual(panelMessage(IDLE_PROFILER_SESSION), undefined);
    assert.strictEqual(panelBadge(IDLE_PROFILER_SESSION), undefined);
  });

  test('a CPU start renders a spinner message and a badge dot', () => {
    assertHas(panelMessage(session({ cpu: 'starting' })), 'Starting CPU');
    assert.strictEqual(panelBadge(session({ cpu: 'starting' }))?.value, 1);
  });

  test('an active CPU profile renders PID, then live count/duration/top once samples arrive', () => {
    const before = panelMessage(session({ cpu: 'active', cpuPid: 7 }));
    assertHas(before, 'PID 7');
    assertLacks(before, 'samples');

    const live = panelMessage(
      session({
        cpu: 'active',
        cpuPid: 4242,
        sampleCount: 1500,
        durationSecs: 3,
        topFunction: 'hot_function',
      }),
    );
    assertHas(live, 'PID 4242');
    assertHas(live, '1.5K samples');
    assertHas(live, '(3s)');
    assertHas(live, 'hot_function');
  });

  test('memory tracking renders a memory-specific message', () => {
    assertHas(panelMessage(session({ memory: 'starting' })), 'memory tracking');
    assertHas(panelMessage(session({ memory: 'active' })), 'memory');
  });

  test('a CPU profile takes precedence over concurrent memory tracking in the readout', () => {
    assertHas(
      panelMessage(session({ cpu: 'active', cpuPid: 9, memory: 'active', memorySessionId: 'm' })),
      'PID 9',
    );
  });
});

suite('Processes panel — reactive chrome (store-driven, live)', () => {
  useLspSuite('sharplsp-reactive-', resetProfilerState);

  /** The live store, asserted present. */
  function liveStore(): NonNullable<ReturnType<typeof getStore>> {
    const store = getStore();
    assert.ok(store, 'the store must be initialized after activation');
    return store;
  }

  /** Return the panel to idle so suites stay independent. */
  function resetProfilerState(): void {
    const store = getStore();
    store?.profilerStopped();
    store?.memoryTrackingStopped();
  }

  test('idle: no live chrome, the status bar is hidden, and nothing is busy', () => {
    resetProfilerState();
    assert.strictEqual(processesViewState().message, undefined, 'no panel message when idle');
    assert.strictEqual(processesViewState().badge, undefined, 'no badge when idle');
    assert.strictEqual(profilerStatusText(), undefined, 'status bar hidden when idle');
    assert.strictEqual(liveStore().profilerBusy.value, false);
  });

  test('starting → active → progress → stop drives the panel and status bar live', () => {
    const store = liveStore();

    store.profilerStarting();
    assert.strictEqual(store.profilerBusy.value, true, 'a start in flight is busy');
    assertHas(processesViewState().message, 'Starting CPU');
    assertHas(profilerStatusText(), 'starting');

    store.profilerActive(4242, 'sess-reactive-1');
    assert.strictEqual(store.profiler.value.cpu, 'active');
    assertHas(processesViewState().message, 'PID 4242');
    assert.strictEqual(processesViewState().badge, 1, 'a badge dot must mark an active profile');
    assertHas(profilerStatusText(), 'Profiling');

    store.profilerProgress(1500, 3, 'hot_function');
    assertHas(processesViewState().message, '1.5K samples');
    assertHas(profilerStatusText(), '1.5K samples');

    store.profilerStopped();
    assert.strictEqual(store.profilerBusy.value, false, 'stop clears busy');
    assert.strictEqual(processesViewState().message, undefined, 'stop clears the panel chrome');
    assert.strictEqual(processesViewState().badge, undefined, 'stop clears the badge');
    assert.strictEqual(
      profilerStatusText(),
      undefined,
      'stop hides the status bar — no zombie spinner',
    );
  });

  test('memory tracking surfaces in the panel and clears on stop', () => {
    const store = liveStore();
    store.memoryTrackingActive('mem-reactive-1');
    assert.strictEqual(store.profilerBusy.value, true, 'memory tracking counts as busy');
    assertHas(processesViewState().message, 'memory');
    store.memoryTrackingStopped();
    assert.strictEqual(processesViewState().message, undefined, 'stop clears the memory chrome');
    assert.strictEqual(store.profilerBusy.value, false);
  });

  // The crux of "both": each metric's busy signal is independent, so a CPU run
  // can start while memory tracks (and vice versa), but never a second of the
  // same metric ([PROF-UI-PROCESSES]).
  test('per-activity busy signals gate independently — CPU free during memory, memory free during CPU', () => {
    const store = liveStore();

    store.profilerActive(1234, 'sess-cpu');
    assert.strictEqual(store.cpuBusy.value, true, 'an active CPU profile makes cpuBusy true');
    assert.strictEqual(store.memoryBusy.value, false, 'an active CPU profile leaves memory free');
    store.profilerStopped();

    store.memoryTrackingActive('sess-mem');
    assert.strictEqual(
      store.memoryBusy.value,
      true,
      'active memory tracking makes memoryBusy true',
    );
    assert.strictEqual(store.cpuBusy.value, false, 'active memory tracking leaves CPU free');
    assert.strictEqual(store.profilerBusy.value, true, 'the aggregate still reflects either leg');
    store.memoryTrackingStopped();
    assert.strictEqual(
      store.profilerBusy.value,
      false,
      'stopping the last leg clears the aggregate',
    );
  });
});
