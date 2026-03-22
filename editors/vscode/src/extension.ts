import * as vscode from "vscode";
import { type ExtensionContext, commands, window, workspace } from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
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
  CMD_SORT_MEMBERS,
  CMD_COPY_QUALIFIED_NAME,
  CMD_COPY_NAME,
  CMD_REVEAL_IN_EXPLORER,
  VIEW_SOLUTION_EXPLORER,
  VIEW_PROFILER,
} from "./constants.js";
import * as client from "./client.js";
import * as deps from "./dependencies.js";
import * as log from "./log.js";
import * as profiler from "./profiler.js";
import * as solution from "./solution.js";
import { ForgeStatusBar, ServerState } from "./status.js";
import {
  type ExplorerNode,
  SolutionExplorerProvider,
  buildQualifiedName,
} from "./tree.js";

/** Public API exported from activate() for tests and other extensions. */
export interface ForgeExtensionApi {
  readonly explorerProvider: SolutionExplorerProvider;
  readonly profilerProvider: profiler.ProfilerTreeProvider;
}

let lspClient: LanguageClient | undefined;
let statusBar: ForgeStatusBar | undefined;
let explorerProvider: SolutionExplorerProvider | undefined;
let profilerProvider: profiler.ProfilerTreeProvider | undefined;

export async function activate(
  context: ExtensionContext,
): Promise<ForgeExtensionApi> {
  log.info("Forge activating…");
  log.info(`File log: ${log.logFilePath()}`);

  statusBar = new ForgeStatusBar();
  context.subscriptions.push(statusBar);

  explorerProvider = new SolutionExplorerProvider();
  context.subscriptions.push(
    window.createTreeView(VIEW_SOLUTION_EXPLORER, {
      treeDataProvider: explorerProvider,
      showCollapseAll: true,
    }),
  );

  profilerProvider = new profiler.ProfilerTreeProvider();
  context.subscriptions.push(
    window.createTreeView(VIEW_PROFILER, {
      treeDataProvider: profilerProvider,
    }),
  );

  const profilerStatusBar = new profiler.ProfilerStatusBar(context);

  explorerProvider.initSortContext();
  registerCommands(context);
  profiler.registerCommands(context, profilerProvider, profilerStatusBar, () => lspClient);
  wireDocumentChangeRefresh(context);

  try {
    lspClient = await client.start(context, statusBar);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`Failed to start server: ${msg}`);
    statusBar.setState(ServerState.Error);
    return { explorerProvider, profilerProvider };
  }

  if (lspClient !== undefined) {
    explorerProvider.setClient(lspClient);
    profilerProvider.setClient(lspClient);
    // Fire-and-forget — don't block activation on solution loading.
    void autoSelectSolution().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.info(`Auto-select solution failed: ${msg}`);
    });
  }

  return { explorerProvider, profilerProvider };
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
      log.info("Restarting server…");
      statusBar.setState(ServerState.Starting);
      try {
        await lspClient?.restart();
        log.info("Server restarted.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
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
      await pickAndLoadSolution();
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
    commands.registerCommand(
      CMD_REMOVE_NUGET_PACKAGE,
      async (node: ExplorerNode) => {
        await confirmAndRemoveDependency(node, "package");
      },
    ),
    commands.registerCommand(
      CMD_REMOVE_PROJECT_REFERENCE,
      async (node: ExplorerNode) => {
        await confirmAndRemoveDependency(node, "reference");
      },
    ),
  );
}

function registerContextMenuCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand(
      CMD_COPY_QUALIFIED_NAME,
      (node: ExplorerNode) => {
        const name = buildQualifiedName(node);
        void vscode.env.clipboard.writeText(name).then(() => {
          void window.showInformationMessage(`Copied: ${name}`);
        });
      },
    ),
    commands.registerCommand(
      CMD_COPY_NAME,
      (node: ExplorerNode) => {
        void vscode.env.clipboard.writeText(node.sortName).then(() => {
          void window.showInformationMessage(`Copied: ${node.sortName}`);
        });
      },
    ),
    commands.registerCommand(
      CMD_REVEAL_IN_EXPLORER,
      (node: ExplorerNode) => {
        if (node.symbolUri === undefined) return;
        const uri = vscode.Uri.parse(node.symbolUri);
        void commands.executeCommand("revealInExplorer", uri);
      },
    ),
    commands.registerCommand(
      CMD_SORT_MEMBERS,
      async (node: ExplorerNode) => {
        await sortMembers(node);
      },
    ),
  );
}

async function sortMembers(node: ExplorerNode): Promise<void> {
  if (node.symbolUri === undefined || node.symbolRange === undefined) {
    void window.showWarningMessage("No symbol location available.");
    return;
  }

  const lsp = lspClient;
  if (lsp === undefined) {
    void window.showWarningMessage("LSP client not available.");
    return;
  }

  const config = workspace.getConfiguration("forge.memberSortOrder");
  const hierarchy = config.get<string[]>(
    "hierarchy", ["accessibility", "category", "alphabetical"],
  );
  const accessibilityOrder = config.get<string[]>("accessibilityOrder", [
    "public", "protected internal", "internal",
    "protected", "private protected", "private",
  ]);
  const categoryOrder = config.get<string[]>("categoryOrder", [
    "constant", "field", "constructor", "finalizer", "delegate",
    "event", "enum", "interface", "property", "indexer",
    "operator", "method", "struct", "class", "record",
  ]);

  try {
    const response = await lsp.sendRequest<SortMembersResponse | null>(
      "forge/sortMembers",
      {
        uri: node.symbolUri,
        range: node.symbolRange,
        sortConfig: { hierarchy, accessibilityOrder, categoryOrder },
      },
    );

    if (response === null || response.edits.length === 0) {
      void window.showInformationMessage("Members already sorted.");
      return;
    }

    const uri = vscode.Uri.parse(node.symbolUri);
    const edit = new vscode.WorkspaceEdit();
    for (const textEdit of response.edits) {
      const range = new vscode.Range(
        textEdit.range.start.line, textEdit.range.start.character,
        textEdit.range.end.line, textEdit.range.end.character,
      );
      edit.replace(uri, range, textEdit.newText);
    }
    await workspace.applyEdit(edit);
    log.info("Sort Members applied successfully");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
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
  node: ExplorerNode,
  kind: "package" | "reference",
): Promise<void> {
  if (node.projectFilePath === undefined) return;
  if (node.referenceName === undefined) return;
  const rawLabel = node.label;
  const displayName = typeof rawLabel === "string" ? rawLabel : rawLabel?.label ?? "";
  const label = kind === "package" ? "NuGet package" : "project reference";
  const answer = await window.showWarningMessage(
    `Remove ${label} "${displayName}"?`, { modal: true }, "Remove",
  );
  if (answer !== "Remove") return;
  const removeFn = kind === "package"
    ? deps.removeNuGetPackage
    : deps.removeProjectReference;
  const error = await removeFn(node.projectFilePath, node.referenceName);
  if (error !== undefined) {
    void window.showErrorMessage(`Failed to remove ${label}: ${error}`);
    return;
  }
  void window.showInformationMessage(`Removed ${displayName}`);
  await explorerProvider?.refresh();
}

const REFRESH_DEBOUNCE_MS = 1_000;
const RELEVANT_LANGUAGES = new Set(["csharp", "fsharp"]);
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
        log.traceInfo("Debounced tree refresh triggered");
        void explorerProvider?.refresh();
      }, REFRESH_DEBOUNCE_MS);
    }),
  );
}

/** Auto-select if exactly one .sln, otherwise wait for user. */
async function autoSelectSolution(): Promise<void> {
  const selected = await solution.selectSolution();
  if (selected !== undefined) {
    await loadSolution(selected);
  }
}

/** Show the QuickPick and load the chosen solution. */
async function pickAndLoadSolution(): Promise<void> {
  const solutions = await solution.selectSolution();
  if (solutions !== undefined) {
    await loadSolution(solutions);
  }
}

/** Load a solution into the explorer tree. */
async function loadSolution(
  selected: solution.SolutionSelection,
): Promise<void> {
  log.info(`Loading solution: ${selected.path}`);
  await explorerProvider?.loadSolution(selected.path);
}
