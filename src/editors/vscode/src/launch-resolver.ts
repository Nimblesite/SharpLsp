// Turning the active document into a concrete thing to run or debug.
//
// Implements [DEBUG-FEATURES-LAUNCH-TARGET], [DEBUG-FEATURES-LAUNCH-BUILD],
// [DEBUG-FEATURES-LAUNCH-SCRIPT], [DEBUG-FEATURES-LAUNCH-PROFILES].
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  candidatesAt,
  classifyDocument,
  hasRuntimeConfig,
  walkCone,
  type DocumentKind,
} from './launch-target';
import { isRunnableOutputType, resolveTargetPath, type ProjectProperties } from './msbuild';
import { profileArgs, profileEnv, projectProfiles, readProfiles } from './launch-profiles';
import { err, ok, type Result } from './result';

/** Shown when nothing about the active document names something to launch. */
export const NO_TARGET_MESSAGE = 'No runnable .NET project or script found for the active document.';

/** A runnable project and everything a launch configuration needs from it. */
export interface ProjectTarget {
  readonly kind: 'project';
  readonly projectFile: string;
  readonly program: string;
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** A C# file-based app — a `.cs` with no owning project. */
export interface FileBasedTarget {
  readonly kind: 'fileBasedApp';
  readonly file: string;
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** A script run by an interpreter; there is no assembly to debug. */
export interface ScriptTarget {
  readonly kind: 'script';
  readonly runner: 'fsi' | 'dotnet-script';
  readonly file: string;
  readonly cwd: string;
}

export type LaunchTarget = ProjectTarget | FileBasedTarget | ScriptTarget;

/** How the caller wants ambiguity handled. */
export interface ResolveOptions {
  /** Pick one of several candidates. Returning undefined cancels. */
  readonly choose?: (items: readonly vscode.QuickPickItem[]) => Thenable<vscode.QuickPickItem | undefined>;
  /** A project the caller already decided on — the Solution Explorer path. */
  readonly projectFile?: string;
}

/** Default chooser: the real QuickPick. */
function defaultChoose(
  items: readonly vscode.QuickPickItem[],
): Thenable<vscode.QuickPickItem | undefined> {
  return vscode.window.showQuickPick(items, {
    title: 'Select a project to launch',
    placeHolder: 'More than one runnable project matched the active document',
  });
}

/** The workspace folder owning `file`, else the single open folder. */
export function folderFor(file: string | undefined): vscode.WorkspaceFolder | undefined {
  if (file !== undefined) {
    const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    if (owner !== undefined) return owner;
    // A document outside every folder must NOT silently borrow folder[0].
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length === 1 ? folders[0] : undefined;
}

/** MSBuild properties for each candidate, dropping any that fail to evaluate. */
async function evaluateAll(
  candidates: readonly string[],
): Promise<{ projectFile: string; properties: ProjectProperties }[]> {
  const evaluated = await Promise.all(
    candidates.map(async (projectFile) => ({
      projectFile,
      result: await resolveTargetPath(projectFile, (candidate) => fs.existsSync(candidate)),
    })),
  );
  return evaluated
    .filter((entry) => entry.result.ok)
    .map((entry) => ({
      projectFile: entry.projectFile,
      properties: entry.result.ok ? entry.result.value : ({} as ProjectProperties),
    }));
}

/** Keep only projects MSBuild says produce an executable. */
function runnableOnly(
  evaluated: readonly { projectFile: string; properties: ProjectProperties }[],
): { projectFile: string; properties: ProjectProperties }[] {
  return evaluated.filter(
    (entry) =>
      isRunnableOutputType(entry.properties.outputType) ||
      (entry.properties.targetPath.length > 0 && hasRuntimeConfig(entry.properties.targetPath)),
  );
}

/** Prompt for one of several runnable projects. */
async function chooseProject(
  runnable: readonly { projectFile: string; properties: ProjectProperties }[],
  options: ResolveOptions,
): Promise<string | undefined> {
  const items = runnable.map((entry) => ({
    label: path.basename(entry.projectFile),
    description: path.dirname(entry.projectFile),
  }));
  const choose = options.choose ?? defaultChoose;
  const picked = await choose(items);
  if (picked === undefined) return undefined;
  return runnable.find((entry) => path.basename(entry.projectFile) === picked.label)?.projectFile;
}

/** Apply the target's launch profile, if exactly one is eligible. */
function withProfile<T extends ProjectTarget | FileBasedTarget>(target: T, source: string): T {
  const eligible = projectProfiles(readProfiles(source));
  const profile = eligible.length === 1 ? eligible[0] : undefined;
  if (profile === undefined) return target;
  const args = profileArgs(profile);
  const env = profileEnv(profile);
  return {
    ...target,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
  };
}

/** Build a project target from an evaluated project. */
function projectTarget(projectFile: string, properties: ProjectProperties): ProjectTarget {
  const base: ProjectTarget = {
    kind: 'project',
    projectFile,
    program: properties.targetPath,
    cwd: path.dirname(projectFile),
  };
  return withProfile(base, projectFile);
}

/** Resolve a project target from a set of candidate project files. */
async function fromCandidates(
  candidates: readonly string[],
  options: ResolveOptions,
): Promise<Result<LaunchTarget, string>> {
  if (candidates.length === 0) return err(NO_TARGET_MESSAGE);
  const runnable = runnableOnly(await evaluateAll(candidates));
  if (runnable.length === 0) return err(NO_TARGET_MESSAGE);

  const only = runnable.length === 1 ? runnable[0] : undefined;
  if (only !== undefined) return ok(projectTarget(only.projectFile, only.properties));

  const chosen = await chooseProject(runnable, options);
  if (chosen === undefined) return err('');
  const entry = runnable.find((candidate) => candidate.projectFile === chosen);
  if (entry === undefined) return err(NO_TARGET_MESSAGE);
  return ok(projectTarget(entry.projectFile, entry.properties));
}

/** A script or file-based target for a project-less document. */
function projectlessTarget(kind: DocumentKind, file: string): Result<LaunchTarget, string> {
  const cwd = path.dirname(file);
  if (kind === 'csharpFileBasedApp') {
    return ok(withProfile({ kind: 'fileBasedApp', file, cwd }, file));
  }
  if (kind === 'fsharpScript') return ok({ kind: 'script', runner: 'fsi', file, cwd });
  if (kind === 'csharpScript') return ok({ kind: 'script', runner: 'dotnet-script', file, cwd });
  return err(NO_TARGET_MESSAGE);
}

/**
 * Resolve what the user's current context says to launch.
 *
 * An explicit `projectFile` (the Solution Explorer's right-click) wins; then the
 * active document's own cone; then, with no editor, the workspace folder itself.
 */
export async function resolveLaunchTarget(
  file: string | undefined,
  folder: vscode.WorkspaceFolder | undefined,
  options: ResolveOptions = {},
): Promise<Result<LaunchTarget, string>> {
  if (options.projectFile !== undefined) {
    return fromCandidates([options.projectFile], options);
  }
  const root = folder?.uri.fsPath;
  if (file === undefined) {
    if (root === undefined) return err(NO_TARGET_MESSAGE);
    return fromCandidates(candidatesAt(walkCone(root, root)), options);
  }
  if (root === undefined) return err(NO_TARGET_MESSAGE);

  const kind = classifyDocument(file, root);
  if (kind !== 'projectOwned') return projectlessTarget(kind, file);
  return fromCandidates(candidatesAt(walkCone(path.dirname(file), root)), options);
}
