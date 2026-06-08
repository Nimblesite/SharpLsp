import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = fileURLToPath(new URL('.', import.meta.url));
const testUserDataDir =
  process.env.VSCODE_TEST_USER_DATA_DIR ??
  path.join(configDir, '.vscode-test', `user-data-${process.pid}`);

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
