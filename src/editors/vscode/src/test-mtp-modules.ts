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
import { evaluateProject } from './msbuild.js';

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

/** Every project file directly under `dir` or below it, without `bin`/`obj`. */
function projectsUnder(dir: string, depth = 6): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && PROJECT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
    if (entry.isDirectory() && depth > 0 && !isIgnoredDirectory(entry.name)) {
      found.push(...projectsUnder(full, depth - 1));
    }
  }
  return found;
}

/** Build output and package directories never hold a source project. */
function isIgnoredDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'bin' || lower === 'obj' || lower === 'node_modules' || name.startsWith('.');
}

/** The project files of a solution, or of a directory that has none. */
export async function projectsOf(target: string, timeoutMs: number): Promise<string[]> {
  if (!isSolutionFile(target)) {
    return projectsUnder(fs.statSync(target).isDirectory() ? target : path.dirname(target));
  }
  const dir = path.dirname(target);
  const run = await runDotnet(['sln', target, 'list'], dir, timeoutMs);
  return parseSolutionProjects(run.stdout, dir);
}

/**
 * Every built module of one MTP project.
 *
 * A multi-targeted project reports an EMPTY `TargetPath` from the outer build —
 * it has no single target — and one module per declared framework instead. Both
 * shapes are handled here so the caller sees a plain list of modules.
 */
async function modulesOf(projectFile: string): Promise<string[]> {
  const evaluated = await evaluateProject(projectFile);
  if (!evaluated.ok) return [];
  if (evaluated.value.targetPath.length > 0) return [evaluated.value.targetPath];
  const modules: string[] = [];
  for (const framework of evaluated.value.targetFrameworks) {
    const pinned = await evaluateProject(projectFile, framework);
    if (pinned.ok && pinned.value.targetPath.length > 0) modules.push(pinned.value.targetPath);
  }
  return modules;
}

/** One project's MTP verdict, plus any diagnostic worth logging. */
async function scanProject(
  projectFile: string,
): Promise<{ project: MtpProject | undefined; warnings: string[] }> {
  const evaluated = await evaluateProject(projectFile);
  if (!evaluated.ok) {
    return {
      project: undefined,
      warnings: [`Could not evaluate ${projectFile}: ${evaluated.error}`],
    };
  }
  if (!evaluated.value.isTestingPlatformApplication) return { project: undefined, warnings: [] };
  const modules = (await modulesOf(projectFile)).filter((module) => fs.existsSync(module));
  if (modules.length === 0) {
    return {
      project: undefined,
      warnings: [`MTP test project built no module that exists on disk: ${projectFile}`],
    };
  }
  return { project: { projectFile, modules }, warnings: [] };
}

/** Build `target` so every test module exists before anything is asked of it. */
export async function buildTarget(
  target: string,
  cwd: string,
  timeoutMs: number,
): Promise<string[]> {
  const positional = cwd === target ? [] : [target];
  const run = await runDotnet(['build', ...positional, '--nologo'], cwd, timeoutMs);
  if (!run.failed) return [];
  const detail = `${run.stdout}\n${run.stderr}`.trim().slice(-2_000);
  return [`dotnet build reported a failure: ${run.errorMessage ?? 'unknown'}; output: ${detail}`];
}

/**
 * Build `target`, then report its MTP test projects and their modules.
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
  const warnings = await buildTarget(target, cwd, timeoutMs);
  const projects: MtpProject[] = [];
  for (const projectFile of await projectsOf(target, timeoutMs)) {
    const scanned = await scanProject(projectFile);
    warnings.push(...scanned.warnings);
    if (scanned.project !== undefined) projects.push(scanned.project);
  }
  return { projects, warnings };
}
