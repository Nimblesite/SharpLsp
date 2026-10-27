// Tests for [DIST-CI-WIN-VSIX] and [NETFX-SCOPE]: which suites a run executes.
//
// The runner (./index) turns MOCHA_FILES into the suites Mocha loads. A request
// that resolves to nothing must fail, never pass a run of zero tests: a pattern
// matching no compiled suite, and, off Windows, a pattern naming only suites of
// `windowsOnly` chunks, whose .NET Framework test hosts need the desktop CLR.
// The Windows-only names are the real test-chunks.json's.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePath } from '../../paths';
import { removeDirRecursive } from '../../utils';
import { resolveSuiteFiles, type ChunkManifest } from './index';

const NETFX_LANGUAGE = 'netfx-language.test.js';
const NETFX_RUN = 'netfx-run-fsharp.test.js';
const EVERYWHERE = 'everywhere.test.js';
const COMPILED = [EVERYWHERE, NETFX_LANGUAGE, NETFX_RUN];

suite('Test runner — suite selection', () => {
  let root = '';

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-select-'));
    for (const suiteFile of COMPILED) {
      fs.writeFileSync(path.join(root, suiteFile), '');
    }
  });

  suiteTeardown(() => removeDirRecursive(root));

  test('the real manifest keeps Linux-only suites on Linux in a full local run', () => {
    const manifest = JSON.parse(
      fs.readFileSync(resolvePath(__dirname, '../../..', 'test-chunks.json'), 'utf8'),
    ) as ChunkManifest;
    const linuxOnly = Object.values(manifest.chunks)
      .filter((chunk) => chunk.linuxOnly === true)
      .flatMap((chunk) => chunk.files);
    assert.ok(linuxOnly.length > 0, 'the real manifest declares Linux-only coverage');
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const selected = resolveSuiteFiles(__dirname, ['*.test.js'], platform);
      assert.deepEqual(
        linuxOnly.filter((file) => selected.includes(file)),
        platform === 'linux' ? linuxOnly : [],
      );
      assert.ok(selected.includes('semantic-highlighting.test.js'));
      assert.equal(selected.includes(NETFX_LANGUAGE), platform === 'win32');
    }
  });

  test('off Windows: a pattern naming only Windows-only suites fails with the platform reason → a broad pattern runs the rest', () => {
    assert.throws(
      () => resolveSuiteFiles(root, [NETFX_LANGUAGE], 'linux'),
      /selects only Windows-only suites, which run on Windows alone \(\[NETFX-SCOPE\]\): netfx-language\.test\.js$/,
    );
    assert.throws(
      () => resolveSuiteFiles(root, [EVERYWHERE, 'netfx-*.test.js'], 'darwin'),
      /Windows alone .*: netfx-\*\.test\.js$/,
      'one Windows-only pattern fails the whole request',
    );
    assert.deepEqual(resolveSuiteFiles(root, ['*.test.js'], 'linux'), [EVERYWHERE]);
    assert.deepEqual(resolveSuiteFiles(root, [EVERYWHERE], 'darwin'), [EVERYWHERE]);
  });

  test('on Windows: the same patterns run their suites → a pattern matching nothing still fails', () => {
    assert.deepEqual(resolveSuiteFiles(root, [NETFX_LANGUAGE], 'win32'), [NETFX_LANGUAGE]);
    assert.deepEqual(resolveSuiteFiles(root, ['netfx-*.test.js'], 'win32'), [
      NETFX_LANGUAGE,
      NETFX_RUN,
    ]);
    assert.deepEqual(resolveSuiteFiles(root, ['*.test.js'], 'win32'), [...COMPILED].sort());
    assert.throws(
      () => resolveSuiteFiles(root, ['nowhere.test.js'], 'win32'),
      /matched no compiled suite: nowhere\.test\.js$/,
    );
  });
});
