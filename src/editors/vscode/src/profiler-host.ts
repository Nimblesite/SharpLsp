// Implements [PROFILER-SHARED-LIBRARY-VSCODE]. SharpLsp's `ProfilerHost` for
// @nimblesite/lsp-profiler-ui: identity, the language client, logging, and
// how debuggee PIDs and "run the current project" launches come from the
// SharpLsp debug adapter. Every profiling screen lives in the library.

import { signal, type Signal } from '@preact/signals-core';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  registerProfilerUi,
  type LaunchMetric,
  type ProfilerHost,
  type ProfilerPalette,
  type ProfilerUi,
} from '@nimblesite/lsp-profiler-ui';
import { DEBUG_TYPE } from './constants';
import * as log from './log.js';

/** SharpLsp's profiler colours: greens for CPU and memory, red for leaks ([PROF-UI-PALETTE]). */
export const SHARPLSP_PALETTE: ProfilerPalette = {
  critical: '#3eaa67',
  hot: '#61c481',
  warm: '#a1d9a4',
  memory: '#42b89d',
  memoryHot: '#82cfb7',
  memoryWarm: '#6bb69e',
  memoryCool: '#479880',
  leak: '#f87171',
  success: '#34d399',
};

/** What `activate` keeps: the registered UI and the client seam to fill once the server starts. */
export interface SharpLspProfiler {
  readonly ui: ProfilerUi;
  /** Set once the language client is running; the library reacts to the change. */
  setClient(client: LanguageClient | undefined): void;
}

/** Register the profiler UI with SharpLsp's identity. */
export function registerProfiler(context: vscode.ExtensionContext): SharpLspProfiler {
  const client = signal<LanguageClient | undefined>(undefined);
  const host: ProfilerHost = {
    idPrefix: 'sharplsp',
    brand: 'SharpLsp',
    palette: SHARPLSP_PALETTE,
    configSection: 'sharplsp',
    debugType: DEBUG_TYPE,
    languageIds: ['csharp', 'fsharp'],
    languageNames: ['F#', 'C#'],
    client,
    logger: {
      trace: log.traceInfo,
      debug: log.traceInfo,
      info: log.info,
      warn: log.warn,
      error: log.error,
    },
    sessionIdToPid: trackDebuggeePids(context),
    launchConfig: profilingLaunch,
  };
  const ui = registerProfilerUi(context, host);
  return {
    ui,
    setClient(next) {
      client.value = next;
    },
  };
}

/**
 * The debug adapter reports the debuggee's PID in the DAP `process` event;
 * record it per session so the library can profile the program being debugged.
 */
function trackDebuggeePids(context: vscode.ExtensionContext): Signal<ReadonlyMap<string, number>> {
  const pids = signal<ReadonlyMap<string, number>>(new Map());
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(message: unknown) {
            const pid = processEventPid(message);
            if (pid !== undefined) {
              pids.value = new Map([...pids.value, [session.id, pid]]);
            }
          },
          onWillStopSession() {
            const next = new Map(pids.value);
            next.delete(session.id);
            pids.value = next;
          },
        };
      },
    }),
  );
  return pids;
}

function processEventPid(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if (Reflect.get(message, 'type') !== 'event' || Reflect.get(message, 'event') !== 'process') {
    return undefined;
  }
  const body: unknown = Reflect.get(message, 'body');
  if (typeof body !== 'object' || body === null) return undefined;
  const pid: unknown = Reflect.get(body, 'systemProcessId');
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

/**
 * "Run & Profile" launches the project that owns `program` under the SharpLsp
 * debug adapter, which resolves the project from the active file when no
 * program is given ([DEBUG-FEATURES-LAUNCH-PROFILES]).
 */
function profilingLaunch(metric: LaunchMetric, program: string): vscode.DebugConfiguration {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(program));
  return {
    type: DEBUG_TYPE,
    request: 'launch',
    name:
      metric === 'cpu' ? 'Run & Profile CPU (Current File)' : 'Run & Track Memory (Current File)',
    ...(folder === undefined ? {} : { cwd: folder.uri.fsPath }),
    ...(metric === 'cpu' ? { profileOnLaunch: true } : { memoryTrackOnLaunch: true }),
  };
}
