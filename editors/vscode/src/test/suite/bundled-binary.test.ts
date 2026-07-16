import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectRuntimePlatform } from '../../platform.js';

const extensionId = 'nimblesite.sharplsp';
const lspComponentId = 'sharplsp';
const envVarsThatBypassBundledResolution = [
  'SHARPLSP_EXECUTABLE_PATH',
  'SHARPLSP_LSP_PATH',
  'SHARPLSP_BINARY_DIR',
  'FORGE_LSP_PATH',
  'FORGE_BINARY_DIR',
] as const;
const envVarsThatBypassBundledResolutionSet = new Set<string>(envVarsThatBypassBundledResolution);

suite('Bundled binary resolution', () => {
  test('sharplsp resolves from bundled source', async function () {
    this.timeout(15_000);

    const { activateShipwright } = await import('@nimblesite/shipwright-vscode');
    const platform = detectRuntimePlatform();
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);

    const binaryName = process.platform === 'win32' ? 'sharplsp.exe' : 'sharplsp';
    const bundledBin = path.join(ext.extensionPath, 'bin', platform, binaryName);
    assert.ok(fs.existsSync(bundledBin), `Bundled binary must exist at ${bundledBin}`);

    for (const name of envVarsThatBypassBundledResolution) {
      assert.strictEqual(process.env[name], undefined, `${name} must be unset in VSIX tests`);
    }

    const result = await activateShipwright(ext, {
      env: sanitizedEnv(),
      manifestPath: path.join(ext.extensionPath, 'shipwright.json'),
      pathEntries: sidecarPathEntries(ext.extensionPath),
      showMessages: false,
      timeoutMs: 5_000,
    });

    const lspDiag = result.diagnostics.find(
      (diagnostic) => diagnostic.componentId === lspComponentId,
    );
    assert.ok(lspDiag !== undefined, `${lspComponentId} diagnostic must be present`);
    assert.strictEqual(lspDiag.resolution.status, 'ok');
    assert.strictEqual(lspDiag.resolution.source, 'bundled');
    assert.strictEqual(lspDiag.resolution.path, bundledBin);
  });
});

// Implements [DIST-VSIX-ASSET-INTEGRITY]. The icon files are tracked as
// symlinks into docs/designs/logo/; on checkouts without core.symlinks Git
// materializes them as text stubs, which vsce would package as broken icons.
// `npm run pretest` resolves the stubs (scripts/resolve-symlink-stubs.mjs)
// before this suite runs, so a failure here means the resolver regressed or
// was unwired.
suite('[DIST-VSIX-ASSET-INTEGRITY] packaged icon assets', () => {
  test('manifest-referenced icons are real images, not symlink text stubs', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext !== undefined, `${extensionId} must be loaded in the VS Code test host`);
    const iconRel: string | undefined = ext.packageJSON.icon;
    assert.ok(iconRel, 'package.json must declare a marketplace icon');
    const iconsDir = path.dirname(path.join(ext.extensionPath, iconRel));

    for (const name of fs.readdirSync(iconsDir)) {
      const assetPath = path.join(iconsDir, name);
      if (fs.lstatSync(assetPath).isSymbolicLink()) {
        continue; // Real OS symlink — vsce reads the target's content.
      }
      const content = fs.readFileSync(assetPath);
      const looksLikeStub =
        content.length < 1024 && /^\.{1,2}\//.test(content.toString('utf8').trim());
      assert.ok(
        !looksLikeStub,
        `${name} is a symlink text stub — packaging would ship a broken icon. ` +
          'Run `node scripts/resolve-symlink-stubs.mjs editors/vscode/icons` ' +
          '(auto-run by npm pretest / vscode:prepublish).',
      );
      if (name.endsWith('.png')) {
        assert.deepStrictEqual(
          [...content.subarray(0, 4)],
          [0x89, 0x50, 0x4e, 0x47],
          `${name} must start with PNG magic bytes`,
        );
      }
      if (name.endsWith('.svg')) {
        assert.match(content.toString('utf8'), /<svg[\s>]/, `${name} must contain <svg markup`);
      }
    }
  });
});

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!envVarsThatBypassBundledResolutionSet.has(name)) {
      env[name] = value;
    }
  }
  return env;
}

function sidecarPathEntries(extensionPath: string): string[] {
  const repoRoot = path.resolve(extensionPath, '..', '..');
  return [
    path.join(repoRoot, 'target', 'sidecar-csharp'),
    path.join(repoRoot, 'target', 'sidecar-fsharp'),
  ].filter((entry) => fs.existsSync(entry));
}
