// Editor navigation commands. Both ask the host, which answers for every
// editor: `sharplsp/relatedFiles` lists the files that belong with the active
// one ([SHARPLSP-FEATURES-NAVIGATION-RELATED]) and `sharplsp/adjacentMember`
// says where the next or previous member starts
// ([SHARPLSP-FEATURES-NAVIGATION-MEMBERS]).
import * as vscode from 'vscode';
import {
  CMD_GO_TO_NEXT_MEMBER,
  CMD_GO_TO_PREVIOUS_MEMBER,
  CMD_GO_TO_RELATED_FILE,
} from './constants.js';
import { info } from './log.js';
import * as state from './state.js';

/** One file the host relates to the active one. */
interface RelatedFile {
  readonly uri: string;
  readonly name: string;
}

/** Where the neighbouring member starts; `null` past either end. */
interface AdjacentMember {
  readonly position: { readonly line: number; readonly character: number } | null;
}

/** The file to open: the only one, or the one picked from several. */
async function chooseRelated(files: readonly RelatedFile[]): Promise<RelatedFile | undefined> {
  if (files.length < 2) return files[0];
  const picked = await vscode.window.showQuickPick(
    files.map((file) => ({ label: file.name, file })),
    { placeHolder: 'Go to related file' },
  );
  return picked?.file;
}

/** `sharplsp.goToRelatedFile`: open a file that belongs with the active one. */
async function goToRelatedFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const client = state.client.value;
  if (editor === undefined || client === undefined) return;
  const textDocument = client.code2ProtocolConverter.asTextDocumentIdentifier(editor.document);
  const { files } = await client.sendRequest<{ readonly files: readonly RelatedFile[] }>(
    'sharplsp/relatedFiles',
    { textDocument },
  );
  info(`relatedFiles: ${String(files.length)} beside ${textDocument.uri}`);
  if (files.length === 0) {
    void vscode.window.showInformationMessage('SharpLsp: this file has no related files.');
    return;
  }
  const chosen = await chooseRelated(files);
  if (chosen !== undefined) await vscode.window.showTextDocument(vscode.Uri.parse(chosen.uri));
}

/** Move the caret to the neighbouring member's name; stay put past the ends. */
async function goToMember(direction: 'next' | 'previous'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const client = state.client.value;
  if (editor === undefined || client === undefined) return;
  const { position } = await client.sendRequest<AdjacentMember>('sharplsp/adjacentMember', {
    textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(editor.document),
    position: client.code2ProtocolConverter.asPosition(editor.selection.active),
    direction,
  });
  if (position === null) return;
  const target = new vscode.Position(position.line, position.character);
  // Awaited, so the caret has moved before the next step reads it: assigning
  // `editor.selection` returns before the editor applies it, and a second key
  // press could start from where the first one began.
  await vscode.window.showTextDocument(editor.document, {
    ...(editor.viewColumn === undefined ? {} : { viewColumn: editor.viewColumn }),
    selection: new vscode.Range(target, target),
  });
}

/** Register the editor navigation commands. */
export function registerEditorNavigation(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_GO_TO_RELATED_FILE, goToRelatedFile),
    vscode.commands.registerCommand(CMD_GO_TO_NEXT_MEMBER, async () => {
      await goToMember('next');
    }),
    vscode.commands.registerCommand(CMD_GO_TO_PREVIOUS_MEMBER, async () => {
      await goToMember('previous');
    }),
  );
}
