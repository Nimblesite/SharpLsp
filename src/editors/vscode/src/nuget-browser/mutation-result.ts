// Shared install/uninstall result presentation.
import * as vscode from 'vscode';
import type { LspResult } from './lsp.js';
import type { ToastState } from './html.js';

/** Render a mutation result and report whether reactive state should reload. */
export function showMutationResult(
  result: LspResult<{ success: boolean; message: string }>,
  op: 'install' | 'uninstall',
  packageId: string,
  setToast: (toast: ToastState | undefined, clearMs?: number) => void,
): boolean {
  const error = mutationError(result);
  if (error !== undefined) {
    setToast({ kind: 'error', text: `${op} failed: ${error}` });
    void vscode.window.showErrorMessage(`${op} failed: ${error}`);
    return false;
  }
  const verb = op === 'install' ? 'Installed' : 'Removed';
  setToast({ kind: 'success', text: `${verb} ${packageId}` }, 2000);
  return true;
}

function mutationError(
  result: LspResult<{ success: boolean; message: string }>,
): string | undefined {
  if (!result.ok) return result.error;
  return result.value.success ? undefined : result.value.message;
}
