// Implements [DIST-API-PARAMETERS] + [DIST-FAILURE-UX] + [DIST-RUNTIME-ACQUIRE].
//
// These tests pin the contract with the .NET Install Tool extension by
// monkey-patching `vscode.commands.executeCommand` and asserting on the
// payloads SharpLsp sends. They prove:
//   1. SharpLsp acquires a .NET 10 *SDK* (mode 'sdk', installType 'global')
//      via `dotnet.acquireGlobalSDK` — NOT a runtime-only `dotnet.acquire`.
//      The sidecar's MSBuildLocator enumerates installed SDKs, so a runtime
//      alone (the original v0.1.x behaviour) leaves MSBuild unable to load
//      projects on a machine that has, e.g., only the .NET 9 SDK.
//   2. `acquireDotnet10Sdk` returns a Result and never throws — the silent
//      failure mode is structurally impossible.
//   3. The user-facing failure notification names the SDK in plain language.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  acquireDotnet10Sdk,
  dotnetArchitecture,
  dotnetRootFromPath,
  showAcquireFailureNotification,
} from '../../dotnetRuntime.js';
import { type Result } from '../../result.js';
import { SharpLspStatusBar } from '../../status.js';

interface CommandCall {
  readonly command: string;
  readonly payload: unknown;
}

interface PatchHandle {
  readonly calls: CommandCall[];
  restore(): void;
}

/**
 * Replace `vscode.commands.executeCommand` with a stub that records every
 * `dotnet.*` call and returns a configured response. All other commands are
 * forwarded to the real runtime so the test host stays functional.
 */
function patchExecuteCommand(routes: Record<string, unknown>): PatchHandle {
  const calls: CommandCall[] = [];
  const original = vscode.commands.executeCommand.bind(vscode.commands);
  // Cast the stub through `unknown` because the public signature is heavily
  // overloaded and TS cannot match a single replacement to all overloads.
  const stub = ((command: string, ...args: unknown[]) => {
    if (command.startsWith('dotnet.')) {
      calls.push({ command, payload: args[0] });
      const route = routes[command];
      if (route !== undefined) {
        const value = typeof route === 'function' ? (route as () => unknown)() : route;
        return Promise.resolve(value);
      }
      return Promise.resolve(undefined);
    }
    return original(command, ...args);
  }) as unknown as typeof vscode.commands.executeCommand;
  (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand =
    stub;
  return {
    calls,
    restore() {
      (
        vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }
      ).executeCommand = original;
    },
  };
}

function makeStatusBar(): SharpLspStatusBar {
  return new SharpLspStatusBar();
}

suite('dotnetArchitecture()', () => {
  test('returns one of x64 / arm64 / x86', () => {
    const arch = dotnetArchitecture();
    assert.ok(
      arch === 'x64' || arch === 'arm64' || arch === 'x86',
      `Expected x64/arm64/x86, got ${arch}`,
    );
  });

  test('matches the host process.arch family', () => {
    const arch = dotnetArchitecture();
    if (process.arch === 'x64') assert.strictEqual(arch, 'x64');
    else if (process.arch === 'arm64') assert.strictEqual(arch, 'arm64');
    else if (process.arch === 'ia32') assert.strictEqual(arch, 'x86');
    else assert.strictEqual(arch, 'x64', 'unknown arch must default to x64');
  });
});

suite('dotnetRootFromPath()', () => {
  test('returns the directory containing the dotnet executable', () => {
    const root = dotnetRootFromPath('/some/dir/dotnet.exe');
    assert.strictEqual(root, path.dirname('/some/dir/dotnet.exe'));
  });
});

suite('[DIST-RUNTIME-ACQUIRE] acquires the SDK, never a runtime-only install', () => {
  let patch: PatchHandle | undefined;
  let statusBar: SharpLspStatusBar | undefined;

  teardown(() => {
    patch?.restore();
    patch = undefined;
    statusBar?.dispose();
    statusBar = undefined;
  });

  test('invokes dotnet.acquireGlobalSDK (SDK), not dotnet.acquire (runtime), on a findPath miss', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquireGlobalSDK': { dotnetPath: '/fake/sdk/dotnet' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, true, `expected Ok, got ${JSON.stringify(result)}`);
    if (result.ok) assert.strictEqual(result.value, '/fake/sdk/dotnet');

    const sdkCall = patch.calls.find((c) => c.command === 'dotnet.acquireGlobalSDK');
    assert.ok(sdkCall, 'dotnet.acquireGlobalSDK (the SDK installer) was not invoked');

    const runtimeCall = patch.calls.find((c) => c.command === 'dotnet.acquire');
    assert.strictEqual(
      runtimeCall,
      undefined,
      'dotnet.acquire (runtime-only) MUST NOT be used — the sidecar needs an SDK for MSBuild',
    );
  });
});

suite('[DIST-API-PARAMETERS] dotnet.acquireGlobalSDK payload', () => {
  let patch: PatchHandle | undefined;
  let statusBar: SharpLspStatusBar | undefined;

  teardown(() => {
    patch?.restore();
    patch = undefined;
    statusBar?.dispose();
    statusBar = undefined;
  });

  test('includes version/mode/architecture/requestingExtensionId/installType when findPath misses', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquireGlobalSDK': { dotnetPath: '/fake/sdk/dotnet' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, true, `expected Ok, got ${JSON.stringify(result)}`);
    const sdkCall = patch.calls.find((c) => c.command === 'dotnet.acquireGlobalSDK');
    assert.ok(sdkCall, 'dotnet.acquireGlobalSDK was not invoked');
    const payload = sdkCall.payload as Record<string, unknown>;
    assert.strictEqual(payload['version'], '10.0', 'version must be major.minor "10.0"');
    assert.strictEqual(payload['mode'], 'sdk', 'mode must be "sdk"');
    assert.strictEqual(payload['installType'], 'global', 'installType must be "global"');
    assert.strictEqual(payload['requestingExtensionId'], 'nimblesite.sharplsp');
    assert.ok(
      payload['architecture'] === 'x64' ||
        payload['architecture'] === 'arm64' ||
        payload['architecture'] === 'x86',
      `architecture missing or invalid: ${String(payload['architecture'])}`,
    );
  });

  test('skips acquisition when findPath returns a compatible SDK path that exists on disk', async () => {
    // acquireDotnet10Sdk validates that findPath's result actually exists on
    // disk (dotnetRuntime.ts: `fs.existsSync`) so a stale path is never
    // trusted. The mock must point at a real existing file; process.execPath
    // is always present in the test host.
    const compatiblePath = process.execPath;
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: compatiblePath },
      'dotnet.acquireGlobalSDK': { dotnetPath: '/should/not/be/used' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.value, compatiblePath);
    }
    const acquireCalled = patch.calls.some((c) => c.command === 'dotnet.acquireGlobalSDK');
    assert.strictEqual(acquireCalled, false, 'acquireGlobalSDK must be skipped on findPath hit');
  });

  test('dotnet.findPath asks for an SDK (mode sdk) >= 10.0 with architecture', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: '/x/dotnet' },
    });
    statusBar = makeStatusBar();

    await acquireDotnet10Sdk(statusBar);

    const findCall = patch.calls.find((c) => c.command === 'dotnet.findPath');
    assert.ok(findCall, 'dotnet.findPath was not invoked');
    const payload = findCall.payload as {
      acquireContext?: Record<string, unknown>;
      versionSpecRequirement?: string;
    };
    assert.ok(payload.acquireContext, 'findPath payload missing acquireContext');
    assert.strictEqual(payload.acquireContext['version'], '10.0');
    assert.strictEqual(payload.acquireContext['mode'], 'sdk', 'findPath must look for an SDK');
    assert.ok(
      payload.acquireContext['architecture'],
      'findPath acquireContext must include architecture (the v0.1.0 bug)',
    );
    assert.strictEqual(
      payload.versionSpecRequirement,
      'greater_than_or_equal',
      'any SDK >= 10.0 should satisfy the requirement',
    );
  });

  test('a stale findPath path (not on disk) falls through to SDK acquisition', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: '/definitely/not/on/disk/dotnet' },
      'dotnet.acquireGlobalSDK': { dotnetPath: '/freshly/installed/dotnet' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, true);
    if (result.ok) assert.strictEqual(result.value, '/freshly/installed/dotnet');
    assert.ok(
      patch.calls.some((c) => c.command === 'dotnet.acquireGlobalSDK'),
      'stale findPath must trigger acquisition',
    );
  });
});

suite('[DIST-FAILURE-UX] acquireDotnet10Sdk never throws', () => {
  let patch: PatchHandle | undefined;
  let statusBar: SharpLspStatusBar | undefined;

  teardown(() => {
    patch?.restore();
    patch = undefined;
    statusBar?.dispose();
    statusBar = undefined;
  });

  test('returns Err when acquireGlobalSDK rejects, never throws', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquireGlobalSDK': () => {
        throw new Error('install tool exploded');
      },
    });
    statusBar = makeStatusBar();

    const result: Result<string> = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(
        result.error,
        /install tool exploded/,
        `expected error to mention upstream cause, got: ${result.error}`,
      );
    }
  });

  test('returns Err when acquireGlobalSDK returns no dotnetPath', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquireGlobalSDK': {},
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /dotnetPath/i);
    }
  });

  test('returns Err when acquireGlobalSDK returns empty dotnetPath', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquireGlobalSDK': { dotnetPath: '' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, false);
  });

  test('treats dotnet.findPath errors as a miss, not a throw', async () => {
    // Reproduces the v0.1.0 production scenario: findPath rejects with the
    // "missing required information" message. The helper must tolerate a
    // findPath miss without throwing and fall through to acquisition.
    patch = patchExecuteCommand({
      'dotnet.findPath': () => {
        throw new Error('missing required information');
      },
      'dotnet.acquireGlobalSDK': { dotnetPath: '/fallback/dotnet' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.value, '/fallback/dotnet');
    }
  });
});

suite('[DIST-FAILURE-UX] showAcquireFailureNotification names the SDK in plain language', () => {
  let originalShowError: typeof vscode.window.showErrorMessage;
  let captured: string | undefined;

  setup(() => {
    captured = undefined;
    originalShowError = vscode.window.showErrorMessage.bind(vscode.window);
    const stub = ((message: string) => {
      captured = message;
      return Promise.resolve(undefined);
    }) as unknown as typeof vscode.window.showErrorMessage;
    (
      vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }
    ).showErrorMessage = stub;
  });

  teardown(() => {
    (
      vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }
    ).showErrorMessage = originalShowError;
  });

  test('the toast mentions the .NET 10 SDK and the underlying cause', async () => {
    await showAcquireFailureNotification('network down', 'sharplsp.retryDotnetAcquisition');
    assert.ok(captured, 'an error notification must be shown');
    assert.match(captured ?? '', /\.NET 10 SDK/, 'message must name the .NET 10 SDK');
    assert.match(captured ?? '', /network down/, 'message must include the underlying cause');
  });
});
