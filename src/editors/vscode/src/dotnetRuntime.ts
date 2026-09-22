import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as log from './log.js';
import { type SdkPin, installedSdkVersions, pinSatisfiedBy, readSdkPin } from './global-json.js';
import { CMD_RETRY_DOTNET_ACQUISITION } from './constants.js';
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
/** Built-in command that restarts the extension host on a new SDK. */
const CMD_RELOAD_WINDOW = 'workbench.action.reloadWindow';

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

  const pin = workspaceSdkPin();
  if (pin !== undefined) {
    log.info(
      `workspace pins .NET SDK ${pin.version} (rollForward: ${pin.rollForward}) via ${pin.source}`,
    );
  }
  log.info(`checking for an existing .NET ${DOTNET_VERSION} SDK (arch=${dotnetArchitecture()})…`);
  const existing = await tryFindExistingSdk(pin);
  if (existing.ok) {
    log.info(`found existing .NET ${DOTNET_VERSION} SDK at ${existing.value}`);
    return ok(existing.value);
  }

  // An SDK that exists but cannot satisfy the pin must NOT block activation on a
  // platform installer: a global install can sit indefinitely on an elevation
  // prompt, and `activate()` awaits this call, so the whole extension host —
  // completions, navigation, everything — would stall behind a build fix. Report
  // it, keep the SDK that IS installed, and let the user start the install.
  const unpinned: Result<string> = pin === undefined ? err('unpinned') : await tryFindExistingSdk();
  if (pin !== undefined && unpinned.ok) {
    void reportUnsatisfiablePin(unpinned.value, pin, statusBar);
    return ok(unpinned.value);
  }

  log.info(
    `no existing .NET ${DOTNET_VERSION} SDK found — invoking ${CMD_ACQUIRE_GLOBAL_SDK} via .NET Install Tool…`,
  );
  statusBar.setState(ServerState.Starting);
  return await installPinnedSdk(pin);
}

/** Run the Install Tool's global SDK install behind a progress notification. */
async function installPinnedSdk(pin?: SdkPin): Promise<Result<string>> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `SharpLsp: Installing .NET ${pin?.version ?? DOTNET_VERSION} SDK`,
      cancellable: false,
    },
    async (progress) => await callAcquireSdk(progress, pin),
  );
}

/**
 * Tell the user their SDK cannot satisfy the workspace pin, and offer to fix it.
 *
 * Without this the first symptom is `dotnet` exiting 155 into a task terminal
 * that closes itself, leaving only VS Code's "failed to launch (exit code:
 * 155)". Implements [DIST-FAILURE-UX].
 */
async function reportUnsatisfiablePin(
  dotnetPath: string,
  pin: SdkPin,
  statusBar: SharpLspStatusBar,
): Promise<void> {
  const diagnosis = describeSdkPinFailure(dotnetPath, path.dirname(pin.source));
  if (diagnosis === undefined) return;
  log.error(diagnosis);
  const install = `Install ${pin.version}`;
  const choice = await vscode.window.showErrorMessage(
    `SharpLsp: ${diagnosis}`,
    install,
    'Show Log',
  );
  if (choice === 'Show Log') {
    log.output().show();
    return;
  }
  if (choice !== install) return;
  statusBar.setState(ServerState.Starting);
  const installed = await installPinnedSdk(pin);
  if (!installed.ok) {
    void showAcquireFailureNotification(installed.error, CMD_RETRY_DOTNET_ACQUISITION);
    return;
  }
  await promptReload(pin);
}

/** A newly installed SDK only reaches every dotnet child after a reload. */
async function promptReload(pin: SdkPin): Promise<void> {
  const reload = 'Reload Window';
  const choice = await vscode.window.showInformationMessage(
    `SharpLsp installed .NET SDK ${pin.version}. Reload to use it.`,
    reload,
  );
  if (choice === reload) {
    await vscode.commands.executeCommand(CMD_RELOAD_WINDOW);
  }
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
  pin?: SdkPin,
): Promise<Result<string>> {
  // A global SDK install runs the platform installer and may prompt for
  // elevation — that UI belongs to the .NET Install Tool, not SharpLsp.
  progress.report({ message: 'Downloading from Microsoft (this may require elevation)…' });
  // Implements [DIST-API-PARAMETERS]: all four required IDotnetAcquireContext
  // fields, plus the SDK-specific `installType: 'global'`.
  const result = await safeExecuteCommand<AcquireResult | undefined>(CMD_ACQUIRE_GLOBAL_SDK, {
    // A pinned workspace needs that exact SDK: `10.0` would happily install a
    // feature band `global.json` rejects, leaving every build broken.
    version: pin?.version ?? DOTNET_VERSION,
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

async function tryFindExistingSdk(pin?: SdkPin): Promise<Result<string>> {
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
  if (pin !== undefined && !pinSatisfiedBy(installedSdkVersions(dotnetPath), pin)) {
    // `greater_than_or_equal` on `10.0` accepts any 10.0.x, including a feature
    // band the workspace pin forbids. Fall through to acquisition instead of
    // handing back an SDK every later `dotnet` call rejects with exit code 155.
    log.info(
      `${CMD_FIND_PATH} returned ${dotnetPath}, but no SDK there satisfies the workspace pin — acquiring ${pin.version}`,
    );
    return err('installed SDKs do not satisfy the workspace global.json pin');
  }
  log.info(`${CMD_FIND_PATH} returned ${dotnetPath}`);
  return ok(dotnetPath);
}

/**
 * Ceiling on one Install Tool call.
 *
 * A global SDK install shells out to the platform installer, which can sit
 * indefinitely on an elevation prompt nobody answers. `acquireDotnet10Sdk` is
 * awaited by `activate()`, so an unbounded wait wedges the extension host and
 * every feature with it. The install is left running — only our wait ends.
 */
const ACQUIRE_TIMEOUT_MS = 5 * 60 * 1000;

async function safeExecuteCommand<T>(command: string, payload: unknown): Promise<Result<T>> {
  try {
    const value = await withTimeout(
      vscode.commands.executeCommand<T>(command, payload),
      `${command} did not return within ${String(ACQUIRE_TIMEOUT_MS / 1000)}s`,
    );
    return value;
  } catch (caught: unknown) {
    return err(getErrorMessage(caught));
  }
}

/** Resolve with the promise's value, or an error once the ceiling elapses. */
async function withTimeout<T>(promise: Thenable<T>, message: string): Promise<Result<T>> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<Result<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve(err(message));
    }, ACQUIRE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve(promise).then((value) => ok(value)), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The SDK pin governing the open workspace, if it declares one. */
export function workspaceSdkPin(): SdkPin | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root === undefined ? undefined : readSdkPin(root);
}

/**
 * Whether the SDKs installed beside `dotnetPath` can satisfy the pin governing
 * `workspaceRoot`. An unpinned workspace accepts whatever the Install Tool found.
 */
export function existingSdkSatisfiesWorkspace(dotnetPath: string, workspaceRoot: string): boolean {
  const pin = readSdkPin(workspaceRoot);
  return pin === undefined || pinSatisfiedBy(installedSdkVersions(dotnetPath), pin);
}

/**
 * An actionable diagnosis of an unsatisfiable pin, or undefined when the pin is
 * satisfied. Names the pinned version, the policy, the `global.json` that set
 * it, and what is actually installed — the facts `exit code: 155` omits.
 * Implements [DIST-FAILURE-UX].
 */
export function describeSdkPinFailure(
  dotnetPath: string,
  workspaceRoot: string,
): string | undefined {
  const pin = readSdkPin(workspaceRoot);
  if (pin === undefined) return undefined;
  const installed = installedSdkVersions(dotnetPath);
  if (pinSatisfiedBy(installed, pin)) return undefined;
  const have = installed.length === 0 ? 'none' : installed.join(', ');
  return (
    `${pin.source} pins .NET SDK ${pin.version} (rollForward: ${pin.rollForward}), ` +
    `but ${dotnetRootFromPath(dotnetPath)} has: ${have}. ` +
    `Every dotnet command in this workspace fails with exit code 155 until ` +
    `${pin.version} is installed or the pin is widened.`
  );
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
