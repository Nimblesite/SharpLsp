// Implements [CONFIG-EDITOR-BRIDGE] against the real LSP, without language sidecars.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LanguageClient } from 'vscode-languageclient/node';
import { sharedDebugConfiguration } from '../../debug-configuration';
import * as state from '../../state';
import { authoredConfigurationAttributes, fakeFolder } from './run-debug-kit';
import { assertSchemaProperty, ATTACH_SCHEMA, LAUNCH_SCHEMA } from './run-debug-manifest-kit';
import { removeDirRecursive } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

suite('Editor bridge to shared configuration', () => {
  test('launch and attach exception options inherit shared TOML settings', () => {
    const schemas = authoredConfigurationAttributes();
    for (const [kind, expected] of [
      ['launch', LAUNCH_SCHEMA],
      ['attach', ATTACH_SCHEMA],
    ] as const) {
      const properties = schemas[kind].properties;
      assert.deepEqual(Object.keys(properties).sort(), expected);
      assertSchemaProperty(properties, 'exceptionPolicy', 'object');
      const policy = properties.exceptionPolicy;
      assert.equal(policy.additionalProperties, false);
      assert.deepEqual(Object.keys(policy.properties).sort(), [
        'break_on',
        'external_code',
        'ignore',
        'just_my_code',
      ]);
      assertSchemaProperty(policy.properties, 'just_my_code', 'boolean');
      assert.equal(policy.properties.just_my_code.default, undefined, 'inherit TOML');
      assertSchemaProperty(policy.properties, 'ignore', 'array');
      assert.equal(policy.properties.ignore.items.type, 'string');
    }
  });

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
        just_my_code: true,
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
      const allCode = await sharedDebugConfiguration(folder, {
        ...config,
        exceptionPolicy: { just_my_code: false },
      });
      assert.equal(allCode.exceptionPolicy?.just_my_code, false);
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
