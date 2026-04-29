import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('VSIX dev binary staging', () => {
  test('keeps bundled sharplsp available for the development extension host', () => {
    const extensionRoot = path.resolve(__dirname, '../../..');
    const binaryName = process.platform === 'win32' ? 'sharplsp.exe' : 'sharplsp';
    const bundledBinary = path.join(extensionRoot, 'bin', detectRuntimePlatform(), binaryName);

    assert.ok(
      fs.existsSync(bundledBinary),
      [
        `Expected bundled sharplsp binary at ${bundledBinary}.`,
        'The VS Code test target must stage this file after packaging, before npm test starts.',
        'Without it Shipwright blocks activation before client.start(), cascading LSP failures.',
      ].join(' '),
    );
  });
});

function detectRuntimePlatform(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin') return 'darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'linux') return 'linux-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-arm64';
  if (process.platform === 'win32') return 'win32-x64';
  return 'linux-x64';
}
