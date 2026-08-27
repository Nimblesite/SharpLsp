// Deciding WHAT to run or debug, from the document the user is looking at.
//
// Implements [DEBUG-FEATURES-LAUNCH-TARGET], reusing the [SCRIPT-CONE] walk and
// the [SCRIPT-DETECT] taxonomy from docs/specs/SCRIPTING-FILEBASED-SPEC.md so
// the editor resolves a target exactly the way the LSP host classifies the same
// document. There is ONE resolver: F5, Ctrl/Cmd+F5, the editor context menu and
// the Solution Explorer all come through here.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The [SCRIPT-DETECT] document kinds a launch can be built from. */
export type DocumentKind =
  | 'projectOwned'
  | 'csharpFileBasedApp'
  | 'csharpScript'
  | 'fsharpScript'
  | 'unsupported';

/** Why the [SCRIPT-CONE] walk stopped. */
export type ConeStop = 'project' | 'solution' | 'workspace' | 'git' | 'root';

/** Where the cone walk ended and why. */
export interface ConeResult {
  /** Directory the walk stopped in; undefined when it left the workspace. */
  readonly dir: string | undefined;
  readonly stoppedAt: ConeStop;
}

const PROJECT_EXTENSIONS = ['.csproj', '.fsproj'];
const SOLUTION_EXTENSIONS = ['.sln', '.slnx'];

/** Case-insensitive on Windows and macOS; symlinks resolved where possible. */
export function normalizePath(value: string): string {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist yet still normalizes by resolve() alone.
  }
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/**
 * True when `child` is `parent` or lives beneath it.
 *
 * String equality alone is not a containment test: a start directory OUTSIDE
 * the workspace never equals the workspace root, so a walk guarded only by
 * equality runs to the filesystem root and can select an unrelated project from
 * an ancestor directory.
 */
export function isWithin(child: string, parent: string): boolean {
  const from = normalizePath(parent);
  const to = normalizePath(child);
  if (from === to) return true;
  return to.startsWith(from.endsWith(path.sep) ? from : from + path.sep);
}

/** Files in `dir`, or an empty list when it cannot be read. */
function entriesOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Project files directly inside `dir`, sorted for a stable prompt order. */
export function projectFilesIn(dir: string): string[] {
  return entriesOf(dir)
    .filter((entry) => PROJECT_EXTENSIONS.includes(path.extname(entry).toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(dir, entry));
}

/** Solution files directly inside `dir`. */
export function solutionFilesIn(dir: string): string[] {
  return entriesOf(dir)
    .filter((entry) => SOLUTION_EXTENSIONS.includes(path.extname(entry).toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(dir, entry));
}

/** True when `dir` holds a `.git` entry — a [SCRIPT-CONE] stop. */
function isRepositoryRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** What, if anything, makes `dir` a cone stop. */
function stopKindOf(dir: string): ConeStop | undefined {
  if (projectFilesIn(dir).length > 0) return 'project';
  if (solutionFilesIn(dir).length > 0) return 'solution';
  if (isRepositoryRoot(dir)) return 'git';
  return undefined;
}

/**
 * Walk from `startDir` toward the filesystem root per [SCRIPT-CONE], stopping at
 * the first of: a directory holding a project or solution, the workspace root, a
 * `.git` directory, or the filesystem root.
 */
export function walkCone(startDir: string, workspaceRoot: string | undefined): ConeResult {
  if (workspaceRoot !== undefined && !isWithin(startDir, workspaceRoot)) {
    return { dir: undefined, stoppedAt: 'workspace' };
  }
  let current = path.resolve(startDir);
  for (;;) {
    const stop = stopKindOf(current);
    if (stop !== undefined) return { dir: current, stoppedAt: stop };
    if (workspaceRoot !== undefined && isWithin(workspaceRoot, current)) {
      return { dir: current, stoppedAt: 'workspace' };
    }
    const parent = path.dirname(current);
    if (parent === current) return { dir: current, stoppedAt: 'root' };
    current = parent;
  }
}

/**
 * Classify a document per [SCRIPT-DETECT]: extension first, then the cone.
 *
 * `.csx` and `.fsx` are NEVER project-owned — MSBuild does not compile scripts —
 * so their kind is decided by extension alone.
 */
export function classifyDocument(file: string, workspaceRoot: string | undefined): DocumentKind {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.csx') return 'csharpScript';
  if (extension === '.fsx' || extension === '.fsscript') return 'fsharpScript';
  if (extension !== '.cs' && extension !== '.fs') return 'unsupported';

  const cone = walkCone(path.dirname(file), workspaceRoot);
  if (cone.stoppedAt === 'project' || cone.stoppedAt === 'solution') return 'projectOwned';
  // A project-less `.fs` has no file-based-app model; only C# has one.
  return extension === '.cs' ? 'csharpFileBasedApp' : 'unsupported';
}

/** Every project reachable from a cone stop: its own dir, or a solution's tree. */
export function candidatesAt(cone: ConeResult): string[] {
  if (cone.dir === undefined) return [];
  const direct = projectFilesIn(cone.dir);
  if (direct.length > 0 || cone.stoppedAt !== 'solution') return direct;
  return childProjectsOf(cone.dir);
}

/** Projects one level below a solution directory, for the common src/App layout. */
function childProjectsOf(root: string): string[] {
  const found: string[] = [];
  for (const entry of entriesOf(root)) {
    const child = path.join(root, entry);
    if (!isDirectory(child)) continue;
    found.push(...projectFilesIn(child));
  }
  return found.sort((left, right) => left.localeCompare(right));
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when a built assembly is a runnable application rather than a library.
 *
 * `<name>.runtimeconfig.json` beside `<name>.dll` is the on-disk evidence: the
 * SDK emits it only for an executable output type, so a library can never be
 * offered as a launch target even when its dll exists.
 */
export function hasRuntimeConfig(assemblyPath: string): boolean {
  const directory = path.dirname(assemblyPath);
  const stem = path.basename(assemblyPath, path.extname(assemblyPath));
  return fs.existsSync(path.join(directory, `${stem}.runtimeconfig.json`));
}

/** A project's launch entry: where its assembly is, and where to run it. */
export interface ProjectEntry {
  /** The project file this entry resolved. Always present. */
  readonly projectFile: string;
  /** The built assembly, or undefined when nothing has been built yet. */
  readonly dll: string | undefined;
  /** The project directory. */
  readonly cwd: string;
}

/** Output roots a build can land in, most likely first. */
const OUTPUT_ROOTS = ['bin', 'artifacts'];

/** Every file under `dir`, depth-first, bounded so a huge tree cannot stall. */
function walkFiles(dir: string, budget: number): string[] {
  if (budget <= 0) return [];
  const found: string[] = [];
  for (const entry of entriesOf(dir)) {
    const child = path.join(dir, entry);
    if (isDirectory(child)) {
      found.push(...walkFiles(child, budget - 1));
    } else {
      found.push(child);
    }
  }
  return found;
}

/**
 * The application assembly a project has actually produced, found by EVIDENCE
 * rather than by rebuilding the SDK's path convention.
 *
 * Searching for a dll with a sibling `<name>.runtimeconfig.json` handles a
 * custom `AssemblyName`, a custom `OutputPath`, a `RuntimeIdentifier` segment,
 * a non-Debug configuration and any target framework — all cases where the old
 * fixed `bin/Debug/<tfm>/<projectName>.dll` ladder returned a path that had
 * never existed. Returns undefined when nothing is built: a launch target must
 * never be fabricated.
 */
export function discoverAssembly(projectDir: string): string | undefined {
  const candidates: string[] = [];
  for (const root of OUTPUT_ROOTS) {
    const outputRoot = path.join(projectDir, root);
    if (!fs.existsSync(outputRoot)) continue;
    candidates.push(...walkFiles(outputRoot, 6).filter(isApplicationAssembly));
  }
  return preferDebug(candidates)[0];
}

/** A dll is an application when the SDK emitted a runtimeconfig beside it. */
function isApplicationAssembly(candidate: string): boolean {
  return path.extname(candidate).toLowerCase() === '.dll' && hasRuntimeConfig(candidate);
}

/** Debug output first, then most recently written. */
function preferDebug(candidates: readonly string[]): string[] {
  return [...candidates].sort((left, right) => {
    const byConfig = Number(isDebugOutput(right)) - Number(isDebugOutput(left));
    if (byConfig !== 0) return byConfig;
    return modifiedAt(right) - modifiedAt(left);
  });
}

function isDebugOutput(candidate: string): boolean {
  return candidate.split(path.sep).some((segment) => segment.toLowerCase() === 'debug');
}

function modifiedAt(candidate: string): number {
  try {
    return fs.statSync(candidate).mtimeMs;
  } catch {
    return 0;
  }
}

/** The launch entry for a project file. */
export function projectEntryFromFile(projectFile: string): ProjectEntry {
  const cwd = path.dirname(projectFile);
  return { projectFile, dll: discoverAssembly(cwd), cwd };
}

/**
 * Walk up from `startPath` to the nearest project, stopping at `stopPath`.
 *
 * The boundary is a CONTAINMENT test, not string equality: a start path outside
 * `stopPath` never equals it, so an equality-guarded walk escapes to the
 * filesystem root and can select an unrelated project from an ancestor.
 */
export function findProjectFile(startPath: string, stopPath: string): ProjectEntry | undefined {
  const cone = walkCone(startPath, stopPath);
  if (cone.dir === undefined) return undefined;
  const projects = candidatesAt(cone);
  const first = projects[0];
  return first === undefined ? undefined : projectEntryFromFile(first);
}

/** The launch entry for a workspace folder's own project, if it has one. */
export function findEntryProject(rootPath: string): ProjectEntry | undefined {
  return findProjectFile(rootPath, rootPath);
}
