// Debugging a unit test: the Test Explorer's Debug profile, the debug-at-cursor
// gesture, and a breakpoint inside a test method.
//
// Implements [DEBUG-FEATURES-TESTS]: "Debug individual test | DAP +
// sharplsp/testDebug | P1", "Breakpoints inside test methods | Standard line
// breakpoints | P1" and "Just My Code in test context | launch config | P1",
// together with that section's closing rule — SharpLsp sets `VSTEST_HOST_DEBUG=1`
// and attaches to the waiting test host, NOT to the parent `dotnet test`.
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
  assertStopReason,
  localsOf,
  methodOf,
  stackFrames,
  topFrame,
  variableNamed,
} from './debug-drive-kit';
import { clearAllBreakpoints, stopDebuggee } from './debug-suite-kit';
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
  deepEq,
  eq,
  removeDirRecursive,
  requireAt,
  requireWorkspaceRoot,
} from './test-helpers';
import { DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** The project the debug run drives. */
const PROJECT = 'DebugTestTarget';

/** The fully-qualified test the Test Explorer must expose. */
const TEST_FQN = 'DebugTestTarget.CalculatorTests.Adds_Two_Numbers';

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

    [Fact]
    public void Adds_Two_Numbers()
    {
        var seed = 20;                                                 // @anchor:test-seed
        var result = Add(seed, 22);                                    // @anchor:test-call
        Assert.Equal(42, result);                                      // @anchor:test-assert
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

    // Interaction 1 — discover the test the way the Test Explorer does.
    const api = await activateTestExplorer();
    const discovered = await discoverSolution(api, solutionPath, [TEST_FQN]);
    eq(
      discovered.includes(TEST_FQN),
      true,
      `the fixture test must be discovered before it can be debugged; found: ${discovered.join(', ')}`,
    );
    const item = findItem(api.testController.items, TEST_FQN);
    assert.ok(item, `the TestItem for ${TEST_FQN} must exist`);

    // Interaction 2 — the Debug profile must exist at all.
    const profile = profileOfKind(api.testController, vscode.TestRunProfileKind.Debug);
    eq(
      profile.kind,
      vscode.TestRunProfileKind.Debug,
      'the Test Explorer must contribute a Debug run profile — it is the ▶-with-a-bug button ' +
        'and the only entry point "Debug individual test" has',
    );
    assert.ok(profile.label.trim() !== '', 'the profile needs a label the user can identify');

    // Interaction 3 — arm a breakpoint INSIDE the test method, then debug it.
    vscode.debug.addBreakpoints([breakpointOn(sourceUri, 'test-call')]);
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint is armed inside the test body');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [item]);

    // Interaction 4 — a real debug session must have started, and stopped.
    const session = requireDebugSession(sessions);
    eq(session.type, DEBUG_TYPE_ID, 'the test debug run must use the SharpLsp debugger');
    eq(
      session.configuration['justMyCode'],
      true,
      '"Just My Code in test context | launch config | P1": without it, stepping out of a ' +
        'test lands the user inside the xUnit runner',
    );
    const stops = await recorder.waitForStops(1);
    const stop = requireAt(stops, 0, 'the stop inside the test method');
    assertStopReason(stop, 'breakpoint', 'a breakpoint inside a test method');

    // Interaction 5 — the stop must be in the TEST, with its own state readable.
    const active = vscode.debug.activeDebugSession;
    assert.ok(active, 'the debug session must still be live at the stop');
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
      variableNamed(await localsOf(active, frame.id), 'seed').value,
      '20',
      'the test’s own locals must be inspectable — the whole reason to debug a test',
    );
    deepEq(stubs.log.errorMessages, [], 'a working test debug run reports no error');
  });

  // Implements [DEBUG-FEATURES-TESTS]'s closing rule: attach to the test HOST.
  test('the session attaches to the test host, not to the parent dotnet test', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — discover and arm a breakpoint one frame deeper, in the
    // helper the test calls, so the whole stack can be inspected.
    const api = await activateTestExplorer();
    await discoverSolution(api, solutionPath, [TEST_FQN]);
    const item = findItem(api.testController.items, TEST_FQN);
    assert.ok(item, `the TestItem for ${TEST_FQN} must exist`);
    vscode.debug.addBreakpoints([breakpointOn(sourceUri, 'add-body')]);

    // Interaction 2 — debug the single test.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [item]);
    const session = requireDebugSession(sessions);

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
      assert.ok(
        Number(session.configuration['processId']) > 0,
        'an attach configuration must carry the pid of the waiting test host',
      );
    }

    // Interaction 4 — the breakpoint one frame deeper must still be hit, and the
    // call stack must show the test that called it.
    const stops = await recorder.waitForStops(1);
    const stop = requireAt(stops, 0, 'the stop inside the helper');
    const active = vscode.debug.activeDebugSession;
    assert.ok(active, 'the debug session must still be live');
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
      variableNamed(await localsOf(active, requireAt(frames, 0, 'the helper frame').id), 'left')
        .value,
      '20',
      'the helper’s arguments must carry the values the test passed',
    );
    assert.ok(
      fakeFolder(requireWorkspaceRoot()).uri.fsPath.length > 0,
      'the workspace folder the session is bound to must exist',
    );
    deepEq(stubs.log.errorMessages, [], 'a working test debug run reports no error');
  });
});
