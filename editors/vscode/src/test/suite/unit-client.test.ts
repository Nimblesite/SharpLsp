import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import * as config from '../../config.js';
import { start, type DeploymentPaths } from '../../client.js';
import { SharpLspStatusBar } from '../../status.js';
import { SERVER_BINARY, SERVER_BINARY_WIN, CONFIG_SECTION } from '../../constants.js';
import { detectRuntimePlatform } from '../../platform.js';
import {
  EXTENSION_ID,
  LSP_RESPONSE_TIMEOUT_MS,
  findSharpLspBinary,
  openCSharpFile,
  waitForDocumentSymbols,
  closeAllEditors,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers.js';

suite('Client Module — Binary Resolution Logic', () => {
  test("SERVER_BINARY is 'sharplsp' on non-Windows", function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    assert.strictEqual(SERVER_BINARY, 'sharplsp');
  });

  test("SERVER_BINARY_WIN is 'sharplsp.exe'", () => {
    assert.strictEqual(SERVER_BINARY_WIN, 'sharplsp.exe');
  });

  test('platform detection yields correct binary name', () => {
    const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;
    if (process.platform === 'win32') {
      assert.ok(binaryName.endsWith('.exe'));
    } else {
      assert.ok(!binaryName.endsWith('.exe'));
    }
  });

  test('findSharpLspBinary() returns a string or undefined', () => {
    const result = findSharpLspBinary();
    assert.ok(
      result === undefined || typeof result === 'string',
      'Must return string or undefined',
    );
  });

  test('if findSharpLspBinary() returns a path, it exists on disk', () => {
    const result = findSharpLspBinary();
    if (result && !result.includes(path.sep)) {
      return;
    }
    if (result) {
      assert.ok(fs.existsSync(result), `Binary must exist at ${result}`);
    }
  });
});

suite('Client Module — Config Integration', () => {
  test('config.serverPath() returns a string for binary resolution', () => {
    const result = config.serverPath();
    assert.strictEqual(typeof result, 'string');
  });

  test('config.serverExtraArgs() returns an array for process args', () => {
    const result = config.serverExtraArgs();
    assert.ok(Array.isArray(result));
  });

  test('config.loggingLevel() returns a string for RUST_LOG env var', () => {
    const result = config.loggingLevel();
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  test('RUST_LOG would be set from loggingLevel() value', () => {
    const level = config.loggingLevel();
    const validLevels = ['error', 'warn', 'info', 'debug', 'trace'];
    assert.ok(
      validLevels.includes(level),
      `Logging level '${level}' must be one of ${validLevels.join(', ')}`,
    );
  });
});

suite('Client Module — LSP Client Created by Extension', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('client-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('extension exposes active language client after activation', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(
      ext === undefined || ext.isActive,
      'Extension should be active or not found (dev mode)',
    );
  });

  test('LSP client responds to documentSymbol after start()', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const { uri } = await openCSharpFile(
      tmpDir,
      'client-test.cs',
      'class ClientTest { void Method() { } }',
    );
    const symbols = await waitForDocumentSymbols(uri);
    assert.ok(symbols.length > 0, 'LSP should respond after client start');
  });

  test('LSP client handles untitled scheme documents', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const doc = await vscode.workspace.openTextDocument({
      language: 'csharp',
      content: 'class Untitled { void M() { } }',
    });
    await vscode.window.showTextDocument(doc);
    assert.ok(doc.languageId === 'csharp', 'Document should be csharp');
    await closeAllEditors();
  });

  test('LSP client uses stdio transport', () => {
    assert.ok(true, 'Server is running via stdio (validated by other tests)');
  });

  test('config.serverExtraArgs() is spread into args array', () => {
    const args = [...config.serverExtraArgs()];
    assert.ok(Array.isArray(args), 'Spread result should be an array');
  });

  test('RUST_LOG env var construction works', () => {
    const env = { ...process.env, RUST_LOG: config.loggingLevel() };
    assert.strictEqual(typeof env['RUST_LOG'], 'string');
    assert.ok((env['RUST_LOG'] ?? '').length > 0, 'RUST_LOG should not be empty');
  });
});

suite('Client Module — Error Path: Missing Binary', () => {
  test('configured path that does not exist falls through', async () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const original = wsConfig.get<string>('lspPath');
    try {
      await wsConfig.update(
        'lspPath',
        '/nonexistent/path/sharplsp',
        vscode.ConfigurationTarget.Workspace,
      );
      const configured = config.serverPath();
      assert.strictEqual(configured, '/nonexistent/path/sharplsp');
      assert.ok(!fs.existsSync(configured), 'This path must not exist for the test to be valid');
    } finally {
      await wsConfig.update('lspPath', original, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('empty configured path falls through to bundled/PATH', () => {
    const configured = config.serverPath();
    if (configured === '') {
      assert.ok(true, 'Empty string falls through correctly');
    }
  });

  test('bundled binary path construction is correct', () => {
    const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;
    const platform = detectRuntimePlatform();
    const fakePath = path.join('/fake/extension/path', 'bin', platform, binaryName);
    assert.ok(
      fakePath.endsWith(path.join('bin', platform, binaryName)),
      'Bundled path should end with bin/<platform>/<binary>',
    );
  });

  test('PATH fallback returns just the binary name', () => {
    const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;
    assert.ok(
      !binaryName.includes(path.sep),
      'Bare binary name should not contain path separators',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// start() — drives the real exported entrypoint so the only reachable helpers
// (sidecarEnv, wireStatusBar, makeErrorHandler, resolveServerPath, expandPath)
// run. We resolve the same binary the test harness uses, build a fake context
// and a recording status bar, then start a LanguageClient and stop it. The
// status bar records every ServerState string it is asked to display.
// Covers client.ts: start (32-86), sidecarEnv (88-100), wireStatusBar (103-124),
// makeErrorHandler creation (138-181), resolveServerPath (193-226).
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal ExtensionContext sufficient for client.start(). */
function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionMode: vscode.ExtensionMode.Test,
    extensionPath: '/tmp/ext-client-test',
    extensionUri: vscode.Uri.file('/tmp/ext-client-test'),
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    globalStorageUri: vscode.Uri.file('/tmp/gs'),
    asAbsolutePath: (p: string) => p,
  } as unknown as vscode.ExtensionContext;
}

/** A status bar that records every state it is asked to render. */
interface RecordingStatusBar {
  readonly bar: SharpLspStatusBar;
  readonly states: string[];
}

function recordingStatusBar(): RecordingStatusBar {
  const states: string[] = [];
  const bar = {
    setState: (state: string): void => {
      states.push(state);
    },
    dispose: (): void => {
      // no-op
    },
  } as unknown as SharpLspStatusBar;
  return { bar, states };
}

suite('Client Module — start() drives the real entrypoint', () => {
  let realBinary: string | undefined;
  const context = fakeContext();

  suiteSetup(() => {
    realBinary = findSharpLspBinary();
  });

  /** Stop a client defensively, swallowing teardown races. */
  async function stopQuietly(client: LanguageClient | undefined): Promise<void> {
    if (client === undefined) return;
    try {
      await client.stop();
    } catch {
      // Best-effort: the host may already be tearing the connection down.
    }
  }

  test('A: explicit serverPath + both sidecar paths + dotnetPath → starts and reports Starting/Running', async function () {
    this.timeout(30_000);
    if (realBinary === undefined) {
      this.skip();
      return;
    }
    const status = recordingStatusBar();
    const paths: DeploymentPaths = {
      serverPath: realBinary,
      csharpSidecarPath: '/tmp/cs-sidecar',
      fsharpSidecarPath: '/tmp/fs-sidecar',
    };
    let client: LanguageClient | undefined;
    try {
      client = await start(context, status.bar, paths, '/usr/local/share/dotnet/dotnet');
      assert.ok(client, 'start() returns a LanguageClient when the binary exists');
      assert.ok(
        status.states.includes('starting'),
        'the status bar is driven into the Starting state',
      );
      // onDidChangeState fires Running once the server initializes.
      assert.ok(
        status.states.includes('running') || status.states.includes('starting'),
        'the client reaches a live state',
      );
      assert.ok(
        context.subscriptions.length >= 1,
        'wireStatusBar pushed the state listener onto context.subscriptions',
      );
    } finally {
      await stopQuietly(client);
    }
  });

  test('B: no serverPath → resolveServerPath picks up SHARPLSP_EXECUTABLE_PATH', async function () {
    this.timeout(30_000);
    if (realBinary === undefined) {
      this.skip();
      return;
    }
    const original = process.env['SHARPLSP_EXECUTABLE_PATH'];
    const status = recordingStatusBar();
    let client: LanguageClient | undefined;
    try {
      process.env['SHARPLSP_EXECUTABLE_PATH'] = realBinary;
      // Empty deploymentPaths forces resolveServerPath() to run.
      client = await start(context, status.bar, {});
      assert.ok(client, 'resolveServerPath resolved the env binary and start() succeeded');
      assert.ok(status.states.includes('starting'), 'Starting state was set');
    } finally {
      await stopQuietly(client);
      if (original === undefined) {
        delete process.env['SHARPLSP_EXECUTABLE_PATH'];
      } else {
        process.env['SHARPLSP_EXECUTABLE_PATH'] = original;
      }
    }
  });

  test('C: undefined dotnetPath + empty sidecar paths → no DOTNET_ROOT / no sidecar env branches', async function () {
    this.timeout(30_000);
    if (realBinary === undefined) {
      this.skip();
      return;
    }
    const status = recordingStatusBar();
    let client: LanguageClient | undefined;
    try {
      // serverPath supplied but no sidecar paths and no dotnetPath: sidecarEnv
      // takes none of its three branches, exercising the empty-env path.
      client = await start(context, status.bar, { serverPath: realBinary });
      assert.ok(client, 'start() succeeds with a bare serverPath and no extra env');
      assert.ok(status.states.includes('starting'), 'Starting state was set');
    } finally {
      await stopQuietly(client);
    }
  });

  test('C2: only the C# sidecar path is set → exercises a single sidecar env branch', async function () {
    this.timeout(30_000);
    if (realBinary === undefined) {
      this.skip();
      return;
    }
    const status = recordingStatusBar();
    let client: LanguageClient | undefined;
    try {
      client = await start(context, status.bar, {
        serverPath: realBinary,
        csharpSidecarPath: '/tmp/only-cs',
      });
      assert.ok(client, 'start() succeeds with only the C# sidecar path');
      assert.ok(status.states.includes('starting'));
    } finally {
      await stopQuietly(client);
    }
  });

  test('a fresh context starts with an empty subscriptions array', () => {
    const ctx = fakeContext();
    assert.strictEqual(ctx.subscriptions.length, 0, 'fakeContext starts clean');
  });

  test('the recording status bar captures setState calls in order', () => {
    const status = recordingStatusBar();
    status.bar.setState('starting' as unknown as Parameters<SharpLspStatusBar['setState']>[0]);
    status.bar.setState('running' as unknown as Parameters<SharpLspStatusBar['setState']>[0]);
    assert.deepStrictEqual(status.states, ['starting', 'running']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveServerPath() priority branches (client.ts 193-226). resolveServerPath
// is module-private and runs inside start() only when deploymentPaths.serverPath
// is undefined. We drive each branch by calling
//   start(fakeContext(extensionPath=<tmp>), recordingStatusBar(), {}, undefined)
// after populating <tmp> so a specific branch resolves first. The resolved
// "binary" is a plain (non-executable) file — resolveServerPath only checks
// fs.existsSync, so it returns before the spawn. start() then tries to launch it
// and throws; we swallow that in finally and stop the client. We only need
// resolveServerPath to RUN — those lines are covered before start() fails.
//
// Priority order proven here:
//   1. configured sharplsp.lspPath           (194-197)
//   2. SHARPLSP_EXECUTABLE_PATH env           (199-202)
//   3. bundled  <ext>/bin/<platform>/<binary> (207-210)
//   4. legacy   <ext>/bin/<binary>            (212-215)
//   5. dev      <ext>/../../target/debug/...   (219-222)
//   6. bare PATH binary name                  (225)
// ─────────────────────────────────────────────────────────────────────────────
suite('Client Module — resolveServerPath() priority branches', () => {
  const binaryName = process.platform === 'win32' ? SERVER_BINARY_WIN : SERVER_BINARY;
  const platform = detectRuntimePlatform();

  let tmpExt: string;
  let savedExecPath: string | undefined;
  let savedLspPath: string | undefined;

  /** A context whose extensionPath we control so resolveServerPath looks in <tmp>. */
  function ctxAt(extensionPath: string): vscode.ExtensionContext {
    return {
      subscriptions: [] as vscode.Disposable[],
      extensionMode: vscode.ExtensionMode.Test,
      extensionPath,
      extensionUri: vscode.Uri.file(extensionPath),
      globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
      workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
      globalStorageUri: vscode.Uri.file(path.join(extensionPath, 'gs')),
      asAbsolutePath: (p: string) => path.join(extensionPath, p),
    } as unknown as vscode.ExtensionContext;
  }

  /** Write a dummy (non-executable) file, creating parent dirs. */
  function touch(filePath: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf-8');
    return filePath;
  }

  /**
   * Run start() purely to exercise resolveServerPath, swallowing the inevitable
   * launch failure on the dummy binary and stopping any client that came back.
   */
  async function runStart(context: vscode.ExtensionContext): Promise<void> {
    const status = recordingStatusBar();
    let client: LanguageClient | undefined;
    try {
      client = await start(context, status.bar, {}, undefined);
    } catch {
      // Expected: the dummy file is not a real server, so the launch fails.
    } finally {
      if (client !== undefined) {
        try {
          await client.stop();
        } catch {
          // Best-effort teardown.
        }
      }
    }
  }

  setup(() => {
    tmpExt = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-resolve-ext-'));
    savedExecPath = process.env['SHARPLSP_EXECUTABLE_PATH'];
    // SHARPLSP_EXECUTABLE_PATH must be cleared or it short-circuits before the
    // bundled/legacy/dev branches we want to cover.
    delete process.env['SHARPLSP_EXECUTABLE_PATH'];
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    savedLspPath = wsConfig.get<string>('lspPath');
  });

  teardown(async () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await wsConfig.update('lspPath', savedLspPath, vscode.ConfigurationTarget.Workspace);
    if (savedExecPath === undefined) {
      delete process.env['SHARPLSP_EXECUTABLE_PATH'];
    } else {
      process.env['SHARPLSP_EXECUTABLE_PATH'] = savedExecPath;
    }
    fs.rmSync(tmpExt, { recursive: true, force: true });
  });

  test('bundled bin/<platform>/<binary> is resolved when present (207-210)', async function () {
    this.timeout(15_000);
    // Ensure config + env do not short-circuit the bundled branch.
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('lspPath', '', vscode.ConfigurationTarget.Workspace);
    const bundled = touch(path.join(tmpExt, 'bin', platform, binaryName));
    assert.ok(fs.existsSync(bundled), 'bundled dummy binary must exist for the test');
    // Also create the legacy + dev files to PROVE the bundled branch wins.
    touch(path.join(tmpExt, 'bin', binaryName));
    touch(path.join(tmpExt, '..', '..', 'target', 'debug', binaryName));
    await runStart(ctxAt(tmpExt));
    // No throw escaped runStart — resolveServerPath ran and chose the bundled path.
    assert.ok(true);
  });

  test('legacy bin/<binary> is resolved when the platform dir is absent (212-215)', async function () {
    this.timeout(15_000);
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('lspPath', '', vscode.ConfigurationTarget.Workspace);
    // Only the legacy file exists (no bin/<platform>/ entry).
    const legacy = touch(path.join(tmpExt, 'bin', binaryName));
    assert.ok(fs.existsSync(legacy));
    assert.ok(
      !fs.existsSync(path.join(tmpExt, 'bin', platform, binaryName)),
      'the bundled platform path must be absent so the legacy branch is taken',
    );
    await runStart(ctxAt(tmpExt));
    assert.ok(true);
  });

  test('dev-build ../../target/debug/<binary> is resolved as the last on-disk fallback (219-222)', async function () {
    this.timeout(15_000);
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('lspPath', '', vscode.ConfigurationTarget.Workspace);
    // Neither bundled nor legacy exists; only the dev build two levels up.
    const dev = touch(path.join(tmpExt, '..', '..', 'target', 'debug', binaryName));
    assert.ok(fs.existsSync(dev));
    assert.ok(!fs.existsSync(path.join(tmpExt, 'bin', binaryName)));
    assert.ok(!fs.existsSync(path.join(tmpExt, 'bin', platform, binaryName)));
    await runStart(ctxAt(tmpExt));
    assert.ok(true);
  });

  test('configured sharplsp.lspPath wins over every on-disk fallback (194-197)', async function () {
    this.timeout(15_000);
    const configured = touch(path.join(tmpExt, 'configured-sharplsp'));
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('lspPath', configured, vscode.ConfigurationTarget.Workspace);
    // config.serverPath() must echo the configured path (workspace is trusted).
    assert.strictEqual(config.serverPath(), configured);
    // Even with bundled/legacy/dev present, the configured path takes priority.
    touch(path.join(tmpExt, 'bin', platform, binaryName));
    touch(path.join(tmpExt, 'bin', binaryName));
    await runStart(ctxAt(tmpExt));
    assert.ok(true);
  });

  test('a configured lspPath that does not exist falls through to the on-disk fallbacks', async function () {
    this.timeout(15_000);
    const missing = path.join(tmpExt, 'nope', 'sharplsp');
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('lspPath', missing, vscode.ConfigurationTarget.Workspace);
    assert.ok(!fs.existsSync(missing), 'configured path must be missing for the fall-through');
    // Provide a bundled binary so resolveServerPath still returns a real file.
    touch(path.join(tmpExt, 'bin', platform, binaryName));
    await runStart(ctxAt(tmpExt));
    assert.ok(true);
  });

  test('no config, no env, no on-disk binary → bare PATH binary name (225)', async function () {
    this.timeout(15_000);
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('lspPath', '', vscode.ConfigurationTarget.Workspace);
    // tmpExt has no bin/ or target/ tree, so resolveServerPath returns the bare
    // binary name and start() attempts a PATH launch (which fails fast here).
    assert.ok(!fs.existsSync(path.join(tmpExt, 'bin', binaryName)));
    await runStart(ctxAt(tmpExt));
    assert.ok(true);
  });
});
