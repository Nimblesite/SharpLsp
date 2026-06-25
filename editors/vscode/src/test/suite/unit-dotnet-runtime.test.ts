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
  INSTALL_TOOL_EXTENSION_ID,
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

// ── dotnetArchitecture() process.arch fallback branches ──────────────

interface ArchOverride {
  restore(): void;
}

/**
 * Temporarily override `process.arch` so the rarely-hit mapping branches
 * (`ia32` → x86, and the unknown-arch default → x64) execute regardless of the
 * host CPU. The descriptor is restored verbatim in `restore()`.
 */
function overrideArch(arch: string): ArchOverride {
  const original = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'arch', {
    value: arch,
    configurable: true,
    writable: false,
    enumerable: true,
  });
  return {
    restore() {
      if (original !== undefined) {
        Object.defineProperty(process, 'arch', original);
      }
    },
  };
}

suite('dotnetArchitecture() — process.arch mapping branches', () => {
  let override: ArchOverride | undefined;

  teardown(() => {
    override?.restore();
    override = undefined;
  });

  test('maps ia32 to the .NET "x86" identifier', () => {
    override = overrideArch('ia32');
    assert.strictEqual(dotnetArchitecture(), 'x86');
  });

  test('maps x64 to "x64"', () => {
    override = overrideArch('x64');
    assert.strictEqual(dotnetArchitecture(), 'x64');
  });

  test('maps arm64 to "arm64"', () => {
    override = overrideArch('arm64');
    assert.strictEqual(dotnetArchitecture(), 'arm64');
  });

  test('defaults an unknown arch (e.g. mips) to "x64"', () => {
    override = overrideArch('mips');
    assert.strictEqual(dotnetArchitecture(), 'x64', 'unrecognised arch must fall back to x64');
  });
});

// ── ensureInstallToolActivated() branches via vscode.extensions.getExtension ──

interface MinimalExtension {
  isActive: boolean;
  activate(): Promise<unknown>;
}

interface ExtensionsPatch {
  restore(): void;
}

/**
 * Stub `vscode.extensions.getExtension` so `acquireDotnet10Sdk` sees a
 * controlled install-tool extension: `undefined` (not installed), an already
 * inactive one whose `activate()` resolves, or one whose `activate()` rejects.
 * Only the install-tool id is intercepted; everything else is delegated.
 */
function patchGetExtension(result: MinimalExtension | undefined | 'real'): ExtensionsPatch {
  const target = vscode.extensions as {
    getExtension: typeof vscode.extensions.getExtension;
  };
  const original = target.getExtension.bind(vscode.extensions);
  const stub = ((extensionId: string) => {
    if (extensionId === INSTALL_TOOL_EXTENSION_ID && result !== 'real') {
      return result as unknown as ReturnType<typeof vscode.extensions.getExtension>;
    }
    return original(extensionId);
  }) as unknown as typeof vscode.extensions.getExtension;
  target.getExtension = stub;
  return {
    restore() {
      target.getExtension = original;
    },
  };
}

suite('[DIST-RUNTIME-ACQUIRE] ensureInstallToolActivated() failure + activation branches', () => {
  let patch: PatchHandle | undefined;
  let extPatch: ExtensionsPatch | undefined;
  let statusBar: SharpLspStatusBar | undefined;

  teardown(() => {
    patch?.restore();
    patch = undefined;
    extPatch?.restore();
    extPatch = undefined;
    statusBar?.dispose();
    statusBar = undefined;
  });

  test('returns Err naming the install tool when the extension is not installed', async () => {
    extPatch = patchGetExtension(undefined);
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, false, 'a missing install tool must short-circuit to Err');
    if (!result.ok) {
      assert.match(result.error, /not installed/i, 'error must explain the tool is missing');
      assert.ok(
        result.error.includes(INSTALL_TOOL_EXTENSION_ID),
        'error must name the install-tool extension id',
      );
    }
  });

  test('does not invoke any dotnet.* command when the install tool is absent', async () => {
    extPatch = patchGetExtension(undefined);
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: '/should/not/be/used' },
      'dotnet.acquireGlobalSDK': { dotnetPath: '/should/not/be/used' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(
      patch.calls.length,
      0,
      'no acquisition/find command may run before the install tool is confirmed present',
    );
  });

  test('activates an inactive install tool, then proceeds to findPath', async () => {
    let activated = false;
    extPatch = patchGetExtension({
      isActive: false,
      activate: () => {
        activated = true;
        return Promise.resolve(undefined);
      },
    });
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: process.execPath },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.ok(activated, 'an inactive install tool must be activated before any command runs');
    assert.strictEqual(result.ok, true, 'after activation the existing SDK lookup must succeed');
    if (result.ok) assert.strictEqual(result.value, process.execPath);
    assert.ok(
      patch.calls.some((c) => c.command === 'dotnet.findPath'),
      'findPath must run once the tool is active',
    );
  });

  test('returns Err (never throws) when the install tool fails to activate', async () => {
    extPatch = patchGetExtension({
      isActive: false,
      activate: () => Promise.reject(new Error('activation kaboom')),
    });
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: process.execPath },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10Sdk(statusBar);

    assert.strictEqual(result.ok, false, 'a failed activation must surface as Err');
    if (!result.ok) {
      assert.match(result.error, /failed to activate/i);
      assert.match(result.error, /activation kaboom/, 'error must include the underlying cause');
    }
    assert.strictEqual(patch.calls.length, 0, 'no dotnet.* command may run if activation failed');
  });
});

// ── showAcquireFailureNotification() button branches ─────────────────

interface NotificationSeams {
  restore(): void;
}

suite('[DIST-FAILURE-UX] showAcquireFailureNotification() handles each button choice', () => {
  let originalShowError: typeof vscode.window.showErrorMessage;
  let originalOpenExternal: typeof vscode.env.openExternal;
  let originalExecuteCommand: typeof vscode.commands.executeCommand;
  let openedUri: vscode.Uri | undefined;
  let executedCommand: string | undefined;

  /** Replace `showErrorMessage` so it returns the caller-chosen button label. */
  function patchSeams(choice: string | undefined): NotificationSeams {
    openedUri = undefined;
    executedCommand = undefined;

    const win = vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage };
    const errStub = (() =>
      Promise.resolve(choice)) as unknown as typeof vscode.window.showErrorMessage;
    win.showErrorMessage = errStub;

    const env = vscode.env as { openExternal: typeof vscode.env.openExternal };
    const openStub = ((uri: vscode.Uri) => {
      openedUri = uri;
      return Promise.resolve(true);
    }) as unknown as typeof vscode.env.openExternal;
    env.openExternal = openStub;

    const cmds = vscode.commands as { executeCommand: typeof vscode.commands.executeCommand };
    const cmdStub = ((command: string) => {
      executedCommand = command;
      return Promise.resolve(undefined);
    }) as unknown as typeof vscode.commands.executeCommand;
    cmds.executeCommand = cmdStub;

    return {
      restore() {
        win.showErrorMessage = originalShowError;
        env.openExternal = originalOpenExternal;
        cmds.executeCommand = originalExecuteCommand;
      },
    };
  }

  let seams: NotificationSeams | undefined;

  setup(() => {
    originalShowError = vscode.window.showErrorMessage.bind(vscode.window);
    originalOpenExternal = vscode.env.openExternal.bind(vscode.env);
    originalExecuteCommand = vscode.commands.executeCommand.bind(vscode.commands);
  });

  teardown(() => {
    seams?.restore();
    seams = undefined;
  });

  test('"Open dot.net" opens the .NET 10 download page and runs no command', async () => {
    seams = patchSeams('Open dot.net');

    await showAcquireFailureNotification('boom', 'sharplsp.retryDotnetAcquisition');

    assert.ok(openedUri !== undefined, 'choosing "Open dot.net" must open an external URL');
    assert.match(
      openedUri?.toString() ?? '',
      /dotnet\.microsoft\.com\/download\/dotnet\/10\.0/,
      'must navigate to the .NET 10 download page',
    );
    assert.strictEqual(
      executedCommand,
      undefined,
      'opening the page must not run the retry command',
    );
  });

  test('"Show Log" reveals the output channel and runs no command', async () => {
    seams = patchSeams('Show Log');

    await showAcquireFailureNotification('boom', 'sharplsp.retryDotnetAcquisition');

    assert.strictEqual(openedUri, undefined, '"Show Log" must not open an external URL');
    assert.strictEqual(executedCommand, undefined, '"Show Log" must not run the retry command');
  });

  test('"Retry" invokes the supplied retry command id', async () => {
    seams = patchSeams('Retry');

    await showAcquireFailureNotification('boom', 'sharplsp.retryDotnetAcquisition');

    assert.strictEqual(
      executedCommand,
      'sharplsp.retryDotnetAcquisition',
      '"Retry" must execute exactly the retry command id passed in',
    );
    assert.strictEqual(openedUri, undefined, '"Retry" must not open an external URL');
  });

  test('dismissing the toast (no choice) performs no side effects', async () => {
    seams = patchSeams(undefined);

    await showAcquireFailureNotification('boom', 'sharplsp.retryDotnetAcquisition');

    assert.strictEqual(openedUri, undefined, 'a dismissed toast must not open a URL');
    assert.strictEqual(executedCommand, undefined, 'a dismissed toast must not run a command');
  });
});
