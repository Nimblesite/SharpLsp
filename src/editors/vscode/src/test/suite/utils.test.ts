// The shared helpers in `utils.ts`, asserted at their own boundary.
//
//   • `removeDirRecursive` is the ONE recursive delete every temp directory
//     goes through — test discovery's FQN listing, the coverage directory and
//     every suite's teardown. It deletes a whole tree, tolerates a path that is
//     already gone, and never throws: a delete that throws from a `finally`
//     discards a result that was already complete.
//   • `RETRYING_RM` is the retry policy Windows needs (EPERM/EBUSY from a
//     handle a just-exited child still holds), in one place so no call site
//     drifts from it.
//   • `splitTrimmed`, `singleLine` and `isRecord` are the pure shapes several
//     modules share: PATHEXT, MSBuild `;` lists, `MOCHA_FILES`, listing lines.
//
// Implements [DIST-CI-WIN-VSIX].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  delay,
  isRecord,
  RETRYING_RM,
  removeDirRecursive,
  singleLine,
  splitTrimmed,
} from '../../utils.js';
import { SETTLE_MS } from './test-timeouts.js';

/** A temp tree two levels deep with a file at each level. */
function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-utils-'));
  const nested = path.join(root, 'bin', 'Debug');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, 'top.txt'), 'top', 'utf8');
  fs.writeFileSync(path.join(nested, 'deep.dll'), 'deep', 'utf8');
  return root;
}

suite('utils — removeDirRecursive and RETRYING_RM', () => {
  test('deletes a nested tree, then tolerates the same path once it is gone', () => {
    const root = makeTree();
    assert.ok(fs.existsSync(path.join(root, 'bin', 'Debug', 'deep.dll')), 'fixture tree exists');
    removeDirRecursive(root);
    assert.equal(fs.existsSync(root), false, 'the root is gone');
    assert.equal(fs.existsSync(path.join(root, 'top.txt')), false, 'its files are gone');
    assert.doesNotThrow(() => {
      removeDirRecursive(root);
    }, 'a missing path is not an error');
    assert.equal(fs.existsSync(root), false, 'a second delete recreates nothing');
  });

  test('swallows a delete that throws instead of failing the caller', () => {
    const invalid = path.join(os.tmpdir(), 'sharplsp\0invalid');
    assert.throws(() => {
      fs.rmSync(invalid, RETRYING_RM);
    }, 'a bare rmSync of this path throws');
    assert.doesNotThrow(() => {
      removeDirRecursive(invalid);
    }, 'the helper does not');
    const root = makeTree();
    removeDirRecursive(root);
    assert.equal(fs.existsSync(root), false, 'a later delete still works after a swallowed one');
  });

  test('frees the path at once and deletes the tree in the background, never the reused path', async function () {
    // A synchronous delete of a copied .NET SDK held the extension host's event
    // loop for 41 s on a Windows runner (GitHub #311). The tree is moved aside
    // in one rename and deleted off the loop, so the path is reusable at once.
    this.timeout(SETTLE_MS + 5_000);
    const root = makeTree();
    const parent = path.dirname(root);
    const aside = (): string[] =>
      fs
        .readdirSync(parent)
        .filter((name) => name.startsWith(`${path.basename(root)}.`) && name.endsWith('.deleting'));

    removeDirRecursive(root);
    assert.equal(fs.existsSync(root), false, 'the path is free the moment the call returns');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'reused.txt'), 'kept', 'utf8');

    const deadline = Date.now() + SETTLE_MS;
    while (aside().length > 0 && Date.now() < deadline) await delay(50);
    assert.deepEqual(aside(), [], 'the tree moved aside is deleted in the background');
    assert.equal(
      fs.readFileSync(path.join(root, 'reused.txt'), 'utf8'),
      'kept',
      'the background delete never touches a path the caller reused',
    );
    removeDirRecursive(root);
  });

  test('carries the Windows retry policy every call site shares', () => {
    assert.equal(RETRYING_RM.recursive, true, 'deletes the whole tree');
    assert.equal(RETRYING_RM.force, true, 'a missing path is not an error');
    assert.equal(RETRYING_RM.maxRetries, 10, 'retries EPERM/EBUSY rather than failing once');
    assert.equal(RETRYING_RM.retryDelay, 100, 'waits between retries for the child to exit');
  });
});

suite('utils — shared pure shapes', () => {
  test('singleLine keeps one line of every non-blank part, CRLF or LF', () => {
    assert.equal(
      singleLine('Assert.Equal() Failure\r\n  Expected: 1\r\n\r\n  Actual: 2'),
      'Assert.Equal() Failure Expected: 1 Actual: 2',
    );
    assert.equal(singleLine('one\ntwo'), 'one two', 'LF input');
    assert.equal(singleLine('  \n \n'), '', 'blank input is empty, not a space');
    assert.equal(singleLine('already single'), 'already single', 'a single line is unchanged');
  });

  test('splitTrimmed keeps the trimmed non-blank parts for every separator its callers use', () => {
    assert.deepEqual(
      splitTrimmed(' .COM; .EXE;;.CMD ;', ';'),
      ['.COM', '.EXE', '.CMD'],
      'PATHEXT / MSBuild list',
    );
    assert.deepEqual(
      splitTrimmed('a.test.js, b.test.js ,', ','),
      ['a.test.js', 'b.test.js'],
      'MOCHA_FILES',
    );
    assert.deepEqual(
      splitTrimmed('Ns.T.A\r\n\r\nNs.T.B\r\n', '\n'),
      ['Ns.T.A', 'Ns.T.B'],
      'CRLF lines',
    );
    assert.deepEqual(splitTrimmed('', ';'), [], 'empty input yields no parts');
    assert.deepEqual(splitTrimmed(' ; ; ', ';'), [], 'only separators and blanks yields no parts');
  });

  test('isRecord accepts a plain object only', () => {
    assert.equal(isRecord({ a: 1 }), true, 'plain object');
    assert.equal(isRecord(null), false, 'null');
    assert.equal(isRecord([1, 2]), false, 'array');
    assert.equal(isRecord('text'), false, 'string');
  });
});
