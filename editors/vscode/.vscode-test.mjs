import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test-cli-runner.cjs',
  extensionDevelopmentPath: '.',
  workspaceFolder: 'test-fixtures/workspace',
  launchArgs: ['--disable-extensions'],
});
