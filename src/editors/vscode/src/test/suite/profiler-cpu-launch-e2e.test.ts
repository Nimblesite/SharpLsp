// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: CPU profiling of a program
// launched through the SharpLsp debugger, plus the results panel's builders,
// ported from Basilisk's profiler-cpu-e2e suite onto a .NET debuggee.
//
// Basilisk needed its cooperative in-process sampler for a debug-launched
// program on macOS. The .NET runtime samples any process over EventPipe, so the
// same journeys run on the debugger's own debuggee with no injection.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { delay } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';
import { profilerStatusText } from '@nimblesite/lsp-profiler-ui/out/src/profiler';
import { processesViewState } from '@nimblesite/lsp-profiler-ui/out/src/process-reactivity';
import { recordedOperations } from '@nimblesite/lsp-profiler-ui/out/src/progress-ops';
import {
  appliedProfileDecorations,
  clearProfileDecorations,
  type ProfileResult,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-decorations';
import {
  buildFlamegraphHtml,
  disposeFlamegraphPanel,
  flamegraphPanelOpen,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-flamegraph-html';
import type { ProfileReport } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import * as fs from 'node:fs';
import { State } from 'vscode-languageclient/node';
import { execute, lspClient, profilerStore } from './profiler-kit';
import { comparablePath } from './test-helpers';
import { assertHardened, assertHtml, pollUntilResult } from './profiler-ui-helpers';
import {
  HOT_LINE,
  debuggeePid,
  launch,
  launchConfig,
  showProgram,
  useDebuggee,
  type Debuggee,
} from './profiler-ui-debuggee';
import { SERVER_RESTART_MS } from './test-timeouts';

const SAMPLE_WINDOW_MS = 3_000;
const STEP_MS = 60_000;

/** True when a hot function of `report` lives in the debuggee's source. */
function hasProgramHotFunction(report: ProfileReport, program: string): boolean {
  return report.hot_functions.some(
    (fn) => fn.file !== undefined && comparablePath(fn.file) === comparablePath(program),
  );
}

/** Launch the current file through the real "Run & Profile CPU" command. */
async function runAndProfileCurrentFile(debuggee: Debuggee): Promise<void> {
  await showProgram(debuggee);
  await vscode.commands.executeCommand('sharplsp.profiler.profileCurrentFileCpu');
  await pollUntilResult({
    fn: () => profilerStore().profiler.value.cpu,
    until: (state) => state === 'active',
    timeoutMs: STEP_MS,
    description: 'Run & Profile CPU to start profiling the launched program',
  });
}

suite('CPU profiling — debug-launched end-to-end', () => {
  const { debuggee: built } = useDebuggee('cpu-launch-', async () => {
    if (profilerStore().profiler.value.cpu !== 'idle') {
      await vscode.commands.executeCommand('sharplsp.profiler.profileStop');
    }
    clearProfileDecorations();
    disposeFlamegraphPanel();
  });

  test('OOTB CPU profile of a debug-launched session', async function () {
    this.timeout(STEP_MS * 2);
    const target = built();
    const session = await launch(target, launchConfig(target, 'Debug-launched CPU E2E'));
    const started = await execute<{ session_id: string }>('cpu.start', {
      pid: await debuggeePid(session),
      sample_rate: 100,
    });
    assert.ok(started.session_id.length > 0, 'the attach must mint a session');
    await delay(SAMPLE_WINDOW_MS);
    const report = await execute<ProfileReport>('cpu.stop', { session_id: started.session_id });
    assert.ok(report.total_samples > 0, 'the sampler must collect real ticks from the debuggee');
    assert.ok(
      hasProgramHotFunction(report, target.program),
      `the debuggee's own code must be attributed: ${JSON.stringify(report.hot_functions.slice(0, 5))}`,
    );
    for (const artifact of [report.artifacts.cpuprofile_path, report.artifacts.flamegraph_path]) {
      assert.ok(
        artifact !== undefined && fs.existsSync(artifact),
        `artifact written: ${String(artifact)}`,
      );
    }
  });

  test("one-click 'Run & Profile CPU' is OOTB (#82)", async function () {
    this.timeout(STEP_MS * 2);
    const target = built();
    const opsBefore = recordedOperations().length;
    await runAndProfileCurrentFile(target);
    assert.ok(profilerStatusText() !== undefined, 'the status bar shows the live profile');
    assert.ok(
      processesViewState().message?.includes('Profiling PID') === true,
      `the panel must show the live profile: ${String(processesViewState().message)}`,
    );
    await delay(SAMPLE_WINDOW_MS);

    await vscode.commands.executeCommand('sharplsp.profiler.profileStop');
    const store = profilerStore();
    assert.equal(store.profiler.value.cpu, 'idle', 'stop must clear the reactive store state');
    assert.equal(processesViewState().message, undefined, 'stop must clear the panel chrome');
    const painted = appliedProfileDecorations().filter(
      (entry) => comparablePath(entry.file) === comparablePath(target.program),
    );
    assert.ok(painted.length > 0, 'stop must paint the heat map on the debuggee source');

    const ops = recordedOperations().slice(opsBefore);
    for (const title of ['SharpLsp: Starting CPU profiler', 'SharpLsp: Stopping profiler']) {
      const begin = ops.indexOf(`begin:${title}`);
      const end = ops.indexOf(`end:${title}`);
      assert.ok(begin !== -1, `"${title}" must show progress, ops: ${ops.join(' | ')}`);
      assert.ok(end > begin, `"${title}" progress must close on completion`);
    }
    assert.equal(profilerStatusText(), undefined, 'the status bar must clear after stop');
  });

  test('run → profile → view: the results panel opens on stop with no click, and stays reachable after closing (#145)', async function () {
    this.timeout(STEP_MS * 2);
    const target = built();
    await runAndProfileCurrentFile(target);

    const toasts: { message: string; actions: string[] }[] = [];
    const win = vscode.window as {
      showInformationMessage: typeof vscode.window.showInformationMessage;
    };
    const originalShow = win.showInformationMessage;
    win.showInformationMessage = async (message: string, ...items: unknown[]) => {
      const actions = items.filter((item): item is string => typeof item === 'string');
      toasts.push({ message, actions });
      return undefined;
    };
    disposeFlamegraphPanel();
    try {
      await delay(SAMPLE_WINDOW_MS);
      await vscode.commands.executeCommand('sharplsp.profiler.profileStop');
    } finally {
      win.showInformationMessage = originalShow;
    }

    await pollUntilResult({
      fn: () => flamegraphPanelOpen(),
      until: (open) => open,
      timeoutMs: 5_000,
      description: 'the results panel to open on stop without any click (#145)',
    });
    const completion = toasts.find((toast) => /Profile complete/i.test(toast.message));
    assert.ok(
      completion,
      `a "Profile complete" notification must be shown: ${JSON.stringify(toasts)}`,
    );
    assert.ok(
      completion.actions.length > 0,
      'the "Profile complete" notification must offer a way to reach the raw trace (#145)',
    );

    disposeFlamegraphPanel();
    assert.equal(flamegraphPanelOpen(), false, 'baseline: panel closed before re-entry');
    await vscode.commands.executeCommand('sharplsp.profiler.profileShowResults');
    await pollUntilResult({
      fn: () => flamegraphPanelOpen(),
      until: (open) => open,
      timeoutMs: 5_000,
      description: 'Show Profile Results to re-open the last profile',
    });
    disposeFlamegraphPanel();
  });

  test('live progress survives an LSP client re-creation — the profile never goes silently dead', async function () {
    this.timeout(SERVER_RESTART_MS + STEP_MS * 2);
    const target = built();
    // SharpLsp may restart the same client object or replace it; either way
    // the profiler's progress listener must follow the running one.
    const oldClient = lspClient();
    let stopped = false;
    const watch = oldClient.onDidChangeState((change) => {
      if (change.newState === State.Stopped) stopped = true;
    });
    try {
      await vscode.commands.executeCommand('sharplsp.restartServer');
      await pollUntilResult({
        fn: () => {
          const client = profilerStore().client.value;
          return {
            restarted: client !== oldClient || stopped,
            running: client?.isRunning() === true,
          };
        },
        until: (seen) => seen.restarted && seen.running,
        timeoutMs: SERVER_RESTART_MS,
        description: 'the language client to restart and run again',
      });
    } finally {
      watch.dispose();
    }

    await runAndProfileCurrentFile(target);
    await pollUntilResult({
      fn: () => profilerStatusText() ?? '',
      until: (text) => /[1-9][\d.]* ?K? samples/.test(text),
      timeoutMs: 30_000,
      description: 'the live sample count to reach the status bar after the restart',
    });
    await vscode.commands.executeCommand('sharplsp.profiler.profileStop');
    assert.equal(profilerStore().profiler.value.cpu, 'idle', 'stop must clear the session');
  });

  test('flamegraph webview HTML renders the dashboard from a profile result', () => {
    const program = built().program;
    const result: ProfileResult = {
      sessionId: 's-test',
      duration: 3,
      totalSamples: 600,
      outputFile: '/tmp/profile.speedscope.json',
      hotFunctions: [
        {
          name: 'LoopLeak.Program.Spin',
          file: program,
          line: HOT_LINE - 5,
          samples: 540,
          percentage: 90,
          selfPercentage: 85,
        },
      ],
      hotLines: [{ file: program, line: HOT_LINE, samples: 500, percentage: 83 }],
    };
    const html = buildFlamegraphHtml(result);
    assert.ok(
      html.includes('LoopLeak.Program.Spin'),
      'the profile data (hot functions) must be embedded',
    );
    assert.ok(html.toLowerCase().includes('#e8500a'), 'the heat palette must be used');
    assert.ok(html.includes('navigateToSource'), 'rows must navigate to source');
    assert.ok(html.includes('fn-body'), 'the hot-functions table must render');
    assert.ok(
      html.includes(String(result.totalSamples)),
      'the summary must show the real sample count',
    );
  });

  test("the flamegraph's Speedscope link uses a working import path, not a dead file:// URL", () => {
    const html = buildFlamegraphHtml({
      sessionId: 's-test',
      duration: 3,
      totalSamples: 600,
      outputFile: '/tmp/profile.speedscope.json',
      hotFunctions: [],
      hotLines: [],
    });
    assertHtml(html, { openSpeedscope: 'the Speedscope link must post an openSpeedscope message' });
    assertHtml(
      html,
      { 'speedscope.app/#profileURL=file://': 'never the always-failing speedscope file:// URL' },
      false,
    );
  });

  test('flamegraph HTML escapes untrusted frame names/paths and nonce-gates its inline script', () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    const html = buildFlamegraphHtml({
      sessionId: 's-test',
      duration: 3,
      totalSamples: 600,
      outputFile: '/tmp/profile.speedscope.json',
      hotFunctions: [
        { name: hostile, file: hostile, line: 1, samples: 540, percentage: 90, selfPercentage: 85 },
        {
          name: '<Main>$',
          file: '/app/Program.cs',
          line: 1,
          samples: 60,
          percentage: 10,
          selfPercentage: 10,
        },
      ],
      hotLines: [{ file: hostile, line: 2, samples: 500, percentage: 83 }],
    });
    assertHardened(html, 'the results panel');
    assertHtml(html, {
      'escapeHtml(fn.name)': 'frame names must be escaped before innerHTML',
      'escapeHtml(basename(fn.file))': 'frame file paths must be escaped',
      '<script nonce="': 'the inline script must carry the CSP nonce',
    });
  });
});
