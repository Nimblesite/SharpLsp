import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dotnetExecutable } from '../../dotnet-roots.js';
import { copySdkMajor, newestVersion } from './sdk-host-kit.js';
import { removeDirRecursive } from './test-helpers.js';

const COMPONENTS = ['sdk', path.join('host', 'fxr'), path.join('shared', 'Microsoft.NETCore.App')];

function seedComponent(source: string, component: string, versions: readonly string[]): void {
  for (const version of versions) {
    fs.mkdirSync(path.join(source, component, version), { recursive: true });
    fs.writeFileSync(path.join(source, component, version, 'payload'), version);
  }
}

/**
 * The fixture copier, held to the two properties CI depends on.
 *
 * Implements [DIST-RUNTIME-ACQUIRE]: a real-host test needs ONE version per
 * component. Copying every installed 9.x and 10.x is what made the Windows
 * `workspace` chunk exceed its whole-run ceiling — `fs.cpSync` is synchronous,
 * so mocha could not fire the 120s hook timeout until the copy finally returned
 * sixteen minutes later, and the chunk was killed before printing a single
 * failure (#297).
 *
 * And "one version" has to mean the NEWEST one by version order. Directory
 * names are versions, not words: a lexicographic sort puts `10.0.99` above
 * `10.0.100` and `9.0.9` above `9.0.14`, so the fixture would quietly stage an
 * SDK older than the machine's newest and keep passing while it did.
 */
suite('SDK host fixture copy', () => {
  let scratch: string;

  setup(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-sdk-kit-'));
  });

  teardown(() => {
    removeDirRecursive(scratch);
  });

  function stage(versions: readonly string[]): { source: string; target: string } {
    const source = path.join(scratch, 'source');
    const target = path.join(scratch, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(dotnetExecutable(source), 'muxer');
    for (const component of COMPONENTS) seedComponent(source, component, versions);
    return { source, target };
  }

  test('copies one newest version per component instead of every installed SDK', () => {
    const { source, target } = stage(['10.0.100', '10.0.303']);
    const host = copySdkMajor(source, target, 10);

    assert.equal(host, dotnetExecutable(target), 'the copier returns the muxer it wrote');
    assert.ok(fs.existsSync(host), 'and that muxer must really exist on disk');
    for (const component of COMPONENTS) {
      assert.deepEqual(
        fs.readdirSync(path.join(target, component)),
        ['10.0.303'],
        `${component} must carry exactly one version, or the copy blocks CI for minutes`,
      );
      assert.equal(
        fs.readFileSync(path.join(target, component, '10.0.303', 'payload'), 'utf8'),
        '10.0.303',
        `${component} must hold the real payload, not an empty directory of the right name`,
      );
    }
  });

  test('picks the newest by VERSION order, which a lexicographic sort gets wrong', () => {
    // `10.0.100` is a later feature band than `10.0.99`, and `9.0.14` a later
    // patch than `9.0.9` — both orderings a string sort reverses.
    const { source, target } = stage(['10.0.99', '10.0.100']);
    copySdkMajor(source, target, 10);
    for (const component of COMPONENTS) {
      assert.deepEqual(
        fs.readdirSync(path.join(target, component)),
        ['10.0.100'],
        `${component}: band 100 is newer than band 0 patch 99, whatever a string sort says`,
      );
    }

    assert.equal(newestVersion(['9.0.9', '9.0.14'], '9.'), '9.0.14', 'patch 14 beats patch 9');
    assert.equal(newestVersion(['10.0.99', '10.0.100'], '10.'), '10.0.100', 'band beats patch');
    assert.equal(newestVersion(['9.0.14', '10.0.1'], '10.'), '10.0.1', 'the prefix still filters');
    assert.equal(newestVersion([], '10.'), undefined, 'nothing installed is not a version');
    assert.equal(newestVersion(['9.0.14'], '10.'), undefined, 'a 9 root cannot supply a 10');
  });

  test('a prerelease never outranks the release it sits below', () => {
    // hostfxr orders `10.0.100-rc.1` BELOW `10.0.100`; staging the prerelease
    // would build a fixture the real host would not have chosen.
    assert.equal(
      newestVersion(['10.0.100', '10.0.100-rc.1'], '10.'),
      '10.0.100',
      'the release wins however the directories happen to be listed',
    );
    assert.equal(
      newestVersion(['10.0.100-rc.1', '10.0.100'], '10.'),
      '10.0.100',
      'and it wins from the other listing order too — order is not the answer',
    );
    assert.equal(
      newestVersion(['10.0.100-rc.1', '10.0.303'], '10.'),
      '10.0.303',
      'a later release still beats an earlier prerelease',
    );
    assert.equal(
      newestVersion(['10.0.100+build-5', '10.0.99'], '10.'),
      '10.0.100+build-5',
      'build metadata carries no precedence and may itself contain "-"',
    );
  });

  test('a major the source cannot supply fails the fixture rather than composing one', () => {
    const { source, target } = stage(['10.0.303']);
    assert.throws(
      () => copySdkMajor(source, target, 9),
      /must supply \.NET 9/,
      'a missing major is a fixture prerequisite, never an empty directory named 9.x',
    );
  });
});
