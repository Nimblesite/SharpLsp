import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as log from './log.js';
import { type Result, err, ok } from './result.js';
import { ServerState, type SharpLspStatusBar } from './status.js';
import { getErrorMessage } from './utils.js';

const DOTNET_VERSION = '10.0';
const REQUESTING_EXTENSION_ID = 'nimblesite.sharplsp';

/** The .NET Install Tool extension SharpLsp depends on for .NET acquisition. */
export const INSTALL_TOOL_EXTENSION_ID = 'ms-dotnettools.vscode-dotnet-runtime';

// Command IDs exposed programmatically by the .NET Install Tool extension.
// `dotnet.acquire` (mode 'runtime') installs only a runtime; SharpLsp needs an
// SDK because the C# sidecar's MSBuildLocator enumerates installed SDKs to find
// MSBuild (see MSBuildInstanceSelector). `dotnet.acquireGlobalSDK` is the SDK
// installer; `dotnet.findPath` discovers an already-installed one.
const CMD_FIND_PATH = 'dotnet.findPath';
const CMD_ACQUIRE_GLOBAL_SDK = 'dotnet.acquireGlobalSDK';

/** Map Node `process.arch` to the .NET Install Tool's architecture identifiers. */
export function dotnetArchitecture(): string {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'x86';
  return 'x64';
}

interface AcquireResult {
  readonly dotnetPath: string;
}

interface FindPathResult {
  readonly dotnetPath?: string;
}

/**
 * Acquire a .NET 10 **SDK** via the ms-dotnettools.vscode-dotnet-runtime
 * extension.
 *
 * Implements [DIST-RUNTIME-ACQUIRE]. SharpLsp needs an SDK, not merely a
 * runtime: the C# sidecar runs an in-process MSBuild design-time build and
 * locates it via `MSBuildLocator.QueryVisualStudioInstances()`, which only
 * enumerates installed SDKs. A runtime-only machine (e.g. .NET 9 SDK + no
 * .NET 10) therefore has no MSBuild whose Roslyn matches the bundled one, so
 * every project load fails. Acquiring the SDK fixes this at the source.
 *
 * Always informs the user via a non-interactive progress notification + status
 * bar; never throws. Returns a `Result<string, string>` whose Ok value is the
 * absolute path to the `dotnet` executable of the acquired/located SDK.
 */
export async function acquireDotnet10Sdk(statusBar: SharpLspStatusBar): Promise<Result<string>> {
  // The commands below only exist once the .NET Install Tool has activated and
  // registered them. `extensionDependencies` activates it before us, but we
  // activate it explicitly so a missing/disabled dependency yields a clear
  // message instead of an opaque "command 'dotnet.findPath' not found".
  const toolReady = await ensureInstallToolActivated();
  if (!toolReady.ok) {
    return err(toolReady.error);
  }

  log.info(`checking for an existing .NET ${DOTNET_VERSION} SDK (arch=${dotnetArchitecture()})…`);
  const existing = await tryFindExistingSdk();
  if (existing.ok) {
    log.info(`found existing .NET ${DOTNET_VERSION} SDK at ${existing.value}`);
    return ok(existing.value);
  }

  log.info(
    `no existing .NET ${DOTNET_VERSION} SDK found — invoking ${CMD_ACQUIRE_GLOBAL_SDK} via .NET Install Tool…`,
  );
  statusBar.setState(ServerState.Starting);
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'SharpLsp: Installing .NET 10 SDK',
      cancellable: false,
    },
    async (progress) => callAcquireSdk(progress),
  );
}

/** Activate the .NET Install Tool extension so its commands are registered. */
async function ensureInstallToolActivated(): Promise<Result<void>> {
  const extension = vscode.extensions.getExtension(INSTALL_TOOL_EXTENSION_ID);
  if (extension === undefined) {
    log.error(`.NET Install Tool extension (${INSTALL_TOOL_EXTENSION_ID}) is not installed`);
    return err(
      `The .NET Install Tool extension (${INSTALL_TOOL_EXTENSION_ID}) is required but not installed. ` +
        'Install it from the Marketplace, then reload the window.',
    );
  }
  if (extension.isActive) {
    return ok(undefined);
  }
  try {
    await extension.activate();
    log.info(`.NET Install Tool extension activated`);
    return ok(undefined);
  } catch (caught: unknown) {
    const message = getErrorMessage(caught);
    log.error(`.NET Install Tool extension failed to activate: ${message}`);
    return err(`The .NET Install Tool extension failed to activate: ${message}`);
  }
}

async function callAcquireSdk(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<Result<string>> {
  // A global SDK install runs the platform installer and may prompt for
  // elevation — that UI belongs to the .NET Install Tool, not SharpLsp.
  progress.report({ message: 'Downloading from Microsoft (this may require elevation)…' });
  // Implements [DIST-API-PARAMETERS]: all four required IDotnetAcquireContext
  // fields, plus the SDK-specific `installType: 'global'`.
  const result = await safeExecuteCommand<AcquireResult | undefined>(CMD_ACQUIRE_GLOBAL_SDK, {
    version: DOTNET_VERSION,
    mode: 'sdk',
    architecture: dotnetArchitecture(),
    requestingExtensionId: REQUESTING_EXTENSION_ID,
    installType: 'global',
  });
  if (!result.ok) {
    log.error(`${CMD_ACQUIRE_GLOBAL_SDK} failed: ${result.error}`);
    return err(`${CMD_ACQUIRE_GLOBAL_SDK} failed: ${result.error}`);
  }
  const dotnetPath = result.value?.dotnetPath;
  if (dotnetPath === undefined || dotnetPath === '') {
    log.error(`${CMD_ACQUIRE_GLOBAL_SDK} returned without a dotnetPath`);
    return err(`${CMD_ACQUIRE_GLOBAL_SDK} returned without a dotnetPath`);
  }
  log.info(`${CMD_ACQUIRE_GLOBAL_SDK} succeeded — .NET 10 SDK installed at ${dotnetPath}`);
  return ok(dotnetPath);
}

async function tryFindExistingSdk(): Promise<Result<string>> {
  // Implements [DIST-API-PARAMETERS]: acquireContext carries all four required
  // fields with mode 'sdk'; `greater_than_or_equal` accepts any SDK >= 10.0.
  const result = await safeExecuteCommand<FindPathResult | undefined>(CMD_FIND_PATH, {
    acquireContext: {
      version: DOTNET_VERSION,
      mode: 'sdk',
      architecture: dotnetArchitecture(),
      requestingExtensionId: REQUESTING_EXTENSION_ID,
    },
    versionSpecRequirement: 'greater_than_or_equal',
  });
  if (!result.ok) {
    log.info(`${CMD_FIND_PATH} unavailable: ${result.error}`);
    return err(result.error);
  }
  const dotnetPath = result.value?.dotnetPath;
  if (dotnetPath === undefined || dotnetPath === '') {
    log.info(`${CMD_FIND_PATH} returned no path`);
    return err('not found');
  }
  if (!fs.existsSync(dotnetPath)) {
    log.info(`${CMD_FIND_PATH} returned stale path (does not exist on disk): ${dotnetPath}`);
    return err('stale path');
  }
  log.info(`${CMD_FIND_PATH} returned ${dotnetPath}`);
  return ok(dotnetPath);
}

async function safeExecuteCommand<T>(command: string, payload: unknown): Promise<Result<T>> {
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
 * Show a non-modal error notification when SDK acquisition fails. Buttons are
 * informational links — `[Open dot.net]`, `[Show Log]`, `[Retry]` — never
 * required actions. Implements [DIST-FAILURE-UX].
 */
export async function showAcquireFailureNotification(
  message: string,
  retryCommandId: string,
): Promise<void> {
  const openDotNet = 'Open dot.net';
  const showLog = 'Show Log';
  const retry = 'Retry';
  const choice = await vscode.window.showErrorMessage(
    `SharpLsp needs the .NET 10 SDK and could not install it automatically: ${message}`,
    openDotNet,
    showLog,
    retry,
  );
  if (choice === openDotNet) {
    await vscode.env.openExternal(
      vscode.Uri.parse('https://dotnet.microsoft.com/download/dotnet/10.0'),
    );
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
