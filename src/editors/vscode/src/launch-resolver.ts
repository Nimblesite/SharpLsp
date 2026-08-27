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
import {
  profileArgs,
  profileEnv,
  projectProfiles,
  readProfiles,
  type LaunchProfile,
} from './launch-profiles';
import { err, ok, type Result } from './result';

/** Shown when nothing about the active document names something to launch. */
export const NO_TARGET_MESSAGE =
  'No runnable .NET project or script found for the active document.';

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
  readonly choose?: (
    items: readonly vscode.QuickPickItem[],
    options: vscode.QuickPickOptions,
  ) => Thenable<vscode.QuickPickItem | undefined>;
  /** A project the caller already decided on — the Solution Explorer path. */
  readonly projectFile?: string;
}

/** Default chooser: the real QuickPick. */
function defaultChoose(
  items: readonly vscode.QuickPickItem[],
  options: vscode.QuickPickOptions,
): Thenable<vscode.QuickPickItem | undefined> {
  return vscode.window.showQuickPick(items, options);
}

/** Asked when the active document's cone holds several runnable projects. */
const PROJECT_PICK: vscode.QuickPickOptions = {
  title: 'Select a project to launch',
  placeHolder: 'More than one runnable project matched the active document',
};

/** Asked when the resolved target declares several `Project` launch profiles. */
const PROFILE_PICK: vscode.QuickPickOptions = {
  title: 'Select a launch profile',
  placeHolder: 'This project declares more than one launch profile',
};

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
  const usable: { projectFile: string; properties: ProjectProperties }[] = [];
  for (const entry of evaluated) {
    if (entry.result.ok)
      usable.push({ projectFile: entry.projectFile, properties: entry.result.value });
  }
  return usable;
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
  const picked = await choose(items, PROJECT_PICK);
  if (picked === undefined) return undefined;
  return runnable.find((entry) => path.basename(entry.projectFile) === picked.label)?.projectFile;
}

/**
 * Apply the target's eligible `Project` launch profile.
 *
 * One eligible profile applies silently. SEVERAL is a real ambiguity — each
 * carries its own arguments, environment and URLs — so the user is asked which
 * to launch. Taking the first silently runs a configuration the developer never
 * chose, and the difference is invisible until the program misbehaves.
 */
async function withProfile<T extends ProjectTarget | FileBasedTarget>(
  target: T,
  source: string,
  options: ResolveOptions,
): Promise<T> {
  const profile = await chooseProfile(projectProfiles(readProfiles(source)), options);
  if (profile === undefined) return target;
  const args = profileArgs(profile);
  const env = profileEnv(profile);
  return {
    ...target,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
  };
}

/** The sole eligible profile, or the one the user picks from several. */
async function chooseProfile(
  eligible: readonly LaunchProfile[],
  options: ResolveOptions,
): Promise<LaunchProfile | undefined> {
  if (eligible.length <= 1) return eligible[0];
  const choose = options.choose ?? defaultChoose;
  const items = eligible.map((profile) => ({ label: profile.name }));
  const picked = await choose(items, PROFILE_PICK);
  return eligible.find((profile) => profile.name === picked?.label);
}

/** Build a project target from an evaluated project. */
async function projectTarget(
  projectFile: string,
  properties: ProjectProperties,
  options: ResolveOptions,
): Promise<ProjectTarget> {
  const base: ProjectTarget = {
    kind: 'project',
    projectFile,
    program: properties.targetPath,
    cwd: path.dirname(projectFile),
  };
  return await withProfile(base, projectFile, options);
}

/** Resolve a project target from a set of candidate project files. */
async function fromCandidates(
  candidates: readonly string[],
  options: ResolveOptions,
): Promise<Result<LaunchTarget>> {
  if (candidates.length === 0) return err(NO_TARGET_MESSAGE);
  const runnable = runnableOnly(await evaluateAll(candidates));
  if (runnable.length === 0) return err(NO_TARGET_MESSAGE);

  const only = runnable.length === 1 ? runnable[0] : undefined;
  if (only !== undefined) {
    return ok(await projectTarget(only.projectFile, only.properties, options));
  }

  const chosen = await chooseProject(runnable, options);
  if (chosen === undefined) return err('');
  const entry = runnable.find((candidate) => candidate.projectFile === chosen);
  if (entry === undefined) return err(NO_TARGET_MESSAGE);
  return ok(await projectTarget(entry.projectFile, entry.properties, options));
}

/** A script or file-based target for a project-less document. */
async function projectlessTarget(
  kind: DocumentKind,
  file: string,
  options: ResolveOptions,
): Promise<Result<LaunchTarget>> {
  const cwd = path.dirname(file);
  if (kind === 'csharpFileBasedApp') {
    return ok(await withProfile({ kind: 'fileBasedApp', file, cwd }, file, options));
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
): Promise<Result<LaunchTarget>> {
  if (options.projectFile !== undefined) {
    return await fromCandidates([options.projectFile], options);
  }
  const root = folder?.uri.fsPath;
  if (file === undefined) {
    if (root === undefined) return err(NO_TARGET_MESSAGE);
    return await fromCandidates(candidatesAt(walkCone(root, root)), options);
  }
  if (root === undefined) return err(NO_TARGET_MESSAGE);

  const kind = classifyDocument(file, root);
  if (kind !== 'projectOwned') return await projectlessTarget(kind, file, options);
  return await fromCandidates(candidatesAt(walkCone(path.dirname(file), root)), options);
}
