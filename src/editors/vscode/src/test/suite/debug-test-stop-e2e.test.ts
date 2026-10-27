// Regression #302: Stop owns the test host, not just its adapter. Exercise the
// real Test Explorer, netcoredbg, runner and terminal in both languages/runners.
// Implements [DEBUG-FEATURES-TESTS], [TEST-MTP-DEBUG] and [TEST-BUILD-GRAPH].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
  assertTerminalClosed,
  assertOneTerminal,
  assertDebugCache,
} from './debug-test-kit';
import { DebugSessionRecorder } from './run-debug-kit';
import { addDebugGraph, updateDebugGraph, type DebugGraph } from './debug-test-graph-fixture';
import { buildsLogged, resetBuildCounter } from './dotnet-project-kit';
import {
  activateTestExplorer,
  discoverSolution,
  findItem,
  runViaProfile,
  runAlreadyCancelled,
} from './test-explorer-kit';
import { closeAllEditors, requireAt } from './test-helpers';
import { DEBUG_TEST_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

// The attached host cannot finish naturally within COMMAND_MS. Remember the
// attachment BEFORE Stop: checking it after detach would skip the delay and
// let a broken detach-only implementation pass by completing the test normally.
const SOURCES = {
  fsharp: (revision = 1) =>
    new AnchoredSource([
      'module Fs.Debug.Fixtures',
      'open Xunit',
      '[<Fact>]',
      'let ``adds two numbers with spaces`` () =',
      '    let revision = DebugGraph.Value.Current()',
      `    Assert.Equal(${String(revision)}, revision)`,
      '    let attached = System.Diagnostics.Debugger.IsAttached',
      '    System.Threading.Thread.Sleep(if attached then 30000 else 0) // @anchor:wait',
      '    Assert.Equal(42, 20 + 22)',
    ]),
  csharp: (revision = 1) =>
    new AnchoredSource([
      'using Xunit;',
      'namespace DebugTestTarget.Math;',
      'public class CalculatorTests {',
      '    [Fact] public void Adds_Two_Numbers() {',
      '        var revision = DebugGraph.Value.Current();',
      `        Assert.Equal(${String(revision)}, revision);`,
      '        var attached = System.Diagnostics.Debugger.IsAttached;',
      '        System.Threading.Thread.Sleep(attached ? 30000 : 0); // @anchor:wait',
      '        Assert.Equal(42, 20 + 22);',
      '    }',
      '}',
    ]),
};

/** Debug must preserve unchanged outputs and never compile the broken sibling. */
function assertUnchangedGraph(graph: DebugGraph, stamps: readonly number[]): void {
  assert.deepEqual(
    graph.assemblies.map((file) => fs.statSync(file).mtimeMs),
    stamps,
  );
  assert.ok(!buildsLogged(graph.counter).includes('Unrelated'), 'only the selected graph builds');
}

for (const language of ['fsharp', 'csharp'] as const) {
  for (const runner of ['vstest', 'mtp'] as const) {
    suite(`Test debug Stop lifecycle — ${language} ${runner}`, () => {
      let fixture: TestDebugFixture;
      let graph: DebugGraph;
      let recorder: DapRecorder;
      let sessions: DebugSessionRecorder;
      let stubs: UiStubs;
      let ownedTerminal: vscode.Terminal | undefined;
      const fsharp = language === 'fsharp';
      const id = fsharp ? FS_SPACED : CS_ADDS;

      suiteSetup(async function () {
        this.timeout(FIXTURE_BUILD_MS);
        fixture = await writeDebugTestFixture('debug-stop-', language, runner);
        graph = await addDebugGraph(fixture, language, runner);
        fs.writeFileSync(fixture.sourceFile, SOURCES[language]().text);
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
        await discoverSolution(api, fixture.solutionPath, [id, 'Other.Unselected']);
        const item = findItem(api.testController.items, id);
        assert.ok(item, 'the real test must be discovered before debugging');
        const stamps = graph.assemblies.map((file) => fs.statSync(file).mtimeMs);
        const unrelated = api.testController.getResult('Other.Unselected');
        fs.writeFileSync(graph.siblingFile, 'deliberately broken unrelated project');
        resetBuildCounter(graph.counter);
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
        const cached = api.testController.getResult(id);
        assert.equal(cached?.outcome, 'passed', 'the fixture passes without the debugger');
        // A cancelled gesture can finish before VS Code opens its pseudoterminal.
        const buildsBeforeCancellation = buildsLogged(graph.counter);
        await runAlreadyCancelled(api.testController, vscode.TestRunProfileKind.Debug, [item]);
        assert.equal(sessions.ours.length, 0, 'a pre-cancelled Debug starts no session');
        assertDebugCache(api, id, cached, 'a pre-cancelled Debug keeps Run results');
        assert.deepEqual(
          buildsLogged(graph.counter),
          buildsBeforeCancellation,
          'a pre-cancelled Debug builds nothing',
        );
        vscode.debug.addBreakpoints([breakpointAt(SOURCES[language](), fixture.sourceUri, 'wait')]);
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
        assert.equal((await evaluate(active, 'revision', frame.id, 'watch')).value, '1');
        assertUnchangedGraph(graph, stamps);
        const first = requireAt(sessions.ours, 0, 'the owned test session');
        const pid = Number(first.configuration['processId']);
        assert.ok(pid > 0 && pid !== process.pid, 'the debuggee is the owned test host');
        assert.doesNotThrow(() => process.kill(pid, 0), 'the owned host is alive before Stop');
        ownedTerminal = assertOneTerminal(
          TEST_DEBUG_TERMINAL_NAME,
          'the cancelled gesture leaves no ghost terminal beside the live debug run',
          'the live run has its output terminal',
        );

        await stopDebuggee();
        await assertTerminalClosed(ownedTerminal);
        assert.throws(
          () => process.kill(pid, 0),
          { code: 'ESRCH' },
          'Stop terminates the owned host',
        );
        assertDebugCache(api, id, cached, 'stopping debug never overwrites the real result');
        assert.equal(sessions.ours.length, 1, 'a stopped invocation must not retry unfiltered');

        // A real subsequent run supplies a progress barrier: no sleep can mask a
        // deferred retry that starts another waiting host after the Stop gesture.
        updateDebugGraph(graph, 2);
        fs.writeFileSync(fixture.sourceFile, SOURCES[language](2).text);
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
        assert.equal(
          api.testController.getResult(id)?.outcome,
          'passed',
          'Run still works after Stop',
        );
        assert.equal(sessions.ours.length, 1, 'no delayed debug retry started during the next run');
        const beforeDebug = api.testController.getResult(id);
        // No rediscovery or manual build: Debug must compile this newer source.
        const libraryAssembly = requireAt(graph.assemblies, 0, 'the referenced library assembly');
        const libraryStamp = fs.statSync(libraryAssembly).mtimeMs;
        updateDebugGraph(graph, 3);
        fs.writeFileSync(fixture.sourceFile, SOURCES[language](3).text);
        await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, [item]);
        const secondStop = requireAt(await recorder.waitForStops(2), 1, 'the rebuilt user test');
        assert.equal(secondStop.reason, 'breakpoint', 'the rebuilt PDB binds the user breakpoint');
        const rebuilt = requireActive('the source edited after the last Run');
        const rebuiltFrame = await topFrame(rebuilt, secondStop.threadId);
        assert.equal(rebuiltFrame.line, SOURCES[language](3).dapLine('wait'));
        assert.equal(
          (await evaluate(rebuilt, 'revision', rebuiltFrame.id, 'watch')).value,
          '3',
          'Debug incrementally builds current sources instead of attaching to stale test code',
        );
        assert.notEqual(
          fs.statSync(libraryAssembly).mtimeMs,
          libraryStamp,
          'Debug rebuilds the changed project reference',
        );
        assert.ok(
          buildsLogged(graph.counter).includes('GraphLibrary'),
          'the transitive dependency participates in the selected build graph',
        );
        assert.ok(
          !buildsLogged(graph.counter).includes('Unrelated'),
          'the broken sibling never blocks Run or either Debug gesture',
        );
        assert.equal(
          api.testController.getResult('Other.Unselected'),
          unrelated,
          'no unrelated test executes',
        );
        const second = requireAt(sessions.ours, 1, 'the next explicit debug session');
        assert.equal(
          sessions.ours.length,
          2,
          'only the next explicit Debug creates another session',
        );
        assert.notEqual(second.id, first.id, 'the next Debug owns a fresh session');
        ownedTerminal = assertOneTerminal(
          TEST_DEBUG_TERMINAL_NAME,
          'no terminal leaked from the stopped run',
          'the new run has its own terminal',
        );
        await stopDebuggee();
        await assertTerminalClosed(ownedTerminal);
        assert.equal(sessions.ours.length, 2, 'the second Stop does not restart either');
        assertDebugCache(api, id, beforeDebug, 'Debug preserves Run results');
        assert.deepEqual(stubs.log.errorMessages, [], 'the lifecycle reports no user-facing error');
      });
    });
  }
}
