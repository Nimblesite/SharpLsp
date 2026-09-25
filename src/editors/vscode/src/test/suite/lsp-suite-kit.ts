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
import { closeAllEditors, setupLspTestSuite, teardownLspTestSuite } from './test-helpers';
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
