import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as config from '../../config.js';

// Implements [DIST-WORKSPACE-TRUST]: a malicious workspace must not be able to
// dictate which executable the extension spawns. These coarse guard tests lock
// in both halves of the fix:
//   1. the declarative `capabilities.untrustedWorkspaces.restrictedConfigurations`
//      manifest entry (VS Code ignores workspace-scoped values when untrusted), and
//   2. the runtime `workspace.isTrusted` gate in config.ts (defence-in-depth).
// If either regresses, opening an untrusted repo with a crafted
// `.vscode/settings.json` could run an arbitrary binary as the language server.
const extensionId = 'nimblesite.sharplsp';

// Every setting whose value selects (or influences) an executable that the
// extension spawns. All MUST be restricted in untrusted workspaces.
const executableSelectingSettings = [
  'sharplsp.lspPath',
  'sharplsp.csharpSidecarPath',
  'sharplsp.fsharpSidecarPath',
  'sharplsp.server.extraArgs',
  'sharplsp.debug.netcoredbgPath',
] as const;

interface UntrustedWorkspacesManifest {
  readonly supported?: unknown;
  readonly restrictedConfigurations?: readonly string[];
}

suite('Workspace trust — RCE hardening [DIST-WORKSPACE-TRUST]', () => {
  test('package.json declares limited untrusted-workspace support', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);
    const capabilities = ext.packageJSON.capabilities as
      | { untrustedWorkspaces?: UntrustedWorkspacesManifest }
      | undefined;
    const untrusted = capabilities?.untrustedWorkspaces;
    assert.ok(untrusted !== undefined, 'capabilities.untrustedWorkspaces must be declared');
    assert.strictEqual(
      untrusted.supported,
      'limited',
      "untrustedWorkspaces.supported must be 'limited' so restricted settings are enforced",
    );
  });

  test('every executable-selecting setting is a restricted configuration', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);
    const restricted = new Set(
      (ext.packageJSON.capabilities?.untrustedWorkspaces?.restrictedConfigurations ??
        []) as readonly string[],
    );
    for (const setting of executableSelectingSettings) {
      assert.ok(
        restricted.has(setting),
        `${setting} must be listed in restrictedConfigurations (untrusted-workspace RCE guard)`,
      );
    }
  });

  test('the test host is trusted, so config reads pass through normally', () => {
    // Sanity anchor: the VS Code test workspace is trusted by default, which is
    // why the config.serverPath()/serverExtraArgs() pass-through tests in
    // unit-config.test.ts still observe configured values.
    assert.strictEqual(vscode.workspace.isTrusted, true, 'test host workspace must be trusted');
    assert.strictEqual(typeof config.serverPath(), 'string');
    assert.ok(Array.isArray(config.serverExtraArgs()));
  });
});
