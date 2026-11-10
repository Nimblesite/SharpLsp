// The Mocha lifecycle every LSP suite repeats, in one place.
//
// One scratch directory and one activated, answering server for the whole
// suite; every editor closed after each test so a document one test opened is
// never the "active editor" another test reads. `setupLspTestSuite` owns the
// readiness probe and its budget ([DIST-CI-VSIX-SHARDS-TIMEOUTS]); this owns
// only the hooks around it.
//
// Mirrors `useDebuggee` in `debug-suite-kit`: the returned accessor is the
// suite's scratch directory, valid from `suiteSetup` onwards.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  removeDirRecursive,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { ACTIVATION_MS } from './test-timeouts';

/** Activate the server once for the suite; hand back its scratch directory. */
export function useLspTestSuite(tmpDirPrefix: string): () => string {
  let tmpDir: string | undefined;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    ({ tmpDir } = await setupLspTestSuite(tmpDirPrefix));
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    if (tmpDir !== undefined) teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  return () => {
    assert.ok(tmpDir, 'the suite scratch directory must be created in suiteSetup');
    return tmpDir;
  };
}

/** Close every editor after each test and after the last one. */
export function closeEditorsBetweenTests(): void {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);
}

/** The text a hint renders: its label, joining the parts VS Code splits it into. */
export function inlayHintLabel(hint: vscode.InlayHint): string {
  if (typeof hint.label === 'string') {
    return hint.label;
  }
  return hint.label.map((part) => part.value).join('');
}

/**
 * Write the `<project>Domain.fs` and `<project>Main.fs` module stubs into `dir`.
 *
 * The F# fixture both Solution Explorer suites build: two `let` bindings whose
 * names the tree and FCS report, with `mainBody` carrying the second one.
 */
export function writeFSharpModuleSources(dir: string, project: string, mainBody: string): void {
  fs.writeFileSync(
    path.join(dir, `${project}Domain.fs`),
    `module ${project}Domain\n\nlet answer = 42\n`,
  );
  fs.writeFileSync(path.join(dir, `${project}Main.fs`), `module ${project}Main\n\n${mainBody}`);
}

/** Whether a failing teardown cleanup may fail the test that just ran. */
export type CleanupTolerance = 'best-effort' | 'strict';

/** What a Solution Explorer suite's teardown undoes beyond editors and stubs. */
export interface ExplorerSuiteOptions {
  /** How a failing solution reset or artifact removal is treated. */
  readonly cleanup: CleanupTolerance;
  /** Reset the live Solution Explorer state the suite's tests mutated. */
  readonly reset: () => void;
}

/** The UI stubs and the written artifacts of the test currently running. */
export interface ExplorerSuiteState {
  readonly stubs: UiStubs;
  readonly created: string[];
}

/**
 * Activate the server for the suite and hand back its per-test UI stubs and
 * artifact list, both discarded after each test.
 */
export function useExplorerSuite(
  tmpDirPrefix: string,
  options: ExplorerSuiteOptions,
): () => ExplorerSuiteState {
  let current: ExplorerSuiteState | undefined;
  useLspTestSuite(tmpDirPrefix);
  setup(() => {
    current = { stubs: installUiStubs(), created: [] };
  });
  teardown(async () => {
    const state = suiteStateOf(current);
    current = undefined;
    state.stubs.restore();
    await closeAllEditors();
    resetExplorer(options, state);
  });
  return () => suiteStateOf(current);
}

/** The live suite state, failing loudly when read outside a test. */
function suiteStateOf(state: ExplorerSuiteState | undefined): ExplorerSuiteState {
  assert.ok(state, 'the suite state must be created in setup');
  return state;
}

/** Reset the tree and remove every artifact the test wrote, as strictly as asked. */
function resetExplorer(options: ExplorerSuiteOptions, state: ExplorerSuiteState): void {
  ifTolerated(options.cleanup, options.reset);
  for (const artifact of state.created) {
    ifTolerated(options.cleanup, () => {
      removeDirRecursive(artifact);
    });
  }
}

/** Run `action`, ignoring a failure when the suite tolerates one. */
function ifTolerated(cleanup: CleanupTolerance, action: () => void): void {
  if (cleanup === 'strict') {
    action();
    return;
  }
  try {
    action();
  } catch {
    // A stray artifact never fails the test that wrote it.
  }
}
