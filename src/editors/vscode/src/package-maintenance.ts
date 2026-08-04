/**
 * Solution-Explorer package maintenance commands.
 *
 * Implements [PKG-UNUSED-UI] and [PKG-CONSOLIDATE-UI]: detect-then-confirm
 * flows over the host's `sharplsp/nuget/unused` and `sharplsp/nuget/consolidate`
 * custom requests. Removal reuses the existing `dependencies.removeNuGetPackage`
 * path so there is one canonical "remove a package" implementation.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import * as deps from './dependencies.js';
import * as log from './log.js';
import { type ExplorerNode } from './tree.js';
import { getErrorMessage } from './utils.js';

// ── Wire types (match the Rust host responses) ────────────────────

interface UnusedPackage {
  readonly id: string;
  readonly version: string;
}

interface UnusedResponse {
  readonly projectPath: string;
  readonly unused: UnusedPackage[];
}

interface MovedPackage {
  readonly id: string;
  readonly version: string;
  readonly fromProjects: string[];
}

interface ConsolidateResponse {
  readonly moved: MovedPackage[];
  readonly propsFile?: string;
  readonly modifiedFiles: string[];
  readonly message: string;
}

/** Per-project unused-package finding. */
interface Finding {
  readonly projectPath: string;
  readonly unused: UnusedPackage[];
}

// ── Node → project paths ──────────────────────────────────────────

/** Collect distinct project file paths under a node (self or descendants). */
export function collectProjectPaths(node: ExplorerNode | undefined): string[] {
  const paths = new Set<string>();
  const visit = (current: ExplorerNode): void => {
    if (current.contextValue === 'project' && current.projectFilePath !== undefined) {
      paths.add(current.projectFilePath);
    }
    for (const child of current.children) {
      visit(child);
    }
  };
  if (node !== undefined) visit(node);
  return [...paths];
}

// ── Remove Unused Packages [PKG-UNUSED-UI] ────────────────────────

/** Detect and remove unused direct package references for a node. */
export async function removeUnusedPackages(
  node: ExplorerNode | undefined,
  lsp: LanguageClient | undefined,
  refresh: () => Promise<void>,
): Promise<void> {
  if (lsp === undefined) {
    void vscode.window.showWarningMessage('SharpLsp server not available.');
    return;
  }
  const projects = collectProjectPaths(node);
  if (projects.length === 0) {
    void vscode.window.showWarningMessage('No project selected.');
    return;
  }

  const findings = await detectUnusedForProjects(lsp, projects);
  const total = findings.reduce((sum, finding) => sum + finding.unused.length, 0);
  if (total === 0) {
    void vscode.window.showInformationMessage('No unused packages found.');
    return;
  }

  if (!(await confirmRemoval(findings, total))) return;
  await applyRemoval(findings, refresh);
}

/** Query each project for unused packages, keeping only non-empty findings. */
async function detectUnusedForProjects(
  lsp: LanguageClient,
  projects: string[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const projectPath of projects) {
    const response = await detectUnused(lsp, projectPath);
    if (response !== undefined && response.unused.length > 0) {
      findings.push({ projectPath, unused: response.unused });
    }
  }
  return findings;
}

/** Send the `sharplsp/nuget/unused` request for a single project. */
async function detectUnused(
  lsp: LanguageClient,
  projectPath: string,
): Promise<UnusedResponse | undefined> {
  try {
    log.info(`nuget/unused: ${projectPath}`);
    return await lsp.sendRequest<UnusedResponse>('sharplsp/nuget/unused', { projectPath });
  } catch (err: unknown) {
    log.error(`nuget/unused failed for ${projectPath}: ${getErrorMessage(err)}`);
    return undefined;
  }
}

/** Modal confirmation listing the packages to be removed. */
async function confirmRemoval(findings: Finding[], total: number): Promise<boolean> {
  const summary = findings
    .map((f) => `${path.basename(f.projectPath)}: ${f.unused.map((u) => u.id).join(', ')}`)
    .join('\n');
  const answer = await vscode.window.showWarningMessage(
    `Remove ${String(total)} unused package(s)?\n\n${summary}`,
    { modal: true },
    'Remove',
  );
  return answer === 'Remove';
}

/** Remove every found package via the canonical removal path, then refresh. */
async function applyRemoval(findings: Finding[], refresh: () => Promise<void>): Promise<void> {
  let removed = 0;
  const errors: string[] = [];
  for (const finding of findings) {
    for (const pkg of finding.unused) {
      const error = await deps.removeNuGetPackage(finding.projectPath, pkg.id);
      if (error === undefined) removed++;
      else errors.push(`${pkg.id}: ${error}`);
    }
  }
  await refresh();
  if (errors.length > 0) {
    void vscode.window.showErrorMessage(
      `Removed ${String(removed)} package(s); ${String(errors.length)} failed: ${errors.join('; ')}`,
    );
  } else {
    void vscode.window.showInformationMessage(`Removed ${String(removed)} unused package(s).`);
  }
}

// ── Consolidate Packages [PKG-CONSOLIDATE-UI] ─────────────────────

/** Scan for shared packages, confirm, then hoist them into Directory.Build.props. */
export async function consolidatePackages(
  node: ExplorerNode | undefined,
  lsp: LanguageClient | undefined,
  refresh: () => Promise<void>,
): Promise<void> {
  if (lsp === undefined) {
    void vscode.window.showWarningMessage('SharpLsp server not available.');
    return;
  }
  const solutionPath = node?.projectFilePath;
  if (solutionPath === undefined) {
    void vscode.window.showWarningMessage('No solution selected.');
    return;
  }

  const preview = await requestConsolidate(lsp, solutionPath, true);
  if (preview === undefined) return;
  if (preview.moved.length === 0) {
    void vscode.window.showInformationMessage(preview.message);
    return;
  }

  if (!(await confirmConsolidation(preview.moved))) return;

  const result = await requestConsolidate(lsp, solutionPath, false);
  if (result === undefined) return;
  await refresh();
  void vscode.window.showInformationMessage(result.message);
}

/** Send the `sharplsp/nuget/consolidate` request (scan or apply). */
async function requestConsolidate(
  lsp: LanguageClient,
  solutionPath: string,
  dryRun: boolean,
): Promise<ConsolidateResponse | undefined> {
  try {
    log.info(`nuget/consolidate: ${solutionPath} (dryRun=${String(dryRun)})`);
    return await lsp.sendRequest<ConsolidateResponse>('sharplsp/nuget/consolidate', {
      solutionPath,
      dryRun,
    });
  } catch (err: unknown) {
    void vscode.window.showErrorMessage(`Consolidate failed: ${getErrorMessage(err)}`);
    return undefined;
  }
}

/** Modal confirmation listing the packages that will be hoisted. */
async function confirmConsolidation(moved: MovedPackage[]): Promise<boolean> {
  const summary = moved
    .map((m) => {
      const version = m.version !== '' ? ` ${m.version}` : '';
      return `${m.id}${version} (${String(m.fromProjects.length)} projects)`;
    })
    .join('\n');
  const answer = await vscode.window.showWarningMessage(
    `Move ${String(moved.length)} shared package(s) into Directory.Build.props?\n\n${summary}`,
    { modal: true },
    'Move',
  );
  return answer === 'Move';
}
