import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD_BUILD, CMD_REBUILD, CMD_CLEAN } from './constants';
import { currentDotnetExecutable } from './dotnet-process';
import { describeSdkPinFailure } from './dotnetRuntime.js';
import { info } from './log';

const diagnosticCollection = vscode.languages.createDiagnosticCollection('sharplsp-build');

/**
 * Provides build tasks for dotnet build/rebuild/clean.
 *
 * The task type is declared in `contributes.taskDefinitions`; without that
 * declaration VS Code rejects every task this provider returns, so none of them
 * appear in Run Task and none can be named from a `preLaunchTask`.
 * Implements [DEBUG-FEATURES-LAUNCH-BUILD].
 */
export class SharpLspBuildTaskProvider implements vscode.TaskProvider {
  public static readonly Type = 'sharplsp-build';

  /** The task source, and so the `<source>: <name>` a preLaunchTask names. */
  public static readonly Source = 'SharpLsp';

  public provideTasks(): vscode.Task[] {
    return [
      createBuildTask('build', 'Build'),
      createBuildTask('rebuild', 'Rebuild'),
      createBuildTask('clean', 'Clean'),
    ];
  }

  public resolveTask(task: vscode.Task): vscode.Task | undefined {
    const command = String(task.definition.command ?? '');
    if (command.length === 0) {
      return undefined;
    }
    return createBuildTask(command, task.name);
  }
}

/**
 * A task that runs `dotnet <command>` with the msCompile matcher.
 *
 * `ProcessExecution`, not `ShellExecution`: a target path containing a space or
 * a shell metacharacter is passed as one argv entry rather than re-parsed by the
 * user's shell, and the command and arguments stay readable on the task itself.
 */
export function createBuildTask(command: string, label: string, target?: string): vscode.Task {
  const execution = new vscode.ProcessExecution(
    currentDotnetExecutable(),
    dotnetArgs(command, target),
  );
  const task = new vscode.Task(
    { type: SharpLspBuildTaskProvider.Type, command, ...(target === undefined ? {} : { target }) },
    vscode.TaskScope.Workspace,
    label,
    SharpLspBuildTaskProvider.Source,
    execution,
    '$msCompile',
  );
  task.group = vscode.TaskGroup.Build;
  // [SE-ACTIONS-BUILD]: "Output appears in VS Code terminal".
  //
  // Nothing dispatches this task on the user's behalf. The pre-launch build of
  // [DEBUG-FEATURES-LAUNCH-BUILD] rule 1 runs IN-PROCESS through msbuild.ts, so
  // every run of this task is one a person asked for — from the Solution
  // Explorer, the palette, Run Task or their own `tasks.json`. The previous
  // `Silent` + `close: true` was written for a headless pre-launch build that no
  // longer dispatches it, and it made a user-invoked build invisible: the panel
  // was never revealed and the terminal was disposed the instant MSBuild exited,
  // so a success, a compile error and a `dotnet` that never launched at all all
  // produced the same observation — nothing.
  //
  // `Dedicated` keys the terminal to THIS task, so repeated builds reuse one
  // panel instead of stacking (the default `Shared` would hand the build any
  // idle task terminal, and terminating it would dispose a terminal some other
  // task created). `clear` means the visible output is this run's, not this run
  // appended to the last one.
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };
  return task;
}

/** The `<source>: <name>` a `preLaunchTask` must use to reach the build task. */
export const BUILD_TASK_NAME = `${SharpLspBuildTaskProvider.Source}: Build`;

/** A diagnostic parsed out of one MSBuild output line. */
interface BuildDiagnostic {
  readonly file: string;
  readonly diagnostic: vscode.Diagnostic;
}

/**
 * Parse `path(line,col): error CODE: message` into a diagnostic.
 *
 * Split on the structural separators MSBuild guarantees rather than matched with
 * a regex over the whole line: a Windows path carries a `:` after the drive
 * letter and a message can contain anything at all.
 */
function parseDiagnosticLine(line: string): BuildDiagnostic | undefined {
  const open = line.indexOf('(');
  const close = line.indexOf(')', open);
  if (open <= 0 || close < 0 || line[close + 1] !== ':') return undefined;
  const position = line.slice(open + 1, close).split(',');
  const lineNumber = Number.parseInt(position[0] ?? '', 10);
  const column = Number.parseInt(position[1] ?? '', 10);
  if (!Number.isFinite(lineNumber) || !Number.isFinite(column)) return undefined;

  const rest = line.slice(close + 2).trim();
  const severity = rest.startsWith('error ')
    ? vscode.DiagnosticSeverity.Error
    : rest.startsWith('warning ')
      ? vscode.DiagnosticSeverity.Warning
      : undefined;
  if (severity === undefined) return undefined;

  const range = new vscode.Range(lineNumber - 1, column - 1, lineNumber - 1, column - 1);
  const diagnostic = new vscode.Diagnostic(range, rest, severity);
  diagnostic.source = 'dotnet build';
  return { file: line.slice(0, open), diagnostic };
}

/** Parse MSBuild diagnostic output and publish it. */
export function parseBuildDiagnostics(output: string): void {
  diagnosticCollection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const line of output.split(/\r?\n/)) {
    const parsed = parseDiagnosticLine(line);
    if (parsed === undefined) continue;
    const existing = byFile.get(parsed.file) ?? [];
    existing.push(parsed.diagnostic);
    byFile.set(parsed.file, existing);
  }
  for (const [file, diagnostics] of byFile) {
    diagnosticCollection.set(vscode.Uri.file(file), diagnostics);
  }
}

/**
 * `dotnet`'s exit code when `hostfxr_resolve_sdk2` cannot satisfy a
 * `global.json` pin — "A compatible .NET SDK was not found".
 */
export const SDK_RESOLUTION_EXIT_CODE = 155;

/**
 * Explain a failed build when the cause is an unsatisfiable SDK pin.
 *
 * `dotnet` prints the real reason — the requested version, the `global.json`
 * responsible, and the installed SDKs — to the task terminal. That terminal now
 * stays up ([SE-ACTIONS-BUILD]), but nothing makes the user read it, and a
 * `dotnet` that never launched writes no reason there at all: VS Code's generic
 * "failed to launch (exit code: 155)" is the whole of it. The notification names
 * the cause outright. Implements [DIST-FAILURE-UX].
 */
export function diagnoseBuildFailure(
  exitCode: number | undefined,
  dotnetPath: string,
  workspaceRoot?: string,
): string | undefined {
  if (exitCode === undefined || exitCode === 0) return undefined;
  if (workspaceRoot === undefined) return undefined;
  return describeSdkPinFailure(dotnetPath, workspaceRoot);
}

/** Show the SDK-pin diagnosis for a build that exited non-zero, if that was the cause. */
async function reportBuildFailure(event: vscode.TaskProcessEndEvent): Promise<void> {
  if (event.execution.task.source !== SharpLspBuildTaskProvider.Source) return;
  const diagnosis = diagnoseBuildFailure(
    event.exitCode,
    currentDotnetExecutable(),
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
  if (diagnosis === undefined) return;
  info(`build failed with exit code ${String(event.exitCode)}: ${diagnosis}`);
  await vscode.window.showErrorMessage(`SharpLsp could not build: ${diagnosis}`);
}

/** A solution/project tree node that can supply an MSBuild target file path. */
interface BuildTarget {
  readonly projectFilePath?: string;
}

/** Register build commands and task provider. */
export function registerBuildCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(diagnosticCollection);
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((event) => {
      void reportBuildFailure(event);
    }),
  );
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      SharpLspBuildTaskProvider.Type,
      new SharpLspBuildTaskProvider(),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_BUILD, async (node?: BuildTarget) => {
      await runDotnetTask('build', 'Build', node);
    }),
    vscode.commands.registerCommand(CMD_REBUILD, async (node?: BuildTarget) => {
      await runDotnetTask('rebuild', 'Rebuild', node);
    }),
    vscode.commands.registerCommand(CMD_CLEAN, async (node?: BuildTarget) => {
      await runDotnetTask('clean', 'Clean', node);
    }),
  );
}

/**
 * Run build/rebuild/clean ONCE, as a task.
 *
 * The previous implementation ran the build twice for every request — once typed
 * into a terminal and once headlessly through `execFile` — so two MSBuild
 * processes raced on the same `obj/` lock files, and neither the exit code nor
 * the command line of the terminal copy could be observed.
 */
export async function runDotnetTask(
  command: string,
  label: string,
  node?: BuildTarget,
): Promise<void> {
  const target = targetFromNode(node);
  info(`Running dotnet ${command}${target === undefined ? '' : ` for ${target}`}`);
  if (command === 'clean') diagnosticCollection.clear();
  const task = createBuildTask(command, label, target);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: progressTitle(command, target) },
    async () => {
      await runToCompletion(task);
    },
  );
}

/** The gerund each build verb reports while it runs. */
const PROGRESS_VERBS: Readonly<Record<string, string>> = {
  build: 'Building',
  rebuild: 'Rebuilding',
  clean: 'Cleaning',
};

/** What the progress notification says: the verb, and what it is acting on. */
export function progressTitle(command: string, target?: string): string {
  const verb = PROGRESS_VERBS[command] ?? 'Running';
  return target === undefined ? `${verb} the workspace` : `${verb} ${path.basename(target)}`;
}

/**
 * Start `task` and resolve once its run has ended.
 *
 * The end listener goes up BEFORE the task starts, and is keyed on the task
 * object this module just built: a build that fails to launch ends almost
 * immediately, and a listener registered after `executeTask` resolves can miss
 * that — leaving a progress notification up over a build that is already over.
 * [SE-ACTIONS-BUILD] requires the notification to last exactly as long as the
 * build, which means neither flashing past it nor outliving it.
 */
async function runToCompletion(task: vscode.Task): Promise<void> {
  let settle: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const subscription = vscode.tasks.onDidEndTask((event) => {
    if (event.execution.task === task) settle();
  });
  try {
    await vscode.tasks.executeTask(task);
    await ended;
  } finally {
    subscription.dispose();
  }
}

/** Publish diagnostics for a finished build's output. */
export function publishBuildOutput(output: string): void {
  parseBuildDiagnostics(output);
}

/** Resolve the .sln/.csproj/.fsproj a node represents, if any. */
export function targetFromNode(node?: BuildTarget): string | undefined {
  const target = node?.projectFilePath;
  return target !== undefined && target.length > 0 ? target : undefined;
}

/** Build the dotnet CLI argument list for a command targeting an optional file. */
export function dotnetArgs(command: string, target?: string): string[] {
  const dotnetCommand = command === 'rebuild' ? 'build' : command;
  const args = [dotnetCommand];
  if (target !== undefined) args.push(target);
  if (command === 'rebuild') args.push('--no-incremental');
  return args;
}
