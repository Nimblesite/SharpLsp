import * as path from 'node:path';
import * as vscode from 'vscode';
import * as log from './log.js';
import { type Result, err, ok } from './result.js';
import { ServerState, type SharpLspStatusBar } from './status.js';
import { getErrorMessage } from './utils.js';

const DOTNET_VERSION = '10.0';
const REQUESTING_EXTENSION_ID = 'nimblesite.sharplsp';

/** Map Node `process.arch` to the .NET Install Tool's architecture identifiers. */
function dotnetArchitecture(): string {
  switch (process.arch) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    case 'ia32':
      return 'x86';
    default:
      return 'x64';
  }
}

interface AcquireResult {
  readonly dotnetPath: string;
}

interface FindPathResult {
  readonly dotnetPath?: string;
}

/**
 * Acquire a .NET 10 runtime via the ms-dotnettools.vscode-dotnet-runtime extension.
 *
 * Implements [DIST-RUNTIME-ACQUIRE]. Always informs the user via a non-interactive
 * progress notification + status bar; never asks the user to do anything. Returns
 * a `Result<string, string>` where the Ok value is the absolute path to the
 * dotnet executable.
 */
export async function acquireDotnet10(
  statusBar: SharpLspStatusBar,
): Promise<Result<string, string>> {
  const existing = await tryFindExistingDotnet();
  if (existing.ok) {
    log.info(`acquired dotnet at ${existing.value} (existing compatible runtime)`);
    return ok(existing.value);
  }

  statusBar.setState(ServerState.Starting);
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'SharpLsp: Installing .NET 10 runtime',
      cancellable: false,
    },
    async (progress) => callAcquire(progress),
  );
}

async function callAcquire(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<Result<string, string>> {
  progress.report({ message: 'Downloading from Microsoft…' });
  const result = await safeExecuteCommand<AcquireResult | undefined>('dotnet.acquire', {
    version: DOTNET_VERSION,
    mode: 'runtime',
    architecture: dotnetArchitecture(),
    requestingExtensionId: REQUESTING_EXTENSION_ID,
  });
  if (!result.ok) {
    log.error(`dotnet.acquire failed: ${result.error}`);
    return err(`dotnet.acquire failed: ${result.error}`);
  }
  const dotnetPath = result.value?.dotnetPath;
  if (dotnetPath === undefined || dotnetPath === '') {
    log.error('dotnet.acquire returned without a dotnetPath');
    return err('dotnet.acquire returned without a dotnetPath');
  }
  log.info(`acquired dotnet at ${dotnetPath}`);
  return ok(dotnetPath);
}

async function tryFindExistingDotnet(): Promise<Result<string, string>> {
  const result = await safeExecuteCommand<FindPathResult | undefined>('dotnet.findPath', {
    acquireContext: {
      version: DOTNET_VERSION,
      mode: 'runtime',
      architecture: dotnetArchitecture(),
      requestingExtensionId: REQUESTING_EXTENSION_ID,
    },
    versionSpecRequirement: 'greater_than_or_equal',
  });
  if (!result.ok) {
    log.info(`dotnet.findPath unavailable: ${result.error}`);
    return err(result.error);
  }
  const dotnetPath = result.value?.dotnetPath;
  return dotnetPath !== undefined && dotnetPath !== '' ? ok(dotnetPath) : err('not found');
}

async function safeExecuteCommand<T>(
  command: string,
  payload: unknown,
): Promise<Result<T, string>> {
  try {
    const value = await vscode.commands.executeCommand<T>(command, payload);
    return ok(value);
  } catch (caught: unknown) {
    return err(getErrorMessage(caught));
  }
}

/** Directory containing the dotnet executable — used to set DOTNET_ROOT. */
export function dotnetRootFromPath(dotnetPath: string): string {
  return path.dirname(dotnetPath);
}

/**
 * Show a non-modal error notification when acquisition fails. Buttons are
 * informational links — `[Open dot.net]`, `[Show Log]`, `[Retry]` — never
 * required actions.
 */
export async function showAcquireFailureNotification(
  message: string,
  retryCommandId: string,
): Promise<void> {
  const openDotNet = 'Open dot.net';
  const showLog = 'Show Log';
  const retry = 'Retry';
  const choice = await vscode.window.showErrorMessage(
    `SharpLsp could not install the .NET 10 runtime: ${message}`,
    openDotNet,
    showLog,
    retry,
  );
  if (choice === openDotNet) {
    await vscode.env.openExternal(vscode.Uri.parse('https://dot.net'));
    return;
  }
  if (choice === showLog) {
    log.output().show();
    return;
  }
  if (choice === retry) {
    await vscode.commands.executeCommand(retryCommandId);
  }
}
