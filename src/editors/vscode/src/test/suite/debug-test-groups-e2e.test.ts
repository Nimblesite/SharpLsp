// Debugging a SELECTION bigger than one test: the class row, the namespace row,
// the assembly root, a multi-select across two classes, and the edge the other
// three hide — a test that is NOT in the selection must not be debugged.
//
// Implements [DEBUG-FEATURES-TESTS] "Debug entire test class/suite | DAP +
// sharplsp/testDebug | P2", with [TEST-RUN-TRX]'s rule that a run is ONE
// invocation for the whole selection — so a class of twenty tests is one debug
// session, not twenty.
//
// One test at a time lives in `debug-test-debugging-e2e.test.ts`.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DapRecorder } from './debug-dap-kit';
import { CMD_CONTINUE, assertStopReason, gesture, methodOf, topFrame } from './debug-drive-kit';
import { assertBoundAtLines, clearAllBreakpoints, stopDebuggee } from './debug-suite-kit';
import {
  CS_ADDS,
  CS_ALL,
  CS_MATH_NAMESPACE,
  CS_MULTIPLIES,
  CS_PROJECT,
  CS_SOURCE,
  CS_TEXT,
  CS_TEXT_NAMESPACE,
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
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import { closeAllEditors, deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** How many tests the fixture declares in its first class. */
const MATH_CLASS_TESTS = 5;

suite('Debug a SELECTION — class, namespace, assembly and multi-select', () => {
  let fixture: TestDebugFixture;
  let recorder: DapRecorder;
  let sessions: DebugSessionRecorder;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    fixture = await writeDebugTestFixture('debug-testgroups-', 'csharp');
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

  /** Discover the fixture and hand back the settled assembly root. */
  async function assemblyRoot(): Promise<vscode.TestItem> {
    const api = await activateTestExplorer();
    await discoverSolution(api, fixture.solutionPath, CS_ALL);
    const roots = rootsOf(api.testController.items);
    const root = roots.find((item) => item.label === CS_PROJECT);
    assert.ok(root, `the ${CS_PROJECT} assembly root must exist; saw ${roots.length} root(s)`);
    return root;
  }

  /** The group row labelled `label` directly under `parent`. */
  function groupUnder(parent: vscode.TestItem, label: string): vscode.TestItem {
    const child = rootsOf(parent.children).find((item) => item.label === label);
    assert.ok(
      child,
      `${parent.label} must hold a '${label}' group; it held ${rootsOf(parent.children)
        .map((item) => item.label)
        .join(' | ')}`,
    );
    return child;
  }

  /** Press the Debug button on `items`. */
  async function debugRun(items: readonly vscode.TestItem[]): Promise<void> {
    const api = await activateTestExplorer();
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, items);
  }

  /** The method names of the first `count` stops, sorted. */
  async function stoppedMethods(count: number): Promise<string[]> {
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const stops = await recorder.waitForStops(index + 1);
      const stop = requireAt(stops, index, `stop ${String(index + 1)}`);
      assertStopReason(stop, 'breakpoint', `stop ${String(index + 1)} of a group debug`);
      names.push(
        methodOf(await topFrame(requireActive(`stop ${String(index + 1)}`), stop.threadId)),
      );
      if (index + 1 < count) await gesture(CMD_CONTINUE);
    }
    return [...names].sort();
  }

  test('debugging the CLASS row breaks in every test the class contains', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — reach the class row the user right-clicks.
    const root = await assemblyRoot();
    const namespaceRow = groupUnder(root, CS_MATH_NAMESPACE);
    const classRow = groupUnder(namespaceRow, 'CalculatorTests');
    eq(classRow.label, 'CalculatorTests', 'the group above a test is its CLASS');
    eq(classRow.children.size, MATH_CLASS_TESTS, 'holding every test declared in that class');
    eq(classRow.canResolveChildren, true, 'and declaring them, so the row expands');
    neq(classRow.id, classRow.label, 'a group id is qualified by the assembly it belongs to');

    // Interaction 2 — arm one breakpoint in each of two of its tests, then
    // debug the class ONCE.
    vscode.debug.addBreakpoints([
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed'),
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'multiplies-seed'),
    ]);
    eq(vscode.debug.breakpoints.length, 2, 'one breakpoint armed in each of two test bodies');
    await debugRun([classRow]);
    assertOneTestSession(sessions, 'debugging a class');
    assertHandshakeOrder(recorder, 'debugging a class');
    assertBoundAtLines(
      recorder,
      [CS_SOURCE.dapLine('adds-seed'), CS_SOURCE.dapLine('multiplies-seed')],
      'both armed test bodies of a class-level debug',
    );

    // Interaction 3 — both tests break, in the ONE session, whichever order the
    // runner scheduled them in. A session that stopped once and ran on would
    // debug only whichever test happened to be scheduled first.
    deepEq(
      await stoppedMethods(2),
      ['Adds_Two_Numbers', 'Multiplies_Two_Numbers'],
      'debugging a class breaks in each of its tests, not twice in one of them',
    );
    eq(sessions.ours.length, 1, 'and one class is ONE session, not one per test');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
  });

  test('debugging the NAMESPACE row leaves the OTHER namespace alone', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the fixture declares two namespaces, so a namespace row
    // is a real subset of the assembly rather than another name for it.
    const root = await assemblyRoot();
    const mathRow = groupUnder(root, CS_MATH_NAMESPACE);
    const textRow = groupUnder(root, CS_TEXT_NAMESPACE);
    neq(mathRow.id, textRow.id, 'two namespaces, two distinct group rows');
    eq(rootsOf(root.children).length, 2, 'and the assembly holds exactly those two');
    eq(mathRow.canResolveChildren, true, 'each is expandable');

    // Interaction 2 — arm a breakpoint in BOTH namespaces, then debug only one
    // of them. The other namespace's breakpoint is the control.
    vscode.debug.addBreakpoints([
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed'),
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'text-seed'),
    ]);
    eq(vscode.debug.breakpoints.length, 2, 'one breakpoint in each namespace');
    await debugRun([mathRow]);
    assertOneTestSession(sessions, 'debugging a namespace');

    // Interaction 3 — the selected namespace breaks…
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop in the selected namespace');
    assertStopReason(stop, 'breakpoint', 'a namespace-level debug');
    const frame = await topFrame(requireActive('a namespace debug'), stop.threadId);
    eq(methodOf(frame), 'Adds_Two_Numbers', 'in a test belonging to the selected namespace');

    // …and the OTHER namespace never runs. [TEST-RUN-TRX] makes a run one
    // invocation for THE SELECTION; a debug that widened to the whole assembly
    // stops here too and would look identical from the first stop alone.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(
      recorder.stops().length,
      1,
      `debugging ${CS_MATH_NAMESPACE} must not execute a test in ${CS_TEXT_NAMESPACE}: the ` +
        'control breakpoint there BOUND, so a second stop is proof the selection widened',
    );
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  test('debugging the ASSEMBLY root debugs every namespace under it, in one session', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the top row of the Testing view: the whole project.
    const root = await assemblyRoot();
    eq(
      root.id.startsWith('assembly:'),
      true,
      `the top row is an ASSEMBLY group, never an FQN; got ${root.id}`,
    );
    eq(root.label, CS_PROJECT, 'labelled with the project it was built from');
    eq(rootsOf(root.children).length, 2, 'holding both namespaces');

    // Interaction 2 — arm one breakpoint per namespace and debug the root.
    vscode.debug.addBreakpoints([
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed'),
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'text-seed'),
    ]);
    await debugRun([root]);
    assertOneTestSession(sessions, 'debugging the assembly root');
    assertBoundAtLines(
      recorder,
      [CS_SOURCE.dapLine('adds-seed'), CS_SOURCE.dapLine('text-seed')],
      'a breakpoint in each namespace of the assembly',
    );

    // Interaction 3 — both namespaces break, inside the ONE session the
    // selection started.
    deepEq(
      await stoppedMethods(2),
      ['Adds_Two_Numbers', 'Joins_Two_Words'],
      'debugging the assembly reaches tests in EVERY namespace it contains',
    );
    eq(sessions.ours.length, 1, 'a whole assembly is still one `dotnet test` and one session');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  test('a MULTI-SELECT of two classes debugs both, and nothing else', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — ctrl-click two tests from two different classes, and
    // leave a third test out of the selection as the control.
    const api = await activateTestExplorer();
    await discoverSolution(api, fixture.solutionPath, CS_ALL);
    const first = findItem(api.testController.items, CS_ADDS);
    const second = findItem(api.testController.items, CS_TEXT);
    const excluded = findItem(api.testController.items, CS_MULTIPLIES);
    assert.ok(first && second && excluded, 'all three fixture tests must be discovered');
    neq(first.parent?.id, second.parent?.id, 'the two selected tests are in different classes');
    eq(excluded.id, CS_MULTIPLIES, 'and the control test is a third, unselected one');

    // Interaction 2 — arm a breakpoint in all THREE, then debug only two.
    vscode.debug.addBreakpoints([
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed'),
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'text-seed'),
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'multiplies-seed'),
    ]);
    eq(vscode.debug.breakpoints.length, 3, 'three breakpoints armed, two tests selected');
    await debugRun([first, second]);
    assertOneTestSession(sessions, 'debugging a multi-select');
    assertBoundAtLines(
      recorder,
      // In LINE order, not the order they were armed in: VS Code's debug model
      // sorts by uri then line (`sortAndDeDup`) before it sends them, and DAP
      // requires the response array to correspond to the request array — so the
      // adapter answers ascending, and asserting the arming order would be
      // asserting something the workbench provably never sends.
      [
        CS_SOURCE.dapLine('adds-seed'),
        CS_SOURCE.dapLine('multiplies-seed'),
        CS_SOURCE.dapLine('text-seed'),
      ],
      'every armed breakpoint binds, whether or not its test was selected',
    );

    // Interaction 3 — the two selected tests break; the third never runs, so
    // its bound breakpoint is never hit. A selection that widened to the class,
    // the namespace or the assembly fails right here.
    const methods = await stoppedMethods(2);
    deepEq(
      methods,
      ['Adds_Two_Numbers', 'Joins_Two_Words'],
      'both selected tests break, one stop each',
    );
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(
      recorder.stops().length,
      2,
      'and exactly two stops in total: the unselected test must never have executed',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  test('debugging a group with no breakpoints runs every test in it to completion', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — the user presses Debug on a class row with nothing armed.
    const root = await assemblyRoot();
    const classRow = groupUnder(groupUnder(root, CS_MATH_NAMESPACE), 'CalculatorTests');
    deepEq(vscode.debug.breakpoints, [], 'nothing is armed anywhere');
    eq(classRow.children.size, MATH_CLASS_TESTS, 'and the class holds several tests');

    // Interaction 2 — a session still starts, for the whole class.
    await debugRun([classRow]);
    const session = assertOneTestSession(sessions, 'debugging a class with nothing armed');
    eq(session.configuration['justMyCode'], true, 'Just My Code holds for a group debug too');

    // Interaction 3 — and it ends by itself, having stopped nowhere.
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    deepEq(
      recorder.stops(),
      [],
      'no breakpoint, no stop: halting a class-level debug run nobody armed would strand ' +
        'every remaining test in the class',
    );
    deepEq(recorder.errors, [], 'and no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'nor an error the user has to dismiss');
  });

  test('debugging a group does not fabricate outcomes for the tests it contains', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — snapshot every outcome the class's tests currently hold.
    const api = await activateTestExplorer();
    await discoverSolution(api, fixture.solutionPath, CS_ALL);
    const root = await assemblyRoot();
    const classRow = groupUnder(groupUnder(root, CS_MATH_NAMESPACE), 'CalculatorTests');
    const before = JSON.stringify(
      CS_ALL.map((id) => [id, api.testController.getResult(id) ?? null]),
    );
    const cacheSize = api.testController.cachedResults.size;

    // Interaction 2 — debug the whole class through to the end.
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed')]);
    await debugRun([classRow]);
    assertOneTestSession(sessions, 'debugging a class');
    await recorder.waitForStops(1);
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);

    // Interaction 3 — [TEST-RUN-TRX] attributes outcomes from the TRX report a
    // RUN writes. A debug session collects none, so it must report none: a
    // class-level debug that painted five rows green would be reporting results
    // nobody measured.
    eq(
      JSON.stringify(CS_ALL.map((id) => [id, api.testController.getResult(id) ?? null])),
      before,
      'every test in the debugged class keeps the outcome its last real RUN produced',
    );
    eq(api.testController.cachedResults.size, cacheSize, 'and the cache gains no entry');
    eq(rootsOf(api.testController.items).length, 1, 'the tree still has its single root');
    eq(
      groupUnder(await assemblyRoot(), CS_MATH_NAMESPACE).children.size,
      1,
      'and that namespace still holds its one class',
    );
  });
});
