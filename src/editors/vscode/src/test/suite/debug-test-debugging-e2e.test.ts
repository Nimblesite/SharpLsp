// Debugging a unit test: the Test Explorer's Debug profile, the debug-at-cursor
// gesture, and a breakpoint inside a test method.
//
// Implements [DEBUG-FEATURES-TESTS]: "Debug individual test | DAP +
// sharplsp/testDebug | P1", "Breakpoints inside test methods | Standard line
// breakpoints | P1", "Just My Code in test context | launch config | P1" and
// "Debug entire test class/suite | DAP + sharplsp/testDebug | P2", together with
// that section's closing rule — SharpLsp sets `VSTEST_HOST_DEBUG=1` and attaches
// to the waiting test host, NOT to the parent `dotnet test`.
//
// The Test Explorer's own discovery and run semantics belong to the
// test-explorer suites; what is asserted here is the DEBUG session that a debug
// run must produce, and whether a breakpoint in the test body is honoured.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AnchoredSource } from './debug-anchors';
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
import { XUNIT_PACKAGES, createSolution, projectXml } from './dotnet-project-kit';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';
import {
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  fakeFolder,
  type ObservedSession,
} from './run-debug-kit';
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
  removeDirRecursive,
  requireAt,
  requireWorkspaceRoot,
} from './test-helpers';
import { DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** The project the debug run drives. */
const PROJECT = 'DebugTestTarget';

/** The class every fixture test lives in — the group a class-level debug uses. */
const TEST_CLASS = 'DebugTestTarget.CalculatorTests';

/** The fully-qualified test the Test Explorer must expose. */
const TEST_FQN = `${TEST_CLASS}.Adds_Two_Numbers`;

/** A SECOND test in the same class, so "debug the whole class" means something. */
const OTHER_FQN = `${TEST_CLASS}.Multiplies_Two_Numbers`;

/** The test body, anchored so no line number is ever written by hand. */
const TEST_SOURCE = new AnchoredSource(
  `
using Xunit;

namespace DebugTestTarget;

public class CalculatorTests
{
    private static int Add(int left, int right)
    {
        var sum = left + right;                                        // @anchor:add-body
        return sum;                                                    // @anchor:add-return
    }

    private static int Multiply(int left, int right)
    {
        return left * right;                                           // @anchor:multiply-body
    }

    [Fact]
    public void Adds_Two_Numbers()
    {
        var seed = 20;                                                 // @anchor:test-seed
        var result = Add(seed, 22);                                    // @anchor:test-call
        Assert.Equal(42, result);                                      // @anchor:test-assert
    }

    [Fact]
    public void Multiplies_Two_Numbers()
    {
        var factor = 6;                                                // @anchor:other-seed
        var result = Multiply(factor, 7);                              // @anchor:other-call
        Assert.Equal(42, result);                                      // @anchor:other-assert
    }
}
`
    .trim()
    .split('\n'),
);

/** A `SourceBreakpoint` on the anchored line of the test source. */
function breakpointOn(uri: vscode.Uri, anchor: string): vscode.SourceBreakpoint {
  return new vscode.SourceBreakpoint(new vscode.Location(uri, TEST_SOURCE.position(anchor)));
}

/** Assert a debug session was started for the test run, and hand it back. */
function requireDebugSession(sessions: DebugSessionRecorder): ObservedSession {
  assert.ok(
    sessions.ours.length > 0,
    '[DEBUG-FEATURES-TESTS] makes "Debug individual test" a P1 row: the Debug run profile must ' +
      'start a real `sharplsp-coreclr` session. Running the test WITHOUT a debugger attached ' +
      'is the silent degradation this row exists to prevent — the run goes green, the ' +
      'breakpoints never bind, and the user concludes their code is unreachable',
  );
  return requireAt(sessions.ours, 0, 'the debug session the test run started');
}

/** The live session, asserted still attached at a stop. */
function requireActive(why: string): vscode.DebugSession {
  const active = vscode.debug.activeDebugSession;
  assert.ok(active, `${why}: the debug session must still be live at the stop`);
  return active;
}

/**
 * Assert the DAP launch handshake that has to precede any stop.
 *
 * A breakpoint the workbench sent AFTER `configurationDone` races the debuggee,
 * and a session that never sent `configurationDone` at all leaves the adapter
 * waiting for configuration it will never receive — both of which present as
 * "the breakpoint did nothing", the very report [DEBUG-FEATURES-TESTS] exists
 * to make impossible.
 */
function assertHandshakeOrder(recorder: DapRecorder): void {
  const order = recorder.requestOrder();
  eq(order[0], 'initialize', `the DAP conversation opens with initialize; saw ${order.join(' -> ')}`);
  eq(
    order.includes('configurationDone'),
    true,
    `the workbench must finish configuration; observed: ${order.join(' -> ')}`,
  );
  eq(
    order.indexOf('setBreakpoints') < order.indexOf('configurationDone'),
    true,
    `breakpoints must be configured BEFORE configurationDone; observed: ${order.join(' -> ')}`,
  );
  eq(recorder.events('initialized').length, 1, 'the adapter announces `initialized` exactly once');
  deepEq(recorder.errors, [], 'a conforming debug session produces no adapter transport error');
}

suite('Debug a unit test — the Test Explorer Debug profile and test breakpoints', () => {
  let scratchDir: string;
  let projectDir: string;
  let sourceFile: string;
  let sourceUri: vscode.Uri;
  let solutionPath: string;
  let recorder: DapRecorder;
  let sessions: DebugSessionRecorder;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    scratchDir = fs.mkdtempSync(path.join(requireWorkspaceRoot(), 'debug-testrun-'));
    isolateFromRepoMsbuild(scratchDir);
    projectDir = path.join(scratchDir, PROJECT);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${PROJECT}.csproj`),
      projectXml(XUNIT_PACKAGES),
      'utf8',
    );
    sourceFile = path.join(projectDir, 'CalculatorTests.cs');
    fs.writeFileSync(sourceFile, TEST_SOURCE.text, 'utf8');
    sourceUri = vscode.Uri.file(sourceFile);
    solutionPath = await createSolution(scratchDir, 'DebugTests', [projectDir]);
  });

  suiteTeardown(() => {
    removeDirRecursive(scratchDir);
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

  // Implements [DEBUG-FEATURES-TESTS] "Debug individual test" and
  // "Breakpoints inside test methods", both P1.
  test('the Debug profile starts a session and stops inside the test body', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — discover the tests the way the Test Explorer does, and
    // check the row the user is about to press ▶🐞 on is the test itself.
    const api = await activateTestExplorer();
    const discovered = await discoverSolution(api, solutionPath, [TEST_FQN, OTHER_FQN]);
    eq(
      discovered.includes(TEST_FQN),
      true,
      `the fixture test must be discovered before it can be debugged; found: ${discovered.join(', ')}`,
    );
    const item = findItem(api.testController.items, TEST_FQN);
    assert.ok(item, `the TestItem for ${TEST_FQN} must exist`);
    eq(item.label, 'Adds_Two_Numbers', 'a test row is labelled with its method name');
    eq(item.id, TEST_FQN, 'and identified by the FQN the debug filter substitutes');
    eq(item.children.size, 0, 'a test is a LEAF — a debuggable row, not a group');
    assert.ok(item.parent, 'and hangs off the class group the class-level debug uses');

    // Interaction 2 — the Debug profile must exist at all, exactly once, and be
    // distinct from ▶: they are two buttons with two behaviours.
    const profile = profileOfKind(api.testController, vscode.TestRunProfileKind.Debug);
    const debugProfiles = api.testController.profiles.filter(
      (candidate) => candidate.kind === vscode.TestRunProfileKind.Debug,
    );
    eq(
      profile.kind,
      vscode.TestRunProfileKind.Debug,
      'the Test Explorer must contribute a Debug run profile — it is the ▶-with-a-bug button ' +
        'and the only entry point "Debug individual test" has',
    );
    eq(debugProfiles.length, 1, 'one Debug profile: two make the gesture ambiguous in the menu');
    assert.ok(profile.label.trim() !== '', 'the profile needs a label the user can identify');
    neq(
      profileOfKind(api.testController, vscode.TestRunProfileKind.Run),
      profile,
      'Debug must not be the Run profile wearing another label',
    );

    // Interaction 3 — arm a breakpoint INSIDE the test method, then debug it.
    vscode.debug.addBreakpoints([breakpointOn(sourceUri, 'test-call')]);
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint is armed inside the test body');
    const armed = vscode.debug.breakpoints[0];
    assert.ok(armed instanceof vscode.SourceBreakpoint, 'armed as a SOURCE breakpoint');
    eq(
      comparablePath(armed.location.uri.fsPath),
      comparablePath(sourceFile),
      'the workbench must keep the breakpoint on the test file it was set in',
    );
    eq(armed.location.range.start.line, TEST_SOURCE.line('test-call'), 'and on the armed line');
    eq(armed.enabled, true, 'an armed breakpoint is enabled — a disabled one never binds');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [item]);

    // Interaction 4 — a real debug session must have started, once.
    const session = requireDebugSession(sessions);
    eq(session.type, DEBUG_TYPE_ID, 'the test debug run must use the SharpLsp debugger');
    eq(
      sessions.ours.length,
      1,
      `debugging ONE test starts ONE session; started: ${sessions.ours
        .map((observed) => observed.name)
        .join(', ')}`,
    );
    assert.ok(session.name.trim() !== '', 'the session needs a name the CALL STACK view can show');
    eq(
      session.configuration['justMyCode'],
      true,
      '"Just My Code in test context | launch config | P1": without it, stepping out of a ' +
        'test lands the user inside the xUnit runner',
    );
    eq(
      session.configuration['type'],
      DEBUG_TYPE_ID,
      'the configuration the session carries must name the SharpLsp adapter',
    );

    // Interaction 5 — the DAP handshake, and the breakpoint that BOUND. A
    // hollow, unverified breakpoint is the failure mode that looks like success.
    assertHandshakeOrder(recorder);
    assertBoundAtLines(
      recorder,
      [TEST_SOURCE.dapLine('test-call')],
      'a breakpoint inside a test method ([DEBUG-FEATURES-TESTS] P1)',
    );

    // Interaction 6 — the session stopped, ON that breakpoint.
    const stops = await recorder.waitForStops(1);
    const stop = requireAt(stops, 0, 'the stop inside the test method');
    assertStopReason(stop, 'breakpoint', 'a breakpoint inside a test method');
    neq(
      stop.hitBreakpointIds.length,
      0,
      'the stop must name the breakpoint it hit — an unattributed stop could be anything',
    );
    neq(stop.threadId, 0, 'a stop identifies the thread the test is running on');

    // Interaction 7 — the stop must be in the TEST, with its own state readable.
    const active = requireActive('a breakpoint stop');
    const frame = await topFrame(active, stop.threadId);
    eq(
      methodOf(frame),
      'Adds_Two_Numbers',
      `a breakpoint inside a test method must stop IN that method; stopped in '${frame.name}'`,
    );
    eq(
      frame.line,
      TEST_SOURCE.dapLine('test-call'),
      'and on the armed line, not on the method entry',
    );
    eq(
      comparablePath(frame.sourcePath),
      comparablePath(sourceFile),
      'and in the user’s OWN file — a frame with no source is a debugger with no symbols',
    );
    const locals = await localsOf(active, frame.id);
    eq(
      variableNamed(locals, 'seed').value,
      '20',
      'the test’s own locals must be inspectable — the whole reason to debug a test',
    );
    eq(
      (await evaluate(active, 'seed + 22', frame.id, 'watch')).value,
      '42',
      'and a WATCH expression must evaluate in the test’s frame, not in the runner’s',
    );

    // Interaction 8 — continuing runs the test to green and ends the session,
    // rather than leaving the host wedged on a breakpoint forever.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1);
    deepEq(stubs.log.errorMessages, [], 'a working test debug run reports no error');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-TESTS]'s closing rule: attach to the test HOST.
  test('the session attaches to the test host, not to the parent dotnet test', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — discover and arm a breakpoint one frame deeper, in the
    // helper the test calls, so the whole stack can be inspected.
    const api = await activateTestExplorer();
    await discoverSolution(api, solutionPath, [TEST_FQN, OTHER_FQN]);
    const item = findItem(api.testController.items, TEST_FQN);
    assert.ok(item, `the TestItem for ${TEST_FQN} must exist`);
    vscode.debug.addBreakpoints([breakpointOn(sourceUri, 'add-body')]);
    eq(vscode.debug.breakpoints.length, 1, 'exactly one breakpoint is armed, in the helper');

    // Interaction 2 — debug the single test.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [item]);
    const session = requireDebugSession(sessions);
    eq(session.type, DEBUG_TYPE_ID, 'the debug run uses the SharpLsp adapter');
    eq(sessions.ours.length, 1, 'one selected test, one session');

    // Interaction 3 — the session must not be pointed at the `dotnet` CLI. The
    // parent `dotnet test` process only spawns the host; attaching to it means
    // no user code is ever loaded into the debugged process.
    const program = String(session.configuration['program'] ?? '');
    eq(
      path.basename(program).startsWith('dotnet') && !program.endsWith('.dll'),
      false,
      'the closing rule of [DEBUG-FEATURES-TESTS]: SharpLsp "attaches to the waiting ' +
        '`testhost.exe`/`dotnet-testhost` child, not the parent `dotnet test` process". ' +
        `The session named '${program}'`,
    );
    if (session.configuration['request'] === 'attach') {
      const pid = Number(session.configuration['processId']);
      assert.ok(pid > 0, 'an attach configuration must carry the pid of the waiting test host');
      neq(
        pid,
        process.pid,
        'and that pid is the TEST HOST — attaching the debugger to the extension host itself ' +
          'would freeze the editor the moment the breakpoint hit',
      );
    }

    // Interaction 4 — the breakpoint one frame deeper must still be hit, and the
    // call stack must show the test that called it.
    assertBoundAtLines(recorder, [TEST_SOURCE.dapLine('add-body')], 'a breakpoint in a helper');
    const stops = await recorder.waitForStops(1);
    const stop = requireAt(stops, 0, 'the stop inside the helper');
    assertStopReason(stop, 'breakpoint', 'a breakpoint in a helper a test calls');
    const active = requireActive('a stop in a helper');
    const frames = await stackFrames(active, stop.threadId);
    const names = frames.map((frame) => methodOf(frame));
    eq(
      names.includes('Add'),
      true,
      `the innermost frame must be the helper the test called; frames: ${names.join(' <- ')}`,
    );
    eq(
      names.includes('Adds_Two_Numbers'),
      true,
      'the test method must appear BELOW it: a stack that stops at the helper proves only the ' +
        'assembly loaded, not that the test host is the debugged process',
    );
    eq(
      names.indexOf('Add') < names.indexOf('Adds_Two_Numbers'),
      true,
      `the callee is ABOVE its caller in a DAP stack; frames: ${names.join(' <- ')}`,
    );
    const helperFrame = requireAt(frames, 0, 'the helper frame');
    eq(helperFrame.line, TEST_SOURCE.dapLine('add-body'), 'the helper stopped on the armed line');
    const helperLocals = await localsOf(active, helperFrame.id);
    eq(
      variableNamed(helperLocals, 'left').value,
      '20',
      'the helper’s arguments must carry the values the test passed',
    );
    eq(variableNamed(helperLocals, 'right').value, '22', 'both of them, not just the first');

    // Interaction 5 — stepping OUT of the helper lands back in the test, in the
    // user's own code. "Just My Code in test context" is what keeps that landing
    // out of the xUnit runner's internals.
    const { frame: afterStepOut } = await stepToFrame(recorder, CMD_STEP_OUT);
    eq(
      methodOf(afterStepOut),
      'Adds_Two_Numbers',
      `stepping out of a helper returns to the TEST; landed in '${afterStepOut.name}'`,
    );
    eq(
      comparablePath(afterStepOut.sourcePath),
      comparablePath(sourceFile),
      'in the test file the user is looking at, not in a decompiled runner frame',
    );
    assert.ok(
      fakeFolder(requireWorkspaceRoot()).uri.fsPath.length > 0,
      'the workspace folder the session is bound to must exist',
    );
    deepEq(stubs.log.errorMessages, [], 'a working test debug run reports no error');
  });

  // Implements [DEBUG-FEATURES-TESTS] "Debug entire test class/suite | P2".
  // A distinct GESTURE — ▶🐞 on the class row, not on a test row — so it cannot
  // be folded into the single-test interactions above.
  test('debugging the CLASS group breaks in every test the class contains', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — reach the class row the user actually right-clicks.
    const api = await activateTestExplorer();
    await discoverSolution(api, solutionPath, [TEST_FQN, OTHER_FQN]);
    const leaf = findItem(api.testController.items, TEST_FQN);
    assert.ok(leaf, `${TEST_FQN} must be discovered`);
    const classItem = leaf.parent;
    assert.ok(classItem, `${TEST_FQN} must hang off a class group`);
    eq(classItem.label, 'CalculatorTests', 'the group above a test is its CLASS');
    eq(
      classItem.children.size,
      2,
      'and it holds every test in the class — a group that holds one cannot prove the P2 row',
    );

    // Interaction 2 — arm a breakpoint in BOTH tests, then debug the class once.
    vscode.debug.addBreakpoints([
      breakpointOn(sourceUri, 'test-seed'),
      breakpointOn(sourceUri, 'other-seed'),
    ]);
    eq(vscode.debug.breakpoints.length, 2, 'one breakpoint armed in each test body');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [classItem]);

    // Interaction 3 — ONE session for the whole class, not one per test:
    // [TEST-RUN-TRX] makes a run one `dotnet test` invocation for the selection.
    const session = requireDebugSession(sessions);
    eq(
      sessions.ours.length,
      1,
      `debugging a class is one session, not one per test; started ${String(sessions.ours.length)}`,
    );
    eq(session.configuration['justMyCode'], true, 'Just My Code holds for a class-level debug too');
    assertHandshakeOrder(recorder);
    assertBoundAtLines(
      recorder,
      [TEST_SOURCE.dapLine('test-seed'), TEST_SOURCE.dapLine('other-seed')],
      'both test bodies armed for a class-level debug',
    );

    // Interaction 4 — the first test breaks, and continuing reaches the SECOND.
    // A session that stopped once and then ran to the end would debug only
    // whichever test the runner happened to schedule first.
    const first = requireAt(await recorder.waitForStops(1), 0, 'the first test’s stop');
    assertStopReason(first, 'breakpoint', 'the first test in a class-level debug');
    neq(first.hitBreakpointIds.length, 0, 'and names the breakpoint it hit');
    const firstFrame = await topFrame(requireActive('the first stop'), first.threadId);
    await gesture(CMD_CONTINUE);
    const second = requireAt(await recorder.waitForStops(2), 1, 'the second test’s stop');
    assertStopReason(second, 'breakpoint', 'the second test in a class-level debug');
    const secondFrame = await topFrame(requireActive('the second stop'), second.threadId);

    // Interaction 5 — the two stops are the two DIFFERENT tests, whichever order
    // the runner chose, each on its own armed line and in the user's own file.
    deepEq(
      [methodOf(firstFrame), methodOf(secondFrame)].sort(),
      ['Adds_Two_Numbers', 'Multiplies_Two_Numbers'],
      'debugging a class must break in each of its tests, not twice in one of them',
    );
    deepEq(
      [firstFrame.line, secondFrame.line].sort((left, right) => left - right),
      [TEST_SOURCE.dapLine('test-seed'), TEST_SOURCE.dapLine('other-seed')].sort(
        (left, right) => left - right,
      ),
      'and on the lines the user armed, one per test',
    );
    eq(
      comparablePath(secondFrame.sourcePath),
      comparablePath(sourceFile),
      'the second stop is in the user’s own test file too',
    );
    deepEq(stubs.log.errorMessages, [], 'a class-level debug run reports no error');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });
});
