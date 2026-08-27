import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { exeName } from '../../platform.js';

const extensionId = 'nimblesite.sharplsp';

suite('Bundled sidecar resolution', () => {
  test('sidecars are present in bin/all/ inside the extension directory', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);

    // Sidecars are staged with the host's executable extension (`.exe` on
    // Windows) exactly as shipwright's `bin/all/…${exe}` bundlePath resolves
    // them; an extensionless check is a false negative on Windows.
    const binAll = path.join(ext.extensionPath, 'bin', 'all');
    const csharpSidecar = path.join(binAll, exeName('sharplsp-sidecar-csharp'));
    const fsharpSidecar = path.join(binAll, exeName('sharplsp-sidecar-fsharp'));

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

  // Existence is NOT proof of a usable payload. `sharplsp-sidecar-csharp(.exe)` is a
  // .NET apphost shim: it is a few hundred KB of launcher whose only job is to load
  // `SharpLsp.Sidecar.<lang>.dll` sitting beside it. Stage the apphost without its
  // managed assembly and every existsSync check above still passes, while running it
  // dies with "The application to execute does not exist: SharpLsp.Sidecar.CSharp.dll".
  //
  // That is not hypothetical. The staging step swallows failures
  // (`cp/mv ... 2>/dev/null || true` in _stage-vsix-binary-only), so a partial publish,
  // a locked file on Windows, or an interrupted stage ships a VSIX that packages
  // cleanly, passes the existence tests, and then fails at activation. Users see
  // "required binaries are missing or version-mismatched" naming an unrelated
  // directory, because shipwright rejects the unusable `bundled` source and falls
  // through to the `path` source, which reports whatever PATH entry it tried last.
  //
  // shipwright resolves these with `versionCheckStrategy: "version-flag"`, so running
  // `--version` is exactly the check activation performs. Implements [DIST-FAILURE-UX].
  test('bundled sidecars actually execute — apphost plus its managed assembly', function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);
    const binAll = path.join(ext.extensionPath, 'bin', 'all');

    for (const sidecar of ['sharplsp-sidecar-csharp', 'sharplsp-sidecar-fsharp']) {
      const binary = path.join(binAll, exeName(sidecar));
      const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 20_000 });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

      assert.equal(
        result.status,
        0,
        `${sidecar} is staged but does not run (exit ${String(result.status)}): ${output}. ` +
          'The apphost needs its managed assembly staged alongside it — an apphost on its own ' +
          'passes every existence check and then fails at activation.',
      );
      assert.ok(
        output.includes(sidecar),
        `${sidecar} --version must report its own name and version so shipwright's ` +
          `version-flag check can resolve the bundled source; got: ${output}`,
      );
    }
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
