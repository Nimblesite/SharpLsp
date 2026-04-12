import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  openCSharpFile,
  setupLspTestSuite,
  teardownLspTestSuite,
  waitForDocumentSymbols,
} from './test-helpers';

suite('Extension Activation & Configuration', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('ext-');
    tmpDir = result.tmpDir;
  });

    suiteTeardown(async () => {
        await closeAllEditors();
        teardownLspTestSuite(tmpDir);
    });

    teardown(async () => {
        await closeAllEditors();
    });

    // ── Activation ───────────────────────────────────────────────

  test('extension is present in the extension list', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} should be installed`);
  });

  test('extension activates when a C# file is opened', async function () {
    this.timeout(30_000);
    const { doc } = await openCSharpFile(tmpDir, 'activation.cs', 'class Activation { }');
    assert.strictEqual(doc.languageId, 'csharp');

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    assert.ok(ext.isActive, 'Extension should be active after opening .cs');
  });

  test('extension activates when an F# file is opened', async function () {
    this.timeout(30_000);
    const { doc } = await openCSharpFile(tmpDir, 'activation.fs', 'module Activation\nlet x = 1\n');
    // The file was opened — extension should be active now.
    assert.ok(
      doc.languageId === 'fsharp' || doc.languageId === 'csharp',
      `Expected fsharp or csharp language, got ${doc.languageId}`,
    );

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension should be active after opening .fs');
  });

    // ── Commands ─────────────────────────────────────────────────

  test('forge.restartServer command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('forge.restartServer'),
      'forge.restartServer should be registered',
    );
  });

  test('forge.showOutput command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(allCommands.includes('forge.showOutput'), 'forge.showOutput should be registered');
  });

  test('forge.showTraceOutput command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('forge.showTraceOutput'),
      'forge.showTraceOutput should be registered',
    );
  });

    // ── Configuration ────────────────────────────────────────────

  test('forge.server.path setting is contributed', () => {
    const config = vscode.workspace.getConfiguration('forge');
    const inspect = config.inspect<string>('server.path');
    assert.ok(inspect, 'server.path setting should be inspectable');
    assert.strictEqual(inspect.defaultValue, '', 'Default server.path should be empty string');
  });

  test('forge.server.extraArgs setting is contributed', () => {
    const config = vscode.workspace.getConfiguration('forge');
    const inspect = config.inspect<string[]>('server.extraArgs');
    assert.ok(inspect, 'server.extraArgs setting should be inspectable');
    assert.deepStrictEqual(inspect.defaultValue, [], 'Default extraArgs should be empty array');
  });

  test('forge.trace.server setting is contributed', () => {
    const config = vscode.workspace.getConfiguration('forge');
    const inspect = config.inspect<string>('trace.server');
    assert.ok(inspect, 'trace.server setting should be inspectable');
    assert.strictEqual(inspect.defaultValue, 'off', 'Default trace level should be off');
  });

  test('forge.logging.level setting is contributed', () => {
    const config = vscode.workspace.getConfiguration('forge');
    const inspect = config.inspect<string>('logging.level');
    assert.ok(inspect, 'logging.level setting should be inspectable');
    assert.strictEqual(inspect.defaultValue, 'info', 'Default logging level should be info');
  });

    // ── Package Metadata ─────────────────────────────────────────

  test('extension has correct display name', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    assert.strictEqual(ext.packageJSON.displayName, 'Forge', "Display name should be 'Forge'");
  });

  test('extension contributes csharp language', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string }[] = ext.packageJSON.contributes?.languages ?? [];
    const csharp = languages.find((l) => l.id === 'csharp');
    assert.ok(csharp, 'Should contribute csharp language');
  });

  test('extension contributes fsharp language', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string }[] = ext.packageJSON.contributes?.languages ?? [];
    const fsharp = languages.find((l) => l.id === 'fsharp');
    assert.ok(fsharp, 'Should contribute fsharp language');
  });

    // ── Command Handler Invocation ─────────────────────────────

  test('forge.showOutput executes without error', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.showOutput');
    }, 'showOutput command should not throw');
  });

  test('forge.showTraceOutput executes without error', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.showTraceOutput');
    }, 'showTraceOutput command should not throw');
  });

  test('forge.restartServer executes without error', async function () {
    this.timeout(60_000);
    // Ensure server is running first.
    const { uri } = await openCSharpFile(tmpDir, 'pre-restart.cs', 'class PreRestart { }');
    await waitForDocumentSymbols(uri);

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.restartServer');
    }, 'restartServer command should not throw');

    // Verify server is back.
    const symbols = await waitForDocumentSymbols(uri, 30_000);
    assert.ok(symbols.length > 0, 'Server should respond after restart');
  });

    // ── C# Language Configuration ──────────────────────────────

  test('csharp language contributes .cs extension', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string; extensions?: string[] }[] =
      ext.packageJSON.contributes?.languages ?? [];
    const csharp = languages.find((l) => l.id === 'csharp');
    assert.ok(csharp, 'Should contribute csharp language');
    assert.ok(csharp.extensions?.includes('.cs'), 'csharp should include .cs extension');
  });

  test('csharp language contributes .csx extension', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string; extensions?: string[] }[] =
      ext.packageJSON.contributes?.languages ?? [];
    const csharp = languages.find((l) => l.id === 'csharp');
    assert.ok(csharp);
    assert.ok(csharp.extensions?.includes('.csx'), 'csharp should include .csx extension');
  });

    // ── F# Language Configuration ──────────────────────────────

  test('fsharp language contributes .fs extension', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string; extensions?: string[] }[] =
      ext.packageJSON.contributes?.languages ?? [];
    const fsharp = languages.find((l) => l.id === 'fsharp');
    assert.ok(fsharp);
    assert.ok(fsharp.extensions?.includes('.fs'), 'fsharp should include .fs extension');
  });

  test('fsharp language contributes .fsx extension', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string; extensions?: string[] }[] =
      ext.packageJSON.contributes?.languages ?? [];
    const fsharp = languages.find((l) => l.id === 'fsharp');
    assert.ok(fsharp);
    assert.ok(fsharp.extensions?.includes('.fsx'), 'fsharp should include .fsx extension');
  });

  test('fsharp language contributes .fsi extension', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string; extensions?: string[] }[] =
      ext.packageJSON.contributes?.languages ?? [];
    const fsharp = languages.find((l) => l.id === 'fsharp');
    assert.ok(fsharp);
    assert.ok(fsharp.extensions?.includes('.fsi'), 'fsharp should include .fsi extension');
  });

    // ── Package Metadata Extras ────────────────────────────────

  test('extension has MIT license', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    assert.strictEqual(ext.packageJSON.license, 'MIT');
  });

  test('extension has version string', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    assert.ok(typeof ext.packageJSON.version === 'string', 'version must be a string');
    assert.match(ext.packageJSON.version, /^\d+\.\d+\.\d+/);
  });

  test('extension contributes 8 commands', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const cmds: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.strictEqual(cmds.length, 8, 'Should contribute exactly 8 commands');
    const ids = cmds.map((c) => c.command);
    assert.ok(ids.includes('forge.restartServer'));
    assert.ok(ids.includes('forge.showOutput'));
    assert.ok(ids.includes('forge.showTraceOutput'));
    assert.ok(ids.includes('forge.selectSolution'));
    assert.ok(ids.includes('forge.refreshExplorer'));
    assert.ok(ids.includes('forge.sortNatural'));
    assert.ok(ids.includes('forge.sortAlphabetical'));
    assert.ok(ids.includes('forge.sortAccessibility'));
  });

  test('extension contributes 4 configuration properties', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const props = ext.packageJSON.contributes?.configuration?.properties ?? {};
    const keys = Object.keys(props);
    assert.strictEqual(
      keys.length,
      4,
      `Expected 4 config properties, got ${keys.length}: ${keys.join(', ')}`,
    );
    assert.ok(keys.includes('forge.server.path'));
    assert.ok(keys.includes('forge.server.extraArgs'));
    assert.ok(keys.includes('forge.trace.server'));
    assert.ok(keys.includes('forge.logging.level'));
  });

  test('extension contributes exactly 2 languages', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const languages: { id: string }[] = ext.packageJSON.contributes?.languages ?? [];
    assert.strictEqual(languages.length, 2);
    const ids = languages.map((l) => l.id);
    assert.deepStrictEqual(ids.sort(), ['csharp', 'fsharp']);
  });

  test('extension has language configuration files', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const languages: { id: string; configuration?: string }[] =
      ext.packageJSON.contributes?.languages ?? [];
    for (const lang of languages) {
      assert.ok(lang.configuration, `Language ${lang.id} must have a configuration file`);
      assert.ok(
        lang.configuration.includes('language-configuration/'),
        `Configuration path should be in language-configuration/`,
      );
    }
  });

  test("all commands have a category of 'Forge'", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const cmds: { command: string; category?: string }[] =
      ext.packageJSON.contributes?.commands ?? [];
    for (const cmd of cmds) {
      assert.strictEqual(
        cmd.category,
        'Forge',
        `Command ${cmd.command} should have category 'Forge'`,
      );
    }
  });

  test('all commands have a title', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const cmds: { command: string; title?: string }[] = ext.packageJSON.contributes?.commands ?? [];
    for (const cmd of cmds) {
      assert.ok(
        cmd.title && cmd.title.length > 0,
        `Command ${cmd.command} must have a non-empty title`,
      );
    }
  });

    // ── Activation Events ──────────────────────────────────────

  test('extension has workspaceContains activation events', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const events: string[] = ext.packageJSON.activationEvents ?? [];
    assert.ok(
      events.some((e: string) => e.includes('*.sln')),
      'Should activate on .sln files',
    );
    assert.ok(
      events.some((e: string) => e.includes('*.csproj')),
      'Should activate on .csproj files',
    );
    assert.ok(
      events.some((e: string) => e.includes('*.fsproj')),
      'Should activate on .fsproj files',
    );
  });
});
