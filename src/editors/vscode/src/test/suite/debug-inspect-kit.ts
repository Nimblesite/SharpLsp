// The checks debug suites make once the debuggee has stopped: what the
// Variables panel, the Watch panel, the Debug Console and a hover read, the one
// breakpoint the workbench holds, and how a session runs on to its end.
//
// Spec: [DEBUG-FEATURES-VARIABLES], [DEBUG-FEATURES-BREAKPOINTS],
// [DEBUG-FEATURES-EXCEPTIONS].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DapRecorder, dap, type StopRecord } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  evaluate,
  gesture,
  variableNamed,
  type Variable,
  CMD_STEP_INTO,
  CMD_STEP_OVER,
  assertStopReason,
  assertStoppedAt,
  at,
  methodOf,
  stackFrames,
  stepToFrame,
  trace,
  walk,
  exceptionInfoOf,
  assertExceptionIs,
  type ExceptionInfo,
  type Frame,
} from './debug-drive-kit';
import { CAUGHT_MESSAGE, type DebugFixture } from './debug-fixture-programs';
import { assertRanToCompletion, refusalsOf, type Debuggee } from './debug-suite-kit';
import { assertContainsAll, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS } from './test-timeouts';
import type { UiStubs } from './ui-stubs';

/** Each named variable reads exactly its expected value, each row failing with its own reason. */
export function assertValues(
  variables: readonly Variable[],
  rows: readonly (readonly [name: string, value: string, why: string])[],
): void {
  for (const [name, value, why] of rows)
    assert.strictEqual(variableNamed(variables, name).value, value, why);
}

/** F5 from the stop, then the session runs to its end with no adapter transport error. */
export async function continueToEnd(recorder: DapRecorder, why: string): Promise<void> {
  await gesture(CMD_CONTINUE);
  await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
  assert.deepStrictEqual(recorder.errors, [], why);
}

/** F5 from the stop, then the debuggee itself runs to completion and exits. */
export async function continueToCompletion(recorder: DapRecorder, why: string): Promise<void> {
  await vscode.commands.executeCommand(CMD_CONTINUE);
  await assertRanToCompletion(recorder, 0, why);
}

/**
 * Each `expression` evaluates in `frameId` to a Watch value containing its
 * `expected` text, and the Debug Console and a hover agree with that value
 * exactly: three answers for one expression is a bug the user reads as their
 * own code misbehaving. `tier` says what kind of expression the rows are.
 */
export async function assertEvaluatesEverywhere(
  session: vscode.DebugSession,
  frameId: number,
  rows: readonly { readonly expression: string; readonly expected: string }[],
  tier: string,
): Promise<void> {
  for (const { expression, expected } of rows) {
    const watch = await evaluate(session, expression, frameId, 'watch');
    assert.ok(
      watch.value.includes(expected),
      `${expression} is ${tier} and must evaluate; the Watch panel answered ${JSON.stringify(watch.value)}`,
    );
    for (const context of ['repl', 'hover'] as const) {
      const other = await evaluate(session, expression, frameId, context);
      assert.strictEqual(
        other.value,
        watch.value,
        `${expression}: ${context} must agree with Watch`,
      );
    }
  }
}

/** The ONE breakpoint armed in the workbench, asserted a source (line) breakpoint. */
export function onlySourceBreakpoint(why: string): vscode.SourceBreakpoint {
  assert.strictEqual(vscode.debug.breakpoints.length, 1, `${why}: exactly one is armed`);
  const armed = requireAt(vscode.debug.breakpoints, 0, why);
  assert.ok(armed instanceof vscode.SourceBreakpoint, `${why}: armed as a SOURCE breakpoint`);
  return armed;
}

/**
 * F5 past the program's HANDLED throw with nothing set to catch it: the run
 * completes, prints both its `handled` and `done` lines, and gains no stop.
 * "No stops" alone is also what a session that died on launch produces, so the
 * negative only counts beside that positive evidence. `noStopWhy` says why a
 * stop there would be the defect.
 */
export async function assertRunsPastHandledThrow(
  recorder: DapRecorder,
  why: string,
  noStopWhy: string,
): Promise<void> {
  const baseline = recorder.stops().length;
  await vscode.commands.executeCommand(CMD_CONTINUE);
  await assertRanToCompletion(recorder, 0, why);
  await recorder.waitForOutput(`handled ${CAUGHT_MESSAGE}`);
  const added = recorder.stops().slice(baseline);
  assert.deepStrictEqual(
    added.map((stop) => `${stop.reason}:${stop.text}`),
    [],
    noStopWhy,
  );
  await recorder.waitForOutput('done caught 45');
  assert.strictEqual(recorder.stops().length, baseline, `${why}: no stop was added`);
  assertContainsAll(
    recorder.outputText(),
    [`handled ${CAUGHT_MESSAGE}`, 'done caught 45'],
    'recorder.outputText()',
  );
}

/**
 * From a stop inside `accumulate`: F10 twice visits the loop header and then
 * the body's call — landing inside `add` instead means `next` was serviced as
 * `stepIn` — and F11 enters `add`, whose stack names `add`, `accumulate` and
 * `main` innermost-first. `names` spells those three in the fixture's language.
 */
export async function stepIntoAddThroughLoop(
  recorder: DapRecorder,
  session: vscode.DebugSession,
  fixture: DebugFixture,
  names: readonly [add: string, accumulate: string, main: string],
): Promise<{ intoAdd: { stop: StopRecord; frame: Frame }; deep: Frame[] }> {
  const [add, accumulate] = names;
  const toCall = await walk(recorder, [CMD_STEP_OVER, CMD_STEP_OVER]);
  assert.deepStrictEqual(
    trace(toCall.frames),
    [at(fixture, accumulate, 'accumulate-loop'), at(fixture, accumulate, 'accumulate-call')],
    'F10 in a for-loop visits the loop header, then the body statement',
  );
  const intoAdd = await stepToFrame(recorder, CMD_STEP_INTO);
  assertStoppedAt(intoAdd.frame, fixture, 'add-body', add, 'F11 into the innermost call');
  const deep = await stackFrames(session, intoAdd.stop.threadId);
  assert.deepStrictEqual(
    deep.slice(0, 3).map((frame) => methodOf(frame)),
    [...names],
    '[DEBUG-FEATURES-STACK]: `stackTrace` names the frames innermost-first',
  );
  return { intoAdd, deep };
}

/** The `breakpoints` entries of one `setBreakpoints`-family request. */
export function entriesOf(args: Record<string, any>): Record<string, any>[] {
  const list: unknown = args['breakpoints'];
  return Array.isArray(list) ? (list as Record<string, any>[]) : [];
}

/**
 * Wait until a `command` request (`setBreakpoints` unless named) carries exactly
 * `want` under `field`, and return what it carried.
 *
 * Reading the LAST request the wire holds asks what is there RIGHT NOW, which
 * is the final state only if nothing further is in flight. One gesture is
 * routinely several requests - the workbench syncs a breakpoint as a remove
 * then an add - so the last entry at an arbitrary moment can be an
 * INTERMEDIATE one carrying the state before the gesture completed, and which
 * one a test observes is then decided by how fast the machine is.
 */
export async function waitForSentField(
  recorder: DapRecorder,
  field: string,
  want: readonly (string | undefined)[],
  why: string,
  command = 'setBreakpoints',
): Promise<(string | undefined)[]> {
  const read = (args: Record<string, any>): (string | undefined)[] =>
    entriesOf(args).map((entry) => entry[field] as string | undefined);
  const carried = await recorder.waitForRequestArgs(
    command,
    (args) => {
      const got = read(args);
      return got.length === want.length && want.every((value, at) => got[at] === value);
    },
    why,
  );
  return read(carried);
}

/** {@link waitForSentField}, then assert the request carried exactly `want`. */
export async function assertSentField(
  recorder: DapRecorder,
  field: string,
  want: readonly (string | undefined)[],
  why: string,
  command = 'setBreakpoints',
): Promise<void> {
  assert.deepStrictEqual(await waitForSentField(recorder, field, want, why, command), want, why);
}

/**
 * Wait until a `setBreakpoints` request carries exactly `lines` — sorted,
 * because the workbench keeps its breakpoint list sorted by line — and assert
 * the request it found really did carry them. Waiting rather than sampling
 * matters: a gesture is routinely several syncs (a remove then an add), so the
 * last request on the wire at an arbitrary instant can be an intermediate one.
 */
export async function waitForSyncedLines(
  recorder: DapRecorder,
  lines: readonly number[],
  why: string,
): Promise<void> {
  const sorted = [...lines].sort((left, right) => left - right);
  const read = (args: Record<string, any>): number[] =>
    entriesOf(args)
      .map((entry) => Number(entry['line']))
      .sort((left, right) => left - right);
  const carried = await recorder.waitForRequestArgs(
    'setBreakpoints',
    (args) => {
      const got = read(args);
      return got.length === sorted.length && sorted.every((line, at) => got[at] === line);
    },
    why,
  );
  assert.deepStrictEqual(read(carried), sorted, why);
}

/** Every response to each named DAP command succeeded, each row failing with its own reason. */
export function assertEverySucceeded(
  recorder: DapRecorder,
  rows: readonly (readonly [command: string, why: string])[],
): void {
  for (const [command, why] of rows) {
    assert.ok(
      recorder.responses(command).every((response) => response.success),
      why,
    );
  }
}

/** The debuggee is still parked on `count` stops — an inspection must never resume it. */
export function assertPausedAt(recorder: DapRecorder, count: number, why: string): void {
  assert.strictEqual(
    recorder.stops().length,
    count,
    `${why}: the debuggee must still be parked where the panel found it`,
  );
}

/**
 * The paused session is still the active one, and no second was started behind
 * it — the claim every hot-reload and rude-edit case owes the user.
 */
export function assertSessionUninterrupted(
  debuggee: Debuggee,
  session: vscode.DebugSession,
  why: string,
): void {
  assert.strictEqual(
    vscode.debug.activeDebugSession?.id,
    session.id,
    `${why}: a new session id means the debuggee was restarted and the user lost their state`,
  );
  assert.strictEqual(
    debuggee.sessions.ours.length,
    1,
    `${why}: and exactly one session has existed`,
  );
}

/** Each workbench breakpoint's 0-based source line, in order; -1 marks a non-source one. */
export function sourceBreakpointLines(): number[] {
  return vscode.debug.breakpoints.map((breakpoint) =>
    breakpoint instanceof vscode.SourceBreakpoint ? breakpoint.location.range.start.line : -1,
  );
}

/** The Breakpoints view holds exactly `expected`, on those source lines and no others. */
export function assertSourceBreakpointLines(expected: readonly number[], why: string): void {
  assert.deepStrictEqual(sourceBreakpointLines(), expected, why);
}

/** The one refusal the pipeline issued, failing with every message seen when the count differs. */
export function requireSingleRefusal(stubs: UiStubs, why: string): string {
  const reported = refusalsOf(stubs);
  assert.strictEqual(reported.length, 1, `${why}; messages seen: ${JSON.stringify(reported)}`);
  return requireAt(reported, 0, 'the refusal message');
}

/**
 * The `filter` ids the initialize response advertises under
 * `exceptionBreakpointFilters`, failing when there are none: VS Code builds the
 * Breakpoints-view checkboxes entirely from that array.
 */
export function advertisedExceptionFilters(capabilities: Record<string, any>): string[] {
  const filters: unknown = capabilities['exceptionBreakpointFilters'];
  assert.ok(
    Array.isArray(filters),
    '[DEBUG-FEATURES-EXCEPTIONS] makes "Break on all CLR exceptions" and "Break on unhandled ' +
      'exceptions only" P1 rows. VS Code renders those as the Breakpoints-view checkboxes and ' +
      'builds them ENTIRELY from `exceptionBreakpointFilters` in the initialize response; with ' +
      'none advertised the user has no exception checkboxes at all',
  );
  return filters.map((filter) => String((filter as Record<string, any>)['filter']));
}

/** The advertised id of the unhandled-only filter, failing with what WAS offered. */
export function requireUnhandledFilterId(recorder: DapRecorder): string {
  const filters = advertisedExceptionFilters(recorder.capabilities());
  const unhandled = filters.find((filter) => UNHANDLED_FILTER_IDS.includes(filter));
  assert.ok(unhandled, `an unhandled-only filter must exist; advertised: ${filters.join(', ')}`);
  return unhandled;
}

/** The filter ids an adapter may use for "unhandled only"; one MUST exist. */
export const UNHANDLED_FILTER_IDS: readonly string[] = ['unhandled', 'user-unhandled', 'uncaught'];

/** Push `filters` to the LIVE adapter and assert the request carried exactly them. */
export async function pushExceptionFilters(
  session: vscode.DebugSession,
  recorder: DapRecorder,
  filters: readonly string[],
  why: string,
): Promise<void> {
  const before = recorder.requests('setExceptionBreakpoints').length;
  await dap(session, 'setExceptionBreakpoints', { filters });
  const sent = await recorder.requestAfter('setExceptionBreakpoints', before);
  assert.deepStrictEqual(sent.args['filters'], filters, why);
}

/**
 * F5 from the current stop into the next throw: assert it stopped on `anchor`
 * in `method` with the `exception` reason, read the panel, and assert it names
 * `type` carrying `message`. Returns the stop and the panel's answer for
 * further checks.
 */
export async function stopOnThrow(
  recorder: DapRecorder,
  session: vscode.DebugSession,
  fixture: DebugFixture,
  anchor: string,
  method: string,
  type: string,
  message: string,
  why: string,
): Promise<{ stop: StopRecord; info: ExceptionInfo }> {
  const landed = await stepToFrame(recorder, CMD_CONTINUE);
  assertStopReason(landed.stop, 'exception', why);
  assertStoppedAt(landed.frame, fixture, anchor, method, why);
  const info = await exceptionInfoOf(session, landed.stop.threadId);
  assertExceptionIs(info, type, message, why);
  return { stop: landed.stop, info };
}
