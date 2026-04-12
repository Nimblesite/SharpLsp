import * as path from 'node:path';
import * as fs from 'node:fs';
import { type ExtensionContext, type Disposable, window } from 'vscode';
import {
  type Executable,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
  State,
} from 'vscode-languageclient/node';
import { EXTENSION_ID, EXTENSION_NAME, SERVER_BINARY, SERVER_BINARY_WIN } from './constants.js';
import * as config from './config.js';
import * as log from './log.js';
import { type ForgeStatusBar, ServerState } from './status.js';

/** Create, start, and return a new `LanguageClient`. */
export async function start(
  context: ExtensionContext,
  statusBar: ForgeStatusBar,
): Promise<LanguageClient | undefined> {
  const serverPath = resolveServerPath(context);
  if (serverPath === undefined) {
    const msg =
      'Forge LSP binary not found. Install via `cargo install forge-lsp` or set `forge.server.path`.';
    log.info(msg);
    window.showErrorMessage(msg);
    statusBar.setState(ServerState.Error);
    return undefined;
  }

  log.info(`Server binary: ${serverPath}`);

  const run: Executable = {
    command: serverPath,
    args: [...config.serverExtraArgs()],
    transport: TransportKind.stdio,
    options: {
      env: { ...process.env, RUST_LOG: config.loggingLevel() },
    },
  };

  const serverOptions: ServerOptions = { run, debug: run };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'csharp' },
      { scheme: 'file', language: 'fsharp' },
      { scheme: 'untitled', language: 'csharp' },
      { scheme: 'untitled', language: 'fsharp' },
    ],
    outputChannel: log.output(),
    traceOutputChannel: log.trace(),
  };

  const client = new LanguageClient(EXTENSION_ID, EXTENSION_NAME, serverOptions, clientOptions);

  wireStatusBar(client, statusBar, context);

  statusBar.setState(ServerState.Starting);
  await client.start();
  return client;
}

/** Wire client state changes to the status bar indicator. */
function wireStatusBar(
  client: LanguageClient,
  statusBar: ForgeStatusBar,
  context: ExtensionContext,
): void {
  const listener: Disposable = client.onDidChangeState((event) => {
    switch (event.newState) {
      case State.Starting:
        statusBar.setState(ServerState.Starting);
        break;
      case State.Running:
        statusBar.setState(ServerState.Running);
        log.info('Server is running.');
        break;
      case State.Stopped:
        statusBar.setState(ServerState.Stopped);
        log.info('Server stopped.');
        break;
    }
  });
  context.subscriptions.push(listener);
}

/**
 * Resolve the forge-lsp binary path.
 *
 * Priority:
 *   1. User-configured `forge.server.path`
 *   2. Bundled binary in `<extension>/bin/`
 *   3. Binary name on `$PATH` (client resolves via shell)
 */
function resolveServerPath(context: ExtensionContext): string | undefined {
  const configured = config.serverPath();
  if (configured !== '' && fs.existsSync(configured)) {
    return configured;
  }

  const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;

  const bundled = path.join(context.extensionPath, 'bin', binaryName);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  // Fall back to PATH — the language client resolves the command via the shell.
  return binaryName;
}
