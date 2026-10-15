// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: the memory autopilot, ported from
// Basilisk's memory-autopilot-e2e suite onto a .NET debuggee.
//
// The whole point is that the TEST never calls snapshot/diff itself. A real
// SharpLsp debug session runs a real leaking .NET program, the autopilot
// captures by itself, and the assertions read what the user sees: leak
// confidence escalating to HIGH, the purple and leak decorations painted, and
// exactly one leak-action offer. Basilisk escalated at a loop breakpoint on
// Continue; a .NET heap cannot be read while the debugger holds the program
// paused, so .NET escalates on the interval and a pause is never captured
// (lsp-profiler's PROF-MEMORY-MODE, PROF-UI-AUTOPILOT).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { delay } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';
import { activeMemorySession } from '@nimblesite/lsp-profiler-ui/out/src/memory-profiler';
import {
  recordedAutopilotCaptures,
  recordedLeakOffers,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-autopilot';
import { referenceTypeCandidates } from '@nimblesite/lsp-profiler-ui/out/src/memory-ref-picker';
import { lastMemorySnapshot } from '@nimblesite/lsp-profiler-ui/out/src/memory-capture';
import {
  appliedMemoryDecorations,
  clearMemoryDecorations,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-decorations';
import { comparablePath } from './test-helpers';
import { launchConfigOf, pollUntilResult } from './profiler-ui-helpers';
import {
  LEAK_LINES,
  LOOP_LINE,
  debuggeePid,
  launch,
  launchConfig,
  resume,
  setBreakpoints,
  showProgram,
  waitForPause,
  useDebuggee,
  type Debuggee,
} from './profiler-ui-debuggee';

/** The purple memory-allocation palette and the leak-confidence palette. */
const MEMORY_PALETTE = ['#c084fc', '#a78bfa', '#8b5cf6', '#7c3aed'];
const LEAK_PALETTE = ['#ef4444', '#f87171', '#fb923c', '#a78bfa'];
/** How long to let a (wrongly) enabled auto-capture fire before asserting none did. */
const QUIET_SETTLE_MS = 1500;
/** Budget for the autopilot to accumulate captures. */
const AUTO_CAPTURE_WAIT_MS = 40_000;

/** Profiler config keys this suite toggles; reset to default after each test. */
const CONFIG_KEYS = ['autoSnapshotOnPause', 'autoSnapshot', 'autoSnapshotInterval'];

async function setProfilerConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration('sharplsp.profiler')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

async function resetProfilerConfig(): Promise<void> {
  for (const key of CONFIG_KEYS) {
    await setProfilerConfig(key, undefined);
  }
}

/** Wait until the autopilot has recorded at least `count` automatic captures. */
async function waitForAutoCaptures(count: number): Promise<void> {
  await pollUntilResult({
    fn: () => recordedAutopilotCaptures().length,
    until: (n) => n >= count,
    timeoutMs: AUTO_CAPTURE_WAIT_MS,
    description: `${count} automatic capture(s)`,
  });
}

/** Whether any recorded capture has escalated to HIGH confidence. */
function sawHighConfidence(): boolean {
  return recordedAutopilotCaptures().some((capture) => capture.maxConfidence === 'HIGH');
}

function onProgram(debuggee: Debuggee): (entry: { file: string }) => boolean {
  return (entry) => comparablePath(entry.file) === comparablePath(debuggee.program);
}

suite('Memory autopilot — real end-to-end', () => {
  const { debuggee: built, recorder } = useDebuggee('mem-autopilot-', async () => {
    await vscode.commands.executeCommand('sharplsp.profiler.memoryStop');
    clearMemoryDecorations();
    await resetProfilerConfig();
  });

  test('the money flow: Run & Track Memory + the interval autopilot escalates a leak to HIGH with no clicks', async function () {
    this.timeout(150_000);
    const target = built();
    await setProfilerConfig('autoSnapshot', true);
    await setProfilerConfig('autoSnapshotInterval', 1);
    await showProgram(target);
    clearMemoryDecorations();
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);

    await launch(target, {
      ...launchConfigOf('memory', target.program),
      program: target.dll,
      args: ['120'],
      cwd: target.project.dir,
      console: 'internalConsole',
    });

    await pollUntilResult({
      fn: () => activeMemorySession(),
      until: (sessionId) => sessionId !== undefined,
      timeoutMs: 45_000,
      description: 'memory tracking to start on launch',
    });
    await pollUntilResult({
      fn: () => sawHighConfidence(),
      until: (high) => high,
      timeoutMs: 90_000,
      description: 'the autopilot to escalate the leak to HIGH',
    });
    assert.ok(
      sawHighConfidence(),
      `the autopilot must escalate the leak to HIGH by itself, got: ${recordedAutopilotCaptures()
        .map((c) => c.maxConfidence)
        .join(' → ')}`,
    );
    const high = recordedAutopilotCaptures().find((capture) => capture.maxConfidence === 'HIGH');
    assert.ok(
      high?.leakLines.some((line) => LEAK_LINES.includes(line)) === true,
      `the HIGH capture must attribute the leaked Widget (lines ${LEAK_LINES.join(', ')}), got: ${JSON.stringify(high)}`,
    );

    const applied = appliedMemoryDecorations().filter(onProgram(target));
    assert.ok(
      applied.some(
        (entry) => LEAK_LINES.includes(entry.line) && MEMORY_PALETTE.includes(entry.color),
      ),
      `the leak site must wear an auto-painted purple track, got: ${JSON.stringify(applied)}`,
    );
    assert.ok(
      applied.some(
        (entry) =>
          LEAK_LINES.includes(entry.line) &&
          LEAK_PALETTE.includes(entry.color) &&
          entry.contentText.includes('HIGH'),
      ),
      `the leak site must wear an auto-painted HIGH leak badge, got: ${JSON.stringify(applied)}`,
    );

    const offers = recordedLeakOffers();
    assert.equal(
      offers.length,
      1,
      `exactly one leak action must be offered, got: ${JSON.stringify(offers)}`,
    );
    const offer = offers[0];
    assert.ok(
      offer !== undefined && (high?.leakLines.includes(offer.line) ?? false),
      `the offer must point at a leak the HIGH capture flagged: ${JSON.stringify(offer)} vs ${JSON.stringify(high)}`,
    );
    assert.equal(offers[0]?.confidence, 'HIGH', 'the offer must carry the HIGH confidence');
  });

  test('pause capture is courier-only: a paused .NET program is never auto-captured, even with autoSnapshotOnPause on', async function () {
    this.timeout(90_000);
    const target = built();
    await setProfilerConfig('autoSnapshotOnPause', true);
    await showProgram(target);
    setBreakpoints(target, [LOOP_LINE]);
    const session = await launch(target, launchConfig(target, 'Autopilot off'));

    await waitForPause(recorder(), 1);
    await vscode.commands.executeCommand(
      'sharplsp.profiler.memoryStart',
      await debuggeePid(session),
    );
    assert.ok(activeMemorySession() !== undefined, 'tracking must start');

    await resume();
    await waitForPause(recorder(), 2);
    await delay(QUIET_SETTLE_MS);

    assert.equal(
      recordedAutopilotCaptures().length,
      0,
      `a heap the debugger holds paused is never auto-captured, got: ${JSON.stringify(recordedAutopilotCaptures())}`,
    );
  });

  test('interval mode: a running program with no breakpoint is auto-captured on a timer', async function () {
    this.timeout(90_000);
    const target = built();
    await setProfilerConfig('autoSnapshotOnPause', false);
    await setProfilerConfig('autoSnapshot', true);
    await setProfilerConfig('autoSnapshotInterval', 1);
    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    await showProgram(target);
    const session = await launch(target, launchConfig(target, 'Autopilot interval'));

    await vscode.commands.executeCommand(
      'sharplsp.profiler.memoryStart',
      await debuggeePid(session),
    );
    assert.ok(activeMemorySession() !== undefined, 'tracking must start on the running program');

    await waitForAutoCaptures(2);
    const captures = recordedAutopilotCaptures();
    assert.ok(
      captures.every((capture) => capture.trigger === 'interval'),
      `every capture must be interval-triggered, got: ${captures.map((c) => c.trigger).join(', ')}`,
    );
  });

  test("reference-graph picker is populated from the real snapshot's own types (no free-text)", async function () {
    this.timeout(90_000);
    const target = built();
    await showProgram(target);
    const session = await launch(target, launchConfig(target, 'Picker'));
    await recorder().waitForOutput('READY');
    await vscode.commands.executeCommand(
      'sharplsp.profiler.memoryStart',
      await debuggeePid(session),
    );
    await vscode.commands.executeCommand('sharplsp.profiler.memorySnapshot');
    const snapshot = await pollUntilResult({
      fn: () => lastMemorySnapshot(),
      until: (snap) => snap !== undefined,
      timeoutMs: 45_000,
      description: 'a memory snapshot',
    });
    assert.ok(snapshot);
    const candidates = referenceTypeCandidates(snapshot);
    assert.ok(
      candidates.some((type) => type.endsWith('Widget')),
      `the picker must offer the program's own leaked type, got: ${candidates.join(', ')}`,
    );
  });
});
