import * as fs from 'node:fs';
import { fileNameOf, isAbsolutePath, joinPath } from './paths';
import { CancellationTokenSource, workspace, window } from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import * as log from './log.js';

/** Result of solution discovery. */
export interface SolutionSelection {
  /** Absolute path to the chosen solution file. */
  readonly path: string;
  /** Display name including extension. */
  readonly name: string;
}

/** The part of the server's effective configuration that names the solution. */
interface SolutionConfiguration {
  readonly csharp?: { readonly solution_path?: string };
}

/**
 * The solution `csharp.solution_path` names (sharplsp.toml or an editor
 * setting), when its file exists. The server already opened it, so the
 * extension shows that one and never asks which of the workspace's solutions to
 * load. A stale entry is no choice: the picker follows, as discovery follows on
 * the server. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
 */
export async function configuredSolution(
  client: LanguageClient | undefined,
): Promise<SolutionSelection | undefined> {
  // The server resolves a relative entry against ITS root: the client's folder.
  const folder = client?.clientOptions.workspaceFolder ?? workspace.workspaceFolders?.[0];
  const root = folder?.uri.fsPath;
  if (client === undefined || root === undefined) return undefined;
  const resolved = await client.sendRequest<SolutionConfiguration>('sharplsp/configuration', {});
  const configured = resolved.csharp?.solution_path ?? '';
  if (configured === '') return undefined;
  const file = isAbsolutePath(configured) ? configured : joinPath(root, configured);
  if (!fs.existsSync(file)) {
    log.warn('csharp.solution_path names no existing file; asking which solution to load');
    return undefined;
  }
  return toSolutionSelections([file])[0];
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

  return await promptUserSelection(solutions);
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
      name: fileNameOf(solutionPath),
    }))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    );
}
