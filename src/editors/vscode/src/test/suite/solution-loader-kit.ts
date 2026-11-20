/**
 * One extension activation's solution loader over stand-ins for what outlives
 * it (workspace storage) and what it drives (the Solution Explorer), shared by
 * the suites that pin which solution an activation loads. [SE-SOLUTION]
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { SharpLspClient } from '../../client';
import { type SolutionLoader, solutionLoader } from '../../solution-load.js';
import type { SolutionExplorerProvider } from '../../tree.js';
import { fakeFolder } from './run-debug-kit';
import { findSharpLspBinary } from './test-helpers';

/** No compiler: a client that only answers which solution `sharplsp.toml` configures. */
export const NO_COMPILERS = '[fsharp]\nenabled = false\n[csharp]\nenabled = false\n';

/** A real server rooted at `root`, so `sharplsp/configuration` reads ITS `sharplsp.toml`. */
export function configurationClient(root: string): SharpLspClient {
  const binary = findSharpLspBinary();
  assert.ok(binary, 'Test host must resolve a staged sharplsp binary');
  const outputChannel = vscode.window.createOutputChannel('Solution test', { log: true });
  return new SharpLspClient(
    'solution-test',
    'Solution test',
    { command: binary, options: { cwd: root } },
    { documentSelector: [], workspaceFolder: fakeFolder(root), outputChannel },
  );
}

/** Workspace storage that outlives one activation, as `context.workspaceState` does. */
export class WorkspaceMemory implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  public keys(): readonly string[] {
    return [...this.values.keys()];
  }
  public get<T>(key: string, fallback?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }
  public update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

/**
 * One activation's loader, recording in `loaded` what it hands the Solution
 * Explorer and in `dismissed` each picker THIS loader showed and saw dismissed —
 * a count no other activation's picker (the live extension's own) can reach.
 */
export function activation(
  memory: vscode.Memento,
  loaded: string[],
  client?: LanguageClient,
  dismissed: unknown[] = [],
): SolutionLoader {
  const explorer = {
    loadSolution: (solutionPath: string) => {
      loaded.push(solutionPath);
      return Promise.resolve();
    },
    // A dismissed pick falls back to solution buttons in the tree; nothing loads.
    showSolutionPicker: (offered: unknown) => {
      dismissed.push(offered);
    },
  } as unknown as SolutionExplorerProvider;
  return solutionLoader({ client: () => client, explorer: () => explorer, memory });
}
