// The checks debug suites make once the debuggee has stopped: what the
// Variables panel, the Watch panel, the Debug Console and a hover read, the one
// breakpoint the workbench holds, and how a session runs on to its end.
//
// Spec: [DEBUG-FEATURES-VARIABLES], [DEBUG-FEATURES-BREAKPOINTS],
// [DEBUG-FEATURES-EXCEPTIONS].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DapRecorder, type StopRecord } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  evaluate,
  gesture,
  variableNamed,
  type Variable,
  CMD_STEP_INTO,
  CMD_STEP_OVER,
  assertStoppedAt,
  at,
  methodOf,
  stackFrames,
  stepToFrame,
  trace,
  walk,
  type Frame,
} from './debug-drive-kit';
import { CAUGHT_MESSAGE, type DebugFixture } from './debug-fixture-programs';
import { assertRanToCompletion } from './debug-suite-kit';
import { assertContainsAll, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS } from './test-timeouts';

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
