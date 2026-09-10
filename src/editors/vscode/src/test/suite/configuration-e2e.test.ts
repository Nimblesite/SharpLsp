// Implements [CONFIG-EDITOR-BRIDGE] against the real LSP, without language sidecars.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LanguageClient } from 'vscode-languageclient/node';
import { sharedDebugConfiguration } from '../../debug-configuration';
import * as state from '../../state';
import { fakeFolder } from './run-debug-kit';
import { removeDirRecursive } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

suite('Editor bridge to shared configuration', () => {
  test('launch overrides merge on the server and file edits are read on the next resolution', async function () {
    this.timeout(DEBUG_TEST_MS);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-config-'));
    const folder = fakeFolder(root);
    const file = path.join(root, 'sharplsp.toml');
    const base = '[csharp]\nenabled = false\n[fsharp]\nenabled = false\n[debug.exceptions]\n';
    fs.writeFileSync(file, `${base}break_on = "all"\nignore = ["System.FormatException"]\n`);
    const binary =
      process.env['SHARPLSP_TEST_LSP'] ??
      path.resolve(
        __dirname,
        '../../../../../../target/debug',
        process.platform === 'win32' ? 'sharplsp.exe' : 'sharplsp',
      );
    const client = new LanguageClient(
      'configuration-test',
      'Configuration test',
      { command: binary, options: { cwd: root } },
      { documentSelector: [], workspaceFolder: folder },
    );
    const previous = state.client.value;
    try {
      await client.start();
      state.client.value = client;
      const config = {
        type: 'sharplsp-coreclr',
        request: 'attach',
        name: 'config test',
        exceptionPolicy: { ignore: [] },
      };
      assert.deepEqual((await sharedDebugConfiguration(folder, config)).exceptionPolicy, {
        break_on: 'all',
        ignore: [],
        external_code: 'throw-site',
      });
      fs.writeFileSync(
        file,
        `${base}break_on = "user-unhandled"\nexternal_code = "user-boundary"\n`,
      );
      const changed = await sharedDebugConfiguration(folder, config);
      assert.equal(changed.justMyCode, true);
      assert.equal(changed.exceptionPolicy?.external_code, 'user-boundary');
      assert.deepEqual(config.exceptionPolicy, { ignore: [] });
      fs.writeFileSync(file, `${base}break_on = "typo"\n`);
      await assert.rejects(
        sharedDebugConfiguration(folder, config),
        /invalid SharpLsp configuration/,
      );
    } finally {
      state.client.value = previous;
      await client.stop();
      removeDirRecursive(root);
    }
  });
});
