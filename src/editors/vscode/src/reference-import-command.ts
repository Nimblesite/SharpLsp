// `sharplsp.addReferenceAndImport` — the command a reference quick fix carries
// ([REFACTOR-IMPORT-REFERENCE]). The action's own edit has already added the
// using or open; this adds the project or package reference it needs. The
// client's command feature is off ([PROFILER-SHARED-LIBRARY-VSCODE]), so the
// extension registers the command and sends it to the server as
// `workspace/executeCommand`. Success says what changed; a failure says why,
// that the import is already in place, and where the log is — never silently
// ([REFACTOR-NEVER-SILENT]).
import * as vscode from 'vscode';
import { CMD_ADD_REFERENCE_AND_IMPORT } from './constants.js';
import { reportCodeActionFailure } from './code-action-failures.js';
import { info } from './log.js';
import { executeServerCommand } from './server-command.js';
import { getErrorMessage } from './utils.js';

/** The command's one argument, as the server builds it. */
export interface ReferenceImportArgument {
  readonly title: string;
  readonly reference: {
    readonly kind: string;
    readonly projectPath: string;
    readonly reference: string;
    readonly version: string;
  };
}

/** Why the import alone does not fix the code, appended to every failure. */
const IMPORT_KEPT = 'the import is already in place, and Undo removes it';

/** The `sharplsp.addReferenceAndImport` command handler. */
export async function addReferenceAndImport(argument: ReferenceImportArgument): Promise<void> {
  try {
    const added = await executeServerCommand(CMD_ADD_REFERENCE_AND_IMPORT, argument);
    info(`${argument.title}: ${added.message}`);
    void vscode.window.showInformationMessage(`SharpLsp: ${added.message}.`);
  } catch (error: unknown) {
    await reportCodeActionFailure(argument.title, `${getErrorMessage(error)}; ${IMPORT_KEPT}`);
  }
}
