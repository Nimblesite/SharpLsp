// Tests for [PROF-UI-PROCESSES]: the shared harness of the Processes panel
// suites. A store whose LSP client serves a stubbed process table and records
// every executeCommand request, the provider loaded through the real fetch
// path, the inline row actions exactly as VS Code invokes them, and a
// decoration provider that always cleans up after itself.
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import {
  ProcessDecorationProvider,
  ProcessesProvider,
  type ProcessInfo,
} from '@nimblesite/lsp-profiler-ui/out/src/process-explorer';
import {
  createProcessRowActions,
  type ProcessRowDeps,
} from '@nimblesite/lsp-profiler-ui/out/src/process-launch';
import {
  createProfilerStore,
  type ProfilerStore as Store,
} from '@nimblesite/lsp-profiler-ui/out/src/store';
import {
  fakeHost,
  processFixture,
  seedSignal,
  toWireProcess,
  ungroup,
} from './profiler-ui-helpers';
import { rawField } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';

export type { ProfilerStore as Store } from '@nimblesite/lsp-profiler-ui/out/src/store';

const MB = 1024 * 1024;

/** The CPU and memory capabilities a CPython runtime advertises ([PROF-UI-CAPABILITIES]). */
const CPYTHON_PROFILERS = {
  cpu: { live_progress: true, line_level: true, native_frames: false, cooperative: true },
  memory: {
    mode: { kind: 'Courier' },
    allocation_sites: true,
    references: false,
    objects_by_type: false,
    gc_collect: true,
  },
} as const;

/** A representative process table covering launchers, users, and versions. */
export const STUB_PROCESSES: readonly ProcessInfo[] = [
  processFixture(100, {
    script: '/app/web.py',
    cpuPercent: 5,
    memoryBytes: 50 * MB,
    runtimeSecs: 10,
    user: 'alice',
    inWorkspace: true,
  }),
  processFixture(200, {
    name: 'python3.11',
    interpreterPath: '/usr/bin/python3.11',
    script: '/app/worker.py',
    runtimeVersion: '3.11.7',
    cpuPercent: 42,
    memoryBytes: 10 * MB,
    runtimeSecs: 99,
    user: 'bob',
    requiresElevation: true,
  }),
  processFixture(300, {
    ppid: 200,
    script: '/app/uvicorn.py',
    cpuPercent: 1,
    memoryBytes: 99 * MB,
    runtimeSecs: 5,
    user: 'alice',
    launcher: 'uvicorn',
  }),
];

/** A debugger-machinery row: listed, but non-debuggable (the 🚫 / grey / sunk case). */
export const MACHINERY: ProcessInfo = processFixture(900, {
  cpuPercent: 99,
  memoryBytes: 5 * MB,
  runtimeSecs: 3,
  user: 'alice',
  debuggable: false,
  undebuggableReason: 'debugger machinery',
});

/** One `workspace/executeCommand` request captured by the recording client. */
export interface RecordedRequest {
  readonly command: string;
  readonly arguments: readonly unknown[];
}

/** A store paired with the wire traffic its client recorded. */
export interface Recording {
  readonly store: Store;
  readonly requests: RecordedRequest[];
}

/**
 * Build a Store whose LSP client returns the given process table and records
 * every executeCommand request so tests can assert what was sent (e.g. that an
 * inline action really issued `basilisk.profiler.start` with the row's PID).
 */
export function storeWith(processes: readonly ProcessInfo[], requests?: RecordedRequest[]): Store {
  const store = createProfilerStore(fakeHost());
  // A stand-in for the three members the provider actually calls. No runtime
  // check can produce the rest of `LanguageClient`, so this one assertion
  // stays — it is the test double itself, not a payload being read.

  const client = {
    isRunning: (): boolean => true,
    // The server names its runtime; the row must show that name, never a
    // guess derived from the wire id's spelling ([PROF-UI-CAPABILITIES]).
    initializeResult: {
      capabilities: {
        experimental: {
          lspProfiler: {
            // Both profilers, as tracemalloc-backed CPython advertises: an absent
            // `memory` block means the runtime has no memory profiler at all.
            runtimes: [
              { id: 'python', display_name: 'CPython', source_entries: true, ...CPYTHON_PROFILERS },
            ],
          },
        },
      },
    },
    onDidChangeState: (): vscode.Disposable => ({ dispose: (): undefined => undefined }),
    sendRequest: async (_method: string, param?: RecordedRequest): Promise<unknown> => {
      if (param !== undefined) {
        requests?.push(param);
      }
      if (param?.command === 'sharplsp.lspProfiler.cpu.start') {
        return undefined;
      }
      return { processes: processes.map(toWireProcess) };
    },
  } as unknown as LanguageClient;
  seedSignal(store.client, client);
  return store;
}

/** A store over `processes` (the stub table by default) plus its recorded wire traffic. */
export function recordedStore(processes: readonly ProcessInfo[] = STUB_PROCESSES): Recording {
  const requests: RecordedRequest[] = [];
  return { store: storeWith(processes, requests), requests };
}

/**
 * Build a flat provider over `store` and pull the process table into the store
 * through the real store-side fetch path — getChildren() is a pure projection
 * of centralised state and never fetches on its own (#148).
 */
export async function loadedProvider(store: Store): Promise<ProcessesProvider> {
  ungroup(store);
  const provider = new ProcessesProvider(store);
  await provider.refreshNow();
  return provider;
}

/** A suite-managed provider slot: every load replaces the last, disposed after each test. */
export interface ProviderSlot {
  /** Load a provider over `store` and remember it for teardown. */
  load(store: Store): Promise<ProcessesProvider>;
}

/** Register a provider slot whose current provider is disposed in teardown. */
export function providerSlot(): ProviderSlot {
  let current: ProcessesProvider | undefined;
  teardown(() => {
    current?.dispose();
  });
  return {
    load: async (store: Store) => {
      const provider = await loadedProvider(store);
      current = provider;
      return provider;
    },
  };
}

/** The `basilisk.profiler.start` requests among the recorded ones. */
export function profilerStarts(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((req) => req.command === 'sharplsp.lspProfiler.cpu.start');
}

/** The pid argument of a recorded `basilisk.profiler.start` request. */
export function startPid(request: RecordedRequest): unknown {
  return rawField(request.arguments[0], 'pid');
}

/** Drive the inline Profile-CPU action against `item` exactly as VS Code passes it. */
export async function runInlineProfile(
  store: Store,
  item: vscode.TreeItem | undefined,
  selection: readonly vscode.TreeItem[],
): Promise<void> {
  await createProcessRowActions(store, { selection }).profileProcess(item);
}

/** Drive the inline Track-Memory action against `item` with the tree's `selection` and `deps`. */
export async function runInlineTrackMemory(
  store: Store,
  item: vscode.TreeItem | undefined,
  selection: readonly vscode.TreeItem[],
  deps: ProcessRowDeps,
): Promise<void> {
  await createProcessRowActions(store, { selection }, deps).memoryTrackProcess(item);
}

/** Run `assert` against a decoration provider bound to `provider`, always disposing it. */
export function withDecorations<T>(
  provider: ProcessesProvider,
  assertBlock: (decorations: ProcessDecorationProvider) => T,
): T {
  const decorations = new ProcessDecorationProvider(provider);
  try {
    return assertBlock(decorations);
  } finally {
    decorations.dispose();
  }
}
