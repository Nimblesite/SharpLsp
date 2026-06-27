import { defineConfig } from '@vscode/test-cli';
import os from 'node:os';
import path from 'node:path';

// Default the test host's --user-data-dir to a SHORT path under the OS temp
// dir, not the repo-relative `.vscode-test/`. VS Code's main IPC handle is a
// Unix domain socket (`<user-data-dir>/<v>-main.sock`); on macOS/Linux the
// `sun_path` limit is ~104 chars, so a deep checkout path (e.g.
// `~/Documents/Code/SharpLsp/editors/vscode/.vscode-test/...`) overflows it and
// the host dies at startup with `listen EINVAL` before any test runs. The OS
// temp dir keeps the socket path well under the limit (and Windows uses named
// pipes, so it's unaffected either way). Overridable via the env var.
const testUserDataDir =
  process.env.VSCODE_TEST_USER_DATA_DIR ?? path.join(os.tmpdir(), 'slsp-vsx', `u${process.pid}`);

export default defineConfig({
  tests: [
    {
      files: 'test-cli-runner.cjs',
      extensionDevelopmentPath: '.',
      workspaceFolder: 'test-fixtures/workspace',
      // The extension declares ms-dotnettools.vscode-dotnet-runtime as an
      // extensionDependency ([DIST-RUNTIME-ACQUIRE] / [SWR-IDE-DOTNET-RUNTIME]).
      // VS Code refuses to activate SharpLsp unless that dependency is installed
      // AND enabled in the test host. Installing it into the isolated test
      // extensions dir replaces the previous '--disable-extensions' flag, which
      // disabled the dependency and made activation fail with
      // "depends on unknown extension 'ms-dotnettools.vscode-dotnet-runtime'".
      installExtensions: ['ms-dotnettools.vscode-dotnet-runtime'],
      launchArgs: [
        `--user-data-dir=${testUserDataDir}`,
        ...(process.env.SHARPLSP_SCREENSHOTS ? ['--remote-debugging-port=9239'] : []),
      ],
    },
  ],
  coverage: {
    // NOTE: `dist/**` is deliberately NOT excluded. The extension runs from the
    // bundled `dist/extension.js` (package.json `main`), so the activation path
    // and every command callback exercised by the end-to-end interaction suites
    // execute there — not in the `out/` modules the unit tests import. The dev
    // bundle ships a source map (esbuild `sourcemap: !production`) that remaps
    // that execution back onto `src/*.ts`, so including it credits the real e2e
    // coverage that would otherwise be invisible. Bundled node_modules sources
    // are still dropped by the `node_modules` glob below.
    // `dist/**` is intentionally NOT excluded. The extension runs from the
    // bundled `dist/extension.js` (package.json `main`), so the activation path
    // and every command callback exercised by the end-to-end interaction suites
    // run there — not in the `out/` modules the unit tests import. The dev bundle
    // ships a source map (esbuild `sourcemap: !production`) AND externalizes
    // dependencies (`packages: 'external'` for non-production), so the only
    // sources it remaps onto are first-party `src/*.ts`. Including it credits the
    // real e2e coverage that is otherwise invisible. Dependencies are required at
    // runtime as separate files and dropped by the `node_modules` glob.
    exclude: ['**/node_modules/**', '**/.vscode-test/**'],
    reporter: ['text-summary', 'html', 'json-summary'],
  },
});
