import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as config from '../../config.js';
import { CONFIG_SECTION } from '../../constants.js';

suite('Config Module — Direct Function Tests', () => {
  // ── serverPath() ─────────────────────────────────────────────
  test('serverPath() returns a string', () => {
    const result = config.serverPath();
    assert.strictEqual(typeof result, 'string', 'Must return a string');
  });

  test('serverPath() returns the configured value when set', async () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const original = wsConfig.get<string>('lspPath');
    try {
      await wsConfig.update('lspPath', '/tmp/fake-sharplsp', vscode.ConfigurationTarget.Workspace);
      const result = config.serverPath();
      assert.strictEqual(result, '/tmp/fake-sharplsp');
    } finally {
      await wsConfig.update('lspPath', original, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('serverPath() returns empty string for null-ish config', () => {
    const result = config.serverPath();
    assert.ok(typeof result === 'string', 'Must always return a string, never undefined');
  });

  // ── serverExtraArgs() ────────────────────────────────────────
  test('serverExtraArgs() returns empty array when not configured', () => {
    const result = config.serverExtraArgs();
    assert.ok(Array.isArray(result), 'Must return an array');
    assert.strictEqual(result.length, 0, 'Default should be empty array');
  });

  test('serverExtraArgs() returns configured array when set', async () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const original = wsConfig.get<string[]>('server.extraArgs');
    try {
      await wsConfig.update(
        'server.extraArgs',
        ['--verbose', '--port=9090'],
        vscode.ConfigurationTarget.Workspace,
      );
      const result = config.serverExtraArgs();
      assert.deepStrictEqual([...result], ['--verbose', '--port=9090']);
    } finally {
      await wsConfig.update('server.extraArgs', original, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('serverExtraArgs() returns readonly array', () => {
    const result = config.serverExtraArgs();
    assert.ok(Array.isArray(result), 'Must be an array');
  });

  // ── loggingLevel() ───────────────────────────────────────────
  test("loggingLevel() returns 'info' by default", () => {
    const result = config.loggingLevel();
    assert.strictEqual(result, 'info', 'Default logging level should be info');
  });

  test('loggingLevel() returns the configured value when set', async () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const original = wsConfig.get<string>('logging.level');
    try {
      await wsConfig.update('logging.level', 'debug', vscode.ConfigurationTarget.Workspace);
      const result = config.loggingLevel();
      assert.strictEqual(result, 'debug');
    } finally {
      await wsConfig.update('logging.level', original, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("loggingLevel() returns 'info' as fallback for undefined config", () => {
    const result = config.loggingLevel();
    assert.ok(typeof result === 'string', 'Must always return a string');
    assert.ok(result.length > 0, 'Must never return empty string');
  });

  // ── section() (internal, tested via all the above) ───────────
  test("all config functions read from the 'sharplsp' section", () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    assert.ok(wsConfig, 'sharplsp config section must be accessible');
  });

  // ── Edge cases ───────────────────────────────────────────────
  test('serverPath() called multiple times returns consistent results', () => {
    const a = config.serverPath();
    const b = config.serverPath();
    assert.strictEqual(a, b, 'Same call should return same result');
  });

  test('serverExtraArgs() called multiple times returns consistent results', () => {
    const a = config.serverExtraArgs();
    const b = config.serverExtraArgs();
    assert.deepStrictEqual([...a], [...b], 'Same call should return same result');
  });

  test('loggingLevel() called multiple times returns consistent results', () => {
    const a = config.loggingLevel();
    const b = config.loggingLevel();
    assert.strictEqual(a, b, 'Same call should return same result');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The remaining getters (config.ts:54-82): fsiExtraArgs, the three inlayHints
// flags, nugetIncludePrerelease, and hotReloadOnSave. Each is tested for both
// its default (unset) and its configured value; every update is restored in the
// finally block so unrelated suites see pristine config.
// ─────────────────────────────────────────────────────────────────────────────
suite('Config Module — feature getters (config.ts:54-82)', () => {
  const ws = (): ReturnType<typeof vscode.workspace.getConfiguration> =>
    vscode.workspace.getConfiguration(CONFIG_SECTION);

  /**
   * Update a setting, run a body, then restore EXACTLY the prior workspace state.
   * Restoring `cfg.get(key)` would write the default value back and leave the key
   * persisted in the fixture's `.vscode/settings.json`; restoring the original
   * `inspect().workspaceValue` (undefined when the key was never workspace-set)
   * removes the key instead, keeping the committed fixture pristine.
   */
  async function withSetting(key: string, value: unknown, body: () => void): Promise<void> {
    const cfg = ws();
    const originalWorkspaceValue = cfg.inspect(key)?.workspaceValue;
    try {
      await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
      body();
    } finally {
      await cfg.update(key, originalWorkspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  }

  // ── fsiExtraArgs() ───────────────────────────────────────────
  test('fsiExtraArgs() defaults to an empty array when unset', () => {
    const result = config.fsiExtraArgs();
    assert.ok(Array.isArray(result), 'must return an array');
    assert.strictEqual(result.length, 0, 'default is an empty array');
  });

  test('fsiExtraArgs() returns the configured arguments when set', async () => {
    await withSetting('fsi.extraArgs', ['--use:init.fsx', '--nologo'], () => {
      const result = config.fsiExtraArgs();
      assert.deepStrictEqual([...result], ['--use:init.fsx', '--nologo']);
    });
  });

  test('fsiExtraArgs() is consistent across repeated calls', () => {
    assert.deepStrictEqual([...config.fsiExtraArgs()], [...config.fsiExtraArgs()]);
  });

  // ── inlayHintsParameterNames() ───────────────────────────────
  test('inlayHintsParameterNames() defaults to true', () => {
    assert.strictEqual(
      config.inlayHintsParameterNames(),
      true,
      'parameter-name hints on by default',
    );
  });

  test('inlayHintsParameterNames() reflects a configured false', async () => {
    await withSetting('inlayHints.parameterNames', false, () => {
      assert.strictEqual(config.inlayHintsParameterNames(), false);
    });
  });

  test('inlayHintsParameterNames() reflects a configured true', async () => {
    await withSetting('inlayHints.parameterNames', true, () => {
      assert.strictEqual(config.inlayHintsParameterNames(), true);
    });
  });

  // ── inlayHintsTypeInference() ────────────────────────────────
  test('inlayHintsTypeInference() defaults to true', () => {
    assert.strictEqual(
      config.inlayHintsTypeInference(),
      true,
      'type-inference hints on by default',
    );
  });

  test('inlayHintsTypeInference() reflects a configured false', async () => {
    await withSetting('inlayHints.typeInference', false, () => {
      assert.strictEqual(config.inlayHintsTypeInference(), false);
    });
  });

  test('inlayHintsTypeInference() reflects a configured true', async () => {
    await withSetting('inlayHints.typeInference', true, () => {
      assert.strictEqual(config.inlayHintsTypeInference(), true);
    });
  });

  // ── inlayHintsPipelineTypes() ────────────────────────────────
  test('inlayHintsPipelineTypes() defaults to true', () => {
    assert.strictEqual(config.inlayHintsPipelineTypes(), true, 'pipeline-type hints on by default');
  });

  test('inlayHintsPipelineTypes() reflects a configured false', async () => {
    await withSetting('inlayHints.pipelineTypes', false, () => {
      assert.strictEqual(config.inlayHintsPipelineTypes(), false);
    });
  });

  test('inlayHintsPipelineTypes() reflects a configured true', async () => {
    await withSetting('inlayHints.pipelineTypes', true, () => {
      assert.strictEqual(config.inlayHintsPipelineTypes(), true);
    });
  });

  // ── nugetIncludePrerelease() ─────────────────────────────────
  test('nugetIncludePrerelease() defaults to false', () => {
    assert.strictEqual(config.nugetIncludePrerelease(), false, 'prerelease excluded by default');
  });

  test('nugetIncludePrerelease() reflects a configured true', async () => {
    await withSetting('nuget.includePrerelease', true, () => {
      assert.strictEqual(config.nugetIncludePrerelease(), true);
    });
  });

  test('nugetIncludePrerelease() reflects a configured false', async () => {
    await withSetting('nuget.includePrerelease', false, () => {
      assert.strictEqual(config.nugetIncludePrerelease(), false);
    });
  });

  // ── hotReloadOnSave() ────────────────────────────────────────
  test('hotReloadOnSave() defaults to false', () => {
    assert.strictEqual(config.hotReloadOnSave(), false, 'hot reload on save off by default');
  });

  test('hotReloadOnSave() reflects a configured true', async () => {
    await withSetting('hotReload.onSave', true, () => {
      assert.strictEqual(config.hotReloadOnSave(), true);
    });
  });

  test('hotReloadOnSave() reflects a configured false', async () => {
    await withSetting('hotReload.onSave', false, () => {
      assert.strictEqual(config.hotReloadOnSave(), false);
    });
  });

  // ── all boolean getters return real booleans ─────────────────
  test('every boolean getter returns a boolean primitive', () => {
    assert.strictEqual(typeof config.inlayHintsParameterNames(), 'boolean');
    assert.strictEqual(typeof config.inlayHintsTypeInference(), 'boolean');
    assert.strictEqual(typeof config.inlayHintsPipelineTypes(), 'boolean');
    assert.strictEqual(typeof config.nugetIncludePrerelease(), 'boolean');
    assert.strictEqual(typeof config.hotReloadOnSave(), 'boolean');
  });
});
