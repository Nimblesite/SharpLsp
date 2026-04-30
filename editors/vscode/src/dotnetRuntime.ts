import * as path from 'node:path';
import * as vscode from 'vscode';
import * as log from './log.js';
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

export class DotnetAcquireError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DotnetAcquireError';
  }
}

/**
 * Acquire a .NET 10 runtime via the ms-dotnettools.vscode-dotnet-runtime extension.
 *
 * Implements [DIST-RUNTIME-ACQUIRE]. Always informs the user via a non-interactive
 * progress notification + status bar; never asks the user to do anything. Throws
 * `DotnetAcquireError` on failure so the caller can render a non-modal fallback.
 */
export async function acquireDotnet10(statusBar: SharpLspStatusBar): Promise<string> {
  const existing = await tryFindExistingDotnet();
  if (existing !== undefined) {
    log.info(`acquired dotnet at ${existing} (existing compatible runtime)`);
    return existing;
  }

  statusBar.setState(ServerState.Starting);
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'SharpLsp: Installing .NET 10 runtime',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Downloading from Microsoft…' });
      try {
        const result = await vscode.commands.executeCommand<AcquireResult | undefined>(
          'dotnet.acquire',
          {
            version: DOTNET_VERSION,
            mode: 'runtime',
            architecture: dotnetArchitecture(),
            requestingExtensionId: REQUESTING_EXTENSION_ID,
          },
        );
        if (result?.dotnetPath === undefined || result.dotnetPath === '') {
          throw new DotnetAcquireError('dotnet.acquire returned without a dotnetPath');
        }
        log.info(`acquired dotnet at ${result.dotnetPath}`);
        return result.dotnetPath;
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        log.error(`dotnet.acquire failed: ${msg}`);
        throw new DotnetAcquireError(`dotnet.acquire failed: ${msg}`, err);
      }
    },
  );
}

async function tryFindExistingDotnet(): Promise<string | undefined> {
  try {
    const result = await vscode.commands.executeCommand<FindPathResult | undefined>(
      'dotnet.findPath',
      {
        acquireContext: {
          version: DOTNET_VERSION,
          mode: 'runtime',
          architecture: dotnetArchitecture(),
          requestingExtensionId: REQUESTING_EXTENSION_ID,
        },
        versionSpecRequirement: 'greater_than_or_equal',
      },
    );
    return result?.dotnetPath !== undefined && result.dotnetPath !== ''
      ? result.dotnetPath
      : undefined;
  } catch (err: unknown) {
    log.info(`dotnet.findPath unavailable: ${getErrorMessage(err)}`);
    return undefined;
  }
}

/** Directory containing the dotnet executable — used to set DOTNET_ROOT. */
export function dotnetRootFromPath(dotnetPath: string): string {
  return path.dirname(dotnetPath);
}

/**
 * Show a non-modal error notification when acquisition fails. Buttons are
 * informational links — `[Open dot.net]` and `[Show log]` — never required
 * actions. Returns the chosen action label, if any.
 */
export async function showAcquireFailureNotification(
  err: unknown,
  retryCommandId: string,
): Promise<void> {
  const msg = getErrorMessage(err);
  const openDotNet = 'Open dot.net';
  const showLog = 'Show Log';
  const retry = 'Retry';
  const choice = await vscode.window.showErrorMessage(
    `SharpLsp could not install the .NET 10 runtime: ${msg}`,
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
