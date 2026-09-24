// Debugging an F# test on Microsoft.Testing.Platform through the Test
// Explorer's Debug profile, end to end, with a real adapter.
//
// The C# MTP debug suite proves the module waits and the attach lands. F# is
// where that has to hold with everything F# brings: a backtick binding whose
// id carries SPACES, a module that IS the class, an F# `[<Theory>]` whose rows
// are separate uids under one id, and the editor's at-cursor gesture. The
// fixture is the same anchored F# source the VSTest F# suite debugs, built on
// `xunit.v3` and opted in with `global.json`, so every difference between the
// two suites is the runner and nothing else.
//
// Implements [TEST-MTP-DEBUG] and the "Debug individual test", "Breakpoints
// inside test methods" and "Expecto/FsCheck test debugging (F# parity)" rows of
// [DEBUG-FEATURES-TESTS].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CMD_TEST_DEBUG_AT_CURSOR } from '../../constants.js';
import { DapRecorder } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  assertStopReason,
  evaluate,
  gesture,
  localsOf,
  methodOf,
  topFrame,
  variableNamed,
} from './debug-drive-kit';
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
  type TestDebugFixture,
} from './debug-test-kit';
import {
  debugRun,
  useDebugTestFixture,
  firstBreakpointStop,
  caretInSource,
} from './debug-test-harness';
import { DEBUG_TYPE_ID, DebugSessionRecorder } from './run-debug-kit';
import {
  activateTestExplorer,
  discoverSolution,
  findItem,
  runViaProfile,
} from './test-explorer-kit';
import { assertPassed, cachedFor } from './test-explorer-outcome-assertions';
import { comparablePath, deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS } from './test-timeouts';
import { type UiStubs } from './ui-stubs';

suite('Debug an F# MTP test — backtick names, theory rows and the at-cursor gesture', () => {
  let fixture: TestDebugFixture;
  let recorder: DapRecorder;
  let sessions: DebugSessionRecorder;
  let stubs: UiStubs;

  const harness = useDebugTestFixture('debug-mtp-fs-', 'fsharp', 'mtp');
  setup(() => {
    ({ fixture, recorder, sessions, stubs } = harness());
  });

  /** Discover the F# MTP fixture and return the tree row for `fqn`. */
  async function rowFor(fqn: string): Promise<vscode.TestItem> {
    const api = await activateTestExplorer();
    const discovered = await discoverSolution(api, fixture.solutionPath, FS_ALL);
    assert.ok(discovered.includes(fqn), `${fqn} must be discovered: ${discovered.join(', ')}`);
    const item = findItem(api.testController.items, fqn);
    assert.ok(item, `the TestItem for ${fqn} must exist`);
    return item;
  }

  test('an F# backtick test on MTP attaches to the module and breaks in its body', async function () {
    this.timeout(DEBUG_TEST_MS);

    // 1. The spaced id reaches the tree verbatim, from the module's own listing
    //    — which, unlike VSTest's, carries the binding's location.
    const item = await rowFor(FS_SPACED);
    eq(item.id, FS_SPACED, 'the tree carries the spaced id verbatim');
    eq(item.label, 'adds two numbers with spaces', 'labelled with the backtick binding');
    eq(item.children.size, 0, 'a module-level binding is a leaf');
    eq(comparablePath(item.uri?.fsPath ?? ''), comparablePath(fixture.sourceFile), 'in Tests.fs');
    const api = await activateTestExplorer();
    const cachedBefore = api.testController.getResult(FS_SPACED);

    // 2. Arm the call line and press Debug: ONE session, ATTACHED to the
    //    waiting module's pid — never launched, never the extension host.
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-call')]);
    await debugRun([item]);
    const session = assertOneTestSession(sessions, 'debugging an F# MTP test');
    eq(session.type, DEBUG_TYPE_ID, 'the SharpLsp adapter attached');
    eq(session.configuration['request'], 'attach', 'an MTP module is attached to');
    neq(Number(session.configuration['processId']), process.pid, 'the module, not the host');
    eq(session.configuration['justMyCode'], true, 'Just My Code holds in a test context');
    assertHandshakeOrder(recorder, 'debugging an F# MTP test');
    // 3. It stops IN the F# binding, with its `let` bindings readable and the
    //    watch window evaluating in the F# frame.
    const stop = await firstBreakpointStop(recorder, FS_SOURCE, 'fs-call');
    const active = requireActive('an F# MTP breakpoint stop');
    const frame = await topFrame(active, stop.threadId);
    eq(frame.line, FS_SOURCE.dapLine('fs-call'), 'on the armed line of the .fs file');
    eq(comparablePath(frame.sourcePath), comparablePath(fixture.sourceFile), 'in Tests.fs');
    eq(variableNamed(await localsOf(active, frame.id), 'seed').value, '20', 'an F# local');
    eq((await evaluate(active, 'seed', frame.id, 'watch')).value, '20', 'and a watch on it');

    // 4. Continue: the module runs to the end, ONE stop, no error, and a debug
    //    run writes no result ([TEST-MTP-DEBUG]).
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(recorder.stops().length, 1, 'one stop, on the armed line');
    deepEq(recorder.errors, [], 'no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'a working F# MTP debug run reports no error');
    await api.testController.whenIdle();
    deepEq(api.testController.getResult(FS_SPACED), cachedBefore, 'the cache is untouched');
  });

  test('an F# [<Theory>] on MTP breaks once per row, then ▶ reports the real result', async function () {
    this.timeout(DEBUG_TEST_MS);

    // 1. ONE row in the tree for both uids, qualified by the F# module.
    const item = await rowFor(FS_ROWS);
    eq(item.id, FS_ROWS, 'one id for both rows');
    assert.ok(item.id.startsWith(`${FS_MODULE}.`), 'qualified by the F# module');
    eq(item.children.size, 0, 'a theory is ONE leaf, however many rows it runs');
    const api = await activateTestExplorer();
    const cachedBefore = api.testController.getResult(FS_ROWS);
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-rows-body')]);
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging an F# MTP theory');

    // 2. Both rows stop in the one session, each with its own [<InlineData>].
    const first = requireAt(await recorder.waitForStops(1), 0, 'the first F# row');
    assertStopReason(first, 'breakpoint', 'the first row of an F# MTP theory');
    const firstActive = requireActive('the first F# row');
    const firstFrame = await topFrame(firstActive, first.threadId);
    eq(firstFrame.line, FS_SOURCE.dapLine('fs-rows-body'), 'on the armed line');
    eq(methodOf(firstFrame), 'adds rows', 'in the backtick binding, by its F# name');
    const firstExpected = variableNamed(await localsOf(firstActive, firstFrame.id), 'expected');
    await gesture(CMD_CONTINUE);
    const second = requireAt(await recorder.waitForStops(2), 1, 'the second F# row');
    const secondActive = requireActive('the second F# row');
    const secondFrame = await topFrame(secondActive, second.threadId);
    const secondExpected = variableNamed(await localsOf(secondActive, secondFrame.id), 'expected');
    deepEq([firstExpected.value, secondExpected.value].sort(), ['3', '30'], 'each row, once');
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(recorder.stops().length, 2, 'two rows, two stops, and no third');
    eq(sessions.ours.length, 1, 'both rows in ONE session');

    // 3. The debug run wrote nothing; ▶ afterwards reports the theory's real
    //    verdict from the module's own report.
    await api.testController.whenIdle();
    deepEq(api.testController.getResult(FS_ROWS), cachedBefore, 'Debug writes nothing');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, FS_ROWS), FS_ROWS);
    deepEq(stubs.log.errorMessages, [], 'nothing reported to the user as a failure');
  });

  test('Debug Test at the cursor debugs the F# MTP binding the caret is in', async function () {
    this.timeout(DEBUG_TEST_MS);

    // 1. The caret sits in the spaced binding of the MTP module's source.
    await rowFor(FS_SPACED);
    await caretInSource(fixture, FS_SOURCE, 'fs-call', 'fsharp');

    // 2. Arm and fire the at-cursor command: the same attach the tree makes.
    vscode.debug.addBreakpoints([breakpointAt(FS_SOURCE, fixture.sourceUri, 'fs-call')]);
    await vscode.commands.executeCommand(
      CMD_TEST_DEBUG_AT_CURSOR,
      fixture.sourceUri,
      'adds two numbers with spaces',
    );
    const session = assertOneTestSession(sessions, 'debugging an F# MTP test at the cursor');
    eq(session.configuration['request'], 'attach', 'to the waiting module');
    eq(session.configuration['justMyCode'], true, 'with the same Just My Code contract');
    // 3. It breaks where the caret was, and nothing warns or errors.
    const stop = await firstBreakpointStop(recorder, FS_SOURCE, 'fs-call');
    const frame = await topFrame(requireActive('the at-cursor stop'), stop.threadId);
    eq(frame.line, FS_SOURCE.dapLine('fs-call'), 'on the line the caret was on');
    eq(comparablePath(frame.sourcePath), comparablePath(fixture.sourceFile), 'in that file');
    deepEq(stubs.log.warningMessages, [], 'a discovered MTP test is found at the cursor');
    deepEq(stubs.log.errorMessages, [], 'nor reports an error');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });
});
