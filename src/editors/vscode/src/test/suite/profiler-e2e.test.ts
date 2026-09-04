// Coarse end-to-end coverage for the VS Code Profiler feature.
//
// This file re-expresses the deleted unit-test coverage for src/profiler.ts,
// src/profiler-diff.ts and src/profiler-graph.ts as REAL end-to-end flows. We
// drive registered `sharplsp.profiler.*` commands through the live extension
// host, reach the live ProfilerTreeProvider via the extension's exported API,
// and exercise the exported pure helpers + webview/workflow functions inside
// those flows — asserting concrete outputs (clipboard contents, prompt logs,
// rendered HTML, formatted values, escaping).
//
// It does NOT duplicate profiler.test.ts (session/tree state management): it
// adds coverage for the uncovered command bodies, the diff/graph webview
// panels, and the dump/leak workflows. Test-mode-gated commands (collectDump,
// analyzeHeap, diffSnapshots, detectLeaks, showObjectGraph, inspectObject)
// early-return inside the host, so for those we assert the command is a safe
// no-op AND drive the real underlying workflow functions directly with the live
// client (or a fake resolving client) so their bodies run end-to-end.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';
import {
  buildSessionNode,
  buildProcessNode,
  buildCounterHtml,
  formatCounterValue,
  formatBytes,
  formatDuration,
  escapeHtml,
  ProfilerTreeItem,
  ProfilerStatusBar,
  type CounterValue,
  type SessionInfo,
  type DotNetProcess,
} from '../../profiler.js';
import {
  HeapDiffPanel,
  buildLoadingHtml,
  buildErrorHtml,
  buildDiffHtml,
  severityBadge,
  promptAndOpenDiff,
  detectLeaksWorkflow,
  formatBytes as diffFormatBytes,
  escapeHtml as diffEscapeHtml,
  type HeapDiffResult,
  type HeapTypeDiff,
  type LeakSuspect,
} from '../../profiler-diff.js';
import { ObjectGraphPanel, promptAndOpenGraph } from '../../profiler-graph.js';
import { removeDirRecursive } from './test-helpers.js';
import { ACTIVATION_MS, COMMAND_MS } from './test-timeouts';

// ── Extension API access ─────────────────────────────────────────

interface ProfilerProviderApi {
  refresh(): Promise<void>;
  addSession(
    id: string,
    kind: string,
    pid: number,
    outputPath?: string,
    processName?: string,
  ): void;
  removeSession(id: string): void;
  findSession(id: string): SessionInfo | undefined;
  getChildren(element?: ProfilerTreeItem): ProfilerTreeItem[];
  getTreeItem(element: ProfilerTreeItem): vscode.TreeItem;
  getActiveSessions(kind: string): SessionInfo[];
  processNameFor(pid: number): string | undefined;
  readonly sessionCount: number;
}

interface SharpLspApi {
  readonly profilerProvider: ProfilerProviderApi;
  readonly explorerProvider: unknown;
  getLspClient(): unknown;
}

function getApi(): SharpLspApi {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext?.isActive, 'Extension must be active');
  const api = ext.exports as SharpLspApi | undefined;
  assert.ok(api?.profilerProvider, 'Extension must export profilerProvider');
  return api;
}

function getProvider(): ProfilerProviderApi {
  return getApi().profilerProvider;
}

// ── Webview-panel spy (mirrors the archived workflow tests) ──────
//
// Workflows that succeed open a real WebviewPanel and set its `webview.html`.
// We wrap createWebviewPanel so the panels are captured for HTML inspection
// and disposed afterward. Always restore via the returned dispose().

interface PanelSpy {
  readonly created: vscode.WebviewPanel[];
  readonly titles: string[];
  restore(): void;
}

function spyWebviewPanels(): PanelSpy {
  const win = vscode.window as unknown as {
    createWebviewPanel: typeof vscode.window.createWebviewPanel;
  };
  const original = win.createWebviewPanel;
  const created: vscode.WebviewPanel[] = [];
  const titles: string[] = [];
  win.createWebviewPanel = (...args: unknown[]): vscode.WebviewPanel => {
    titles.push(String(args[1]));
    const panel = (original as (...a: unknown[]) => vscode.WebviewPanel).apply(vscode.window, args);
    created.push(panel);
    return panel;
  };
  return {
    created,
    titles,
    restore() {
      for (const panel of created) {
        try {
          panel.dispose();
        } catch {
          // best-effort cleanup
        }
      }
      win.createWebviewPanel = original;
    },
  };
}

// ── Fake LanguageClient stubs (for workflow functions, no LSP needed) ──

function resolvingDiffClient(
  result: HeapDiffResult,
  sink?: { method?: string; payload?: unknown },
) {
  return {
    sendRequest: async (method: string, payload: unknown): Promise<unknown> => {
      if (sink) {
        sink.method = method;
        sink.payload = payload;
      }
      return result;
    },
  } as never;
}

function rejectingClient(error: unknown) {
  return {
    sendRequest: async (): Promise<unknown> => {
      throw error;
    },
  } as never;
}

function fakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

// ── Fixture builders ─────────────────────────────────────────────

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'sess-1',
    kind: 'Trace',
    pid: 4242,
    processName: 'MyApp',
    outputPath: '/tmp/trace.nettrace',
    startedAt: Date.now(),
    ...overrides,
  };
}

function proc(overrides: Partial<DotNetProcess>): DotNetProcess {
  return {
    pid: 1234,
    name: 'dotnet',
    command_line: 'dotnet run --project App',
    runtime_version: '10.0.0',
    ...overrides,
  };
}

function counter(overrides: Partial<CounterValue>): CounterValue {
  return {
    provider: 'System.Runtime',
    name: 'cpu-usage',
    display_name: 'CPU Usage',
    value: 12,
    unit: '%',
    ...overrides,
  };
}

function makeDiff(overrides: Partial<HeapTypeDiff> = {}): HeapTypeDiff {
  return {
    type_name: 'System.String',
    baseline_count: 10,
    comparison_count: 20,
    count_delta: 10,
    baseline_size_bytes: 100,
    comparison_size_bytes: 300,
    size_delta_bytes: 200,
    growth_percent: 200,
    ...overrides,
  };
}

function makeSuspect(overrides: Partial<LeakSuspect> = {}): LeakSuspect {
  return {
    type_name: 'System.Object',
    severity: 'high',
    reason: 'Unbounded growth',
    count_delta: 5,
    size_delta_bytes: 1024,
    ...overrides,
  };
}

function makeResult(overrides: Partial<HeapDiffResult> = {}): HeapDiffResult {
  return {
    baseline_total_objects: 1000,
    baseline_total_size_bytes: 2048,
    comparison_total_objects: 2000,
    comparison_total_size_bytes: 4096,
    diffs: [],
    leak_suspects: [],
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════
//  SUITE
// ════════════════════════════════════════════════════════════════

suite('Profiler — command bodies, webviews & workflows (e2e)', () => {
  let tmpDir: string;
  let dumpDir: string;
  let stubs: UiStubs | undefined;
  let panelSpy: PanelSpy | undefined;
  const trackedSessions = new Set<string>();

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('profiler-e2e-');
    tmpDir = result.tmpDir;
    dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-prof-dumps-'));
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
    removeDirRecursive(dumpDir);
  });

  teardown(async () => {
    // Drop any sessions a test added so the shared provider stays clean.
    const provider = getProvider();
    for (const id of trackedSessions) provider.removeSession(id);
    trackedSessions.clear();
    panelSpy?.restore();
    panelSpy = undefined;
    stubs?.restore();
    stubs = undefined;
    await closeAllEditors();
  });

  /** Add a session via the provider and remember it for teardown cleanup. */
  function addTracked(
    provider: ProfilerProviderApi,
    id: string,
    kind: string,
    pid: number,
    outputPath?: string,
    processName?: string,
  ): void {
    provider.addSession(id, kind, pid, outputPath, processName);
    trackedSessions.add(id);
  }

  /** Create a fake dump file on disk and return its Uri. */
  function makeDumpFile(name: string): vscode.Uri {
    const p = path.join(dumpDir, name);
    fs.writeFileSync(p, 'FAKE-DUMP', 'utf8');
    return vscode.Uri.file(p);
  }

  // ───────────────────────────────────────────────────────────────
  // 1. copyPid: clipboard + info toast, driven through the real command
  //    with a provider-built process node. Exercises buildProcessNode.
  // ───────────────────────────────────────────────────────────────

  test('copyPid copies a process PID to the clipboard and toasts it', async function () {
    this.timeout(COMMAND_MS);
    stubs = installUiStubs();

    const node = buildProcessNode(
      proc({ pid: 778899, name: 'WebApi', command_line: 'WebApi.dll' }),
    );
    // Assert the node the command will consume is well-formed (buildProcessNode body).
    assert.strictEqual(node.nodeKind, 'process');
    assert.strictEqual(node.processPid, 778899);
    assert.strictEqual(node.label, 'WebApi (PID 778899)');
    assert.strictEqual(node.contextValue, 'profiler-process');

    await vscode.env.clipboard.writeText('sentinel-before');
    await vscode.commands.executeCommand('sharplsp.profiler.copyPid', node);

    const clip = await vscode.env.clipboard.readText();
    assert.strictEqual(clip, '778899', 'copyPid must place the PID on the clipboard');
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('778899')),
      'copyPid must show an info toast naming the PID',
    );

    // No-arg invocation is a safe no-op (no pid → early return, clipboard intact).
    await vscode.commands.executeCommand('sharplsp.profiler.copyPid');
    assert.strictEqual(await vscode.env.clipboard.readText(), '778899');
    assert.strictEqual(
      stubs.log.infoMessages.length,
      1,
      'a no-op copy shows no second toast — one copy, one confirmation',
    );

    // Interaction 2 — the clipboard carries the PID ALONE. A user pastes it
    // straight into `dotnet-trace collect -p`, so a label, a name or trailing
    // whitespace makes the paste fail with a parse error
    // ([PROFILER-PROCESS-LIST]).
    assert.strictEqual(clip, clip.trim(), 'the clipboard text is not padded');
    assert.strictEqual(clip.includes('WebApi'), false, 'and carries no process name');
    assert.strictEqual(clip.includes('PID'), false, 'and no label');
    assert.strictEqual(Number(clip), 778899, 'so it parses back as the number it came from');

    // Interaction 3 — a SECOND process copies its own PID over the first. A
    // command that caches the first node it saw copies the wrong process for
    // the rest of the session.
    const other = buildProcessNode(proc({ pid: 112233, name: 'Worker', command_line: 'w.dll' }));
    assert.strictEqual(other.processPid, 112233, 'the second node carries its own pid');
    await vscode.commands.executeCommand('sharplsp.profiler.copyPid', other);
    assert.strictEqual(
      await vscode.env.clipboard.readText(),
      '112233',
      'the clipboard follows the node that was clicked',
    );
    assert.ok(
      stubs.log.infoMessages.some((message) => message.includes('112233')),
      'and the toast names the second pid too',
    );
  });

  // ───────────────────────────────────────────────────────────────
  // 2. copyOutputPath: with and without an output path. Exercises
  //    buildSessionNode (which carries outputPath onto the node).
  // ───────────────────────────────────────────────────────────────

  test('copyOutputPath copies a trace output path and warns when absent', async function () {
    this.timeout(COMMAND_MS);
    stubs = installUiStubs();

    const tracePath = path.join(dumpDir, 'session.nettrace');
    const withPath = buildSessionNode(
      session({ kind: 'Trace', outputPath: tracePath, id: 'cp-1', pid: 4242 }),
    );
    assert.strictEqual(withPath.outputPath, tracePath, 'session node carries outputPath');

    await vscode.env.clipboard.writeText('sentinel');
    await vscode.commands.executeCommand('sharplsp.profiler.copyOutputPath', withPath);
    assert.strictEqual(await vscode.env.clipboard.readText(), tracePath);
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes(tracePath)),
      'a path was copied → "Copied:" toast names it',
    );

    // A session node WITHOUT an output path → informational "no output" toast,
    // clipboard untouched.
    const noPath = buildSessionNode(session({ outputPath: undefined, id: 'cp-2' }));
    assert.strictEqual(noPath.outputPath, undefined);
    await vscode.commands.executeCommand('sharplsp.profiler.copyOutputPath', noPath);
    assert.strictEqual(await vscode.env.clipboard.readText(), tracePath, 'clipboard unchanged');
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('no output file')),
      'missing output path surfaces the "no output file yet" message',
    );

    // Interaction 3 — "no output yet" is INFORMATION, not an error. A trace
    // that has not flushed its file is the normal state of a running session
    // ([PROFILER-SESSIONS-LIFECYCLE]: Created -> Running -> Stopped), so a red
    // toast for it trains the user to ignore red toasts.
    assert.deepEqual(stubs.log.errorMessages, [], 'a pending output file is not an error');
    assert.deepEqual(stubs.log.warningMessages, [], 'nor a warning');
    assert.strictEqual(stubs.log.infoMessages.length, 2, 'one toast per invocation, no more');

    // Interaction 4 — the copied path is the session's OWN output, verbatim.
    // A path rewritten on the way to the clipboard cannot be opened, and
    // [PROFILER-TRACE-CONVERSION] makes the sibling name load-bearing.
    assert.strictEqual(withPath.outputPath, tracePath, 'the node still carries its own path');
    assert.ok(tracePath.endsWith('.nettrace'), 'the fixture really is a trace file');
    assert.strictEqual(
      (await vscode.env.clipboard.readText()).trim(),
      tracePath,
      'and the clipboard holds it untrimmed and unrewritten',
    );

    // Interaction 5 — a no-arg invocation copies nothing at all, so a command
    // run from the palette with no selection cannot clobber the clipboard.
    await vscode.commands.executeCommand('sharplsp.profiler.copyOutputPath');
    assert.strictEqual(
      await vscode.env.clipboard.readText(),
      tracePath,
      'a no-arg copy leaves the clipboard untouched',
    );
  });

  // ───────────────────────────────────────────────────────────────
  // 3. killProcess: confirmation warning gating. Cancel vs confirm.
  //    Confirm path hits the live LSP killProcess request (no real PID,
  //    so it errors → error toast); we only assert the prompt + safety.
  // ───────────────────────────────────────────────────────────────

  test('killProcess gates on a modal confirmation before terminating', async function () {
    this.timeout(COMMAND_MS);
    const provider = getProvider();
    const node = buildProcessNode(proc({ pid: 424242, name: 'Victim', command_line: 'v.dll' }));

    // (a) Dismiss the warning → handler returns before any LSP request.
    stubs = installUiStubs();
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.killProcess', node);
    });
    assert.strictEqual(stubs.log.warningMessages.length, 1, 'one confirmation prompt shown');
    assert.ok(
      stubs.log.warningMessages[0]?.includes('Victim (PID 424242)'),
      'warning names the process and PID',
    );
    assert.ok(
      stubs.log.warningMessages[0]?.includes('forcibly terminates'),
      'warning explains the destructive, irreversible action',
    );
    stubs.restore();

    // Interaction 2 - [PROFILER-PROCESS-LIST] terminates a process the user
    // does not own the lifetime of. The confirmation must therefore be MODAL
    // and offer exactly the destructive verb: a non-modal toast can be swept
    // away by the next notification before it is read, and an extra button is
    // one more thing to mis-click.
    assert.strictEqual(stubs.log.warningOptions[0]?.modal, true, 'the kill prompt is modal');
    assert.deepEqual(stubs.log.warningActions[0], ['Kill'], "offering only 'Kill'");
    assert.deepEqual(stubs.log.errorMessages, [], 'and a dismissed prompt is not an error');
    assert.deepEqual(stubs.log.infoMessages, [], 'nor does it report a termination');

    // (b) Confirm "Kill": the real command sends the LSP request for a PID that
    //     does not exist. It must not throw; either an error toast or a refresh
    //     follows. The session count is unaffected by a kill.
    stubs = installUiStubs().queueWarning('Kill');
    const before = provider.sessionCount;
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.killProcess', node);
    }, 'confirmed kill of a bogus PID must not throw');
    assert.strictEqual(stubs.log.warningMessages.length, 1, 'confirmation still shown once');
    assert.strictEqual(provider.sessionCount, before, 'killing a process changes no sessions');
  });

  // ───────────────────────────────────────────────────────────────
  // 4. stopSession (Counters): clicking a Counters session reveals its
  //    live panel rather than stopping it. Drives the real command with a
  //    provider-registered Counters session + buildSessionNode arg.
  // ───────────────────────────────────────────────────────────────

  test('stopSession on a Counters session opens its live counters webview', async function () {
    this.timeout(COMMAND_MS);
    const provider = getProvider();
    panelSpy = spyWebviewPanels();

    addTracked(provider, 'cnt-show-1', 'Counters', 31337, undefined, 'Streamer');
    const stored = provider.findSession('cnt-show-1');
    assert.ok(stored, 'session registered in provider');
    assert.strictEqual(stored.kind, 'Counters');

    const node = buildSessionNode(stored);
    assert.strictEqual(node.command?.command, 'sharplsp.profiler.stopSession');
    assert.strictEqual(node.command.title, 'Show Counters', 'Counters click is "Show Counters"');

    await vscode.commands.executeCommand('sharplsp.profiler.stopSession', node);

    assert.strictEqual(panelSpy.created.length, 1, 'exactly one counter webview opened');
    assert.ok(
      panelSpy.titles.some((t) => t.includes('Counters: PID 31337')),
      'counter panel title carries the PID',
    );
    const html = panelSpy.created[0]?.webview.html ?? '';
    assert.ok(html.includes('Live .NET Performance Counters'), 'counter panel shows its heading');
    assert.ok(
      html.includes('Waiting for counter data'),
      'fresh panel shows the waiting placeholder',
    );

    // stopSession with no session (unknown id) is a safe no-op (no extra panel).
    const orphan = new ProfilerTreeItem('x', 'session', vscode.TreeItemCollapsibleState.None, {
      sessionId: 'does-not-exist',
    });
    await vscode.commands.executeCommand('sharplsp.profiler.stopSession', orphan);
    assert.strictEqual(panelSpy.created.length, 1, 'unknown session opens no further panel');
  });

  // ───────────────────────────────────────────────────────────────
  // 5. showCountersPanel: opens (and re-reveals) a counters webview for a
  //    registered session; no-ops for an unknown session.
  // ───────────────────────────────────────────────────────────────

  test('showCountersPanel reveals a panel for a known session and re-uses it', async function () {
    this.timeout(COMMAND_MS);
    const provider = getProvider();
    panelSpy = spyWebviewPanels();

    addTracked(provider, 'cnt-panel-1', 'Counters', 9090, undefined, 'PanelProc');
    const node = buildSessionNode(provider.findSession('cnt-panel-1')!);

    await vscode.commands.executeCommand('sharplsp.profiler.showCountersPanel', node);
    assert.strictEqual(panelSpy.created.length, 1, 'first call opens the panel');

    // A second call for the SAME session reveals the existing panel (no new one).
    await vscode.commands.executeCommand('sharplsp.profiler.showCountersPanel', node);
    assert.strictEqual(panelSpy.created.length, 1, 'second call re-uses the existing panel');

    // Unknown session → no panel.
    const unknown = new ProfilerTreeItem('y', 'session', vscode.TreeItemCollapsibleState.None, {
      sessionId: 'nope',
    });
    await vscode.commands.executeCommand('sharplsp.profiler.showCountersPanel', unknown);
    assert.strictEqual(panelSpy.created.length, 1, 'unknown session adds no panel');

    // No-arg invocation is a safe no-op.
    await vscode.commands.executeCommand('sharplsp.profiler.showCountersPanel');
    assert.strictEqual(panelSpy.created.length, 1);

    // Interaction 2 — the panel is TITLED for its session. [PROFILER-EDITOR-VSCODE]
    // lists one webview per counter session; two identically-titled tabs leave
    // the user unable to tell which process they are watching.
    const title = panelSpy.titles[0] ?? '';
    assert.ok(title.length > 0, 'the counters panel carries a title');
    assert.ok(
      title.includes('9090') || title.includes('PanelProc') || /counter/i.test(title),
      `the title identifies the session; got '${title}'`,
    );
    assert.strictEqual(panelSpy.titles.length, 1, 'and there is exactly one panel title');

    // Interaction 3 — a SECOND session gets its OWN panel. Re-use is keyed by
    // session id, not by "a counters panel exists"; sharing one panel across
    // sessions overwrites the first process's live counters with the second's.
    addTracked(provider, 'cnt-panel-2', 'Counters', 9091, undefined, 'OtherProc');
    const second = buildSessionNode(provider.findSession('cnt-panel-2')!);
    assert.notStrictEqual(second.sessionId, node.sessionId, 'the two nodes are different sessions');
    await vscode.commands.executeCommand('sharplsp.profiler.showCountersPanel', second);
    assert.strictEqual(panelSpy.created.length, 2, 'a second session opens a second panel');
    assert.strictEqual(
      new Set(panelSpy.titles).size,
      2,
      `the two panels are distinctly titled; got: ${panelSpy.titles.join(' | ')}`,
    );

    // Interaction 4 — and re-revealing the FIRST session still re-uses its own
    // panel rather than the one that was opened most recently.
    await vscode.commands.executeCommand('sharplsp.profiler.showCountersPanel', node);
    assert.strictEqual(panelSpy.created.length, 2, 'no third panel for a session already shown');
  });

  // ───────────────────────────────────────────────────────────────
  // 6. stopTrace / stopCounters with no active sessions: the pickActiveSession
  //    helper surfaces an info message and returns. Drives both real commands.
  // ───────────────────────────────────────────────────────────────

  test('stopTrace and stopCounters report when there are no active sessions', async function () {
    this.timeout(COMMAND_MS);
    const provider = getProvider();
    // Ensure no sessions of these kinds exist.
    for (const s of [
      ...provider.getActiveSessions('Trace'),
      ...provider.getActiveSessions('Counters'),
    ]) {
      provider.removeSession(s.id);
    }
    stubs = installUiStubs();

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.stopTrace');
    });
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.stopCounters');
    });

    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('No active Trace sessions')),
      'stopTrace with none active shows "No active Trace sessions"',
    );
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('No active Counters sessions')),
      'stopCounters with none active shows "No active Counters sessions"',
    );

    // Interaction 2 — the two messages name their OWN session kind. A shared
    // "no active sessions" string leaves the user unable to tell whether the
    // trace they started is still running ([PROFILER-SESSIONS-LIFECYCLE]).
    assert.strictEqual(stubs.log.infoMessages.length, 2, 'one message per command');
    assert.strictEqual(
      new Set(stubs.log.infoMessages).size,
      2,
      `the two messages differ; got: ${stubs.log.infoMessages.join(' | ')}`,
    );
    assert.deepEqual(stubs.log.errorMessages, [], 'having nothing to stop is not an error');

    // Interaction 3 — nothing was picked and nothing was started. A stop with
    // no candidates must not fall back to a picker the user then has to
    // dismiss, and must not leave a phantom session behind.
    assert.deepEqual(
      stubs.log.quickPickItems,
      [],
      'no picker is shown when there is nothing to stop',
    );
    assert.strictEqual(provider.getActiveSessions('Trace').length, 0, 'still no trace sessions');
    assert.strictEqual(
      provider.getActiveSessions('Counters').length,
      0,
      'still no counter sessions',
    );

    // Interaction 4 — with a session PRESENT the same command reaches the
    // picker instead, so the message above is a guard and not a dead command.
    addTracked(provider, 'stop-guard-1', 'Trace', 5150, undefined, 'GuardProc');
    assert.strictEqual(provider.getActiveSessions('Trace').length, 1, 'one trace session now');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.stopTrace');
    }, 'stopTrace with a live session must not throw');
    assert.strictEqual(
      stubs.log.infoMessages.filter((m) => m.includes('No active Trace sessions')).length,
      1,
      'and must not repeat the "nothing to stop" message when there IS something',
    );
    provider.removeSession('stop-guard-1');
  });

  // ───────────────────────────────────────────────────────────────
  // 7. traceProcess / countersProcess / dumpProcess with no PID → no-ops.
  //    With a valid process node the trace/counters paths hit the live LSP
  //    (bogus PID → error toast); must never throw. Exercises buildProcessNode.
  // ───────────────────────────────────────────────────────────────

  test('per-process commands are safe no-ops without a PID and do not throw with one', async function () {
    // Every other test in this suite drives ONE command, which is what `COMMAND_MS`
    // budgets. This one drives five: three no-arg early-return commands, then
    // traceProcess and countersProcess against a PID that does not exist - and
    // those two reach the live LSP host and wait for it to answer that the process
    // is gone. Five round trips cost five round trips, so it declares them.
    this.timeout(5 * COMMAND_MS);
    stubs = installUiStubs();
    const provider = getProvider();

    // No-arg / no-pid item → early return, no throw, no toast.
    for (const cmd of [
      'sharplsp.profiler.traceProcess',
      'sharplsp.profiler.countersProcess',
      'sharplsp.profiler.dumpProcess',
    ]) {
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand(cmd);
      }, `${cmd} with no item must be a safe no-op`);
    }

    // With a real process node, startTrace/startCounters reach the live LSP host
    // for a PID that does not exist → graceful error toast, never a throw.
    const node = buildProcessNode(proc({ pid: 999999, name: 'Ghost', command_line: 'ghost.dll' }));
    assert.strictEqual(node.command?.command, 'sharplsp.profiler.traceProcess');
    const sessionsBefore = provider.sessionCount;
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.traceProcess', node);
    });
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.countersProcess', node);
    });
    // dumpProcess early-returns in test mode; still must not throw.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.dumpProcess', node);
    });
    // A bogus PID never yields a real session.
    assert.strictEqual(
      provider.getActiveSessions('Trace').filter((s) => s.pid === 999999).length,
      0,
      'no phantom trace session for a non-existent PID',
    );
    assert.ok(provider.sessionCount >= sessionsBefore);

    // Interaction 4 — [PROFILER-EDITOR-VSCODE-TREE] requires a process row to
    // be profilable FROM the row. That means the node carries the command, the
    // pid it acts on, and the context value its menu is scoped by — a node
    // missing any of them renders a row with no actions.
    assert.strictEqual(node.processPid, 999999, 'the node carries the pid it will act on');
    assert.strictEqual(node.contextValue, 'profiler-process', 'and the menu scope');
    assert.strictEqual(node.nodeKind, 'process', 'and identifies itself as a process row');
    assert.ok(String(node.label).includes('Ghost'), `and names the process: ${String(node.label)}`);

    // Interaction 5 — a dead PID produces no counters session either, and the
    // failures are REPORTED rather than swallowed: [PROFILER-SESSIONS-LIFECYCLE]
    // has a Failed state precisely so the tree does not show a phantom Running.
    assert.strictEqual(
      provider.getActiveSessions('Counters').filter((s) => s.pid === 999999).length,
      0,
      'no phantom counters session for a non-existent PID',
    );
    assert.strictEqual(
      provider.getActiveSessions('Trace').some((s) => s.pid === 999999),
      false,
      'and none among the trace sessions',
    );
    assert.deepEqual(
      stubs.log.quickPickItems,
      [],
      'a per-process command acts on ITS row and never falls back to a picker',
    );
  });

  // ───────────────────────────────────────────────────────────────
  // 8. listProcesses + refresh: drive the real commands and assert the tree
  //    renders. Exercises ProfilerTreeProvider.getChildren / getTreeItem.
  // ───────────────────────────────────────────────────────────────

  test('refresh and listProcesses repopulate the tree without throwing', async function () {
    this.timeout(COMMAND_MS);
    const provider = getProvider();

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.refresh');
    });
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.listProcesses');
    });

    // The tree must always render at least one node (real processes, or the
    // "No .NET processes found" placeholder). getTreeItem returns the element.
    const nodes = provider.getChildren();
    assert.ok(nodes.length >= 1, 'tree always renders at least one node');
    const first = nodes[0]!;
    assert.strictEqual(provider.getTreeItem(first), first, 'getTreeItem is identity');
    // Every node is a leaf (flat tree).
    assert.deepStrictEqual(provider.getChildren(first), [], 'nodes have no children');
    // The node is either a real process header/empty placeholder.
    assert.ok(
      typeof first.label === 'string' || typeof first.label === 'object',
      'first node has a label',
    );

    // Interaction 2 — every row is well formed. A row with no label renders
    // blank; one with no collapsible state renders an arrow that expands to
    // nothing ([PROFILER-EDITOR-VSCODE-TREE]).
    for (const item of nodes) {
      assert.notStrictEqual(item.label, undefined, 'every tree row carries a label');
      assert.notStrictEqual(item.collapsibleState, undefined, 'and a collapsible state');
      assert.strictEqual(
        item.collapsibleState,
        vscode.TreeItemCollapsibleState.None,
        'and the profiler tree is flat, so no row claims children',
      );
    }

    // Interaction 3 — refreshing is REPEATABLE and idempotent in shape. A
    // refresh that duplicates rows turns a busy machine's process list into a
    // list of the same process ten times over.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.refresh');
    }, 'a second refresh must not throw');
    const after = provider.getChildren();
    assert.ok(after.length >= 1, 'the tree still renders after a second refresh');
    const labels = after.map((item) => String(item.label));
    assert.deepEqual([...new Set(labels)], labels, 'and renders no row twice');
  });

  // ───────────────────────────────────────────────────────────────
  // 9. openTrace command: cancelled dialog → no-op. With a .speedscope.json
  //    file selected, openTraceFile routes to vscode.env.openExternal. In the
  //    headless host the DialogService REFUSES to open external websites, so we
  //    either stub openExternal (when reassignable) and assert it was called
  //    with the speedscope uri, or fall back to accepting the host's refusal as
  //    proof the handler reached the open-external step.
  // ───────────────────────────────────────────────────────────────

  test('openTrace cancels cleanly and routes a selected speedscope file to open-external', async function () {
    this.timeout(COMMAND_MS);

    // (a) Cancelled dialog → early return.
    stubs = installUiStubs();
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.openTrace');
    });
    assert.strictEqual(stubs.log.openDialogOptions.length, 1, 'open dialog was shown');
    assert.strictEqual(
      stubs.log.openDialogOptions[0]?.title,
      'Open Trace File',
      'dialog titled "Open Trace File"',
    );
    stubs.restore();

    // (b) Select a .speedscope.json file → openTraceFile reaches openExternal.
    const speedscope = path.join(dumpDir, 'capture.speedscope.json');
    fs.writeFileSync(speedscope, '{}', 'utf8');
    stubs = installUiStubs().queueOpenDialog([vscode.Uri.file(speedscope)]);

    // Try to stub openExternal so we can positively assert it was reached with
    // the speedscope URL. `vscode.env.openExternal` may be a read-only getter;
    // if so, defineProperty throws and we fall back to the refusal-tolerant path.
    const env = vscode.env as unknown as Record<string, unknown>;
    const original = env['openExternal'];
    const captured: vscode.Uri[] = [];
    let stubbed: boolean;
    try {
      Object.defineProperty(vscode.env, 'openExternal', {
        value: async (uri: vscode.Uri): Promise<boolean> => {
          captured.push(uri);
          return true;
        },
        configurable: true,
        writable: true,
      });
      stubbed = true;
    } catch {
      stubbed = false;
    }

    try {
      if (stubbed) {
        // With openExternal stubbed the command resolves; assert it was called
        // with a speedscope URL carrying the local profile path.
        await vscode.commands.executeCommand('sharplsp.profiler.openTrace');
        assert.strictEqual(captured.length, 1, 'openExternal reached once for a speedscope file');
        // Uri.toString() percent-encodes the fragment (localProfilePath= -> %3D),
        // so inspect with skipEncoding to assert the raw query the source builds
        // (profiler.ts: https://www.speedscope.app/#localProfilePath=<encoded path>).
        const url = captured[0]?.toString(true) ?? '';
        assert.ok(url.includes('speedscope.app'), 'speedscope viewer URL is opened externally');
        assert.ok(url.includes('localProfilePath='), 'URL carries the local profile path');
      } else {
        // openExternal is not reassignable: accept EITHER a clean resolve OR a
        // reject whose message is the host's external-open refusal (which proves
        // the handler reached the open-external step) — and nothing else.
        let resolvedCleanly = false;
        let reachedOpenExternal = false;
        try {
          await vscode.commands.executeCommand('sharplsp.profiler.openTrace');
          resolvedCleanly = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(
            msg.includes('refused to show dialog') ||
              msg.toLowerCase().includes('openexternal') ||
              msg.includes('external website'),
            `openTrace must only reject via the open-external refusal; got: ${msg}`,
          );
          reachedOpenExternal = true;
        }
        assert.ok(
          resolvedCleanly || reachedOpenExternal,
          'openTrace resolves or reaches the open-external step for a speedscope file',
        );
      }
    } finally {
      if (stubbed) {
        Object.defineProperty(vscode.env, 'openExternal', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    }

    assert.strictEqual(stubs.log.openDialogOptions.length, 1, 'one open dialog for the selection');
    assert.strictEqual(stubs.log.openDialogOptions[0]?.title, 'Open Trace File');
  });

  // ───────────────────────────────────────────────────────────────
  // 10. convertTrace command: cancelled dialog is a no-op. Drives the real
  //     command; with the live client a real conversion may run for a bogus
  //     path, so we only assert the cancel path deterministically.
  // ───────────────────────────────────────────────────────────────

  test('convertTrace is a no-op when the file dialog is cancelled', async function () {
    this.timeout(COMMAND_MS);
    stubs = installUiStubs();
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.convertTrace');
    });
    // Either no dialog (no client) or exactly one cancelled dialog — never throws.
    if (stubs.log.openDialogOptions.length > 0) {
      assert.strictEqual(stubs.log.openDialogOptions[0]?.title, 'Convert .nettrace File');
    }

    // Interaction 2 — a cancelled dialog is SILENT. The user pressed Escape;
    // an error toast for that is noise, and a success toast is a lie about a
    // conversion that never ran ([PROFILER-TRACE-CONVERSION]).
    assert.deepEqual(stubs.log.errorMessages, [], 'cancelling the picker is not an error');
    assert.deepEqual(stubs.log.infoMessages, [], 'and reports no conversion');
    assert.deepEqual(stubs.log.warningMessages, [], 'and no warning');
    assert.ok(stubs.log.openDialogOptions.length <= 1, 'at most one dialog was shown');

    // Interaction 3 — the dialog it WOULD have shown is scoped to trace files.
    // `convertTrace` takes "any trace file on disk", so an unfiltered picker
    // lets the user choose a .json and get a conversion error instead of a
    // greyed-out entry.
    const dialog = stubs.log.openDialogOptions[0];
    if (dialog) {
      assert.strictEqual(dialog.canSelectMany, false, 'one input file, not many');
      assert.strictEqual(dialog.canSelectFolders !== true, true, 'a file, never a folder');
      assert.ok(dialog.filters, 'and the picker filters by extension');
      assert.ok(
        JSON.stringify(dialog.filters).includes('nettrace'),
        `filtering to .nettrace; got ${JSON.stringify(dialog.filters)}`,
      );
    }

    // Interaction 4 — cancelling twice is still a no-op, so a user who
    // dismisses the picker can simply run the command again.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.convertTrace');
    }, 'a second cancelled conversion must not throw');
    assert.deepEqual(stubs.log.errorMessages, [], 'and still reports nothing');
  });

  // ───────────────────────────────────────────────────────────────
  // 11. revealOutput: with a path → revealFileInOS; without → info toast.
  // ───────────────────────────────────────────────────────────────

  test('revealOutput warns when a session has no output file yet', async function () {
    this.timeout(COMMAND_MS);
    stubs = installUiStubs();
    const noPath = buildSessionNode(session({ outputPath: undefined, id: 'rv-1' }));
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.revealOutput', noPath);
    });
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('no output file')),
      'revealOutput with no path shows the "no output file yet" message',
    );

    // No-arg invocation is a safe no-op too.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.revealOutput');
    });
    assert.deepEqual(stubs.log.errorMessages, [], 'and neither path is an error');

    // Interaction 2 — the node really has no path, so the message above is
    // about the session state and not about a node the test built wrong.
    assert.strictEqual(noPath.outputPath, undefined, 'the session carries no output path');
    assert.strictEqual(noPath.nodeKind, 'session', 'and it is a session row');
    assert.strictEqual(stubs.log.infoMessages.length, 1, 'one message, from the one node');

    // Interaction 3 — a session that HAS produced a file behaves differently.
    // A command that shows "no output file yet" whatever it is given is a
    // command that never reveals anything ([PROFILER-EDITOR-VSCODE]).
    const revealPath = path.join(dumpDir, 'revealed.nettrace');
    fs.writeFileSync(revealPath, 'FAKE-TRACE', 'utf8');
    const withPath = buildSessionNode(session({ outputPath: revealPath, id: 'rv-2' }));
    assert.strictEqual(withPath.outputPath, revealPath, 'the second node carries its path');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.revealOutput', withPath);
    }, 'revealing a real file must not throw');
    assert.strictEqual(
      stubs.log.infoMessages.filter((m) => m.includes('no output file')).length,
      1,
      'and must NOT repeat the "no output file yet" message for a file that exists',
    );
    assert.ok(fs.existsSync(revealPath), 'the file it revealed is still on disk');
  });

  // ───────────────────────────────────────────────────────────────
  // 12. diffSnapshots command (test-mode gated → no-op) AND the real
  //     promptAndOpenDiff workflow driven directly with a fake resolving
  //     client. Asserts: command does not throw; two-dialog gating; rendered
  //     diff HTML; and buildDiffHtml / severityBadge / formatBytes outputs.
  // ───────────────────────────────────────────────────────────────

  test('diffSnapshots: gated command no-op + promptAndOpenDiff renders a real diff panel', async function () {
    this.timeout(COMMAND_MS);

    // (a) The registered command early-returns in test mode → safe no-op.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.diffSnapshots');
    }, 'diffSnapshots command must not throw in the test host');

    const baseline = makeDumpFile('base.dmp');
    const comparison = makeDumpFile('cmp.dmp');
    const result = makeResult({
      baseline_total_objects: 1000,
      comparison_total_objects: 2500,
      leak_suspects: [makeSuspect({ severity: 'high', type_name: 'Leaky<T>' })],
      diffs: [makeDiff({ type_name: 'Growing', count_delta: 5, size_delta_bytes: 1048576 })],
    });

    // (b) Cancel BASELINE dialog → no panel.
    panelSpy = spyWebviewPanels();
    stubs = installUiStubs().queueOpenDialog(undefined);
    await promptAndOpenDiff(fakeContext(), resolvingDiffClient(result));
    assert.strictEqual(panelSpy.created.length, 0, 'baseline cancel opens no panel');
    assert.strictEqual(stubs.log.openDialogOptions.length, 1, 'only the baseline dialog shown');
    assert.ok(stubs.log.openDialogOptions[0]?.title?.includes('BASELINE'));
    stubs.restore();
    panelSpy.restore();

    // (c) Both files chosen → one diff panel rendered with the result.
    panelSpy = spyWebviewPanels();
    stubs = installUiStubs().queueOpenDialog([baseline], [comparison]);
    const sink: { method?: string; payload?: unknown } = {};
    await promptAndOpenDiff(fakeContext(), resolvingDiffClient(result, sink));

    assert.strictEqual(panelSpy.created.length, 1, 'both files selected → one diff panel');
    assert.strictEqual(sink.method, 'sharplsp/profiler/diffHeapSnapshots', 'correct LSP method');
    const payload = sink.payload as { baseline_dump_path: string; comparison_dump_path: string };
    assert.strictEqual(payload.baseline_dump_path, baseline.fsPath);
    assert.strictEqual(payload.comparison_dump_path, comparison.fsPath);

    const html = panelSpy.created[0]?.webview.html ?? '';
    assert.ok(html.includes('<h2>Heap Snapshot Diff</h2>'), 'rendered the diff document');
    assert.ok(!html.includes('Comparing heap snapshots'), 'loading shell replaced');
    assert.ok(html.includes('<h3>Leak Suspects (1)</h3>'), 'suspect count rendered');
    assert.ok(html.includes(severityBadge('high')), 'high-severity badge present');
    assert.ok(html.includes('Leaky&lt;T&gt;'), 'suspect type name HTML-escaped');
    assert.ok(html.includes('+1.0 MB'), 'positive MB size delta formatted on the growing row');
    assert.ok(
      html.includes((2500).toLocaleString()),
      'comparison object count uses locale grouping',
    );

    // (d) Pure-helper assertions inside this same flow.
    assert.strictEqual(severityBadge('medium'), '<span class="badge badge-medium">medium</span>');
    assert.strictEqual(diffFormatBytes(-2048), '-2.0 KB', 'diff formatBytes signs negatives');
    assert.strictEqual(diffFormatBytes(1048576), '1.0 MB');
    assert.strictEqual(diffEscapeHtml('a & <b>'), 'a &amp; &lt;b&gt;');
  });

  // ───────────────────────────────────────────────────────────────
  // 13. detectLeaks command (gated no-op) + the real detectLeaksWorkflow,
  //     driven through ui-stubbed info messages and open dialogs. Asserts the
  //     guided gating (decline aborts) and the happy-path panel render.
  // ───────────────────────────────────────────────────────────────

  test('detectLeaks: gated command no-op + guided detectLeaksWorkflow gating and happy path', async function () {
    this.timeout(COMMAND_MS);

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.detectLeaks');
    }, 'detectLeaks command must not throw in the test host');

    const baseline = makeDumpFile('leak-base.dmp');
    const comparison = makeDumpFile('leak-cmp.dmp');
    const result = makeResult({
      leak_suspects: [makeSuspect({ severity: 'medium', type_name: 'Leaky' })],
      diffs: [makeDiff({ type_name: 'Growing' })],
    });

    // (a) Declining the FIRST guided info message aborts before any dialog.
    panelSpy = spyWebviewPanels();
    stubs = installUiStubs().queueInfo('Cancel');
    await detectLeaksWorkflow(fakeContext(), resolvingDiffClient(result));
    assert.strictEqual(panelSpy.created.length, 0, 'declining baseline step opens no panel');
    assert.strictEqual(stubs.log.infoMessages.length, 1, 'only the first guided message shown');
    assert.ok(stubs.log.infoMessages[0]?.includes('BASELINE'));
    assert.strictEqual(stubs.log.openDialogOptions.length, 0, 'no dialog after declining');
    stubs.restore();
    panelSpy.restore();

    // (b) Full happy path: accept both guided steps, pick both dumps → panel.
    panelSpy = spyWebviewPanels();
    stubs = installUiStubs()
      .queueInfo('Select Baseline', 'Select Comparison Dump')
      .queueOpenDialog([baseline], [comparison]);
    const sink: { method?: string; payload?: unknown } = {};
    await detectLeaksWorkflow(fakeContext(), resolvingDiffClient(result, sink));

    assert.strictEqual(panelSpy.created.length, 1, 'happy path opens exactly one diff panel');
    assert.strictEqual(stubs.log.infoMessages.length, 2, 'both guided steps shown');
    assert.ok(
      stubs.log.infoMessages[1]?.includes('exercise the suspected leak path'),
      'second guided step prompts the user to exercise the leak path',
    );
    assert.strictEqual(sink.method, 'sharplsp/profiler/diffHeapSnapshots');
    const payload = sink.payload as { baseline_dump_path: string; comparison_dump_path: string };
    assert.strictEqual(payload.baseline_dump_path, baseline.fsPath);
    assert.strictEqual(payload.comparison_dump_path, comparison.fsPath);
    const html = panelSpy.created[0]?.webview.html ?? '';
    assert.ok(html.includes('<h2>Heap Snapshot Diff</h2>'));
    assert.ok(html.includes(severityBadge('medium')), 'medium-severity suspect rendered');
  });

  // ───────────────────────────────────────────────────────────────
  // 14. HeapDiffPanel.open error path: a rejecting client renders the error
  //     page (buildErrorHtml) rather than the diff layout. Also asserts the
  //     buildLoadingHtml and buildErrorHtml outputs directly.
  // ───────────────────────────────────────────────────────────────

  test('HeapDiffPanel.open renders the error page when the diff request rejects', async function () {
    this.timeout(COMMAND_MS);
    panelSpy = spyWebviewPanels();

    await HeapDiffPanel.open(
      '/tmp/base<x>.dmp',
      '/tmp/cmp&y.dmp',
      fakeContext(),
      rejectingClient(new Error('diff sidecar exploded <boom>')),
    );

    assert.strictEqual(panelSpy.created.length, 1, 'open() creates exactly one panel');
    assert.ok(
      panelSpy.titles.some((t) => t.startsWith('Heap Diff #')),
      'panel titled "Heap Diff #n"',
    );
    const html = panelSpy.created[0]?.webview.html ?? '';
    assert.ok(html.includes('<title>Heap Diff — Error</title>'), 'error document shown');
    assert.ok(html.includes('<strong>Heap diff failed:</strong>'));
    assert.ok(html.includes('diff sidecar exploded &lt;boom&gt;'), 'error message HTML-escaped');
    assert.ok(!html.includes('<h2>Heap Snapshot Diff</h2>'), 'no successful diff layout');

    // Direct pure-builder assertions in the same flow.
    const loading = buildLoadingHtml('/a&b.dmp', '/c"d.dmp');
    assert.ok(loading.startsWith('<!DOCTYPE html>'));
    assert.ok(loading.includes('Comparing heap snapshots'));
    assert.ok(loading.includes('/a&amp;b.dmp'), 'loading escapes the baseline path');
    assert.ok(loading.includes('/c&quot;d.dmp'), 'loading escapes the comparison path');

    const errorHtml = buildErrorHtml('bad <input> & "q"');
    assert.ok(errorHtml.includes('bad &lt;input&gt; &amp; &quot;q&quot;'));
    assert.ok(!errorHtml.includes('script-src'), 'error page disallows scripts');

    // buildDiffHtml: zero-suspect + zero-diff scaffolding and sign rules.
    const empty = buildDiffHtml(makeResult(), '/b.dmp', '/c.dmp');
    assert.ok(empty.includes('No leak suspects detected.'));
    assert.ok(empty.includes('<h3>All Growing Types (0)</h3>'));
    const signed = buildDiffHtml(
      makeResult({
        diffs: [makeDiff({ count_delta: -8, size_delta_bytes: 2048, growth_percent: 12.34 })],
      }),
      '/b',
      '/c',
    );
    assert.ok(signed.includes('class="mono neg">-8</td>'), 'negative count delta gets neg class');
    assert.ok(
      signed.includes('class="mono pos">+2.0 KB</td>'),
      'positive size delta gets + and pos',
    );
    assert.ok(
      signed.includes('class="mono pos">+12.3%</td>'),
      'growth percent + sign, one decimal',
    );
  });

  // ───────────────────────────────────────────────────────────────
  // 15. showObjectGraph (gated no-op) + the real promptAndOpenGraph workflow
  //     with a fake resolving client → renders the object-graph summary. Also
  //     covers ObjectGraphPanel.open directly (title + error path).
  // ───────────────────────────────────────────────────────────────

  test('showObjectGraph: gated no-op + promptAndOpenGraph renders the retention summary', async function () {
    this.timeout(COMMAND_MS);

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.showObjectGraph');
    }, 'showObjectGraph command must not throw in the test host');

    const dump = makeDumpFile('graph.dmp');
    const graphResult = {
      nodes: [
        {
          id: '0x1',
          type_name: 'My.Type',
          display_name: 'root',
          size_bytes: 24,
          retained_size_bytes: 24,
          instance_count: 1,
          is_root: true,
          depth: 0,
        },
        {
          id: '0x2',
          type_name: 'Child',
          display_name: 'leaf',
          size_bytes: 8,
          retained_size_bytes: 8,
          instance_count: 1,
          is_root: false,
          depth: 1,
        },
      ],
      edges: [],
      stats: {
        total_nodes_traversed: 2,
        total_edges_traversed: 1,
        max_depth_reached: 1,
        truncated: true,
      },
    };

    // (a) Cancel the open dialog → no panel, no input box.
    panelSpy = spyWebviewPanels();
    stubs = installUiStubs().queueOpenDialog(undefined);
    await promptAndOpenGraph(fakeContext(), resolvingDiffClient(graphResult as never));
    assert.strictEqual(panelSpy.created.length, 0, 'cancelled dump dialog opens no graph');
    assert.strictEqual(stubs.log.inputBoxOptions.length, 0, 'no address prompt after cancel');
    stubs.restore();
    panelSpy.restore();

    // (b) Pick a dump + enter a (padded) address → one graph panel, trimmed addr.
    panelSpy = spyWebviewPanels();
    stubs = installUiStubs().queueOpenDialog([dump]).queueInput('  00007ff8CAFE  ');
    await promptAndOpenGraph(fakeContext(), resolvingDiffClient(graphResult as never));

    assert.strictEqual(panelSpy.created.length, 1, 'graph panel opened on the happy path');
    assert.strictEqual(stubs.log.inputBoxOptions.length, 1, 'address prompt shown once');
    assert.ok(
      panelSpy.titles.some((t) => t.includes('Object Graph: 00007ff8CAFE')),
      'title trimmed',
    );
    const html = panelSpy.created[0]?.webview.html ?? '';
    assert.ok(html.includes('Root: 00007ff8CAFE'), 'trimmed root address echoed');
    assert.ok(!html.includes('  00007ff8CAFE'), 'untrimmed address must not leak');
    assert.ok(html.includes('Nodes: 2, Edges: 1, Max depth: 1'), 'stats line from stats object');
    assert.ok(html.includes('root (My.Type) depth=0'), 'first node line rendered');
    assert.ok(html.includes('leaf (Child) depth=1'), 'second node line rendered');
    assert.ok(html.includes('WARNING: graph truncated'), 'truncated flag surfaces a warning');
  });

  // ───────────────────────────────────────────────────────────────
  // 16. ObjectGraphPanel.open error path: a rejecting client renders the
  //     error document, not the summary <pre> layout.
  // ───────────────────────────────────────────────────────────────

  test('ObjectGraphPanel.open surfaces request errors in the panel', async function () {
    this.timeout(COMMAND_MS);
    panelSpy = spyWebviewPanels();

    await ObjectGraphPanel.open(
      '/tmp/x.dmp',
      'addr-123',
      fakeContext(),
      rejectingClient(new Error('graph boom')),
    );

    assert.strictEqual(panelSpy.created.length, 1, 'one panel created');
    assert.ok(
      panelSpy.titles.some((t) => t.includes('Object Graph: addr-123')),
      'titled by address',
    );
    const html = panelSpy.created[0]?.webview.html ?? '';
    assert.ok(html.includes('Error: graph boom'), 'error message surfaced');
    assert.ok(!html.includes('<pre>'), 'error page does not use the summary layout');
    assert.ok(!html.includes('Nodes:'), 'error page renders no stats line');

    // Interaction 2 — the error page is a PAGE. A bare error string with no
    // document around it renders as unstyled text in the webview, which reads
    // as a rendering failure rather than as a reported error.
    assert.ok(html.length > 0, 'the panel really has content');
    assert.ok(
      /<html|<body|<div/i.test(html),
      `the error page is real markup: ${html.slice(0, 120)}`,
    );
    assert.strictEqual(html.includes('undefined'), false, 'and leaks no undefined into the text');

    // Interaction 3 — [PROFILER-GRAPH] renders a retention graph; a failed
    // request must render NONE of it. A page that shows an error banner above
    // an empty graph invites the user to interpret the emptiness as a result.
    for (const artefact of ['Max depth', 'depth=0', 'Edges:', 'Root:']) {
      assert.strictEqual(
        html.includes(artefact),
        false,
        `the error page must not render '${artefact}' from a request that failed`,
      );
    }

    // Interaction 4 — the panel is still titled by the address that was asked
    // for, so the user can tell WHICH inspection failed when several are open.
    assert.strictEqual(panelSpy.titles.length, 1, 'one title for the one panel');
    const errorTitles: readonly string[] = panelSpy.titles;
    assert.ok(errorTitles[0]?.includes('addr-123'), 'naming the address that failed');
  });

  // ───────────────────────────────────────────────────────────────
  // 17. inspectObject (gated no-op) + analyzeHeap / collectDump (gated no-ops).
  //     Asserts each command is a safe no-op AND covers the counter-webview
  //     HTML builder + counter value formatting directly (buildCounterHtml,
  //     formatCounterValue, escapeHtml) since the live counter panel is built
  //     from the same code paths.
  // ───────────────────────────────────────────────────────────────

  test('inspectObject/analyzeHeap/collectDump are safe no-ops; counter HTML builds correctly', async function () {
    this.timeout(COMMAND_MS);

    for (const cmd of [
      'sharplsp.profiler.inspectObject',
      'sharplsp.profiler.analyzeHeap',
      'sharplsp.profiler.collectDump',
    ]) {
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand(cmd);
      }, `${cmd} must not throw in the test host`);
    }

    // buildCounterHtml: empty placeholder.
    const emptyHtml = buildCounterHtml([]);
    assert.ok(emptyHtml.startsWith('<!DOCTYPE html>'));
    assert.ok(emptyHtml.includes('<title>Live Counters</title>'));
    assert.ok(emptyHtml.includes('Waiting for counter data'));
    assert.ok(emptyHtml.includes('colspan="4"'));
    assert.ok(!emptyHtml.includes('<td class="provider">'), 'no data row when empty');

    // buildCounterHtml: data rows, sorted by provider/name, escaped, formatted.
    const rowsHtml = buildCounterHtml([
      counter({ provider: 'Zeta', name: 'a', display_name: 'Za', value: 2048, unit: 'bytes' }),
      counter({ provider: 'Alpha', name: 'b', display_name: '<n>', value: 1234, unit: 'count' }),
      counter({ provider: 'Alpha', name: 'a', display_name: 'Aa', value: 3.14159, unit: 'ratio' }),
    ]);
    // Byte-unit value is byte-formatted; integer uses locale grouping; fraction → 2dp.
    assert.ok(rowsHtml.includes('<td class="value">2.0 KB</td>'), 'byte counter byte-formatted');
    assert.ok(
      rowsHtml.includes(`<td class="value">${(1234).toLocaleString()}</td>`),
      'int locale grouped',
    );
    assert.ok(rowsHtml.includes('<td class="value">3.14</td>'), 'fraction → two decimals');
    assert.ok(rowsHtml.includes('<td class="name">&lt;n&gt;</td>'), 'display name HTML-escaped');
    // Sort order: Alpha/a < Alpha/b < Zeta/a.
    const idxAa = rowsHtml.indexOf('>Aa<');
    const idxAb = rowsHtml.indexOf('&lt;n&gt;');
    const idxZa = rowsHtml.indexOf('>Za<');
    assert.ok(idxAa !== -1 && idxAb !== -1 && idxZa !== -1, 'all three rows present');
    assert.ok(idxAa < idxAb && idxAb < idxZa, 'counters sorted by provider/name ascending');

    // formatCounterValue branches.
    assert.strictEqual(formatCounterValue(1024, 'BYTES'), '1.0 KB', 'unit casing normalized');
    assert.strictEqual(
      formatCounterValue(1024, 'megabytes'),
      '1.0 KB',
      'substring "byte" routes to bytes',
    );
    assert.strictEqual(formatCounterValue(1000, 'count'), (1000).toLocaleString());
    assert.strictEqual(formatCounterValue(0.5, '%'), '0.50');
    assert.strictEqual(formatCounterValue(42, ''), (42).toLocaleString());

    // escapeHtml + formatBytes/formatDuration tier boundaries.
    assert.strictEqual(
      escapeHtml('<script>"&"</script>'),
      '&lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;',
    );
    assert.strictEqual(escapeHtml("it's fine"), "it's fine", 'single quotes are not escaped');
    assert.strictEqual(formatBytes(1023), '1023 B');
    assert.strictEqual(formatBytes(1024), '1.0 KB');
    assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
    assert.strictEqual(formatDuration(999), '999ms');
    assert.strictEqual(formatDuration(1500), '1.5s');
    assert.strictEqual(formatDuration(90_000), '1m 30s');
  });

  // ───────────────────────────────────────────────────────────────
  // 18. ProfilerStatusBar: drive update() visibility transitions through the
  //     real status-bar item (no throw across visible/hidden toggles).
  // ───────────────────────────────────────────────────────────────

  test('ProfilerStatusBar toggles visibility across session-count updates', async function () {
    this.timeout(COMMAND_MS);
    const ctx = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
    const bar = new ProfilerStatusBar(ctx);
    try {
      assert.strictEqual(ctx.subscriptions.length, 1, 'status bar registers its item');
      const item = ctx.subscriptions[0] as unknown as vscode.StatusBarItem;
      assert.strictEqual(item.command, 'sharplsp.profiler.listProcesses', 'click lists processes');
      assert.strictEqual(item.text, '', 'constructor update(0) leaves text empty');

      bar.update(3);
      assert.strictEqual(item.text, '$(pulse) 3 profiling', 'positive count shows text');
      bar.update(0);
      assert.strictEqual(item.text, '$(pulse) 3 profiling', 'hide() leaves prior text untouched');
      assert.doesNotThrow(() => {
        bar.update(7);
        bar.update(0);
        bar.update(1);
      });
      assert.strictEqual(item.text, '$(pulse) 1 profiling');

      // Interaction 2 — the count is SINGULAR-agnostic but always present, and
      // it is the count the caller passed. [PROFILER-EDITOR-VSCODE] lists the
      // status bar as "show active profiling session count", so a stale number
      // is worse than a hidden bar: it says work is running when it is not.
      bar.update(12);
      const twoDigits: string = item.text;
      assert.strictEqual(twoDigits, '$(pulse) 12 profiling', 'a two-digit count renders in full');
      assert.ok(twoDigits.includes('$(pulse)'), 'and keeps the codicon that identifies it');
      bar.update(1);
      const oneAgain: string = item.text;
      assert.strictEqual(oneAgain, '$(pulse) 1 profiling', 'and drops back to one');

      // Interaction 3 — the item stays CLICKABLE across every transition. A
      // status bar whose command is cleared on hide becomes decorative the
      // first time the session count reaches zero.
      bar.update(0);
      assert.strictEqual(
        item.command,
        'sharplsp.profiler.listProcesses',
        'the click target survives being hidden',
      );
      bar.update(4);
      assert.strictEqual(item.command, 'sharplsp.profiler.listProcesses', 'and being shown again');
      const fourNow: string = item.text;
      assert.strictEqual(fourNow, '$(pulse) 4 profiling', 'with the new count');

      // Interaction 4 — one item, registered once. A status bar that registers
      // per update leaks an item into the bar on every session change.
      assert.strictEqual(ctx.subscriptions.length, 1, 'still exactly one registered disposable');
    } finally {
      for (const d of ctx.subscriptions) d.dispose();
    }
  });
});
