import * as path from 'node:path';
import * as fs from 'node:fs';
import { type ExtensionContext, type Disposable, window, workspace } from 'vscode';
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
import { type SharpLspStatusBar, ServerState } from './status.js';

/** Create, start, and return a new `LanguageClient`. */
export async function start(
  context: ExtensionContext,
  statusBar: SharpLspStatusBar,
): Promise<LanguageClient | undefined> {
  const serverPath = resolveServerPath(context);
  if (serverPath === undefined) {
    const msg =
      'SharpLsp binary not found. Install via `cargo install sharplsp` or set `sharplsp.lspPath`.';
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
  statusBar: SharpLspStatusBar,
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
 * Custom error handler that restarts sharplsp-lsp with exponential backoff.
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
function makeErrorHandler(statusBar: SharpLspStatusBar): {
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
          `sharplsp-lsp closed unexpectedly (restart ${String(restartCount)}/${String(MAX_RESTARTS)})`,
        );
        return { action: CloseAction.Restart, handled: true };
      }
      log.error(`sharplsp-lsp closed ${String(MAX_RESTARTS)} times — giving up`);
      statusBar.setState(ServerState.Error);
      void window
        .showErrorMessage(
          'SharpLsp: language server failed to start after multiple attempts. Check the SharpLsp output channel for details.',
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
 * Resolve the sharplsp-lsp binary path.
 *
 * Priority:
 *   1. User-configured `sharplsp.lspPath`
 *   2. `SHARPLSP_EXECUTABLE_PATH` for test and development runs
 *   3. Bundled binary in `<extension>/bin/<platform>/`
 *   4. Legacy bundled binary in `<extension>/bin/`
 *   5. Binary name on `$PATH` (client resolves via shell)
 */
function resolveServerPath(context: ExtensionContext): string | undefined {
  const configured = expandPath(config.serverPath());
  if (configured !== '' && fs.existsSync(configured)) {
    return configured;
  }

  const envPath = process.env.SHARPLSP_EXECUTABLE_PATH;
  if (envPath !== undefined && envPath !== '' && fs.existsSync(envPath)) {
    return envPath;
  }

  const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;
  const platform = detectRuntimePlatform();

  const bundled = path.join(context.extensionPath, 'bin', platform, binaryName);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const legacyBundled = path.join(context.extensionPath, 'bin', binaryName);
  if (fs.existsSync(legacyBundled)) {
    return legacyBundled;
  }

  // Dev fallback: look for a Cargo debug build two levels above the extension dir.
  // Extension lives at <repo>/editors/vscode, so ../../target/debug/<binary> is the repo build.
  const devBuild = path.join(context.extensionPath, '..', '..', 'target', 'debug', binaryName);
  if (fs.existsSync(devBuild)) {
    return devBuild;
  }

  // Fall back to PATH — the language client resolves the command via the shell.
  return binaryName;
}

function detectRuntimePlatform(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin') return 'darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'linux') return 'linux-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-arm64';
  if (process.platform === 'win32') return 'win32-x64';
  return 'linux-x64';
}

/** Expand ${workspaceFolder} in a user-configured path. */
function expandPath(raw: string): string {
  if (!raw.includes('${workspaceFolder}')) return raw;
  const folder = workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return raw.replace('${workspaceFolder}', folder);
}
