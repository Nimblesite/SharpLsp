import * as vscode from 'vscode';
import { type ExtensionContext, commands, window, workspace } from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { getErrorMessage } from './utils.js';
import {
  CMD_RESTART_SERVER,
  CMD_SHOW_OUTPUT,
  CMD_SHOW_TRACE,
  CMD_SELECT_SOLUTION,
  CMD_REFRESH_EXPLORER,
  CMD_SORT_NATURAL,
  CMD_SORT_ALPHABETICAL,
  CMD_SORT_ACCESSIBILITY,
  CMD_REMOVE_NUGET_PACKAGE,
  CMD_REMOVE_PROJECT_REFERENCE,
  CMD_BROWSE_NUGET_PACKAGES,
  CMD_SORT_MEMBERS,
  CMD_COPY_QUALIFIED_NAME,
  CMD_COPY_NAME,
  CMD_REVEAL_IN_EXPLORER,
  CMD_OPEN_SOLUTION,
  VIEW_SOLUTION_EXPLORER,
  VIEW_PROFILER,
} from './constants.js';
import * as client from './client.js';
import * as deps from './dependencies.js';
import * as log from './log.js';
import * as profiler from './profiler.js';
import * as solution from './solution.js';
import { ForgeStatusBar, ServerState } from './status.js';
import { type ExplorerNode, SolutionExplorerProvider, buildQualifiedName } from './tree.js';
import { NuGetBrowserPanel } from './nuget-browser.js';

/** Public API exported from activate() for tests and other extensions. */
export interface ForgeExtensionApi {
  readonly explorerProvider: SolutionExplorerProvider;
  readonly profilerProvider: profiler.ProfilerTreeProvider;
  /** Get the active LSP client, if started. Used by tests. */
  readonly getLspClient: () => LanguageClient | undefined;
}

let lspClient: LanguageClient | undefined;
let statusBar: ForgeStatusBar | undefined;
let explorerProvider: SolutionExplorerProvider | undefined;
let profilerProvider: profiler.ProfilerTreeProvider | undefined;

export async function activate(context: ExtensionContext): Promise<ForgeExtensionApi> {
  // FIRST line: synchronous file log so we always know activate() ran,
  // even if every subsequent line throws.
  log.info('Forge activating…');
  log.info(`File log: ${log.logFilePath()}`);
  try {
    return await activateInner(context);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.error(`activate() threw: ${msg}`);
    if (err instanceof Error && err.stack !== undefined) {
      log.error(err.stack);
    }
    throw err;
  }
}

async function activateInner(context: ExtensionContext): Promise<ForgeExtensionApi> {
  log.info('step 1: ForgeStatusBar');
  statusBar = new ForgeStatusBar();
  context.subscriptions.push(statusBar);

  log.info('step 2: SolutionExplorerProvider');
  explorerProvider = new SolutionExplorerProvider();
  log.info('step 3: createTreeView SOLUTION_EXPLORER');
  context.subscriptions.push(
    window.createTreeView(VIEW_SOLUTION_EXPLORER, {
      treeDataProvider: explorerProvider,
      showCollapseAll: true,
    }),
  );

  log.info('step 4: ProfilerTreeProvider');
  profilerProvider = new profiler.ProfilerTreeProvider();
  log.info('step 5: createTreeView PROFILER');
  context.subscriptions.push(
    window.createTreeView(VIEW_PROFILER, {
      treeDataProvider: profilerProvider,
    }),
  );

  log.info('step 6: ProfilerStatusBar');
  const profilerStatusBar = new profiler.ProfilerStatusBar(context);

  log.info('step 7: initSortContext');
  explorerProvider.initSortContext();
  log.info('step 8: registerCommands');
  registerCommands(context);
  log.info('step 9: profiler.registerCommands');
  profiler.registerCommands(context, profilerProvider, profilerStatusBar, () => lspClient);
  log.info('step 10: wireDocumentChangeRefresh');
  wireDocumentChangeRefresh(context);

  log.info('step 11: client.start (await)');
  try {
    lspClient = await client.start(context, statusBar);
    log.info('step 11: client.start returned');
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.error(`Failed to start server: ${msg}`);
    statusBar.setState(ServerState.Error);
    void window.showErrorMessage(`Forge: Failed to start language server. ${msg}`);
    return {
      explorerProvider,
      profilerProvider,
      getLspClient: () => lspClient,
    };
  }

  log.info('step 12: post-start wiring');
  if (lspClient !== undefined) {
    explorerProvider.setClient(lspClient);
    profilerProvider.setClient(lspClient);
    // Fire-and-forget — don't block activation on solution loading.
    void selectAndLoadSolution().catch((err: unknown) => {
      const msg = getErrorMessage(err);
      log.error(`Auto-select solution failed: ${msg}`);
    });
  }

  log.info('step 13: activate complete');
  return {
    explorerProvider,
    profilerProvider,
    getLspClient: () => lspClient,
  };
}

export async function deactivate(): Promise<void> {
  if (lspClient !== undefined) {
    await lspClient.stop();
    lspClient = undefined;
  }
  log.dispose();
}

function registerCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand(CMD_RESTART_SERVER, async () => {
      if (statusBar === undefined) return;
      log.info('Restarting server…');
      statusBar.setState(ServerState.Starting);
      try {
        await lspClient?.restart();
        log.info('Server restarted.');
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        log.info(`Restart failed: ${msg}`);
        statusBar.setState(ServerState.Error);
      }
    }),
  );

  context.subscriptions.push(
    commands.registerCommand(CMD_SHOW_OUTPUT, () => {
      log.output().show();
    }),
  );

  context.subscriptions.push(
    commands.registerCommand(CMD_SHOW_TRACE, () => {
      log.trace().show();
    }),
  );

  context.subscriptions.push(
    commands.registerCommand(CMD_SELECT_SOLUTION, async () => {
      await selectAndLoadSolution();
    }),
  );

  context.subscriptions.push(
    commands.registerCommand(CMD_OPEN_SOLUTION, async (solutionPath: string) => {
      await loadSolution({ path: solutionPath, name: '' });
    }),
  );

  context.subscriptions.push(
    commands.registerCommand(CMD_REFRESH_EXPLORER, async () => {
      await explorerProvider?.refresh();
    }),
  );

  const cycleSortHandler = (): void => {
    explorerProvider?.cycleSortOrder();
  };
  context.subscriptions.push(
    commands.registerCommand(CMD_SORT_NATURAL, cycleSortHandler),
    commands.registerCommand(CMD_SORT_ALPHABETICAL, cycleSortHandler),
    commands.registerCommand(CMD_SORT_ACCESSIBILITY, cycleSortHandler),
  );

  registerDependencyCommands(context);
  registerContextMenuCommands(context);
}

function registerDependencyCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand(CMD_REMOVE_NUGET_PACKAGE, async (node: ExplorerNode | undefined) => {
      await confirmAndRemoveDependency(node, 'package');
    }),
    commands.registerCommand(
      CMD_REMOVE_PROJECT_REFERENCE,
      async (node: ExplorerNode | undefined) => {
        await confirmAndRemoveDependency(node, 'reference');
      },
    ),
    commands.registerCommand(CMD_BROWSE_NUGET_PACKAGES, (node: ExplorerNode | undefined) => {
      browseNuGetPackages(node, context);
    }),
  );
}

function browseNuGetPackages(node: ExplorerNode | undefined, context: ExtensionContext): void {
  if (node?.projectFilePath === undefined) {
    void window.showWarningMessage('No project file path available.');
    return;
  }
  const projectName = node.sortName;
  log.info(`Opening NuGet browser for ${projectName} (${node.projectFilePath})`);
  NuGetBrowserPanel.open(context, node.projectFilePath, projectName, () => lspClient);
}

function registerContextMenuCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand(CMD_COPY_QUALIFIED_NAME, (node: ExplorerNode) => {
      const name = buildQualifiedName(node);
      void vscode.env.clipboard.writeText(name).then(() => {
        void window.showInformationMessage(`Copied: ${name}`);
      });
    }),
    commands.registerCommand(CMD_COPY_NAME, (node: ExplorerNode) => {
      void vscode.env.clipboard.writeText(node.sortName).then(() => {
        void window.showInformationMessage(`Copied: ${node.sortName}`);
      });
    }),
    commands.registerCommand(CMD_REVEAL_IN_EXPLORER, (node: ExplorerNode) => {
      if (node.symbolUri === undefined) return;
      const uri = vscode.Uri.parse(node.symbolUri);
      void commands.executeCommand('revealInExplorer', uri);
    }),
    commands.registerCommand(CMD_SORT_MEMBERS, async (node: ExplorerNode) => {
      await sortMembers(node);
    }),
  );
}

async function sortMembers(node: ExplorerNode): Promise<void> {
  if (node.symbolUri === undefined || node.symbolRange === undefined) {
    void window.showWarningMessage('No symbol location available.');
    return;
  }

  const lsp = lspClient;
  if (lsp === undefined) {
    void window.showWarningMessage('LSP client not available.');
    return;
  }

  const config = workspace.getConfiguration('forge.memberSortOrder');
  const hierarchy = config.get<string[]>('hierarchy', [
    'accessibility',
    'category',
    'alphabetical',
  ]);
  const accessibilityOrder = config.get<string[]>('accessibilityOrder', [
    'public',
    'protected internal',
    'internal',
    'protected',
    'private protected',
    'private',
  ]);
  const categoryOrder = config.get<string[]>('categoryOrder', [
    'constant',
    'field',
    'constructor',
    'finalizer',
    'delegate',
    'event',
    'enum',
    'interface',
    'property',
    'indexer',
    'operator',
    'method',
    'struct',
    'class',
    'record',
  ]);

  try {
    const response = await lsp.sendRequest<SortMembersResponse | null>('forge/sortMembers', {
      uri: node.symbolUri,
      range: node.symbolRange,
      sortConfig: { hierarchy, accessibilityOrder, categoryOrder },
    });

    if (response === null || response.edits.length === 0) {
      void window.showInformationMessage('Members already sorted.');
      return;
    }

    const uri = vscode.Uri.parse(node.symbolUri);
    const edit = new vscode.WorkspaceEdit();
    for (const textEdit of response.edits) {
      const range = new vscode.Range(
        textEdit.range.start.line,
        textEdit.range.start.character,
        textEdit.range.end.line,
        textEdit.range.end.character,
      );
      edit.replace(uri, range, textEdit.newText);
    }
    await workspace.applyEdit(edit);
    log.info('Sort Members applied successfully');
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.info(`Sort Members failed: ${msg}`);
    void window.showErrorMessage(`Sort Members failed: ${msg}`);
  }
}

interface SortMembersEdit {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly newText: string;
}

interface SortMembersResponse {
  readonly edits: SortMembersEdit[];
}

async function confirmAndRemoveDependency(
  node: ExplorerNode | undefined,
  kind: 'package' | 'reference',
): Promise<void> {
  if (node?.projectFilePath === undefined) return;
  if (node.referenceName === undefined) return;
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
  await explorerProvider?.refresh();
}

const REFRESH_DEBOUNCE_MS = 1_000;
const RELEVANT_LANGUAGES = new Set(['csharp', 'fsharp']);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/** Re-fetch workspace symbols when a C#/F# file changes. */
function wireDocumentChangeRefresh(context: ExtensionContext): void {
  context.subscriptions.push(
    workspace.onDidChangeTextDocument((event) => {
      if (!RELEVANT_LANGUAGES.has(event.document.languageId)) return;
      if (event.contentChanges.length === 0) return;
      log.traceInfo(`Document changed: ${event.document.uri.fsPath}`);
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        log.traceInfo('Debounced tree refresh triggered');
        void explorerProvider?.refresh();
      }, REFRESH_DEBOUNCE_MS);
    }),
  );
}

/** Select a solution (auto or user-picked) and load it into the explorer. */
async function selectAndLoadSolution(): Promise<void> {
  const solutions = await solution.findSolutions();
  if (solutions.length === 0) {
    return;
  }
  if (solutions.length === 1 && solutions[0] !== undefined) {
    await loadSolution(solutions[0]);
    return;
  }
  const picked = await solution.promptUserSelection(solutions);
  if (picked !== undefined) {
    await loadSolution(picked);
    return;
  }
  // User dismissed the QuickPick — show solutions as buttons in the tree.
  explorerProvider?.showSolutionPicker(solutions);
}

/** Load a solution into the explorer tree AND the LSP sidecar. */
async function loadSolution(selected: solution.SolutionSelection): Promise<void> {
  log.info(`Loading solution: ${selected.path}`);

  // Tell the LSP server to reload sidecars with this specific solution.
  // Without this, the sidecar uses the workspace root and may pick the
  // wrong .sln when multiple exist — breaking hover, definition, etc.
  if (lspClient !== undefined) {
    try {
      await lspClient.sendRequest('forge/loadSolution', {
        solutionPath: selected.path,
      });
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      log.error(`forge/loadSolution failed: ${msg}`);
    }
  }

  await explorerProvider?.loadSolution(selected.path);
}
