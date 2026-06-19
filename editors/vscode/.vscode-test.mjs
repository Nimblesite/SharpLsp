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
    exclude: ['**/dist/**', '**/node_modules/**', '**/.vscode-test/**'],
    reporter: ['text-summary', 'html', 'json-summary'],
  },
});
