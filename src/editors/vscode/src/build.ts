import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { CMD_BUILD, CMD_REBUILD, CMD_CLEAN } from './constants';
import { info } from './log';

const diagnosticCollection = vscode.languages.createDiagnosticCollection('sharplsp-build');

/**
 * Provides build tasks for dotnet build/rebuild/clean.
 */
export class SharpLspBuildTaskProvider implements vscode.TaskProvider {
  public static readonly Type = 'sharplsp-build';

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

/** Build a VS Code shell task that runs `dotnet <command>` with the msCompile matcher. */
export function createBuildTask(command: string, label: string): vscode.Task {
  const execution = new vscode.ShellExecution('dotnet', dotnetArgs(command));
  const task = new vscode.Task(
    { type: SharpLspBuildTaskProvider.Type, command },
    vscode.TaskScope.Workspace,
    label,
    'SharpLsp',
    execution,
    '$msCompile',
  );
  task.group = vscode.TaskGroup.Build;
  return task;
}

/**
 * Parse MSBuild diagnostic output and push to VS Code diagnostics.
 */
export function parseBuildDiagnostics(output: string): void {
  diagnosticCollection.clear();
  const diagnosticMap = new Map<string, vscode.Diagnostic[]>();

  // Match: path(line,col): error/warning CODE: message
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(\w+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const [, filePath, lineStr, colStr, severity, code, message] = match;
    if (
      filePath === undefined ||
      lineStr === undefined ||
      colStr === undefined ||
      message === undefined
    )
      continue;

    const line = parseInt(lineStr, 10) - 1;
    const col = parseInt(colStr, 10) - 1;
    const range = new vscode.Range(line, col, line, col);
    const diag = new vscode.Diagnostic(
      range,
      `${String(code)}: ${message}`,
      severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diag.source = 'dotnet build';

    const existing = diagnosticMap.get(filePath) ?? [];
    existing.push(diag);
    diagnosticMap.set(filePath, existing);
  }

  for (const [filePath, diags] of diagnosticMap) {
    diagnosticCollection.set(vscode.Uri.file(filePath), diags);
  }
}

/** Run dotnet build/clean for an optional target file and capture diagnostics. */
export async function buildWithDiagnostics(command: string, target?: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined) return;

  const args = dotnetArgs(command, target);

  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile('dotnet', args, { cwd: folder, timeout: 120000 }, (error, stdout, stderr) => {
        // Build may "fail" with non-zero exit but still produce output.
        resolve(stdout + '\n' + stderr);
        if (error !== null && stdout.length === 0 && stderr.length === 0) {
          reject(new Error(error.message));
        }
      });
    });
    parseBuildDiagnostics(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    info(`Build diagnostics capture failed: ${message}`);
  }
}

/** A solution/project tree node that can supply an MSBuild target file path. */
interface BuildTarget {
  readonly projectFilePath?: string;
}

/**
 * Register build commands and task provider.
 */
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
      await runDotnetTask('build', node);
    }),
    vscode.commands.registerCommand(CMD_REBUILD, async (node?: BuildTarget) => {
      await runDotnetTask('rebuild', node);
    }),
    vscode.commands.registerCommand(CMD_CLEAN, async (node?: BuildTarget) => {
      await runDotnetTask('clean', node);
    }),
  );
}

/** Run build/rebuild/clean for the workspace, or for a right-clicked solution/project node. */
async function runDotnetTask(command: string, node?: BuildTarget): Promise<void> {
  const target = targetFromNode(node);
  const scope = target !== undefined ? ` for ${target}` : '';
  info(`Running dotnet ${command}${scope}`);
  runDotnetCommand(command, target);
  if (command === 'clean') {
    diagnosticCollection.clear();
    return;
  }
  await buildWithDiagnostics(command, target);
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

function runDotnetCommand(command: string, target?: string): void {
  try {
    const terminal =
      vscode.window.terminals.find((t) => t.name === 'SharpLsp Build') ??
      vscode.window.createTerminal('SharpLsp Build');
    terminal.show(true);
    const args = dotnetArgs(command, target).map(quoteArg);
    terminal.sendText(`dotnet ${args.join(' ')}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Build failed: ${message}`);
  }
}

/** Wrap an argument in double quotes when it contains whitespace. */
export function quoteArg(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}
