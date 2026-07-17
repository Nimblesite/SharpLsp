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

  // The C# sidecar must ship its own complete Roslyn. If the publish graph
  // drops an assembly (Microsoft.CodeAnalysis.CSharp.dll went missing after
  // the Roslyn 5.6.0 bump), the runtime silently falls back to the machine
  // SDK's Roslyn and workspace/open crashes with "Could not load type
  // 'Microsoft.CodeAnalysis.CSharp.Syntax.WithElementSyntax'" on any SDK
  // whose Roslyn is older than the bundled Features/Workspaces assemblies
  // (e.g. 10.0.2xx). CI never sees it because its SDK's Roslyn happens to
  // be new enough — this pins the payload so the fallback can never happen.
  test('C# sidecar payload ships its own Roslyn compiler assemblies', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);
    const binAll = path.join(ext.extensionPath, 'bin', 'all');
    for (const required of [
      'Microsoft.CodeAnalysis.dll',
      'Microsoft.CodeAnalysis.CSharp.dll',
      'Microsoft.CodeAnalysis.CSharp.Features.dll',
      'Microsoft.CodeAnalysis.CSharp.Workspaces.dll',
      'Microsoft.CodeAnalysis.Workspaces.MSBuild.dll',
    ]) {
      assert.ok(
        fs.existsSync(path.join(binAll, required)),
        `${required} must ship with the C# sidecar — a missing Roslyn assembly makes the ` +
          "sidecar resolve it from the machine SDK instead, crashing workspace/open when the SDK's " +
          'Roslyn is older than the bundled one.',
      );
    }
  });
});
