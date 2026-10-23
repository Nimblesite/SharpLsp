// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// CPU profiling, real end-to-end: the SharpLsp server attaches the .NET engine
// to a live `ProfileTarget`, the library's one-click panel flow drives it, and
// the results land as heat-map decorations, a results panel and artifacts on
// disk. Ported from Basilisk's profiler-cpu-e2e suite: the raw pipeline, the
// panel flow, the exited-process classification and the results panel keep
// their assertions; the Python-only cooperative sampler has no .NET analogue.
import { registerCpuCaptureContract } from '@nimblesite/lsp-profiler-ui/out/src/testing/cpu-capture-contract';
import { toProfileResult } from '@nimblesite/lsp-profiler-ui/out/src/wire-adapters';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  appliedProfileDecorations,
  flamegraphPanelOpen,
  profileHasNoUsableData,
  profilerStatusText,
  recordedOperations,
  type ProfileResult,
} from '@nimblesite/lsp-profiler-ui';
import type { ProfileReport } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  execute,
  executeError,
  fixtureSource,
  openSource,
  profileFromRowFor,
  profilingSuite,
  Target,
  uiCommand,
} from './profiler-kit';
import { PROCESS_START_MS } from './test-timeouts';

const SAMPLE_WINDOW_MS = 3_000;
const STOP_MS = 60_000;
const HOT_FUNCTIONS = [
  'SlowJsonParsing',
  'DeepCallStack',
  'StringBuilderAllocation',
  'LockContention',
];

function isHot(report: ProfileReport): boolean {
  return report.hot_functions.some((fn) => HOT_FUNCTIONS.some((name) => fn.name.includes(name)));
}

suite('CPU profiling — real end-to-end', () => {
  const live = profilingSuite('profiler-cpu-', 'ProfileTarget');
  registerCpuCaptureContract(async () => {
    const started = await execute<{ session_id: string }>('cpu.start', { pid: live.target.pid });
    await new Promise(resolve => setTimeout(resolve, SAMPLE_WINDOW_MS));
    return toProfileResult(await execute<ProfileReport>('cpu.stop', { session_id: started.session_id }));
  });

  test('raw pipeline: hot functions attributed to the target, speedscope + .cpuprofile artifacts written and parseable', async function () {
    this.timeout(STOP_MS + SAMPLE_WINDOW_MS);
    const { target } = live;
    const started = await execute<{ session_id: string; runtime: string }>('cpu.start', {
      pid: target.pid,
    });
    assert.equal(started.runtime, 'dotnet');
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_WINDOW_MS));
    const report = await execute<ProfileReport>('cpu.stop', { session_id: started.session_id });
    assert.ok(report.total_samples > 100, `samples: ${report.total_samples}`);
    assert.ok(
      isHot(report),
      `ProfileTarget's workers must be hot: ${report.hot_functions.map((f) => f.name).join(', ')}`,
    );
    assert.ok(
      report.hot_lines.some((line) => line.file.endsWith('Program.cs')),
      'hot lines resolve to the fixture source',
    );
    for (const key of ['speedscope_path', 'cpuprofile_path', 'flamegraph_path'] as const) {
      const file = report.artifacts[key];
      assert.ok(file !== undefined && fs.existsSync(file), `${key} must be written: ${file}`);
    }
    const speedscope = JSON.parse(
      fs.readFileSync(report.artifacts.speedscope_path ?? '', 'utf8'),
    ) as { profiles: unknown[] };
    assert.ok(speedscope.profiles.length > 0, 'speedscope file parses with profiles');
    const cpuprofile = JSON.parse(
      fs.readFileSync(report.artifacts.cpuprofile_path ?? '', 'utf8'),
    ) as { nodes: unknown[] };
    assert.ok(cpuprofile.nodes.length > 0, '.cpuprofile parses with nodes');
  });

  test('panel one-click flow: Profile CPU on a row → live status bar → Stop paints the heat map and opens the results panel', async function () {
    this.timeout(STOP_MS + SAMPLE_WINDOW_MS);
    const { target } = live;
    await openSource(fixtureSource('ProfileTarget'));
    await profileFromRowFor(target.pid, SAMPLE_WINDOW_MS, STOP_MS);
    assert.equal(profilerStatusText(), undefined, 'the status bar hides after stop');
    const applied = appliedProfileDecorations();
    assert.ok(
      applied.some((entry) => entry.file.endsWith('Program.cs')),
      `heat map painted on the fixture source: ${JSON.stringify(applied.map((e) => e.file))}`,
    );
    assert.ok(flamegraphPanelOpen(), 'the results panel opens on stop with no click');
    const operations = recordedOperations();
    assert.ok(
      operations.some((op) => op.startsWith('begin:SharpLsp: Starting CPU profiler')),
      'the start narrates progress',
    );
    assert.ok(
      operations.some((op) => op.startsWith('end:SharpLsp: Stopping profiler')),
      'the stop narrates progress and closes it',
    );
  });

  test('Show Profile Results re-opens the last results after the panel is closed', async function () {
    this.timeout(PROCESS_START_MS);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand(uiCommand('profileShowResults'));
    assert.ok(flamegraphPanelOpen(), 'results stay reachable after closing the panel');
  });

  test('attaching to an exited process fails with a distinct, classified cause', async function () {
    this.timeout(PROCESS_START_MS);
    const victim = await Target.start('ProfileTarget');
    victim.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const error = await executeError('cpu.start', { pid: victim.pid });
    assert.equal(error?.code, -32001, `PROCESS_NOT_FOUND: ${error?.message}`);
  });

  test('a profile with no hotspots is flagged unusable; one with hotspots is not', () => {
    const empty: ProfileResult = {
      sessionId: 's',
      duration: 1,
      totalSamples: 0,
      outputFile: '',
      hotFunctions: [],
      hotLines: [],
    };
    const hot: ProfileResult = {
      ...empty,
      totalSamples: 10,
      hotFunctions: [
        { name: 'f', file: 'a.cs', line: 1, samples: 10, percentage: 100, selfPercentage: 100 },
      ],
    };
    assert.equal(profileHasNoUsableData(empty), true, 'no samples and no hotspots is unusable');
    assert.equal(profileHasNoUsableData(hot), false, 'a hotspot makes the profile usable');
  });
});
