// `sharplsp.nuget.updateVulnerable` — the command the vulnerable-package update
// quick fix carries ([PKG-VULN-FIX], #578). The server installs the known-good
// version through `sharplsp/nuget/install` and restores in the background.
// Success says what changed; a failure says why — never silently
// ([REFACTOR-NEVER-SILENT]).
import * as vscode from 'vscode';
import { CMD_UPDATE_VULNERABLE_PACKAGE } from './constants.js';
import { reportCodeActionFailure } from './code-action-failures.js';
import { info } from './log.js';
import { executeServerCommand } from './server-command.js';
import { getErrorMessage } from './utils.js';

/** The command's one argument, as the server builds it. */
export interface VulnerableUpdateArgument {
  readonly projectPath: string;
  readonly packageId: string;
  readonly version: string;
  readonly expectedVersion: string;
}

/** The `sharplsp.nuget.updateVulnerable` command handler. */
export async function updateVulnerablePackage(argument: VulnerableUpdateArgument): Promise<void> {
  const title = `Update ${argument.packageId} to ${argument.version}`;
  try {
    const updated = await executeServerCommand(CMD_UPDATE_VULNERABLE_PACKAGE, argument);
    info(`${title}: ${updated.message}`);
    void vscode.window.showInformationMessage(`SharpLsp: ${updated.message}.`);
  } catch (error: unknown) {
    await reportCodeActionFailure(title, getErrorMessage(error));
  }
}
