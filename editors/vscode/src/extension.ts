import { type ExtensionContext, commands } from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import {
  CMD_RESTART_SERVER,
  CMD_SHOW_OUTPUT,
  CMD_SHOW_TRACE,
} from "./constants.js";
import * as client from "./client.js";
import * as log from "./log.js";
import { ForgeStatusBar, ServerState } from "./status.js";

let lspClient: LanguageClient | undefined;
let statusBar: ForgeStatusBar | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  log.info("Forge activating…");

  statusBar = new ForgeStatusBar();
  context.subscriptions.push(statusBar);

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

  try {
    lspClient = await client.start(context, statusBar);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`Failed to start server: ${msg}`);
    statusBar.setState(ServerState.Error);
  }
}

export async function deactivate(): Promise<void> {
  if (lspClient !== undefined) {
    await lspClient.stop();
    lspClient = undefined;
  }
  log.dispose();
}
