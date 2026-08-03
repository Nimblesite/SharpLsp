import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRuntimePlatform, exeName } from '../../platform.js';

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
