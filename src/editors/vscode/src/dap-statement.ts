// Source-aware debugger stop classification.
//
// netcoredbg exposes CLR sequence points, including C# block braces. The Rust
// host already owns the concrete syntax trees for both C# and F#, so the router
// asks it whether a stop carries code instead of guessing from source text.
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as state from './state';

/** One source position reported by the adapter, in DAP's one-based coordinates. */
export interface StatementLocation {
  readonly path: string | undefined;
  readonly line: number;
  readonly column: number;
}

/** Whether a step location belongs to the user's workspace under JMC. */
export async function carriesUserCode(
  location: StatementLocation,
  justMyCode: boolean,
  launchRoot?: string,
): Promise<boolean> {
  if (justMyCode && !belongsToUserCode(location, launchRoot)) {
    return false;
  }
  return await carriesCode(location);
}

export function belongsToUserCode(location: StatementLocation, launchRoot?: string): boolean {
  if (location.path === undefined) return false;
  return (
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(location.path)) !== undefined ||
    isWithin(launchRoot, location.path)
  );
}

function isWithin(root: string | undefined, candidate: string): boolean {
  if (root === undefined) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

interface StatementStopResponse {
  readonly statement: boolean;
}

/**
 * True when a stop is code the user should see.
 *
 * This operation is deliberately fail-open: an absent LSP client, an unknown
 * source, or a failed request keeps the stop visible. Hiding a real statement
 * is worse than exposing one structural sequence point.
 */
export async function carriesCode(location: StatementLocation): Promise<boolean> {
  if (location.path === undefined || location.line <= 0) return true;
  const lsp = state.client.value;
  if (lsp === undefined) return true;
  try {
    const response = await lsp.sendRequest<StatementStopResponse>('sharplsp/statementStop', {
      uri: vscode.Uri.file(location.path).toString(),
      line: location.line - 1,
      character: Math.max(0, location.column - 1),
    });
    return typeof response.statement === 'boolean' ? response.statement : true;
  } catch {
    return true;
  }
}
