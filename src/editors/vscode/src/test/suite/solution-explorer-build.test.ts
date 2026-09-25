// What the user SEES when they press Build. Spec: [SE-ACTIONS-BUILD].
//
// "Simple build solution does nothing!" is what a conforming-looking build loop
// reports when its presentation hides it. The task dispatched by `sharplsp.build`
// carried `reveal: Silent` with `close: true`, so the terminal was never revealed
// and was disposed the instant MSBuild exited. Success, a compile error and a
// `dotnet` that failed to launch at all then produce the SAME observation —
// nothing — and the user cannot tell a working build from a broken one.
//
// [SE-ACTIONS-BUILD] names two obligations the manifest cannot express and no
// other suite asserted: output APPEARS IN THE TERMINAL, and progress is SHOWN
// while the build runs. Both are properties of the dispatched `vscode.Task` and
// of the command that dispatches it, so both are assertable without MSBuild.
//
// The dispatch itself — one build, one task, never a terminal racing a headless
// run — belongs to [DEBUG-FEATURES-LAUNCH-BUILD] and is covered in
// run-debug-build.test.ts. Nothing here re-asserts it.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SharpLspBuildTaskProvider, createBuildTask } from '../../build.js';
import { writeCSharpConsole } from './run-debug-fixtures';
import { assertCommandRegistered, invokeCommand } from './run-debug-kit';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS } from './test-timeouts';

/** The command the Solution Explorer's Build menu item names ([SE-ACTIONS-BUILD]). */
const CMD_BUILD = 'sharplsp.build';

/** The three verbs `provideTasks` offers, in picker order. */
const VERBS = ['build', 'rebuild', 'clean'] as const;

/** One observed `window.withProgress` call and when its body finished. */
interface ProgressCall {
  readonly options: vscode.ProgressOptions;
  /** `Date.now()` at the moment the wrapped body resolved; `undefined` while it runs. */
  settledAt: number | undefined;
}

/** `vscode.window` with the one member this suite patches made assignable. */
interface MutableWindow {
  withProgress: typeof vscode.window.withProgress;
}

/**
 * Record every `withProgress` call, running the real one underneath.
 *
 * Wrapped rather than replaced: the assertion is that the notification is tied
 * to the build's LIFETIME, which only holds if the genuine body still runs and
 * is still awaited. A stub that resolved immediately would report a pass for the
 * fire-and-forget notification this test exists to reject.
 */
function recordProgress(): { readonly calls: ProgressCall[]; restore: () => void } {
  const mutable = vscode.window as unknown as MutableWindow;
  const original = mutable.withProgress;
  const calls: ProgressCall[] = [];
  mutable.withProgress = async (options, body) => {
    const call: ProgressCall = { options, settledAt: undefined };
    calls.push(call);
    const result = await original(options, body);
    call.settledAt = Date.now();
    return result;
  };
  return { calls, restore: () => (mutable.withProgress = original) };
}

/** Record when the last SharpLsp build process exited. */
function recordBuildExit(): { readonly endedAt: number[]; restore: () => void } {
  const endedAt: number[] = [];
  const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
    if (event.execution.task.source !== SharpLspBuildTaskProvider.Source) return;
    endedAt.push(Date.now());
  });
  return { endedAt, restore: () => subscription.dispose() };
}

suite('Solution Explorer build presentation [SE-ACTIONS-BUILD]', () => {
  let caseDir: string;

  setup(() => {
    caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-se-build-'));
  });

  teardown(() => {
    removeDirRecursive(caseDir);
  });

  // The whole reported defect, as a shape assertion: the build is dispatched,
  // and it is dispatched INVISIBLY.
  test('every build the user dispatches reveals its terminal and leaves it standing', () => {
    // 1 — the user right-clicks TestFixtures.sln in the Solution Explorer and
    //     picks Build. That node supplies the .sln; the task carries the rest.
    const solution = path.join(caseDir, 'TestFixtures.sln');
    const build = createBuildTask('build', 'Build', solution);
    const shown = build.presentationOptions;
    const invisible = 'Silent never reveals the terminal: the user sees no output at all';
    assert.strictEqual(shown.reveal, vscode.TaskRevealKind.Always, invisible);
    const vanished = 'close:true disposes the terminal at exit, taking the output with it';
    assert.notStrictEqual(shown.close, true, vanished);
    const stacked = 'Dedicated reuses ONE terminal per task; New stacks a panel per build';
    assert.strictEqual(shown.panel, vscode.TaskPanelKind.Dedicated, stacked);
    assert.strictEqual(build.definition.target, solution, 'the solution node picks the target');

    // 2 — the same is true of Rebuild and Clean, which sit in the same menu group.
    const dispatched = VERBS.map((verb) => createBuildTask(verb, verb, solution));
    assert.deepStrictEqual(
      dispatched.map((task) => task.presentationOptions.reveal),
      dispatched.map(() => vscode.TaskRevealKind.Always),
      'Rebuild and Clean are user actions too — none of the three may run unseen',
    );
    assert.deepStrictEqual(
      dispatched.map((task) => task.presentationOptions.close === true),
      dispatched.map(() => false),
      'no build verb may dispose the terminal holding its own output',
    );

    // 3 — and of the tasks offered in Run Task, which is the same dispatch path.
    const provided = new SharpLspBuildTaskProvider().provideTasks();
    assert.strictEqual(provided.length, 3, 'build, rebuild and clean are offered');
    assert.deepStrictEqual(
      provided.map((task) => task.presentationOptions.reveal),
      provided.map(() => vscode.TaskRevealKind.Always),
      'a task picked from Run Task shows its output for the same reason',
    );
  });

  // Progress is the ONLY signal a build is under way: the terminal says nothing
  // until MSBuild speaks, and a solution build can be silent for a long time.
  test('building from the Solution Explorer reports progress for as long as it builds', async function () {
    this.timeout(DOTNET_CLI_MS);
    // 1 — a real project, and the command wired to the Build menu item.
    const project = writeCSharpConsole(path.join(caseDir, 'Shown'), 'Shown');
    await assertCommandRegistered(CMD_BUILD);
    const progress = recordProgress();
    const exits = recordBuildExit();

    try {
      // 2 — the user presses Build on that node.
      const outcome = await invokeCommand(CMD_BUILD, { projectFilePath: project.projectFile });
      assert.ok(!outcome.rejected, `Build must resolve: ${outcome.message}`);

      // 3 — a notification was raised, and it named the build.
      assert.strictEqual(progress.calls.length, 1, 'exactly one progress notification per build');
      const call = progress.calls[0]!;
      const silent = 'a status-bar spinner is not a notification; the spec says notification';
      assert.strictEqual(call.options.location, vscode.ProgressLocation.Notification, silent);
      const title = call.options.title ?? '';
      assert.match(title, /build/i, `the notification must say what it is doing: '${title}'`);
      assert.ok(title.includes('Shown'), `and which target: '${title}'`);

      // 4 — and it stayed up until the build ended, rather than flashing past.
      assert.strictEqual(exits.endedAt.length, 1, 'the build process ran exactly once');
      assert.notStrictEqual(call.settledAt, undefined, 'the progress body must have completed');
      const flashed = 'progress that resolves before the build exits reports nothing to anyone';
      assert.ok(call.settledAt! >= exits.endedAt[0]!, flashed);
    } finally {
      progress.restore();
      exits.restore();
    }
  });
});
