// Tests for [PROFILE-MEMORY-DISCOVERY]. See docs/specs/LSP-PROFILING-SPEC.md#PROFILE-MEMORY-DISCOVERY
//
// Memory-profiler discoverability (#263): starting a memory-tracking run drops
// the user in the Debug view, so the snapshot/compare actions must be VISIBLE
// there and everywhere the flow narrates them — never palette-only. These
// tests assert the four user-facing surfaces:
//
//   A. the debug toolbar carries Snapshot / Compare / Stop while tracking
//   B. the memory dashboard's "take more snapshots" advice IS a button
//   C. every toast that names an action offers that action as a button
//   D. the Processes panel (the launch surface) can drive the session
//
// The heavier flow mechanics (courier round-trip, autopilot, finalisation)
// live in memory-e2e.test.ts; this suite covers how the user FINDS the flow.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activeMemorySession } from '@nimblesite/lsp-profiler-ui/out/src/memory-profiler';
import {
  buildMemoryDashboardHtml,
  type MemoryDashboardSnapshot,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import * as memoryDashboardModule from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import type { WebviewMessage } from '@nimblesite/lsp-profiler-ui/out/src/profiler-webview';
import { Target } from './profiler-kit';
import { stopAnyDebugSession } from './run-debug-kit';
import { setupLspTestSuite, teardownLspTestSuite, closeAllEditors } from './profiler-ui-helpers';
import { manifestMenus } from './profiler-ui-manifest';
import { stringField } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';

/** One contributes.menus entry from the live manifest. */
/** A captured notification: its message and the action buttons it offered. */
interface Toast {
  readonly message: string;
  readonly actions: string[];
}

/** The label of one showInformationMessage item (string or MessageItem). */
function actionLabel(item: unknown): string | undefined {
  if (typeof item === 'string') {
    return item;
  }
  return stringField(item, 'title');
}

/** Run `body` while capturing every information toast (message + actions). */
async function captureToasts(body: () => Promise<void>): Promise<Toast[]> {
  const toasts: Toast[] = [];
  const win = vscode.window as {
    showInformationMessage: typeof vscode.window.showInformationMessage;
  };
  const original = win.showInformationMessage;
  win.showInformationMessage = async (message: string, ...items: unknown[]) => {
    const actions = items.map(actionLabel).filter((label): label is string => label !== undefined);
    toasts.push({ message, actions });
    return undefined;
  };
  try {
    await body();
  } finally {
    win.showInformationMessage = original;
  }
  return toasts;
}

/** A minimal dashboard snapshot (fresh session: one capture, no diff yet). */
function dashboardSnapshot(): MemoryDashboardSnapshot {
  return {
    memorySessionId: 'mem-disc-1',
    snapshotId: 'snap-1',
    currentMemory: 1_048_576,
    peakMemory: 2_097_152,
    gcObjects: 1200,
    gcCounts: [700, 12, 3],
    topAllocations: [{ file: '/app/main.py', line: 10, size: 4096, count: 8 }],
    timeline: [],
    heapProfilePath: '',
  };
}

/** Live targets a test started; stopped after each test. */
const targets: Target[] = [];

// ── A. Debug toolbar ────────────────────────────────────────────────────

/**
 * Starting a memory run focuses the Debug view (stopOnEntry breaks there), so
 * the actions must be ON the debug toolbar — the one surface the user is
 * guaranteed to be looking at. Palette-only actions are invisible.
 */
function assertDebugToolbarCarriesMemoryActions(): void {
  const toolbar = manifestMenus()['debug/toolBar'] ?? [];
  for (const command of [
    'sharplsp.profiler.memorySnapshot',
    'sharplsp.profiler.memoryDiff',
    'sharplsp.profiler.memoryStop',
  ]) {
    const entry = toolbar.find((candidate) => candidate.command === command);
    assert.ok(
      entry !== undefined,
      `"${command}" must be contributed to debug/toolBar — the user lands in the ` +
        `Debug view with no visible memory controls (#263); got: ${JSON.stringify(toolbar)}`,
    );
    assert.ok(
      entry.when.includes('sharplsp.profiler.memoryTracking'),
      `"${command}" on the debug toolbar must only show while tracking, when: ${entry.when}`,
    );
    assert.ok(
      entry.when.includes('debugType == sharplsp-coreclr'),
      `"${command}" must not appear on other debuggers' toolbars, when: ${entry.when}`,
    );
    // The profiling UI ships enabled — a leftover reference to the removed
    // availability-gate key would evaluate falsy and hide the toolbar buttons
    // from every shipped user.
    assert.ok(
      !entry.when.includes('sharplsp.profiler.profilingEnabled'),
      `"${command}" must not reference the removed profiling UI gate key, when: ${entry.when}`,
    );
  }
}

// ── D. Launch-panel parity ──────────────────────────────────────────────

/**
 * The panel the user clicked "Run & Track Memory" in currently collapses to a
 * lone Stop button while tracking; it must offer the whole loop.
 */
function assertLaunchPanelDrivesTheSession(): void {
  const title = (manifestMenus()['view/title'] ?? []).filter((entry) =>
    entry.when.includes('sharplsp.profiler.processes'),
  );
  for (const command of ['sharplsp.profiler.memorySnapshot', 'sharplsp.profiler.memoryDiff']) {
    const entry = title.find((candidate) => candidate.command === command);
    assert.ok(
      entry !== undefined,
      `"${command}" must join Stop on the pythonProcesses view title while tracking (#263); ` +
        `got: ${JSON.stringify(title.map((item) => item.command))}`,
    );
    assert.ok(
      entry.when.includes('sharplsp.profiler.memoryTracking'),
      `"${command}" on the panel must only show while tracking, when: ${entry.when}`,
    );
  }
}

// ── B. The dashboard's advice is actionable ─────────────────────────────

/**
 * A fresh session's dashboard (one snapshot, no diff) tells the user to take
 * more snapshots in two empty states — it must also let them DO it.
 */
function assertDashboardAdviceIsActionable(): void {
  const html = buildMemoryDashboardHtml(dashboardSnapshot());
  assert.ok(
    html.includes('Take multiple snapshots') || html.includes('Take more snapshots'),
    'precondition: the dashboard advises taking snapshots (its empty states)',
  );
  assert.ok(
    html.includes('takeSnapshot'),
    "the dashboard must wire a Take Snapshot action that posts 'takeSnapshot' back to the extension (#263)",
  );
  assert.ok(
    html.includes('compareSnapshots'),
    "the dashboard must wire a Compare Snapshots action that posts 'compareSnapshots' back to the extension (#263)",
  );
  assert.ok(
    html.includes('Take Snapshot'),
    'the Take Snapshot action must be a visible, labelled button',
  );
  assert.ok(html.includes('Compare'), 'the Compare action must be a visible, labelled button');
}

/**
 * The webview buttons post messages; the extension side must translate them
 * into the real sharplsp.profiler.memorySnapshot / sharplsp.profiler.memoryDiff runs.
 */
/**
 * Whether the module's export is the dashboard's message router.
 *
 * A predicate rather than an assertion: this suite deliberately reads
 * `memory-dashboard` as an untyped module so #263 stays a runtime check that
 * the export exists, and a predicate keeps that check while still giving the
 * caller something callable.
 */
function isMessageRouter(value: unknown): value is (msg: WebviewMessage) => boolean {
  return typeof value === 'function';
}

async function assertDashboardMessagesRouteToCommands(): Promise<void> {
  const { handleMemoryDashboardMessage } = memoryDashboardModule as {
    handleMemoryDashboardMessage?: unknown;
  };
  assert.ok(
    isMessageRouter(handleMemoryDashboardMessage),
    'memory-dashboard must export handleMemoryDashboardMessage routing the action buttons (#263)',
  );
  const route = handleMemoryDashboardMessage;

  const executed: string[] = [];
  const commandsApi = vscode.commands as {
    executeCommand: typeof vscode.commands.executeCommand;
  };
  const original = commandsApi.executeCommand;
  // Swapping in a recorder for `executeCommand` means producing its generic
  // return from nothing — no runtime check can do that, so the double keeps
  // one explained assertion.
  commandsApi.executeCommand = (async (command: string) => {
    executed.push(command);

    return undefined as never;
  }) as typeof vscode.commands.executeCommand;
  try {
    assert.strictEqual(route({ type: 'takeSnapshot' }), true, "'takeSnapshot' must be handled");
    assert.strictEqual(
      route({ type: 'compareSnapshots' }),
      true,
      "'compareSnapshots' must be handled",
    );
    assert.strictEqual(route({ type: 'unrelated' }), false, 'unknown messages must not be claimed');
  } finally {
    commandsApi.executeCommand = original;
  }
  assert.deepStrictEqual(
    executed,
    ['sharplsp.profiler.memorySnapshot', 'sharplsp.profiler.memoryDiff'],
    'the dashboard actions must run the real snapshot/compare commands',
  );
}

// ── C. Toasts offer the actions they name ───────────────────────────────

/**
 * Stopping without a capture says "Take a snapshot while paused…" — the toast
 * must carry a button for that, not point at an invisible palette.
 */
async function assertStopToastOffersTheActionItDemands(): Promise<void> {
  const toasts = await captureToasts(async () => {
    await vscode.commands.executeCommand('sharplsp.profiler.memoryStop');
  });
  const stopToast = toasts.find((toast) => /no snapshot was taken/i.test(toast.message));
  assert.ok(
    stopToast !== undefined,
    `stopping with no capture must explain itself, got: ${JSON.stringify(toasts)}`,
  );
  assert.ok(
    stopToast.actions.length > 0 &&
      stopToast.actions.some((label) => /snapshot|memory/i.test(label)),
    `the stop toast tells the user to take a snapshot but offers no way to do it (#263) — ` +
      `actions: ${JSON.stringify(stopToast.actions)}`,
  );
}

/**
 * Real flow: launch the run-forever allocator, start tracking via the real
 * command, and assert the started toast is actionable at the exact moment the
 * user is disoriented (#263).
 */
async function assertStartedToastOffersTakeSnapshot(): Promise<void> {
  // .NET memory is captured directly (no debugger pause), so the real session
  // is a live allocating target started from its processes-panel row.
  const target = await Target.start('ProfileLeakTarget');
  targets.push(target);

  const toasts = await captureToasts(async () => {
    await vscode.commands.executeCommand('sharplsp.profiler.memoryStart', target.pid);
  });
  assert.ok(activeMemorySession() !== undefined, 'tracking must start for the toast to matter');
  const startedToast = toasts.find((toast) => /memory tracking started/i.test(toast.message));
  assert.ok(
    startedToast !== undefined,
    `starting must announce itself, got: ${JSON.stringify(toasts)}`,
  );
  assert.ok(
    startedToast.actions.some((label) => /snapshot/i.test(label)),
    `the started toast is the moment the user is dropped into the Debug view — it must ` +
      `offer Take Snapshot right there (#263), actions: ${JSON.stringify(startedToast.actions)}`,
  );

  await vscode.commands.executeCommand('sharplsp.profiler.memoryStop');
}

suite('Memory discoverability — actions visible where the user lands (#263)', () => {
  let tmpDir = '';

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('sharplsp-mem-disc-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async function () {
    this.timeout(30_000);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    for (const target of targets.splice(0)) target.stop();
    await stopAnyDebugSession();
  });

  test('the debug toolbar offers Snapshot / Compare / Stop while memory tracking is active', () => {
    assertDebugToolbarCarriesMemoryActions();
  });

  test('the Processes panel can drive the session it launched — Snapshot and Compare beside Stop', () => {
    assertLaunchPanelDrivesTheSession();
  });

  test("the memory dashboard's 'take more snapshots' advice is a button, not homework", () => {
    assertDashboardAdviceIsActionable();
  });

  test("the dashboard's action messages route to the real memory commands", async () => {
    await assertDashboardMessagesRouteToCommands();
  });

  test("the 'no snapshot was taken' stop toast offers the action it demands", async () => {
    await assertStopToastOffersTheActionItDemands();
  });

  test("the 'memory tracking started' toast offers Take Snapshot on a real session", async function () {
    this.timeout(60_000);
    await assertStartedToastOffersTakeSnapshot();
  });
});
