// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: the memory autopilot, ported from
// Basilisk's memory-autopilot-e2e suite onto a .NET debuggee.
//
// The whole point is that the TEST never calls snapshot/diff itself. A real
// SharpLsp debug session runs a real leaking .NET program, the autopilot
// captures by itself, and the assertions read what the user sees: leak
// confidence escalating to HIGH, the memory and leak decorations painted, and
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
  type LeakActionOffer,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-autopilot';
import { referenceTypeCandidates } from '@nimblesite/lsp-profiler-ui/out/src/memory-ref-picker';
import {
  isMemoryOperationInFlight,
  lastMemorySnapshot,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-capture';
import {
  appliedMemoryDecorations,
  clearMemoryDecorations,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-decorations';
import { fileNameOf } from '../../paths';
import type { DapRecorder } from './debug-dap-kit';
import { comparablePath } from './test-helpers';
import { LEAK_PALETTE, MEMORY_PALETTE } from './profiler-fsharp-kit';
import { setProfilerSetting } from './profiler-kit';
import { launchConfigOf, pollUntilResult } from './profiler-ui-helpers';
import {
  LEAK_LINES,
  LOOP_LINE,
  debuggeePid,
  endSessions,
  launch,
  launchConfig,
  resume,
  setBreakpoints,
  showProgram,
  waitForPause,
  useDebuggee,
  type Debuggee,
} from './profiler-ui-debuggee';

/** How long to let a (wrongly) enabled auto-capture fire before asserting none did. */
const QUIET_SETTLE_MS = 1500;
/** Budget for the autopilot to accumulate captures. */
const AUTO_CAPTURE_WAIT_MS = 40_000;

/**
 * Budget for a held capture to let go once it is released. The stuck capture
 * this guards against sat out the engine's 90 s SessionRun deadline, and
 * starved the next session's autopilot meanwhile (lspkit [PROF-MEMORY-STOP]);
 * a released capture answers within a round trip, or a capture's own length.
 */
const RELEASE_MS = 15_000;
/** Poll step while racing a capture, which takes about a second. */
const IN_FLIGHT_POLL_MS = 5;
/**
 * How long a paused capture must stay in flight to count as held: twice the
 * second a whole capture takes, so one that merely finished late cannot pass.
 */
const HOLD_MS = 2_000;

/** Profiler config keys this suite toggles; reset to default after each test. */
const CONFIG_KEYS = ['autoSnapshotOnPause', 'autoSnapshot', 'autoSnapshotInterval'];

const setProfilerConfig = setProfilerSetting;

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

/**
 * The offer names its leak by what the runtime reported (its type, its source
 * line, or both) and never by an empty location: every run offered "Suspected
 * memory leak at :0" for the leaked byte[] (lspkit [PROF-UI-AUTOPILOT]).
 */
function assertOfferNamesItsLeak(offer: LeakActionOffer, debuggee: Debuggee): void {
  const shown = JSON.stringify(offer);
  assert.ok(
    !offer.message.includes(' :0') && !offer.message.includes(' at :'),
    `no empty location: ${shown}`,
  );
  assert.ok(offer.typeName !== '' || offer.line > 0, `the offer names a type or a line: ${shown}`);
  if (offer.typeName !== '')
    assert.ok(offer.message.includes(offer.typeName), `it names its type: ${shown}`);
  if (offer.line === 0) return;
  assert.ok(LEAK_LINES.includes(offer.line), `a located offer points at the leak: ${shown}`);
  assert.equal(
    comparablePath(offer.file),
    comparablePath(debuggee.program),
    `in the program: ${shown}`,
  );
  const at = `${fileNameOf(debuggee.program)}:${offer.line}`;
  assert.ok(offer.message.includes(at), `it names ${at}: ${shown}`);
}

/** Interval mode on, with no breakpoint to hold the program. */
async function useIntervalMode(target: Debuggee): Promise<void> {
  await setProfilerConfig('autoSnapshotOnPause', false);
  await setProfilerConfig('autoSnapshot', true);
  await setProfilerConfig('autoSnapshotInterval', 1);
  vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  await showProgram(target);
}

/** Start tracking `pid` and confirm it took. */
async function track(pid: number, what: string): Promise<void> {
  await vscode.commands.executeCommand('sharplsp.profiler.memoryStart', pid);
  assert.ok(activeMemorySession() !== undefined, `${what}: tracking must start`);
}

/** A launched debuggee: its debug session and its process. */
interface Launched {
  readonly session: vscode.DebugSession;
  readonly pid: number;
}

/** A fresh launch of `target`, tracked on the interval. */
async function launchTracked(target: Debuggee, name: string): Promise<Launched> {
  const session = await launch(target, launchConfig(target, name));
  const pid = await debuggeePid(session);
  await track(pid, name);
  return { session, pid };
}

/**
 * Wait for the autopilot's first capture, then for the next one to be mid-flight:
 * the moment CI's teardown stopped a session ([PROF-UI-AUTOPILOT]).
 */
async function waitForCaptureInFlight(): Promise<void> {
  await waitForAutoCaptures(1);
  await pollUntilResult({
    fn: () => isMemoryOperationInFlight(),
    until: (busy) => busy,
    timeoutMs: AUTO_CAPTURE_WAIT_MS,
    intervalMs: IN_FLIGHT_POLL_MS,
    description: 'an automatic capture in flight',
  });
}

/**
 * Pause the program while an automatic capture is mid-read. A .NET runtime the
 * debugger holds cannot answer it, so the capture stays in flight for as long
 * as the pause lasts: the step CI's teardown caught, held open on purpose
 * rather than by timing. Returns how many captures were recorded before it.
 */
async function holdCapture(recorder: DapRecorder): Promise<number> {
  await waitForCaptureInFlight();
  const recorded = recordedAutopilotCaptures().length;
  await vscode.commands.executeCommand('workbench.action.debug.pause');
  await waitForPause(recorder, 1);
  await delay(HOLD_MS);
  assert.ok(isMemoryOperationInFlight(), 'the capture the pause holds is still in flight');
  assert.equal(recordedAutopilotCaptures().length, recorded, 'and has recorded nothing yet');
  return recorded;
}

/** The held capture has answered, and tracking stopped. Spec: lspkit [PROF-MEMORY-STOP]. */
async function assertStopped(what: string): Promise<void> {
  await pollUntilResult({
    fn: () => isMemoryOperationInFlight() || activeMemorySession() !== undefined,
    until: (held) => !held,
    timeoutMs: RELEASE_MS,
    description: `${what}: the held capture to answer and tracking to stop`,
  });
  assert.equal(isMemoryOperationInFlight(), false, `${what}: no capture is left in flight`);
  assert.equal(activeMemorySession(), undefined, `${what}: tracking has stopped`);
}

/** The held capture finished and was recorded, and tracking carried on. */
async function assertHeldCaptureRecorded(what: string, recorded: number): Promise<void> {
  await pollUntilResult({
    fn: () => recordedAutopilotCaptures().length,
    until: (count) => count > recorded,
    timeoutMs: RELEASE_MS,
    description: `${what}: the held capture to finish`,
  });
  const held = recordedAutopilotCaptures()[recorded];
  assert.equal(held?.trigger, 'interval', `${what}: the held capture is the interval's`);
  assert.ok(activeMemorySession() !== undefined, `${what}: tracking carries on`);
}

/** Whether process `pid` is still running. */
function isRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** The autopilot captures twice more on the interval after `from`, within its usual budget. */
async function assertAutopilotResumes(what: string, from: number): Promise<void> {
  await waitForAutoCaptures(from + 2);
  const captures = recordedAutopilotCaptures().slice(from);
  assert.ok(captures.length >= 2, `${what}: two captures, got ${captures.length}`);
  assert.ok(
    captures.every((capture) => capture.trigger === 'interval'),
    `${what}: every capture is interval-triggered, got: ${captures.map((c) => c.trigger).join(', ')}`,
  );
}

/** How a test lets go of a capture the pause holds. */
interface Release {
  readonly what: string;
  /** Whether the debuggee survives the release. */
  readonly survives: boolean;
  /** Whether tracking carries on through the release. */
  readonly keepsTracking: boolean;
  readonly release: () => Promise<void>;
}

/**
 * Hold a tracked `target`'s capture with a pause, then let go of it by
 * `release`: the capture answers, the program lives or dies as the release
 * says, and tracking — carried on, picked up again, or of a fresh launch —
 * captures within the usual budget.
 */
async function releaseHeldCapture(
  target: Debuggee,
  recorder: DapRecorder,
  release: Release,
): Promise<void> {
  await useIntervalMode(target);
  const first = await launchTracked(target, `Held: ${release.what}`);
  const recorded = await holdCapture(recorder);
  await release.release();
  if (release.keepsTracking) await assertHeldCaptureRecorded(release.what, recorded);
  else await assertStopped(release.what);
  const from = await trackAgain(target, release, first, recorded);
  await assertAutopilotResumes(release.what, from);
}

/** Pick tracking up after `release`; the ledger length new captures count from. */
async function trackAgain(
  target: Debuggee,
  release: Release,
  first: Launched,
  recorded: number,
): Promise<number> {
  const { what } = release;
  if (!release.survives) {
    assert.equal(vscode.debug.activeDebugSession, undefined, `${what}: the session has ended`);
    await launchTracked(target, `After: ${what}`);
    return 0;
  }
  assert.equal(vscode.debug.activeDebugSession?.id, first.session.id, `${what}: still debugged`);
  assert.ok(isRunning(first.pid), `${what}: the program keeps running`);
  if (release.keepsTracking) return recorded;
  await resume();
  await track(first.pid, `${what}, tracked again`);
  return 0;
}

/** Every way a held capture is let go of. Spec: lspkit [PROF-MEMORY-STOP]. */
const RELEASES: readonly Release[] = [
  {
    what: 'the program continued, so the read it held completes',
    survives: true,
    keepsTracking: true,
    release: resume,
  },
  {
    what: 'tracking stopped, program left running',
    survives: true,
    keepsTracking: false,
    release: async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.memoryStop');
    },
  },
  {
    what: 'tracking stopped, then the program killed (the CI teardown)',
    survives: false,
    keepsTracking: false,
    release: async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.memoryStop');
      await endSessions();
    },
  },
  {
    what: 'the program killed while still tracked',
    survives: false,
    keepsTracking: false,
    release: endSessions,
  },
];

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
      `the leak site must wear an auto-painted memory track, got: ${JSON.stringify(applied)}`,
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
    assert.ok(offer !== undefined);
    assertOfferNamesItsLeak(offer, target);
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
    await useIntervalMode(target);
    await launchTracked(target, 'Autopilot interval');

    await waitForAutoCaptures(2);
    const captures = recordedAutopilotCaptures();
    assert.ok(
      captures.every((capture) => capture.trigger === 'interval'),
      `every capture must be interval-triggered, got: ${captures.map((c) => c.trigger).join(', ')}`,
    );
  });

  // A capture the interval sent just before teardown stopped tracking and killed
  // the program once sat out the engine's 90 s deadline, so the next test's
  // session never captured ("2 automatic capture(s) not met within 40000ms").
  for (const release of RELEASES) {
    test(`a capture a pause holds lets go when ${release.what}, and the autopilot captures on time after`, async function () {
      this.timeout(240_000);
      await releaseHeldCapture(built(), recorder(), release);
    });
  }

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
