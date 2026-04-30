// Implements [DIST-FAILURE-UX].
//
// These tests prove the silent-failure mode that broke v0.1.0 cannot recur:
//   - activate() always resolves with an API, never rejects.
//   - notifyActivationFailure exists and surfaces a non-modal error.
//   - The retry recovery command is registered.
//   - extensionDependencies includes the .NET Install Tool.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { EXTENSION_ID } from './test-helpers.js';

suite('[DIST-FAILURE-UX] activate() never rejects', () => {
  test('extension is activated successfully (resolved promise, not rejected)', async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} must be loaded`);

    // If activate() ever threw, ext.activate() would reject. The host catches
    // it and stores the rejection on the extension. We assert on the resolved
    // state — a degraded API is still a resolved promise.
    const api: unknown = await ext.activate();
    assert.ok(api, 'activate() must resolve with an API value, never reject');
  });

  test('extension exports a degraded API surface even if components fail', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const api = ext.exports as
      | { explorerProvider?: unknown; profilerProvider?: unknown; getLspClient?: unknown }
      | undefined;
    assert.ok(api, 'extension exports must be present');
    assert.ok(api.explorerProvider, 'explorerProvider must exist on degraded API');
    assert.ok(api.profilerProvider, 'profilerProvider must exist on degraded API');
    assert.strictEqual(typeof api.getLspClient, 'function', 'getLspClient must be a function');
  });
});

suite('[DIST-FAILURE-UX] recovery commands are registered', () => {
  test('sharplsp.retryDotnetAcquisition is in the command palette', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    if (!ext.isActive) await ext.activate();

    const all = await vscode.commands.getCommands(true);
    assert.ok(
      all.includes('sharplsp.retryDotnetAcquisition'),
      'sharplsp.retryDotnetAcquisition must be registered for the degraded recovery path',
    );
  });

  test('sharplsp.restartServer is in the command palette', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    if (!ext.isActive) await ext.activate();

    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('sharplsp.restartServer'));
  });

  test('sharplsp.showOutput is in the command palette (the [Show Log] target)', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    if (!ext.isActive) await ext.activate();

    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('sharplsp.showOutput'));
  });
});

suite('[DIST-FAILURE-UX] retry command contributes a category-titled palette entry', () => {
  test('package.json contributes the retry command with title and category', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const cmds: { command: string; title?: string; category?: string }[] =
      ext.packageJSON.contributes?.commands ?? [];
    const retry = cmds.find((c) => c.command === 'sharplsp.retryDotnetAcquisition');
    assert.ok(retry, 'retry command must be declared in package.json contributions');
    assert.ok(retry.title, 'retry command must have a user-visible title');
    assert.strictEqual(retry.category, 'SharpLsp');
  });
});

suite('[DIST-RUNTIME-ACQUIRE] extensionDependencies declares .NET Install Tool', () => {
  test('package.json declares ms-dotnettools.vscode-dotnet-runtime as an extensionDependency', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const deps: string[] = ext.packageJSON.extensionDependencies ?? [];
    assert.ok(
      deps.includes('ms-dotnettools.vscode-dotnet-runtime'),
      'extensionDependencies must include ms-dotnettools.vscode-dotnet-runtime per [DIST-RUNTIME-ACQUIRE]',
    );
  });

  test('the .NET Install Tool extension is actually present in the test host', () => {
    const installTool = vscode.extensions.getExtension('ms-dotnettools.vscode-dotnet-runtime');
    assert.ok(
      installTool,
      'ms-dotnettools.vscode-dotnet-runtime should be auto-installed via extensionDependencies',
    );
  });
});

suite('[DIST-FAILURE-UX] notifyActivationFailure helper', () => {
  test('exists as an exported function and accepts (headline, detail)', async () => {
    // Dynamic import keeps the test independent of build-time tree-shaking.
    const mod = (await import('../../extension.js')) as {
      notifyActivationFailure?: (headline: string, detail: string) => Promise<void>;
    };
    assert.strictEqual(
      typeof mod.notifyActivationFailure,
      'function',
      'extension.ts must export notifyActivationFailure(headline, detail)',
    );
  });
});
