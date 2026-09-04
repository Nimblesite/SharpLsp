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
  FS_MODULE_NAMESPACE,
  FS_MODULE_TYPE,
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
import { closeAllEditors, comparablePath, deepEq, eq, neq, requireAt } from './test-helpers';
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
    // Interaction 4 - the DAP conversation behind that one gesture. F# is not
    // a special case at the protocol layer either: the same handshake, the same
    // capability table, the same single termination.
    eq(recorder.events('initialized').length, 1, 'one `initialized` event for the F# session');
    eq(recorder.events('terminated').length, 1, 'and exactly one termination');
    eq(
      recorder.responses('configurationDone').length >= 1,
      true,
      'configurationDone was ANSWERED before the gesture settled ([DEBUG-FEATURES-TESTS] rule 2)',
    );
    eq(
      recorder.capabilities()['supportsConditionalBreakpoints'],
      true,
      'the capability table is language-agnostic and must hold for an F# test host',
    );
    eq(recorder.capabilities()['supportsSetVariable'], true, 'value editing included');
    eq(sessions.ours.length, 1, 'one F# test, one session');
    eq(recorder.stops().length, 1, 'and exactly one stop: the breakpoint the user armed');
    eq(vscode.debug.breakpoints.length, 1, 'the breakpoint survives the session ending');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(recorder.exits, [], 'and no adapter process exiting under the session');
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
    // Interaction 4 - the whole F# stack AT THE HELPER STOP, not only the two
    // frames the walk touched. A test host runs the user's code under the xUnit
    // runner, so the frames beneath must be there and must be distinguishable
    // from the user's. After the step-out the helper frame is gone by design.
    const wholeStack = frames;
    eq(wholeStack.length >= 2, true, 'an F# helper called from a test is at least two deep');
    eq(
      wholeStack.filter(
        (entry) => comparablePath(entry.sourcePath) === comparablePath(fixture.sourceFile),
      ).length >= 2,
      true,
      'both user frames resolve to the .fs file the user wrote',
    );
    eq(
      new Set(wholeStack.map((entry) => entry.id)).size,
      wholeStack.length,
      'every frame carries its own handle, or selecting a caller reads the callee',
    );
    eq(
      wholeStack.every((entry) => entry.line >= 0),
      true,
      'and a line the editor can point at',
    );
    eq(
      wholeStack.length > 2,
      true,
      'the xUnit runner frames sit beneath both - a stack that stopped at the test method is ' +
        'truncated, not filtered',
    );
    eq(sessions.ours.length, 1, 'all of it inside the ONE session the Debug press started');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
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
    // Interaction 4 - a theory is ONE test in the tree however many rows it
    // runs, and one session however many times it stops ([TEST-RUN-TRX]).
    const theoryRow = await rowFor(FS_ROWS);
    eq(theoryRow.id, FS_ROWS, 'the theory is addressed by the single name its rows share');
    eq(theoryRow.children.size, 0, 'and is a LEAF - one row per [<InlineData>] is two tests');
    eq(recorder.stops().length, 2, 'two rows, two stops, and no third');
    eq(
      recorder.stops().every((entry) => entry.reason === 'breakpoint'),
      true,
      'each of them a breakpoint stop, never a step the user never asked for',
    );
    eq(
      recorder.stops().every((entry) => entry.threadId !== 0),
      true,
      'each naming the thread it stopped',
    );
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint served both rows');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
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
    // Interaction 4 - the at-cursor gesture must reach the SAME machinery the
    // Testing view does: one real session, a complete handshake, and a tree
    // left exactly as it was.
    assertHandshakeOrder(recorder, 'the at-cursor F# gesture');
    assertBoundAtLines(recorder, [FS_SOURCE.dapLine('fs-call')], 'the at-cursor F# breakpoint');
    eq(sessions.ours.length, 1, 'the editor gesture starts ONE session, exactly as the tree does');
    eq(recorder.events('terminated').length <= 1, true, 'and terminates it at most once');
    const api = await activateTestExplorer();
    const stillThere = findItem(api.testController.items, FS_SPACED);
    assert.ok(stillThere, 'the binding is still a row after being debugged from the editor');
    eq(stillThere.id, FS_SPACED, 'under its own name, spaces preserved exactly');
    eq(stillThere.children.size, 0, 'and still a leaf');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  test('debugging the F# MODULE row debugs every binding under it, in one session', async function () {
    this.timeout(DEBUG_TEST_MS);

    // An F# module renders as Assembly → Namespace → Class → Test like anything
    // else, because that is what it COMPILES to: `Fs.Debug.Fixtures` is a CLR
    // type named `Fixtures` in namespace `Fs.Debug`, so the module row is the
    // CLASS level and carries the type's own name, not the dotted path
    // (`testing.ts`: "deterministic for C# namespaces and dotted F# modules
    // alike"). The module row is still the group the user right-clicks.
    // [TEST-RUN-TRX] makes it ONE invocation for the whole selection.
    //
    // Interaction 1 — reach the module row through a leaf, and check it holds
    // every binding the fixture declares.
    const leaf = await rowFor(FS_SPACED);
    const moduleRow = leaf.parent;
    assert.ok(moduleRow, 'an F# binding hangs off the module it is declared in');
    eq(moduleRow.label, FS_MODULE_TYPE, 'and that group is the module, by its TYPE name');
    const namespaceRow = moduleRow.parent;
    assert.ok(namespaceRow, 'and the module hangs off the namespace enclosing it');
    eq(namespaceRow.label, FS_MODULE_NAMESPACE, 'which is the module path without the type');
    eq(
      `${namespaceRow.label}.${moduleRow.label}`,
      FS_MODULE,
      'so namespace and class rejoin to exactly the F# module the fixture declares',
    );
    eq(moduleRow.children.size, FS_ALL.length, 'holding every binding the fixture declares');
    eq(moduleRow.canResolveChildren, true, 'and declaring them, so the row expands');
    neq(moduleRow.id, FS_SPACED, 'a group id is never a fully-qualified test name');

    // Interaction 2 — arm the spaced binding and the module HELPER both
    // bindings call, then debug the module once.
    vscode.debug.addBreakpoints([
      breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-seed'),
      breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-add-body'),
    ]);
    eq(vscode.debug.breakpoints.length, 2, 'one breakpoint in a test body, one in the helper');
    await debugRun([moduleRow]);
    assertOneTestSession(sessions, 'debugging an F# module');
    assertHandshakeOrder(recorder, 'debugging an F# module');
    assertBoundAtLines(
      recorder,
      [FS_SOURCE.dapLine('fs-add-body'), FS_SOURCE.dapLine('fs-seed')],
      'both armed lines of an F# module debug',
    );

    // Interaction 3 — the first stop is real, in F# code, in this fixture's own
    // file. A module debug that resolved to the wrong assembly stops nowhere.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the first stop of a module debug');
    assertStopReason(stop, 'breakpoint', 'debugging an F# module');
    const frame = await topFrame(requireActive('the module stop'), stop.threadId);
    eq(
      comparablePath(frame.sourcePath ?? ''),
      comparablePath(fixture.sourceFile),
      'the stop is in the fixture source the user armed, not in a framework file',
    );
    eq(sessions.ours.length, 1, 'a module is ONE session, not one per binding');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
    // Interaction 4 - the module row is a GROUP, and a group is one invocation
    // ([TEST-RUN-TRX]). Its id must never be a test name, and every binding
    // under it must still be addressable afterwards.
    eq(moduleRow.id.includes(FS_MODULE_TYPE), true, 'the group id names the module');
    eq(FS_MODULE.startsWith(FS_MODULE_NAMESPACE), true, 'which sits under its own namespace');
    eq(recorder.events('terminated').length <= 1, true, 'one group is at most one termination');
    eq(sessions.ours.length, 1, 'and exactly one session throughout');
    for (const fqn of FS_ALL) {
      const item = findItem((await activateTestExplorer()).testController.items, fqn);
      assert.ok(item, fqn + ' must still be a row after the module was debugged');
      eq(item.id, fqn, 'under its own name');
      eq(item.children.size, 0, 'and still a leaf');
    }
    deepEq(stubs.log.warningMessages, [], 'debugging a module warns about nothing');
  });

  test('debugging an F# selection of BOTH bindings runs both under one session', async function () {
    this.timeout(DEBUG_TEST_MS);

    // [TEST-FILTER-ESCAPE]: an F# backtick name carries SPACES, which are not
    // grammar and must not be escaped, and multiple selected tests are OR-ed
    // with an UNESCAPED pipe. A multi-select is where both rules meet.
    //
    // Interaction 1 — select every binding the fixture exposes.
    const rows = [] as vscode.TestItem[];
    for (const fqn of FS_ALL) rows.push(await rowFor(fqn));
    eq(rows.length, FS_ALL.length, 'every F# binding resolved to a row');
    deepEq(
      rows.map((row) => row.id),
      [...FS_ALL],
      'each under its own fully-qualified name, spaces and all',
    );
    eq(
      FS_SPACED.includes(' '),
      true,
      'the fixture really does declare an idiomatic backtick binding',
    );

    // Interaction 2 — arm the shared helper, which BOTH bindings call, then
    // debug the selection.
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-add-body')]);
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint, in the helper both bindings call');
    await debugRun(rows);
    assertOneTestSession(sessions, 'debugging an F# multi-select');
    assertBoundAtLines(
      recorder,
      [FS_SOURCE.dapLine('fs-add-body')],
      'the shared helper of an F# multi-select',
    );

    // Interaction 3 — the helper is reached more than once, because more than
    // one selected binding called it, and all of it happens in ONE session.
    const first = requireAt(await recorder.waitForStops(1), 0, 'the first helper stop');
    assertStopReason(first, 'breakpoint', 'an F# multi-select debug');
    eq(
      methodOf(await topFrame(requireActive('the first helper stop'), first.threadId)),
      'add',
      'the top frame is the module helper the breakpoint sits in',
    );
    await gesture(CMD_CONTINUE);
    const stops = await recorder.waitForStops(2);
    eq(
      stops.length >= 2,
      true,
      'both selected bindings call the helper, so it is reached more than once in the one run',
    );
    eq(sessions.ours.length, 1, 'and a selection is ONE session, never one per test');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    // Interaction 4 - the filter the selection produced. [TEST-FILTER-ESCAPE]
    // makes SPACES not grammar and the joining pipe UNESCAPED, and a
    // multi-select of two F# bindings is where both rules meet.
    eq(rows.length, 2, 'exactly the two bindings the fixture declares were selected');
    eq(
      rows.every((row) => row.children.size === 0),
      true,
      'both of them leaves',
    );
    eq(
      rows.every((row) => row.id.startsWith(FS_MODULE)),
      true,
      'both under the module the fixture declares',
    );
    eq(sessions.ours.length, 1, 'a selection is ONE session, never one per test');
    eq(recorder.events('terminated').length <= 1, true, 'and at most one termination');
    eq(
      recorder.stops().every((entry) => entry.reason === 'breakpoint'),
      true,
      'every stop was the armed helper breakpoint, not a step or an exception',
    );
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
  });

  test('an F# debug run leaves the tree and the spaced ids exactly as they were', async function () {
    this.timeout(DEBUG_TEST_MS);

    // A debug run is still a run: the Testing view must survive it unchanged,
    // and an F# id carrying SPACES must survive it VERBATIM — a round trip that
    // trimmed or escaped one would leave a row that can never be run again.
    //
    // Interaction 1 — the tree before.
    const api = await activateTestExplorer();
    const before = await discoverSolution(api, fixture.solutionPath, FS_ALL);
    deepEq([...before].sort(), [...FS_ALL].sort(), 'the F# fixture is fully discovered');
    eq(
      before.filter((id) => id.trim() !== id).length,
      0,
      'no discovered id carries leading or trailing padding',
    );
    eq(
      before.filter((id) => id.includes('\\')).length,
      0,
      'and none carries a filter escape — escaping is applied at run time, never to the id',
    );

    // Interaction 2 — debug one binding with nothing armed, so the run goes
    // straight through to termination.
    const row = await rowFor(FS_SPACED);
    eq(vscode.debug.breakpoints.length, 0, 'the user has armed nothing');
    await debugRun([row]);
    assertOneTestSession(sessions, 'debugging an F# binding with nothing armed');
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    deepEq(recorder.stops(), [], 'with no breakpoint armed, a debug run must never stop');
    deepEq(recorder.errors, [], 'and no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');

    // Interaction 3 — the tree, and every id in it, is byte-for-byte what it was.
    const after = await discoverSolution(api, fixture.solutionPath, FS_ALL);
    deepEq([...after].sort(), [...before].sort(), 'a debug run adds, drops and reorders nothing');
    for (const fqn of FS_ALL) {
      const item = findItem(api.testController.items, fqn);
      assert.ok(item, `${fqn} must still be a row after a debug run`);
      eq(item.id, fqn, 'under its own name, spaces preserved exactly');
      eq(item.children.size, 0, 'and still a leaf');
    }
    eq(sessions.ours.length, 1, 'exactly one debug session was started');
    // Interaction 4 - and the RESULT cache is untouched by a debug run. A debug
    // session is a diagnostic, not a run: repainting the tree green because the
    // user stepped through a test is a result nobody produced.
    const api2 = await activateTestExplorer();
    for (const fqn of FS_ALL) {
      const item = findItem(api2.testController.items, fqn);
      assert.ok(item, fqn + ' must still be a row');
      neq(item.label, '', fqn + ' must still be labelled for the user to read');
      eq(item.error, undefined, fqn + ' must not be marked errored by a debug run');
    }
    eq(recorder.events('terminated').length, 1, 'exactly one termination');
    eq(recorder.stops().length, 0, 'and no stop, because nothing was armed');
    eq(vscode.debug.breakpoints.length, 0, 'the Breakpoints view is still empty');
    deepEq(stubs.log.warningMessages, [], 'a clean debug run warns about nothing');
  });
});
