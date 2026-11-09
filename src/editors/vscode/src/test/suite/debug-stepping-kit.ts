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
  stackFrames,
  stepToFrame,
  type Frame,
} from './debug-drive-kit';
import type { DebugFixture } from './debug-fixture-programs';

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
