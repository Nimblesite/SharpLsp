import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DapRouter, INTERPRETER_ARGS } from '../../dap-router.js';
import { SharpLspDebugAdapterFactory, getNetcoredbgCandidates } from '../../debug.js';
import { DEBUG_TYPE_ID, fakeFolder, stopAnyDebugSession } from './run-debug-kit';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { closeAllEditors, comparablePath, removeDirRecursive } from './test-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Spec: [DEBUG-ADAPTER-NETCOREDBG], [DEBUG-ARCHITECTURE-NETCOREDBG].
//
// How the extension decides WHICH netcoredbg binary a session will spawn. Split
// out of debug-e2e.test.ts, which had grown past the 500-line ceiling and mixed
// adapter discovery with the F5 resolve contract.
//
// registerDebugAdapter() is NEVER called here: the extension registered the
// factory at activation and a second registration corrupts the host. The
// factory class is exercised directly instead — a plain object with no host
// state — which is also what lets a case supply an `extensionPath` the running
// extension does not have.
// ─────────────────────────────────────────────────────────────────────────────

/** The binary name netcoredbg ships under on this platform. */
const EXE = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';

/** The DAP interpreter flag every descriptor must carry. */
const ADAPTER_ARGS: readonly string[] = ['--interpreter=vscode'];

/** Where a VSIX stages its bundled copy, relative to the extension root. */
function bundledPath(extensionPath: string): string {
  return path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`, 'netcoredbg', EXE);
}

/** Materialise an executable stand-in so `existsSync` sees a real candidate. */
function writeFakeAdapter(target: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', 'utf-8');
  return target;
}

/**
 * A session shaped like the real one VS Code hands the factory: it carries the
 * resolved `configuration` and the owning `workspaceFolder`, not just an id.
 */
function sessionFor(name: string, root: string): vscode.DebugSession {
  return {
    id: `sess-${name}`,
    type: DEBUG_TYPE_ID,
    name,
    workspaceFolder: fakeFolder(root),
    configuration: {
      type: DEBUG_TYPE_ID,
      request: 'launch',
      name,
      program: path.join(root, 'bin', 'Debug', 'net10.0', `${name}.dll`),
      cwd: root,
      justMyCode: true,
    },
  } as unknown as vscode.DebugSession;
}

suite('Debug Adapter E2E — netcoredbg resolution via the adapter factory', () => {
  const factory = new SharpLspDebugAdapterFactory();

  let tmpDir: string;
  let stubs: UiStubs;
  let savedNetcoredbgPath: string | undefined;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-adapter-e2e-'));
    stubs = installUiStubs();
    savedNetcoredbgPath = vscode.workspace
      .getConfiguration('sharplsp')
      .inspect<string>('debug.netcoredbgPath')?.globalValue;
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
  });

  teardown(async () => {
    await setNetcoredbgPath(savedNetcoredbgPath);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    stubs.restore();
    await stopAnyDebugSession();
    await closeAllEditors();
    removeDirRecursive(tmpDir);
  });

  /** Write the user-scoped `sharplsp.debug.netcoredbgPath` override. */
  async function setNetcoredbgPath(value: string | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration('sharplsp')
      .update('debug.netcoredbgPath', value, vscode.ConfigurationTarget.Global);
  }

  /** Point HOME at the fixture root so no real user install can be picked up. */
  function isolateHome(): void {
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
  }

  /** The descriptor the factory produced, asserting it resolved synchronously. */
  function descriptorOf(
    target: SharpLspDebugAdapterFactory,
    session: vscode.DebugSession,
  ): vscode.DebugAdapterDescriptor | undefined {
    const result = target.createDebugAdapterDescriptor(session);
    assert.strictEqual(
      result instanceof Promise,
      false,
      'adapter discovery is a filesystem probe and must not defer the launch round-trip',
    );
    return result as vscode.DebugAdapterDescriptor | undefined;
  }

  /**
   * The router the factory wrapped, asserting the routed descriptor contract.
   *
   * [DEBUG-ARCHITECTURE-ROUTER] routes every session through the DapRouter — a
   * bare `DebugAdapterExecutable` would hand VS Code netcoredbg's raw wire with
   * none of the proxy-layer emulation — so the resolvable outcome is an inline
   * router, and the contract is WHICH binary that router spawns.
   */
  function routerOf(target: SharpLspDebugAdapterFactory, session: vscode.DebugSession): DapRouter {
    const descriptor = descriptorOf(target, session);
    assert.ok(
      descriptor instanceof vscode.DebugAdapterInlineImplementation,
      'a resolvable netcoredbg must produce an inline DapRouter, not an executable/server descriptor',
    );
    // The API type keeps `implementation` private; at runtime it is the router
    // the factory constructed, and asserting its identity is the whole contract.
    const router = (descriptor as unknown as { implementation?: unknown }).implementation;
    assert.ok(
      router instanceof DapRouter,
      'the inline adapter must BE the DapRouter wrapping the resolved netcoredbg',
    );
    assert.deepStrictEqual(
      INTERPRETER_ARGS,
      ADAPTER_ARGS,
      'netcoredbg only speaks DAP under --interpreter=vscode',
    );
    router.dispose();
    return router;
  }

  // B59 — the configured override outranks every discovered candidate.
  test('a configured netcoredbgPath outranks bundled, user-installed and PATH copies', async function () {
    this.timeout(60_000);
    const session = sessionFor('Configured', tmpDir);

    const primary = writeFakeAdapter(path.join(tmpDir, 'configured', EXE));
    await setNetcoredbgPath(primary);
    const first = routerOf(factory, session);
    assert.strictEqual(first.adapterPath, primary, 'B59: the configured path is spawned verbatim');
    assert.strictEqual(
      typeof first.adapterPath,
      'string',
      'B59: the command is a plain path string',
    );
    // B59: no cwd/env override is imposed on netcoredbg — DapRouter.spawn
    // passes stdio pipes only, so the resolved path is spawned verbatim.
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'a resolvable adapter reports nothing');

    // A user install appears; the setting must still win.
    isolateHome();
    const userInstall = writeFakeAdapter(path.join(tmpDir, '.dotnet', 'tools', EXE));
    assert.strictEqual(
      getNetcoredbgCandidates()[0],
      userInstall,
      'with HOME isolated, ~/.dotnet/tools is candidate zero',
    );
    const second = routerOf(factory, session);
    assert.strictEqual(
      second.adapterPath,
      primary,
      'B59: an explicit setting beats a user install',
    );
    assert.notStrictEqual(second.adapterPath, userInstall, 'B59: the candidate must not be chosen');

    // A VSIX-bundled copy appears too; the setting still wins.
    const extensionPath = path.join(tmpDir, 'ext');
    const bundled = writeFakeAdapter(bundledPath(extensionPath));
    const bundledFactory = new SharpLspDebugAdapterFactory(extensionPath);
    assert.strictEqual(
      routerOf(bundledFactory, session).adapterPath,
      primary,
      'B59: an explicit setting beats even the bundled binary',
    );

    // Repointing the setting repoints the descriptor.
    const replacement = writeFakeAdapter(path.join(tmpDir, 'other', EXE));
    await setNetcoredbgPath(replacement);
    const fourth = routerOf(bundledFactory, session);
    assert.strictEqual(fourth.adapterPath, replacement, 'B59: the setting is read per descriptor');
    assert.notStrictEqual(fourth.adapterPath, primary, 'B59: the old value must not be cached');

    // Clearing the setting hands the decision back to the candidate order.
    await setNetcoredbgPath(undefined);
    assert.strictEqual(
      routerOf(bundledFactory, session).adapterPath,
      bundled,
      'B59: with no setting the bundled copy is preferred',
    );
    assert.strictEqual(
      routerOf(factory, session).adapterPath,
      userInstall,
      'B59: a factory with no extensionPath cannot see the bundled copy',
    );
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'six resolutions, zero error toasts');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'and zero warnings');
    assert.deepStrictEqual(stubs.log.infoMessages, [], 'and zero information messages');
  });

  // B61 — the candidate list is a stable, ordered contract.
  test('the candidate list is ordered, pure, and only its head depends on extensionPath', async function () {
    this.timeout(60_000);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const candidates = getNetcoredbgCandidates();
    assert.strictEqual(candidates.length, 5, 'B61: five default locations are scanned');
    assert.deepStrictEqual(
      candidates,
      [
        path.join(home, '.dotnet', 'tools', EXE),
        path.join(home, '.local', 'share', 'netcoredbg', EXE),
        `/usr/local/bin/${EXE}`,
        `/usr/bin/${EXE}`,
        path.join(home, 'AppData', 'Local', 'netcoredbg', EXE),
      ],
      'B61: the search ORDER is the contract — a user install outranks /usr/bin',
    );
    assert.deepStrictEqual(
      candidates.map((candidate) => path.basename(candidate)),
      [EXE, EXE, EXE, EXE, EXE],
      'B61: every candidate names the platform executable',
    );
    assert.deepStrictEqual(getNetcoredbgCandidates(), candidates, 'B61: the function is pure');

    const extensionPath = path.join(tmpDir, 'ext');
    const withBundle = getNetcoredbgCandidates(extensionPath);
    assert.strictEqual(withBundle.length, 6, 'B61: the bundled path is prepended');
    assert.strictEqual(withBundle[0], bundledPath(extensionPath), 'B61: it is scanned FIRST');
    assert.deepStrictEqual(withBundle.slice(1), candidates, 'B61: the tail is the default list');
    assert.deepStrictEqual(
      getNetcoredbgCandidates(''),
      candidates,
      'B61: an empty extensionPath contributes no candidate',
    );
    const other = getNetcoredbgCandidates(path.join(tmpDir, 'other-ext'));
    assert.notStrictEqual(other[0], withBundle[0], 'B61: only the head varies with extensionPath');
    assert.deepStrictEqual(other.slice(1), withBundle.slice(1), 'B61: the tail is invariant');

    // The factory must honour that order, not merely publish it.
    isolateHome();
    await setNetcoredbgPath(undefined);
    const session = sessionFor('Ordered', tmpDir);
    const local = writeFakeAdapter(path.join(tmpDir, '.local', 'share', 'netcoredbg', EXE));
    assert.strictEqual(getNetcoredbgCandidates()[1], local, 'B61: ~/.local/share is candidate one');
    assert.strictEqual(
      routerOf(factory, session).adapterPath,
      local,
      'B61: with candidate zero absent, candidate one is used',
    );
    const tools = writeFakeAdapter(path.join(tmpDir, '.dotnet', 'tools', EXE));
    assert.strictEqual(
      routerOf(factory, session).adapterPath,
      tools,
      'B61: candidate zero takes over the moment it exists',
    );
    assert.notStrictEqual(
      routerOf(factory, session).adapterPath,
      local,
      'B61: order, not first-seen',
    );
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'a resolvable adapter reports nothing');
  });

  // B60 — absence must be reported, never papered over with a bare PATH name.
  test('an unresolvable netcoredbg is reported once per attempt, never spawned blind', async function () {
    this.timeout(60_000);
    isolateHome();
    await setNetcoredbgPath(undefined);
    const present = getNetcoredbgCandidates().filter((candidate) => fs.existsSync(candidate));
    assert.deepStrictEqual(present, [], 'the isolated HOME must leave no candidate on disk');

    const session = sessionFor('Absent', tmpDir);
    assert.strictEqual(
      descriptorOf(factory, session),
      undefined,
      "B60: with nothing installed the factory must refuse — a bare 'netcoredbg' descriptor " +
        'only defers the failure to a spawn ENOENT the user cannot diagnose',
    );
    assert.strictEqual(stubs.log.errorMessages.length, 1, 'B60: exactly one message per attempt');
    assert.ok(
      stubs.log.errorMessages[0]?.includes('netcoredbg'),
      `B60: the message must name the missing tool; got: ${stubs.log.errorMessages[0] ?? '<none>'}`,
    );
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'B60: a hard failure is not a warning');
    assert.deepStrictEqual(stubs.log.infoMessages, [], 'B60: and not an information toast');

    // A configured path that does not exist must not be spawned either.
    const ghost = path.join(tmpDir, 'ghost', EXE);
    assert.strictEqual(fs.existsSync(ghost), false, 'the ghost path must not exist');
    await setNetcoredbgPath(ghost);
    assert.strictEqual(
      descriptorOf(factory, session),
      undefined,
      'B60: a configured path that is missing falls through to the same refusal',
    );
    assert.strictEqual(stubs.log.errorMessages.length, 2, 'B60: one more message, not zero or two');

    // An empty configured path is the same case.
    await setNetcoredbgPath('');
    assert.strictEqual(descriptorOf(factory, session), undefined, 'B60: empty means unset');
    assert.strictEqual(stubs.log.errorMessages.length, 3, 'B60: still one message per attempt');

    // Install one: resolution succeeds and adds NO new message.
    const installed = writeFakeAdapter(path.join(tmpDir, '.dotnet', 'tools', EXE));
    const resolved = routerOf(factory, session);
    assert.strictEqual(
      comparablePath(resolved.adapterPath),
      comparablePath(installed),
      'B60: once installed, that exact binary is spawned',
    );
    assert.notStrictEqual(resolved.adapterPath, 'netcoredbg', 'B60: never a bare PATH name');
    assert.strictEqual(stubs.log.errorMessages.length, 3, 'B60: success adds no message');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'B60: and still no warning');
  });
});
