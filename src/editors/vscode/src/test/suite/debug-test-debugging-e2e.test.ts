// Debugging ONE test through the Test Explorer's Debug profile: the session it
// must start, the breakpoint inside the test body, and the shapes of test that
// are not a plain green fact — a failing one, a skipped one, a `[Theory]` whose
// rows run the same body twice, and a test debugged with nothing armed at all.
//
// Implements [DEBUG-FEATURES-TESTS]: "Debug individual test | DAP +
// sharplsp/testDebug | P1", "Breakpoints inside test methods | Standard line
// breakpoints | P1" and "Just My Code in test context | launch config | P1",
// together with that section's closing rule — SharpLsp sets `VSTEST_HOST_DEBUG=1`
// and attaches to the waiting `testhost.exe`/`dotnet-testhost` child, NOT to the
// parent `dotnet test` process.
//
// Selections bigger than one test — a class, a namespace, an assembly, a
// multi-select — live in `debug-test-groups-e2e.test.ts`; F# lives in
// `debug-test-fsharp-e2e.test.ts`, and F# is not the afterthought there.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
  CS_ADDS,
  CS_ALL,
  CS_FAILS,
  CS_ROWS,
  CS_SKIPPED,
  CS_SOURCE,
  assertHandshakeOrder,
  assertOneTestSession,
  breakpointAt,
  conditionalBreakpointAt,
  disabledBreakpointAt,
  requireActive,
  requireDebugSession,
  disposeDebugTestFixture,
  writeDebugTestFixture,
  type TestDebugFixture,
} from './debug-test-kit';
import { DEBUG_TYPE_ID, DebugSessionRecorder, fakeFolder } from './run-debug-kit';
import {
  activateTestExplorer,
  discoverSolution,
  findItem,
  profileOfKind,
  runViaProfile,
} from './test-explorer-kit';
import {
  closeAllEditors,
  comparablePath,
  deepEq,
  eq,
  neq,
  requireAt,
  requireWorkspaceRoot,
} from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

suite('Debug ONE test — the Test Explorer Debug profile and test breakpoints', () => {
  let fixture: TestDebugFixture;
  let recorder: DapRecorder;
  let sessions: DebugSessionRecorder;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    fixture = await writeDebugTestFixture('debug-testrun-', 'csharp');
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

  /** Discover the fixture and return the tree row for `fqn`. */
  async function rowFor(fqn: string): Promise<vscode.TestItem> {
    const api = await activateTestExplorer();
    const discovered = await discoverSolution(api, fixture.solutionPath, CS_ALL);
    eq(
      discovered.includes(fqn),
      true,
      `${fqn} must be discovered before it can be debugged; found: ${discovered.join(', ')}`,
    );
    const item = findItem(api.testController.items, fqn);
    assert.ok(item, `the TestItem for ${fqn} must exist`);
    eq(item.children.size, 0, `${fqn} is a test, so it is a LEAF the Debug button applies to`);
    return item;
  }

  /** Press the Debug button on `items`, exactly as the workbench does. */
  async function debugRun(items: readonly vscode.TestItem[]): Promise<void> {
    const api = await activateTestExplorer();
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, items);
  }

  // Implements "Debug individual test" and "Breakpoints inside test methods".
  test('the Debug profile starts a session and stops inside the test body', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — find the row the user is about to press the Debug button
    // on, and the profile that button maps to.
    const api = await activateTestExplorer();
    const item = await rowFor(CS_ADDS);
    eq(item.label, 'Adds_Two_Numbers', 'a test row is labelled with its method name');
    eq(item.id, CS_ADDS, 'and identified by the FQN the debug filter substitutes');
    const profile = profileOfKind(api.testController, vscode.TestRunProfileKind.Debug);
    eq(
      api.testController.profiles.filter(
        (candidate) => candidate.kind === vscode.TestRunProfileKind.Debug,
      ).length,
      1,
      'one Debug profile: two make the gesture ambiguous in the menu',
    );
    neq(
      profileOfKind(api.testController, vscode.TestRunProfileKind.Run),
      profile,
      'Debug must not be the Run profile wearing another label',
    );
    assert.ok(profile.label.trim() !== '', 'the profile needs a label the user can identify');

    // Interaction 2 — arm a breakpoint INSIDE the test method, then debug it.
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-call')]);
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint is armed inside the test body');
    const armed = vscode.debug.breakpoints[0];
    assert.ok(armed instanceof vscode.SourceBreakpoint, 'armed as a SOURCE breakpoint');
    eq(
      comparablePath(armed.location.uri.fsPath),
      comparablePath(fixture.sourceFile),
      'the workbench keeps it on the test file it was set in',
    );
    eq(armed.location.range.start.line, CS_SOURCE.line('adds-call'), 'and on the armed line');
    eq(armed.enabled, true, 'an armed breakpoint is enabled — a disabled one never binds');
    await debugRun([item]);

    // Interaction 3 — one real session, a complete handshake, and a breakpoint
    // that BOUND. A hollow, unverified breakpoint is the failure that looks
    // like success: the run goes green and nothing ever stops.
    assertOneTestSession(sessions, 'debugging one test');
    assertHandshakeOrder(recorder, 'debugging one test');
    assertBoundAtLines(
      recorder,
      [CS_SOURCE.dapLine('adds-call')],
      'a breakpoint inside a test method ([DEBUG-FEATURES-TESTS] P1)',
    );

    // Interaction 4 — the session stopped ON that breakpoint, in the TEST, with
    // the test's own state readable.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop inside the test method');
    assertStopReason(stop, 'breakpoint', 'a breakpoint inside a test method');
    neq(stop.hitBreakpointIds.length, 0, 'the stop names the breakpoint it hit');
    neq(stop.threadId, 0, 'and the thread the test is running on');
    const active = requireActive('a breakpoint stop');
    const frame = await topFrame(active, stop.threadId);
    eq(methodOf(frame), 'Adds_Two_Numbers', `stopped in '${frame.name}', not in the test method`);
    eq(frame.line, CS_SOURCE.dapLine('adds-call'), 'on the armed line, not on the method entry');
    eq(
      comparablePath(frame.sourcePath),
      comparablePath(fixture.sourceFile),
      'and in the user’s OWN file — a frame with no source is a debugger with no symbols',
    );
    eq(
      variableNamed(await localsOf(active, frame.id), 'seed').value,
      '20',
      'the test’s own locals are inspectable — the whole reason to debug a test',
    );
    eq(
      (await evaluate(active, 'seed + 22', frame.id, 'watch')).value,
      '42',
      'and a WATCH expression evaluates in the test’s frame, not in the runner’s',
    );

    // Interaction 5 — continuing runs the test to the end and ends the session,
    // rather than leaving the test host wedged on a breakpoint forever.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1);
    deepEq(stubs.log.errorMessages, [], 'a working test debug run reports no error');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-TESTS]'s closing rule: attach to the test HOST.
  test('the session ATTACHES to the waiting test host, not to the parent dotnet test', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — arm a breakpoint one frame deeper, in the helper the test
    // calls, so the whole stack can be inspected, and debug the single test.
    const item = await rowFor(CS_ADDS);
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'add-body')]);
    eq(vscode.debug.breakpoints.length, 1, 'exactly one breakpoint is armed, in the helper');
    await debugRun([item]);
    const session = assertOneTestSession(sessions, 'attaching to the test host');

    // Interaction 2 — the closing rule, to the letter. `VSTEST_HOST_DEBUG=1`
    // makes the test host WAIT for a debugger, and the debugger SharpLsp starts
    // must attach to that pid. A launch configuration, or an attach with no pid,
    // means the waiting host is never picked up and the user's Debug press ends
    // in silence (issue #233).
    eq(
      session.configuration['request'],
      'attach',
      'the closing rule of [DEBUG-FEATURES-TESTS]: SharpLsp "attaches to the waiting ' +
        '`testhost.exe`/`dotnet-testhost` child, not the parent `dotnet test` process". ' +
        `The session was a '${String(session.configuration['request'])}' request`,
    );
    const pid = Number(session.configuration['processId']);
    assert.ok(pid > 0, `an attach configuration must carry the waiting host's pid; got ${pid}`);
    neq(
      pid,
      process.pid,
      'and that pid is the TEST HOST — attaching to the extension host itself would freeze ' +
        'the editor the moment the breakpoint hit',
    );
    const program = String(session.configuration['program'] ?? '');
    eq(
      path.basename(program).startsWith('dotnet') && !program.endsWith('.dll'),
      false,
      `an attach must not name the dotnet muxer as its program; it named '${program}'`,
    );

    // Interaction 3 — the breakpoint one frame deeper is hit, and the call stack
    // shows the test that called it. A stack that stops at the helper proves
    // only that the assembly loaded, not that the test host is being debugged.
    assertBoundAtLines(recorder, [CS_SOURCE.dapLine('add-body')], 'a breakpoint in a helper');
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop inside the helper');
    assertStopReason(stop, 'breakpoint', 'a breakpoint in a helper a test calls');
    const active = requireActive('a stop in a helper');
    const frames = await stackFrames(active, stop.threadId);
    const names = frames.map((frame) => methodOf(frame));
    eq(
      names.includes('Add'),
      true,
      `the innermost frame is the helper; frames: ${names.join(' <- ')}`,
    );
    eq(names.includes('Adds_Two_Numbers'), true, 'and the test method appears below it');
    eq(
      names.indexOf('Add') < names.indexOf('Adds_Two_Numbers'),
      true,
      `the callee is ABOVE its caller in a DAP stack; frames: ${names.join(' <- ')}`,
    );
    const helperFrame = requireAt(frames, 0, 'the helper frame');
    eq(helperFrame.line, CS_SOURCE.dapLine('add-body'), 'the helper stopped on the armed line');
    const helperLocals = await localsOf(active, helperFrame.id);
    eq(variableNamed(helperLocals, 'left').value, '20', 'carrying the values the test passed');
    eq(variableNamed(helperLocals, 'right').value, '22', 'both of them, not just the first');

    // Interaction 4 — stepping OUT lands back in the test, in the user's own
    // code: that landing is what "Just My Code in test context" buys.
    const { frame: afterStepOut } = await stepToFrame(recorder, CMD_STEP_OUT);
    eq(
      methodOf(afterStepOut),
      'Adds_Two_Numbers',
      `stepping out of a helper returns to the TEST; landed in '${afterStepOut.name}'`,
    );
    eq(
      comparablePath(afterStepOut.sourcePath),
      comparablePath(fixture.sourceFile),
      'in the test file the user is looking at, not in a decompiled runner frame',
    );
    assert.ok(
      fakeFolder(requireWorkspaceRoot()).uri.fsPath.length > 0,
      'the workspace folder the session is bound to must exist',
    );
    deepEq(stubs.log.errorMessages, [], 'a working test debug run reports no error');
  });

  test('debugging with NO breakpoint armed still runs the test to completion', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the commonest accident: the user presses Debug having
    // forgotten to arm anything. That must still be a debug SESSION, not a
    // silent no-op, and not a hang.
    const item = await rowFor(CS_ADDS);
    deepEq(vscode.debug.breakpoints, [], 'nothing is armed anywhere in the workbench');
    await debugRun([item]);
    const session = assertOneTestSession(sessions, 'debugging with nothing armed');
    eq(session.type, DEBUG_TYPE_ID, 'and it is the SharpLsp adapter that started');

    // Interaction 2 — the session runs to the end on its own.
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    deepEq(
      recorder.stops(),
      [],
      'with nothing armed there is nothing to stop on: a `stopped` event here means the ' +
        'debugger halted the test host for a reason the user never asked for',
    );
    deepEq(recorder.errors, [], 'and the adapter reported no transport error');

    // Interaction 3 — and the workbench is left clean for the next gesture.
    deepEq(stubs.log.errorMessages, [], 'a breakpoint-free debug run is not an error');
    deepEq(vscode.debug.breakpoints, [], 'debugging must not invent breakpoints of its own');
  });

  test('debugging a FAILING test stops first, then lets the assertion throw', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — a red test is the one a user actually debugs. Arm the
    // line before the failing assertion.
    const item = await rowFor(CS_FAILS);
    eq(item.label, 'Fails_On_Purpose', 'the red test is the row being debugged');
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'fails-seed')]);
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging a failing test');
    assertBoundAtLines(recorder, [CS_SOURCE.dapLine('fails-seed')], 'a breakpoint in a red test');

    // Interaction 2 — it stops, and the value that is ABOUT to fail the
    // assertion is inspectable. That is the entire point of the gesture.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop in the failing test');
    assertStopReason(stop, 'breakpoint', 'a breakpoint in a failing test');
    const active = requireActive('a stop in a failing test');
    const frame = await topFrame(active, stop.threadId);
    eq(methodOf(frame), 'Fails_On_Purpose', 'stopped in the failing test');
    eq(frame.line, CS_SOURCE.dapLine('fails-seed'), 'on the armed line');
    eq(
      (await evaluate(active, '1 + 2', frame.id, 'watch')).value,
      '3',
      'and the frame evaluates expressions — 3, which the test asserts is 4',
    );

    // Interaction 3 — continuing lets xUnit's assertion throw and the session
    // end. A failing test must not leave the adapter in an error state, or the
    // NEXT debug press starts from a poisoned host.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    deepEq(recorder.errors, [], 'an assertion failure is not an adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'nor a SharpLsp error the user has to read');
    eq(
      recorder.stops().length,
      1,
      'the assertion throws INSIDE xUnit, which catches it: a caught exception must not stop ' +
        'the debuggee a second time',
    );
  });

  test('debugging a SKIPPED test starts a session whose body is never entered', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — a `[Fact(Skip=…)]` row is still a row the user can press
    // Debug on. Arm its body.
    const item = await rowFor(CS_SKIPPED);
    eq(item.label, 'Skipped_Test', 'the skipped test is a row like any other');
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'skipped-body')]);
    eq(vscode.debug.breakpoints.length, 1, 'armed inside a body that will never run');
    await debugRun([item]);

    // Interaction 2 — the gesture is honoured: a session starts, exactly as for
    // any other test. Refusing to start one would leave the user unable to tell
    // "skipped" from "the Debug button is broken".
    const session = assertOneTestSession(sessions, 'debugging a skipped test');
    eq(session.configuration['justMyCode'], true, 'with the same Just My Code contract');
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);

    // Interaction 3 — but the body is never entered, so nothing stops.
    deepEq(
      recorder.stops().map((stop) => stop.reason),
      [],
      'a skipped test is NOT EXECUTED, so a breakpoint in its body cannot be hit; a stop here ' +
        'means the runner ran a test the user marked Skip',
    );
    deepEq(recorder.errors, [], 'and the session ended without an adapter error');
    deepEq(stubs.log.errorMessages, [], 'debugging a skipped test is not an error condition');
  });

  test('debugging a [Theory] stops ONCE PER ROW, with each row’s own arguments', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — a theory is ONE row in the tree ([TEST-DISCOVERY-FQN]:
    // "no row data") but TWO executions of the same body.
    const item = await rowFor(CS_ROWS);
    eq(item.id, CS_ROWS, 'the theory is addressed by one fully-qualified name');
    eq(item.id.includes('('), false, 'carrying no row data, so no filter metacharacter');
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'rows-body')]);
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging a theory');
    assertBoundAtLines(recorder, [CS_SOURCE.dapLine('rows-body')], 'a breakpoint in a theory body');

    // Interaction 2 — the first row stops, and its arguments are the FIRST
    // row's, not the declaration's defaults.
    const first = requireAt(await recorder.waitForStops(1), 0, 'the first row’s stop');
    assertStopReason(first, 'breakpoint', 'the first row of a theory');
    const firstFrame = await topFrame(requireActive('the first row'), first.threadId);
    eq(methodOf(firstFrame), 'Adds_Rows', 'stopped in the theory body');
    const firstLocals = await localsOf(requireActive('the first row'), firstFrame.id);
    const firstExpected = variableNamed(firstLocals, 'expected').value;

    // Interaction 3 — continuing reaches the SECOND row, in the same session,
    // with DIFFERENT arguments. One stop for two rows would mean the debugger
    // saw only half the executions the test performs.
    await gesture(CMD_CONTINUE);
    const second = requireAt(await recorder.waitForStops(2), 1, 'the second row’s stop');
    assertStopReason(second, 'breakpoint', 'the second row of a theory');
    const secondFrame = await topFrame(requireActive('the second row'), second.threadId);
    eq(methodOf(secondFrame), 'Adds_Rows', 'the second stop is the same body, run again');
    eq(secondFrame.line, firstFrame.line, 'on the same armed line');
    const secondLocals = await localsOf(requireActive('the second row'), secondFrame.id);
    deepEq(
      [firstExpected, variableNamed(secondLocals, 'expected').value].sort(),
      ['3', '30'],
      'each stop carries ITS OWN row’s arguments — the two [InlineData] rows, once each',
    );
    eq(sessions.ours.length, 1, 'and both rows ran inside the ONE session the selection started');
    deepEq(recorder.errors, [], 'no adapter transport error across the two rows');
  });

  test('a breakpoint the user DISABLED is never honoured', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the user unticks the breakpoint in the Breakpoints view
    // rather than deleting it. It must reach the adapter as disabled, or not at
    // all — never as a live breakpoint.
    const item = await rowFor(CS_ADDS);
    vscode.debug.addBreakpoints([disabledBreakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-call')]);
    eq(vscode.debug.breakpoints.length, 1, 'the breakpoint is still in the workbench');
    eq(
      vscode.debug.breakpoints[0]?.enabled,
      false,
      'but disabled — the gutter shows it hollow and it must not stop anything',
    );

    // Interaction 2 — debugging still starts a session and still runs the test.
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging with a disabled breakpoint');
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);

    // Interaction 3 — and the disabled line is never stopped on.
    deepEq(
      recorder.stops().map((stop) => `${stop.reason}@${String(stop.threadId)}`),
      [],
      'a DISABLED breakpoint that still stops the debuggee is worse than one that never binds: ' +
        'the user turned it off and the debugger halted anyway',
    );
    deepEq(recorder.errors, [], 'and no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'nor a reported failure');
  });

  test('a CONDITIONAL breakpoint selects which row of a theory stops', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the theory runs its body twice; the condition picks the
    // second row. This is the only way a user debugs "the row that fails".
    const item = await rowFor(CS_ROWS);
    vscode.debug.addBreakpoints([
      conditionalBreakpointAt(CS_SOURCE, fixture.sourceUri, 'rows-body', 'expected == 30'),
    ]);
    eq(vscode.debug.breakpoints.length, 1, 'one conditional breakpoint is armed');
    await debugRun([item]);
    assertOneTestSession(sessions, 'debugging one row of a theory');

    // Interaction 2 — the condition reaches the adapter verbatim: an adapter
    // that never received it would stop on BOTH rows and still look correct
    // from the first stop alone.
    const requested = recorder.requests('setBreakpoints');
    const sent = requested[requested.length - 1]?.args['breakpoints'];
    assert.ok(Array.isArray(sent), '`setBreakpoints` must carry a breakpoints array');
    deepEq(
      (sent as Record<string, any>[]).map((entry) => entry['condition']),
      ['expected == 30'],
      'the condition the user typed is sent to the adapter unaltered',
    );

    // Interaction 3 — exactly ONE row stops, and it is the row the condition
    // names.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the conditional stop');
    assertStopReason(stop, 'breakpoint', 'a conditional breakpoint inside a theory');
    const active = requireActive('the conditional stop');
    const frame = await topFrame(active, stop.threadId);
    const locals = await localsOf(active, frame.id);
    eq(methodOf(frame), 'Adds_Rows', 'stopped in the theory body');
    eq(
      variableNamed(locals, 'expected').value,
      '30',
      'on the row the condition selected, not on the first row that reached the line',
    );
    eq(variableNamed(locals, 'left').value, '10', 'carrying that row’s own arguments');
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(
      recorder.stops().length,
      1,
      'and the other row ran straight through: a condition that stops every row is no condition',
    );
  });

  test('debugging is not a RUN: it caches no outcome and leaves the tree alone', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — record what the Testing view holds before the gesture.
    const api = await activateTestExplorer();
    const item = await rowFor(CS_ADDS);
    const before = api.testController.getResult(CS_ADDS);
    const cacheSize = api.testController.cachedResults.size;
    const treeBefore = api.testController.items.size;
    assert.ok(treeBefore > 0, 'the tree is populated before the debug gesture');

    // Interaction 2 — debug the test through to the end.
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed')]);
    await debugRun([item]);
    requireDebugSession(sessions);
    await recorder.waitForStops(1);
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);

    // Interaction 3 — a debug session executes under a debugger, so it must not
    // masquerade as a RUN: fabricating a pass here would paint the tree green
    // for a test whose outcome nobody collected from TRX ([TEST-RUN-TRX]).
    eq(
      api.testController.getResult(CS_ADDS),
      before,
      'debugging must leave the last real RUN’s outcome exactly as it was',
    );
    eq(api.testController.cachedResults.size, cacheSize, 'and add no cache entry of its own');
    eq(api.testController.items.size, treeBefore, 'nor change the shape of the tree');
    eq(
      findItem(api.testController.items, CS_ADDS)?.id,
      CS_ADDS,
      'the debugged test is still exactly where it was',
    );
  });
});
