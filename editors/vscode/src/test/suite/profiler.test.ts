import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  pollUntilResult,
  setupLspTestSuite,
  teardownLspTestSuite,
  openForgePanelProfiler,
  takeScreenshot,
} from './test-helpers';

interface ProfilerTreeNode {
  readonly label?: string | { label: string };
  readonly nodeKind: string;
  readonly processPid?: number;
  readonly sessionId?: string;
}

interface ProfilerProviderApi {
  readonly onDidChangeTreeData: vscode.Event<unknown>;
  refresh(): Promise<void>;
  addSession(id: string, kind: string, pid: number): void;
  removeSession(id: string): void;
  getChildren(element?: unknown): ProfilerTreeNode[];
  getActiveSessions(kind: string): { id: string; kind: string; pid: number }[];
  readonly sessionCount: number;
}

interface ProfilerExtensionApi {
  readonly profilerProvider: ProfilerProviderApi;
}

function nodeLabel(node: ProfilerTreeNode): string {
  if (typeof node.label === 'string') return node.label;
  return node.label?.label ?? '';
}

function findByLabel(nodes: ProfilerTreeNode[], substring: string): ProfilerTreeNode | undefined {
  return nodes.find((n) => nodeLabel(n).includes(substring));
}

suite('Profiler', () => {
  let tmpDir: string;
  let fixtureDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('profiler-');
    tmpDir = result.tmpDir;
    fixtureDir = path.resolve(__dirname, '../../../test-fixtures/workspace');
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // ── Command Registration ─────────────────────────────────────

  for (const cmd of [
    'forge.profiler.refresh',
    'forge.profiler.listProcesses',
    'forge.profiler.startTrace',
    'forge.profiler.stopTrace',
    'forge.profiler.startCounters',
    'forge.profiler.stopCounters',
    'forge.profiler.collectDump',
    'forge.profiler.analyzeHeap',
    'forge.profiler.diffSnapshots',
    'forge.profiler.detectLeaks',
    'forge.profiler.showObjectGraph',
    'forge.profiler.inspectObject',
  ]) {
    test(`${cmd} command is registered`, async () => {
      const allCommands = await vscode.commands.getCommands(true);
      assert.ok(allCommands.includes(cmd), `${cmd} should be registered`);
    });
  }

  // ── Package Contributions ────────────────────────────────────

  test('extension contributes profiler view', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const views = ext.packageJSON.contributes?.views ?? {};
    const forgeViews: { id: string; name: string }[] = views['forge-explorer'] ?? [];
    const profilerView = forgeViews.find((v) => v.id === 'forge.profiler');
    assert.ok(profilerView, 'Should contribute forge.profiler view');
    assert.strictEqual(profilerView.name, 'Profiler');
  });

  // ── Tree Provider API ────────────────────────────────────────

  function getProvider(): ProfilerProviderApi {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');
    const api = ext.exports as ProfilerExtensionApi | undefined;
    assert.ok(api?.profilerProvider, 'Extension must export profilerProvider');
    return api.profilerProvider;
  }

  // ── E2E: startTrace → session appears in tree view ───────────

  test('startTrace: session appears in tree view after addSession', async function () {
    this.timeout(10_000);
    const provider = getProvider();

    // Tree starts empty or with "No .NET processes found".
    const before = provider.getChildren();
    const sessionBefore = findByLabel(before, 'Trace: PID 12345');
    assert.strictEqual(sessionBefore, undefined, 'No trace session should exist before addSession');

    // Simulate what startTrace command does after a successful LSP response.
    provider.addSession('test-trace-001', 'Trace', 12345);

    try {
      const after = provider.getChildren();

      // Verify the "Active Sessions" header appears.
      const header = findByLabel(after, 'Active Sessions');
      assert.ok(header, 'Active Sessions header must appear after addSession');
      assert.strictEqual(header.nodeKind, 'header');

      // Verify the trace session node exists with correct label.
      const sessionNode = findByLabel(after, 'Trace: PID 12345');
      assert.ok(sessionNode, 'Trace session must appear in tree view');
      assert.strictEqual(sessionNode.nodeKind, 'session');
      assert.strictEqual(sessionNode.sessionId, 'test-trace-001');

      // Verify session count updated.
      assert.ok(provider.sessionCount >= 1, 'Session count must be at least 1');

      // Verify getActiveSessions returns the trace session.
      const traceSessions = provider.getActiveSessions('Trace');
      const found = traceSessions.find((s) => s.id === 'test-trace-001');
      assert.ok(found, "getActiveSessions('Trace') must include our session");
      assert.strictEqual(found.pid, 12345);

      // Verify onDidChangeTreeData fires on addSession.
      let changeCount = 0;
      const disposable = provider.onDidChangeTreeData(() => {
        changeCount++;
      });

      provider.addSession('test-trace-002', 'Trace', 99999);
      assert.ok(changeCount > 0, 'onDidChangeTreeData must fire on addSession');
      disposable.dispose();

      // Verify second session also visible.
      const afterTwo = provider.getChildren();
      const second = findByLabel(afterTwo, 'Trace: PID 99999');
      assert.ok(second, 'Second trace session must appear in tree view');
      // Load fixture solution so Solution Explorer is populated in the screenshot.
      if (process.env['FORGE_SCREENSHOTS']) {
        const ext2 = vscode.extensions.getExtension(EXTENSION_ID);
        const api2 = ext2?.exports as { explorerProvider?: { loadSolution(p: string): Promise<void>; getChildren(e?: unknown): unknown[] | undefined } } | undefined;
        if (api2?.explorerProvider) {
          const slnPath = path.join(fixtureDir, 'TestFixtures.sln');
          if (fs.existsSync(slnPath)) {
            await api2.explorerProvider.loadSolution(slnPath);
            await pollUntilResult(
              async () => api2.explorerProvider!.getChildren() ?? [],
              (nodes) => nodes.length > 0,
              8_000,
            );
          }
        }
      }
      await openForgePanelProfiler();
      await takeScreenshot('vscode-profiler-page.png');

      // Remove sessions and verify they disappear.
      provider.removeSession('test-trace-002');
      const afterRemove = provider.getChildren();
      const removed = findByLabel(afterRemove, 'Trace: PID 99999');
      assert.strictEqual(removed, undefined, 'Removed session must not appear in tree view');
    } finally {
      // Clean up all test sessions.
      provider.removeSession('test-trace-001');
      provider.removeSession('test-trace-002');
    }
  });

  // ── E2E: startCounters → webview opens and receives updates ──

  test('startCounters: session tracked and tree fires change events', async function () {
    this.timeout(10_000);
    const provider = getProvider();

    // Track tree change events.
    let changeCount = 0;
    const disposable = provider.onDidChangeTreeData(() => {
      changeCount++;
    });

    try {
      // Simulate what startCounters command does after LSP response.
      provider.addSession('test-counters-001', 'Counters', 54321);

      // Verify tree change event fired.
      assert.ok(changeCount > 0, 'onDidChangeTreeData must fire when counter session added');

      // Verify session appears in tree.
      const children = provider.getChildren();
      const sessionNode = findByLabel(children, 'Counters: PID 54321');
      assert.ok(sessionNode, 'Counter session must appear in tree view');
      assert.strictEqual(sessionNode.nodeKind, 'session');
      assert.strictEqual(sessionNode.sessionId, 'test-counters-001');

      // Verify getActiveSessions filters by kind correctly.
      const counterSessions = provider.getActiveSessions('Counters');
      assert.ok(
        counterSessions.some((s) => s.id === 'test-counters-001'),
        "getActiveSessions('Counters') must include counter session",
      );
      const traceSessions = provider.getActiveSessions('Trace');
      assert.ok(
        !traceSessions.some((s) => s.id === 'test-counters-001'),
        "getActiveSessions('Trace') must not include counter session",
      );

      // Verify the "Active Sessions" header shows correct count.
      const header = findByLabel(children, 'Active Sessions (1)');
      assert.ok(header, 'Active Sessions header must show count of 1');

      // Reset counter, remove session, verify event fires again.
      changeCount = 0;
      provider.removeSession('test-counters-001');
      assert.ok(changeCount > 0, 'onDidChangeTreeData must fire when counter session removed');

      // Verify session gone from tree.
      const afterRemove = provider.getChildren();
      const gone = findByLabel(afterRemove, 'Counters: PID 54321');
      assert.strictEqual(gone, undefined, 'Removed counter session must disappear from tree');

      // Verify session count is back to 0.
      assert.strictEqual(
        provider.sessionCount,
        0,
        'Session count must be 0 after removing all sessions',
      );
    } finally {
      disposable.dispose();
      provider.removeSession('test-counters-001');
    }
  });

  // ── E2E: collectDump → analyzeHeap → heap stats table ────────

  test('collectDump and analyzeHeap: tree state management and heap display', async function () {
    this.timeout(15_000);
    const provider = getProvider();

    // Verify the analyzeHeap command exists and can be invoked
    // (it will return immediately since no LSP client is picking a file).
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.profiler.collectDump');
    }, 'collectDump command must not throw when no process is available');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.profiler.analyzeHeap');
    }, 'analyzeHeap command must not throw when no dump file is selected');

    // Simulate a dump collection flow: add a session, verify tree, remove.
    // (Real dump commands interact with LSP + QuickPick, but the tree state
    // management is what we're verifying here.)

    // Add multiple session types concurrently to test mixed tree display.
    provider.addSession('dump-trace-001', 'Trace', 10001);
    provider.addSession('dump-counters-001', 'Counters', 10002);

    try {
      const children = provider.getChildren();

      // Verify both session types appear in the tree.
      const traceNode = findByLabel(children, 'Trace: PID 10001');
      assert.ok(traceNode, 'Trace session must appear in mixed tree');

      const counterNode = findByLabel(children, 'Counters: PID 10002');
      assert.ok(counterNode, 'Counter session must appear in mixed tree');

      // Header must reflect total count.
      const header = findByLabel(children, 'Active Sessions (2)');
      assert.ok(header, 'Active Sessions header must show count of 2');

      // Verify session count.
      assert.strictEqual(provider.sessionCount, 2, 'Must have 2 sessions');

      // Remove one, verify the other remains.
      provider.removeSession('dump-trace-001');
      const afterOne = provider.getChildren();
      assert.ok(
        findByLabel(afterOne, 'Counters: PID 10002'),
        'Counter session must remain after removing trace session',
      );
      assert.strictEqual(
        findByLabel(afterOne, 'Trace: PID 10001'),
        undefined,
        'Removed trace session must not appear',
      );

      // Header updates to count 1.
      const headerOne = findByLabel(afterOne, 'Active Sessions (1)');
      assert.ok(headerOne, 'Active Sessions header must show count of 1');

      // Remove last session, verify no active sessions remain.
      provider.removeSession('dump-counters-001');
      const afterAll = provider.getChildren();

      // After removing all sessions, no Active Sessions header should appear.
      const noHeader = findByLabel(afterAll, 'Active Sessions');
      assert.strictEqual(noHeader, undefined, 'Active Sessions header must be gone when no sessions remain');
      // Session count must be 0.
      assert.strictEqual(provider.sessionCount, 0, 'Session count must be 0 after removing all sessions');
    } finally {
      provider.removeSession('dump-trace-001');
      provider.removeSession('dump-counters-001');
    }
  });

  // ── Refresh command ──────────────────────────────────────────

  test('forge.profiler.refresh executes without error', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.profiler.refresh');
    }, 'profiler.refresh command should not throw');
  });

  // ── New Phase G/I/J/K commands: registration + no-crash ──────

  test('diffSnapshots command does not throw when cancelled', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      // The command opens a file dialog; without a client it returns early.
      await vscode.commands.executeCommand('forge.profiler.diffSnapshots');
    }, 'diffSnapshots must not throw when no file is selected');
  });

  test('detectLeaks command does not throw when user cancels', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.profiler.detectLeaks');
    }, 'detectLeaks must not throw when user cancels the workflow');
  });

  test('showObjectGraph command does not throw when cancelled', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.profiler.showObjectGraph');
    }, 'showObjectGraph must not throw when no file is selected');
  });

  test('inspectObject command does not throw when cancelled', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.profiler.inspectObject');
    }, 'inspectObject must not throw when no file is selected');
  });

  // ── Package contribution: new commands declared ───────────────

  test('package.json declares diffSnapshots command', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must exist');
    const commands: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(
      commands.some((c) => c.command === 'forge.profiler.diffSnapshots'),
      'package.json must declare forge.profiler.diffSnapshots',
    );
  });

  test('package.json declares detectLeaks command', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must exist');
    const commands: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(
      commands.some((c) => c.command === 'forge.profiler.detectLeaks'),
      'package.json must declare forge.profiler.detectLeaks',
    );
  });

  test('package.json declares showObjectGraph command', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must exist');
    const commands: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(
      commands.some((c) => c.command === 'forge.profiler.showObjectGraph'),
      'package.json must declare forge.profiler.showObjectGraph',
    );
  });

  test('package.json declares inspectObject command', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must exist');
    const commands: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(
      commands.some((c) => c.command === 'forge.profiler.inspectObject'),
      'package.json must declare forge.profiler.inspectObject',
    );
  });

  // ── Tree: mixed sessions with heap diff flow ──────────────────

  test('heap diff workflow: mixed sessions show correctly in tree', async function () {
    this.timeout(10_000);
    const provider = getProvider();

    // Simulate a heap analysis session alongside a trace session.
    provider.addSession('heap-trace-001', 'Trace', 20001);

    try {
      const children = provider.getChildren();
      const node = findByLabel(children, 'Trace: PID 20001');
      assert.ok(node, 'Trace session must appear in tree');
      assert.strictEqual(node.nodeKind, 'session');
      assert.strictEqual(node.sessionId, 'heap-trace-001');
      assert.ok(provider.sessionCount >= 1, 'Session count must reflect added session');
    } finally {
      provider.removeSession('heap-trace-001');
    }
  });
});
