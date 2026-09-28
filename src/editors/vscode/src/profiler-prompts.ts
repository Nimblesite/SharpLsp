// The dialogs the profiler commands share: pick a file, ask for an object
// address, and show a plain-text report. Each resolves `undefined` when the
// user cancels, so a command can simply stop.
import * as vscode from 'vscode';

/** The one file the user picks in an Open dialog, or `undefined` on cancel. */
export async function pickOneFile(
  filters: Record<string, string[]>,
  title: string,
): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters, title });
  return picked?.[0]?.fsPath;
}

/** A memory dump (`.dmp`) the user picks, or `undefined` on cancel. */
export async function pickDumpFile(title = 'Select memory dump file'): Promise<string | undefined> {
  return await pickOneFile({ 'Dump files': ['dmp'] }, title);
}

/** A non-empty object address (hex) the user types, or `undefined` on cancel. */
export async function askObjectAddress(prompt: string): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    prompt,
    placeHolder: '00007ff812345678',
    validateInput: (v) => (v.trim().length > 0 ? undefined : 'Address is required'),
  });
}

/** Show `lines` as a plain-text preview document. */
export async function showPlainText(lines: readonly string[]): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'plaintext',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}
