// Implements [TEST-REACTIVITY-BUILD]: host output observations feed the same signal as tasks.
import { Disposable, workspace } from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import { effect } from './signals';
import * as state from './state';
import { error } from './log';
import { getErrorMessage } from './utils';
import { discoveryTargets } from './test-targets';

/** Reattach monitoring after restart and follow solution selection outside workspace folders. */
export function wireBuildDiscovery(client: LanguageClient): Disposable {
  const update = (): void => {
    const targets = discoveryTargets();
    if (!state.serverRunning.value || client.state !== State.Running) return;
    void client.sendNotification('sharplsp/watchBuilds', { targets }).catch((cause: unknown) => {
      error(`Build monitoring subscription failed: ${getErrorMessage(cause)}`);
    });
  };
  return Disposable.from(
    client.onNotification('sharplsp/buildCompleted', () => {
      state.buildCompleted.value += 1;
    }),
    workspace.onDidChangeWorkspaceFolders(update),
    { dispose: effect(update) },
  );
}
