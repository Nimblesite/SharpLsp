import { defineConfig } from '@vscode/test-cli';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Default the test host's --user-data-dir to a SHORT path under the OS temp
// dir, not the repo-relative `.vscode-test/`. VS Code's main IPC handle is a
// Unix domain socket (`<user-data-dir>/<v>-main.sock`); on macOS/Linux the
// `sun_path` limit is ~104 chars, so a deep checkout path (e.g.
// `~/Documents/Code/SharpLsp/src/editors/vscode/.vscode-test/...`) overflows it and
// the host dies at startup with `listen EINVAL` before any test runs. The OS
// temp dir keeps the socket path well under the limit (and Windows uses named
// pipes, so it's unaffected either way). `mkdtemp` makes it fresh and private,
// so no other user can plant its settings. Overridable via the env var.
function userDataDir(suffix) {
  const chosen = process.env.VSCODE_TEST_USER_DATA_DIR;
  return chosen ? `${chosen}${suffix}` : fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-u'));
}

/** The directory of the suites that need a MULTI-ROOT workspace ([DIST-CI-VSIX-SHARDS]). */
const MULTI_ROOT_SUITES = 'multiroot/';

/**
 * True when this run selects a multi-root suite: no `MOCHA_FILES` means every
 * suite, and a chunk naming none of them must not pay a second editor start.
 */
function wantsMultiRoot() {
  const requested = process.env.MOCHA_FILES?.trim();
  if (!requested) return true;
  return requested.split(',').some((glob) => glob.trim().startsWith(MULTI_ROOT_SUITES));
}

/**
 * A fresh two-folder workspace for the multi-root suites: `vstest` and `mtp`.
 *
 * Only a workspace OPENED with two folders has two: adding the second folder
 * from inside the test host turns the window into a workspace, and VS Code
 * restarts the extension host — the one running the suite — to do it. So the
 * folders exist before the editor starts, and the suite writes its projects
 * into them. They live under the canonical temp root, the spelling every
 * `dotnet` child reports back ([DIST-CI-WIN-VSIX]).
 */
function multiRootWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'slsp-mr-'));
  for (const folder of ['vstest', 'mtp']) fs.mkdirSync(path.join(root, folder));
  const file = path.join(root, 'mixed-runners.code-workspace');
  const workspace = { folders: [{ path: 'vstest' }, { path: 'mtp' }], settings: {} };
  fs.writeFileSync(file, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * User settings for a test host. VS Code's built-in chat adds its own code
 * actions ("Fix", "Explain", "Modify") once a diagnostic lands, so with AI on a
 * suite's lightbulb list depends on when diagnostics arrive, not on SharpLsp.
 */
function writeUserSettings(userDataDir) {
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  const settings = { 'chat.disableAIFeatures': true };
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify(settings));
}

/** One editor start: the same extension and dependency, its own workspace shape. */
function testConfig(label, workspaceFolder, userDataDir) {
  writeUserSettings(userDataDir);
  return {
    label,
    // Explicit minimum-editor runs verify [DIST-VSIX-MODEL].
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    files: 'test-cli-runner.cjs',
    extensionDevelopmentPath: '.',
    workspaceFolder,
    // Read by src/test/suite/index.ts, which runs only the suites of this shape.
    env: { SHARPLSP_WORKSPACE_SHAPE: label },
    // The extension declares ms-dotnettools.vscode-dotnet-runtime as an
    // extensionDependency ([DIST-RUNTIME-ACQUIRE]).
    // VS Code refuses to activate SharpLsp unless that dependency is installed
    // AND enabled in the test host. Installing it into the isolated test
    // extensions dir replaces the previous '--disable-extensions' flag, which
    // disabled the dependency and made activation fail with
    // "depends on unknown extension 'ms-dotnettools.vscode-dotnet-runtime'".
    installExtensions: ['ms-dotnettools.vscode-dotnet-runtime'],
    launchArgs: [
      `--user-data-dir=${userDataDir}`,
      ...(process.env.SHARPLSP_SCREENSHOTS ? ['--remote-debugging-port=9239'] : []),
    ],
  };
}

export default defineConfig({
  // Both editor starts write into ONE coverage directory, so a run that needs
  // the multi-root shape still produces one tracefile.
  tests: [
    testConfig('folder', 'test-fixtures/workspace', userDataDir('')),
    ...(wantsMultiRoot()
      ? [testConfig('multiroot', multiRootWorkspace(), userDataDir('-mr'))]
      : []),
  ],
  coverage: {
    // `dist/**` is deliberately NOT excluded. The extension runs from the
    // bundled `dist/extension.js` (package.json `main`), so the activation path
    // and every command callback exercised by the end-to-end interaction suites
    // run there -- not in the `out/` modules the unit tests import. That is the
    // development bundle, whose source map covers only first-party sources: it
    // leaves node_modules external. The report step still filters remapped
    // dependencies, because test-cli applies these globs before remapping.
    exclude: ['**/node_modules/**', '**/.vscode-test/**'],
    // `lcov` is what makes SHARDING possible ([DIST-CI-VSIX-SHARDS]): CI runs one
    // chunk of the suite per job, and tools/coverage/merge-lcov.mjs union-merges
    // the per-shard tracefiles before the single ratcheted gate reads the total.
    // `json-summary` still feeds the unsharded local `make test` gate.
    //
    // `includeAll` is deliberately left off. Every shard instruments the same
    // bundle, so a file loaded by ANY shard contributes its whole line set to the
    // union (unexecuted lines included, as `DA:<line>,0`) — which reproduces
    // exactly the file set and line set of one unsharded run, and so the same
    // percentage. Turning `includeAll` on would change the denominator and
    // silently move the ratchet.
    // Generate the remapped map once. report-vsix-coverage.mjs applies vendor
    // exclusions AFTER remapping, then emits the normal reports and lcov.
    reporter: ['json'],
  },
});
