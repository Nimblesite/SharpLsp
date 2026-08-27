import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRuntimePlatform, exeName } from '../../platform.js';
import { getNetcoredbgCandidates } from '../../debug.js';

/**
 * Platforms with no upstream netcoredbg prebuilt. On these the VSIX cannot bundle
 * a debugger and the extension falls back to PATH / sharplsp.debug.netcoredbgPath
 * ([DIST-DEBUGGER-BUNDLE]); everywhere else a missing debugger is a staging bug.
 */
const NO_PREBUILT: readonly string[] = ['win32-arm64', 'darwin-x64'];

suite('VSIX dev binary staging', () => {
  test('keeps bundled sharplsp available for the development extension host', () => {
    const extensionRoot = path.resolve(__dirname, '../../..');
    const bundledBinary = path.join(
      extensionRoot,
      'bin',
      detectRuntimePlatform(),
      exeName('sharplsp'),
    );

    assertStagedComponent(bundledBinary, 'sharplsp');
  });

  test('keeps both required sidecars bundled for the development extension host', () => {
    const extensionRoot = path.resolve(__dirname, '../../..');

    // Sidecars are staged with the host's executable extension (`.exe` on
    // Windows) exactly as shipwright's `bin/all/…${exe}` bundlePath resolves
    // them; an extensionless check is a false negative on Windows.
    assertStagedComponent(
      path.join(extensionRoot, 'bin', 'all', exeName('sharplsp-sidecar-csharp')),
      'sharplsp-sidecar-csharp',
    );
    assertStagedComponent(
      path.join(extensionRoot, 'bin', 'all', exeName('sharplsp-sidecar-fsharp')),
      'sharplsp-sidecar-fsharp',
    );
  });

  // Implements [DIST-DEBUGGER-BUNDLE], [DEBUG-ADAPTER-NETCOREDBG]. Without the
  // bundled adapter every launch falls through to a bare `netcoredbg` on PATH,
  // which on a user's machine does not exist: F5 fails with a spawn ENOENT.
  test('bundles the netcoredbg debug adapter the launch path resolves first', function () {
    const platform = detectRuntimePlatform();
    const extensionRoot = path.resolve(__dirname, '../../..');

    // Upstream ships no netcoredbg for these platforms, so [DIST-DEBUGGER-BUNDLE]
    // mandates the PATH fallback rather than a bundle. That is a CONTRACT, not an
    // excuse to skip: skipping here would also pass if staging silently broke on
    // a platform that DOES have a prebuilt, so the unsupported case asserts its
    // own shape instead.
    if (NO_PREBUILT.includes(platform)) {
      const absent = path.join(extensionRoot, 'bin', platform, 'netcoredbg', exeName('netcoredbg'));
      assert.strictEqual(
        fs.existsSync(absent),
        false,
        `${platform} has no upstream prebuilt, so the VSIX must not claim to bundle one at ${absent}`,
      );
      const fallbacks = getNetcoredbgCandidates(extensionRoot);
      assert.ok(fallbacks.length > 0, 'the launch path must still have somewhere to look');
      assert.strictEqual(
        fallbacks.includes(absent),
        false,
        'and must not offer a bundled path that was never staged',
      );
      assert.ok(
        fallbacks.every((candidate) => candidate.endsWith(exeName('netcoredbg'))),
        `every fallback names the adapter binary; got ${JSON.stringify(fallbacks)}`,
      );
      return;
    }

    const bundled = path.join(extensionRoot, 'bin', platform, 'netcoredbg', exeName('netcoredbg'));
    assertStagedComponent(bundled, 'netcoredbg');

    // The adapter factory must prefer THIS copy: it is candidate zero.
    const candidates = getNetcoredbgCandidates(extensionRoot);
    assert.strictEqual(candidates[0], bundled, 'the bundled adapter must be searched first');
    assert.strictEqual(
      candidates.filter((candidate) => candidate === bundled).length,
      1,
      'and appear exactly once in the search order',
    );

    // A launcher alone is not a debugger: netcoredbg loads its managed half at
    // startup, so a stage that dropped ManagedPart.dll passes an existence check
    // and then dies on the first launch request.
    const adapterDir = path.dirname(bundled);
    for (const companion of ['ManagedPart.dll', 'Microsoft.CodeAnalysis.dll']) {
      assertStagedComponent(path.join(adapterDir, companion), `netcoredbg/${companion}`);
    }

    // AppleDouble forks from the macOS zip must never reach a user's VSIX.
    const junk = path.join(extensionRoot, 'bin', platform, '__MACOSX');
    assert.strictEqual(fs.existsSync(junk), false, `${junk} is archive junk and must be stripped`);

    if (process.platform !== 'win32') {
      const mode = fs.statSync(bundled).mode;
      assert.strictEqual((mode & 0o111) !== 0, true, 'the staged adapter must be executable');
    }
  });
});

function assertStagedComponent(filePath: string, component: string): void {
  assert.ok(
    fs.existsSync(filePath),
    [
      `Expected bundled ${component} at ${filePath}.`,
      'The VS Code test target must stage every required component after packaging, before npm test starts.',
      'Without it Shipwright blocks activation before client.start(), cascading LSP failures.',
    ].join(' '),
  );
}
