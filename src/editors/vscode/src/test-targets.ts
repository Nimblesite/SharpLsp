/**
 * Where the Test Explorer looks, and how it classifies a test name.
 *
 * Split out of `testing.ts` so the controller file stays about the VS Code
 * Testing API wiring and nothing else.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as state from './state';

/** The paths to enumerate: the loaded solution, else each workspace folder. */
export function discoveryTargets(): string[] {
  const solution = state.solutionPath.value;
  if (solution !== undefined) {
    return [solution];
  }
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** Directory containing a target path (the path itself when it is a directory). */
export function dirOf(target: string): string {
  try {
    return fs.statSync(target).isDirectory() ? target : path.dirname(target);
  } catch {
    return path.dirname(target);
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
    return path.dirname(solution);
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
