// The bundles the stepping suites repeat: one gesture, where it must land, how
// deep the stack must be, and what a continue must hit next.
//
// Spec: [DEBUG-FEATURES-STEPPING], [DEBUG-FEATURES-STACK],
// [DEBUG-FEATURES-BREAKPOINTS].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DapRecorder, type StopRecord } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  assertStopReason,
  assertStoppedAt,
  methodOf,
  stackFrames,
  stepToFrame,
  type Frame,
} from './debug-drive-kit';
import { LaunchOptions, startDebuggee, type Debuggee } from './debug-suite-kit';
import type { DebugFixture } from './debug-fixture-programs';
import { deepEq, eq, requireAt } from './test-helpers';

/** The result of one gesture: the stop it produced and the frame it landed in. */
export interface Landing {
  readonly stop: StopRecord;
  readonly frame: Frame;
}

/**
 * Make one stepping gesture and assert it came to rest on `anchor` inside
 * `method`. `reason`, when given, must be the stop's DAP reason — `step` for a
 * step, `breakpoint` for a hit — because a step serviced as a breakpoint (or
 * vice versa) is a misrouted gesture even when the line looks right.
 */
export async function stepLandsAt(
  recorder: DapRecorder,
  command: string,
  fixture: DebugFixture,
  anchor: string,
  method: string,
  why: string,
  reason?: string,
): Promise<Landing> {
  const landed = await stepToFrame(recorder, command);
  if (reason !== undefined) assertStopReason(landed.stop, reason, why);
  assertStoppedAt(landed.frame, fixture, anchor, method, why);
  return landed;
}

/**
 * Continue from the current stop to the next breakpoint hit: assert the stop's
 * reason is `breakpoint` and it landed on `anchor` inside `method`. Returning
 * to a breakpoint with any other reason means a pending step resumed the
 * debuggee past the user's own breakpoint.
 */
export async function continueToBreakpoint(
  recorder: DapRecorder,
  fixture: DebugFixture,
  anchor: string,
  method: string,
  why: string,
): Promise<Landing> {
  return stepLandsAt(recorder, CMD_CONTINUE, fixture, anchor, method, why, 'breakpoint');
}

/** The `dapLine` of each anchor, sorted ascending — the order the workbench syncs in. */
export function sortedDapLines(fixture: DebugFixture, ...anchors: readonly string[]): number[] {
  return anchors
    .map((anchor) => fixture.source.dapLine(anchor))
    .sort((left, right) => left - right);
}

/** The lines of the fixture's three user walk statements, in call order. */
export function walkLines(fixture: DebugFixture): number[] {
  return [
    fixture.source.dapLine('add-body'),
    fixture.source.dapLine('accumulate-call'),
    fixture.source.dapLine('main-accumulate'),
  ];
}

/** The stack of the stop `landing` produced is exactly `depth` frames deep. */
export async function assertLandingDepth(
  session: vscode.DebugSession,
  landing: Landing,
  depth: number,
  why: string,
): Promise<void> {
  assert.strictEqual((await stackFrames(session, landing.stop.threadId)).length, depth, why);
}

/** Every stop in `stops` reports the DAP `step` reason, never a hidden breakpoint. */
export function assertAllStepStops(stops: readonly StopRecord[], why: string): void {
  assert.ok(
    stops.every((stop) => stop.reason === 'step'),
    `${why}: reasons seen: ${stops.map((stop) => stop.reason).join(', ')}`,
  );
}

/** Launch the debuggee and wait for its first stop, failing with `why` if it never arrives. */
export async function stopAfterLaunch(
  debuggee: Debuggee,
  options: LaunchOptions,
  why: string,
): Promise<{ session: vscode.DebugSession; stop: StopRecord }> {
  const session = await startDebuggee(debuggee, options);
  return { session, stop: requireAt(await debuggee.recorder.waitForStops(1), 0, why) };
}

/**
 * The frame names `method` and is parked on the fixture's `anchor` statement
 * line; each half of the claim fails with its own reason.
 */
export function assertParkedOn(
  frame: Frame,
  fixture: DebugFixture,
  anchor: string,
  method: string,
  methodWhy: string,
  lineWhy: string,
): void {
  eq(methodOf(frame), method, methodWhy);
  eq(frame.line, fixture.source.dapLine(anchor), lineWhy);
}

/** `frames` projected through `project` equal `expected` exactly, in order. */
export function assertProjectedFrames(
  frames: readonly Frame[],
  project: (frame: Frame) => unknown,
  expected: readonly unknown[],
  why: string,
): void {
  deepEq(frames.map(project), expected, why);
}
