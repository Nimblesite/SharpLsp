// Implements [DIST-API-PARAMETERS] + [DIST-FAILURE-UX].
//
// These tests pin the contract with the .NET Install Tool extension by
// monkey-patching `vscode.commands.executeCommand` and asserting on the
// payloads SharpLsp sends. They also prove `acquireDotnet10` returns a
// Result and never throws — the bug that produced the silent v0.1.0
// failure mode is now structurally impossible.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { acquireDotnet10, dotnetArchitecture, dotnetRootFromPath } from '../../dotnetRuntime.js';
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

suite('[DIST-API-PARAMETERS] dotnet.acquire payload', () => {
  let patch: PatchHandle | undefined;
  let statusBar: SharpLspStatusBar | undefined;

  teardown(() => {
    patch?.restore();
    patch = undefined;
    statusBar?.dispose();
    statusBar = undefined;
  });

  test('includes all four required fields when findPath misses', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquire': { dotnetPath: '/fake/dotnet' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10(statusBar);

    assert.strictEqual(result.ok, true, `expected Ok, got ${JSON.stringify(result)}`);
    const acquireCall = patch.calls.find((c) => c.command === 'dotnet.acquire');
    assert.ok(acquireCall, 'dotnet.acquire was not invoked');
    const payload = acquireCall.payload as Record<string, unknown>;
    assert.strictEqual(payload['version'], '10.0', 'version must be major.minor "10.0"');
    assert.strictEqual(payload['mode'], 'runtime', 'mode must be "runtime"');
    assert.strictEqual(payload['requestingExtensionId'], 'nimblesite.sharplsp');
    assert.ok(
      payload['architecture'] === 'x64' ||
        payload['architecture'] === 'arm64' ||
        payload['architecture'] === 'x86',
      `architecture missing or invalid: ${String(payload['architecture'])}`,
    );
  });

  test('skips dotnet.acquire when findPath returns a compatible path', async () => {
    // acquireDotnet10 validates that findPath's result actually exists on disk
    // (dotnetRuntime.ts: `fs.existsSync`) so a stale path is never trusted. The
    // mock must therefore point at a real existing file to represent a
    // "compatible path"; process.execPath is always present in the test host.
    const compatiblePath = process.execPath;
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: compatiblePath },
      'dotnet.acquire': { dotnetPath: '/should/not/be/used' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10(statusBar);

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.value, compatiblePath);
    }
    const acquireCalled = patch.calls.some((c) => c.command === 'dotnet.acquire');
    assert.strictEqual(acquireCalled, false, 'dotnet.acquire must be skipped on findPath hit');
  });

  test('dotnet.findPath payload includes architecture inside acquireContext', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': { dotnetPath: '/x/dotnet' },
    });
    statusBar = makeStatusBar();

    await acquireDotnet10(statusBar);

    const findCall = patch.calls.find((c) => c.command === 'dotnet.findPath');
    assert.ok(findCall, 'dotnet.findPath was not invoked');
    const payload = findCall.payload as { acquireContext?: Record<string, unknown> };
    assert.ok(payload.acquireContext, 'findPath payload missing acquireContext');
    assert.strictEqual(payload.acquireContext['version'], '10.0');
    assert.strictEqual(payload.acquireContext['mode'], 'runtime');
    assert.ok(
      payload.acquireContext['architecture'],
      'findPath acquireContext must include architecture (the v0.1.0 bug)',
    );
  });
});

suite('[DIST-FAILURE-UX] acquireDotnet10 never throws', () => {
  let patch: PatchHandle | undefined;
  let statusBar: SharpLspStatusBar | undefined;

  teardown(() => {
    patch?.restore();
    patch = undefined;
    statusBar?.dispose();
    statusBar = undefined;
  });

  test('returns Err when dotnet.acquire rejects, never throws', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquire': () => {
        throw new Error('install tool exploded');
      },
    });
    statusBar = makeStatusBar();

    const result: Result<string> = await acquireDotnet10(statusBar);

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(
        result.error,
        /install tool exploded/,
        `expected error to mention upstream cause, got: ${result.error}`,
      );
    }
  });

  test('returns Err when dotnet.acquire returns no dotnetPath', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquire': {},
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10(statusBar);

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /dotnetPath/i);
    }
  });

  test('returns Err when dotnet.acquire returns empty dotnetPath', async () => {
    patch = patchExecuteCommand({
      'dotnet.findPath': undefined,
      'dotnet.acquire': { dotnetPath: '' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10(statusBar);

    assert.strictEqual(result.ok, false);
  });

  test('treats dotnet.findPath errors as a miss, not a throw', async () => {
    // Reproduces the v0.1.0 production scenario: findPath rejects with the
    // "missing required information" message when architecture is omitted.
    // We now include architecture, but the helper must still tolerate a
    // findPath miss without throwing.
    patch = patchExecuteCommand({
      'dotnet.findPath': () => {
        throw new Error('missing required information');
      },
      'dotnet.acquire': { dotnetPath: '/fallback/dotnet' },
    });
    statusBar = makeStatusBar();

    const result = await acquireDotnet10(statusBar);

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.value, '/fallback/dotnet');
    }
  });
});
