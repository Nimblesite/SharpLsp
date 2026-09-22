// Debugging a Microsoft.Testing.Platform test through the Test Explorer's Debug
// profile, end to end, with a real adapter.
//
// An MTP module IS its own test host: there is no `testhost.dll` child to wait
// for. The Debug profile sets `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1`, the
// module prints `Waiting for debugger to attach... Process Id: <pid>` and
// blocks, and SharpLsp must attach to THAT pid — so this is the one suite that
// proves the prefixed announcement is read, the module waits, and a breakpoint
// in the test body binds and stops. The fixture is the same anchored source the
// VSTest debug suites use, built on `xunit.v3`.
//
// Implements [TEST-MTP-DEBUG] and the "Debug individual test" and "Breakpoints
// inside test methods" rows of [DEBUG-FEATURES-TESTS].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DapRecorder } from './debug-dap-kit';
import {
  CMD_CONTINUE,
  assertStopReason,
  gesture,
  localsOf,
  methodOf,
  topFrame,
  variableNamed,
} from './debug-drive-kit';
import { assertBoundAtLines, clearAllBreakpoints, stopDebuggee } from './debug-suite-kit';
import {
  CS_ADDS,
  CS_ALL,
  CS_FAILS,
  CS_SOURCE,
  assertHandshakeOrder,
  assertOneTestSession,
  breakpointAt,
  disposeDebugTestFixture,
  requireActive,
  writeDebugTestFixture,
  type TestDebugFixture,
} from './debug-test-kit';
import { TEST_HOST_DEBUG_ENV } from '../../test-debug.js';
import { DEBUG_TYPE_ID, DebugSessionRecorder } from './run-debug-kit';
import {
  activateTestExplorer,
  discoverSolution,
  findItem,
  runViaProfile,
} from './test-explorer-kit';
import { assertFailed, cachedFor } from './test-explorer-outcome-assertions';
import { closeAllEditors, comparablePath, deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

suite(
  'Debug an MTP test — the Test Explorer Debug profile on a Microsoft.Testing.Platform module',
  () => {
    let fixture: TestDebugFixture;
    let recorder: DapRecorder;
    let sessions: DebugSessionRecorder;
    let stubs: UiStubs;

    suiteSetup(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      fixture = await writeDebugTestFixture('debug-mtp-', 'csharp', 'mtp');
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

    /** Discover the MTP fixture and return the tree row for `fqn`. */
    async function rowFor(fqn: string): Promise<vscode.TestItem> {
      const api = await activateTestExplorer();
      const discovered = await discoverSolution(api, fixture.solutionPath, CS_ALL);
      eq(discovered.includes(fqn), true, `${fqn} must be discovered: ${discovered.join(', ')}`);
      const item = findItem(api.testController.items, fqn);
      assert.ok(item, `the TestItem for ${fqn} must exist`);
      return item;
    }

    /** Press the Debug button on `items`, exactly as the workbench does. */
    async function debugRun(items: readonly vscode.TestItem[]): Promise<void> {
      const api = await activateTestExplorer();
      await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, items);
    }

    test('the Debug profile attaches to the waiting MODULE and stops inside the test body', async function () {
      this.timeout(DEBUG_TEST_MS);

      // 1. Arm a breakpoint inside the test method and press Debug on its row.
      const item = await rowFor(CS_ADDS);
      const api = await activateTestExplorer();
      const cachedBefore = api.testController.getResult(CS_ADDS);
      vscode.debug.addBreakpoints([breakpointAt(CS_SOURCE, fixture.sourceUri, 'adds-call')]);
      await debugRun([item]);

      // 2. ONE session, ATTACHED to the module's own pid — read off the prefixed
      //    MTP announcement — never to the extension host.
      const session = assertOneTestSession(sessions, 'debugging an MTP test');
      eq(session.configuration['request'], 'attach', 'an MTP module is attached to, not launched');
      const pid = Number(session.configuration['processId']);
      assert.ok(pid > 0, `the attach must carry the waiting module's pid; got ${String(pid)}`);
      neq(pid, process.pid, 'the pid is the MODULE, not the extension host');
      assertHandshakeOrder(recorder, 'debugging an MTP test');
      // [DEBUG-FEATURES-TESTS]: the SharpLsp adapter, under Just My Code …
      eq(session.type, DEBUG_TYPE_ID, 'it is the SharpLsp adapter that attached');
      eq(session.configuration['justMyCode'], true, 'Just My Code holds in a test context');
      // … and [TEST-MTP-DEBUG]: the module waited on ITS variable, set beside
      // VSTest's because each runner ignores the other's.
      eq(TEST_HOST_DEBUG_ENV['TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER'], '1', 'the MTP wait');
      eq(TEST_HOST_DEBUG_ENV['VSTEST_HOST_DEBUG'], '1', 'beside the VSTest wait');

      // 3. The breakpoint BOUND and the module stopped on it, in the test, with
      //    the test's own state readable.
      assertBoundAtLines(recorder, [CS_SOURCE.dapLine('adds-call')], 'a breakpoint in an MTP test');
      const stop = requireAt(await recorder.waitForStops(1), 0, 'the stop inside the MTP test');
      assertStopReason(stop, 'breakpoint', 'a breakpoint inside an MTP test method');
      const active = requireActive('a breakpoint stop in an MTP module');
      const frame = await topFrame(active, stop.threadId);
      eq(methodOf(frame), 'Adds_Two_Numbers', `stopped in '${frame.name}', not in the test`);
      eq(frame.line, CS_SOURCE.dapLine('adds-call'), 'on the armed line');
      eq(
        comparablePath(frame.sourcePath),
        comparablePath(fixture.sourceFile),
        'in the user’s file',
      );
      eq(
        variableNamed(await localsOf(active, frame.id), 'seed').value,
        '20',
        'locals are readable',
      );

      // 4. Continue: the module runs the test to the end and the session ends.
      await gesture(CMD_CONTINUE);
      await recorder.waitForEvents('terminated', 1);
      deepEq(stubs.log.errorMessages, [], 'a working MTP debug run reports no error');
      deepEq(recorder.errors, [], 'and no adapter transport error');

      // 5. The user's breakpoint was the first stop AND the only one: no wait loop
      //    or runner frame stopped the module on its own.
      eq(recorder.stops().length, 1, 'one stop, on the armed line');
      eq(vscode.debug.breakpoints.length, 1, 'debugging invents no breakpoint of its own');
      // [TEST-MTP-DEBUG]: a debug run writes NO result to the cache.
      await api.testController.whenIdle();
      deepEq(api.testController.getResult(CS_ADDS), cachedBefore, 'the cache is untouched');
    });

    test('an MTP debug run writes no result, and ▶ afterwards still reports the real one', async function () {
      this.timeout(DEBUG_TEST_MS);
      const api = await activateTestExplorer();
      const item = await rowFor(CS_FAILS);
      const before = api.testController.getResult(CS_FAILS);

      // 1. Debug a FAILING test with nothing armed: a session starts, the module
      //    runs to the end, and the session ends on its own.
      await debugRun([item]);
      const session = assertOneTestSession(sessions, 'debugging a failing MTP test');
      await recorder.waitForEvents('terminated', 1);
      // [DEBUG-FEATURES-TESTS]: the SharpLsp adapter ATTACHED to the module …
      eq(session.type, DEBUG_TYPE_ID, 'it is the SharpLsp adapter that attached');
      eq(session.configuration['request'], 'attach', 'to the waiting module');
      neq(Number(session.configuration['processId']), process.pid, 'never to the extension host');
      // … and with nothing armed there is nothing to stop on (rule 3): the run went
      // to the end, and a red test is neither an adapter error nor a SharpLsp one.
      deepEq(recorder.stops(), [], 'no stop without a breakpoint');
      deepEq(recorder.errors, [], 'no adapter transport error');
      deepEq(stubs.log.errorMessages, [], 'debugging a red test is not an error');

      // 2. A debug gesture never fabricates a run result: the cache is untouched.
      await api.testController.whenIdle();
      deepEq(api.testController.getResult(CS_FAILS), before, 'Debug writes nothing to the cache');

      // 3. The Run profile afterwards reports the real failure, with its text.
      await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
      await api.testController.whenIdle();
      assertFailed(cachedFor(api, CS_FAILS), CS_FAILS);
    });
  },
);
