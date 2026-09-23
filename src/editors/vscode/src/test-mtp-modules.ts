/**
 * Finding the Microsoft.Testing.Platform test modules of a target.
 *
 * MTP prints no `Test run for <assembly>` banner, so the assemblies cannot be
 * scraped out of a listing the way the VSTest path scrapes them. They come from
 * MSBuild instead, which is the only source that survives a custom
 * `AssemblyName`, a custom `OutputPath`, an `ArtifactsPath` or a
 * `RuntimeIdentifier`.
 *
 * Nothing here throws: a project that cannot be evaluated adds a warning and
 * leaves the other projects alone.
 *
 * Implements [TEST-MTP-MODULES].
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOTNET_TIMEOUT_MS, runDotnet } from './dotnet-process.js';
import { evaluateProject, type ProjectProperties } from './msbuild.js';

/** Project file extensions the Test Explorer knows. */
const PROJECT_EXTENSIONS = ['.csproj', '.fsproj'];

/** Solution file extensions `dotnet sln list` accepts. */
const SOLUTION_EXTENSIONS = ['.sln', '.slnx', '.slnf'];

/** One MTP test project and the modules its target frameworks produced. */
export interface MtpProject {
  /** Absolute path of the project file. */
  readonly projectFile: string;
  /** Absolute paths of the built test modules, one per target framework. */
  readonly modules: readonly string[];
}

/** What a module sweep found. Never an exception. */
export interface MtpProjectScan {
  readonly projects: readonly MtpProject[];
  readonly warnings: readonly string[];
}

/** True when `target` is a solution file `dotnet sln list` understands. */
export function isSolutionFile(target: string): boolean {
  return SOLUTION_EXTENSIONS.includes(path.extname(target).toLowerCase());
}

/**
 * The project paths in `dotnet sln <solution> list` output.
 *
 * The command prints a two-line header (`Project(s)` and a rule) before the
 * paths, and the paths are RELATIVE to the solution. Lines are classified one
 * by one rather than sliced past a fixed header: a localized or a future header
 * would otherwise turn into a project path that does not exist.
 */
export function parseSolutionProjects(output: string, solutionDir: string): string[] {
  const projects: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!PROJECT_EXTENSIONS.includes(path.extname(line).toLowerCase())) continue;
    projects.push(path.resolve(solutionDir, line));
  }
  return projects;
}

/** True when `name` is a file `dotnet build <folder>` would pick up. */
function isBuildable(name: string): boolean {
  const extension = path.extname(name).toLowerCase();
  return PROJECT_EXTENSIONS.includes(extension) || SOLUTION_EXTENSIONS.includes(extension);
}

/** The project and solution files DIRECTLY inside `dir`, never below it. */
function buildableFilesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isBuildable(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** True when `target` is a directory on disk. */
function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Directory containing a target path (the path itself when it is a directory). */
export function dirOf(target: string): string {
  return isDirectory(target) ? target : path.dirname(target);
}

/**
 * The project files of `target`, resolved the way `dotnet` itself resolves it.
 *
 * A solution lists its projects, and a project file is that ONE project, never
 * its neighbours. A folder is the single project or solution file directly in
 * it: `dotnet` refuses a folder holding several (MSB1011) or none (MSB1003),
 * and so does this. Walking the folder instead listed modules an EARLIER build
 * had left on disk, as if they were live, while every run's build failed.
 */
export async function projectsOf(target: string, timeoutMs: number): Promise<string[]> {
  if (isSolutionFile(target)) {
    const dir = path.dirname(target);
    const run = await runDotnet(['sln', target, 'list'], dir, timeoutMs);
    return parseSolutionProjects(run.stdout, dir);
  }
  if (!isDirectory(target)) return [target];
  const [only, ...others] = buildableFilesIn(target);
  return only === undefined || others.length > 0 ? [] : await projectsOf(only, timeoutMs);
}

/**
 * Every module of one MTP project, from the evaluation already in hand.
 *
 * A multi-targeted project reports an EMPTY `TargetPath` from the outer build —
 * it has no single target — and one module per declared framework instead. Both
 * shapes are handled here so the caller sees a plain list of modules.
 */
async function modulesOf(projectFile: string, evaluated: ProjectProperties): Promise<string[]> {
  if (evaluated.targetPath.length > 0) return [evaluated.targetPath];
  const modules: string[] = [];
  for (const framework of evaluated.targetFrameworks) {
    const pinned = await evaluateProject(projectFile, framework);
    if (pinned.ok && pinned.value.targetPath.length > 0) modules.push(pinned.value.targetPath);
  }
  return modules;
}

/**
 * One project's MTP verdict from ONE evaluation, plus any diagnostic. The
 * modules are the ones MSBuild NAMES; whether they exist is the build's say.
 */
async function evaluateCandidate(
  projectFile: string,
): Promise<{ candidate: MtpProject | undefined; warnings: string[] }> {
  const evaluated = await evaluateProject(projectFile);
  if (!evaluated.ok) {
    return {
      candidate: undefined,
      warnings: [`Could not evaluate ${projectFile}: ${evaluated.error}`],
    };
  }
  if (!evaluated.value.isTestingPlatformApplication) return { candidate: undefined, warnings: [] };
  return {
    candidate: { projectFile, modules: await modulesOf(projectFile, evaluated.value) },
    warnings: [],
  };
}

/** Every MTP project of `target` as MSBuild evaluates it. Nothing is built. */
async function findMtpProjects(
  target: string,
  timeoutMs: number,
): Promise<{ candidates: MtpProject[]; warnings: string[] }> {
  const candidates: MtpProject[] = [];
  const warnings: string[] = [];
  for (const projectFile of await projectsOf(target, timeoutMs)) {
    const found = await evaluateCandidate(projectFile);
    warnings.push(...found.warnings);
    if (found.candidate !== undefined) candidates.push(found.candidate);
  }
  return { candidates, warnings };
}

/** The candidates whose modules the build really produced. */
function onDisk(candidates: readonly MtpProject[], warnings: readonly string[]): MtpProjectScan {
  const projects: MtpProject[] = [];
  const all = [...warnings];
  for (const candidate of candidates) {
    const modules = candidate.modules.filter((module) => fs.existsSync(module));
    if (modules.length > 0) projects.push({ projectFile: candidate.projectFile, modules });
    else all.push(`MTP test project built no module that exists on disk: ${candidate.projectFile}`);
  }
  return { projects, warnings: all };
}

/** Resolve current MSBuild outputs after a build, without building again. */
export async function builtMtpProjects(target: string, timeoutMs: number): Promise<MtpProjectScan> {
  const found = await findMtpProjects(target, timeoutMs);
  return onDisk(found.candidates, found.warnings);
}

/** Build `target` so every test module exists before anything is asked of it. */
export async function buildTarget(
  target: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const positional = cwd === target ? [] : [target];
  const run = await runDotnet(['build', ...positional, '--nologo'], cwd, timeoutMs, signal);
  if (!run.failed) return [];
  const detail = `${run.stdout}\n${run.stderr}`.trim().slice(-2_000);
  return [`dotnet build reported a failure: ${run.errorMessage ?? 'unknown'}; output: ${detail}`];
}

/**
 * Build `target`, then report its MTP test projects and their modules.
 *
 * The build comes FIRST because nothing may have restored the target yet, and
 * `IsTestingPlatformApplication` comes from the test framework's package: an
 * unrestored MTP project evaluates as an ordinary one.
 *
 * A build FAILURE is a warning, not a stop: a solution whose sibling project
 * does not compile still has modules from the projects that did, and dropping
 * them would blank the Testing view over an unrelated error.
 */
export async function scanMtpProjects(
  target: string,
  cwd: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
): Promise<MtpProjectScan> {
  const built = await buildTarget(target, cwd, timeoutMs);
  const found = await builtMtpProjects(target, timeoutMs);
  return { projects: found.projects, warnings: [...built, ...found.warnings] };
}

/**
 * Report the MTP test projects of a target the VSTest passes have just
 * restored, building it only when there turns out to be one.
 *
 * This runs after EVERY VSTest sweep that attributed no assembly — a library
 * solution with the Testing view open, a VSTest solution that failed to build.
 * Evaluating first is what keeps such a sweep at the one build VSTest already
 * paid for. Spec: [TEST-MTP-DETECT].
 */
export async function probeMtpProjects(
  target: string,
  cwd: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
): Promise<MtpProjectScan> {
  const found = await findMtpProjects(target, timeoutMs);
  if (found.candidates.length === 0) return { projects: [], warnings: found.warnings };
  const built = await buildTarget(target, cwd, timeoutMs);
  return onDisk(found.candidates, [...found.warnings, ...built]);
}
