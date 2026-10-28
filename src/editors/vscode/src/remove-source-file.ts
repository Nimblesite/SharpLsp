// "Remove F# Source File" (GitHub #493) — [SE-REMOVE-FILE-COMMAND].
//
// The counterpart of "Add F# Source File": takes a file out of its .fsproj's
// compile order through the host's `sharplsp/project/removeCompileItem`, which
// edits the project through the C# sidecar's MSBuild DOM
// ([SE-REMOVE-FILE-REQUEST]). The file itself is the user's: a modal question
// keeps it on disk or deletes it, and dismissing it changes nothing.
import * as vscode from 'vscode';
import {
  compileIncludeOf,
  fsharpProjectOfNode,
  type AddCompileItemResponse,
  type NodeLike,
} from './add-source-file.js';
import { CMD_REFRESH_EXPLORER } from './constants.js';
import { info } from './log.js';
import { fileNameOf } from './paths';
import * as state from './state.js';
import { getErrorMessage } from './utils.js';

/** Take the file out of compile order and leave it on disk. */
export const KEEP_FILE = 'Remove from Project';
/** Take the file out of compile order and delete it. */
export const DELETE_FILE = 'Remove and Delete File';

/** The project and the file a node names. */
interface Removal {
  readonly projectPath: string;
  readonly file: string;
}

/** The `sharplsp.removeFSharpSourceFile` command handler. */
export async function removeFSharpSourceFile(node?: NodeLike): Promise<void> {
  try {
    const removal = removalOf(node);
    if (removal === undefined) return;
    const choice = await ask(removal);
    if (choice === undefined) return;
    if (!(await removeFromProject(removal))) return;
    if (choice === DELETE_FILE) await vscode.workspace.fs.delete(vscode.Uri.file(removal.file));
    await vscode.commands.executeCommand(CMD_REFRESH_EXPLORER);
  } catch (err) {
    void vscode.window.showErrorMessage(`Remove F# Source File failed: ${getErrorMessage(err)}`);
  }
}

/** The file node's project and file, or an error saying why there is none. */
function removalOf(node: NodeLike | undefined): Removal | undefined {
  const projectPath = fsharpProjectOfNode(node);
  if (projectPath === undefined || node?.symbolUri === undefined) {
    void vscode.window.showErrorMessage(
      'Remove F# Source File: run it on a file of an F# project.',
    );
    return undefined;
  }
  return { projectPath, file: vscode.Uri.parse(node.symbolUri).fsPath };
}

/** Keep the file, delete it, or (dismissed) leave everything as it is. */
async function ask(removal: Removal): Promise<string | undefined> {
  return await vscode.window.showWarningMessage(
    `Remove ${fileNameOf(removal.file)} from ${fileNameOf(removal.projectPath)}?`,
    { modal: true, detail: `${DELETE_FILE} deletes ${removal.file} permanently.` },
    KEEP_FILE,
    DELETE_FILE,
  );
}

/** Ask the host to take the Compile item out; report a failure and say so. */
async function removeFromProject(removal: Removal): Promise<boolean> {
  const include = compileIncludeOf(removal.projectPath, removal.file);
  const response = await state.client.value?.sendRequest<AddCompileItemResponse>(
    'sharplsp/project/removeCompileItem',
    { projectPath: removal.projectPath, include },
  );
  if (response?.success !== true) {
    const reason = response?.message ?? 'no language client';
    void vscode.window.showErrorMessage(`Failed to remove ${include}: ${reason}`);
    return false;
  }
  info(`Removed ${include} from ${fileNameOf(removal.projectPath)}`);
  return true;
}
