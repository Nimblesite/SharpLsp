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
      launchArgs: [
        '--disable-extensions',
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
