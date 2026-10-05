import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/** Implements [PROFILER-PERFORMANCE]: progress owns the diagnostic request lifetime. */
export async function profilerRequest<T>(
  client: LanguageClient,
  method: string,
  params: object,
  title: string,
): Promise<T | undefined> {
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      const isCancelled = (): boolean => token.isCancellationRequested;
      if (isCancelled()) return undefined;
      try {
        return await client.sendRequest<T>(method, params, token);
      } catch (error: unknown) {
        if (isCancelled()) return undefined;
        throw error;
      }
    },
  );
}
