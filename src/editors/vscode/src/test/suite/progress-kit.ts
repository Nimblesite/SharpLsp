import * as vscode from 'vscode';

/** Real progress lifetime, shared by build and profiler presentation tests. */
interface ProgressCall {
  readonly options: vscode.ProgressOptions;
  settledAt: number | undefined;
}

/** Implements [SE-ACTIONS-BUILD] and [PROFILER-PERFORMANCE]. */
export function recordProgress(token?: vscode.CancellationToken): {
  readonly calls: ProgressCall[];
  restore: () => void;
} {
  const mutable = vscode.window as { withProgress: typeof vscode.window.withProgress };
  const original = mutable.withProgress;
  const calls: ProgressCall[] = [];
  mutable.withProgress = async (options, body) => {
    const call: ProgressCall = { options, settledAt: undefined };
    calls.push(call);
    const result = await original(options, (progress, actual) => body(progress, token ?? actual));
    call.settledAt = Date.now();
    return result;
  };
  return { calls, restore: () => (mutable.withProgress = original) };
}
