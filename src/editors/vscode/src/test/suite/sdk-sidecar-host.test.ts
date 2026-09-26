import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireDotnet10Sdk, existingSdkSatisfiesWorkspace } from '../../dotnetRuntime.js';
import { supportsSidecars } from '../../dotnet-host.js';
import { verifyDeployment } from '../../deployment.js';
import { installedSdkVersions } from '../../global-json.js';
import { SharpLspStatusBar } from '../../status.js';
import { removeDirRecursive } from './test-helpers.js';
import { installUiStubs, type UiStubs } from './ui-stubs.js';
import {
  FRAMEWORK_MISSING_EXIT,
  assertSidecarsRun,
  copySdkMajor,
  describeRun,
  launchSidecar,
  runHost,
  sdkSource,
  selectRuntimeVersion,
  stageSdk,
  stubSdkWorkspace,
} from './sdk-host-kit.js';
import { DOTNET_CLI_MS } from './test-timeouts.js';

// #297: an older workspace SDK must never evict the runtime both sidecars require.
// Implements [DIST-RUNTIME-ACQUIRE], exercising the actual acquisition entry point.
suite('SDK pin preserves the sidecar host', () => {
  let scratch: string;
  let modernSource: string;
  let oldHost: string;
  let modernHost: string;
  let pinnedVersion: string;
  let restore: (() => void) | undefined;
  let previousRoot: string | undefined;
  let ui: UiStubs;
  let status: SharpLspStatusBar;

  setup(async function () {
    this.timeout(DOTNET_CLI_MS);
    modernSource = sdkSource(10);
    const oldSource = sdkSource(9);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-sdk-host-'));
    [oldHost, modernHost] = await Promise.all([
      copySdkMajor(oldSource, path.join(scratch, 'old'), 9),
      copySdkMajor(modernSource, path.join(scratch, 'modern'), 10),
    ]);
    pinnedVersion = installedSdkVersions(oldHost)[0]!;
    fs.writeFileSync(
      path.join(scratch, 'global.json'),
      JSON.stringify({
        sdk: { version: pinnedVersion, rollForward: 'disable' },
      }),
    );
    previousRoot = process.env['DOTNET_ROOT'];
    process.env['DOTNET_ROOT'] = path.dirname(oldHost);
    ui = installUiStubs();
    status = new SharpLspStatusBar();
  });

  teardown(() => {
    restore?.();
    restore = undefined;
    ui.restore();
    status.dispose();
    if (previousRoot === undefined) delete process.env['DOTNET_ROOT'];
    else process.env['DOTNET_ROOT'] = previousRoot;
    removeDirRecursive(scratch);
  });

  async function acquireRunnableHost(): Promise<string> {
    const selected = await acquireDotnet10Sdk(status);
    assert.ok(selected.ok, JSON.stringify(selected));
    assertSidecarsRun(selected.value, scratch);
    return selected.value;
  }

  test('deployment verification uses the acquired SDK rather than inherited DOTNET_ROOT', async function () {
    this.timeout(DOTNET_CLI_MS);
    const selected = await verifyDeployment(path.resolve(__dirname, '../../..'), modernHost);
    assert.equal(selected.ok, true, JSON.stringify(selected.diagnostics));
    for (const language of ['fsharp', 'csharp']) {
      const diagnostic = selected.diagnostics.find(
        (item) => item.componentId === `sharplsp-sidecar-${language}`,
      );
      assert.equal(diagnostic?.blocking, false);
      assert.equal(diagnostic?.resolution.status, 'ok');
    }
    assert.equal(process.env['DOTNET_ROOT'], path.dirname(oldHost), 'do not mutate the editor');
  });

  for (const [version, compatible] of [
    ['9.0.99', false],
    ['10.0.0-rc.2', false],
    ['10.0.0', true],
    ['10.0.99-rc.1', true],
    ['11.0.0-preview.1', true],
  ] as const) {
    test(`runtime floor agrees with both real sidecars for ${version}`, async function () {
      this.timeout(DOTNET_CLI_MS);
      // These are real installed runtime bits with remapped directory versions,
      // testing hostfxr selection, not claiming preview SDKs were downloaded.
      selectRuntimeVersion(path.dirname(modernHost), version);
      for (const language of ['FSharp', 'CSharp'] as const) {
        const run = launchSidecar(modernHost, scratch, language);
        assert.equal(
          run.status,
          compatible ? 0 : FRAMEWORK_MISSING_EXIT,
          describeRun(`${language} on a ${version} runtime`, run),
        );
        assert.equal(run.signal, null, describeRun(`${language} must decide, not time out`, run));
      }
      assert.equal(await supportsSidecars(modernHost), compatible, version);
    });
  }

  test('an older pin in a separate root is installed automatically without breaking either sidecar', async function () {
    this.timeout(DOTNET_CLI_MS);
    const requested: string[] = [];
    restore = stubSdkWorkspace(
      scratch,
      () => modernHost,
      async (version) => {
        requested.push(version);
        return await copySdkMajor(path.dirname(oldHost), path.dirname(modernHost), 9);
      },
    );
    assert.equal(runHost(oldHost, scratch, ['--version']).stdout.trim(), pinnedVersion);
    const selected = await acquireRunnableHost();
    assert.equal(selected, modernHost, 'keep the host that runs both sidecars');
    assert.deepEqual(requested, [pinnedVersion], 'the Install Tool must install the exact pin');
    assert.equal(runHost(selected, scratch, ['--version']).stdout.trim(), pinnedVersion);
    assert.deepEqual(ui.log.errorMessages, [], 'no manual install prompt replaces acquisition');
  });

  test('fresh acquisition installs both the pinned SDK and the .NET 10 sidecar SDK', async function () {
    this.timeout(DOTNET_CLI_MS);
    const requested: string[] = [];
    restore = stubSdkWorkspace(
      scratch,
      () => undefined,
      async (version) => {
        requested.push(version);
        if (version === '10.0') await copySdkMajor(modernSource, path.dirname(oldHost), 10);
        return oldHost;
      },
    );
    const selected = await acquireRunnableHost();
    assert.deepEqual(requested, [pinnedVersion, '10.0']);
    assert.equal(existingSdkSatisfiesWorkspace(selected, scratch), true);
    assert.equal(runHost(selected, scratch, ['--version']).stdout.trim(), pinnedVersion);
  });

  test('a root carrying both SDKs preserves the pin without acquisition or warnings', async function () {
    this.timeout(DOTNET_CLI_MS);
    await copySdkMajor(modernSource, path.dirname(oldHost), 10);
    restore = stubSdkWorkspace(
      scratch,
      () => modernHost,
      () => assert.fail('already installed'),
    );
    const selected = await acquireRunnableHost();
    assert.equal(selected, oldHost);
    assert.equal(runHost(selected, scratch, ['--version']).stdout.trim(), pinnedVersion);
    assert.deepEqual(ui.log.errorMessages, []);
  });

  test('SDK files without the required runtime are rejected even when installation reports success', async function () {
    this.timeout(DOTNET_CLI_MS);
    // ONE real 10 SDK, not every installed one: `fs.cpSync` is synchronous, so
    // copying the whole `sdk` tree blocks the event loop past the point where
    // mocha could even report the timeout it caused (#297 CI).
    stageSdk(path.dirname(oldHost), 10);
    assert.ok(installedSdkVersions(oldHost).some((sdk) => sdk.startsWith('10.')));
    assert.equal(runHost(oldHost, scratch, ['--version']).stdout.trim(), pinnedVersion);
    restore = stubSdkWorkspace(
      scratch,
      () => oldHost,
      () => oldHost,
    );
    const selected = await acquireDotnet10Sdk(status);
    assert.equal(selected.ok, false, 'SDK directories alone cannot prove the sidecars can start');
    assert.ok(!selected.ok && selected.error.includes('SDK/runtime'));
    assert.ok(!selected.ok && selected.error.includes(pinnedVersion));
  });

  test('an installer result that runs sidecars but violates the pin is not a fallback', async function () {
    this.timeout(DOTNET_CLI_MS);
    restore = stubSdkWorkspace(
      scratch,
      () => modernHost,
      () => modernHost,
    );
    const selected = await acquireDotnet10Sdk(status);
    assert.equal(selected.ok, false, 'never return an unpinned host as success');
    assert.ok(!selected.ok && selected.error.includes(pinnedVersion));
    assert.equal(existingSdkSatisfiesWorkspace(modernHost, scratch), false);
  });

  test('an installer failure never falls back to an existing incompatible SDK', async function () {
    this.timeout(DOTNET_CLI_MS);
    restore = stubSdkWorkspace(
      scratch,
      () => modernHost,
      () => {
        throw new Error('SDK install refused');
      },
    );
    const selected = await acquireDotnet10Sdk(status);
    assert.equal(selected.ok, false, 'installation failure must remain a failure');
    assert.ok(!selected.ok && selected.error.includes('SDK install refused'));
    assert.deepEqual(ui.log.errorMessages, [], 'the acquisition caller owns failure reporting');
  });
});
