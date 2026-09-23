import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as dotnetRoots from '../../dotnet-roots.js';
import { candidateDotnetRoots, dotnetExecutable } from '../../dotnet-roots.js';
import { installedSdkVersions } from '../../global-json.js';
import { SETTLE_MS } from './test-timeouts.js';

// Implements [DIST-RUNTIME-ACQUIRE]. Copy real installations, never empty SDK directories.
export function sdkSource(major: number): string {
  const prefix = `${major}.`;
  const root = candidateDotnetRoots().find((candidate) =>
    installedSdkVersions(dotnetExecutable(candidate)).some((sdk) => sdk.startsWith(prefix)),
  );
  assert.ok(root, `SDK ${major} must be installed (CI provisions SDKs 9 and 10)`);
  return root;
}

export function copySdkMajor(source: string, target: string, major: number): string {
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(dotnetExecutable(source), dotnetExecutable(target));
  for (const component of ['sdk', 'host/fxr', 'shared/Microsoft.NETCore.App']) {
    const parent = path.join(source, component);
    const versions = fs.readdirSync(parent).filter((version) => version.startsWith(`${major}.`));
    assert.ok(versions.length > 0, `${component} must supply .NET ${major}`);
    for (const version of versions) {
      fs.cpSync(path.join(parent, version), path.join(target, component, version), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
    }
  }
  return dotnetExecutable(target);
}

export function runHost(host: string, cwd: string, args: string[]) {
  return spawnSync(host, args, {
    cwd,
    encoding: 'utf8',
    timeout: SETTLE_MS,
    env: { ...process.env, DOTNET_ROOT: path.dirname(host), DOTNET_MULTILEVEL_LOOKUP: '0' },
  });
}

/** Exercise hostfxr version selection with real runtime bits under one advertised version. */
export function selectRuntimeVersion(root: string, version: string): void {
  const parent = path.join(root, 'shared/Microsoft.NETCore.App');
  const versions = fs.readdirSync(parent);
  assert.ok(versions.length > 0);
  const source = path.join(root, 'runtime-source');
  fs.renameSync(parent, source);
  fs.mkdirSync(parent);
  fs.cpSync(path.join(source, versions[0]!), path.join(parent, version), {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
}

export function assertSidecarsRun(host: string, cwd: string): void {
  for (const language of ['FSharp', 'CSharp']) {
    const dll = path.resolve(__dirname, '../../../bin/all', `SharpLsp.Sidecar.${language}.dll`);
    assert.ok(fs.existsSync(dll), 'the test must execute the staged release sidecars');
    const run = runHost(host, cwd, [dll, '--version']);
    assert.equal(run.status, 0, `${language} must start on the selected host: ${run.stderr}`);
    assert.ok(run.stdout.startsWith(`sharplsp-sidecar-${language.toLowerCase()} `));
    assert.equal(run.signal, null, 'sidecar must exit normally, not time out');
  }
}

/** Only replace editor/installer boundaries; SDK selection and executable hosts stay real. */
export function stubSdkWorkspace(
  root: string,
  find: () => string | undefined,
  acquire: (version: string) => string,
): () => void {
  const folders = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  const execute = vscode.commands.executeCommand;
  const candidates = dotnetRoots.candidateDotnetRoots;
  Object.defineProperty(dotnetRoots, 'candidateDotnetRoots', {
    configurable: true,
    value: () => [process.env['DOTNET_ROOT']],
  });
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    get: () => [{ uri: vscode.Uri.file(root), name: 'sdk-host-regression', index: 0 }],
  });
  vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
    if (command === 'dotnet.findPath') return { dotnetPath: find() };
    if (command === 'dotnet.acquireGlobalSDK') {
      const context = args[0] as { version: string; mode: string };
      assert.equal(context.mode, 'sdk', 'sidecars need MSBuild as well as the runtime');
      return { dotnetPath: acquire(context.version) };
    }
    return await execute(command, ...args);
  }) as typeof execute;
  return () => {
    vscode.commands.executeCommand = execute;
    Object.defineProperty(dotnetRoots, 'candidateDotnetRoots', { value: candidates });
    assert.ok(folders, 'VS Code must expose the workspaceFolders descriptor');
    Object.defineProperty(vscode.workspace, 'workspaceFolders', folders);
  };
}
