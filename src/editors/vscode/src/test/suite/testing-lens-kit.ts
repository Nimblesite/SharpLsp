// Reading and asserting the [TEST-STATUS-LENS] rows a test file renders.
//
// The status lens puts THREE CodeLenses above one test method — a result plus a
// Run and a Debug action — and they share a range. So a status row is matched to
// its method the way the user reads it: by the RANGE it sits on, which is the
// range the method's Run action carries. Matching on the title alone cannot tell
// one method's "Passed" from another's, and matching on position alone cannot
// tell a status from an action.
//
// The titles themselves are pinned by [TEST-STATUS-LENS]:
//
//   $(pass) Passed (<duration>)      $(debug-step-over) Skipped
//   $(circle-slash) Not run          $(error) Failed: <assertion text>
//
// Every helper here takes the name the user sees — a fully-qualified test id or
// the bare method/binding name a lens row is addressed by, since a method name
// never carries a `.` — so a suite asserts the row without re-deriving it.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CMD_TEST_DEBUG_AT_CURSOR, CMD_TEST_RUN_AT_CURSOR } from '../../constants.js';
import { actionLenses, codeLensesFor, lensedMethods, lensedMethodsOver } from './code-lens-kit';
import type { SharpLspExtensionApi } from '../../extension.js';
import { cachedFor } from './test-explorer-outcome-assertions';
import type { UiStubs } from './ui-stubs';

/** The four titles [TEST-STATUS-LENS] pins, by the icon each opens with. */
export const NOT_RUN = '$(circle-slash) Not run';
export const SKIPPED_TITLE = '$(debug-step-over) Skipped';
export const PASSED_PREFIX = '$(pass) Passed';
export const FAILED_PREFIX = '$(error) Failed:';

/** Every icon a status lens may open with, and nothing else. */
export const STATUS_ICONS = [
  '$(pass)',
  '$(error)',
  '$(circle-slash)',
  '$(debug-step-over)',
] as const;

/** The method or binding name a fully-qualified id ends in — an id has no `.` of its own. */
export function lensMethodOf(id: string): string {
  return id.slice(id.lastIndexOf('.') + 1);
}

/** True for a lens rendering a RESULT rather than a Run/Debug action. */
export function isStatusLens(lens: vscode.CodeLens): boolean {
  const title = lens.command?.title ?? '';
  return STATUS_ICONS.some((icon) => title.startsWith(icon));
}

/** The status rows among `lenses`, in the order the provider returned them. */
export function statusLenses(lenses: readonly vscode.CodeLens[]): vscode.CodeLens[] {
  return lenses.filter((lens) => isStatusLens(lens));
}

/**
 * The status title rendered for `name`, or `undefined` when it has none.
 *
 * `name` is a fully-qualified test id or the bare method name its row is
 * addressed by. The row is found by RANGE — the status renders on the same line
 * as that method's Run and Debug actions, which carry the name — because that is
 * what the user sees: three actions on one row above one method.
 */
export function statusFor(lenses: readonly vscode.CodeLens[], name: string): string | undefined {
  const method = lensMethodOf(name);
  const action = actionLenses(lenses).find((lens) => lens.command?.arguments?.[1] === method);
  if (action === undefined) return undefined;
  return lenses.find((lens) => isStatusLens(lens) && lens.range.isEqual(action.range))?.command
    ?.title;
}

/** The status title of every lensed method in `lenses`, in method order. */
export function statusTitles(lenses: readonly vscode.CodeLens[]): string[] {
  return lensedMethods(lenses).map((method) => statusFor(lenses, method) ?? '');
}

/** Open `uri` in an editor and read the lenses the providers paint over it. */
export async function openAndReadLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return await codeLensesFor(uri);
}

/** The row of `name` renders exactly `expected`. */
export function assertRowIs(
  lenses: readonly vscode.CodeLens[],
  name: string,
  expected: string | undefined,
  why: string,
): void {
  assert.strictEqual(statusFor(lenses, name), expected, why);
}

/** The row of `name` renders a title opening with `prefix`, reporting the title it did render. */
export function assertRowOpens(
  lenses: readonly vscode.CodeLens[],
  name: string,
  prefix: string,
  why: string,
): void {
  const title = statusFor(lenses, name) ?? '';
  assert.ok(title.startsWith(prefix), `${why}; got ${title || '(nothing)'}`);
}

/** The row of `name` renders a title containing `fragment`, reporting the title it did render. */
export function assertRowHas(
  lenses: readonly vscode.CodeLens[],
  name: string,
  fragment: string,
  why: string,
): void {
  const title = statusFor(lenses, name) ?? '';
  assert.ok(title.includes(fragment), `${why}; got ${title || '(nothing)'}`);
}

/** What {@link assertEveryRowRan} says when a row is wrong, built per method. */
export interface RowRunMessages {
  /** Built for a method whose row still reads "Not run". */
  readonly notRun?: (method: string) => string;
  /** Built for a method with no status row at all. */
  readonly missing?: (method: string) => string;
  /** Built for a method whose title opens with none of the four spec icons. */
  readonly spec?: (method: string, title: string) => string;
}

/** Every lensed method carries a status row that has run, opening with a spec icon. */
export function assertEveryRowRan(
  lenses: readonly vscode.CodeLens[],
  messages: RowRunMessages,
): void {
  for (const method of lensedMethods(lenses)) {
    const title = statusFor(lenses, method);
    if (messages.missing !== undefined) {
      assert.notStrictEqual(title, undefined, messages.missing(method));
    }
    if (messages.notRun !== undefined) {
      assert.notStrictEqual(title, NOT_RUN, messages.notRun(method));
    }
    if (messages.spec !== undefined) {
      const title = statusFor(lenses, method) ?? '';
      assert.ok(
        STATUS_ICONS.some((icon) => title.startsWith(icon)),
        messages.spec(method, title),
      );
    }
  }
}

/** `lenses` carries exactly one status row per lensed method. */
export function assertOneStatusPerMethod(lenses: readonly vscode.CodeLens[], why: string): void {
  assert.strictEqual(statusLenses(lenses).length, lensedMethods(lenses).length, why);
}

/** `lenses` carries exactly one Run and one Debug action per lensed method. */
export function assertOneActionPerMethod(lenses: readonly vscode.CodeLens[], why: string): void {
  const methods = lensedMethods(lenses).length;
  assert.strictEqual(actionLenses(lenses).length, methods * 2, why);
}

/** The Run and Debug action lenses over `method`; either is `undefined` when missing. */
export function actionsFor(
  lenses: readonly vscode.CodeLens[],
  method: string,
): { readonly run: vscode.CodeLens | undefined; readonly debug: vscode.CodeLens | undefined } {
  const paired = actionLenses(lenses).filter((lens) => lens.command?.arguments?.[1] === method);
  const run = paired.find((lens) => lens.command?.command === CMD_TEST_RUN_AT_CURSOR);
  const debug = paired.find((lens) => lens.command?.command === CMD_TEST_DEBUG_AT_CURSOR);
  return { run, debug };
}

/** What {@link assertActionsPaired} says when the pair is broken, built per method. */
export interface PairMessages {
  /** Built for a method missing one of its two actions. */
  readonly missing: (method: string) => string;
  /** Built for a method whose two actions render on different rows. */
  readonly row: (method: string) => string;
}

/**
 * Queue one warning and drive `command` at `(uri, method)` as the lens does,
 * asserting the gesture never rejects (a rejected command is a dead button).
 */
export async function pressAtCursor(
  stubs: UiStubs,
  command: string,
  uri: vscode.Uri,
  method: string,
): Promise<void> {
  stubs.queueWarning(undefined);
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(command, uri, method);
  }, `${command} on ${method} must never reject`);
}

/** `method` carries both a Run and a Debug action, and both render on ONE row. */
export function assertActionsPaired(
  lenses: readonly vscode.CodeLens[],
  method: string,
  messages: PairMessages,
): { readonly run: vscode.CodeLens; readonly debug: vscode.CodeLens } {
  const { run, debug } = actionsFor(lenses, method);
  assert.ok(run && debug, messages.missing(method));
  assert.ok(run.range.isEqual(debug.range), messages.row(method));
  return { run, debug };
}

/** The controller cached exactly `outcome` for `id` — the result the lens reads from it. */
export function assertCachedOutcome(
  api: SharpLspExtensionApi,
  id: string,
  outcome: string,
  why: string,
): void {
  assert.strictEqual(cachedFor(api, id).outcome, outcome, why);
}

/** `uri` still carries a lens over every test method it declares (four at least). */
export async function assertStillLensed(uri: vscode.Uri, why: string): Promise<void> {
  assert.ok((await lensedMethodsOver(uri)).length >= 4, why);
}

/** One row above `method`: exactly one Run, one Debug and one status, never a stack of them. */
export function assertOnePerRow(
  lenses: readonly vscode.CodeLens[],
  method: string,
  label: string,
): void {
  const { run, debug } = actionsFor(lenses, method);
  assert.ok(run && debug, `${label}: ${method} must carry both actions`);
  const onRow = lenses.filter((lens) => lens.range.isEqual(run.range));
  const count = (matches: (lens: vscode.CodeLens) => boolean): number =>
    onRow.filter(matches).length;
  for (const [command, what] of [
    [CMD_TEST_RUN_AT_CURSOR, 'offers exactly one Run action'],
    [CMD_TEST_DEBUG_AT_CURSOR, 'offers exactly one Debug action'],
  ] as const) {
    assert.strictEqual(
      count((lens) => lens.command?.command === command),
      1,
      `${label}: ${method} ${what}`,
    );
  }
  assert.strictEqual(
    count(isStatusLens),
    1,
    `${label}: ${method} shows exactly one status, not a stack of them`,
  );
}

/** No lens in `lenses` renders a title `matches` accepts. */
export function assertNoTitle(
  lenses: readonly vscode.CodeLens[],
  matches: (title: string) => boolean,
  why: string,
): void {
  assert.strictEqual(lenses.filter((lens) => matches(lens.command?.title ?? '')).length, 0, why);
}
