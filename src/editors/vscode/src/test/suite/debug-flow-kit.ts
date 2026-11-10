// The gestures a debug FLOW is made of: arm a breakpoint and press Debug on the
// row it belongs to, wait for the session to end, walk a stub adapter through
// one scripted misbehaviour, and put a live session to work on a reload.
//
// Spec: [DEBUG-FEATURES-TESTS], [DEBUG-FEATURES-BREAKPOINTS],
// [DEBUG-FEATURES-HOT-RELOAD], [DEBUG-FEATURES-LAUNCH], [DEBUG-ARCHITECTURE-ROUTER].
//
// The F5 resolver harness lives in debug-e2e-kit, the "debug a test" fixtures in
// debug-test-kit, and the program-debugging suite harness in debug-suite-kit.
// This kit holds what is left over: the shapes two or more of those suites write
// out identically. Each helper asserts exactly what the call sites it replaced
// asserted, with every differing reason passed in.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DapRecorder, type StopRecord } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  assertStopReason,
  assertStoppedAt,
  evaluate,
  gesture,
  localsOf,
  methodOf,
  stackFrames,
  topFrame,
  variableNamed,
  type Frame,
  type Variable,
} from './debug-drive-kit';
import type { DebugFixture } from './debug-fixture-programs';
import { MODE } from './debug-fixture-programs';
import type { Debuggee, LaunchOptions } from './debug-suite-kit';
import { breakpointAt, runToFirstStop, startDebuggee } from './debug-suite-kit';
import { assertValues } from './debug-inspect-kit';
import {
  CS_ALL,
  CS_SOURCE,
  breakpointAt as anchoredBreakpointAt,
  conditionalBreakpointAt,
  hitCountBreakpointAt,
  requireActive,
  type TestDebugFixture,
} from './debug-test-kit';
import {
  breakpointStopFrame,
  debugRunOneSession,
  debuggableRow,
  firstBreakpointStop,
  armAnchoredBreakpoints,
} from './debug-test-harness';
import { DEBUG_TYPE_ID, type DebugSessionRecorder } from './run-debug-kit';
import { eq, deepEq, pollUntilResult, requireAt, sleep } from './test-helpers';
import { DEBUG_SESSION_MS, QUIET_MS } from './test-timeouts';

/** The conditional payload of a breakpoint: an expression, a hit count, a log message, or none. */
export interface BreakpointExtras {
  readonly condition?: string;
  readonly hitCondition?: string;
  readonly logMessage?: string;
}

/** Arm ONE breakpoint on the fixture's `accumulate-call` carrying the user's condition. */
export function armAccumulateCall(fixture: DebugFixture, extras: BreakpointExtras): void {
  vscode.debug.addBreakpoints([breakpointAt(fixture, 'accumulate-call', extras)]);
}

/** Replace every breakpoint in the workbench with one on `accumulate-call`. */
export function rearmAccumulateCall(fixture: DebugFixture, extras: BreakpointExtras): void {
  vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  armAccumulateCall(fixture, extras);
}

/** Launch the plain debuggee and return its first stop, asserted to exist. */
export async function launchToFirstStop(
  debuggee: Debuggee,
  recorder: DapRecorder,
  stopWhy: string,
): Promise<{ session: vscode.DebugSession; stop: StopRecord }> {
  const session = await startDebuggee(debuggee, { mode: MODE.plain });
  const stop = requireAt(await recorder.waitForStops(1), 0, stopWhy);
  return { session, stop };
}

/**
 * The stop is a breakpoint hit whose top frame is the fixture's `accumulate-call`
 * line inside `Accumulate` — where the loop's own state can be read.
 */
export async function stopInAccumulate(
  session: vscode.DebugSession,
  fixture: DebugFixture,
  stop: StopRecord,
  expected: { readonly reasonWhy: string; readonly frameWhy: string; readonly locals: LocalsRows },
): Promise<void> {
  assertStopReason(stop, 'breakpoint', expected.reasonWhy);
  const frame = await topFrame(session, stop.threadId);
  assertStoppedAt(frame, fixture, 'accumulate-call', 'Accumulate', expected.frameWhy);
  assertValues(await localsOf(session, frame.id), expected.locals);
}

/** One named local and the value it must hold, each with its own reason. */
export type LocalsRows = readonly (readonly [name: string, value: string, why: string])[];

/** `expression` evaluates in `frameId` to exactly `expected` — the answer the Watch panel shows. */
export async function assertWatchValue(
  session: vscode.DebugSession,
  frameId: number,
  expression: string,
  expected: string,
  why: string,
): Promise<void> {
  eq((await evaluate(session, expression, frameId, 'watch')).value, expected, why);
}

/** The row for `fqn`, with the ONE breakpoint `armed` builds for the fixture's source. */
async function rowArmedBy(
  fixture: TestDebugFixture,
  fqn: string,
  armed: (uri: vscode.Uri) => vscode.SourceBreakpoint,
): Promise<vscode.TestItem> {
  const item = await debuggableRow(fixture, CS_ALL, fqn);
  vscode.debug.addBreakpoints([armed(fixture.sourceUri)]);
  return item;
}

/** How the one breakpoint a row is armed with selects which visit of its line stops. */
export type RowSelector = { readonly condition: string } | { readonly hitCondition: string };

/**
 * The row for `fqn` with ONE breakpoint armed at `anchor`, selecting a visit by
 * `selector`: a condition over the frame's locals, or a hit count.
 */
export function rowArmedSelected(
  fixture: TestDebugFixture,
  fqn: string,
  anchor: string,
  selector: RowSelector,
): Promise<vscode.TestItem> {
  return rowArmedBy(fixture, fqn, (uri) =>
    'condition' in selector
      ? conditionalBreakpointAt(CS_SOURCE, uri, anchor, selector.condition)
      : hitCountBreakpointAt(CS_SOURCE, uri, anchor, selector.hitCondition),
  );
}

/** The row for `fqn` of the C# test fixture, with ONE breakpoint armed at `anchor`. */
export function rowArmedAt(
  fixture: TestDebugFixture,
  fqn: string,
  anchor: string,
): Promise<vscode.TestItem> {
  return rowArmedBy(fixture, fqn, (uri) => anchoredBreakpointAt(CS_SOURCE, uri, anchor));
}

/**
 * Arm ONE breakpoint at `anchor` of the C# test fixture, asserted as the only one
 * the workbench holds: a second, stray breakpoint changes which stop a test sees.
 */
export function armTestAnchor(fixture: TestDebugFixture, anchor: string, why: string): void {
  armAnchoredBreakpoints(CS_SOURCE, fixture.sourceUri, [anchor], why);
}

/**
 * Debug `item` and return the stop the breakpoint armed at `anchor` must make.
 *
 * The stop is the FIRST of the run: a test that stops somewhere earlier is
 * stopping in machinery the user never armed.
 */
export async function debugRowToStop(
  recorder: DapRecorder,
  sessions: DebugSessionRecorder,
  item: vscode.TestItem,
  anchor: string,
  why: string,
): Promise<StopRecord> {
  await debugRunOneSession([item], sessions, why);
  return firstBreakpointStop(recorder, CS_SOURCE, anchor);
}

/** A theory row's stop: the session, the frame it stopped in, and that row's own locals. */
export interface TheoryRowStop {
  readonly stop: StopRecord;
  readonly active: vscode.DebugSession;
  readonly frame: Frame;
  readonly locals: readonly Variable[];
}

/**
 * The `nth` stop of a debug-a-test run, in the theory body `Adds_Rows`, with the
 * row's own locals read out of its frame.
 */
export async function theoryRowStop(
  recorder: DapRecorder,
  nth: number,
  why: string,
  methodWhy: string,
): Promise<TheoryRowStop> {
  const { stop, active, frame } = await breakpointStopFrame(recorder, nth, why);
  eq(methodOf(frame), 'Adds_Rows', methodWhy);
  return { stop, active, frame, locals: await localsOf(active, frame.id) };
}

/** The live session, the stop's whole stack and its method names, innermost first. */
export async function stackNames(
  stop: StopRecord,
  why: string,
): Promise<{ active: vscode.DebugSession; frames: Frame[]; names: string[] }> {
  const active = requireActive(why);
  const frames = await stackFrames(active, stop.threadId);
  return { active, frames, names: frames.map((frame) => methodOf(frame)) };
}

/** F5 from a stop, then wait for the session to end — the last step of a debug flow. */
export async function finishSession(recorder: DapRecorder): Promise<void> {
  await gesture(CMD_CONTINUE);
  await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
}

/**
 * The router's end of session reached the client exactly once: one `terminated`
 * is the whole promise, and a second is a session ended twice.
 */
export async function assertEndedOnce(
  driver: { awaitTerminated(): Promise<readonly unknown[]> },
  why: string,
): Promise<void> {
  const ended = await driver.awaitTerminated();
  eq(ended.length, 1, why);
}

/**
 * Wait out four deadlines, then assert how many ends the router had announced by
 * then — the deadline, disarmed, must add none.
 */
export async function endsAfterDeadline(
  driver: { events(name: string): readonly unknown[] },
  expected: number,
  why: string,
  deadlineMs: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, deadlineMs * 4));
  eq(driver.events('terminated').length, expected, why);
}

/** The ONE `pause` request on the wire aimed at `threadId` — a Pause must not target a sibling. */
export function assertPauseFor(recorder: DapRecorder, threadId: number, why: string): void {
  deepEq(
    recorder.requests('pause').map((request) => Number(request.args['threadId'])),
    [threadId],
    why,
  );
}

/**
 * Run `body` against a fresh driver over a stub told to `behaviour`, disposing
 * it afterwards. Scoped here so a driver is released even when an assertion in
 * the body throws, which is the whole reason every wedge test has a `finally`.
 */
export async function withDriver<T extends { dispose(): void }>(
  start: (behaviour: string) => T,
  behaviour: string,
  body: (driver: T) => Promise<void>,
): Promise<void> {
  const driver = start(behaviour);
  try {
    await body(driver);
  } finally {
    driver.dispose();
  }
}

/** The named local of the live session's stopped frame `frameId` reads exactly `value`. */
export async function assertLocalValue(
  activeWhy: string,
  frameId: number,
  name: string,
  value: string,
  why: string,
): Promise<void> {
  const locals = await localsOf(requireActive(activeWhy), frameId);
  eq(variableNamed(locals, name).value, value, why);
}

/** The session the workbench is attached to is still `session`: a new id is a restart. */
export function assertSameSession(session: vscode.DebugSession, why: string): void {
  eq(vscode.debug.activeDebugSession?.id, session.id, why);
}

/**
 * Pause the debuggee on `accumulate-entry` with hot reload on: the opening
 * every hot-reload test shares, since the edit must land while it is RUNNING.
 */
export function runReloading(debuggee: Debuggee): Promise<{
  session: vscode.DebugSession;
  stop: StopRecord;
}> {
  const options: LaunchOptions = { mode: MODE.plain, extra: { hotReload: true } };
  return runToFirstStop(debuggee, 'accumulate-entry', options);
}

/**
 * Attempt to start `config` and assert the workbench REFUSED it, then let the
 * refusal reach the user — a silent no-op is the defect these cases guard.
 */
export async function refusedLaunch(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
  why: string,
): Promise<void> {
  const started = await vscode.debug.startDebugging(folder, config);
  assert.ok(!started, why);
  await sleep(QUIET_MS);
}

/** Start an attach for `config`, assert it was accepted, and return the live session. */
export async function startAttached(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
  refusalWhy: string,
  sessionWhy: string,
): Promise<vscode.DebugSession> {
  const started = await vscode.debug.startDebugging(folder, config);
  assert.ok(started, refusalWhy);
  const session = await pollUntilResult(
    async () => vscode.debug.activeDebugSession,
    (current) => current?.type === DEBUG_TYPE_ID,
    60_000,
    50,
  );
  assert.ok(session, sessionWhy);
  return session;
}
