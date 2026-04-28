import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  openCSharpFile,
  openSharpLspPanel,
  setupLspTestSuite,
  takeScreenshot,
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

  test('sharplsp.restartServer command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('sharplsp.restartServer'),
      'sharplsp.restartServer should be registered',
    );
  });

  test('sharplsp.showOutput command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(allCommands.includes('sharplsp.showOutput'), 'sharplsp.showOutput should be registered');
  });

  test('sharplsp.showTraceOutput command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('sharplsp.showTraceOutput'),
      'sharplsp.showTraceOutput should be registered',
    );
  });

  // ── Configuration ────────────────────────────────────────────

  test('sharplsp.server.path setting is contributed', async function () {
    this.timeout(15_000);
    const config = vscode.workspace.getConfiguration('sharplsp');
    const inspect = config.inspect<string>('server.path');
    assert.ok(inspect, 'server.path setting should be inspectable');
    assert.strictEqual(inspect.defaultValue, '', 'Default server.path should be empty string');
    // Open Settings UI filtered to sharplsp so the screenshot shows real config options.
    await vscode.commands.executeCommand('workbench.action.openSettings', 'sharplsp');
    await new Promise((r) => setTimeout(r, 1500));
    await takeScreenshot('vscode-configuration-page.png');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('sharplsp.server.extraArgs setting is contributed', () => {
    const config = vscode.workspace.getConfiguration('sharplsp');
    const inspect = config.inspect<string[]>('server.extraArgs');
    assert.ok(inspect, 'server.extraArgs setting should be inspectable');
    assert.deepStrictEqual(inspect.defaultValue, [], 'Default extraArgs should be empty array');
  });

  test('sharplsp.trace.server setting is contributed', () => {
    const config = vscode.workspace.getConfiguration('sharplsp');
    const inspect = config.inspect<string>('trace.server');
    assert.ok(inspect, 'trace.server setting should be inspectable');
    assert.strictEqual(inspect.defaultValue, 'off', 'Default trace level should be off');
  });

  test('sharplsp.logging.level setting is contributed', () => {
    const config = vscode.workspace.getConfiguration('sharplsp');
    const inspect = config.inspect<string>('logging.level');
    assert.ok(inspect, 'logging.level setting should be inspectable');
    assert.strictEqual(inspect.defaultValue, 'info', 'Default logging level should be info');
  });

  // ── Package Metadata ─────────────────────────────────────────

  test('extension has correct display name', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    assert.strictEqual(ext.packageJSON.displayName, 'SharpLsp', "Display name should be 'SharpLsp'");
  });

  test('extension contributes csharp language', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string }[] = ext.packageJSON.contributes?.languages ?? [];
    const csharp = languages.find((l) => l.id === 'csharp');
    assert.ok(csharp, 'Should contribute csharp language');
    // Open a C# file and an F# file in split editor, with SharpLsp panel showing solution.
    const { uri: csUri } = await openCSharpFile(tmpDir, 'editors-shot.cs', `namespace Demo\n{\n    public class Calculator\n    {\n        public int Add(int a, int b) => a + b;\n    }\n}`);
    await waitForDocumentSymbols(csUri);
    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await openCSharpFile(tmpDir, 'editors-shot.fs', 'module Demo\n\nlet greet name = sprintf "Hello, %s!" name\n');
    await new Promise((r) => setTimeout(r, 800));
    // Load fixture solution so Solution Explorer shows content.
    if (process.env['SHARPLSP_SCREENSHOTS']) {
      const api2 = ext.exports as { explorerProvider?: { loadSolution(p: string): Promise<void>; getChildren(e?: unknown): unknown[] | undefined } } | undefined;
      if (api2?.explorerProvider) {
        const ws2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        await api2.explorerProvider.loadSolution(`${ws2}/TestFixtures.sln`);
        let w = 0;
        while ((api2.explorerProvider.getChildren() ?? []).length === 0 && w < 8000) {
          await new Promise((r) => setTimeout(r, 200)); w += 200;
        }
      }
    }
    await openSharpLspPanel();
    await takeScreenshot('vscode-editors-page.png');
  });

  test('extension contributes fsharp language', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const languages: { id: string }[] = ext.packageJSON.contributes?.languages ?? [];
    const fsharp = languages.find((l) => l.id === 'fsharp');
    assert.ok(fsharp, 'Should contribute fsharp language');
  });

  // ── Command Handler Invocation ─────────────────────────────

  test('sharplsp.showOutput executes without error', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.showOutput');
    }, 'showOutput command should not throw');
  });

  test('sharplsp.showTraceOutput executes without error', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.showTraceOutput');
    }, 'showTraceOutput command should not throw');
  });

  test('sharplsp.restartServer executes without error', async function () {
    this.timeout(60_000);
    // Ensure server is running first.
    const { uri } = await openCSharpFile(tmpDir, 'pre-restart.cs', 'class PreRestart { }');
    await waitForDocumentSymbols(uri);

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.restartServer');
    }, 'restartServer command should not throw');

    // Verify server is back.
    const symbols = await waitForDocumentSymbols(uri, 30_000);
    assert.ok(symbols.length > 0, 'Server should respond after restart');

    // Open Calculator.cs from the fixture workspace so a real file is visible.
    if (process.env['SHARPLSP_SCREENSHOTS']) {
      const ext2 = vscode.extensions.getExtension(EXTENSION_ID);
      const api2 = ext2?.exports as { explorerProvider?: { loadSolution(p: string): Promise<void>; getChildren(e?: unknown): unknown[] | undefined } } | undefined;
      const ws2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const calcUri = vscode.Uri.file(`${ws2}/Calculator.cs`);
      const calcDoc = await vscode.workspace.openTextDocument(calcUri);
      await vscode.window.showTextDocument(calcDoc, { preview: false });
      await waitForDocumentSymbols(calcUri);
      if (api2?.explorerProvider) {
        await api2.explorerProvider.loadSolution(`${ws2}/TestFixtures.sln`);
        let w = 0;
        while ((api2.explorerProvider.getChildren() ?? []).length === 0 && w < 8000) {
          await new Promise((r) => setTimeout(r, 200)); w += 200;
        }
      }
    }
    // Close any bottom panel, open Forge sidebar — shows Rust host + Roslyn sidecar in action.
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await openSharpLspPanel();
    await new Promise((r) => setTimeout(r, 1_000));
    await takeScreenshot('vscode-architecture-page.png');
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

  test('extension contributes all expected commands', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const cmds: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(cmds.length >= 8, `Should contribute at least 8 commands, got ${cmds.length}`);
    const ids = cmds.map((c) => c.command);
    // Core commands that must always be present.
    for (const required of [
      'sharplsp.restartServer',
      'sharplsp.showOutput',
      'sharplsp.showTraceOutput',
      'sharplsp.selectSolution',
      'sharplsp.refreshExplorer',
      'sharplsp.sortNatural',
      'sharplsp.sortAlphabetical',
      'sharplsp.sortAccessibility',
      'sharplsp.build',
      'sharplsp.rebuild',
      'sharplsp.clean',
      'sharplsp.openProjectFile',
      'sharplsp.addProjectReference',
      'sharplsp.nuget.addFromExplorer',
      'sharplsp.nuget.add',
      'sharplsp.nuget.update',
      'sharplsp.nuget.restore',
    ]) {
      assert.ok(ids.includes(required), `Missing required command: ${required}`);
    }
  });

  test('extension contributes all expected configuration properties', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const props = ext.packageJSON.contributes?.configuration?.properties ?? {};
    const keys = Object.keys(props);
    assert.ok(
      keys.length >= 4,
      `Should contribute at least 4 config properties, got ${keys.length}`,
    );
    for (const required of [
      'sharplsp.server.path',
      'sharplsp.server.extraArgs',
      'sharplsp.trace.server',
      'sharplsp.logging.level',
    ]) {
      assert.ok(keys.includes(required), `Missing required config property: ${required}`);
    }
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
      events.some((e: string) => e.includes('*.slnx')),
      'Should activate on .slnx files',
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
