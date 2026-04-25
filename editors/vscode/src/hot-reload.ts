import * as vscode from 'vscode';
import { hotReloadOnSave } from './config.js';
import { info } from './log.js';

let watchTerminal: vscode.Terminal | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

/** Whether a hot reload session is currently active. */
export function isHotReloadRunning(): boolean {
  return watchTerminal !== undefined;
}

/** Toggle hot reload on/off. */
function toggleHotReload(): void {
  if (watchTerminal !== undefined) {
    stopHotReload();
  } else {
    startHotReload();
  }
}

/** Start dotnet watch for hot reload. */
function startHotReload(): void {
  if (watchTerminal !== undefined) {
    void vscode.window.showWarningMessage('Hot Reload is already running.');
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined || folder === '') {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  watchTerminal = vscode.window.createTerminal({
    name: 'Forge Hot Reload',
    cwd: folder,
  });
  watchTerminal.show();
  watchTerminal.sendText('dotnet watch run');
  info('Hot Reload started via dotnet watch');
  updateStatusBar();
}

/** Stop dotnet watch. */
function stopHotReload(): void {
  if (watchTerminal === undefined) {
    void vscode.window.showInformationMessage('Hot Reload is not running.');
    return;
  }

  watchTerminal.dispose();
  watchTerminal = undefined;
  info('Hot Reload stopped');
  updateStatusBar();
}

/** Update the status bar and context to reflect current hot reload state. */
function updateStatusBar(): void {
  void vscode.commands.executeCommand(
    'setContext',
    'forge.hotReloadRunning',
    watchTerminal !== undefined,
  );
  if (statusBarItem === undefined) return;
  if (watchTerminal !== undefined) {
    showRunningStatus();
  } else {
    showStoppedStatus();
  }
}

/** Display the "running" state in the status bar. */
function showRunningStatus(): void {
  if (statusBarItem === undefined) return;
  statusBarItem.text = '$(flame) Hot Reload';
  statusBarItem.tooltip = 'Hot Reload is active -- click to stop';
  statusBarItem.command = 'forge.hotReload.stop';
  statusBarItem.color = undefined;
  statusBarItem.show();
}

/** Display the "stopped" state in the status bar. */
function showStoppedStatus(): void {
  if (statusBarItem === undefined) return;
  statusBarItem.text = '$(circle-outline) Hot Reload';
  statusBarItem.tooltip = 'Hot Reload is stopped -- click to start';
  statusBarItem.command = 'forge.hotReload.start';
  statusBarItem.color = new vscode.ThemeColor('disabledForeground');
  statusBarItem.show();
}

/** Handle save events: notify the watch terminal when onSave is enabled. */
function handleDocumentSave(doc: vscode.TextDocument): void {
  if (watchTerminal === undefined) return;
  if (!hotReloadOnSave()) return;
  if (!isRelevantLanguage(doc.languageId)) return;
  info(`Hot Reload triggered on save: ${doc.uri.fsPath}`);
}

/** Check if the language is C# or F#. */
function isRelevantLanguage(languageId: string): boolean {
  return languageId === 'csharp' || languageId === 'fsharp';
}

/** Stop hot reload when a debug session ends. */
function handleDebugSessionEnd(): void {
  if (watchTerminal === undefined) return;
  info('Debug session ended -- stopping Hot Reload');
  stopHotReload();
}

/** Wire up terminal close events to clean up state. */
function wireTerminalClose(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === watchTerminal) {
        watchTerminal = undefined;
        updateStatusBar();
      }
    }),
  );
}

/** Wire up debug session lifecycle to auto-stop hot reload. */
function wireDebugLifecycle(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => {
      handleDebugSessionEnd();
    }),
  );
}

/** Wire up document save events for hot reload on save. */
function wireOnSave(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(handleDocumentSave));
}

/** Register hot reload commands and lifecycle hooks. */
export function registerHotReloadCommands(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.hotReload.start', startHotReload),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.hotReload.stop', stopHotReload),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.hotReload.toggle', toggleHotReload),
  );

  wireTerminalClose(context);
  wireOnSave(context);
  wireDebugLifecycle(context);

  updateStatusBar();
  info('Hot Reload commands registered');
}
