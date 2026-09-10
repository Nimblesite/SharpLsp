import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_ROLL_FORWARD,
  findGlobalJson,
  installedSdkVersions,
  parseSdkVersion,
  pinSatisfiedBy,
  readSdkPin,
  sdkSatisfiesPin,
  type SdkPin,
} from '../../global-json.js';
import { describeSdkPinFailure, existingSdkSatisfiesWorkspace } from '../../dotnetRuntime.js';
import { SDK_RESOLUTION_EXIT_CODE, diagnoseBuildFailure } from '../../build.js';

/**
 * Regression suite for the SDK pin that broke every `dotnet` entry point on a
 * machine whose only .NET 10 SDK was `10.0.203` while the workspace
 * `global.json` pinned `10.0.303`.
 *
 * Implements [DIST-RUNTIME-ACQUIRE] / [DIST-SDK-DISCOVERY].
 */
suite('global.json SDK pin', () => {
  let scratchDir: string;

  /** A `dotnet` executable path with the given SDKs installed beside it. */
  function fakeDotnet(name: string, sdks: readonly string[]): string {
    const root = path.join(scratchDir, name);
    for (const sdk of sdks) fs.mkdirSync(path.join(root, 'sdk', sdk), { recursive: true });
    const exe = path.join(root, 'dotnet');
    fs.writeFileSync(exe, '');
    return exe;
  }

  /** A workspace directory containing the given `global.json` contents. */
  function fakeWorkspace(name: string, contents: string): string {
    const dir = path.join(scratchDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'global.json'), contents);
    return dir;
  }

  const pin = (version: string, rollForward: SdkPin['rollForward']): SdkPin => ({
    version,
    rollForward,
    source: '/workspace/global.json',
  });

  setup(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-sdk-pin-'));
  });

  teardown(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  test('a lower feature band never satisfies a latestPatch pin', () => {
    // The exact production failure: band 200 cannot roll forward to band 300.
    const target = pin('10.0.303', 'latestPatch');
    assert.equal(
      sdkSatisfiesPin('10.0.203', target),
      false,
      '10.0.203 is band 200, pin is band 300',
    );
    assert.equal(sdkSatisfiesPin('10.0.300', target), false, 'same band but patch 0 < patch 3');
    assert.equal(sdkSatisfiesPin('10.0.303', target), true, 'the pinned version itself satisfies');
    assert.equal(sdkSatisfiesPin('10.0.310', target), true, 'a higher patch in the band satisfies');
    assert.equal(sdkSatisfiesPin('10.0.400', target), false, 'latestPatch may not cross bands');

    // The whole installed set of the broken machine satisfies nothing.
    assert.equal(
      pinSatisfiedBy(['9.0.312', '10.0.203'], target),
      false,
      'neither installed SDK can satisfy the pin',
    );
    assert.equal(pinSatisfiedBy(['9.0.312', '10.0.203', '10.0.303'], target), true);
  });

  test('rollForward widens how far a version may roll', () => {
    assert.equal(sdkSatisfiesPin('10.0.400', pin('10.0.303', 'latestFeature')), true);
    assert.equal(sdkSatisfiesPin('10.1.100', pin('10.0.303', 'latestFeature')), false);
    assert.equal(sdkSatisfiesPin('10.1.100', pin('10.0.303', 'latestMinor')), true);
    assert.equal(sdkSatisfiesPin('11.0.100', pin('10.0.303', 'latestMinor')), false);
    assert.equal(sdkSatisfiesPin('11.0.100', pin('10.0.303', 'latestMajor')), true);
    assert.equal(sdkSatisfiesPin('10.0.303', pin('10.0.303', 'disable')), true);
    assert.equal(sdkSatisfiesPin('10.0.310', pin('10.0.303', 'disable')), false);
    // A pin is never satisfied by something older, whatever the policy.
    assert.equal(sdkSatisfiesPin('9.0.312', pin('10.0.303', 'latestMajor')), false);
  });

  test('parseSdkVersion splits the feature band from the patch', () => {
    assert.deepEqual(parseSdkVersion('10.0.303'), { major: 10, minor: 0, band: 300, patch: 3 });
    assert.deepEqual(parseSdkVersion('10.0.203'), { major: 10, minor: 0, band: 200, patch: 3 });
    assert.deepEqual(parseSdkVersion('10.0.100-preview.2'), {
      major: 10,
      minor: 0,
      band: 100,
      patch: 0,
    });
    assert.equal(parseSdkVersion('10.0'), undefined, 'major.minor alone is not an SDK version');
    assert.equal(parseSdkVersion('not.a.version'), undefined);
  });

  test('readSdkPin reads the nearest global.json and defaults rollForward', () => {
    const pinned = fakeWorkspace(
      'pinned',
      JSON.stringify({ sdk: { version: '10.0.303', rollForward: 'latestPatch' } }),
    );
    const found = readSdkPin(pinned);
    assert.equal(found?.version, '10.0.303');
    assert.equal(found?.rollForward, 'latestPatch');
    assert.equal(found?.source, path.join(pinned, 'global.json'));

    // A nested directory resolves the same pin as the root that declares it.
    const nested = path.join(pinned, 'src', 'examples');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(readSdkPin(nested)?.version, '10.0.303', 'the pin governs nested directories');
    assert.equal(findGlobalJson(nested), path.join(pinned, 'global.json'));

    // rollForward omitted means latestPatch, which is the strictest policy.
    const bare = fakeWorkspace('bare', JSON.stringify({ sdk: { version: '10.0.303' } }));
    assert.equal(readSdkPin(bare)?.rollForward, DEFAULT_ROLL_FORWARD);

    // Malformed or SDK-less files pin nothing rather than throwing.
    assert.equal(readSdkPin(fakeWorkspace('broken', '{ not json')), undefined);
    assert.equal(readSdkPin(fakeWorkspace('empty', JSON.stringify({}))), undefined);
  });

  test('installedSdkVersions enumerates the SDKs beside a dotnet executable', () => {
    const exe = fakeDotnet('root', ['10.0.203', '9.0.312']);
    assert.deepEqual(installedSdkVersions(exe), ['10.0.203', '9.0.312']);
    assert.deepEqual(installedSdkVersions(path.join(scratchDir, 'absent', 'dotnet')), []);
  });

  // ── The bug: acquisition accepted an SDK the workspace could never use ──

  test('an installed SDK that cannot satisfy the workspace pin is not usable', () => {
    const workspace = fakeWorkspace(
      'ws',
      JSON.stringify({ sdk: { version: '10.0.303', rollForward: 'latestPatch' } }),
    );
    const broken = fakeDotnet('broken', ['9.0.312', '10.0.203']);
    const working = fakeDotnet('working', ['9.0.312', '10.0.303']);

    assert.equal(
      existingSdkSatisfiesWorkspace(broken, workspace),
      false,
      'a 10.0.203-only install cannot satisfy a 10.0.303 pin, so acquisition must not be skipped',
    );
    assert.equal(
      existingSdkSatisfiesWorkspace(working, workspace),
      true,
      'an install carrying the pinned SDK is usable',
    );

    // With no pin at all, any .NET 10 SDK the Install Tool found is usable.
    const unpinned = path.join(scratchDir, 'unpinned');
    fs.mkdirSync(unpinned, { recursive: true });
    assert.equal(existingSdkSatisfiesWorkspace(broken, unpinned), true);
  });

  test('the pin failure message names the pin, its file, and what is installed', () => {
    const workspace = fakeWorkspace(
      'diag',
      JSON.stringify({ sdk: { version: '10.0.303', rollForward: 'latestPatch' } }),
    );
    const broken = fakeDotnet('diag-sdk', ['9.0.312', '10.0.203']);

    const message = describeSdkPinFailure(broken, workspace);
    assert.ok(message !== undefined, 'an unsatisfiable pin must produce a diagnosis');
    assert.ok(message.includes('10.0.303'), `names the pinned version: ${message}`);
    assert.ok(message.includes('latestPatch'), `names the rollForward policy: ${message}`);
    assert.ok(
      message.includes(path.join(workspace, 'global.json')),
      `names the global.json responsible: ${message}`,
    );
    assert.ok(message.includes('10.0.203'), `names what is actually installed: ${message}`);

    // A satisfiable pin produces no diagnosis at all.
    const working = fakeDotnet('diag-ok', ['10.0.303']);
    assert.equal(describeSdkPinFailure(working, workspace), undefined);
  });

  test('a build that dies on the SDK pin is diagnosed, not reported as exit code 155', () => {
    const workspace = fakeWorkspace(
      'build-ws',
      JSON.stringify({ sdk: { version: '10.0.303', rollForward: 'latestPatch' } }),
    );
    const broken = fakeDotnet('build-sdk', ['9.0.312', '10.0.203']);

    const diagnosis = diagnoseBuildFailure(SDK_RESOLUTION_EXIT_CODE, broken, workspace);
    assert.ok(diagnosis !== undefined, 'exit code 155 must be explained, not passed through');
    assert.ok(diagnosis.includes('10.0.303'), 'the diagnosis names the SDK the build needed');
    assert.ok(diagnosis.includes('10.0.203'), 'the diagnosis names what is installed instead');

    // A successful build is never second-guessed.
    assert.equal(diagnoseBuildFailure(0, broken, workspace), undefined);
    assert.equal(diagnoseBuildFailure(undefined, broken, workspace), undefined);

    // A genuine compile failure on a satisfiable pin is left to $msCompile.
    const working = fakeDotnet('build-ok', ['10.0.303']);
    assert.equal(
      diagnoseBuildFailure(1, working, workspace),
      undefined,
      'ordinary compile errors must not be blamed on the SDK',
    );

    // No workspace means no global.json to blame.
    assert.equal(diagnoseBuildFailure(SDK_RESOLUTION_EXIT_CODE, broken, undefined), undefined);
  });
});

/**
 * Activation must point every `dotnet` child at the SDK it actually resolved.
 *
 * CI installs the pinned SDK onto `$PATH`, so a bare `dotnet` and the resolved
 * one are the same binary there and this defect is invisible. It only appears
 * where `$PATH`'s SDK differs from the workspace pin — which is every machine
 * that has not installed the pinned band. Implements [DIST-RUNTIME-ACQUIRE].
 */
suite('resolved SDK reaches dotnet-spawning features', () => {
  test('build tasks run the resolved SDK, not whatever $PATH provides', async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('nimblesite.sharplsp');
    assert.ok(extension !== undefined, 'the extension under test must be installed');
    await extension.activate();

    const tasks = await vscode.tasks.fetchTasks({ type: 'sharplsp-build' });
    assert.ok(tasks.length > 0, 'the build task provider must contribute tasks');

    for (const task of tasks) {
      const execution = task.execution;
      assert.ok(
        execution instanceof vscode.ProcessExecution,
        `${task.name} must run dotnet as a process execution`,
      );
      assert.notEqual(
        execution.process,
        'dotnet',
        `${task.name} must not fall back to $PATH: activation resolved a specific SDK, ` +
          'and a bare "dotnet" silently runs a different one',
      );
      assert.ok(
        path.isAbsolute(execution.process),
        `${task.name} must invoke an absolute SDK path, got ${execution.process}`,
      );
    }
  });
});
