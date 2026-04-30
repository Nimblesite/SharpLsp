import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRuntimePlatform } from '../../platform.js';

suite('VSIX dev binary staging', () => {
  test('keeps bundled sharplsp available for the development extension host', () => {
    const extensionRoot = path.resolve(__dirname, '../../..');
    const binaryName = process.platform === 'win32' ? 'sharplsp.exe' : 'sharplsp';
    const bundledBinary = path.join(extensionRoot, 'bin', detectRuntimePlatform(), binaryName);

    assertStagedComponent(bundledBinary, 'sharplsp');
  });

  test('keeps both required sidecars bundled for the development extension host', () => {
    const extensionRoot = path.resolve(__dirname, '../../..');

    assertStagedComponent(
      path.join(extensionRoot, 'bin', 'all', 'sharplsp-sidecar-csharp'),
      'sharplsp-sidecar-csharp',
    );
    assertStagedComponent(
      path.join(extensionRoot, 'bin', 'all', 'sharplsp-sidecar-fsharp'),
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
