// Records the tasks the extension starts, and each one's process from start to
// exit, for the run/debug suites. [DEBUG-FEATURES-LAUNCH-SCRIPT]
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { binaryNameOf } from '../../platform.js';
import { getErrorMessage } from '../../utils.js';
import { pollUntilResult, sleep } from './test-helpers';
import { DEBUG_SESSION_MS, QUIET_MS } from './test-timeouts';

/** One observed task execution and the process result it produced. */
export interface ObservedTask {
  readonly name: string;
  readonly source: string;
  readonly definitionType: string;
  readonly command: string | undefined;
  readonly args: readonly string[];
}

/** Flatten a task's execution into readable command + args. */
function executionOf(task: vscode.Task): { command: string | undefined; args: string[] } {
  const execution = task.execution;
  if (execution instanceof vscode.ProcessExecution) {
    return { command: execution.process, args: [...execution.args] };
  }
  if (execution instanceof vscode.ShellExecution) {
    const command = execution.command;
    const name = typeof command === 'string' ? command : command?.value;
    // A ShellExecution built from a whole command LINE carries no args at all.
    const args = (execution.args ?? []).map((arg) => (typeof arg === 'string' ? arg : arg.value));
    return { command: name, args };
  }
  return { command: undefined, args: [] };
}

/**
 * One execution as VS Code reported it, in milliseconds since the recorder
 * started. A task whose exit never came (#533) is told apart by these: a process
 * that never started, one still running, or one that ended without a code.
 */
interface Lifecycle {
  readonly name: string;
  readonly started: number;
  pid?: number;
  processStarted?: number;
  processEnded?: number;
  /** Absent until the process ends; `undefined` after, when VS Code reported no code. */
  exitCode?: number | undefined;
  ended?: number;
}

/** Whether `pid` is a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What became of one execution, for a failure message. */
function describe(each: Lifecycle): string {
  const pid = each.pid;
  const spawned =
    pid === undefined
      ? 'its process never started'
      : `process ${String(pid)} started at +${String(each.processStarted)}ms and is ${alive(pid) ? 'still alive' : 'gone'}`;
  const code = each.exitCode === undefined ? 'NO exit code' : `exit code ${String(each.exitCode)}`;
  const exited =
    each.processEnded === undefined
      ? 'no process end was reported'
      : `its process ended at +${String(each.processEnded)}ms with ${code}`;
  const task =
    each.ended === undefined
      ? 'the task never ended'
      : `the task ended at +${String(each.ended)}ms`;
  return `'${each.name}' started at +${String(each.started)}ms: ${spawned}, ${exited}, ${task}`;
}

/**
 * Records every task the extension starts and every task process that ends.
 *
 * A script run must be dispatched as a `vscode.Task`, not typed into a terminal
 * ([DEBUG-FEATURES-LAUNCH-SCRIPT] rule 1) — precisely so that its command, its
 * arguments and its exit code are observable here. `Terminal.sendText` has no
 * read-back API, so a terminal-based run can assert nothing about what it ran.
 */
export class TaskRecorder {
  private readonly startedTasks: ObservedTask[] = [];
  private readonly exitCodes: number[] = [];
  private readonly lifecycles = new Map<vscode.TaskExecution, Lifecycle>();
  private readonly origin = Date.now();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.tasks.onDidStartTask((event) => {
        this.onStart(event.execution);
      }),
      vscode.tasks.onDidStartTaskProcess((event) => {
        this.track(event.execution, { pid: event.processId, processStarted: this.now() });
      }),
      vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.exitCode !== undefined) this.exitCodes.push(event.exitCode);
        this.track(event.execution, { exitCode: event.exitCode, processEnded: this.now() });
      }),
      vscode.tasks.onDidEndTask((event) => {
        this.track(event.execution, { ended: this.now() });
      }),
    );
  }

  private now(): number {
    return Date.now() - this.origin;
  }

  private onStart(execution: vscode.TaskExecution): void {
    const task = execution.task;
    const { command, args } = executionOf(task);
    this.startedTasks.push({
      name: task.name,
      source: task.source,
      definitionType: task.definition.type,
      command,
      args,
    });
    this.lifecycles.set(execution, { name: task.name, started: this.now() });
  }

  /** Fold one later event into its execution's lifecycle. */
  private track(execution: vscode.TaskExecution, event: Partial<Lifecycle>): void {
    const known = this.lifecycles.get(execution) ?? { name: execution.task.name, started: -1 };
    this.lifecycles.set(execution, { ...known, ...event });
  }

  /** Every task observed so far, in start order. */
  public get started(): readonly ObservedTask[] {
    return this.startedTasks;
  }

  /** Exit codes of task processes that have finished. */
  public get exits(): readonly number[] {
    return this.exitCodes;
  }

  /**
   * Tasks whose command is the `dotnet` CLI — the run paths we care about.
   *
   * Named through {@link binaryNameOf}, never `endsWith('dotnet')`.
   * [DIST-RUNTIME-ACQUIRE] resolves an ABSOLUTE SDK path, so the command is
   * `C:\Program Files\dotnet\dotnet.exe` on Windows and
   * `/usr/share/dotnet/dotnet` elsewhere: a suffix test matched every POSIX run
   * and NO Windows run at all, which is why every script run read as zero tasks
   * there while passing on macOS and Linux. It also matched an unrelated
   * `mydotnet`, so it was both too narrow and too wide.
   */
  public get dotnetTasks(): readonly ObservedTask[] {
    return this.startedTasks.filter((task) => binaryNameOf(task.command ?? '') === 'dotnet');
  }

  /** Wait for at least `count` `dotnet` tasks to start. */
  public async waitForDotnetTasks(
    count = 1,
    timeoutMs = DEBUG_SESSION_MS,
  ): Promise<readonly ObservedTask[]> {
    return pollUntilResult(
      async () => this.dotnetTasks,
      (tasks) => tasks.length >= count,
      timeoutMs,
      100,
    );
  }

  /**
   * Wait for at least `count` task processes to report an exit code. When they
   * do not, the failure says what became of every task process. (#533)
   */
  public async waitForExits(count = 1, timeoutMs = DEBUG_SESSION_MS): Promise<readonly number[]> {
    try {
      return await pollUntilResult(
        async () => this.exits,
        (codes) => codes.length >= count,
        timeoutMs,
        100,
      );
    } catch (cause: unknown) {
      const seen = [...this.lifecycles.values()].map(describe);
      assert.fail(`${getErrorMessage(cause)}. Tasks: ${seen.join('; ') || 'none started'}`);
    }
  }

  /** Settle, then assert no task ran. Proves a refusal did not run anything. */
  public async assertNoTask(reason: string, quietMs = QUIET_MS): Promise<void> {
    await sleep(quietMs);
    assert.deepStrictEqual(
      this.dotnetTasks.map((task) => `${task.command ?? '?'} ${task.args.join(' ')}`),
      [],
      reason,
    );
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
