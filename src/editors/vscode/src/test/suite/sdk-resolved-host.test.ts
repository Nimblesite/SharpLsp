import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ACTIVATION_MS } from './test-timeouts.js';

/**
 * Activation must point every `dotnet` child at the SDK it actually resolved.
 *
 * CI installs the pinned SDK onto `$PATH`, so a bare `dotnet` and the resolved
 * one are the same binary there and this defect is invisible. It only appears
 * where `$PATH`'s SDK differs from the workspace pin — which is every machine
 * that has not installed the pinned band. Implements [DIST-RUNTIME-ACQUIRE].
 */
suite('resolved SDK reaches dotnet-spawning features', () => {
  test('build tasks run the resolved SDK, not whatever $PATH provides', async function () {
    this.timeout(ACTIVATION_MS);
    const extension = vscode.extensions.getExtension('nimblesite.sharplsp');
    assert.ok(extension !== undefined, 'the extension under test must be installed');
    await extension.activate();

    const tasks = await vscode.tasks.fetchTasks({ type: 'sharplsp-build' });
    assert.ok(tasks.length > 0, 'the build task provider must contribute tasks');

    for (const task of tasks) {
      const execution = task.execution;
      assert.ok(
        execution instanceof vscode.ProcessExecution,
        `${task.name} must run dotnet as a process execution`,
      );
      assert.notEqual(
        execution.process,
        'dotnet',
        `${task.name} must not fall back to $PATH: activation resolved a specific SDK, ` +
          'and a bare "dotnet" silently runs a different one',
      );
      assert.ok(
        path.isAbsolute(execution.process),
        `${task.name} must invoke an absolute SDK path, got ${execution.process}`,
      );
    }
  });
});
