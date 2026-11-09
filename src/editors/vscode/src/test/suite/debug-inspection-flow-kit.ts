// The repeated bodies of the debug inspection suites: how a paused frame's
// values are expanded and checked, and the recorder epilogue every
// interaction block ends with.
//
// Spec: [DEBUG-FEATURES-VARIABLES], [DEBUG-FEATURES-STACK].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DapRecorder, type StopRecord } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  localsOf,
  topFrame,
  variableNamed,
  variablesOf,
  type Frame,
  type Variable,
} from './debug-drive-kit';
import { runToFirstFrame, stopInFrame, type Debuggee } from './debug-suite-kit';
import { deepEq, eq } from './test-helpers';

/** Stop on `anchor` inside `method` and return the stopped frame with its locals. */
export async function stopForLocals(
  debuggee: Debuggee,
  anchors: string | readonly string[],
  method: string,
  why: string,
): Promise<{ session: vscode.DebugSession; stop: StopRecord; frame: Frame; locals: Variable[] }> {
  const landed = await stopInFrame(debuggee, anchors, method, why);
  return { ...landed, locals: await localsOf(landed.session, landed.frame.id) };
}

/** Run to the first stop on `anchors` and return the stopped frame with its locals. */
export async function runToLocals(
  debuggee: Debuggee,
  anchors: string | readonly string[],
): Promise<{ session: vscode.DebugSession; stop: StopRecord; frame: Frame; locals: Variable[] }> {
  const landed = await runToFirstFrame(debuggee, anchors);
  return { ...landed, locals: await localsOf(landed.session, landed.frame.id) };
}

/** Continue the debuggee and wait until `count` stops have been recorded. */
export async function continueToStops(recorder: DapRecorder, count: number): Promise<StopRecord[]> {
  await vscode.commands.executeCommand(CMD_CONTINUE);
  return recorder.waitForStops(count);
}

/** The top frame of `stop` with its locals. */
export async function topFrameLocals(
  session: vscode.DebugSession,
  stop: StopRecord,
): Promise<{ frame: Frame; locals: Variable[] }> {
  const frame = await topFrame(session, stop.threadId);
  return { frame, locals: await localsOf(session, frame.id) };
}

/** The variable carries a non-zero `variablesReference`, so the panel can expand it. */
export function assertExpandable(variable: Variable, why: string): void {
  assert.ok(variable.reference > 0, why);
}

/**
 * Expand the local named `name`, asserting it carries a non-zero
 * `variablesReference` (`why`). Returns the variable and its expansion.
 */
export async function expandLocal(
  session: vscode.DebugSession,
  locals: readonly Variable[],
  name: string,
  why: string,
): Promise<{ readonly variable: Variable; readonly children: Variable[] }> {
  const variable = variableNamed(locals, name);
  assertExpandable(variable, why);
  return { variable, children: await variablesOf(session, variable.reference) };
}

/**
 * Some expanded child's value equals `value` exactly, failing with `why` and
 * what the expansion produced — `listing` spells each child as its bare value
 * or as `name=value`.
 */
export function assertExpandedValue(
  children: readonly Variable[],
  value: string,
  why: string,
  listing: 'name=value' | 'value',
): void {
  assert.ok(
    children.some((child) => child.value === value),
    `${why}; expansion produced: ${children
      .map((child) => (listing === 'value' ? child.value : `${child.name}=${child.value}`))
      .join(', ')}`,
  );
}

/** Some expanded child's value contains `fragment`, failing with `why`. */
export function assertExpandedContains(
  children: readonly Variable[],
  fragment: string,
  why: string,
): void {
  assert.ok(
    children.some((child) => child.value.includes(fragment)),
    why,
  );
}

/** The frame's locals include one named exactly `name`, failing with `why`. */
export function assertLocalNamed(locals: readonly Variable[], name: string, why: string): void {
  assert.ok(locals.map((local) => local.name).includes(name), why);
}

/**
 * Every name in `wanted` appears among the frame's locals, failing with `why`
 * followed by `offerClause` and the sorted names the frame did offer.
 */
export function assertLocalsInclude(
  locals: readonly Variable[],
  wanted: readonly string[],
  why: string,
  offerClause: string,
): void {
  const offered = locals.map((local) => local.name).sort();
  assert.ok(
    wanted.every((name) => offered.includes(name)),
    `${why} ${offerClause}${offered.join(', ')}`,
  );
}

/** The wire holds at least `min` requests for `command`, failing with `why`. */
export function assertRequested(
  recorder: DapRecorder,
  command: string,
  min: number,
  why: string,
): void {
  assert.ok(recorder.requests(command).length >= min, why);
}

/** Every stop recorded named a non-zero thread id, failing with `why`. */
export function assertStopsNamedThreads(recorder: DapRecorder, why: string): void {
  assert.ok(
    recorder.stops().every((entry) => entry.threadId !== 0),
    why,
  );
}

/** The debuggee stopped exactly `stops` times, and the adapter transport never errored. */
export function assertPausedQuietly(
  recorder: DapRecorder,
  stops: number,
  stopsWhy: string,
  errorsWhy: string,
): void {
  eq(recorder.stops().length, stops, stopsWhy);
  deepEq(recorder.errors, [], errorsWhy);
}
