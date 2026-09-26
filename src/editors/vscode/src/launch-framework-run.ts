/**
 * Run without debugging a MULTI-targeted project under ONE of its frameworks:
 * the one its documents answer from ([NETFX-CONTEXT]), else the first it
 * declares. It runs as `dotnet run --framework <tfm>`, a task with no debug
 * adapter, so a .NET Framework build starts on the desktop CLR it needs and a
 * .NET build through its own host. Implements [NETFX-DEBUG].
 */
import { fileStemOf, resolvePath } from './paths';
import * as vscode from 'vscode';
import { currentDotnetExecutable } from './dotnet-process';
import { RUN_TASK_SOURCE, RUN_TASK_TYPE } from './launch-run';
import type { ProjectTarget } from './launch-resolver';
import { info } from './log';
import { evaluateProject } from './msbuild';
import { err, ok, type Result } from './result';
import { isNetFramework, netFrameworkDebugRefusal } from './test-frameworks';

/** What the language server says a document's project answers from. */
export interface FrameworkAnswer {
  readonly active: string | undefined;
  readonly project: string | undefined;
}

/** Reads a document's framework context from the language server. */
export type ActiveFrameworkReader = (file: string) => Promise<FrameworkAnswer | undefined>;

/** The `dotnet` arguments that run `target` under `framework`. */
export function frameworkRunArgs(target: ProjectTarget, framework: string): string[] {
  const args = target.args ?? [];
  return [
    'run',
    '--project',
    target.projectFile,
    '--framework',
    framework,
    ...(args.length === 0 ? [] : ['--', ...args]),
  ];
}

/** True when both paths name the same file, whatever the host's spelling. */
function sameFile(left: string, right: string): boolean {
  const normalize = (file: string): string => resolvePath(file).toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * The framework to run: the active one when `document` belongs to the project,
 * else the first `frameworks` declares.
 */
export async function chosenFramework(
  target: ProjectTarget,
  frameworks: readonly string[],
  document: string | undefined,
  read: ActiveFrameworkReader | undefined,
): Promise<string> {
  const [first = ''] = frameworks;
  const answer = document === undefined ? undefined : await read?.(document);
  const owned = answer?.project !== undefined && sameFile(answer.project, target.projectFile);
  return owned && answer.active !== undefined ? answer.active : first;
}

/** A task that runs `target` under `framework`, ready for `vscode.tasks.executeTask`. */
export function frameworkRunTask(
  target: ProjectTarget,
  framework: string,
  scope: vscode.WorkspaceFolder | vscode.TaskScope,
): vscode.Task {
  const execution = new vscode.ProcessExecution(
    currentDotnetExecutable(),
    frameworkRunArgs(target, framework),
    { cwd: target.cwd, ...(target.env === undefined ? {} : { env: { ...target.env } }) },
  );
  const name = fileStemOf(target.projectFile);
  const task = new vscode.Task(
    { type: RUN_TASK_TYPE, project: target.projectFile, framework },
    scope,
    `Run ${name} (${framework})`,
    RUN_TASK_SOURCE,
    execution,
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
  };
  return task;
}

/** Run `target` under the framework its focused document answers from. */
export async function runUnderFramework(
  target: ProjectTarget,
  frameworks: readonly string[],
  scope: vscode.WorkspaceFolder,
  document: string | undefined,
  read: ActiveFrameworkReader | undefined,
): Promise<void> {
  const framework = await chosenFramework(target, frameworks, document, read);
  info(`Run: ${fileStemOf(target.projectFile)} under ${framework}`);
  await vscode.tasks.executeTask(frameworkRunTask(target, framework, scope));
}

/**
 * The target F5 debugs: netcoredbg attaches to .NET only, so a multi-targeted
 * project is debugged under its active framework when that is .NET, else under
 * the first .NET framework it declares — never a .NET Framework build it could
 * not attach to. A project with no .NET framework is refused. [NETFX-DEBUG]
 */
export async function debuggableTarget(
  target: ProjectTarget,
  frameworks: readonly string[],
  document: string | undefined,
  read: ActiveFrameworkReader | undefined,
): Promise<Result<ProjectTarget>> {
  const active = await chosenFramework(target, frameworks, document, read);
  const net = [active, ...frameworks].find(
    (framework) => !isNetFramework(framework) && !framework.startsWith('netstandard'),
  );
  if (net === undefined) return err(netFrameworkDebugRefusal(fileStemOf(target.projectFile)));
  if (net === target.framework) return ok(target);
  const evaluated = await evaluateProject(target.projectFile, net);
  return evaluated.ok
    ? ok({ ...target, framework: net, program: evaluated.value.targetPath })
    : evaluated;
}
