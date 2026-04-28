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

function createBuildTask(command: string, label: string): vscode.Task {
  const dotnetCommand = command === 'rebuild' ? 'build' : command;
  const args = command === 'rebuild' ? ['--no-incremental'] : [];

  const execution = new vscode.ShellExecution('dotnet', [dotnetCommand, ...args]);
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
function parseBuildDiagnostics(output: string): void {
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

/** Run dotnet build and capture diagnostics. */
export async function buildWithDiagnostics(
  command: string,
  extraArgs: string[] = [],
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined) return;

  const dotnetCommand = command === 'rebuild' ? 'build' : command;
  const args = [dotnetCommand, ...extraArgs];
  if (command === 'rebuild') args.push('--no-incremental');

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
    vscode.commands.registerCommand(CMD_BUILD, async () => {
      info('Running dotnet build');
      runDotnetCommand('build');
      await buildWithDiagnostics('build');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_REBUILD, async () => {
      info('Running dotnet rebuild');
      runDotnetCommand('build', ['--no-incremental']);
      await buildWithDiagnostics('rebuild');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_CLEAN, () => {
      info('Running dotnet clean');
      runDotnetCommand('clean');
      diagnosticCollection.clear();
    }),
  );
}

function runDotnetCommand(command: string, extraArgs: string[] = []): void {
  try {
    const terminal =
      vscode.window.terminals.find((t) => t.name === 'SharpLsp Build') ??
      vscode.window.createTerminal('SharpLsp Build');
    terminal.show(true);
    terminal.sendText(`dotnet ${command} ${extraArgs.join(' ')}`.trim());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Build failed: ${message}`);
  }
}
