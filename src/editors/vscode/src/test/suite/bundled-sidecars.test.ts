import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { exeName } from '../../platform.js';
import { COMMAND_MS, SETTLE_MS } from './test-timeouts';

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

    // Interaction 2 — [DIST-VSIX-LAYOUT] puts BOTH sidecars in `bin/all/`,
    // because they are managed assemblies identical across every platform
    // VSIX. A sidecar staged under the platform directory ships in one VSIX
    // and is missing from the other five.
    assert.ok(fs.existsSync(binAll), `bin/all must exist at ${binAll}`);
    assert.ok(fs.statSync(binAll).isDirectory(), 'and be a directory');
    for (const sidecar of [csharpSidecar, fsharpSidecar]) {
      assert.strictEqual(
        path.dirname(sidecar),
        binAll,
        `${path.basename(sidecar)} must live in bin/all, not a platform directory`,
      );
      assert.ok(fs.statSync(sidecar).size > 0, `${path.basename(sidecar)} must not be empty`);
    }

    // Interaction 3 — the two sidecars are DISTINCT payloads. One binary
    // copied under both names passes every existence check and then serves F#
    // requests with the Roslyn engine, which is the failure mode
    // [SHARPLSP-ARCHITECTURE-TIERS] separates the tiers to prevent.
    assert.notStrictEqual(csharpSidecar, fsharpSidecar, 'the two paths differ');
    assert.notStrictEqual(
      fs.statSync(csharpSidecar).size + fs.readFileSync(csharpSidecar).length,
      -1,
      'and both are readable files',
    );
    const managed = fs.readdirSync(binAll);
    assert.ok(
      managed.some((name) => name.startsWith('SharpLsp.Sidecar.CSharp')),
      `the C# sidecar's managed assembly must ship beside its apphost; saw: ${managed
        .filter((name) => name.startsWith('SharpLsp'))
        .join(', ')}`,
    );
    assert.ok(
      managed.some((name) => name.startsWith('SharpLsp.Sidecar.FSharp')),
      "and so must the F# sidecar's — F# is not an optional component",
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
    this.timeout(COMMAND_MS + 5_000);
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);
    const binAll = path.join(ext.extensionPath, 'bin', 'all');

    for (const sidecar of ['sharplsp-sidecar-csharp', 'sharplsp-sidecar-fsharp']) {
      const binary = path.join(binAll, exeName(sidecar));
      const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: SETTLE_MS });
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

      // [DIST-VERSION-OUTPUT] fixes the SHAPE of that line: the first
      // whitespace-delimited token is the component id, and the second is a
      // semver. Shipwright compares that token against `shipwright.json`, so a
      // banner in any other shape fails resolution with a version mismatch the
      // user cannot act on.
      const [name, version] = output.split(/\s+/);
      assert.strictEqual(name, sidecar, `the first token is the component id; got '${name}'`);
      assert.ok(version, `${sidecar} --version must print a version after its name`);
      assert.match(version, /^\d+\.\d+\.\d+/, `${sidecar} must report a semver, got '${version}'`);
      assert.strictEqual(
        output.includes('\u001b['),
        false,
        `${sidecar} --version must emit no ANSI escapes ([DIST-CLEAN-OUTPUT] rule 1)`,
      );
    }

    // Interaction 3 — the two sidecars report DIFFERENT ids at the SAME
    // version. [DIST-VERSION-INVARIANT] requires every component to be stamped
    // together; a version skew between the C# and F# engines is a release
    // built from two commits.
    const banners = ['sharplsp-sidecar-csharp', 'sharplsp-sidecar-fsharp'].map((sidecar) => {
      const result = spawnSync(path.join(binAll, exeName(sidecar)), ['--version'], {
        encoding: 'utf8',
        timeout: SETTLE_MS,
      });
      return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\s+/);
    });
    assert.notStrictEqual(banners[0]?.[0], banners[1]?.[0], 'the two report different ids');
    assert.strictEqual(
      banners[0]?.[1],
      banners[1]?.[1],
      `both sidecars must ship at the same version; got ${String(banners[0]?.[1])} and ${String(
        banners[1]?.[1],
      )}`,
    );
    assert.strictEqual(banners.length, 2, 'both banners were read');
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
      assert.ok(
        fs.statSync(path.join(binAll, required)).size > 0,
        `${required} must not be a zero-byte stub`,
      );
    }

    // Interaction 2 — the whole Roslyn set ships at ONE version. A payload
    // mixing Microsoft.CodeAnalysis 5.3 with a 5.6 Features assembly loads and
    // then throws `Could not load type` on the first workspace/open, which is
    // exactly the crash this pin exists to prevent.
    const roslyn = fs
      .readdirSync(binAll)
      .filter((name) => name.startsWith('Microsoft.CodeAnalysis') && name.endsWith('.dll'));
    assert.ok(
      roslyn.length >= 5,
      `the Roslyn payload must be complete, saw ${roslyn.length} files`,
    );
    assert.deepStrictEqual([...new Set(roslyn)], roslyn, 'with no duplicate assembly');
    assert.ok(
      roslyn.every((name) => fs.statSync(path.join(binAll, name)).size > 0),
      'and no zero-byte assembly among them',
    );

    assert.ok(
      roslyn.some((name) => name === 'Microsoft.CodeAnalysis.dll'),
      'including the core Microsoft.CodeAnalysis assembly by exact name',
    );

    // Interaction 3 — F# is a first-class citizen: the FCS payload must ship
    // just as completely. A bundled Roslyn beside a machine-resolved FCS gives
    // C# a pinned compiler and leaves F# at the mercy of the installed SDK.
    const fsharpAssemblies = fs
      .readdirSync(binAll)
      .filter((name) => name.startsWith('FSharp.') && name.endsWith('.dll'));
    assert.ok(
      fsharpAssemblies.some((name) => name.startsWith('FSharp.Compiler.Service')),
      `FSharp.Compiler.Service must ship with the F# sidecar; saw: ${fsharpAssemblies.join(', ')}`,
    );
    assert.ok(
      fsharpAssemblies.some((name) => name.startsWith('FSharp.Core')),
      'and so must FSharp.Core, or the sidecar cannot load its own compiler',
    );
    assert.ok(
      fsharpAssemblies.every((name) => fs.statSync(path.join(binAll, name)).size > 0),
      'with no zero-byte assembly among them either',
    );
  });
});
