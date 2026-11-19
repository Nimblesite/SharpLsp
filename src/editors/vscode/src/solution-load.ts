/**
 * Choosing and loading the solution the Solution Explorer and the LSP server
 * work from, and the debounced tree refresh that follows source or solution
 * file changes. Implements [SE-SOLUTION] and [SE-LOADING-FEEDBACK].
 */
import * as fs from 'node:fs';
import { type ExtensionContext, type Memento, window, workspace } from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { VIEW_SOLUTION_EXPLORER } from './constants.js';
import * as log from './log.js';
import * as solution from './solution.js';
import * as sharedState from './state.js';
import { type SolutionExplorerProvider } from './tree.js';
import { getErrorMessage } from './utils.js';

/** The live client and explorer the loader drives; either may not exist yet. */
export interface SolutionLoaderDeps {
  readonly client: () => LanguageClient | undefined;
  readonly explorer: () => SolutionExplorerProvider | undefined;
  /** Per-workspace storage that outlives a window reload; absent until activation. */
  readonly memory?: Memento;
}

/** Solution selection and loading bound to one extension activation. */
export interface SolutionLoader {
  /** Reopen the remembered solution, else select one (auto or user-picked) and load it. */
  readonly selectAndLoad: () => Promise<void>;
  /** Always ask which solution to load: the user is switching on purpose. */
  readonly pickAndLoad: () => Promise<void>;
  /** Load a solution into the explorer tree AND the LSP sidecar. */
  readonly load: (selected: solution.SolutionSelection) => Promise<void>;
  /** Re-fetch workspace symbols when source or solution files change. */
  readonly wireRefresh: (context: ExtensionContext) => void;
}

const REFRESH_DEBOUNCE_MS = 1_000;
const RELEVANT_LANGUAGES = new Set(['csharp', 'fsharp']);
const SOLUTION_FILE_GLOB = '**/*.{sln,slnx}';
/** The workspace-storage key holding the solution last loaded in this workspace. */
const REMEMBERED_SOLUTION = 'sharplsp.solution';

/** The remembered solution while its file still exists; a deleted one is forgotten. */
function remembered(memory: Memento | undefined): solution.SolutionSelection | undefined {
  const stored = memory?.get<string>(REMEMBERED_SOLUTION);
  if (stored === undefined || !fs.existsSync(stored)) return undefined;
  return solution.toSolutionSelections([stored])[0];
}

/** Build the loader; selection generations make a superseded pick a no-op. */
export function solutionLoader(deps: SolutionLoaderDeps): SolutionLoader {
  let generation = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const isCurrent = (started: number, initialSolution: string | undefined): boolean =>
    started === generation && sharedState.solutionPath.value === initialSolution;

  const scheduleRefresh = (reason: string): void => {
    log.traceInfo(reason);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      log.traceInfo('Debounced tree refresh triggered');
      void deps.explorer()?.refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  const load = async (selected: solution.SolutionSelection): Promise<void> => {
    generation += 1;
    log.info(`Loading solution: ${selected.path}`);
    // Cover the whole load — the LSP reload below runs BEFORE
    // state.loadSolution begins its own phase, and the tree must not sit on a
    // stale/blank view meanwhile ([SE-LOADING-FEEDBACK]).
    const phase = sharedState.beginLoading(selected.path);
    // `finally`, never a trailing statement: a throw out of the explorer load
    // would otherwise leave the phase set forever and the tree spinning.
    try {
      await reloadSidecars(deps.client(), selected.path);
      await deps.explorer()?.loadSolution(selected.path);
      await deps.memory?.update(REMEMBERED_SOLUTION, selected.path);
    } finally {
      sharedState.endLoadPhase(phase);
    }
  };

  const selectAndLoad = async (): Promise<void> => {
    const known = remembered(deps.memory);
    if (known === undefined) {
      await pickAndLoad();
      return;
    }
    log.info(`Reopening remembered solution: ${known.path}`);
    await load(known);
  };

  const pickAndLoad = async (): Promise<void> => {
    const started = ++generation;
    const initialSolution = sharedState.solutionPath.value;
    // [SE-LOADING-FEEDBACK]: `window.withProgress` puts a native progress bar in
    // the Solution Explorer view title while the workspace scan (up to 5s) and
    // the load run; the `loadPhase` signal drives the in-tree spinner node.
    await window.withProgress(
      { location: { viewId: VIEW_SOLUTION_EXPLORER } },
      async (progress) => {
        progress.report({ message: 'Searching for solutions…' });
        const solutions = await discoverSolutions();
        if (!isCurrent(started, initialSolution) || solutions.length === 0) return;
        const picked =
          solutions.length === 1 ? solutions[0] : await solution.promptUserSelection(solutions);
        if (!isCurrent(started, initialSolution)) return;
        if (picked !== undefined) {
          progress.report({ message: `Loading ${picked.name}…` });
          await load(picked);
          return;
        }
        // User dismissed the QuickPick — show solutions as buttons in the tree.
        deps.explorer()?.showSolutionPicker(solutions);
      },
    );
  };

  const wireRefresh = (context: ExtensionContext): void => {
    context.subscriptions.push(
      workspace.onDidChangeTextDocument((event) => {
        if (!RELEVANT_LANGUAGES.has(event.document.languageId)) return;
        if (event.contentChanges.length === 0) return;
        scheduleRefresh(`Document changed: ${event.document.uri.fsPath}`);
      }),
    );
    const solutionWatcher = workspace.createFileSystemWatcher(SOLUTION_FILE_GLOB);
    const onSolutionFile = (uri: { readonly fsPath: string }): void => {
      scheduleRefresh(`Solution file changed: ${uri.fsPath}`);
    };
    context.subscriptions.push(
      solutionWatcher,
      solutionWatcher.onDidChange(onSolutionFile),
      solutionWatcher.onDidCreate(onSolutionFile),
      solutionWatcher.onDidDelete(onSolutionFile),
    );
    log.traceInfo(`Solution file watcher active: ${SOLUTION_FILE_GLOB}`);
  };

  return { selectAndLoad, pickAndLoad, load, wireRefresh };
}

/** Scan the workspace; a failed scan must still clear the discovery phase. */
async function discoverSolutions(): Promise<readonly solution.SolutionSelection[]> {
  const phase = sharedState.beginDiscovery();
  try {
    return await solution.findSolutions();
  } finally {
    sharedState.endLoadPhase(phase);
  }
}

/**
 * Tell the LSP server to reload sidecars with this specific solution. Without
 * it the sidecar uses the workspace root and may pick the wrong solution when
 * several exist — breaking hover, definition, etc.
 */
async function reloadSidecars(client: LanguageClient | undefined, path: string): Promise<void> {
  if (client === undefined) return;
  try {
    await client.sendRequest('sharplsp/loadSolution', { solutionPath: path });
  } catch (err: unknown) {
    log.error(`sharplsp/loadSolution failed: ${getErrorMessage(err)}`);
  }
}
