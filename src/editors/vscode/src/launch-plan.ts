// Turning a resolved launch target into the configuration netcoredbg starts:
// the base shape [DEBUG-FEATURES-LAUNCH-NOCONFIG] fixes, the build that makes
// the program exist ([DEBUG-FEATURES-LAUNCH-BUILD] rule 3) and the args/env a
// project target contributes.
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './constants';
import { type LaunchTarget, type ProjectTarget } from './launch-resolver';
import { buildFileBasedApp, buildProject, scriptDebugMessage } from './launch-run';
import { fileNameOf } from './paths';

/** A launch configuration in the shape [DEBUG-FEATURES-LAUNCH-NOCONFIG] fixes. */
export function baseConfiguration(
  name: string,
  program: string | undefined,
  cwd: string,
): vscode.DebugConfiguration {
  return {
    type: DEBUG_TYPE,
    request: 'launch',
    name,
    ...(program === undefined ? {} : { program }),
    cwd,
    console: 'integratedTerminal',
    justMyCode: true,
  };
}

/** The file a target's launch profiles belong to. */
export function targetSource(target: LaunchTarget): string {
  return target.kind === 'project' ? target.projectFile : target.file;
}

/** Everything a launch needs, once a target has been turned into a program. */
interface LaunchPlan {
  readonly configuration: vscode.DebugConfiguration;
  readonly folder: vscode.WorkspaceFolder;
}

/** Build a debug configuration for a resolved project or file-based target. */
export async function planLaunch(
  target: LaunchTarget,
  folder: vscode.WorkspaceFolder,
  noDebug: boolean,
): Promise<LaunchPlan | undefined> {
  const program = await programFor(target);
  if (program === undefined) return undefined;
  const named =
    target.kind === 'project' ? fileNameOf(target.projectFile) : fileNameOf(target.file);
  const configuration: vscode.DebugConfiguration = {
    ...baseConfiguration(`${noDebug ? 'Run' : 'Debug'} ${named}`, program, target.cwd),
    ...(target.kind === 'script' ? {} : argsAndEnv(target)),
  };
  return { configuration, folder };
}

/** The `args`/`env` a non-script target contributes. */
function argsAndEnv(target: ProjectTarget | Exclude<LaunchTarget, ProjectTarget>): object {
  if (target.kind === 'script') return {};
  return {
    ...(target.args === undefined ? {} : { args: [...target.args] }),
    ...(target.env === undefined ? {} : { env: { ...target.env } }),
  };
}

/** The assembly to debug, building the target first so its output exists. */
export async function programFor(target: LaunchTarget): Promise<string | undefined> {
  if (target.kind === 'project') return await builtProgram(target);
  if (target.kind === 'script') {
    void vscode.window.showWarningMessage(scriptDebugMessage(target.runner));
    return undefined;
  }
  const built = await buildFileBasedApp(target.file);
  if (!built.ok) {
    void vscode.window.showWarningMessage(built.error);
    return undefined;
  }
  return built.value;
}

/**
 * Build a project, then confirm on disk that it produced what will be launched.
 *
 * [DEBUG-FEATURES-LAUNCH-BUILD] rule 3: after the build step the resolved
 * program MUST exist; if it does not, the session MUST NOT start.
 */
async function builtProgram(target: ProjectTarget): Promise<string | undefined> {
  const built = await buildProject(target.projectFile, target.framework);
  const named = fileNameOf(target.projectFile);
  if (!built.ok) {
    void vscode.window.showWarningMessage(`Build failed for ${named}: ${built.error}`);
    return undefined;
  }
  const program = target.program;
  if (program.length > 0 && fs.existsSync(program)) return program;
  void vscode.window.showWarningMessage(`Build produced no output for ${named}.`);
  return undefined;
}
