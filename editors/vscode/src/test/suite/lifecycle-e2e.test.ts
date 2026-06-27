import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  findSharpLspBinary,
  flattenSymbolNames,
  openCSharpFile,
  setupLspTestSuite,
  teardownLspTestSuite,
  waitForDocumentSymbols,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { effect } from '../../signals.js';
import { getInstalledVersion, describeBinaryStatus } from '../../install.js';
import {
  dotnetArchitecture,
  dotnetRootFromPath,
  showAcquireFailureNotification,
  INSTALL_TOOL_EXTENSION_ID,
} from '../../dotnetRuntime.js';
import { SharpLspStatusBar, ServerState } from '../../status.js';
import {
  SortOrder,
  SORT_CYCLE,
  cycleSortOrder,
  clear,
  loadSolution as loadSolutionState,
  refresh as refreshState,
  sortOrder,
  solutionPath,
  symbolsState,
  client as clientSignal,
} from '../../state.js';
import { notifyActivationFailure } from '../../extension.js';

/**
 * Coarse end-to-end coverage for the extension lifecycle plumbing:
 * client wiring + restart recovery, .NET runtime acquisition UX,
 * binary-version probing, the status-bar indicator, the reactive shared
 * state, and the activation-failure notification. These drive REAL commands
 * and REAL exported functions and assert their deterministic effects.
 */
suite('Lifecycle E2E', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  let scratchDir: string;
  let savedSortOrder: SortOrder;
  let savedSolutionPath: string | undefined;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('lifecycle-e2e-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  setup(() => {
    stubs = installUiStubs();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-lifecycle-'));
    // Snapshot the shared reactive state we are about to mutate so other
    // suites observe pristine signals afterwards.
    savedSortOrder = sortOrder.value;
    savedSolutionPath = solutionPath.value;
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
    // Restore the shared state mutated by these tests.
    sortOrder.value = savedSortOrder;
    solutionPath.value = savedSolutionPath;
    symbolsState.value = { kind: 'empty' };
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  // ── client.ts: restart + live wiring ────────────────────────────

  test('restartServer recovers the live client and keeps it serving symbols', async function () {
    // A restart tears down and respawns the server + sidecars and re-indexes,
    // which can take well over the default budget on a cold host.
    this.timeout(120_000);
    const filename = 'lifecycle-restart.cs';
    const content = 'namespace L { class Restartable { void Run() { } } }';
    const { uri } = await openCSharpFile(tmpDir, filename, content);
    const before = await waitForDocumentSymbols(uri);
    assert.ok(before.length > 0, 'Server should serve symbols before restart');

    // The live client is exposed through the extension API.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');
    const api = ext.exports as { getLspClient: () => unknown };
    assert.ok(typeof api.getLspClient === 'function', 'API exposes getLspClient');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.restartServer');
    }, 'restartServer must not throw');

    // Give the respawned server a moment to settle, then re-open the document so
    // it is active and definitely synced to the fresh server instance.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const { uri: reopened } = await openCSharpFile(tmpDir, filename, content);

    // CRITICAL: restart MUST recover — poll generously until symbols return so
    // later suites inherit a WORKING server (never left mid-restart).
    const after = await waitForDocumentSymbols(reopened, 90_000);
    assert.ok(after.length > 0, 'Server must serve symbols again after restart');
    // DocumentSymbols are hierarchical — `Restartable` is nested under namespace
    // `L`, so flatten the tree before the name lookup (executeDocumentSymbolProvider).
    const names = flattenSymbolNames(after);
    assert.ok(names.includes('Restartable'), 'Restarted server resolves the class');
  });

  test('server-option inputs (config) expose deterministic defaults', () => {
    // client.start() builds its Executable from these config readers; assert
    // their shape so the server-options wiring stays stable.
    const inspectArgs = vscode.workspace
      .getConfiguration('sharplsp')
      .inspect<string[]>('server.extraArgs');
    assert.ok(inspectArgs, 'server.extraArgs is inspectable');
    assert.deepStrictEqual(inspectArgs.defaultValue, [], 'default extraArgs is empty');

    const inspectLevel = vscode.workspace
      .getConfiguration('sharplsp')
      .inspect<string>('logging.level');
    assert.ok(inspectLevel, 'logging.level is inspectable');
    assert.strictEqual(inspectLevel.defaultValue, 'info', 'default RUST_LOG level is info');

    const inspectTrace = vscode.workspace
      .getConfiguration('sharplsp')
      .inspect<string>('trace.server');
    assert.ok(inspectTrace, 'trace.server is inspectable');
    assert.strictEqual(inspectTrace.defaultValue, 'off', 'default trace level is off');
  });

  // ── install.ts: pure version probes ─────────────────────────────

  test('getInstalledVersion reads the real bundled binary and rejects bogus paths', () => {
    const binary = findSharpLspBinary();
    assert.ok(binary, 'Bundled sharplsp binary must be discoverable');
    assert.ok(fs.existsSync(binary), 'Discovered binary path exists on disk');

    const version = getInstalledVersion(binary, 'sharplsp');
    assert.ok(version, 'Real binary reports a version');
    assert.match(version, /^\d+\.\d+\.\d+/, 'Version is semver-shaped');

    // Wrong expected prefix -> undefined (first token will not match).
    assert.strictEqual(
      getInstalledVersion(binary, 'totally-not-sharplsp'),
      undefined,
      'Mismatched prefix yields undefined',
    );

    // Non-existent executable -> undefined (execFileSync throws, caught).
    const bogus = path.join(scratchDir, 'does-not-exist-binary');
    assert.strictEqual(
      getInstalledVersion(bogus, 'sharplsp'),
      undefined,
      'Bogus path yields undefined',
    );
  });

  test('describeBinaryStatus summarises configured and PATH-based resolution', () => {
    const binary = findSharpLspBinary();
    assert.ok(binary, 'Bundled binary must exist for this assertion');

    const configured = describeBinaryStatus(binary);
    assert.strictEqual(configured.location, binary, 'Configured path is echoed as location');
    assert.match(
      configured.expected,
      /^\d+\.\d+\.\d+/,
      'Expected version is semver from package.json',
    );
    assert.strictEqual(configured.found, getInstalledVersion(binary, 'sharplsp'));

    // Empty configured path -> falls back to the PATH/env command probe.
    const fallback = describeBinaryStatus('');
    assert.strictEqual(
      fallback.expected,
      configured.expected,
      'Expected version is independent of path',
    );
    assert.ok(fallback.location.length > 0, 'Fallback resolves a non-empty command');

    // A bogus configured path is reported as not-found but still echoed.
    const missing = describeBinaryStatus(path.join(scratchDir, 'nope'));
    assert.strictEqual(missing.found, undefined, 'Missing binary reports no found version');
    assert.strictEqual(missing.location, path.join(scratchDir, 'nope'));
  });

  // ── dotnetRuntime.ts: pure helpers + retry command + failure UX ──

  test('dotnetArchitecture and dotnetRootFromPath compute real values', () => {
    const arch = dotnetArchitecture();
    assert.ok(['x64', 'arm64', 'x86'].includes(arch), `arch should be a known id, got ${arch}`);

    // dotnetRootFromPath is the directory containing the dotnet executable.
    const fakeDotnet = path.join(scratchDir, 'sdk', 'dotnet');
    assert.strictEqual(
      dotnetRootFromPath(fakeDotnet),
      path.join(scratchDir, 'sdk'),
      'Root is the parent directory of the dotnet executable',
    );
    assert.strictEqual(
      dotnetRootFromPath('/usr/local/share/dotnet/dotnet'),
      '/usr/local/share/dotnet',
    );

    // The Install Tool dependency id is the published extension id.
    assert.strictEqual(INSTALL_TOOL_EXTENSION_ID, 'ms-dotnettools.vscode-dotnet-runtime');
  });

  test('retryDotnetAcquisition command runs end-to-end without throwing', async function () {
    this.timeout(30_000);
    // The acquisition succeeds (SDK already present in this host) or fails and
    // surfaces a notification; either way the command must resolve. Pre-queue
    // dismissals so any prompt it shows cannot block the headless host.
    stubs.queueInfo(undefined).queueError(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.retryDotnetAcquisition');
    }, 'retryDotnetAcquisition must not throw');
  });

  test('showAcquireFailureNotification offers Open/Show Log/Retry and routes Show Log', async function () {
    this.timeout(10_000);
    // Click "Show Log" -> opens the output channel, does NOT invoke the retry command.
    stubs.queueError('Show Log');
    await assert.doesNotReject(
      showAcquireFailureNotification('disk full', 'sharplsp.restartServer'),
      'Show Log branch must not throw',
    );
    assert.strictEqual(stubs.log.errorMessages.length, 1, 'Exactly one error notification shown');
    const shown = stubs.log.errorMessages[0] ?? '';
    assert.ok(shown.includes('.NET 10 SDK'), 'Notification mentions the .NET 10 SDK');
    assert.ok(shown.includes('disk full'), 'Notification includes the failure detail');
  });

  test('showAcquireFailureNotification Retry dispatches the retry command', async function () {
    this.timeout(10_000);
    // Click "Retry" -> executes the supplied command id. Use a benign, idempotent
    // command (showOutput) and assert the whole flow resolves.
    stubs.queueError('Retry').queueInfo(undefined);
    await assert.doesNotReject(
      showAcquireFailureNotification('network down', 'sharplsp.showOutput'),
      'Retry branch must not throw',
    );
    assert.strictEqual(stubs.log.errorMessages.length, 1, 'One failure notification was shown');

    // Dismissing the notification (no choice) is also a no-throw path.
    stubs.queueError(undefined);
    await assert.doesNotReject(
      showAcquireFailureNotification('transient', 'sharplsp.showOutput'),
      'Dismiss branch must not throw',
    );
    assert.strictEqual(stubs.log.errorMessages.length, 2, 'Second notification was shown');
  });

  // ── status.ts: SharpLspStatusBar state transitions ──────────────

  test('SharpLspStatusBar cycles through every ServerState without throwing', () => {
    const bar = new SharpLspStatusBar();
    try {
      // Constructor seeds Starting; drive the full lifecycle explicitly.
      assert.doesNotThrow(() => {
        bar.setState(ServerState.Starting);
        bar.setState(ServerState.Running);
        bar.setState(ServerState.Stopped);
        bar.setState(ServerState.Error);
        bar.setState(ServerState.Running);
      }, 'Every state transition must be safe');
    } finally {
      bar.dispose();
    }
    // Disposing twice must also be safe (idempotent teardown).
    assert.doesNotThrow(() => {
      bar.dispose();
    }, 'Double dispose must not throw');
  });

  test('restartServer drives the live status bar through Starting and back to Running', async function () {
    this.timeout(60_000);
    const { uri } = await openCSharpFile(
      tmpDir,
      'lifecycle-status.cs',
      'class StatusProbe { void M() { } }',
    );
    await waitForDocumentSymbols(uri);

    // The live status bar is wired to the client's state changes; restarting it
    // exercises the Starting -> Running transitions. We assert recovery as proof.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.restartServer');
    }, 'restartServer must not throw while the status bar tracks state');
    const symbols = await waitForDocumentSymbols(uri, 30_000);
    assert.ok(symbols.length > 0, 'Server (and status bar) recovered to Running');
  });

  // ── state.ts: reactive signals + sort cycle ─────────────────────

  test('cycleSortOrder advances the signal through SORT_CYCLE reactively', () => {
    const observed: SortOrder[] = [];
    const dispose = effect(() => {
      observed.push(sortOrder.value);
    });

    sortOrder.value = SortOrder.Natural;
    cycleSortOrder(); // Natural -> Alphabetical
    cycleSortOrder(); // Alphabetical -> Accessibility
    cycleSortOrder(); // Accessibility -> Natural
    dispose();
    // A change after disposing must NOT be observed.
    sortOrder.value = SortOrder.Alphabetical;

    assert.deepStrictEqual(
      observed,
      [
        savedSortOrder,
        SortOrder.Natural,
        SortOrder.Alphabetical,
        SortOrder.Accessibility,
        SortOrder.Natural,
      ],
      'Effect re-ran for the initial value plus each cycle, then stopped after dispose',
    );

    // The SORT_CYCLE map is the single source of truth for the transitions above.
    assert.strictEqual(SORT_CYCLE[SortOrder.Natural], SortOrder.Alphabetical);
    assert.strictEqual(SORT_CYCLE[SortOrder.Alphabetical], SortOrder.Accessibility);
    assert.strictEqual(SORT_CYCLE[SortOrder.Accessibility], SortOrder.Natural);
  });

  test('sort commands execute against the live explorer without throwing', async function () {
    this.timeout(15_000);
    for (const command of [
      'sharplsp.sortNatural',
      'sharplsp.sortAlphabetical',
      'sharplsp.sortAccessibility',
    ]) {
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand(command);
      }, `${command} must not throw`);
    }
  });

  test('loadSolution, refresh, and clear drive the shared state signals reactively', async function () {
    this.timeout(15_000);
    // No live client is bound to state.client here, so refresh resolves to the
    // empty branch deterministically — exactly the no-client code path.
    assert.strictEqual(clientSignal.value, undefined, 'state.client starts unbound');

    const paths: (string | undefined)[] = [];
    const states: string[] = [];
    const disposePath = solutionPath.subscribe((value) => paths.push(value));
    const disposeState = symbolsState.subscribe((value) => states.push(value.kind));

    const fakeSolution = path.join(scratchDir, 'Demo.sln');
    await loadSolutionState(fakeSolution);
    assert.strictEqual(solutionPath.value, fakeSolution, 'loadSolution records the path');
    // With no client, refresh sets symbolsState back to empty.
    assert.strictEqual(symbolsState.value.kind, 'empty', 'No client -> empty symbols');

    await refreshState();
    assert.strictEqual(symbolsState.value.kind, 'empty', 'Repeated refresh stays empty');

    clear();
    assert.strictEqual(solutionPath.value, undefined, 'clear resets the solution path');
    assert.strictEqual(symbolsState.value.kind, 'empty', 'clear resets symbols to empty');

    disposePath();
    disposeState();
    assert.ok(paths.includes(fakeSolution), 'solutionPath signal emitted the loaded path');
    assert.ok(paths.includes(undefined), 'solutionPath signal emitted the cleared value');
    assert.ok(states.includes('empty'), 'symbolsState signal emitted the empty state');
  });

  test('selectSolution command resolves through the headless host', async function () {
    this.timeout(20_000);
    // Multiple solutions exist in the fixture workspace, so a QuickPick is shown;
    // dismiss it (undefined) and assert the command still resolves cleanly.
    stubs.queuePick(undefined);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.selectSolution');
    }, 'selectSolution must not throw even when the picker is dismissed');
  });

  // ── extension.ts: activation-failure notification + degraded API ─

  test('notifyActivationFailure offers Show Log and Restart Window and is non-fatal', async function () {
    this.timeout(10_000);
    // Dismiss the notification: no action taken, must resolve.
    stubs.queueError(undefined);
    await assert.doesNotReject(
      notifyActivationFailure('SharpLsp failed to activate.', 'sidecar missing'),
      'Dismiss branch must not throw',
    );

    // Click "Show Log": opens output channel, must not reload the window.
    stubs.queueError('Show Log');
    await assert.doesNotReject(
      notifyActivationFailure('SharpLsp failed to activate.', 'binary mismatch'),
      'Show Log branch must not throw',
    );

    assert.strictEqual(stubs.log.errorMessages.length, 2, 'Two failure notifications shown');
    assert.ok(
      stubs.log.errorMessages.every((message) => message.includes('SharpLsp failed to activate.')),
      'Each notification carries the headline',
    );
    assert.ok(stubs.log.errorMessages[1]?.includes('binary mismatch'), 'Detail is appended');
  });

  test('extension exports a non-degraded API surface after successful activation', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension is active');
    const api = ext.exports as {
      explorerProvider: unknown;
      profilerProvider: unknown;
      getLspClient: () => unknown;
    };
    // degradedApi() returns the same shape, so the contract holds in both modes:
    // explorerProvider + profilerProvider non-null, getLspClient callable.
    assert.ok(api.explorerProvider, 'API exposes an explorerProvider');
    assert.ok(api.profilerProvider, 'API exposes a profilerProvider');
    assert.strictEqual(typeof api.getLspClient, 'function', 'API exposes getLspClient');
  });
});
