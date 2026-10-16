// Implements [DEBUG-FEATURES-LAUNCH-SCRIPT]: real run tasks have observable process executions.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ObservedTask } from './run-debug-kit';

/** The run MUST be a `vscode.Task` on SharpLsp's own task type (rule 1). */
export function assertTaskIdentity(task: ObservedTask, why: string): void {
  assert.strictEqual(typeof task.name, 'string', `${why}: a task carries a name`);
  assert.notStrictEqual(task.name.trim().length, 0, `${why}: the task name must not be empty`);
  assert.strictEqual(typeof task.source, 'string', `${why}: a task carries a source`);
  assert.notStrictEqual(task.definitionType, 'dotnet', `${why}: 'dotnet' is the proprietary type`);
  const type = task.definitionType;
  assert.ok(type.startsWith('sharplsp'), `${why}: SharpLsp must own type '${type}'`);
}

/** A run must be a process, not a shell command line, or its args are unreadable. */
export function processExecutionOf(task: vscode.Task, why: string): vscode.ProcessExecution {
  const execution = task.execution;
  if (execution instanceof vscode.ProcessExecution) return execution;
  assert.fail(`${why}: a run must be a ProcessExecution, never a shell command line`);
}
