// The server's `workspace/executeCommand` commands. The client's own command
// feature is off ([PROFILER-SHARED-LIBRARY-VSCODE]), so each command a code
// action carries is registered by the extension and forwarded here.
import { ExecuteCommandRequest } from 'vscode-languageclient/node';
import * as state from './state.js';

/** What the server answers once a command has applied. */
export interface ServerCommandResult {
  readonly message: string;
}

/** Run `command` on the server with its one `argument`; a refusal throws. */
export async function executeServerCommand(
  command: string,
  argument: unknown,
): Promise<ServerCommandResult> {
  const client = state.client.value;
  if (client === undefined) {
    throw new Error('the language server is not running');
  }
  return await client.sendRequest<ServerCommandResult>(ExecuteCommandRequest.method, {
    command,
    arguments: [argument],
  });
}
