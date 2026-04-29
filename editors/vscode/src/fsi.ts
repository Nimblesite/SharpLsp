import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { info } from './log';

let fsiTerminal: vscode.Terminal | undefined;

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

  if (fsiTerminal === undefined || fsiTerminal.exitStatus !== undefined) {
    fsiTerminal = vscode.window.createTerminal({
      name: 'F# Interactive',
      shellPath: 'dotnet',
      shellArgs: ['fsi'],
    });
  }

  fsiTerminal.show(true);
  fsiTerminal.sendText(text + ';;');
  info(`Sent to FSI: ${text.substring(0, 50)}...`);
}

/** Generate a .fsi signature file for the active F# file. */
async function generateSignatureFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const fsPath = editor?.document.uri.fsPath;
  if (editor === undefined || fsPath === undefined || !fsPath.endsWith('.fs')) {
    void vscode.window.showWarningMessage('No F# file is active.');
    return;
  }

  const fsiPath = path.join(path.dirname(fsPath), `${path.basename(fsPath, '.fs')}.fsi`);
  const content = editor.document.getText();
  const signature = extractSignature(content);

  fs.writeFileSync(fsiPath, signature, 'utf8');
  const uri = vscode.Uri.file(fsiPath);
  await vscode.window.showTextDocument(uri);
  info(`Generated signature file: ${fsiPath}`);
}

/** Extract a basic signature from F# source code. */
function extractSignature(source: string): string {
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

  if (fsiTerminal === undefined || fsiTerminal.exitStatus !== undefined) {
    fsiTerminal = vscode.window.createTerminal({
      name: 'F# Interactive',
      shellPath: 'dotnet',
      shellArgs: ['fsi'],
    });
  }

  fsiTerminal.show(true);
  fsiTerminal.sendText(`#load @"${editor.document.uri.fsPath}";;`);
  info(`Loaded ${editor.document.fileName} in FSI`);
}

/** Start a fresh FSI session. */
function startFsi(): void {
  if (fsiTerminal !== undefined) {
    fsiTerminal.dispose();
    fsiTerminal = undefined;
  }
  fsiTerminal = vscode.window.createTerminal({
    name: 'F# Interactive',
    shellPath: 'dotnet',
    shellArgs: ['fsi'],
  });
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
