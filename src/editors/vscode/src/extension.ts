/** Implements [SE-COMMANDS], [SE-ACTIONS], [SE-SOLUTION], and [SE-NAVIGATION]. */
import type * as vscode from 'vscode';
import { type ExtensionContext, commands, window, workspace } from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { getErrorMessage } from './utils.js';
import {
  CMD_RESTART_SERVER,
  CMD_RETRY_DOTNET_ACQUISITION,
  CMD_SHOW_OUTPUT,
  CMD_SHOW_TRACE,
  CMD_SELECT_SOLUTION,
  CMD_REFRESH_EXPLORER,
  CMD_SORT_NATURAL,
  CMD_SORT_ALPHABETICAL,
  CMD_SORT_ACCESSIBILITY,
  CMD_OPEN_SOLUTION,
  CONTEXT_FS_PROJECT_SELECTED,
  VIEW_SOLUTION_EXPLORER,
} from './constants.js';
import { configureDotnet } from './dotnet-process.js';
import { acquireDotnet10Sdk, showAcquireFailureNotification } from './dotnetRuntime.js';
import { verifyDeployment } from './deployment.js';
import * as client from './client.js';
import * as sharedState from './state.js';
import { registerExplorerCommands } from './explorer-commands.js';
import { solutionLoader } from './solution-load.js';
import * as log from './log.js';
import { registerProfiler, type SharpLspProfiler } from './profiler-host.js';
import { SharpLspStatusBar, ServerState } from './status.js';
import { registerNamespaceLayout } from './tree-namespaces.js';
import { registerBuildCommands } from './build.js';
import { registerNuGetCommands } from './nuget.js';
import { fsharpProjectOfNode } from './add-source-file.js';
import { type ExplorerNode, SolutionExplorerProvider } from './tree.js';
import { registerScaffoldingCommands } from './scaffolding.js';
import { registerFsiCommands } from './fsi.js';
import { registerHotReloadCommands } from './hot-reload.js';
import { registerDebugAdapter } from './debug.js';
import { registerTestExplorer, SharpLspTestController } from './testing.js';
import { registerTestStatusLens } from './test-lens.js';
import {
  registerTargetFramework,
  type TargetFrameworkStatus,
  type TargetFrameworkUi,
} from './target-framework.js';
import { initProjectDepsStore } from './project-deps-store.js';
import { registerTutorial, type TutorialApi } from './tutorial/register.js';

/** Public API exported from activate() for tests and other extensions. */
export interface SharpLspExtensionApi {
  readonly explorerProvider: SolutionExplorerProvider;
  /** The shared profiler UI ([PROFILER-SHARED-LIBRARY-VSCODE]); its store is the test seam. */
  readonly profiler: SharpLspProfiler | undefined;
  /** Get the active LSP client, if started. Used by tests. */
  readonly getLspClient: () => LanguageClient | undefined;
  /** The Test Explorer controller. Exposed so tests can drive/observe discovery. */
  readonly testController: SharpLspTestController;
  /**
   * Where the workbench writes this extension's log channels (`<name>.log`).
   * Exposed so tests can read the SharpLsp channel back ([DIST-CLEAN-OUTPUT]).
   */
  readonly logUri: vscode.Uri;
  /** The focused project's active target framework, as the status bar shows it. [NETFX-CONTEXT] */
  readonly targetFrameworkStatus?: TargetFrameworkStatus;
  /** The interactive tutorial's progress and panel ([TUTORIAL-TESTING]). */
  readonly tutorial?: TutorialApi;
}

let lspClient: LanguageClient | undefined;
let statusBar: SharpLspStatusBar | undefined;
let explorerProvider: SolutionExplorerProvider | undefined;
let profilerUi: SharpLspProfiler | undefined;
let testController: SharpLspTestController | undefined;
let targetFrameworks: TargetFrameworkUi | undefined;
let tutorial: TutorialApi | undefined;

/** Accessors the command modules use; the client and explorer appear during activation. */
const explorerDeps = {
  client: (): LanguageClient | undefined => lspClient,
  explorer: (): SolutionExplorerProvider | undefined => explorerProvider,
};
const solutions = solutionLoader(explorerDeps);

interface DeploymentDiagnostic {
  readonly componentId: string;
  readonly resolution: {
    readonly path?: string | null;
  };
}

interface DeploymentResult {
  readonly diagnostics: readonly DeploymentDiagnostic[];
}

// Implements [DIST-FAILURE-UX]: activate() MUST always resolve, never reject.
// Any unhandled error becomes a non-modal error notification + degraded API,
// not a re-throw. VS Code logs uncaught activation rejections to the developer
// console where users do not see them — that is the failure mode this prevents.
export async function activate(context: ExtensionContext): Promise<SharpLspExtensionApi> {
  log.info('SharpLsp activating…');
  log.info(`File log: ${log.logFilePath()}`);
  try {
    return await activateInner(context);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.error(`activate() caught unhandled error: ${msg}`);
    if (err instanceof Error && err.stack !== undefined) {
      log.error(err.stack);
    }
    statusBar?.setState(ServerState.Error);
    void notifyActivationFailure(
      'SharpLsp failed to activate. The language server will not start.',
      msg,
    );
    return degradedApi(context);
  }
}

/**
 * Keep the Solution Explorer in sync with the active editor: reveal and select
 * the tree node for the focused file, re-syncing whenever the tree repopulates
 * or the view becomes visible. Mirrors VS Code's `explorer.autoReveal`; gated by
 * the `sharplsp.solutionExplorer.autoReveal` setting (default on).
 * [SE-ACTIVE-EDITOR-SYNC]
 */
function wireActiveEditorReveal(
  context: ExtensionContext,
  treeView: vscode.TreeView<ExplorerNode>,
  provider: SolutionExplorerProvider,
): void {
  const reveal = (editor: vscode.TextEditor | undefined): void => {
    if (editor === undefined || !treeView.visible) return;
    const enabled = workspace
      .getConfiguration('sharplsp')
      .get<boolean>('solutionExplorer.autoReveal', true);
    if (!enabled) return;
    const node = provider.findNodeForUri(editor.document.uri.toString());
    if (node === undefined) return;
    void treeView
      .reveal(node, { select: true, focus: false, expand: true })
      .then(undefined, (err: unknown) => {
        log.traceInfo(`Solution Explorer reveal failed: ${getErrorMessage(err)}`);
      });
  };

  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(reveal),
    // Re-sync after the tree (re)populates so the selection follows the editor.
    provider.onDidChangeTreeData(() => {
      reveal(window.activeTextEditor);
    }),
    // Sync the moment the view is revealed (it may have been hidden on open).
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) reveal(window.activeTextEditor);
    }),
  );
  reveal(window.activeTextEditor);
}

/**
 * Keep the `sharplsp.fsProjectSelected` context key in step with the tree
 * selection, so the "Add F# Source File" menu entries ([SE-ADD-FILE-COMMAND])
 * appear exactly on F# project / folder / file nodes.
 */
function wireFsProjectContext(treeView: vscode.TreeView<ExplorerNode>): void {
  const sync = (selection: readonly ExplorerNode[]): void => {
    const selected = selection.some((node) => fsharpProjectOfNode(node) !== undefined);
    void commands.executeCommand('setContext', CONTEXT_FS_PROJECT_SELECTED, selected);
  };
  treeView.onDidChangeSelection((event) => {
    sync(event.selection);
  });
  sync(treeView.selection);
}

async function activateInner(context: ExtensionContext): Promise<SharpLspExtensionApi> {
  log.info('step 1: SharpLspStatusBar');
  statusBar = new SharpLspStatusBar();
  context.subscriptions.push(statusBar);
  const { provider, solutionTreeView } = createSolutionExplorer(context);
  log.info('step 4: profiler UI');
  profilerUi = registerProfiler(context);
  const features = registerFeatureModules(context, solutionTreeView);

  log.info('step 10c: acquireDotnet10Sdk');
  const dotnetPath = await acquireSdk(statusBar);
  if (dotnetPath === undefined) return degradedApi(context);

  log.info('step 11: activateShipwright');
  lspClient = await startLanguageServer(context, statusBar, dotnetPath);
  if (lspClient === undefined) return degradedApi(context);

  log.info('step 12: post-start wiring');
  wirePostStart(context, lspClient);
  log.info('step 13: activate complete');
  return {
    explorerProvider: provider,
    profiler: profilerUi,
    getLspClient: () => lspClient,
    testController: features.testController,
    logUri: context.logUri,
    targetFrameworkStatus: features.targetFrameworks.status,
    tutorial: features.tutorial,
  };
}

/** The Solution Explorer view, its provider and the editor wiring around it. */
function createSolutionExplorer(context: ExtensionContext): {
  provider: SolutionExplorerProvider;
  solutionTreeView: vscode.TreeView<ExplorerNode>;
} {
  log.info('step 2: SolutionExplorerProvider');
  const provider = new SolutionExplorerProvider();
  explorerProvider = provider;
  log.info('step 3: createTreeView SOLUTION_EXPLORER');
  const solutionTreeView = window.createTreeView<ExplorerNode>(VIEW_SOLUTION_EXPLORER, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(solutionTreeView);
  wireActiveEditorReveal(context, solutionTreeView, provider);
  wireFsProjectContext(solutionTreeView);
  log.info('step 7: initSortContext');
  provider.initSortContext();
  return { provider, solutionTreeView };
}

/** Every feature module's commands, providers and stores; none needs the server yet. */
function registerFeatureModules(
  context: ExtensionContext,
  solutionTreeView: vscode.TreeView<ExplorerNode>,
): {
  testController: SharpLspTestController;
  targetFrameworks: TargetFrameworkUi;
  tutorial: TutorialApi;
} {
  log.info('step 8: registerCommands');
  registerCommands(context);
  const tour = registerTutorial(context, solutionTreeView);
  tutorial = tour;
  log.info('step 9: registerAllModuleCommands');
  registerBuildCommands(context);
  registerNuGetCommands(context, () => lspClient);
  registerScaffoldingCommands(context);
  registerFsiCommands(context);
  registerHotReloadCommands(context);
  const frameworks = registerTargetFramework(context, () => lspClient);
  targetFrameworks = frameworks;
  registerDebugAdapter(context, frameworks.answerFor);
  const controller = registerTestExplorer(context);
  testController = controller;
  registerTestStatusLens(context, controller);
  log.info('step 10: wireDocumentChangeRefresh');
  solutions.wireRefresh(context);
  log.info('step 10b: initProjectDepsStore');
  initProjectDepsStore(context);
  return { testController: controller, targetFrameworks: frameworks, tutorial: tour };
}

/**
 * The .NET 10 SDK every dotnet child runs on, published to the shared state
 * and the process spawner; `undefined` once the failure has been shown.
 * Implements [DIST-FAILURE-UX] and [DIST-RUNTIME-ACQUIRE].
 */
async function acquireSdk(bar: SharpLspStatusBar): Promise<string | undefined> {
  const dotnetResult = await acquireDotnet10Sdk(bar);
  if (!dotnetResult.ok) {
    bar.setState(ServerState.Error);
    void showAcquireFailureNotification(dotnetResult.error, CMD_RETRY_DOTNET_ACQUISITION);
    return undefined;
  }
  const dotnetPath = dotnetResult.value;
  // Features that spawn dotnet (e.g. F# Interactive) use the resolved SDK even
  // when `dotnet` is not on $PATH, and builds, discovery and test runs point at
  // it too: the PATH SDK may be exactly the one `global.json` rejects (exit 155).
  sharedState.dotnetPath.value = dotnetPath;
  configureDotnet(dotnetPath);
  return dotnetPath;
}

/**
 * Verify the bundled binaries and start the language client; `undefined` once
 * a failure has been shown. Implements [DIST-FAILURE-UX] and [BINARY-VSCODE].
 */
async function startLanguageServer(
  context: ExtensionContext,
  bar: SharpLspStatusBar,
  dotnetPath: string,
): Promise<LanguageClient | undefined> {
  const deployResult = await verifyDeployment(context.extensionPath, dotnetPath);
  const blocking = deployResult.diagnostics.filter((diagnostic) => diagnostic.blocking);
  if (blocking.length > 0) {
    for (const diagnostic of blocking) {
      log.error(`Deployment toolkit (${diagnostic.componentId}): ${diagnostic.message}`);
    }
    bar.setState(ServerState.Error);
    void notifyActivationFailure(
      'SharpLsp could not start: required binaries are missing or version-mismatched.',
      blocking.map((diagnostic) => diagnostic.message).join(' '),
    );
    return undefined;
  }
  log.info('step 11b: client.start (await)');
  try {
    return await client.start(context, bar, deploymentPaths(deployResult), dotnetPath);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.error(`Failed to start server: ${msg}`);
    bar.setState(ServerState.Error);
    void notifyActivationFailure('SharpLsp could not start the language server.', msg);
    return undefined;
  }
}

/** Hand the started client to the views, load the solution, and restart on trust. */
function wirePostStart(context: ExtensionContext, started: LanguageClient): void {
  explorerProvider?.setClient(started);
  profilerUi?.setClient(started);
  targetFrameworks?.attach(started);
  // Fire-and-forget — don't block activation on solution loading.
  void solutions.selectAndLoad().catch((err: unknown) => {
    log.error(`Auto-select solution failed: ${getErrorMessage(err)}`);
  });
  // Implements [DIST-WORKSPACE-TRUST]: granting trust activates the previously
  // restricted executable-path/extra-args settings, so restart the client
  // rather than require a window reload.
  context.subscriptions.push(
    workspace.onDidGrantWorkspaceTrust(() => {
      log.info(
        'Workspace trust granted — restarting language server to apply trusted configuration.',
      );
      void lspClient?.restart().catch((err: unknown) => {
        log.error(`Restart after trust grant failed: ${getErrorMessage(err)}`);
      });
    }),
  );
}

function deploymentPaths(deployResult: DeploymentResult): client.DeploymentPaths {
  const serverPath = resolvedComponentPath(deployResult, 'sharplsp');
  const csharpSidecarPath = resolvedComponentPath(deployResult, 'sharplsp-sidecar-csharp');
  const fsharpSidecarPath = resolvedComponentPath(deployResult, 'sharplsp-sidecar-fsharp');
  return {
    ...(serverPath !== undefined ? { serverPath } : {}),
    ...(csharpSidecarPath !== undefined ? { csharpSidecarPath } : {}),
    ...(fsharpSidecarPath !== undefined ? { fsharpSidecarPath } : {}),
  };
}

function resolvedComponentPath(
  deployResult: DeploymentResult,
  componentId: string,
): string | undefined {
  const resolvedPath = deployResult.diagnostics.find(
    (diagnostic) => diagnostic.componentId === componentId,
  )?.resolution.path;
  return typeof resolvedPath === 'string' && resolvedPath !== '' ? resolvedPath : undefined;
}

/** Implements [DIST-FAILURE-UX]: empty/inert API returned when activation fails. */
function degradedApi(context: ExtensionContext): SharpLspExtensionApi {
  return {
    explorerProvider: explorerProvider ?? new SolutionExplorerProvider(),
    profiler: profilerUi,
    getLspClient: () => lspClient,
    testController: testController ?? new SharpLspTestController(),
    logUri: context.logUri,
    ...(targetFrameworks === undefined ? {} : { targetFrameworkStatus: targetFrameworks.status }),
    ...(tutorial === undefined ? {} : { tutorial }),
  };
}

/**
 * Implements [DIST-FAILURE-UX]: every activation failure MUST display a
 * non-modal error notification with [Show Log] and [Restart] convenience
 * buttons, plus full diagnostic detail in the output channel.
 */
export async function notifyActivationFailure(headline: string, detail: string): Promise<void> {
  log.error(`Activation failure: ${headline} — ${detail}`);
  const showLog = 'Show Log';
  const restart = 'Restart Window';
  const choice = await window.showErrorMessage(`${headline} ${detail}`, showLog, restart);
  if (choice === showLog) {
    log.output().show();
    return;
  }
  if (choice === restart) {
    await commands.executeCommand('workbench.action.reloadWindow');
  }
}

export async function deactivate(): Promise<void> {
  // Take the handle and clear it in one synchronous step. Assigning after the
  // await instead lets an activate() that runs during the stop install a NEW
  // client, which this function would then discard — leaving a live client
  // nobody can reach and a `lspClient` of undefined.
  const running = lspClient;
  lspClient = undefined;
  if (running !== undefined) {
    await running.stop();
  }
  log.dispose();
}

function registerCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand(CMD_RESTART_SERVER, async () => {
      if (statusBar === undefined) return;
      log.info('Restarting server…');
      statusBar.setState(ServerState.Starting);
      try {
        if (lspClient !== undefined) await client.restart(lspClient);
        log.info('Server restarted.');
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        log.info(`Restart failed: ${msg}`);
        statusBar.setState(ServerState.Error);
      }
    }),
  );

  context.subscriptions.push(
    commands.registerCommand(CMD_RETRY_DOTNET_ACQUISITION, async () => {
      if (statusBar === undefined) return;
      log.info('Retrying .NET 10 SDK acquisition…');
      // Implements [DIST-FAILURE-UX]: Result-based retry with toast on failure.
      const retryResult = await acquireDotnet10Sdk(statusBar);
      if (!retryResult.ok) {
        await showAcquireFailureNotification(retryResult.error, CMD_RETRY_DOTNET_ACQUISITION);
        return;
      }
      sharedState.dotnetPath.value = retryResult.value;
      const reload = 'Reload Window';
      const choice = await window.showInformationMessage(
        'SharpLsp: .NET 10 SDK acquired. Reload the window to start the language server.',
        reload,
      );
      if (choice === reload) {
        await commands.executeCommand('workbench.action.reloadWindow');
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
      await solutions.selectAndLoad();
    }),
  );

  context.subscriptions.push(
    commands.registerCommand(CMD_OPEN_SOLUTION, async (solutionPath: string) => {
      await solutions.load({ path: solutionPath, name: '' });
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

  registerNamespaceLayout(context);
  registerExplorerCommands(context, explorerDeps);
}
