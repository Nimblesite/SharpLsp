// Running a target without a debugger, and building one so it can be debugged.
//
// Implements [DEBUG-FEATURES-LAUNCH-SCRIPT], [DEBUG-FEATURES-LAUNCH-BUILD].
//
// Script and file-based runs are dispatched as a `vscode.Task`, never typed into
// a terminal: `Terminal.sendText` has no read-back, no exit code and no
// cancellation, so a terminal run can neither be observed nor reported. A Task
// exposes its command, its arguments and its process exit code.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { currentDotnetExecutable, runDotnet } from './dotnet-process';
import { err, ok, type Result } from './result';
import type { FileBasedTarget, ScriptTarget } from './launch-resolver';

/** Task type and source for every run SharpLsp dispatches. */
export const RUN_TASK_TYPE = 'sharplsp-run';
export const RUN_TASK_SOURCE = 'SharpLsp';

/** Where a file-based app's debug build is staged, under the entry file's dir. */
export const ARTIFACTS_DIRNAME = '.sharplsp-run';

/** Told to the user when `.fsx` debugging is asked for. */
export const FSX_DEBUG_MESSAGE =
  'F# scripts cannot be debugged: dotnet fsi emits no assembly or PDB to attach to. Run the script instead.';

/** Told to the user when a `.csx` run is asked for and no runner resolves. */
export const CSX_TOOL_MESSAGE =
  'Running C# scripts needs the dotnet-script global tool: dotnet tool install -g dotnet-script';

/** Build the argv for running a target without a debugger. */
export function runArgs(target: FileBasedTarget | ScriptTarget): string[] {
  if (target.kind === 'fileBasedApp') {
    // `--file` and never the positional `dotnet run <path>`: inside a directory
    // that holds a project, the positional form runs THE PROJECT and passes the
    // path along as an application argument, launching the wrong program.
    return ['run', '--file', target.file, ...(target.args ?? [])];
  }
  return target.runner === 'fsi' ? ['fsi', '--exec', target.file] : [target.file];
}

/** The executable a target runs under. */
function runExecutable(target: FileBasedTarget | ScriptTarget): string {
  const script = target.kind === 'script' ? target : undefined;
  return script?.runner === 'dotnet-script' ? 'dotnet-script' : currentDotnetExecutable();
}

/** A task that runs `target`, ready for `vscode.tasks.executeTask`. */
export function runTask(
  target: FileBasedTarget | ScriptTarget,
  scope: vscode.WorkspaceFolder | vscode.TaskScope,
): vscode.Task {
  const execution = new vscode.ProcessExecution(runExecutable(target), runArgs(target), {
    cwd: target.cwd,
    ...(target.kind === 'fileBasedApp' && target.env !== undefined
      ? { env: { ...target.env } }
      : {}),
  });
  const task = new vscode.Task(
    { type: RUN_TASK_TYPE, file: target.file },
    scope,
    `Run ${path.basename(target.file)}`,
    RUN_TASK_SOURCE,
    execution,
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
  };
  return task;
}

/**
 * Build a project so its output exists before a launch.
 *
 * SharpLsp performs this build itself ([DEBUG-FEATURES-LAUNCH-BUILD] rule 1):
 * naming a `preLaunchTask` of a type it does not contribute aborts F5 with a
 * modal, and a build the user's `debug.onTaskErrors` setting can wave past is
 * not a guarantee that the assembly exists. Exactly one MSBuild process runs.
 */
export async function buildProject(projectFile: string): Promise<Result<void>> {
  const run = await runDotnet(['build', projectFile], path.dirname(projectFile));
  if (!run.failed) return ok(undefined);
  const reason = run.errorMessage ?? '';
  return err(reason.length > 0 ? reason : run.stderr || run.stdout);
}

/** True when the `dotnet-script` global tool can be found. */
export async function hasDotnetScript(): Promise<boolean> {
  const run = await runDotnet(['tool', 'list', '--global'], process.cwd(), 30_000);
  return !run.failed && run.stdout.includes('dotnet-script');
}

/**
 * Build a file-based app so it can be debugged.
 *
 * `--artifacts-path` is mandatory: the default output lands in a per-platform,
 * SHA-256-keyed runfile cache (`%TEMP%/dotnet/runfile` on Windows,
 * `~/Library/Application Support/dotnet/runfile` on macOS,
 * `$XDG_DATA_HOME/dotnet/runfile` on Linux), so without it the produced assembly
 * has no path a `launch` request could name.
 */
export async function buildFileBasedApp(file: string): Promise<Result<string>> {
  const artifacts = path.join(path.dirname(file), ARTIFACTS_DIRNAME);
  const run = await runDotnet(['build', file, '--artifacts-path', artifacts], path.dirname(file));
  if (run.failed) {
    const reason = run.errorMessage ?? '';
    return err(reason.length > 0 ? reason : run.stderr || run.stdout);
  }
  const produced = fileBasedAssembly(artifacts, file);
  if (!fs.existsSync(produced)) {
    return err(`Build produced no output for ${path.basename(file)}.`);
  }
  return ok(produced);
}

/**
 * Where `dotnet build <file>.cs --artifacts-path <dir>` puts the assembly.
 *
 * `bin/<configuration-lowercased>/<name>.dll` with NO target-framework segment,
 * unlike a project's `bin/Debug/<tfm>/`. The two layouts must not share a path
 * builder.
 */
export function fileBasedAssembly(artifactsDir: string, entryFile: string): string {
  const stem = path.basename(entryFile, path.extname(entryFile));
  return path.join(artifactsDir, 'bin', 'debug', `${stem}.dll`);
}
