// How one `sharplsp/nuget/restoreProgress` notification changes the panel:
// which spinner it toggles and the toast it shows, as data the panel applies.
// Implements [NUGET-WEBVIEW-EXTENSION].
import type { ToastState } from './html.js';
import { type LoadingKey, type RestoreProgressParams, restoreKey } from './types.js';

/** The panel-state change one restore phase asks for. */
export interface RestoreEffect {
  /** The loading key that starts or stops spinning. */
  readonly key: LoadingKey;
  readonly spinning: boolean;
  readonly toast: ToastState;
  /** How long a terminal toast stays before clearing itself. */
  readonly clearMs?: number;
}

const TERMINAL: Record<
  'succeeded' | 'failed',
  { kind: ToastState['kind']; text: string; clearMs: number }
> = {
  succeeded: { kind: 'success', text: 'Restore succeeded', clearMs: 2000 },
  failed: { kind: 'error', text: 'Restore failed', clearMs: 5000 },
};

/** Map a restore phase to its effect; the server's message wins over the default text. */
export function restoreEffect(params: RestoreProgressParams): RestoreEffect {
  const key = restoreKey(params.targetId);
  if (params.phase === 'started' || params.phase === 'restoring') {
    return {
      key,
      spinning: true,
      toast: { kind: 'info', text: params.message ?? 'Restoring packages…' },
    };
  }
  const terminal = TERMINAL[params.phase];
  return {
    key,
    spinning: false,
    toast: { kind: terminal.kind, text: params.message ?? terminal.text },
    clearMs: terminal.clearMs,
  };
}
