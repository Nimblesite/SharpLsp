// The shared helpers in `utils.ts`, asserted at their own boundary.
//
//   • `removeDirRecursive` is the ONE recursive delete every temp directory
//     goes through — test discovery's FQN listing, the coverage directory and
//     every suite's teardown. It deletes a whole tree, tolerates a path that is
//     already gone, and never throws: a delete that throws from a `finally`
//     discards a result that was already complete. It never reaches through a
//     link: a junction in the tree, or the path itself, loses only the link.
//   • `RETRYING_RM` is the retry policy Windows needs (EPERM/EBUSY from a
//     handle a just-exited child still holds), in one place so no call site
//     drifts from it.
//   • `splitTrimmed`, `singleLine` and `isRecord` are the pure shapes several
//     modules share: PATHEXT, MSBuild `;` lists, `MOCHA_FILES`, listing lines.
//
// Implements [DIST-CI-WIN-VSIX].
import * as assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ok } from '../../result.js';
import {
  delay,
  isRecord,
  RETRYING_RM,
  removeDirRecursive,
  singleLine,
  splitTrimmed,
} from '../../utils.js';
import { pollUntilResult } from './test-helpers.js';
import { POLL_INTERVAL_MS, SETTLE_MS } from './test-timeouts.js';

/** A temp tree two levels deep with a file at each level. */
function makeTree(parent = os.tmpdir()): string {
  const root = fs.mkdtempSync(path.join(parent, 'sharplsp-utils-'));
  const nested = path.join(root, 'bin', 'Debug');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, 'top.txt'), 'top', 'utf8');
  fs.writeFileSync(path.join(nested, 'deep.dll'), 'deep', 'utf8');
  return root;
}

/** Two trees in a private base: a victim, and a tree whose `bin/Debug/linked` is a junction to it. */
function makeLinkedTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-utils-link-'));
  const [victim, tree] = [makeTree(base), makeTree(base)];
  const held = path.join(tree, 'bin', 'Debug');
  fs.symlinkSync(victim, path.join(held, 'linked'), 'junction');
  return { base, victim, tree, held, link: path.join(held, 'linked') };
}

/**
 * A process running in `cwd`, returned once it has spoken, so it is really there. On
 * Windows its working directory pins the tree: while it lives the tree can be neither
 * renamed aside nor removed, so a delete of it runs in place.
 */
async function pinTree(cwd: string): Promise<ChildProcess> {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['ping', ['-n', '60', '127.0.0.1']]
      : ['sh', ['-c', 'echo pinned; exec sleep 60']];
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  return child;
}

/** Stop the pinning process and wait until it has let go of the tree. */
async function release(child: ChildProcess): Promise<void> {
  child.kill();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
}

/** Whether anything, a link included, is at `target`. */
function present(target: string): boolean {
  return fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

/** What `base` holds once nothing moved aside in it is still being deleted. */
async function settled(base: string): Promise<string[]> {
  return await pollUntilResult(
    async () => fs.readdirSync(base),
    (names) => names.every((name) => !name.endsWith('.deleting')),
    SETTLE_MS,
    POLL_INTERVAL_MS,
    `the background delete under ${base}`,
  );
}

/** Once nothing moved aside is still being deleted, `base` holds the victim alone, whole. */
async function assertVictimAlone(base: string, victim: string, why: string): Promise<void> {
  assert.deepEqual(await settled(base), [path.basename(victim)], why);
  assert.equal(fs.readFileSync(path.join(victim, 'top.txt'), 'utf8'), 'top', `${why}: kept`);
  const deep = path.join(victim, 'bin', 'Debug', 'deep.dll');
  assert.equal(fs.readFileSync(deep, 'utf8'), 'deep', `${why}: kept to the bottom`);
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

  test('never reaches through a junction: in place while a child pins the tree, nor once it is free', async function () {
    // The extension host's fs.rmSync (Node 24) walks INTO a junction and empties the
    // directory it names. A child sitting in the tree blocks the rename on Windows, so
    // the delete runs in place: the path a teardown takes over a composed .NET root
    // whose `sdk/<version>` is a junction into the machine's own install.
    this.timeout(SETTLE_MS * 3 + 5_000);
    const { base, victim, tree, held, link } = makeLinkedTree();
    const child = await pinTree(held);
    try {
      removeDirRecursive(tree);
      await settled(base);
      const kept = path.join(victim, 'top.txt');
      assert.ok(fs.existsSync(kept), 'the directory the junction names keeps its file');
      assert.ok(fs.statSync(path.join(victim, 'bin')).isDirectory(), 'and its folders');
      assert.equal(present(link), false, 'the junction itself is gone');
    } finally {
      await release(child);
    }
    removeDirRecursive(tree);
    await assertVictimAlone(base, victim, 'once the child is gone the tree goes');
    const aimed = path.join(base, 'aimed');
    fs.symlinkSync(victim, aimed, 'junction');
    removeDirRecursive(aimed);
    await assertVictimAlone(base, victim, 'a delete aimed AT a junction takes only the link');
    removeDirRecursive(base);
  });

  test('answers whether the path is free: ok the moment it is, an error naming a tree a child pins', async function () {
    // freshCoverageDir must not reuse a directory it could not empty, so the one
    // delete says whether the path is free rather than swallowing that it is not.
    this.timeout(SETTLE_MS * 2 + 5_000);
    const { base, victim, tree, held } = makeLinkedTree();
    const child = await pinTree(held);
    try {
      const pinned = removeDirRecursive(tree);
      assert.equal(pinned.ok, !present(tree), 'ok exactly when the path is free on return');
      assert.equal(pinned.ok, process.platform !== 'win32', 'only Windows pins a tree it sits in');
      assert.ok(pinned.ok || pinned.error.includes(tree), 'an error names the tree it left');
    } finally {
      await release(child);
    }
    assert.deepEqual(removeDirRecursive(tree), ok(undefined), 'unpinned, the path frees');
    assert.deepEqual(removeDirRecursive(tree), ok(undefined), 'and a path already gone is free');
    await assertVictimAlone(base, victim, 'nothing is left behind but the target');
    removeDirRecursive(base);
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
