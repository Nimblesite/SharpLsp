// The Mocha lifecycle every "debug a test" suite repeats, in one place.
//
// Each suite in [DEBUG-FEATURES-TESTS] builds one fixture solution for the
// whole suite and arms a fresh set of recorders per test: a `DapRecorder` for
// the adapter traffic, a `DebugSessionRecorder` for the sessions the gesture
// starts, and `installUiStubs()` for the prompts a refusal would raise. The
// teardown then has to run in an exact order — stop the debuggee BEFORE the
// recorders are disposed, or the stop's own traffic is recorded against a
// disposed listener and the next test starts with a live session still
// attached.
//
// That ordering is the whole reason this lives here rather than being written
// out per suite: five copies of it are five chances to get the order wrong, and
// the failure mode is a later, unrelated suite timing out.
//
// Mirrors `useDebuggee` in `debug-suite-kit`, which does the same job for the
// suites that debug a PROGRAM rather than a test.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { AnchoredSource } from './debug-anchors';
import { DapRecorder, type StopRecord } from './debug-dap-kit';
import { assertStopReason } from './debug-drive-kit';
import { assertBoundAtLines, clearAllBreakpoints, stopDebuggee } from './debug-suite-kit';
import {
  disposeDebugTestFixture,
  writeDebugTestFixture,
  type FixtureLanguage,
  type FixtureRunner,
  type TestDebugFixture,
} from './debug-test-kit';
import { DebugSessionRecorder } from './run-debug-kit';
import {
  activateTestExplorer,
  discoverSolution,
  findItem,
  runViaProfile,
} from './test-explorer-kit';
import { closeAllEditors, comparablePath, eq, requireAt } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** The suite's built fixture, plus the recorders armed for the current test. */
export interface DebugTestHarness {
  readonly fixture: TestDebugFixture;
  readonly recorder: DapRecorder;
  readonly sessions: DebugSessionRecorder;
  readonly stubs: UiStubs;
}

/**
 * Build one fixture solution for the suite and arm a fresh harness per test.
 *
 * The returned accessor is only valid from `setup` onwards; calling it outside
 * a test throws rather than handing back a disposed recorder.
 */
export function useDebugTestFixture(
  prefix: string,
  language: FixtureLanguage,
  runner: FixtureRunner = 'vstest',
): () => DebugTestHarness {
  let fixture: TestDebugFixture;
  let current: DebugTestHarness | undefined;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    fixture = await writeDebugTestFixture(prefix, language, runner);
  });

  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await disposeDebugTestFixture(fixture);
  });

  setup(() => {
    clearAllBreakpoints();
    current = {
      fixture,
      recorder: new DapRecorder(),
      sessions: new DebugSessionRecorder(),
      stubs: installUiStubs(),
    };
  });

  teardown(async () => {
    const active = current;
    current = undefined;
    if (active === undefined) return;
    await stopDebuggee();
    clearAllBreakpoints();
    active.sessions.dispose();
    active.recorder.dispose();
    active.stubs.restore();
    await closeAllEditors();
  });

  return () => {
    assert.ok(current, 'the debug-test harness must be created in setup');
    return current;
  };
}

/**
 * Discover `fixture`, expecting `expected`, and return the row for `fqn`: the
 * LEAF the Debug button applies to.
 */
export async function debuggableRow(
  fixture: TestDebugFixture,
  expected: readonly string[],
  fqn: string,
): Promise<vscode.TestItem> {
  const api = await activateTestExplorer();
  const discovered = await discoverSolution(api, fixture.solutionPath, expected);
  assert.ok(
    discovered.includes(fqn),
    `${fqn} must be discovered before it can be debugged; found: ${discovered.join(', ')}`,
  );
  const item = findItem(api.testController.items, fqn);
  assert.ok(item, `the TestItem for ${fqn} must exist`);
  eq(item.children.size, 0, `${fqn} is a test, so it is a LEAF the Debug button applies to`);
  return item;
}

/** Press the Debug button on `items`, exactly as the workbench does. */
export async function debugRun(items: readonly vscode.TestItem[]): Promise<void> {
  const api = await activateTestExplorer();
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, items);
}

/**
 * The breakpoint armed at `anchor` BOUND to its line, and the session's first
 * stop is ON it: a hollow, unverified breakpoint is the failure that looks like
 * success — the run goes green and nothing ever stops.
 */
export async function firstBreakpointStop(
  recorder: DapRecorder,
  source: AnchoredSource,
  anchor: string,
): Promise<StopRecord> {
  const why = `the breakpoint armed at '${anchor}'`;
  assertBoundAtLines(recorder, [source.dapLine(anchor)], why);
  const stop = requireAt(await recorder.waitForStops(1), 0, `the first stop: ${why}`);
  assertStopReason(stop, 'breakpoint', why);
  return stop;
}

/**
 * Put the caret inside `anchor`'s line of the fixture's test source, asserted
 * open in the editor as `languageId` — the start of every at-cursor command.
 */
export async function caretInSource(
  fixture: { readonly sourceUri: vscode.Uri; readonly sourceFile: string },
  source: AnchoredSource,
  anchor: string,
  languageId: string,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(fixture.sourceUri);
  const editor = await vscode.window.showTextDocument(document);
  const caret = source.line(anchor);
  editor.selection = new vscode.Selection(caret, 4, caret, 4);
  eq(editor.selection.active.line, caret, `the caret sits inside ${anchor}`);
  eq(document.languageId, languageId, `and the editor knows it is ${languageId}`);
  eq(comparablePath(document.uri.fsPath), comparablePath(fixture.sourceFile), 'in the fixture');
}
