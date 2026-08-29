/**
 * Fakes and task-dispatch helpers for the FSI / build / output-filter suite.
 *
 * Two reasons this file exists rather than living inside the test:
 *
 *  1. `sharplsp.build`, `sharplsp.rebuild` and `sharplsp.clean` are dispatched
 *     as `vscode.Task`s ([DEBUG-FEATURES-LAUNCH-BUILD] rule 4). A resolved
 *     `executeCommand` promise proves nothing — the workbench swallows errors
 *     thrown inside a command handler — so the ONLY evidence a command ran
 *     anything is the task the workbench itself reports. The observation is not
 *     reimplemented here: it reuses {@link TaskRecorder} from run-debug-kit.
 *  2. It keeps `fsi-build-output-e2e.test.ts` inside the 500-line budget.
 *
 * Implements [DEBUG-FEATURES-LAUNCH-BUILD].
 */
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SharpLspBuildTaskProvider } from '../../build.js';
import { pollUntilResult } from './test-helpers.js';
import { DOTNET_CLI_MS } from './test-timeouts';
import type { ObservedTask, TaskRecorder } from './run-debug-kit.js';

/** How long a dispatched build task may take to report that it started. */

/** Poll interval while waiting on the task queue. */
const TASK_POLL_MS = 100;

/** A solution/project tree node as the context menu hands it to a command. */
export interface BuildNode {
  readonly projectFilePath: string;
}

/** Only the tasks the build commands own — other providers' tasks are noise. */
export function buildTasksOf(recorder: TaskRecorder): readonly ObservedTask[] {
  return recorder.started.filter((task) => task.definitionType === SharpLspBuildTaskProvider.Type);
}

/**
 * A dispatched task minus its `dotnet` path.
 *
 * The path is machine-specific: [DIST-RUNTIME-ACQUIRE] resolves an ABSOLUTE SDK
 * path at activation, and the extension host's module state is not the test
 * host's, so the executable is asserted by name in {@link dispatchedBuildTask}
 * and everything else is compared exactly.
 */
export interface BuildTaskShape {
  readonly name: string;
  readonly source: string;
  readonly definitionType: string;
  readonly args: readonly string[];
}

/** The exact task a build command must dispatch: identity AND full argv. */
export function expectedBuildTask(name: string, args: readonly string[]): BuildTaskShape {
  return {
    name,
    source: SharpLspBuildTaskProvider.Source,
    definitionType: SharpLspBuildTaskProvider.Type,
    args,
  };
}

/** Assert the task runs the `dotnet` CLI, then drop its machine-specific path. */
function shapeOf(task: ObservedTask, command: string): BuildTaskShape {
  const executable = path.basename(task.command ?? '');
  assert.ok(
    executable === 'dotnet' || executable === 'dotnet.exe',
    `${command} must run the dotnet CLI, not ${task.command ?? '<no process>'}`,
  );
  const { name, source, definitionType, args } = task;
  return { name, source, definitionType, args };
}

/** Build executions still running right now. */
function runningBuildTasks(): readonly vscode.TaskExecution[] {
  return vscode.tasks.taskExecutions.filter(
    (execution) => execution.task.definition.type === SharpLspBuildTaskProvider.Type,
  );
}

/**
 * Terminate every running build task and wait for the queue to drain.
 *
 * A build task is a real `dotnet` process against the fixture workspace. Left
 * running, it races the NEXT command's task on the same `obj/` lock files and
 * leaks into whichever test runs after this one.
 */
export async function terminateBuildTasks(): Promise<void> {
  for (const execution of runningBuildTasks()) execution.terminate();
  await pollUntilResult(
    async () => runningBuildTasks(),
    (left) => left.length === 0,
    DOTNET_CLI_MS,
    TASK_POLL_MS,
  );
}

/**
 * Run a build command and return the ONE task it dispatched.
 *
 * `previous` is how many build tasks the recorder had already seen, so the
 * count assertion catches a command that dispatches twice as surely as one that
 * dispatches nothing at all.
 */
export async function dispatchedBuildTask(
  recorder: TaskRecorder,
  command: string,
  previous: number,
  node?: BuildNode,
): Promise<BuildTaskShape> {
  await vscode.commands.executeCommand(command, node);
  const observed = await pollUntilResult(
    async () => buildTasksOf(recorder),
    (tasks) => tasks.length > previous,
    DOTNET_CLI_MS,
    TASK_POLL_MS,
  );
  await terminateBuildTasks();
  assert.strictEqual(
    observed.length,
    previous + 1,
    `${command} must dispatch exactly one ${SharpLspBuildTaskProvider.Type} task`,
  );
  const task = observed[previous];
  assert.ok(task !== undefined, `${command} dispatched no build task at all`);
  return shapeOf(task, command);
}

// ── Fake OutputChannel ────────────────────────────────────────────

/** Records everything a LogOutputChannel receives so we can assert on it. */
export interface RecordingChannel extends vscode.LogOutputChannel {
  readonly appended: string[];
  readonly appendedLines: string[];
  readonly replaced: string[];
  /** Level-tagged log calls, as `level:message`. */
  readonly logged: string[];
  cleared: number;
  shown: number;
  hidden: number;
  disposed: number;
}

/** Build a minimal in-memory OutputChannel that records every interaction. */
export function recordingChannel(name: string): RecordingChannel {
  const appended: string[] = [];
  const appendedLines: string[] = [];
  const replaced: string[] = [];
  const logged: string[] = [];
  const channel: RecordingChannel = {
    name,
    appended,
    appendedLines,
    replaced,
    logged,
    cleared: 0,
    shown: 0,
    hidden: 0,
    disposed: 0,
    logLevel: vscode.LogLevel.Info,
    onDidChangeLogLevel: new vscode.EventEmitter<vscode.LogLevel>().event,
    append(value: string): void {
      appended.push(value);
    },
    appendLine(value: string): void {
      appendedLines.push(value);
    },
    replace(value: string): void {
      replaced.push(value);
    },
    trace(message: string): void {
      logged.push(`trace:${message}`);
    },
    debug(message: string): void {
      logged.push(`debug:${message}`);
    },
    info(message: string): void {
      logged.push(`info:${message}`);
    },
    warn(message: string): void {
      logged.push(`warn:${message}`);
    },
    error(error: string | Error): void {
      logged.push(`error:${typeof error === 'string' ? error : error.message}`);
    },
    clear(): void {
      channel.cleared += 1;
    },
    show(): void {
      channel.shown += 1;
    },
    hide(): void {
      channel.hidden += 1;
    },
    dispose(): void {
      channel.disposed += 1;
    },
  };
  return channel;
}
