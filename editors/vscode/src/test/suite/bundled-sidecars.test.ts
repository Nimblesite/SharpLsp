import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const extensionId = 'nimblesite.sharplsp';

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
});
