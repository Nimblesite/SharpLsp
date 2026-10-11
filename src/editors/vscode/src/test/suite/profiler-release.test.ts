// Implements [PROFILER-PERFORMANCE] and [PROFILER-PROTOCOL-DUMP-COLLECT].
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { isAbsolutePath, joinPath, resolvePath } from '../../paths.js';
import { buildProcessNode, type ProfilerTreeProvider } from '../../profiler.js';
import { dotnet } from './dotnet-project-kit';
import { recordProgress } from './progress-kit';
import { recordExternalUrls } from './external-url-kit';
import { profilerRequest } from '../../profiler-request.js';
import { installUiStubs } from './ui-stubs';
import {
  EXTENSION_ID,
  pollUntilResult,
  setupLspTestSuite,
  teardownLspTestSuite,
  openSharpLspPanelProfiler,
  takeScreenshot,
} from './test-helpers';
import { ACTIVATION_MS, DOTNET_CLI_MS, LSP_RESPONSE_MS } from './test-timeouts';

interface ProfilerApi {
  readonly profilerProvider: ProfilerTreeProvider;
  getLspClient(): LanguageClient | undefined;
}

suite('Profiler release flows', function () {
  this.timeout(LSP_RESPONSE_MS);
  let tmpDir: string;
  let target: ChildProcess;
  let pid: number;
  let api: ProfilerApi;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-release-'));
    const extension = vscode.extensions.getExtension<ProfilerApi>(EXTENSION_ID);
    assert.ok(extension?.isActive);
    api = extension.exports;
    const fixture = resolvePath(
      extension.extensionPath,
      '../../sharplsp/tests/fixtures/ProfileTarget',
    );
    await dotnet(['build', '-c', 'Release'], fixture);
    target = spawn(
      'dotnet',
      [joinPath(fixture, 'bin', 'Release', 'net10.0', 'ProfileTarget.dll')],
      {
        cwd: tmpDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SHARPLSP_PROFILE_TARGET_PARENT_PID: String(process.pid) },
      },
    );
    let output = '';
    target.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    await pollUntilResult(
      async () => output,
      (text) => text.includes('READY'),
    );
    assert.ok(target.pid);
    pid = target.pid;
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    for (const session of api.profilerProvider
      .getActiveSessions('Trace')
      .filter((s) => s.pid === pid)) {
      await api
        .getLspClient()
        ?.sendRequest('sharplsp/profiler/stopTrace', { session_id: session.id });
      api.profilerProvider.removeSession(session.id);
    }
    target?.kill();
    if (tmpDir !== undefined) teardownLspTestSuite(tmpDir);
  });

  test('dump row shows cancellable progress and cancelling preserves the process', async () => {
    const ui = installUiStubs().queuePick('Heap');
    const cancellation = new vscode.CancellationTokenSource();
    const progress = recordProgress(cancellation.token);
    cancellation.cancel();
    try {
      const row = buildProcessNode({
        pid,
        name: 'ProfileTarget',
        command_line: '',
        runtime_version: 'net10.0',
      });
      await vscode.commands.executeCommand('sharplsp.profiler.dumpProcess', row);
      assert.equal(progress.calls.length, 1, 'dump collection must show progress');
      assert.equal(progress.calls[0]?.options.cancellable, true);
      assert.equal(progress.calls[0]?.options.location, vscode.ProgressLocation.Notification);
      assert.ok(progress.calls[0]?.settledAt);
      assert.deepEqual(ui.log.errorMessages, []);
      assert.deepEqual(ui.log.infoMessages, []);
      assert.equal(target.exitCode, null, 'cancellation must preserve the target');
    } finally {
      progress.restore();
      cancellation.dispose();
      ui.restore();
    }
  });

  test('in-flight cancellation ends progress; a subsequent real dump and heap analysis succeed', async () => {
    const client = api.getLspClient();
    assert.ok(client);
    const cancellation = new vscode.CancellationTokenSource();
    const progress = recordProgress(cancellation.token);
    const onProgress = client.onNotification('$/progress', () => {
      cancellation.cancel();
    });
    const output = joinPath(tmpDir, 'cancelled.dmp');
    try {
      assert.equal(
        await profilerRequest(
          client,
          'sharplsp/profiler/collectDump',
          { pid, output_path: output },
          'Collecting memory dump',
        ),
        undefined,
      );
      assert.ok(cancellation.token.isCancellationRequested, 'the real host reported progress');
      assert.ok(progress.calls[0]?.settledAt, 'cancelled progress settled');
      assert.equal(target.exitCode, null);
    } finally {
      onProgress.dispose();
      progress.restore();
      cancellation.dispose();
    }
    const recovery = recordProgress();
    try {
      const dump = await profilerRequest<{ file_size_bytes: number }>(
        client,
        'sharplsp/profiler/collectDump',
        { pid, output_path: output },
        'Collecting memory dump',
      );
      assert.ok(dump && dump.file_size_bytes > 0);
      const heap = await profilerRequest<{ total_objects: number; total_size_bytes: number }>(
        client,
        'sharplsp/profiler/analyzeHeap',
        { dump_path: output },
        'Analyzing heap dump',
      );
      assert.ok(heap && heap.total_objects > 0 && heap.total_size_bytes > 0);
      assert.equal(recovery.calls.length, 2);
      assert.ok(recovery.calls.every((call) => call.settledAt && call.options.cancellable));
    } finally {
      recovery.restore();
    }
  });

  // [PROFILER-EDITOR-VSCODE-TREE] Real process -> trace row -> stop -> standalone reopen.
  test('process and trace clicks update the live tree and open a real standalone trace', async function () {
    this.timeout(DOTNET_CLI_MS);
    const provider = api.profilerProvider;
    const ui = installUiStubs();
    const external = recordExternalUrls();
    const changes: number[] = [];
    const changed = provider.onDidChangeTreeData(() => changes.push(provider.sessionCount));
    try {
      await provider.refresh();
      const processRow = provider.getChildren().find((row) => row.processPid === pid);
      assert.ok(processRow?.command);
      await vscode.commands.executeCommand(
        processRow.command.command,
        ...(processRow.command.arguments ?? []),
      );
      const row = provider
        .getChildren()
        .find(
          (item) =>
            item.sessionId !== undefined && provider.findSession(item.sessionId)?.pid === pid,
        );
      assert.ok(
        row?.command && row.outputPath && row.sessionId,
        JSON.stringify(ui.log.errorMessages),
      );
      assert.ok(
        isAbsolutePath(row.outputPath),
        'trace output must be usable outside the server working directory',
      );
      assert.ok(changes.includes(1), 'session creation is reactive');
      await openSharpLspPanelProfiler();
      await takeScreenshot('vscode-profiler-page.png');
      await takeScreenshot('vscode-profiler-context-menu.png');
      if (process.env['SHARPLSP_SCREENSHOTS']) {
        await pollUntilResult(
          async () => await vscode.env.clipboard.readText(),
          (text) => text === row.outputPath,
          LSP_RESPONSE_MS,
          100,
          'context-menu copy',
        );
        assert.equal(
          await vscode.env.clipboard.readText(),
          row.outputPath,
          'the real context-menu click copies the trace path',
        );
      }
      await vscode.commands.executeCommand('sharplsp.profiler.copyOutputPath', row);
      assert.equal(await vscode.env.clipboard.readText(), row.outputPath);
      await pollUntilResult(
        async () => (fs.existsSync(row.outputPath!) ? fs.statSync(row.outputPath!).size : 0),
        (size) => size > 0,
        LSP_RESPONSE_MS,
        250,
        'trace data to be written',
      );
      await vscode.commands.executeCommand(row.command.command, ...(row.command.arguments ?? []));
      assert.equal(provider.findSession(row.sessionId), undefined);
      assert.equal(provider.sessionCount, 0);
      assert.ok(changes.includes(0), 'session removal is reactive');
      assert.equal(external.captured.length, 1);
      assert.equal(external.captured[0]?.authority, 'www.speedscope.app');
      ui.queueOpenDialog([vscode.Uri.file(row.outputPath)]);
      await vscode.commands.executeCommand('sharplsp.profiler.openTrace');
      assert.equal(external.captured.length, 2);
      assert.equal(external.captured[1]?.toString(), external.captured[0]?.toString());
      assert.deepEqual(ui.log.errorMessages, []);
    } finally {
      changed.dispose();
      external.restore();
      ui.restore();
    }
  });
});
