import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { info } from './log';
import * as config from './config.js';
import * as state from './state.js';

const FSI_TERMINAL_NAME = 'F# Interactive';

let fsiTerminal: vscode.Terminal | undefined;

/** True when the document is an F# source (.fs) file. */
export function isFSharpSourceDocument(
  document: vscode.TextDocument | undefined,
): document is vscode.TextDocument {
  return document?.uri.fsPath.endsWith('.fs') === true;
}

/** VS Code terminal options for launching an F# Interactive session. */
export interface FsiTerminalOptions {
  readonly name: string;
  readonly shellPath: string;
  readonly shellArgs: readonly string[];
}

/**
 * Build the terminal options for an F# Interactive session.
 *
 * When the .NET 10 SDK was acquired off-`$PATH` — e.g. via the .NET Install
 * Tool on a machine that previously had only the .NET 9 SDK (see
 * [DIST-RUNTIME-ACQUIRE]) — the bare `dotnet` command is not resolvable, so
 * FSI must launch through the resolved SDK executable. `dotnetExecutable` is
 * that absolute path; pass `undefined`/empty to fall back to `dotnet` on
 * `$PATH`. `extraArgs` follow the `fsi` verb (Ionide's `fsiExtraParameters`).
 */
export function fsiTerminalOptions(
  dotnetExecutable: string | undefined,
  extraArgs: readonly string[],
): FsiTerminalOptions {
  const shellPath =
    dotnetExecutable !== undefined && dotnetExecutable !== '' ? dotnetExecutable : 'dotnet';
  return {
    name: FSI_TERMINAL_NAME,
    shellPath,
    shellArgs: ['fsi', ...extraArgs],
  };
}

/** Create a fresh FSI terminal using the acquired SDK + configured args. */
function createFsiTerminal(): vscode.Terminal {
  const options = fsiTerminalOptions(state.dotnetPath.value, config.fsiExtraArgs());
  return vscode.window.createTerminal({
    name: options.name,
    shellPath: options.shellPath,
    shellArgs: [...options.shellArgs],
  });
}

/** Return the live FSI terminal, creating one if none is running. */
function ensureFsiTerminal(): vscode.Terminal {
  if (fsiTerminal === undefined || fsiTerminal.exitStatus !== undefined) {
    fsiTerminal = createFsiTerminal();
  }
  return fsiTerminal;
}

/** Start F# Interactive and optionally send selected text. */
function sendToFsi(): void {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId !== 'fsharp') {
    void vscode.window.showWarningMessage('No F# file is active.');
    return;
  }

  const selection = editor.selection;
  const text = selection.isEmpty
    ? editor.document.lineAt(selection.active.line).text
    : editor.document.getText(selection);

  const terminal = ensureFsiTerminal();
  terminal.show(true);
  terminal.sendText(text + ';;');
  info(`Sent to FSI: ${text.substring(0, 50)}...`);
}

/** Generate a .fsi signature file for the active F# file. */
async function generateSignatureFile(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (!isFSharpSourceDocument(document)) {
    void vscode.window.showWarningMessage('No F# file is active.');
    return;
  }

  const fsPath = document.uri.fsPath;
  const fsiPath = path.join(path.dirname(fsPath), `${path.basename(fsPath, '.fs')}.fsi`);
  const content = document.getText();
  const signature = extractSignature(content);

  fs.writeFileSync(fsiPath, signature, 'utf8');
  const uri = vscode.Uri.file(fsiPath);
  await vscode.window.showTextDocument(uri);
  info(`Generated signature file: ${fsiPath}`);
}

/** Extract a basic signature from F# source code. */
export function extractSignature(source: string): string {
  const lines = source.split('\n');
  const sigLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('module ') || trimmed.startsWith('namespace ')) {
      sigLines.push(line);
    } else if (trimmed.startsWith('type ')) {
      sigLines.push(line);
    } else if (trimmed.startsWith('let ') && !trimmed.startsWith('let private')) {
      // Convert let binding to val signature.
      const match = /^(\s*)let\s+(\w+)/.exec(line);
      if (match !== null) {
        sigLines.push(`${String(match[1])}val ${String(match[2])} : 'a`);
      }
    } else if (trimmed.startsWith('val ') || trimmed.startsWith('member ')) {
      sigLines.push(line);
    } else if (trimmed === '') {
      sigLines.push('');
    }
  }

  return sigLines.join('\n') + '\n';
}

/** Send entire file to FSI via #load. */
function sendFileToFsi(): void {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId !== 'fsharp') {
    void vscode.window.showWarningMessage('No F# file is active.');
    return;
  }

  const terminal = ensureFsiTerminal();
  terminal.show(true);
  terminal.sendText(`#load @"${editor.document.uri.fsPath}";;`);
  info(`Loaded ${editor.document.fileName} in FSI`);
}

/** Start a fresh FSI session. */
function startFsi(): void {
  if (fsiTerminal !== undefined) {
    fsiTerminal.dispose();
    fsiTerminal = undefined;
  }
  fsiTerminal = createFsiTerminal();
  fsiTerminal.show();
  info('Started fresh FSI session');
}

/** Register FSI commands. */
export function registerFsiCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sharplsp.fsi.send', sendToFsi),
    vscode.commands.registerCommand('sharplsp.fsi.sendFile', sendFileToFsi),
    vscode.commands.registerCommand('sharplsp.fsi.start', startFsi),
    vscode.commands.registerCommand('sharplsp.fsi.generateSignature', generateSignatureFile),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === fsiTerminal) {
        fsiTerminal = undefined;
      }
    }),
  );

  info('FSI commands registered');
}
