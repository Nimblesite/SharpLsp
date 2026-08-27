// Asking MSBuild where a project's output actually is.
//
// Implements [DEBUG-FEATURES-LAUNCH-BUILD].
//
// A launch target must never be assembled from a guessed directory layout. The
// hardcoded `bin/Debug/<tfm>/<projectName>.dll` ladder this replaces is wrong
// for a custom `AssemblyName`, a custom `OutputPath`/`ArtifactsPath`, a
// `RuntimeIdentifier`, a non-Debug configuration, and any framework outside its
// fixed list — and it returned a fabricated path as though it had succeeded, so
// the failure surfaced as a raw adapter error instead of a usable message.
//
// `dotnet msbuild -getProperty:A -getProperty:B` emits a JSON document
// (`{"Properties": {...}}`) which is parsed with `JSON.parse`, never scraped.
import * as path from 'node:path';
import { runDotnet } from './dotnet-process';
import { err, ok, type Result } from './result';

/** The properties a launch needs from MSBuild. */
export interface ProjectProperties {
  /** Absolute path to the built assembly. Empty for a multi-targeted project. */
  readonly targetPath: string;
  /** The single target framework, or empty when multi-targeted. */
  readonly targetFramework: string;
  /** `;`-separated frameworks when multi-targeted, else empty. */
  readonly targetFrameworks: readonly string[];
  /** `Exe`, `WinExe` or `Library`. */
  readonly outputType: string;
}

/** MSBuild evaluation is a full project load; a cold one can take a while. */
const EVALUATE_TIMEOUT_MS = 120_000;

const REQUESTED = [
  'TargetPath',
  'TargetFramework',
  'TargetFrameworks',
  'OutputType',
  'RunCommand',
] as const;

/** `-getProperty:` arguments for a project, optionally pinned to one TFM. */
function evaluateArgs(projectFile: string, framework?: string): string[] {
  const args = ['msbuild', projectFile, '-nologo'];
  if (framework !== undefined && framework.length > 0) {
    args.push(`-p:TargetFramework=${framework}`);
  }
  for (const property of REQUESTED) args.push(`-getProperty:${property}`);
  return args;
}

/** The `Properties` bag of a `-getProperty` response, or an error. */
function parseProperties(stdout: string): Result<Record<string, string>, string> {
  const start = stdout.indexOf('{');
  if (start < 0) return err('MSBuild returned no JSON document');
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (typeof parsed !== 'object' || parsed === null) return err('MSBuild JSON was not an object');
    const bag: unknown = (parsed as { Properties?: unknown }).Properties;
    if (typeof bag !== 'object' || bag === null) return err('MSBuild JSON had no Properties');
    return ok(bag as Record<string, string>);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

/** Split a `;`-separated MSBuild list, dropping empties. */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Evaluate `projectFile`, optionally pinned to a single target framework. */
export async function evaluateProject(
  projectFile: string,
  framework?: string,
): Promise<Result<ProjectProperties, string>> {
  const run = await runDotnet(
    evaluateArgs(projectFile, framework),
    path.dirname(projectFile),
    EVALUATE_TIMEOUT_MS,
  );
  if (run.failed) {
    const reason = run.errorMessage ?? '';
    return err(reason.length > 0 ? reason : run.stderr);
  }
  const bag = parseProperties(run.stdout);
  if (!bag.ok) return bag;
  return ok({
    targetPath: bag.value['TargetPath'] ?? '',
    targetFramework: bag.value['TargetFramework'] ?? '',
    targetFrameworks: splitList(bag.value['TargetFrameworks']),
    outputType: bag.value['OutputType'] ?? '',
  });
}

/**
 * `TargetPath` for a project, re-querying per framework when multi-targeted.
 *
 * A bare `-getProperty:TargetPath` on a multi-targeted project returns an EMPTY
 * string and exit code 0 — the outer build has no single target. The framework
 * whose output already exists is preferred so a user who built one TFM debugs
 * that one; otherwise the first declared framework wins.
 */
export async function resolveTargetPath(
  projectFile: string,
  exists: (candidate: string) => boolean,
): Promise<Result<ProjectProperties, string>> {
  const evaluated = await evaluateProject(projectFile);
  if (!evaluated.ok) return evaluated;
  if (evaluated.value.targetPath.length > 0) return evaluated;

  const frameworks = evaluated.value.targetFrameworks;
  if (frameworks.length === 0) {
    return err(`MSBuild reported no TargetPath for ${path.basename(projectFile)}`);
  }
  return pickFramework(projectFile, frameworks, exists);
}

/** First multi-target framework whose output exists, else the first declared. */
async function pickFramework(
  projectFile: string,
  frameworks: readonly string[],
  exists: (candidate: string) => boolean,
): Promise<Result<ProjectProperties, string>> {
  let firstDeclared: ProjectProperties | undefined;
  for (const framework of frameworks) {
    const pinned = await evaluateProject(projectFile, framework);
    if (!pinned.ok) continue;
    firstDeclared ??= pinned.value;
    if (exists(pinned.value.targetPath)) return ok(pinned.value);
  }
  if (firstDeclared !== undefined) return ok(firstDeclared);
  return err(`no target framework of ${path.basename(projectFile)} could be evaluated`);
}

/** True when MSBuild says the project produces a runnable assembly. */
export function isRunnableOutputType(outputType: string): boolean {
  const normalized = outputType.trim().toLowerCase();
  return normalized === 'exe' || normalized === 'winexe';
}
