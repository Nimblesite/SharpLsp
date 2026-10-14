// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// The shared profiler UI mounted under SharpLsp's prefix: every client command
// is registered, the server advertises every protocol command and none of the
// UI's, the manifest carries the generated contributions, settings have their
// defaults, and the wire answers bad input with the protocol's error codes.
// Ported from Basilisk's profiler, profiler-memory-integration and
// profiler-ux suites with their assertions kept.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { memoryStatusText, profilerStatusText } from '@nimblesite/lsp-profiler-ui';
import { commandEntries, configProperties, viewIds } from './extension-manifest-kit';
import {
  execute,
  executeError,
  lspClient,
  lspCommand,
  profilerStore,
  uiCommand,
} from './profiler-kit';
import { setupLspTestSuite, teardownLspTestSuite } from './test-helpers';
import { ACTIVATION_MS, LSP_RESPONSE_MS } from './test-timeouts';

const CLIENT_COMMANDS = [
  'profileStart',
  'profileStop',
  'profileSnapshot',
  'profileAttachToDebug',
  'profileShowResults',
  'memoryMenu',
  'memoryStart',
  'memorySnapshot',
  'memoryStop',
  'memoryDiff',
  'memoryGcCollect',
  'memoryReferences',
  'refreshProcesses',
  'sortProcesses',
  'groupProcesses',
  'filterProcesses',
  'profileCurrentFileCpu',
  'trackMemoryCurrentFile',
  'profileProcess',
  'memoryTrackProcess',
  'copyProcessPid',
  'revealProcessScript',
  'killProcess',
].map(uiCommand);

const SERVER_COMMANDS = [
  'capabilities',
  'processes',
  'kill',
  'cpu.start',
  'cpu.stop',
  'cpu.snapshot',
  'cpu.list',
  'memory.start',
  'memory.snapshot',
  'memory.diff',
  'memory.references',
  'memory.objectsByType',
  'memory.gcCollect',
  'memory.stop',
].map(lspCommand);

const SETTINGS: Record<string, unknown> = {
  'profiler.sampleRate': 100,
  'profiler.includeNative': false,
  'profiler.showInlineHeatMap': true,
  'profiler.profileOnLaunch': false,
  'profiler.processRefreshMs': 2000,
  'profiler.preset': 'default',
  'profiler.autoSnapshotOnPause': true,
  'profiler.autoSnapshot': false,
  'profiler.autoSnapshotInterval': 30,
};

suite('Profiler — shared UI registration', () => {
  let tmpDir = '';
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-reg-'));
  });
  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  test('every profiler client command is registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of CLIENT_COMMANDS) {
      assert.ok(registered.has(command), `${command} must be registered`);
    }
  });

  test('the server advertises every protocol command and none of the UI commands', () => {
    const advertised = new Set(
      lspClient().initializeResult?.capabilities.executeCommandProvider?.commands ?? [],
    );
    for (const command of SERVER_COMMANDS) {
      assert.ok(advertised.has(command), `${command} must be advertised`);
    }
    for (const command of CLIENT_COMMANDS) {
      assert.ok(!advertised.has(command), `${command} is a UI command and must not be advertised`);
    }
  });

  test('the server advertises the .NET runtime with direct memory capture', () => {
    const experimental = lspClient().initializeResult?.capabilities.experimental as
      | { lspProfiler?: { runtimes: { id: string; memory?: { mode: { kind: string } } }[] } }
      | undefined;
    const dotnet = experimental?.lspProfiler?.runtimes.find((runtime) => runtime.id === 'dotnet');
    assert.ok(dotnet, 'dotnet runtime advertised');
    assert.equal(dotnet.memory?.mode.kind, 'Direct');
    assert.ok(profilerStore().memoryIsDirect('dotnet'), 'the store reads the capability');
  });

  test('the manifest declares every client command with SharpLsp as its category', () => {
    const declared = new Map(commandEntries().map((entry) => [entry.command, entry]));
    for (const command of CLIENT_COMMANDS) {
      const entry = declared.get(command);
      assert.ok(entry, `${command} must be declared in package.json`);
      assert.equal(entry.category, 'SharpLsp');
      assert.ok((entry.title ?? '').length > 0, `${command} must have a title`);
    }
  });

  test('the processes view and its welcome states are declared', () => {
    assert.ok(viewIds().includes('sharplsp.profiler.processes'));
    const extension = vscode.extensions.getExtension('nimblesite.sharplsp');
    const welcome = (
      extension?.packageJSON as {
        contributes: { viewsWelcome: { view: string; when?: string; contents: string }[] };
      }
    ).contributes.viewsWelcome.filter((entry) => entry.view === 'sharplsp.profiler.processes');
    assert.equal(welcome.length, 5, 'connecting/stopped/loading/error/empty');
    const empty = welcome.find((entry) => entry.contents.includes('No processes running'));
    assert.ok(empty, 'a genuinely-empty welcome must exist');
    assert.ok(
      empty.when?.includes('sharplsp.profiler.processesState == loaded'),
      'empty is gated on a successful fetch',
    );
    assert.ok(
      empty.contents.includes(`command:${uiCommand('profileCurrentFileCpu')}`),
      'the empty state keeps the launches',
    );
    const stopped = welcome.find((entry) => entry.contents.includes('not running'));
    assert.ok(
      stopped?.contents.includes('command:sharplsp.restartServer'),
      'the stopped state offers a restart',
    );
  });

  test('profiler settings are declared with their defaults', () => {
    const properties = configProperties();
    const config = vscode.workspace.getConfiguration('sharplsp');
    for (const [key, expected] of Object.entries(SETTINGS)) {
      assert.ok(properties[`sharplsp.${key}`], `sharplsp.${key} must be declared`);
      assert.deepEqual(config.get(key), expected, key);
    }
    assert.deepEqual(properties['sharplsp.profiler.preset']?.enum, [
      'default',
      'quick',
      'detailed',
      'longRunning',
    ]);
  });

  test('status bars start hidden and the store is idle', () => {
    const session = profilerStore().profiler.value;
    assert.equal(session.cpu, 'idle');
    assert.equal(session.memory, 'idle');
    assert.equal(profilerStatusText(), undefined);
    assert.equal(memoryStatusText(), undefined);
  });
});

suite('Profiler — wire lifecycle errors', () => {
  let tmpDir = '';
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-wire-'));
  });
  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  test('cpu.start rejects a dead PID as PROCESS_NOT_FOUND', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const error = await executeError('cpu.start', { pid: 999_999 });
    assert.equal(error?.code, -32001, error?.message ?? 'no error');
    assert.ok(!(error?.message ?? '').includes('    at '), 'no raw stack traces reach the user');
  });

  test('cpu.start on a non-.NET process is UNSUPPORTED_RUNTIME', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const error = await executeError('cpu.start', { pid: process.pid });
    assert.equal(error?.code, -32002, error?.message ?? 'no error');
  });

  test('cpu.stop and cpu.snapshot reject an unknown session', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.equal((await executeError('cpu.stop', { session_id: 'nope' }))?.code, -32000);
    assert.equal((await executeError('cpu.snapshot', { session_id: 'nope' }))?.code, -32000);
  });

  test('missing parameters are INVALID_PARAMS', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.equal((await executeError('cpu.stop', {}))?.code, -32602);
    assert.equal((await executeError('cpu.start', {}))?.code, -32602);
  });

  test('cpu.list is empty and stable when nothing runs', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const first = await execute<{ sessions: unknown[] }>('cpu.list', {});
    const second = await execute<{ sessions: unknown[] }>('cpu.list', {});
    assert.deepEqual(first.sessions, []);
    assert.deepEqual(second.sessions, []);
  });

  test('memory steps without a session are rejected, not hung', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const error = await executeError('memory.snapshot', { memory_session_id: 'mem-none' });
    assert.equal(error?.code, -32000, error?.message ?? 'no error');
  });
});
