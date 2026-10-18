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
import { removeDirRecursive } from '../../utils';
import { resolveSuiteFiles } from './index';

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
