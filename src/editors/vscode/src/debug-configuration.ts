// Editor bridge to server-owned configuration. Implements [CONFIG-EDITOR-BRIDGE].
import * as vscode from 'vscode';
import * as state from './state';
import type { ExceptionPolicy } from './dap-exception-policy';

/** The shared configuration fields consumed by this editor integration. */
interface SharedConfiguration {
  readonly debug: { readonly exceptions: ExceptionPolicy };
}

/** Resolve shared settings through LSP; launch.json may supply explicit overrides. */
export async function sharedDebugConfiguration(
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
): Promise<{ exceptionPolicy?: ExceptionPolicy; justMyCode?: boolean }> {
  const client = state.client.value;
  if (client === undefined) return {};
  const policy: unknown = config.exceptionPolicy;
  const overrides = policy === undefined ? {} : { debug: { exceptions: policy } };
  const scope =
    typeof config.cwd === 'string'
      ? vscode.Uri.file(config.cwd)
      : typeof config.program === 'string'
        ? vscode.Uri.file(config.program)
        : folder?.uri;
  const resolved = await client.sendRequest<SharedConfiguration>('sharplsp/configuration', {
    scopeUri: scope?.toString(),
    overrides,
  });
  return {
    exceptionPolicy: resolved.debug.exceptions,
    ...(resolved.debug.exceptions.break_on === 'user-unhandled' ? { justMyCode: true } : {}),
  };
}
