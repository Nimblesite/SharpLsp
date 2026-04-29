import * as path from 'node:path';
import { CancellationTokenSource, workspace, window } from 'vscode';
import * as log from './log.js';

/** Result of solution discovery. */
export interface SolutionSelection {
  /** Absolute path to the chosen solution file. */
  readonly path: string;
  /** Display name including extension. */
  readonly name: string;
}

/** Discover .sln/.slnx files in the workspace and let the user pick if needed. */
export async function selectSolution(): Promise<SolutionSelection | undefined> {
  const solutions = await findSolutions();

  if (solutions.length === 0) {
    log.info('No solution files found in workspace.');
    window.showInformationMessage('SharpLsp: No .sln or .slnx files found in this workspace.');
    return undefined;
  }

  if (solutions.length === 1) {
    const [selected] = solutions;
    if (selected !== undefined) {
      log.info(`Auto-selected solution: ${selected.path}`);
      return selected;
    }
  }

  return promptUserSelection(solutions);
}

/** Prompt the user to pick from multiple solutions. */
export async function promptUserSelection(
  solutions: readonly SolutionSelection[],
): Promise<SolutionSelection | undefined> {
  const items = solutions.map((sol) => ({
    label: sol.name,
    description: sol.path,
    solution: sol,
  }));

  const picked = await window.showQuickPick(items, {
    placeHolder: 'Select a solution to open',
    title: 'SharpLsp: Multiple solutions found',
  });

  if (picked === undefined) {
    log.info('User cancelled solution selection.');
    return undefined;
  }

  log.info(`User selected solution: ${picked.solution.path}`);
  return picked.solution;
}

/** Find all .sln/.slnx files across workspace folders. */
export async function findSolutions(): Promise<SolutionSelection[]> {
  const folders = workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) {
    return [];
  }

  const pattern = '**/*.{sln,slnx}';
  const excludePattern = '**/{node_modules,bin,obj,target}/**';
  const cts = new CancellationTokenSource();
  const timer = setTimeout(() => {
    cts.cancel();
  }, 5_000);
  try {
    const uris = await workspace.findFiles(pattern, excludePattern, 50, cts.token);
    return toSolutionSelections(uris.map((uri) => uri.fsPath));
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

/** Build sorted solution selections from absolute file paths. */
export function toSolutionSelections(paths: readonly string[]): SolutionSelection[] {
  return paths
    .map((solutionPath) => ({
      path: solutionPath,
      name: path.basename(solutionPath),
    }))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    );
}
