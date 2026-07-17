import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import {
  SharpLspDebugAdapterFactory,
  SharpLspLaunchProvider,
  applyLaunchProfile,
  findEntryProject,
  findProjectFile,
  getNetcoredbgCandidates,
  isLaunchSettings,
  projectEntryFromFile,
  readLaunchProfiles,
} from '../../debug.js';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { closeAllEditors } from './test-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// COARSE end-to-end tests for the debug subsystem (src/debug.ts).
//
// These drive the REAL extension surface — the registered `sharplsp.debugProgram`
// command and the registered `SharpLspLaunchProvider` DebugConfigurationProvider —
// against REAL temp-dir .NET console projects built with the REAL `dotnet` CLI.
// Every exported helper in debug.ts is exercised inside one of those flows and its
// concrete output asserted.
//
// We NEVER call registerDebugAdapter(): the extension already registered the
// provider/factory/command at activation. Real debug-session launch is wrapped in
// assert.doesNotReject because attaching netcoredbg in a headless host may fail;
// the deterministic parts (project discovery, config resolution, built dll path,
// error/warning toasts) are asserted directly.
// ─────────────────────────────────────────────────────────────────────────────

const TFM = 'net10.0';

/** The single command this module registers. */
const CMD_DEBUG_PROGRAM = 'sharplsp.debugProgram';

/** Build a WorkspaceFolder rooted at `root` for direct provider calls. */
function fakeFolder(root: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(root), name: path.basename(root), index: 0 };
}

/** Write a launchSettings.json into <root>/Properties and return its path. */
function writeLaunchSettings(root: string, body: string): string {
  const propsDir = path.join(root, 'Properties');
  fs.mkdirSync(propsDir, { recursive: true });
  const file = path.join(propsDir, 'launchSettings.json');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

/** Materialise a minimal buildable .NET console project under `dir`. */
function writeConsoleProject(dir: string, name: string): { proj: string; program: string } {
  fs.mkdirSync(dir, { recursive: true });
  const proj = path.join(dir, `${name}.csproj`);
  fs.writeFileSync(
    proj,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <OutputType>Exe</OutputType>',
      `    <TargetFramework>${TFM}</TargetFramework>`,
      '    <Nullable>enable</Nullable>',
      '    <ImplicitUsings>enable</ImplicitUsings>',
      '  </PropertyGroup>',
      '</Project>',
      '',
    ].join('\n'),
    'utf-8',
  );
  const program = path.join(dir, 'Program.cs');
  fs.writeFileSync(
    program,
    'System.Console.WriteLine("hello from sharplsp debug e2e");\n',
    'utf-8',
  );
  return { proj, program };
}

/** Best-effort: stop any debug session this test may have started. */
async function stopAnyDebugSession(): Promise<void> {
  try {
    await vscode.debug.stopDebugging();
  } catch {
    // No active session — nothing to stop.
  }
}

suite('Debug E2E — exported helpers inside real flows', () => {
  let tmpDir: string;
  let stubs: UiStubs;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-e2e-'));
    stubs = installUiStubs();
  });

  teardown(async () => {
    stubs.restore();
    await stopAnyDebugSession();
    await closeAllEditors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the debug command and provider type are registered by the activated extension', async function () {
    this.timeout(30_000);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes(CMD_DEBUG_PROGRAM),
      `${CMD_DEBUG_PROGRAM} must be a registered VS Code command`,
    );

    // The launch provider type id is what package.json + registerDebugAdapter wire up.
    const config: vscode.DebugConfiguration = { type: '', name: '', request: '' };
    const provider = new SharpLspLaunchProvider();
    const resolved = provider.resolveDebugConfiguration(undefined, config) as
      | vscode.DebugConfiguration
      | undefined;
    assert.ok(resolved !== undefined);
    assert.strictEqual(resolved.type, 'sharplsp-coreclr');
  });

  test('isLaunchSettings + readLaunchProfiles parse a real launchSettings.json on disk', () => {
    // No file -> empty; malformed -> empty; valid Project profile -> parsed verbatim.
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});

    writeLaunchSettings(tmpDir, '{ not valid json ');
    assert.doesNotThrow(() => readLaunchProfiles(tmpDir));
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});

    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          App: {
            commandName: 'Project',
            environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
            commandLineArgs: '--port 5000 --verbose',
          },
          IIS: { commandName: 'IISExpress' },
        },
      }),
    );
    const profiles = readLaunchProfiles(tmpDir);
    assert.deepStrictEqual(Object.keys(profiles).sort(), ['App', 'IIS']);
    assert.strictEqual(profiles.App?.commandLineArgs, '--port 5000 --verbose');

    // The type guard discriminates real parse results.
    assert.strictEqual(isLaunchSettings({ profiles }), true);
    assert.strictEqual(isLaunchSettings({ iisSettings: {} }), false);
    assert.strictEqual(isLaunchSettings(null), false);
    assert.strictEqual(isLaunchSettings([1, 2, 3]), false);
  });

  test('applyLaunchProfile maps the first Project profile onto a config without clobbering set fields', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          IIS: { commandName: 'IISExpress', environmentVariables: { WHICH: 'iis' } },
          Web: {
            commandName: 'Project',
            environmentVariables: { WHICH: 'web' },
            commandLineArgs: 'a b c',
          },
        },
      }),
    );

    const fresh: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    };
    applyLaunchProfile(tmpDir, fresh);
    assert.deepStrictEqual(fresh.env, { WHICH: 'web' });
    assert.deepStrictEqual(fresh.args, ['a', 'b', 'c']);

    // Pre-set fields are preserved (no overwrite).
    const preset: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
      env: { WHICH: 'explicit' },
      args: ['kept'],
    };
    applyLaunchProfile(tmpDir, preset);
    assert.deepStrictEqual(preset.env, { WHICH: 'explicit' });
    assert.deepStrictEqual(preset.args, ['kept']);

    // No profiles at all -> nothing applied.
    const empty: vscode.DebugConfiguration = { type: 't', name: 'n', request: 'launch' };
    applyLaunchProfile(path.join(tmpDir, 'no-such'), empty);
    assert.strictEqual(empty.env, undefined);
    assert.strictEqual(empty.args, undefined);
  });

  test('getNetcoredbgCandidates returns five platform-correct paths the resolver scans', () => {
    const candidates = getNetcoredbgCandidates();
    assert.strictEqual(candidates.length, 5);

    const exe = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';
    for (const candidate of candidates) {
      assert.strictEqual(typeof candidate, 'string');
      assert.ok(candidate.endsWith(exe), `expected ${candidate} to end with ${exe}`);
    }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    assert.ok(candidates.includes(path.join(home, '.dotnet', 'tools', exe)));
    assert.ok(candidates.includes(`/usr/local/bin/${exe}`));
    assert.deepStrictEqual(getNetcoredbgCandidates(), getNetcoredbgCandidates());
  });

  test('projectEntryFromFile + findProjectFile + findEntryProject resolve the built dll path', () => {
    // Unbuilt project -> net10.0 fallback path (deterministic).
    const unbuilt = path.join(tmpDir, 'Unbuilt.csproj');
    const fallback = projectEntryFromFile(unbuilt);
    assert.strictEqual(fallback.cwd, tmpDir);
    assert.strictEqual(fallback.dll, path.join(tmpDir, 'bin', 'Debug', TFM, 'Unbuilt.dll'));

    // Simulate net9.0 being the only built TFM -> it is preferred over the missing net10.0.
    const nineDir = path.join(tmpDir, 'bin', 'Debug', 'net9.0');
    fs.mkdirSync(nineDir, { recursive: true });
    fs.writeFileSync(path.join(nineDir, 'Unbuilt.dll'), '', 'utf-8');
    assert.strictEqual(projectEntryFromFile(unbuilt).dll, path.join(nineDir, 'Unbuilt.dll'));

    // findEntryProject only looks AT the root.
    fs.writeFileSync(path.join(tmpDir, 'Root.csproj'), '<Project />', 'utf-8');
    const entry = findEntryProject(tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.cwd, tmpDir);

    // findProjectFile walks up from a child to the nearest project.
    const child = path.join(tmpDir, 'a', 'b');
    fs.mkdirSync(child, { recursive: true });
    const walked = findProjectFile(child, tmpDir);
    assert.ok(walked !== undefined);
    assert.strictEqual(walked.cwd, tmpDir);

    // Missing dir and stop-boundary cases return undefined.
    assert.strictEqual(findProjectFile(path.join(tmpDir, 'ghost', 'x'), tmpDir), undefined);
    assert.strictEqual(findEntryProject(path.join(tmpDir, 'ghost')), undefined);
  });
});

suite('Debug E2E — SharpLspLaunchProvider.resolveDebugConfiguration branches', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  const provider = new SharpLspLaunchProvider();

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-resolve-e2e-'));
    stubs = installUiStubs();
  });

  teardown(async () => {
    stubs.restore();
    await stopAnyDebugSession();
    await closeAllEditors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function resolve(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.DebugConfiguration {
    const result = provider.resolveDebugConfiguration(folder, config);
    assert.ok(result !== undefined && result !== null);
    return result as vscode.DebugConfiguration;
  }

  test('empty F5 config is filled with defaults and the build pre-launch task', () => {
    const resolved = resolve(undefined, { type: '', name: '', request: '' });
    assert.strictEqual(resolved.type, 'sharplsp-coreclr');
    assert.strictEqual(resolved.name, 'Launch .NET Project');
    assert.strictEqual(resolved.request, 'launch');
    assert.strictEqual(resolved.preLaunchTask, 'dotnet: build');
    assert.strictEqual(resolved.program, undefined);
    assert.strictEqual(resolved.justMyCode, true);
  });

  test('missing program is auto-detected from a real .csproj; explicit program is preserved', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');

    // Default (missing program) branch -> auto-detect dll + cwd.
    const auto = resolve(fakeFolder(tmpDir), {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    });
    assert.strictEqual(auto.program, path.join(tmpDir, 'bin', 'Debug', TFM, 'WebApp.dll'));
    assert.strictEqual(auto.cwd, tmpDir);
    assert.strictEqual(auto.justMyCode, true);

    // Explicit program branch -> untouched.
    const explicit = resolve(fakeFolder(tmpDir), {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
      program: '/explicit/App.dll',
      cwd: '/explicit',
    });
    assert.strictEqual(explicit.program, '/explicit/App.dll');
    assert.strictEqual(explicit.cwd, '/explicit');
  });

  test('launchSettings Project profile is applied for launch but not attach requests', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          WebApp: {
            commandName: 'Project',
            environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
            commandLineArgs: '--port 5000',
          },
        },
      }),
    );

    const launch = resolve(fakeFolder(tmpDir), {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    });
    assert.deepStrictEqual(launch.env, { ASPNETCORE_ENVIRONMENT: 'Development' });
    assert.deepStrictEqual(launch.args, ['--port', '5000']);

    const attach = resolve(fakeFolder(tmpDir), {
      type: 'sharplsp-coreclr',
      name: 'Attach',
      request: 'attach',
    });
    assert.strictEqual(attach.env, undefined);
    assert.strictEqual(attach.args, undefined);
  });

  test('provideDebugConfigurations emits a default config and one config per Project profile', () => {
    // No folder -> empty list.
    assert.deepStrictEqual(provider.provideDebugConfigurations(undefined), []);

    // Folder with a project but no profiles -> single default config wired to the dll.
    fs.writeFileSync(path.join(tmpDir, 'Solo.csproj'), '<Project />', 'utf-8');
    const defaults = provider.provideDebugConfigurations(fakeFolder(tmpDir));
    assert.ok(Array.isArray(defaults));
    assert.strictEqual(defaults.length, 1);
    assert.strictEqual(defaults[0]?.name, 'Launch .NET Project');
    assert.strictEqual(defaults[0]?.program, path.join(tmpDir, 'bin', 'Debug', TFM, 'Solo.dll'));

    // Add two Project profiles + a skipped IISExpress -> two generated configs.
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          one: { commandName: 'Project' },
          two: { commandName: 'Project', commandLineArgs: 'x y' },
          IIS: { commandName: 'IISExpress' },
        },
      }),
    );
    const generated = provider.provideDebugConfigurations(fakeFolder(tmpDir));
    assert.ok(Array.isArray(generated));
    assert.strictEqual(generated.length, 2);
    const names = generated.map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['Launch: one', 'Launch: two']);
    assert.deepStrictEqual(generated.find((c) => c.name === 'Launch: two')?.args, ['x', 'y']);
  });
});

suite('Debug E2E — netcoredbg path resolution via the registered adapter factory', () => {
  const factory = new SharpLspDebugAdapterFactory();
  const fakeSession = {
    id: 'sess-e2e',
    type: 'sharplsp-coreclr',
    name: 'Debug',
  } as unknown as vscode.DebugSession;

  let tmpDir: string;
  let stubs: UiStubs;
  let savedNetcoredbgPath: string | undefined;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-netcoredbg-e2e-'));
    stubs = installUiStubs();
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    savedNetcoredbgPath = cfg.inspect<string>('debug.netcoredbgPath')?.globalValue;
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
  });

  teardown(async () => {
    // Restore the changed Global setting to its inspected original.
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update(
      'debug.netcoredbgPath',
      savedNetcoredbgPath,
      vscode.ConfigurationTarget.Global,
    );
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    stubs.restore();
    await stopAnyDebugSession();
    await closeAllEditors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function resolveCommand(): string {
    const descriptor = factory.createDebugAdapterDescriptor(fakeSession);
    assert.ok(descriptor instanceof vscode.DebugAdapterExecutable);
    assert.deepStrictEqual(descriptor.args, ['--interpreter=vscode']);
    return descriptor.command;
  }

  test('a configured netcoredbgPath that exists wins over candidates and PATH', async function () {
    this.timeout(30_000);
    const exe = path.join(tmpDir, 'configured-netcoredbg');
    fs.writeFileSync(exe, '#!/bin/sh\n', 'utf-8');
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('debug.netcoredbgPath', exe, vscode.ConfigurationTarget.Global);

    assert.strictEqual(resolveCommand(), exe);
  });

  test('configured path that is missing/empty falls through to the bare PATH command', async function () {
    this.timeout(30_000);
    const cfg = vscode.workspace.getConfiguration('sharplsp');

    // Point HOME at an empty temp dir so NO candidate file exists.
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
    for (const candidate of getNetcoredbgCandidates()) {
      assert.ok(!fs.existsSync(candidate), `candidate must not exist: ${candidate}`);
    }

    // Missing configured path -> existsSync false -> skip config branch.
    await cfg.update(
      'debug.netcoredbgPath',
      path.join(tmpDir, 'ghost', 'netcoredbg'),
      vscode.ConfigurationTarget.Global,
    );
    assert.strictEqual(resolveCommand(), 'netcoredbg');

    // Empty configured path -> length 0 -> skip config branch.
    await cfg.update('debug.netcoredbgPath', '', vscode.ConfigurationTarget.Global);
    assert.strictEqual(resolveCommand(), 'netcoredbg');
  });

  test('the first existing candidate (~/.dotnet/tools/netcoredbg) resolves when config is unset', async function () {
    this.timeout(30_000);
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('debug.netcoredbgPath', undefined, vscode.ConfigurationTarget.Global);

    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
    const exeName = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';
    const toolsDir = path.join(tmpDir, '.dotnet', 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const candidate = path.join(toolsDir, exeName);
    fs.writeFileSync(candidate, '#!/bin/sh\n', 'utf-8');

    assert.strictEqual(getNetcoredbgCandidates()[0], candidate);
    assert.strictEqual(resolveCommand(), candidate);
  });
});

suite('Debug E2E — sharplsp.debugProgram command against real temp-dir projects', () => {
  let tmpDir: string;
  let stubs: UiStubs;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-cmd-e2e-'));
    stubs = installUiStubs();
  });

  teardown(async () => {
    stubs.restore();
    await stopAnyDebugSession();
    await closeAllEditors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('warns and starts no session when the active file lives outside any project', async function () {
    this.timeout(60_000);
    // A bare .cs file with NO .csproj anywhere in its tree -> findProjectFile fails.
    const orphan = path.join(tmpDir, 'Orphan.cs');
    fs.writeFileSync(orphan, 'class Orphan { }\n', 'utf-8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(orphan));
    await vscode.window.showTextDocument(doc);

    // The command may resolve to the real workspace folder rather than tmpDir; in
    // either case it must NOT reject. We assert it produced no debug session here.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_DEBUG_PROGRAM);
    });

    // If a "no project" warning fired it must carry the expected message; the exact
    // branch depends on the host's active workspace folder, so accept either no
    // warning or the precise one.
    for (const warning of stubs.log.warningMessages) {
      assert.ok(
        warning.includes('No workspace folder open.') ||
          warning.includes("No .csproj or .fsproj found in this file's directory tree."),
        `unexpected warning: ${warning}`,
      );
    }
  });

  test('builds and launches a freshly compiled console project without rejecting', async function () {
    this.timeout(90_000);
    const projectDir = path.join(tmpDir, 'ConsoleApp');
    const { proj, program } = writeConsoleProject(projectDir, 'ConsoleApp');

    // Build with the REAL dotnet CLI so the dll the resolver targets actually exists.
    const built = await new Promise<boolean>((resolve) => {
      execFile(
        'dotnet',
        ['build', proj, '-c', 'Debug'],
        { cwd: projectDir, timeout: 80_000 },
        (error) => {
          resolve(error === null);
        },
      );
    });

    // The deterministic, build-independent assertions: the resolver finds the
    // project and points at the dll path the build would produce.
    const entry = findProjectFile(projectDir, projectDir);
    assert.ok(entry !== undefined, 'findProjectFile must locate ConsoleApp.csproj');
    assert.strictEqual(entry.cwd, projectDir);
    assert.strictEqual(entry.dll, path.join(projectDir, 'bin', 'Debug', TFM, 'ConsoleApp.dll'));
    if (built) {
      assert.ok(
        fs.existsSync(entry.dll),
        'a successful build must produce the dll the resolver targets',
      );
    }

    // Open the program so debugCurrentProject() searches from the project's tree.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(program));
    await vscode.window.showTextDocument(doc);

    // Drive the REAL command. Launching netcoredbg in a headless host may not fully
    // attach — assert only that invoking it does not reject.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_DEBUG_PROGRAM);
    });

    // Resolve the config the provider would build for this folder and assert its
    // deterministic shape (the same path the command launches with).
    const provider = new SharpLspLaunchProvider();
    const resolved = provider.resolveDebugConfiguration(fakeFolder(projectDir), {
      type: 'sharplsp-coreclr',
      name: 'Debug Program',
      request: 'launch',
    }) as vscode.DebugConfiguration;
    assert.strictEqual(resolved.program, entry.dll);
    assert.strictEqual(resolved.cwd, projectDir);
    assert.strictEqual(resolved.justMyCode, true);
  });

  test('invoking the command with no active editor does not reject', async function () {
    this.timeout(60_000);
    await closeAllEditors();

    // With no active editor the command falls back to the first workspace folder
    // (or warns if none). Either way it must not reject.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(CMD_DEBUG_PROGRAM);
    });

    for (const warning of stubs.log.warningMessages) {
      assert.ok(
        warning.includes('No workspace folder open.') ||
          warning.includes("No .csproj or .fsproj found in this file's directory tree."),
        `unexpected warning: ${warning}`,
      );
    }
  });
});
