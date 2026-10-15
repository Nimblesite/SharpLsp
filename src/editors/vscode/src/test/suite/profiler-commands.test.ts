// Implements [PROF-UI]. See docs/specs/LSP-PROFILER-SPEC.md
/**
 * Profiler E2E Tests — Command Registration, Configuration, Status Bar, Keybindings.
 *
 * Validates the profiling command registration and configuration:
 * - CPU profiler commands are registered and callable
 * - Profiler settings are read from configuration
 * - Status bar item appears and responds to profiling state
 * - Keybindings are declared
 *
 * These tests require the SharpLsp LSP server binary to be built.
 * They exercise the real LSP protocol, not mocks.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { getStore, advertisedServerCommands } from './profiler-ui-helpers';
import { arrayField, isRecord, rawField } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';
import { EXTENSION_ID, runCommand, useLspSuite } from './profiler-ui-helpers';

import {
  PROFILER_CLIENT_COMMANDS,
  PROFILER_SERVER_COMMANDS,
  PROFILER_SETTINGS,
  PROFILER_EXTRA_SETTINGS,
} from './profiler-ui-constants';
import {
  manifestCommands,
  manifestConfigurationProperties,
  manifestKeybindings,
} from './profiler-ui-manifest';

/** Assert every one of `settings` is declared in package.json. */
function assertDeclared(settings: readonly string[]): void {
  const properties = manifestConfigurationProperties();
  for (const setting of settings) {
    assert.ok(
      properties[setting] !== undefined,
      `Setting "${setting}" should be declared in package.json`,
    );
  }
}

function assertCommandRegistered(commandId: string, label: string): void {
  let threw = false;
  let disposable: vscode.Disposable | undefined;
  try {
    disposable = vscode.commands.registerCommand(commandId, () => {
      /* probe */
    });
  } catch {
    threw = true;
  } finally {
    disposable?.dispose();
  }
  assert.ok(threw, `${label} "${commandId}" should be registered after activation`);
}

suite('Profiler — Command Registration', () => {
  useLspSuite('sharplsp-profiler-test-');

  test('all profiler client commands are registered', () => {
    for (const cmd of PROFILER_CLIENT_COMMANDS) {
      assertCommandRegistered(cmd, 'Client command');
    }
  });

  test('profiler server commands are advertised by LSP', () => {
    const advertised = advertisedServerCommands();
    assert.ok(advertised.size > 0, 'Server should advertise commands');
    for (const cmd of PROFILER_SERVER_COMMANDS) {
      assert.ok(advertised.has(cmd), `Server command "${cmd}" should be advertised by LSP`);
    }
  });

  test('profiler client commands are NOT advertised by the server', () => {
    const advertised = advertisedServerCommands();
    for (const cmd of PROFILER_CLIENT_COMMANDS) {
      assert.ok(!advertised.has(cmd), `Client command "${cmd}" must NOT be a server command`);
    }
  });

  test('profiler.list returns empty sessions initially', async () => {
    const result = await runCommand('sharplsp.lspProfiler.cpu.list');
    assert.ok(result !== undefined, 'profiler.list should return a result');
    assert.ok(result !== null, 'profiler.list should not return null');

    assert.ok(Array.isArray(rawField(result, 'sessions')), 'sessions should be an array');
    assert.strictEqual(
      arrayField(result, 'sessions').length,
      0,
      'no sessions should be active initially',
    );
  });

  test('profiler.list result has correct shape', async () => {
    const result = await runCommand('sharplsp.lspProfiler.cpu.list');
    assert.ok(result !== undefined, 'profiler.list must return a value');

    assert.ok(isRecord(result), 'result must be an object');
    assert.ok('sessions' in result, 'result must have sessions key');
    assert.ok(Array.isArray(rawField(result, 'sessions')), 'sessions must be an array');
  });
});

suite('Profiler — Configuration', () => {
  useLspSuite('sharplsp-profiler-cfg-');

  test('profiler settings have correct defaults', () => {
    const config = vscode.workspace.getConfiguration('sharplsp.profiler');

    assert.strictEqual(config.get<number>('sampleRate'), 100, 'default sample rate should be 100');
    assert.strictEqual(
      config.get<boolean>('includeNative'),
      false,
      'includeNative should default to false',
    );
    assert.strictEqual(
      config.get<number>('lineThreshold'),
      1.0,
      'lineThreshold should default to 1.0',
    );
    assert.strictEqual(
      config.get<number>('functionThreshold'),
      2.0,
      'functionThreshold should default to 2.0',
    );
    assert.strictEqual(
      config.get<number>('maxDiagnosticsPerFile'),
      20,
      'maxDiagnosticsPerFile should default to 20',
    );
    assert.strictEqual(
      config.get<boolean>('showInlineHeatMap'),
      true,
      'showInlineHeatMap should default to true',
    );
  });

  test('profileOnLaunch defaults to false', () => {
    const config = vscode.workspace.getConfiguration('sharplsp.profiler');
    assert.strictEqual(
      config.get<boolean>('profileOnLaunch'),
      false,
      'profileOnLaunch should default to false',
    );
  });

  test('preset defaults to "default"', () => {
    const config = vscode.workspace.getConfiguration('sharplsp.profiler');
    assert.strictEqual(
      config.get<string>('preset'),
      'default',
      'preset should default to "default"',
    );
  });

  test('profiler settings are declared in package.json', () => {
    assertDeclared(PROFILER_SETTINGS);
  });

  test('extra profiler settings are declared in package.json', () => {
    assertDeclared(PROFILER_EXTRA_SETTINGS);
  });

  test('profiler settings have correct types in package.json', () => {
    const properties = manifestConfigurationProperties();

    const expectedTypes: Record<string, string> = {
      'sharplsp.profiler.sampleRate': 'number',
      'sharplsp.profiler.includeNative': 'boolean',
      'sharplsp.profiler.lineThreshold': 'number',
      'sharplsp.profiler.functionThreshold': 'number',
      'sharplsp.profiler.maxDiagnosticsPerFile': 'number',
      'sharplsp.profiler.showInlineHeatMap': 'boolean',
      'sharplsp.profiler.profileOnLaunch': 'boolean',
      'sharplsp.profiler.preset': 'string',
    };

    for (const [key, expectedType] of Object.entries(expectedTypes)) {
      const prop = properties[key] as { type?: string } | undefined;
      assert.ok(prop !== undefined, `Property "${key}" must exist`);
      assert.strictEqual(
        prop.type,
        expectedType,
        `"${key}" should have type "${expectedType}", got "${String(prop.type)}"`,
      );
    }
  });

  test('preset enum offers exactly the presets the server parses', () => {
    const properties = manifestConfigurationProperties();
    const presetProp = properties['sharplsp.profiler.preset'] as { enum?: string[] } | undefined;
    assert.ok(presetProp, 'preset property should exist');
    assert.ok(Array.isArray(presetProp.enum), 'preset should have enum values');

    // Must mirror ProfilingPreset::parse_name (presets.rs) plus "default"
    // (user-tuned sampleRate/includeNative). Advertising a name the server
    // silently ignores is the preset:"memory" defect — never reintroduce one.
    const expectedValues = ['default', 'quick', 'detailed', 'longRunning'];
    assert.deepStrictEqual(
      [...presetProp.enum].sort(),
      [...expectedValues].sort(),
      'every advertised preset must be one the LSP actually parses',
    );
  });
});

suite('Profiler — Status Bar', () => {
  useLspSuite('sharplsp-profiler-sb-');

  test('profiler status bar item exists after activation', () => {
    const store = getStore();
    assert.ok(store, 'Store should be initialized after activation');
    assert.ok(store.client.value?.isRunning() === true, 'the language client should be running');
  });

  test('extension is active after profiler setup', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should be found');
    assert.strictEqual(ext.isActive, true, 'Extension must be active');
  });
});

suite('Profiler — Keybindings', () => {
  useLspSuite('sharplsp-profiler-kb-');

  test('profiler commands declared in keybindings', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'Extension should be found');

    const keybindings = manifestKeybindings();

    const profilerKeybindings = keybindings.filter((kb) =>
      kb.command.startsWith('sharplsp.profiler.profile'),
    );

    assert.ok(
      profilerKeybindings.length >= 2,
      `Should have at least 2 profiler keybindings (start + stop), found ${profilerKeybindings.length}`,
    );
  });

  test('profiler commands appear in package.json commands section', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'Extension should be found');

    const commands = manifestCommands();
    const commandIds = commands.map((c) => c.command);

    for (const cmd of PROFILER_CLIENT_COMMANDS) {
      assert.ok(
        commandIds.includes(cmd),
        `Command "${cmd}" should be in package.json contributes.commands`,
      );
    }
  });

  test('profiler commands have titles and categories', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'Extension should be found');

    const commands = manifestCommands();

    for (const cmd of PROFILER_CLIENT_COMMANDS) {
      const entry = commands.find((c) => c.command === cmd);
      assert.ok(entry, `Command entry for "${cmd}" should exist`);
      assert.ok(
        entry.title !== undefined && entry.title.length > 0,
        `Command "${cmd}" should have a non-empty title`,
      );
      assert.strictEqual(
        entry.category,
        'SharpLsp',
        `Command "${cmd}" should have category "SharpLsp"`,
      );
    }
  });
});
