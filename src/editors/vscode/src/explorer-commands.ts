/**
 * Solution Explorer context-menu and dependency commands.
 * Implements [SE-COMMANDS], [SE-ACTIONS], [SE-CONTEXT-VALUES] and [SE-NAVIGATION].
 */
import * as vscode from 'vscode';
import { type ExtensionContext, commands, window, workspace } from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { addFSharpSourceFile } from './add-source-file.js';
import {
  CMD_ADD_FSHARP_FILE,
  CMD_ADD_PROJECT_REFERENCE,
  CMD_ADD_REFERENCE_AND_IMPORT,
  CMD_BROWSE_NUGET_PACKAGES,
  CMD_CONSOLIDATE_PACKAGES,
  CMD_COPY_NAME,
  CMD_COPY_QUALIFIED_NAME,
  CMD_NUGET_ADD_FROM_EXPLORER,
  CMD_OPEN_PROJECT_FILE,
  CMD_REMOVE_FSHARP_FILE,
  CMD_REMOVE_NUGET_PACKAGE,
  CMD_REMOVE_PROJECT_REFERENCE,
  CMD_REMOVE_UNUSED_PACKAGES,
  CMD_REVEAL_IN_EXPLORER,
  CMD_SORT_MEMBERS,
} from './constants.js';
import * as deps from './dependencies.js';
import * as log from './log.js';
import { addNuGetPackageToProject } from './nuget.js';
import { NuGetBrowserPanel } from './nuget-browser.js';
import * as pkgMaint from './package-maintenance.js';
import { samePath } from './paths';
import { addReferenceAndImport } from './reference-import-command.js';
import { removeFSharpSourceFile } from './remove-source-file.js';
import { DEFAULT_SORT_POLICY } from './sort-members-policy.js';
import { type ExplorerNode, type SolutionExplorerProvider, buildQualifiedName } from './tree.js';
import { getErrorMessage } from './utils.js';

/** The live client and explorer the commands act on; either may not exist yet. */
export interface ExplorerCommandDeps {
  readonly client: () => LanguageClient | undefined;
  readonly explorer: () => SolutionExplorerProvider | undefined;
}

type NodeCommand = (node?: ExplorerNode) => Promise<void> | void;

/** Register every Solution Explorer row command. */
export function registerExplorerCommands(
  context: ExtensionContext,
  api: ExplorerCommandDeps,
): void {
  const refresh = async (): Promise<void> => {
    await api.explorer()?.refresh();
  };
  const handlers: Record<string, NodeCommand> = {
    [CMD_COPY_QUALIFIED_NAME]: async (node) => {
      await copyToClipboard(node, buildQualifiedName);
    },
    [CMD_COPY_NAME]: async (node) => {
      await copyToClipboard(node, (n) => n.sortName);
    },
    [CMD_REVEAL_IN_EXPLORER]: revealInExplorer,
    [CMD_SORT_MEMBERS]: async (node) => {
      await sortMembers(node, api.client());
    },
    [CMD_OPEN_PROJECT_FILE]: openProjectFile,
    [CMD_ADD_PROJECT_REFERENCE]: async (node) => {
      await addProjectReference(node, refresh);
    },
    [CMD_ADD_FSHARP_FILE]: addFSharpSourceFile,
    [CMD_REMOVE_FSHARP_FILE]: removeFSharpSourceFile,
    [CMD_NUGET_ADD_FROM_EXPLORER]: addNuGetFromExplorer,
    [CMD_REMOVE_NUGET_PACKAGE]: async (node) => {
      await confirmAndRemoveDependency(node, 'package', refresh);
    },
    [CMD_REMOVE_PROJECT_REFERENCE]: async (node) => {
      await confirmAndRemoveDependency(node, 'reference', refresh);
    },
    [CMD_BROWSE_NUGET_PACKAGES]: (node) => {
      browseNuGetPackages(node, context, api.client);
    },
    [CMD_REMOVE_UNUSED_PACKAGES]: async (node) => {
      await pkgMaint.removeUnusedPackages(node, api.client(), refresh);
    },
    [CMD_CONSOLIDATE_PACKAGES]: async (node) => {
      await pkgMaint.consolidatePackages(node, api.client(), refresh);
    },
  };
  context.subscriptions.push(
    ...Object.entries(handlers).map(([id, handler]) => commands.registerCommand(id, handler)),
    // Invoked by the import quick fix with its own argument, never a tree row.
    commands.registerCommand(CMD_ADD_REFERENCE_AND_IMPORT, addReferenceAndImport),
  );
}

/** Copy `text(node)` and confirm; the Command Palette passes no node. [SE-CONTEXT-VALUES] */
async function copyToClipboard(
  node: ExplorerNode | undefined,
  text: (node: ExplorerNode) => string,
): Promise<void> {
  if (node === undefined) {
    void window.showWarningMessage('Select an item in the Solution Explorer first.');
    return;
  }
  const value = text(node);
  await vscode.env.clipboard.writeText(value);
  void window.showInformationMessage(`Copied: ${value}`);
}

function revealInExplorer(node?: ExplorerNode): void {
  if (node?.symbolUri === undefined) return;
  void commands.executeCommand('revealInExplorer', vscode.Uri.parse(node.symbolUri));
}

/**
 * The project file a Solution Explorer command was invoked on, or `undefined`
 * once the user has been told why nothing happened. The Command Palette
 * invokes these commands with no argument at all ([SE-CONTEXT-VALUES]).
 */
function projectPathOf(node: ExplorerNode | undefined): string | undefined {
  if (node?.projectFilePath === undefined) {
    void window.showWarningMessage('No project file path available.');
    return undefined;
  }
  return node.projectFilePath;
}

async function openProjectFile(node?: ExplorerNode): Promise<void> {
  const projectFilePath = projectPathOf(node);
  if (projectFilePath === undefined) return;
  const doc = await workspace.openTextDocument(vscode.Uri.file(projectFilePath));
  await window.showTextDocument(doc);
  log.info(`Opened project file: ${projectFilePath}`);
}

async function addNuGetFromExplorer(node?: ExplorerNode): Promise<void> {
  const projectFilePath = projectPathOf(node);
  if (projectFilePath === undefined) return;
  await addNuGetPackageToProject(projectFilePath);
}

async function addProjectReference(
  node: ExplorerNode | undefined,
  refresh: () => Promise<void>,
): Promise<void> {
  const projectFilePath = projectPathOf(node);
  if (projectFilePath === undefined) return;
  const projectFiles = await workspace.findFiles('**/*.{csproj,fsproj}', '**/node_modules/**');
  const candidates = projectFiles.filter((f) => !samePath(f.fsPath, projectFilePath));
  if (candidates.length === 0) {
    void window.showWarningMessage('No other project files found to reference.');
    return;
  }
  const pick = await window.showQuickPick(
    candidates.map((f) => ({ label: workspace.asRelativePath(f), uri: f })),
    { placeHolder: 'Select project to reference' },
  );
  if (pick === undefined) return;
  const error = await deps.addProjectReference(projectFilePath, pick.uri.fsPath);
  if (error !== undefined) {
    void window.showErrorMessage(`Failed to add project reference: ${error}`);
    return;
  }
  void window.showInformationMessage(`Added reference to ${pick.label}`);
  await refresh();
}

async function confirmAndRemoveDependency(
  node: ExplorerNode | undefined,
  kind: 'package' | 'reference',
  refresh: () => Promise<void>,
): Promise<void> {
  if (node?.projectFilePath === undefined || node.referenceName === undefined) return;
  const rawLabel = node.label;
  const displayName = typeof rawLabel === 'string' ? rawLabel : (rawLabel?.label ?? '');
  const label = kind === 'package' ? 'NuGet package' : 'project reference';
  const answer = await window.showWarningMessage(
    `Remove ${label} "${displayName}"?`,
    { modal: true },
    'Remove',
  );
  if (answer !== 'Remove') return;
  const removeFn = kind === 'package' ? deps.removeNuGetPackage : deps.removeProjectReference;
  const error = await removeFn(node.projectFilePath, node.referenceName);
  if (error !== undefined) {
    void window.showErrorMessage(`Failed to remove ${label}: ${error}`);
    return;
  }
  void window.showInformationMessage(`Removed ${displayName}`);
  await refresh();
}

function browseNuGetPackages(
  node: ExplorerNode | undefined,
  context: ExtensionContext,
  client: () => LanguageClient | undefined,
): void {
  const projectFilePath = projectPathOf(node);
  if (node === undefined || projectFilePath === undefined) return;
  log.info(`Opening NuGet browser for ${node.sortName} (${projectFilePath})`);
  NuGetBrowserPanel.open(context, projectFilePath, node.sortName, client);
}

// ── Sort Members ────────────────────────────────────────────────

interface LspPosition {
  readonly line: number;
  readonly character: number;
}

interface SortMembersEdit {
  readonly range: { readonly start: LspPosition; readonly end: LspPosition };
  readonly newText: string;
}

interface SortMembersResponse {
  readonly edits: SortMembersEdit[];
}

/** The user's `sharplsp.memberSortOrder` settings over the default policy. */
function sortConfig(): Record<keyof typeof DEFAULT_SORT_POLICY, string[]> {
  const config = workspace.getConfiguration('sharplsp.memberSortOrder');
  const read = (key: keyof typeof DEFAULT_SORT_POLICY): string[] =>
    config.get<string[]>(key, [...DEFAULT_SORT_POLICY[key]]);
  return {
    hierarchy: read('hierarchy'),
    accessibilityOrder: read('accessibilityOrder'),
    categoryOrder: read('categoryOrder'),
  };
}

async function sortMembers(
  node: ExplorerNode | undefined,
  lsp: LanguageClient | undefined,
): Promise<void> {
  if (node?.symbolUri === undefined || node.symbolRange === undefined) {
    void window.showWarningMessage('No symbol location available.');
    return;
  }
  if (lsp === undefined) {
    void window.showWarningMessage('LSP client not available.');
    return;
  }
  try {
    const response = await lsp.sendRequest<SortMembersResponse | null>('sharplsp/sortMembers', {
      uri: node.symbolUri,
      range: node.symbolRange,
      sortConfig: sortConfig(),
    });
    if (response === null || response.edits.length === 0) {
      void window.showInformationMessage('Members already sorted.');
      return;
    }
    await workspace.applyEdit(sortEdit(vscode.Uri.parse(node.symbolUri), response.edits));
    log.info('Sort Members applied successfully');
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.info(`Sort Members failed: ${msg}`);
    void window.showErrorMessage(`Sort Members failed: ${msg}`);
  }
}

/** The server's replacements as one workspace edit on `uri`. */
function sortEdit(uri: vscode.Uri, edits: readonly SortMembersEdit[]): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const { range, newText } of edits) {
    edit.replace(
      uri,
      new vscode.Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character,
      ),
      newText,
    );
  }
  return edit;
}
