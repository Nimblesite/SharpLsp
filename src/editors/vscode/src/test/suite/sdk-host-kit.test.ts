import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dotnetExecutable } from '../../dotnet-roots.js';
import { copySdkMajor } from './sdk-host-kit.js';
import { removeDirRecursive } from './test-helpers.js';

const COMPONENTS = ['sdk', 'host/fxr', 'shared/Microsoft.NETCore.App'];

function seedComponent(source: string, component: string): void {
  for (const version of ['10.0.100', '10.0.303']) {
    fs.mkdirSync(path.join(source, component, version), { recursive: true });
    fs.writeFileSync(path.join(source, component, version, 'payload'), version);
  }
}

// Implements [DIST-RUNTIME-ACQUIRE]: a real-host test needs one version per component.
suite('SDK host fixture copy', () => {
  test('copies one newest version per component instead of every installed SDK', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-sdk-kit-'));
    const source = path.join(scratch, 'source');
    const target = path.join(scratch, 'target');
    try {
      fs.mkdirSync(source);
      fs.writeFileSync(dotnetExecutable(source), 'muxer');
      for (const component of COMPONENTS) seedComponent(source, component);
      copySdkMajor(source, target, 10);
      for (const component of COMPONENTS) {
        assert.deepEqual(fs.readdirSync(path.join(target, component)), ['10.0.303']);
        assert.equal(
          fs.readFileSync(path.join(target, component, '10.0.303', 'payload'), 'utf8'),
          '10.0.303',
        );
      }
    } finally {
      removeDirRecursive(scratch);
    }
  });
});
