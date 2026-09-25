// Regression #302: Stop owns the test host, not just its adapter. Exercise the
// real Test Explorer, netcoredbg, runner and terminal in both languages/runners.
// Implements [DEBUG-FEATURES-TESTS] and [TEST-MTP-DEBUG].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { TEST_DEBUG_TERMINAL_NAME } from '../../test-debug';
import { DapRecorder } from './debug-dap-kit';
import { AnchoredSource } from './debug-anchors';
import { evaluate, topFrame } from './debug-drive-kit';
import { clearAllBreakpoints, stopDebuggee } from './debug-suite-kit';
import {
  CS_ADDS,
  FS_SPACED,
  breakpointAt,
  disposeDebugTestFixture,
  writeDebugTestFixture,
  requireActive,
  type TestDebugFixture,
} from './debug-test-kit';
import { DebugSessionRecorder } from './run-debug-kit';
import {
  activateTestExplorer,
  discoverSolution,
  findItem,
  runViaProfile,
} from './test-explorer-kit';
import { closeAllEditors, pollUntilResult, requireAt } from './test-helpers';
import { COMMAND_MS, DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

// The attached host cannot finish naturally within COMMAND_MS. Remember the
// attachment BEFORE Stop: checking it after detach would skip the delay and
// let a broken detach-only implementation pass by completing the test normally.
const SOURCES = {
  fsharp: new AnchoredSource([
    'module Fs.Debug.Fixtures',
    'open Xunit',
    '[<Fact>]',
    'let ``adds two numbers with spaces`` () =',
    '    let attached = System.Diagnostics.Debugger.IsAttached',
    '    System.Threading.Thread.Sleep(if attached then 30000 else 0) // @anchor:wait',
    '    Assert.Equal(42, 20 + 22)',
  ]),
  csharp: new AnchoredSource([
    'using Xunit;',
    'namespace DebugTestTarget.Math;',
    'public class CalculatorTests {',
    '    [Fact] public void Adds_Two_Numbers() {',
    '        var attached = System.Diagnostics.Debugger.IsAttached;',
    '        System.Threading.Thread.Sleep(attached ? 30000 : 0); // @anchor:wait',
    '        Assert.Equal(42, 20 + 22);',
    '    }',
    '}',
  ]),
};

/** Wait for the actual terminal object to close, not an unrelated queue. */
async function assertTerminalClosed(terminal: vscode.Terminal): Promise<void> {
  const closed = await pollUntilResult(
    async () => !vscode.window.terminals.includes(terminal),
    (done) => done,
    COMMAND_MS,
    50,
  );
  assert.equal(closed, true, 'Stop must settle the owned runner and close its debug terminal');
}

for (const language of ['fsharp', 'csharp'] as const) {
  for (const runner of ['vstest', 'mtp'] as const) {
    suite(`Test debug Stop lifecycle — ${language} ${runner}`, () => {
      let fixture: TestDebugFixture;
      let recorder: DapRecorder;
      let sessions: DebugSessionRecorder;
      let stubs: UiStubs;
      let ownedTerminal: vscode.Terminal | undefined;
      const fsharp = language === 'fsharp';
      const id = fsharp ? FS_SPACED : CS_ADDS;

      suiteSetup(async function () {
        this.timeout(FIXTURE_BUILD_MS);
        fixture = await writeDebugTestFixture(
          'debug-stop-',
          language,
          runner,
          SOURCES[language].text,
        );
        clearAllBreakpoints();
        recorder = new DapRecorder();
        sessions = new DebugSessionRecorder();
        stubs = installUiStubs();
      });

      suiteTeardown(async function () {
        this.timeout(FIXTURE_BUILD_MS);
        await stopDebuggee();
        ownedTerminal?.dispose();
        clearAllBreakpoints();
        sessions.dispose();
        recorder.dispose();
        stubs.restore();
        await closeAllEditors();
        await disposeDebugTestFixture(fixture);
      });

      test('Stop ends its host and terminal, never retries, and the next Debug starts clean', async function () {
        this.timeout(DEBUG_TEST_MS * 2);
        const api = await activateTestExplorer();
        await discoverSolution(api, fixture.solutionPath, [id]);
        const item = findItem(api.testController.items, id);
        assert.ok(item, 'the real test must be discovered before debugging');
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
        const cached = api.testController.getResult(id);
        assert.equal(cached?.outcome, 'passed', 'the fixture passes without the debugger');
        vscode.debug.addBreakpoints([breakpointAt(SOURCES[language], fixture.sourceUri, 'wait')]);
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [item]);
        const stopped = requireAt(await recorder.waitForStops(1), 0, 'the user breakpoint');
        assert.equal(
          stopped.reason,
          'breakpoint',
          'Stop is pressed in user code, not before attach',
        );
        assert.equal(sessions.ours.length, 1, 'one Debug gesture starts one session');
        const active = requireActive('the owned test at the wait breakpoint');
        const frame = await topFrame(active, stopped.threadId);
        assert.equal(
          (await evaluate(active, 'attached', frame.id, 'watch')).value,
          'true',
          'the fixture must retain its 30-second wait even after the debugger detaches',
        );
        const first = requireAt(sessions.ours, 0, 'the owned test session');
        const pid = Number(first.configuration['processId']);
        assert.ok(pid > 0 && pid !== process.pid, 'the debuggee is the owned test host');
        assert.doesNotThrow(() => process.kill(pid, 0), 'the owned host is alive before Stop');
        ownedTerminal = vscode.window.terminals.find(
          (terminal) => terminal.name === TEST_DEBUG_TERMINAL_NAME,
        );
        assert.ok(ownedTerminal, 'the live run has its output terminal');

        await stopDebuggee();
        await assertTerminalClosed(ownedTerminal);
        assert.throws(
          () => process.kill(pid, 0),
          { code: 'ESRCH' },
          'Stop terminates the owned host',
        );
        assert.equal(
          api.testController.getResult(id),
          cached,
          'stopping debug never overwrites the real result',
        );
        assert.equal(sessions.ours.length, 1, 'a stopped invocation must not retry unfiltered');

        // A real subsequent run supplies a progress barrier: no sleep can mask a
        // deferred retry that starts another waiting host after the Stop gesture.
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
        assert.equal(
          api.testController.getResult(id)?.outcome,
          'passed',
          'Run still works after Stop',
        );
        assert.equal(sessions.ours.length, 1, 'no delayed debug retry started during the next run');
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [item]);
        await recorder.waitForStops(2);
        const second = requireAt(sessions.ours, 1, 'the next explicit debug session');
        assert.equal(
          sessions.ours.length,
          2,
          'only the next explicit Debug creates another session',
        );
        assert.notEqual(second.id, first.id, 'the next Debug owns a fresh session');
        ownedTerminal = vscode.window.terminals.find(
          (terminal) => terminal.name === TEST_DEBUG_TERMINAL_NAME,
        );
        assert.ok(ownedTerminal, 'the new run has its own terminal');
        assert.equal(
          vscode.window.terminals.filter((terminal) => terminal.name === TEST_DEBUG_TERMINAL_NAME)
            .length,
          1,
          'no terminal leaked from the stopped run',
        );
        await stopDebuggee();
        await assertTerminalClosed(ownedTerminal);
        assert.equal(sessions.ours.length, 2, 'the second Stop does not restart either');
        assert.deepEqual(stubs.log.errorMessages, [], 'the lifecycle reports no user-facing error');
      });
    });
  }
}
