import * as path from 'node:path';
import * as fs from 'node:fs';
import { type ExtensionContext, type Disposable, window } from 'vscode';
import {
  CloseAction,
  ErrorAction,
  type CloseHandlerResult,
  type ErrorHandlerResult,
  type Executable,
  LanguageClient,
  type LanguageClientOptions,
  type Message,
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
    errorHandler: makeErrorHandler(statusBar),
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
 * Custom error handler that restarts forge-lsp with exponential backoff.
 *
 * The default vscode-languageclient handler shows an error notification
 * on every unexpected close, including the transient kills that happen
 * when VS Code restarts the extension host or when a dev workflow
 * replaces the binary on disk. This handler:
 *
 *   - Suppresses the modal error dialog on close (uses `handled: true`)
 *   - Allows up to MAX_RESTARTS automatic restarts
 *   - After MAX_RESTARTS, stops and shows one actionable message
 */
function makeErrorHandler(statusBar: ForgeStatusBar): {
  error(error: Error, message: Message | undefined, count: number | undefined): ErrorHandlerResult;
  closed(): CloseHandlerResult;
} {
  const MAX_RESTARTS = 5;
  let restartCount = 0;

  return {
    error(
      _error: Error,
      _message: Message | undefined,
      count: number | undefined,
    ): ErrorHandlerResult {
      if ((count ?? 0) <= 3) {
        return { action: ErrorAction.Continue };
      }
      return { action: ErrorAction.Shutdown };
    },

    closed(): CloseHandlerResult {
      restartCount += 1;
      if (restartCount <= MAX_RESTARTS) {
        log.info(
          `forge-lsp closed unexpectedly (restart ${String(restartCount)}/${String(MAX_RESTARTS)})`,
        );
        return { action: CloseAction.Restart, handled: true };
      }
      log.error(`forge-lsp closed ${String(MAX_RESTARTS)} times — giving up`);
      statusBar.setState(ServerState.Error);
      void window
        .showErrorMessage(
          'Forge: language server failed to start after multiple attempts. Check the Forge output channel for details.',
          'Show Output',
        )
        .then((choice) => {
          if (choice === 'Show Output') {
            log.output().show();
          }
        });
      restartCount = 0;
      return { action: CloseAction.DoNotRestart, handled: true };
    },
  };
}

/**
 * Resolve the forge-lsp binary path.
 *
 * Priority:
 *   1. User-configured `forge.server.path`
 *   2. `FORGE_EXECUTABLE_PATH` for test and development runs
 *   3. Bundled binary in `<extension>/bin/`
 *   4. Binary name on `$PATH` (client resolves via shell)
 */
function resolveServerPath(context: ExtensionContext): string | undefined {
  const configured = config.serverPath();
  if (configured !== '' && fs.existsSync(configured)) {
    return configured;
  }

  const envPath = process.env.FORGE_EXECUTABLE_PATH;
  if (envPath !== undefined && envPath !== '' && fs.existsSync(envPath)) {
    return envPath;
  }

  const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;

  const bundled = path.join(context.extensionPath, 'bin', binaryName);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  // Fall back to PATH — the language client resolves the command via the shell.
  return binaryName;
}
