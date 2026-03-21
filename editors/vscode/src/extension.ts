import { type ExtensionContext, commands, window } from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import {
  CMD_RESTART_SERVER,
  CMD_SHOW_OUTPUT,
  CMD_SHOW_TRACE,
  CMD_SELECT_SOLUTION,
  CMD_REFRESH_EXPLORER,
  VIEW_SOLUTION_EXPLORER,
} from "./constants.js";
import * as client from "./client.js";
import * as log from "./log.js";
import * as solution from "./solution.js";
import { ForgeStatusBar, ServerState } from "./status.js";
import { SolutionExplorerProvider } from "./tree.js";

let lspClient: LanguageClient | undefined;
let statusBar: ForgeStatusBar | undefined;
let explorerProvider: SolutionExplorerProvider | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  log.info("Forge activating…");

  statusBar = new ForgeStatusBar();
  context.subscriptions.push(statusBar);

  explorerProvider = new SolutionExplorerProvider();
  context.subscriptions.push(
    window.createTreeView(VIEW_SOLUTION_EXPLORER, {
      treeDataProvider: explorerProvider,
      showCollapseAll: true,
    }),
  );

  registerCommands(context);

  try {
    lspClient = await client.start(context, statusBar);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`Failed to start server: ${msg}`);
    statusBar.setState(ServerState.Error);
    return;
  }

  if (lspClient !== undefined) {
    explorerProvider.setClient(lspClient);
    // Fire-and-forget — don't block activation on solution loading.
    void autoSelectSolution().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.info(`Auto-select solution failed: ${msg}`);
    });
  }
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
