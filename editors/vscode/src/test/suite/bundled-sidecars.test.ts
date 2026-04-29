import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const extensionId = 'sharplsp.sharp-lsp';

const envVarsThatBypassSidecarResolution = [
  'SHARPLSP_CSHARP_SIDECAR_PATH',
  'SHARPLSP_FSHARP_SIDECAR_PATH',
] as const;

suite('Bundled sidecar resolution', () => {
  test('sidecars are present in bin/all/ inside the extension directory', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);

    const csharpSidecar = path.join(ext.extensionPath, 'bin', 'all', 'sharplsp-sidecar-csharp');
    const fsharpSidecar = path.join(ext.extensionPath, 'bin', 'all', 'sharplsp-sidecar-fsharp');

    assert.ok(
      fs.existsSync(csharpSidecar),
      [
        `Expected C# sidecar at ${csharpSidecar}.`,
        'The _build-vsix target must stage sharplsp-sidecar-csharp into bin/all/ before vsce package.',
        'Without it activation crashes — sidecars are required, not optional.',
      ].join(' '),
    );

    assert.ok(
      fs.existsSync(fsharpSidecar),
      [
        `Expected F# sidecar at ${fsharpSidecar}.`,
        'The _build-vsix target must stage sharplsp-sidecar-fsharp into bin/all/ before vsce package.',
        'F# is a first-class citizen — no SharpLsp without F# support.',
      ].join(' '),
    );
  });

  test('sidecars resolve from bundled source without PATH injection', async function () {
    this.timeout(15_000);

    const { activateDeploymentToolkit } = await import('@nimblesite/shipwright-vscode');
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);

    for (const name of envVarsThatBypassSidecarResolution) {
      assert.strictEqual(
        process.env[name],
        undefined,
        `${name} must be unset in bundled sidecar tests`,
      );
    }

    const result = await activateDeploymentToolkit(ext, {
      env: sanitizedEnv(),
      manifestPath: path.join(ext.extensionPath, 'shipwright.json'),
      pathEntries: [],
      showMessages: false,
      timeoutMs: 5_000,
    });

    const csharpDiag = result.diagnostics.find((d) => d.componentId === 'sharplsp-sidecar-csharp');
    const fsharpDiag = result.diagnostics.find((d) => d.componentId === 'sharplsp-sidecar-fsharp');

    assert.ok(csharpDiag !== undefined, 'sharplsp-sidecar-csharp diagnostic must be present');
    assert.strictEqual(csharpDiag.resolution.status, 'ok', 'C# sidecar must resolve successfully');
    assert.strictEqual(
      csharpDiag.resolution.source,
      'bundled',
      'C# sidecar must resolve from bundled, not PATH',
    );

    assert.ok(fsharpDiag !== undefined, 'sharplsp-sidecar-fsharp diagnostic must be present');
    assert.strictEqual(fsharpDiag.resolution.status, 'ok', 'F# sidecar must resolve successfully');
    assert.strictEqual(
      fsharpDiag.resolution.source,
      'bundled',
      'F# sidecar must resolve from bundled, not PATH',
    );
  });
});

function sanitizedEnv(): NodeJS.ProcessEnv {
  const bypass = new Set<string>([
    'SHARPLSP_EXECUTABLE_PATH',
    'SHARPLSP_LSP_PATH',
    'SHARPLSP_BINARY_DIR',
    'FORGE_LSP_PATH',
    'FORGE_BINARY_DIR',
    'SHARPLSP_CSHARP_SIDECAR_PATH',
    'SHARPLSP_FSHARP_SIDECAR_PATH',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !bypass.has(name)),
  ) as NodeJS.ProcessEnv;
}
