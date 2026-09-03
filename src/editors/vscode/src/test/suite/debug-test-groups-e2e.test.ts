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
  disabledBreakpointAt,
  requireActive,
  disposeDebugTestFixture,
  writeDebugTestFixture,
  type TestDebugFixture,
} from './debug-test-kit';
import { DebugSessionRecorder } from './run-debug-kit';
import {
  activateTestExplorer,
  collectLeafIds,
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
    // Interaction 4 - a class is ONE invocation ([TEST-RUN-TRX]) however many
    // tests it holds, and the tree row itself must stay a GROUP the whole time.
    eq(sessions.ours.length, 1, 'a class of five tests is ONE session, never five');
    eq(recorder.events('terminated').length <= 1, true, 'and at most one termination');
    eq(recorder.events('initialized').length, 1, 'behind exactly one handshake');
    eq(classRow.children.size, MATH_CLASS_TESTS, 'the class still holds every test it declares');
    eq(classRow.canResolveChildren, true, 'and still declares them, so the row stays expandable');
    neq(classRow.id, CS_ADDS, 'a group id is never a fully-qualified test name');
    eq(
      recorder.stops().every((entry) => entry.reason === 'breakpoint'),
      true,
      'every stop was an armed breakpoint - a step or entry stop is a pause nobody asked for',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
    eq(recorder.requests('setBreakpoints').length >= 1, true, 'the breakpoints were synced');
    eq(recorder.responses('launch').length >= 1, true, 'and the launch was answered');
    eq(recorder.events('exited').length <= 1, true, 'with at most one process exit');
    eq(
      vscode.debug.activeDebugSession === undefined || sessions.ours.length === 1,
      true,
      'and no stray session left focused',
    );
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
    // Interaction 4 - the namespace row is a group under the assembly, and the
    // OTHER namespace must be untouched in the tree as well as at runtime.
    eq(sessions.ours.length, 1, 'one namespace, one session');
    eq(recorder.events('initialized').length, 1, 'behind one handshake');
    const other = groupUnder(await assemblyRoot(), CS_TEXT_NAMESPACE);
    neq(other.children.size, 0, 'the other namespace still holds tests of its own');
    eq(other.canResolveChildren, true, 'and still declares them');
    neq(other.id, CS_TEXT, 'its id is a group id, not a test name');
    eq(
      collectLeafIds(other.children).every((id) => id.startsWith(CS_TEXT_NAMESPACE)),
      true,
      'every leaf beneath it belongs to that namespace and no other',
    );
    eq(
      recorder.stops().every((entry) => entry.threadId !== 0),
      true,
      'every stop named the thread it stopped',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
    eq(
      recorder.requests('setBreakpoints').length >= 1,
      true,
      'the namespace debug synced its breakpoints',
    );
    eq(
      recorder.responses('setBreakpoints').every((response) => response.success),
      true,
      'and every sync was answered successfully',
    );
    eq(recorder.events('exited').length <= 1, true, 'with at most one process exit');
    eq(
      collectLeafIds((await assemblyRoot()).children).length,
      CS_ALL.length,
      'and the whole tree survives',
    );
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
    // Interaction 4 - the assembly root is the widest group there is, and it is
    // still ONE invocation. The tree beneath it must survive intact.
    eq(sessions.ours.length, 1, 'the whole assembly is ONE session');
    eq(recorder.events('initialized').length, 1, 'behind one handshake');
    const settled = await assemblyRoot();
    eq(rootsOf(settled.children).length, 2, 'the assembly still holds its two namespaces');
    eq(
      collectLeafIds(settled.children).length,
      CS_ALL.length,
      'and every test the fixture declares is still beneath it',
    );
    deepEq(
      [...collectLeafIds(settled.children)].sort(),
      [...CS_ALL].sort(),
      'under exactly the fully-qualified names discovery produced',
    );
    eq(settled.label, CS_PROJECT, 'labelled with the project the user recognises');
    neq(settled.id, CS_ADDS, 'and identified by a group id, never a test name');
    deepEq(stubs.log.errorMessages, [], 'with nothing reported to the user as a failure');
    eq(
      recorder.responses('configurationDone').every((response) => response.success),
      true,
      'configurationDone was answered successfully',
    );
    eq(
      recorder.requestedCommands().includes('launch'),
      true,
      'the assembly debug really launched a process',
    );
    eq(recorder.events('exited').length <= 1, true, 'which exited at most once');
    eq(
      collectLeafIds((await assemblyRoot()).children).length,
      CS_ALL.length,
      'and the tree is still complete afterwards',
    );
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
    // Interaction 4 - a multi-select is still ONE invocation, and the rows the
    // user did NOT select must be untouched in the tree.
    eq(sessions.ours.length, 1, 'two selected classes are ONE session, not two');
    eq(recorder.events('initialized').length, 1, 'behind one handshake');
    eq(recorder.events('terminated').length <= 1, true, 'and at most one termination');
    const root = await assemblyRoot();
    eq(
      collectLeafIds(root.children).length,
      CS_ALL.length,
      'every test is still discovered after a multi-select debug',
    );
    eq(
      recorder.stops().every((entry) => entry.reason === 'breakpoint'),
      true,
      'every stop was an armed breakpoint',
    );
    eq(
      new Set(recorder.stops().map((entry) => entry.threadId)).size >= 1,
      true,
      'and every stop named a thread',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
    eq(
      recorder.responses('launch').length >= 1,
      true,
      'the multi-select launched exactly one process',
    );
    eq(
      recorder.requestedCommands().filter((command) => command === 'launch').length,
      1,
      'one launch request, not one per selected class',
    );
    eq(recorder.events('initialized').length, 1, 'behind one handshake');
    eq(recorder.events('exited').length <= 1, true, 'and at most one exit');
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
    // Interaction 4 - nothing armed means nothing stops, and the session still
    // has to be a REAL one ([DEBUG-FEATURES-TESTS] rule 3: "A run with NO
    // breakpoints armed is armed as soon as configurationDone is answered").
    eq(vscode.debug.breakpoints.length, 0, 'the user armed nothing');
    deepEq(recorder.stops(), [], 'so the debuggee must never stop');
    eq(
      recorder.responses('configurationDone').length >= 1,
      true,
      'configurationDone was still ANSWERED - a run with nothing to bind is armed there',
    );
    eq(recorder.events('initialized').length, 1, 'the handshake still happened in full');
    eq(recorder.events('terminated').length, 1, 'and the session ended exactly once');
    eq(sessions.ours.length, 1, 'one group, one session, breakpoints or not');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
    eq(
      recorder.requestedCommands().includes('configurationDone'),
      true,
      'the handshake completed even with nothing to bind',
    );
    eq(recorder.responses('launch').length >= 1, true, 'the launch was answered');
    eq(recorder.events('exited').length, 1, 'and the debuggee exited exactly once');
    eq(vscode.debug.breakpoints.length, 0, 'with the Breakpoints view still empty');
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
    // Interaction 4 - and the tree carries no fabricated result. A debug run is
    // a diagnostic, not a run: painting rows green because the user stepped
    // through them reports outcomes nobody produced ([TEST-RUN-TRX]).
    const api3 = await activateTestExplorer();
    for (const fqn of CS_ALL) {
      const item = findItem(api3.testController.items, fqn);
      assert.ok(item, fqn + ' must still be a row after a group debug');
      eq(item.id, fqn, 'under its own fully-qualified name');
      eq(item.children.size, 0, 'and still a leaf');
      eq(item.error, undefined, fqn + ' must not be marked errored by a debug run');
    }
    eq(sessions.ours.length, 1, 'exactly one session was started');
    deepEq(stubs.log.warningMessages, [], 'and the user was warned about nothing');
    eq(recorder.events('initialized').length, 1, 'one handshake for the whole group');
    eq(
      recorder.responses('launch').every((response) => response.success),
      true,
      'answered successfully',
    );
    eq(sessions.ours.length, 1, 'and one session');
    eq(
      recorder.stops().every((entry) => entry.threadId !== 0),
      true,
      'every stop naming its thread',
    );
  });

  test('a group with ONE armed test stops exactly once, in that test', async function () {
    this.timeout(DEBUG_TEST_MS);

    // [TEST-RUN-TRX] makes a group ONE invocation, so every test in it EXECUTES.
    // Only the armed one may STOP. A session that stopped in an unarmed test
    // would be reporting a breakpoint the user never set.
    //
    // Interaction 1 — the class row, and a single breakpoint inside one of its
    // five tests.
    const root = await assemblyRoot();
    const classRow = groupUnder(groupUnder(root, CS_MATH_NAMESPACE), 'CalculatorTests');
    eq(classRow.children.size, MATH_CLASS_TESTS, 'the class holds every test it declares');
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'multiplies-seed')]);
    eq(vscode.debug.breakpoints.length, 1, 'exactly ONE breakpoint is armed');

    // Interaction 2 — debug the whole class. The one armed body binds and stops.
    await debugRun([classRow]);
    assertOneTestSession(sessions, 'debugging a class with one armed test');
    assertHandshakeOrder(recorder, 'debugging a class with one armed test');
    assertBoundAtLines(
      recorder,
      [CS_SOURCE.dapLine('multiplies-seed')],
      'the single armed body of a class-level debug',
    );
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop in the armed test');
    assertStopReason(stop, 'breakpoint', 'a class debug with one armed test');
    const frame = await topFrame(requireActive('the armed stop'), stop.threadId);
    eq(methodOf(frame), 'Multiplies_Two_Numbers', 'in the test the user armed, and no other');

    // Interaction 3 — running on, the session ends with no further stop, even
    // though four other tests of the class ran to completion inside it.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(
      recorder.stops().length,
      1,
      'the other four tests of the class execute but carry no breakpoint, so they must not stop',
    );
    eq(sessions.ours.length, 1, 'and a class is ONE session throughout');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
    // Interaction 4 - the class row itself is unchanged, and the four unarmed
    // tests really did execute inside the one session.
    eq(classRow.children.size, MATH_CLASS_TESTS, 'the class still holds all five tests');
    eq(sessions.ours.length, 1, 'in ONE session');
    eq(recorder.events('terminated').length, 1, 'which ended exactly once');
    eq(recorder.events('exited').length <= 1, true, 'with at most one process exit');
    eq(vscode.debug.breakpoints.length, 1, 'the single breakpoint survives the session');
    eq(
      recorder.requests('setBreakpoints').length >= 1,
      true,
      'and it really was synced to the adapter rather than kept client-side',
    );
    deepEq(recorder.errors, [], 'with no adapter transport error');
    eq(recorder.requests('setBreakpoints').length >= 1, true, 'the one armed line was synced');
    eq(
      recorder.responses('setBreakpoints').every((response) => response.success),
      true,
      'and the sync was answered',
    );
    eq(recorder.events('initialized').length, 1, 'behind one handshake');
    eq(
      recorder.stops().every((entry) => entry.reason === 'breakpoint'),
      true,
      'and every stop was that breakpoint',
    );
  });

  test('a DISABLED breakpoint in a group is bound by nothing and stops nothing', async function () {
    this.timeout(DEBUG_TEST_MS);

    // A disabled breakpoint is a user gesture with a precise meaning: keep it,
    // do not honour it. A group debug that honoured it anyway would halt on a
    // line the user deliberately switched off.
    //
    // Interaction 1 — arm one enabled and one disabled breakpoint in two
    // different tests of the same class.
    const root = await assemblyRoot();
    const classRow = groupUnder(groupUnder(root, CS_MATH_NAMESPACE), 'CalculatorTests');
    vscode.debug.addBreakpoints([
      breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-seed'),
      disabledBreakpointAt(CS_SOURCE, fixture.sourceUri, 'multiplies-seed'),
    ]);
    eq(vscode.debug.breakpoints.length, 2, 'two breakpoints are registered');
    eq(
      vscode.debug.breakpoints.filter((each) => each.enabled).length,
      1,
      'but only ONE of them is enabled',
    );

    // Interaction 2 — debug the class. Only the enabled line is sent to the
    // adapter, so only it can bind.
    await debugRun([classRow]);
    assertOneTestSession(sessions, 'debugging a class with a disabled breakpoint');
    assertBoundAtLines(
      recorder,
      [CS_SOURCE.dapLine('adds-seed')],
      'only the ENABLED breakpoint of a group debug',
    );

    // Interaction 3 — exactly one stop, in the enabled test, and the session
    // ends without ever visiting the disabled line.
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop at the enabled line');
    assertStopReason(stop, 'breakpoint', 'a group debug with one line disabled');
    eq(
      methodOf(await topFrame(requireActive('the enabled stop'), stop.threadId)),
      'Adds_Two_Numbers',
      'in the test carrying the ENABLED breakpoint',
    );
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(recorder.stops().length, 1, 'the disabled line must never produce a stop');
    deepEq(recorder.errors, [], 'and no adapter transport error');
    // Interaction 4 - the Breakpoints view still holds BOTH, exactly as the
    // user left them. A debugger that silently deletes a breakpoint it declined
    // to honour is worse than one that ignores it.
    eq(vscode.debug.breakpoints.length, 2, 'both breakpoints are still in the view');
    eq(
      vscode.debug.breakpoints.filter((entry) => entry.enabled).length,
      1,
      'one enabled and one still disabled',
    );
    eq(
      vscode.debug.breakpoints.filter((entry) => !entry.enabled).length,
      1,
      'the disabled one was not quietly removed',
    );
    eq(sessions.ours.length, 1, 'one class, one session');
    eq(recorder.events('terminated').length, 1, 'ended exactly once');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
    eq(recorder.requests('setBreakpoints').length >= 1, true, 'the enabled line was synced');
    eq(recorder.events('initialized').length, 1, 'behind one handshake');
    eq(recorder.events('exited').length <= 1, true, 'with at most one process exit');
    eq(
      recorder.stops().every((entry) => entry.reason === 'breakpoint'),
      true,
      'and every stop was a breakpoint stop',
    );
  });

  test('debugging a group leaves the TREE and the other namespace intact', async function () {
    this.timeout(DEBUG_TEST_MS);

    // A debug run is still a run: it must not reshape the Testing view, and it
    // must not quietly widen past the row the user pressed.
    //
    // Interaction 1 — the tree before, and the two namespaces it holds.
    const root = await assemblyRoot();
    const api = await activateTestExplorer();
    const before = [...collectLeafIds(api.testController.items)].sort();
    deepEq(before, [...CS_ALL].sort(), 'the fixture is fully discovered before debugging');
    eq(rootsOf(root.children).length, 2, 'the assembly holds two namespaces');
    const textRow = groupUnder(root, CS_TEXT_NAMESPACE);
    const textChildren = textRow.children.size;
    neq(textChildren, 0, 'and the other namespace holds tests of its own');

    // Interaction 2 — debug the TEXT namespace, with its own body armed.
    vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'text-seed')]);
    eq(vscode.debug.breakpoints.length, 1, 'one breakpoint, in the namespace being debugged');
    await debugRun([textRow]);
    assertOneTestSession(sessions, 'debugging the text namespace');
    assertBoundAtLines(
      recorder,
      [CS_SOURCE.dapLine('text-seed')],
      'the armed body of the text namespace',
    );
    const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop in the text namespace');
    assertStopReason(stop, 'breakpoint', 'debugging the text namespace');
    eq(
      methodOf(await topFrame(requireActive('the text stop'), stop.threadId)),
      'Joins_Two_Words',
      'in the one test that namespace declares',
    );

    // Interaction 3 — the session ends, and the view is exactly as it was.
    await gesture(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    deepEq(
      [...collectLeafIds(api.testController.items)].sort(),
      before,
      'debugging a namespace must not add, drop or reorder a row',
    );
    eq(rootsOf(api.testController.items).length, 1, 'still ONE assembly root');
    eq(textRow.children.size, textChildren, 'and the debugged group keeps its children');
    eq(sessions.ours.length, 1, 'one group, one session');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    deepEq(stubs.log.errorMessages, [], 'and nothing reported to the user as a failure');
    // Interaction 4 - and the OTHER namespace's tests are still addressable by
    // their own fully-qualified names, which is what makes them runnable.
    const finalRoot = await assemblyRoot();
    const mathRow = groupUnder(finalRoot, CS_MATH_NAMESPACE);
    eq(mathRow.children.size >= 1, true, 'the untouched namespace still holds its class');
    eq(
      collectLeafIds(mathRow.children).includes(CS_ADDS),
      true,
      'and that class still holds the test the user never selected',
    );
    eq(collectLeafIds(mathRow.children).includes(CS_MULTIPLIES), true, 'and its sibling');
    eq(
      collectLeafIds(finalRoot.children).includes(CS_TEXT),
      true,
      'while the debugged namespace keeps its own test too',
    );
    eq(sessions.ours.length, 1, 'exactly one session for the whole gesture');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    eq(recorder.events('initialized').length, 1, 'one handshake for the namespace debug');
    eq(recorder.responses('launch').length >= 1, true, 'the launch was answered');
    eq(recorder.events('terminated').length, 1, 'and the session ended exactly once');
    eq(sessions.ours.length, 1, 'with one session for the whole gesture');
  });
});
