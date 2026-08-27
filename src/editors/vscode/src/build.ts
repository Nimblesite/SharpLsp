import * as vscode from 'vscode';
import { CMD_BUILD, CMD_REBUILD, CMD_CLEAN } from './constants';
import { currentDotnetExecutable } from './dotnet-process';
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
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
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

/** A solution/project tree node that can supply an MSBuild target file path. */
interface BuildTarget {
  readonly projectFilePath?: string;
}

/** Register build commands and task provider. */
export function registerBuildCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(diagnosticCollection);
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
  await vscode.tasks.executeTask(createBuildTask(command, label, target));
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
