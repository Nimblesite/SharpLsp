// Debugging an F# test. F# is not a port of the C# suites: an idiomatic
// backtick binding's fully-qualified name contains SPACES, its "class" is a
// module, and [TEST-OVERVIEW] refuses to make either a second-class case —
// "Expecto/FsCheck test debugging | P1 (F# parity)" is a P1 row of
// [DEBUG-FEATURES-TESTS] for the same reason.
//
// Everything the C# suites assert about the Debug profile has to hold here with
// a name the filter grammar, the DAP stack and the tree all have to carry
// verbatim — and the at-cursor gesture ([TEST-STATUS-LENS]'s Debug action) has
// to reach the same session from the editor rather than from the Testing view.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CMD_TEST_DEBUG_AT_CURSOR } from '../../constants.js';
import { DapRecorder } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  CMD_STEP_OUT,
  assertStopReason,
  evaluate,
  gesture,
  localsOf,
  methodOf,
  stackFrames,
  stepToFrame,
  topFrame,
  variableNamed,
} from './debug-drive-kit';
import { assertBoundAtLines, clearAllBreakpoints, stopDebuggee } from './debug-suite-kit';
import {
  FS_ALL,
  FS_MODULE,
  FS_ROWS,
  FS_SOURCE,
  FS_SPACED,
  assertHandshakeOrder,
  assertOneTestSession,
  breakpointAt,
  requireActive,
  disposeDebugTestFixture,
  writeDebugTestFixture,
  type TestDebugFixture,
} from './debug-test-kit';
import { DebugSessionRecorder } from './run-debug-kit';
import {
  activateTestExplorer,
  discoverSolution,
  findItem,
  runViaProfile,
} from './test-explorer-kit';
import {
  closeAllEditors,
  comparablePath,
  deepEq,
  eq,
  neq,
  requireAt,
} from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

suite('Debug an F# test — backtick names, modules and the at-cursor gesture', () => {
  let fixture: TestDebugFixture;
  let recorder: DapRecorder;
  let sessions: DebugSessionRecorder;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    fixture = await writeDebugTestFixture('debug-testfs-', 'fsharp');
  });

  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await disposeDebugTestFixture(fixture);
  });

  setup(() => {
    clearAllBreakpoints();
    recorder = new DapRecorder();
    sessions = new DebugSessionRecorder();
    stubs = installUiStubs();
  });

  teardown(async () => {
    await stopDebuggee();
    clearAllBreakpoints();
    sessions.dispose();
    recorder.dispose();
    stubs.restore();
    await closeAllEditors();
  });

  /** Discover the F# fixture and return the tree row for `fqn`. */
  async function rowFor(fqn: string): Promise<vscode.TestItem> {
    const api = await activateTestExplorer();
    const discovered = await discoverSolution(api, fixture.solutionPath, FS_ALL);
    eq(
      discovered.includes(fqn),
      true,
      `${fqn} must be discovered before it can be debugged; found: ${discovered.join(', ')}`,
    );
    const item = findItem(api.testController.items, fqn);
    assert.ok(item, `the TestItem for ${fqn} must exist`);
    return item;
  }

  /** Press the Debug button on `items`. */
  async function debugRun(items: readonly vscode.TestItem[]): Promise<void> {
    const api = await activateTestExplorer();
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, items);
  }

  test('an F# backtick test whose FQN contains SPACES debugs and breaks in its body', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the name itself is the hard part. A space is not filter
    // grammar, so it must be substituted verbatim ([TEST-FILTER-ESCAPE]); an
    // escaped or truncated name selects no test and the Debug press ends in
    // silence.
    const item = await rowFor(FS_SPACED);
    eq(FS_SPACED.includes(' '), true, 'the fixture name really does contain spaces');
    eq(item.id, FS_SPACED, 'and the tree carries it verbatim as the id');
    eq(item.label, 'adds two numbers with spaces', 'labelled with the backtick binding');
    eq(item.children.size, 0, 'an F# module-level test is a LEAF, like any other test');

    // Interaction 2 — arm a breakpoint inside the F# body and debug it.
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-call')]);
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint armed inside the F# binding');
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging an F# test');
    assertHandshakeOrder(recorder, 'debugging an F# test');
    assertBoundAtLines(
      recorder,
      [FS_SOURCE.dapLine('fs-call')],
      'a breakpoint inside an F# test binding',
    );

    // Interaction 3 — it stops IN the F# source, with F# locals readable. The
    // F# compiler's PDB gaps ([DEBUG-FSHARP-PDB]) are about state machines, not
    // about plain `let` bindings: these must be inspectable.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop in the F# test');
    assertStopReason(stop, 'breakpoint', 'a breakpoint inside an F# test');
    neq(stop.hitBreakpointIds.length, 0, 'naming the breakpoint it hit');
    const active = requireActive('an F# breakpoint stop');
    const frame = await topFrame(active, stop.threadId);
    eq(frame.line, FS_SOURCE.dapLine('fs-call'), 'on the armed line of the .fs file');
    eq(
      comparablePath(frame.sourcePath),
      comparablePath(fixture.sourceFile),
      'attributed to the F# source the user wrote, not to a generated file',
    );
    eq(
      variableNamed(await localsOf(active, frame.id), 'seed').value,
      '20',
      'an F# `let` binding is a local the debugger can read',
    );
    eq(
      (await evaluate(active, 'seed', frame.id, 'watch')).value,
      '20',
      'and the watch window evaluates in the F# frame',
    );
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    deepEq(stubs.log.errorMessages, [], 'a working F# test debug run reports no error');
  });

  test('an F# stack shows the module helper ABOVE the backtick test that called it', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — arm the private module-level helper, one frame deeper
    // than the test.
    const item = await rowFor(FS_SPACED);
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-add-body')]);
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging into an F# helper');
    assertBoundAtLines(
      recorder,
      [FS_SOURCE.dapLine('fs-add-body')],
      'a breakpoint in a private F# helper',
    );

    // Interaction 2 — the stack must carry BOTH frames. A stack that stops at
    // the helper proves only that the assembly loaded, not that the F# test is
    // the thing being debugged.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop in the F# helper');
    const active = requireActive('a stop in an F# helper');
    const frames = await stackFrames(active, stop.threadId);
    const names = frames.map((each) => methodOf(each));
    assert.ok(
      frames.length >= 2,
      `the F# stack must carry the caller too; got ${names.join(' <- ')}`,
    );
    eq(
      names.some((name) => name.includes('add')),
      true,
      `the innermost frame is the helper; frames: ${names.join(' <- ')}`,
    );
    const helperFrame = requireAt(frames, 0, 'the F# helper frame');
    eq(helperFrame.line, FS_SOURCE.dapLine('fs-add-body'), 'stopped on the armed helper line');
    eq(
      variableNamed(await localsOf(active, helperFrame.id), 'left').value,
      '20',
      'carrying the argument the F# test applied',
    );

    // Interaction 3 — stepping out returns to the backtick test's own frame, in
    // the user's own file: Just My Code, in F#.
    const { frame: afterStepOut } = await stepToFrame(recorder, CMD_STEP_OUT);
    eq(
      comparablePath(afterStepOut.sourcePath),
      comparablePath(fixture.sourceFile),
      'stepping out of an F# helper lands back in the .fs file, not in the xUnit runner',
    );
    assert.ok(
      afterStepOut.line > 0,
      'and on a real source line — a zero line is a frame with no PDB mapping',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  test('an F# [<Theory>] breaks once per row, each with its own arguments', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the F# theory is ONE row in the tree, under one name.
    const item = await rowFor(FS_ROWS);
    eq(item.id, FS_ROWS, 'one fully-qualified name for both rows');
    eq(item.id.startsWith(`${FS_MODULE}.`), true, 'qualified by the F# MODULE, not by a class');
    eq(item.id.includes('('), false, 'and carrying no row data into the filter grammar');
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-rows-body')]);
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging an F# theory');

    // Interaction 2 — the first row stops, inside the F# body.
    const first = requireAt(await recorder.waitForStops(1), 0, 'the first F# row');
    assertStopReason(first, 'breakpoint', 'the first row of an F# theory');
    const firstActive = requireActive('the first F# row');
    const firstFrame = await topFrame(firstActive, first.threadId);
    eq(firstFrame.line, FS_SOURCE.dapLine('fs-rows-body'), 'on the armed line');
    const firstExpected = variableNamed(
      await localsOf(firstActive, firstFrame.id),
      'expected',
    ).value;

    // Interaction 3 — continuing reaches the SECOND row, with the other
    // arguments, in the same session.
    await gesture(CMD_CONTINUE);
    const second = requireAt(await recorder.waitForStops(2), 1, 'the second F# row');
    assertStopReason(second, 'breakpoint', 'the second row of an F# theory');
    const secondActive = requireActive('the second F# row');
    const secondFrame = await topFrame(secondActive, second.threadId);
    eq(secondFrame.line, firstFrame.line, 'the same body, run a second time');
    deepEq(
      [
        firstExpected,
        variableNamed(await localsOf(secondActive, secondFrame.id), 'expected').value,
      ].sort(),
      ['3', '30'],
      'each F# row carries its own [<InlineData>] arguments, once each',
    );
    eq(sessions.ours.length, 1, 'both rows ran in the ONE session the selection started');
  });

  test('Debug Test at the cursor debugs the F# binding the caret is in', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the editor entry point of [TEST-STATUS-LENS]: the user
    // puts the caret in a test and presses the Debug lens, never touching the
    // Testing view. It must reach the same debugger the Testing view does —
    // a command that resolves nothing is exactly how "Debug Test does nothing"
    // presents (issue #233).
    await rowFor(FS_SPACED);
    const document = await vscode.workspace.openTextDocument(fixture.sourceUri);
    const editor = await vscode.window.showTextDocument(document);
    const caret = FS_SOURCE.line('fs-call');
    editor.selection = new vscode.Selection(caret, 4, caret, 4);
    eq(editor.selection.active.line, caret, 'the caret sits inside the F# test binding');
    eq(
      comparablePath(document.uri.fsPath),
      comparablePath(fixture.sourceFile),
      'in the fixture the tests were discovered from',
    );
    eq(document.languageId, 'fsharp', 'and the editor knows it is F#');

    // Interaction 2 — arm a breakpoint and fire the at-cursor command.
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-call')]);
    await vscode.commands.executeCommand(
      CMD_TEST_DEBUG_AT_CURSOR,
      fixture.sourceUri,
      'adds two numbers with spaces',
    );
    const session = assertOneTestSession(sessions, 'debugging at the cursor');
    eq(session.configuration['justMyCode'], true, 'with the same Just My Code contract');

    // Interaction 3 — it breaks in the binding the caret was in, and nothing
    // was reported to the user as a refusal.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the at-cursor stop');
    assertStopReason(stop, 'breakpoint', 'a breakpoint reached by the at-cursor gesture');
    const frame = await topFrame(requireActive('the at-cursor stop'), stop.threadId);
    eq(frame.line, FS_SOURCE.dapLine('fs-call'), 'on the line the caret was on');
    eq(
      comparablePath(frame.sourcePath),
      comparablePath(fixture.sourceFile),
      'in the file the caret was in',
    );
    deepEq(
      stubs.log.warningMessages,
      [],
      'a discovered test debugged at the cursor must not warn that it could not be found',
    );
    deepEq(stubs.log.errorMessages, [], 'nor report an error');
  });
});
