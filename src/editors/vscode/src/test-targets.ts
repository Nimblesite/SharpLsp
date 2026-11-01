/**
 * Where the Test Explorer looks, and how it classifies a test name.
 *
 * Split out of `testing.ts` so the controller file stays about the VS Code
 * Testing API wiring and nothing else.
 */

import * as fs from 'node:fs';
import { directoryOf, hasExtension } from './paths';
import * as vscode from 'vscode';
import * as state from './state';

export { dirOf } from './test-mtp-modules';

/** Extensions `dotnet test <folder>` resolves from a folder's top level. */
const BUILDABLE_EXTENSIONS = ['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj'] as const;

/**
 * The paths to enumerate: the loaded solution, else each workspace folder that
 * `dotnet test` can resolve. A folder with no solution or project at its top
 * level (a Rust repo with one C# host three folders down) always fails with
 * MSB1003, so it is no target — enumerating it only paints a false
 * "Test discovery failed" row. [TEST-DISCOVERY-TARGETS]
 */
export function discoveryTargets(): string[] {
  const solution = state.solutionPath.value;
  if (solution !== undefined) {
    return [solution];
  }
  return (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath)
    .filter(holdsBuildableFile);
}

function holdsBuildableFile(folder: string): boolean {
  try {
    return fs.readdirSync(folder).some((name) => hasExtension(name, ...BUILDABLE_EXTENSIONS));
  } catch {
    return false;
  }
}

/**
 * The positional argument for a `dotnet test` run: the loaded solution.
 *
 * Without one, `dotnet test` resolves the project from the working directory —
 * and a directory holding more than one project or solution file makes it error
 * out instead of running anything.
 */
export function runTarget(): string | undefined {
  return state.solutionPath.value;
}

/** Working directory for `dotnet test` runs: the loaded solution's folder. */
export function runCwd(): string | undefined {
  const solution = state.solutionPath.value;
  if (solution !== undefined) {
    return directoryOf(solution);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** True when a test name matches Expecto naming conventions. */
export function isExpectoTest(name: string): boolean {
  return name.includes('Expecto') || name.includes('testCase') || name.includes('testList');
}

/** True when a test name matches FsCheck property-test conventions. */
export function isFsCheckTest(name: string): boolean {
  return name.includes('FsCheck') || name.includes('Property');
}
/**
 * The filter ids a run uses. "Run everything, nothing excluded" is how VS Code
 * expresses ▶ on the root of the Testing view; passing NO filter then runs every
 * test in ONE `dotnet test` — instead of N command-line-sized filter batches.
 */
export function filterIdsFor(
  request: vscode.TestRunRequest,
  tests: readonly vscode.TestItem[],
): readonly string[] {
  const unfiltered = request.include === undefined && (request.exclude ?? []).length === 0;
  return unfiltered ? [] : tests.map((test) => test.id);
}
