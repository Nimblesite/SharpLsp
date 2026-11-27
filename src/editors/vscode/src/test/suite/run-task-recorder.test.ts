// The recorder reads a run's exit from the task the extension started, never
// from another task process that happened to end first (#631).
// Implements [DEBUG-FEATURES-LAUNCH-SCRIPT]: a run's exit code is observable.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { RUN_TASK_SOURCE, RUN_TASK_TYPE } from '../../launch-run.js';
import { activateTestExplorer } from './test-explorer-kit';
import { sleep } from './test-helpers';
import { TaskRecorder } from './run-task-recorder';
import { DEBUG_SESSION_MS } from './test-timeouts';

/**
 * A task that exits with `code` at once, run by the Node on PATH.
 * VS Code runs only task types some extension contributes, so a foreign task
 * — a workspace tasks.json build, say — is told apart by its source alone.
 */
function exitingTask(source: string, definition: vscode.TaskDefinition, code: number): vscode.Task {
  const execution = new vscode.ProcessExecution('node', ['-e', `process.exit(${String(code)})`]);
  const [folder] = vscode.workspace.workspaceFolders ?? [];
  assert.ok(folder, 'the suite runs inside a workspace folder');
  return new vscode.Task(definition, folder, `exit ${String(code)}`, source, execution);
}

/** Run `task` and resolve with the exit code VS Code reported for its process. */
async function runToExit(task: vscode.Task): Promise<number | undefined> {
  // The event carries VS Code's own copy of the task, so match it by identity fields.
  const ours = (other: vscode.Task): boolean =>
    other.name === task.name && other.source === task.source;
  let settle: (code: number | undefined) => void = () => undefined;
  const ended = new Promise<number | undefined>((resolve) => {
    settle = resolve;
  });
  const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
    if (ours(event.execution.task)) settle(event.exitCode);
  });
  const stalled = sleep(DEBUG_SESSION_MS / 2).then(() => {
    assert.fail(`'${task.name}' (${task.source}) never reported a process exit`);
  });
  try {
    await vscode.tasks.executeTask(task);
    return await Promise.race([ended, stalled]);
  } finally {
    subscription.dispose();
  }
}

suite('Run task recorder — exits belong to the tasks SharpLsp started (#631)', () => {
  suiteSetup(async () => {
    await activateTestExplorer();
  });

  test('a foreign task that ends first never stands in for the run task exit', async function () {
    this.timeout(DEBUG_SESSION_MS * 2);
    const tasks = new TaskRecorder();
    try {
      // 1 — another task, not SharpLsp's, ends with 0 while the recorder listens.
      const foreign = await runToExit(
        exitingTask('Workspace', { type: 'sharplsp-build', command: 'build' }, 0),
      );
      assert.strictEqual(foreign, 0, 'the foreign task really ran and exited 0');
      assert.deepStrictEqual([...tasks.exits], [], "a foreign task's exit is not a SharpLsp exit");

      // 2 — SharpLsp's run then exits 10: that, and only that, is the exit observed.
      const run = exitingTask(RUN_TASK_SOURCE, { type: RUN_TASK_TYPE, file: 'exit-10' }, 10);
      const [exits, own] = await Promise.all([
        tasks.waitForExits(1, DEBUG_SESSION_MS),
        runToExit(run),
      ]);
      assert.strictEqual(own, 10, 'VS Code reported the run exiting 10');
      assert.deepStrictEqual([...exits], [10], "the run's own exit, never the foreign 0");
      assert.strictEqual(tasks.started.length, 2, 'both tasks were still observed starting');
    } finally {
      tasks.dispose();
    }
  });
});
