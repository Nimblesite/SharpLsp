import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

// Build a fake WorkspaceFolder rooted at `root` for provider tests.
function fakeFolder(root: string): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index: 0,
  };
}

// Helper: write a launchSettings.json into <root>/Properties.
function writeLaunchSettings(root: string, body: string): string {
  const propsDir = path.join(root, 'Properties');
  fs.mkdirSync(propsDir, { recursive: true });
  const file = path.join(propsDir, 'launchSettings.json');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

suite('Debug Module — isLaunchSettings()', () => {
  test('accepts a plain object with a profiles property', () => {
    assert.strictEqual(isLaunchSettings({ profiles: {} }), true);
    assert.strictEqual(isLaunchSettings({ profiles: { A: { commandName: 'Project' } } }), true);
  });

  test('accepts an object with profiles even when profiles is not an object', () => {
    // The guard only checks for key presence, not the shape of `profiles`.
    assert.strictEqual(isLaunchSettings({ profiles: 'nope' }), true);
    assert.strictEqual(isLaunchSettings({ profiles: 123 }), true);
    assert.strictEqual(isLaunchSettings({ profiles: null }), true);
    assert.strictEqual(isLaunchSettings({ profiles: undefined }), true);
  });

  test('accepts an object carrying extra unrelated keys alongside profiles', () => {
    assert.strictEqual(isLaunchSettings({ iisSettings: {}, profiles: {} }), true);
  });

  test('rejects an object missing the profiles property', () => {
    assert.strictEqual(isLaunchSettings({}), false);
    assert.strictEqual(isLaunchSettings({ profile: {} }), false);
    assert.strictEqual(isLaunchSettings({ Profiles: {} }), false);
    assert.strictEqual(isLaunchSettings({ iisSettings: {} }), false);
  });

  test('rejects null and undefined', () => {
    assert.strictEqual(isLaunchSettings(null), false);
    assert.strictEqual(isLaunchSettings(undefined), false);
  });

  test('rejects primitive types', () => {
    assert.strictEqual(isLaunchSettings('profiles'), false);
    assert.strictEqual(isLaunchSettings(42), false);
    assert.strictEqual(isLaunchSettings(0), false);
    assert.strictEqual(isLaunchSettings(true), false);
    assert.strictEqual(isLaunchSettings(false), false);
    assert.strictEqual(isLaunchSettings(Symbol('profiles')), false);
    assert.strictEqual(isLaunchSettings(BigInt(1)), false);
  });

  test('rejects a bare array without a profiles key', () => {
    // typeof [] === 'object' and [] !== null, but '0'/'profiles' keys absent.
    assert.strictEqual(isLaunchSettings([]), false);
    assert.strictEqual(isLaunchSettings([1, 2, 3]), false);
  });

  test('accepts an array that has had a profiles property attached', () => {
    const arr: unknown[] = [];
    (arr as unknown as { profiles: unknown }).profiles = {};
    // `'profiles' in arr` is now true, so the guard passes.
    assert.strictEqual(isLaunchSettings(arr), true);
  });

  test('respects inherited profiles property via prototype chain', () => {
    const proto = { profiles: {} };
    const child = Object.create(proto) as object;
    // `in` checks the prototype chain too.
    assert.strictEqual(isLaunchSettings(child), true);
  });

  test('rejects functions', () => {
    assert.strictEqual(
      isLaunchSettings(() => undefined),
      false,
    );
  });
});

suite('Debug Module — readLaunchProfiles()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-profiles-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty object when no launchSettings.json exists', () => {
    const profiles = readLaunchProfiles(tmpDir);
    assert.deepStrictEqual(profiles, {});
  });

  test('returns empty object for a non-existent root path', () => {
    const profiles = readLaunchProfiles(path.join(tmpDir, 'does', 'not', 'exist'));
    assert.deepStrictEqual(profiles, {});
  });

  test('parses a single Project profile', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          MyApp: {
            commandName: 'Project',
            applicationUrl: 'https://localhost:5001',
          },
        },
      }),
    );
    const profiles = readLaunchProfiles(tmpDir);
    assert.deepStrictEqual(Object.keys(profiles), ['MyApp']);
    assert.strictEqual(profiles.MyApp?.commandName, 'Project');
    assert.strictEqual(profiles.MyApp?.applicationUrl, 'https://localhost:5001');
  });

  test('parses multiple profiles preserving environmentVariables and commandLineArgs', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          http: {
            commandName: 'Project',
            commandLineArgs: '--port 8080 --verbose',
            environmentVariables: {
              ASPNETCORE_ENVIRONMENT: 'Development',
              FOO: 'bar',
            },
          },
          IIS: {
            commandName: 'IISExpress',
          },
        },
      }),
    );
    const profiles = readLaunchProfiles(tmpDir);
    assert.deepStrictEqual(Object.keys(profiles).sort(), ['IIS', 'http']);
    assert.strictEqual(profiles.http?.commandLineArgs, '--port 8080 --verbose');
    assert.deepStrictEqual(profiles.http?.environmentVariables, {
      ASPNETCORE_ENVIRONMENT: 'Development',
      FOO: 'bar',
    });
    assert.strictEqual(profiles.IIS?.commandName, 'IISExpress');
    assert.strictEqual(profiles.IIS?.environmentVariables, undefined);
  });

  test('returns the profiles object verbatim (empty profiles map)', () => {
    writeLaunchSettings(tmpDir, JSON.stringify({ profiles: {} }));
    const profiles = readLaunchProfiles(tmpDir);
    assert.deepStrictEqual(profiles, {});
  });

  test('returns empty object when JSON is valid but has no profiles key', () => {
    // isLaunchSettings(parsed) is false -> the function returns {}.
    writeLaunchSettings(tmpDir, JSON.stringify({ iisSettings: { windowsAuthentication: true } }));
    const profiles = readLaunchProfiles(tmpDir);
    assert.deepStrictEqual(profiles, {});
  });

  test('returns empty object when JSON is malformed (defensive parse)', () => {
    writeLaunchSettings(tmpDir, '{ this is not valid json ');
    assert.doesNotThrow(() => readLaunchProfiles(tmpDir));
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});
  });

  test('returns empty object when file content is empty string', () => {
    writeLaunchSettings(tmpDir, '');
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});
  });

  test('returns empty object when JSON is a bare array', () => {
    // parsed is an array; isLaunchSettings([...]) is false -> {}.
    writeLaunchSettings(tmpDir, JSON.stringify([1, 2, 3]));
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});
  });

  test('returns empty object when JSON is a primitive literal', () => {
    writeLaunchSettings(tmpDir, JSON.stringify('just a string'));
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});
    writeLaunchSettings(tmpDir, JSON.stringify(42));
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});
    writeLaunchSettings(tmpDir, JSON.stringify(null));
    assert.deepStrictEqual(readLaunchProfiles(tmpDir), {});
  });

  test('preserves profiles even when a .csproj sits beside Properties', () => {
    // The presence of a project file adds a duplicate candidate path; the
    // result must still be the parsed profiles, not affected by the dedup path.
    fs.writeFileSync(path.join(tmpDir, 'App.csproj'), '<Project />', 'utf-8');
    writeLaunchSettings(tmpDir, JSON.stringify({ profiles: { Web: { commandName: 'Project' } } }));
    const profiles = readLaunchProfiles(tmpDir);
    assert.deepStrictEqual(Object.keys(profiles), ['Web']);
    assert.strictEqual(profiles.Web?.commandName, 'Project');
  });

  test('handles unicode and special-regex characters inside profile values', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          'プロファイル (.*)': {
            commandName: 'Project',
            commandLineArgs: '--name "café ☕" --pattern .*+?[]',
            environmentVariables: { 'KEY.$1': 'välue™' },
          },
        },
      }),
    );
    const profiles = readLaunchProfiles(tmpDir);
    const key = 'プロファイル (.*)';
    assert.deepStrictEqual(Object.keys(profiles), [key]);
    assert.strictEqual(profiles[key]?.commandLineArgs, '--name "café ☕" --pattern .*+?[]');
    assert.strictEqual(profiles[key]?.environmentVariables?.['KEY.$1'], 'välue™');
  });
});

suite('Debug Module — getNetcoredbgCandidates()', () => {
  test('returns a non-empty array of strings', () => {
    const candidates = getNetcoredbgCandidates();
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      assert.strictEqual(typeof candidate, 'string');
      assert.ok(candidate.length > 0);
    }
  });

  test('returns exactly five candidate paths', () => {
    assert.strictEqual(getNetcoredbgCandidates().length, 5);
  });

  test('every candidate ends with the platform-correct executable name', () => {
    const exe = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';
    for (const candidate of getNetcoredbgCandidates()) {
      assert.ok(candidate.endsWith(exe), `expected ${candidate} to end with ${exe}`);
    }
  });

  test('includes the dotnet global tools path and the well-known unix prefixes', () => {
    const exe = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';
    const candidates = getNetcoredbgCandidates();
    assert.ok(candidates.includes(`/usr/local/bin/${exe}`));
    assert.ok(candidates.includes(`/usr/bin/${exe}`));
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    assert.ok(candidates.includes(path.join(home, '.dotnet', 'tools', exe)));
    assert.ok(candidates.includes(path.join(home, '.local', 'share', 'netcoredbg', exe)));
    assert.ok(candidates.includes(path.join(home, 'AppData', 'Local', 'netcoredbg', exe)));
  });

  test('candidate list is deterministic across calls', () => {
    assert.deepStrictEqual(getNetcoredbgCandidates(), getNetcoredbgCandidates());
  });
});

suite('Debug Module — projectEntryFromFile()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-entry-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('falls back to net10.0 dll path when nothing is built', () => {
    const projFile = path.join(tmpDir, 'MyApp.csproj');
    const entry = projectEntryFromFile(projFile);
    assert.strictEqual(entry.cwd, tmpDir);
    assert.strictEqual(entry.dll, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'MyApp.dll'));
  });

  test('prefers net10.0 dll when present', () => {
    const projFile = path.join(tmpDir, 'Pref.csproj');
    const dllDir = path.join(tmpDir, 'bin', 'Debug', 'net10.0');
    fs.mkdirSync(dllDir, { recursive: true });
    fs.writeFileSync(path.join(dllDir, 'Pref.dll'), '', 'utf-8');
    const entry = projectEntryFromFile(projFile);
    assert.strictEqual(entry.dll, path.join(dllDir, 'Pref.dll'));
    assert.strictEqual(entry.cwd, tmpDir);
  });

  test('falls back to net9.0 when net10.0 is absent', () => {
    const projFile = path.join(tmpDir, 'Nine.csproj');
    const dllDir = path.join(tmpDir, 'bin', 'Debug', 'net9.0');
    fs.mkdirSync(dllDir, { recursive: true });
    fs.writeFileSync(path.join(dllDir, 'Nine.dll'), '', 'utf-8');
    const entry = projectEntryFromFile(projFile);
    assert.strictEqual(entry.dll, path.join(dllDir, 'Nine.dll'));
  });

  test('falls back to net8.0 when net10.0 and net9.0 are absent', () => {
    const projFile = path.join(tmpDir, 'Eight.csproj');
    const dllDir = path.join(tmpDir, 'bin', 'Debug', 'net8.0');
    fs.mkdirSync(dllDir, { recursive: true });
    fs.writeFileSync(path.join(dllDir, 'Eight.dll'), '', 'utf-8');
    const entry = projectEntryFromFile(projFile);
    assert.strictEqual(entry.dll, path.join(dllDir, 'Eight.dll'));
  });

  test('prefers net10.0 over net9.0 and net8.0 when several are built', () => {
    const projFile = path.join(tmpDir, 'All.csproj');
    for (const tfm of ['net8.0', 'net9.0', 'net10.0']) {
      const dllDir = path.join(tmpDir, 'bin', 'Debug', tfm);
      fs.mkdirSync(dllDir, { recursive: true });
      fs.writeFileSync(path.join(dllDir, 'All.dll'), '', 'utf-8');
    }
    const entry = projectEntryFromFile(projFile);
    assert.strictEqual(entry.dll, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'All.dll'));
  });

  test('strips the .fsproj extension to derive the dll name', () => {
    const projFile = path.join(tmpDir, 'FSharpLib.fsproj');
    const entry = projectEntryFromFile(projFile);
    assert.strictEqual(entry.dll, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'FSharpLib.dll'));
  });

  test('derives the dll name from the basename only, not the directory', () => {
    const nested = path.join(tmpDir, 'src', 'Service');
    fs.mkdirSync(nested, { recursive: true });
    const projFile = path.join(nested, 'Service.Api.csproj');
    const entry = projectEntryFromFile(projFile);
    // Multi-dot name: extname is '.csproj', so only that is stripped.
    assert.strictEqual(entry.dll, path.join(nested, 'bin', 'Debug', 'net10.0', 'Service.Api.dll'));
    assert.strictEqual(entry.cwd, nested);
  });
});

suite('Debug Module — findProjectFile()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-find-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds a .csproj directly in the start directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'Direct.csproj'), '<Project />', 'utf-8');
    const entry = findProjectFile(tmpDir, tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.cwd, tmpDir);
    assert.strictEqual(entry.dll, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Direct.dll'));
  });

  test('finds a .fsproj directly in the start directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'Lib.fsproj'), '<Project />', 'utf-8');
    const entry = findProjectFile(tmpDir, tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.dll, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Lib.dll'));
  });

  test('returns undefined when start equals stop and no project exists', () => {
    assert.strictEqual(findProjectFile(tmpDir, tmpDir), undefined);
  });

  test('walks up to a parent directory to find a project', () => {
    fs.writeFileSync(path.join(tmpDir, 'Root.csproj'), '<Project />', 'utf-8');
    const child = path.join(tmpDir, 'a', 'b');
    fs.mkdirSync(child, { recursive: true });
    const entry = findProjectFile(child, tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.cwd, tmpDir);
    assert.strictEqual(entry.dll, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Root.dll'));
  });

  test('returns the nearest project when both child and ancestor have one', () => {
    fs.writeFileSync(path.join(tmpDir, 'Outer.csproj'), '<Project />', 'utf-8');
    const child = path.join(tmpDir, 'inner');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'Inner.csproj'), '<Project />', 'utf-8');
    const entry = findProjectFile(child, tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.cwd, child);
    assert.strictEqual(entry.dll, path.join(child, 'bin', 'Debug', 'net10.0', 'Inner.dll'));
  });

  test('stops at stopPath and returns undefined without scanning above it', () => {
    // Project lives ABOVE the stop boundary, so it must not be discovered.
    fs.writeFileSync(path.join(tmpDir, 'Above.csproj'), '<Project />', 'utf-8');
    const stop = path.join(tmpDir, 'boundary');
    const start = path.join(stop, 'deep');
    fs.mkdirSync(start, { recursive: true });
    assert.strictEqual(findProjectFile(start, stop), undefined);
  });

  test('returns undefined when the start directory cannot be read', () => {
    const missing = path.join(tmpDir, 'no', 'such', 'dir');
    assert.strictEqual(findProjectFile(missing, tmpDir), undefined);
  });

  test('ignores non-project files in the directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# hi', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'app.sln'), '', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'notes.csproj.bak'), '', 'utf-8');
    assert.strictEqual(findProjectFile(tmpDir, tmpDir), undefined);
  });
});

suite('Debug Module — findEntryProject()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-entryproj-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds a project in the root path', () => {
    fs.writeFileSync(path.join(tmpDir, 'Entry.csproj'), '<Project />', 'utf-8');
    const entry = findEntryProject(tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.cwd, tmpDir);
    assert.strictEqual(entry.dll, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Entry.dll'));
  });

  test('returns undefined for a root path with no project (search does not walk up)', () => {
    // findEntryProject passes rootPath as both start and stop, so a project in
    // a PARENT of rootPath is never discovered.
    fs.writeFileSync(path.join(tmpDir, 'Parent.csproj'), '<Project />', 'utf-8');
    const child = path.join(tmpDir, 'child');
    fs.mkdirSync(child, { recursive: true });
    assert.strictEqual(findEntryProject(child), undefined);
  });

  test('returns undefined for a non-existent root path', () => {
    assert.strictEqual(findEntryProject(path.join(tmpDir, 'ghost')), undefined);
  });
});

suite('Debug Module — applyLaunchProfile()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-apply-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(
    overrides: Partial<vscode.DebugConfiguration> = {},
  ): vscode.DebugConfiguration {
    return {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
      ...overrides,
    };
  }

  test('does nothing when there are no profiles', () => {
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.strictEqual(config.env, undefined);
    assert.strictEqual(config.args, undefined);
  });

  test('does nothing when no Project-command profile exists', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          IIS: {
            commandName: 'IISExpress',
            environmentVariables: { X: '1' },
            commandLineArgs: '--ignored',
          },
        },
      }),
    );
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.strictEqual(config.env, undefined);
    assert.strictEqual(config.args, undefined);
  });

  test('applies environmentVariables from the first Project profile', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          App: {
            commandName: 'Project',
            environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development', LEVEL: 'Trace' },
          },
        },
      }),
    );
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.deepStrictEqual(config.env, {
      ASPNETCORE_ENVIRONMENT: 'Development',
      LEVEL: 'Trace',
    });
    assert.strictEqual(config.args, undefined);
  });

  test('splits commandLineArgs on spaces into the args array', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          App: {
            commandName: 'Project',
            commandLineArgs: '--port 8080 --verbose',
          },
        },
      }),
    );
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.deepStrictEqual(config.args, ['--port', '8080', '--verbose']);
    assert.strictEqual(config.env, undefined);
  });

  test('applies both env and args from a single Project profile', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          App: {
            commandName: 'Project',
            environmentVariables: { FOO: 'bar' },
            commandLineArgs: 'one two',
          },
        },
      }),
    );
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.deepStrictEqual(config.env, { FOO: 'bar' });
    assert.deepStrictEqual(config.args, ['one', 'two']);
  });

  test('does not overwrite an env that is already set on the config', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: { App: { commandName: 'Project', environmentVariables: { FROM: 'profile' } } },
      }),
    );
    const config = makeConfig({ env: { FROM: 'existing' } });
    applyLaunchProfile(tmpDir, config);
    assert.deepStrictEqual(config.env, { FROM: 'existing' });
  });

  test('does not overwrite args that are already set on the config', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: { App: { commandName: 'Project', commandLineArgs: 'from profile' } },
      }),
    );
    const config = makeConfig({ args: ['preexisting'] });
    applyLaunchProfile(tmpDir, config);
    assert.deepStrictEqual(config.args, ['preexisting']);
  });

  test('does not set args when commandLineArgs is an empty string', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: { App: { commandName: 'Project', commandLineArgs: '' } },
      }),
    );
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.strictEqual(config.args, undefined);
  });

  test('uses the first Project profile when multiple exist', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          First: { commandName: 'Project', environmentVariables: { WHICH: 'first' } },
          Second: { commandName: 'Project', environmentVariables: { WHICH: 'second' } },
        },
      }),
    );
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.deepStrictEqual(config.env, { WHICH: 'first' });
  });

  test('skips non-Project profiles and selects the first Project one', () => {
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
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.deepStrictEqual(config.env, { WHICH: 'web' });
    assert.deepStrictEqual(config.args, ['a', 'b', 'c']);
  });

  test('does not mutate type/name/request fields of the config', () => {
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: { App: { commandName: 'Project', environmentVariables: { A: '1' } } },
      }),
    );
    const config = makeConfig();
    applyLaunchProfile(tmpDir, config);
    assert.strictEqual(config.type, 'sharplsp-coreclr');
    assert.strictEqual(config.name, 'Launch');
    assert.strictEqual(config.request, 'launch');
  });
});

suite('Debug Module — SharpLspLaunchProvider.resolveDebugConfiguration()', () => {
  let tmpDir: string;
  const provider = new SharpLspLaunchProvider();

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-resolve-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // resolveDebugConfiguration returns the (possibly mutated) config synchronously.
  function resolve(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.DebugConfiguration {
    const result = provider.resolveDebugConfiguration(folder, config);
    assert.ok(result !== undefined && result !== null);
    return result as vscode.DebugConfiguration;
  }

  test('fills in defaults for an empty F5 config (no type/request/name)', () => {
    const config: vscode.DebugConfiguration = { type: '', name: '', request: '' };
    const resolved = resolve(undefined, config);
    assert.strictEqual(resolved.type, 'sharplsp-coreclr');
    assert.strictEqual(resolved.name, 'Launch .NET Project');
    assert.strictEqual(resolved.request, 'launch');
    assert.strictEqual(resolved.preLaunchTask, 'dotnet: build');
    // No folder -> no program auto-detection; justMyCode defaulted on.
    assert.strictEqual(resolved.program, undefined);
    assert.strictEqual(resolved.justMyCode, true);
  });

  test('leaves a fully specified config type/name/request untouched', () => {
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'My Launch',
      request: 'launch',
    };
    const resolved = resolve(undefined, config);
    assert.strictEqual(resolved.type, 'sharplsp-coreclr');
    assert.strictEqual(resolved.name, 'My Launch');
    assert.strictEqual(resolved.request, 'launch');
    // preLaunchTask only set for the all-empty case.
    assert.strictEqual(resolved.preLaunchTask, undefined);
  });

  test('auto-detects the entry .csproj program and cwd when none is given', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    };
    const resolved = resolve(fakeFolder(tmpDir), config);
    assert.strictEqual(
      resolved.program,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'WebApp.dll'),
    );
    assert.strictEqual(resolved.cwd, tmpDir);
    assert.strictEqual(resolved.justMyCode, true);
  });

  test('auto-detects an F# .fsproj program and cwd', () => {
    fs.writeFileSync(path.join(tmpDir, 'FSharpApp.fsproj'), '<Project />', 'utf-8');
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    };
    const resolved = resolve(fakeFolder(tmpDir), config);
    assert.strictEqual(
      resolved.program,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'FSharpApp.dll'),
    );
    assert.strictEqual(resolved.cwd, tmpDir);
  });

  test('does not auto-detect when the folder has no project file', () => {
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    };
    const resolved = resolve(fakeFolder(tmpDir), config);
    assert.strictEqual(resolved.program, undefined);
    assert.strictEqual(resolved.cwd, undefined);
    // justMyCode still defaulted on.
    assert.strictEqual(resolved.justMyCode, true);
  });

  test('does not overwrite an explicitly provided program/cwd', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
      program: '/explicit/path/App.dll',
      cwd: '/explicit',
    };
    const resolved = resolve(fakeFolder(tmpDir), config);
    assert.strictEqual(resolved.program, '/explicit/path/App.dll');
    assert.strictEqual(resolved.cwd, '/explicit');
  });

  test('applies a launchSettings.json Project profile (env + args) for launch requests', () => {
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
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    };
    const resolved = resolve(fakeFolder(tmpDir), config);
    assert.deepStrictEqual(resolved.env, { ASPNETCORE_ENVIRONMENT: 'Development' });
    assert.deepStrictEqual(resolved.args, ['--port', '5000']);
    assert.strictEqual(
      resolved.program,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'WebApp.dll'),
    );
  });

  test('does not apply launch profiles for a non-launch (attach) request', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: { WebApp: { commandName: 'Project', commandLineArgs: '--port 5000' } },
      }),
    );
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Attach',
      request: 'attach',
    };
    const resolved = resolve(fakeFolder(tmpDir), config);
    assert.strictEqual(resolved.args, undefined);
    assert.strictEqual(resolved.env, undefined);
  });

  test('preserves a caller-supplied justMyCode=false', () => {
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
      justMyCode: false,
    };
    const resolved = resolve(undefined, config);
    assert.strictEqual(resolved.justMyCode, false);
  });

  test('returns the same config object instance (mutates in place)', () => {
    const config: vscode.DebugConfiguration = {
      type: 'sharplsp-coreclr',
      name: 'Launch',
      request: 'launch',
    };
    const resolved = resolve(undefined, config);
    assert.strictEqual(resolved, config);
  });
});

suite('Debug Module — SharpLspLaunchProvider.provideDebugConfigurations()', () => {
  let tmpDir: string;
  const provider = new SharpLspLaunchProvider();

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-provide-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function provide(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
    const result = provider.provideDebugConfigurations(folder);
    assert.ok(Array.isArray(result));
    return result;
  }

  test('returns an empty array when no folder is given', () => {
    assert.deepStrictEqual(provide(undefined), []);
  });

  test('emits a default config when the folder has no profiles or project', () => {
    const configs = provide(fakeFolder(tmpDir));
    assert.strictEqual(configs.length, 1);
    const config = configs[0];
    assert.ok(config !== undefined);
    assert.strictEqual(config.type, 'sharplsp-coreclr');
    assert.strictEqual(config.request, 'launch');
    assert.strictEqual(config.name, 'Launch .NET Project');
    assert.strictEqual(
      config.program,
      '${workspaceFolder}/bin/Debug/net9.0/${workspaceFolderBasename}.dll',
    );
    assert.strictEqual(config.cwd, '${workspaceFolder}');
    assert.strictEqual(config.justMyCode, true);
  });

  test('default config uses the discovered project dll when one exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'Solo.csproj'), '<Project />', 'utf-8');
    const configs = provide(fakeFolder(tmpDir));
    assert.strictEqual(configs.length, 1);
    const config = configs[0];
    assert.ok(config !== undefined);
    assert.strictEqual(config.program, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Solo.dll'));
    assert.strictEqual(config.cwd, tmpDir);
  });

  test('generates one config per Project profile with env and args', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          http: {
            commandName: 'Project',
            environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
            commandLineArgs: '--urls http://localhost:5000',
          },
          IIS: { commandName: 'IISExpress' },
        },
      }),
    );
    const configs = provide(fakeFolder(tmpDir));
    // Only the Project profile produces a config (IISExpress is skipped).
    assert.strictEqual(configs.length, 1);
    const config = configs[0];
    assert.ok(config !== undefined);
    assert.strictEqual(config.name, 'Launch: http');
    assert.strictEqual(config.type, 'sharplsp-coreclr');
    assert.strictEqual(config.request, 'launch');
    assert.strictEqual(config.program, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'WebApp.dll'));
    assert.strictEqual(config.cwd, tmpDir);
    assert.deepStrictEqual(config.env, { ASPNETCORE_ENVIRONMENT: 'Development' });
    assert.deepStrictEqual(config.args, ['--urls', 'http://localhost:5000']);
    assert.strictEqual(config.justMyCode, true);
  });

  test('generates a config per Project profile when multiple exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: {
          one: { commandName: 'Project' },
          two: { commandName: 'Project', commandLineArgs: 'x y' },
        },
      }),
    );
    const configs = provide(fakeFolder(tmpDir));
    assert.strictEqual(configs.length, 2);
    const names = configs.map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['Launch: one', 'Launch: two']);
    const two = configs.find((c) => c.name === 'Launch: two');
    assert.deepStrictEqual(two?.args, ['x', 'y']);
    const one = configs.find((c) => c.name === 'Launch: one');
    assert.strictEqual(one?.args, undefined);
  });

  test('falls back to the default config when a Project profile has no entry project', () => {
    // Profiles exist but there is no .csproj/.fsproj, so findEntryProject returns
    // undefined and the per-profile loop produces nothing -> default config.
    writeLaunchSettings(tmpDir, JSON.stringify({ profiles: { web: { commandName: 'Project' } } }));
    const configs = provide(fakeFolder(tmpDir));
    assert.strictEqual(configs.length, 1);
    const config = configs[0];
    assert.ok(config !== undefined);
    assert.strictEqual(config.name, 'Launch .NET Project');
  });

  test('omits args when a Project profile has an empty commandLineArgs', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: { web: { commandName: 'Project', commandLineArgs: '' } },
      }),
    );
    const configs = provide(fakeFolder(tmpDir));
    assert.strictEqual(configs.length, 1);
    const config = configs[0];
    assert.ok(config !== undefined);
    assert.strictEqual(config.args, undefined);
    assert.strictEqual(config.env, undefined);
  });

  test('skips non-Project profiles entirely and emits the default config', () => {
    fs.writeFileSync(path.join(tmpDir, 'WebApp.csproj'), '<Project />', 'utf-8');
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({
        profiles: { IIS: { commandName: 'IISExpress' }, IISX: { commandName: 'IIS Express' } },
      }),
    );
    const configs = provide(fakeFolder(tmpDir));
    assert.strictEqual(configs.length, 1);
    const config = configs[0];
    assert.ok(config !== undefined);
    // No Project profiles -> default fallback config (uses the discovered dll).
    assert.strictEqual(config.name, 'Launch .NET Project');
    assert.strictEqual(config.program, path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'WebApp.dll'));
  });
});

suite('Debug Module — SharpLspDebugAdapterFactory.createDebugAdapterDescriptor()', () => {
  const factory = new SharpLspDebugAdapterFactory();

  const fakeSession = {
    id: 'sess-1',
    type: 'sharplsp-coreclr',
    name: 'Debug',
  } as unknown as vscode.DebugSession;

  test('returns a DebugAdapterExecutable pointing at netcoredbg', () => {
    const descriptor = factory.createDebugAdapterDescriptor(fakeSession);
    // findNetcoredbg falls back to the bare "netcoredbg" command on PATH when no
    // candidate file exists, so a descriptor is always produced in this env.
    assert.ok(descriptor !== undefined && descriptor !== null);
    assert.ok(descriptor instanceof vscode.DebugAdapterExecutable);
    const exe = descriptor;
    // The command is either a resolved absolute path or the bare PATH command.
    assert.strictEqual(typeof exe.command, 'string');
    assert.ok(exe.command.length > 0);
    assert.ok(
      exe.command === 'netcoredbg' ||
        exe.command.endsWith('netcoredbg') ||
        exe.command.endsWith('netcoredbg.exe'),
      `unexpected netcoredbg command: ${exe.command}`,
    );
  });

  test('passes the vscode interpreter flag as the only argument', () => {
    const descriptor = factory.createDebugAdapterDescriptor(fakeSession);
    assert.ok(descriptor instanceof vscode.DebugAdapterExecutable);
    assert.deepStrictEqual(descriptor.args, ['--interpreter=vscode']);
  });

  test('produces an equivalent descriptor across repeated calls', () => {
    const first = factory.createDebugAdapterDescriptor(fakeSession);
    const second = factory.createDebugAdapterDescriptor(fakeSession);
    assert.ok(first instanceof vscode.DebugAdapterExecutable);
    assert.ok(second instanceof vscode.DebugAdapterExecutable);
    assert.strictEqual(first.command, second.command);
    assert.deepStrictEqual(first.args, second.args);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findNetcoredbg() resolution branches, exercised through the factory.
// findNetcoredbg is module-private, so we drive it via
// SharpLspDebugAdapterFactory.createDebugAdapterDescriptor and assert which
// path the produced DebugAdapterExecutable points at:
//   - the user-configured `sharplsp.debug.netcoredbgPath` (debug.ts 186-188)
//   - the first existing entry from getNetcoredbgCandidates()   (debug.ts 192-195)
//   - the bare `netcoredbg` PATH fallback                       (debug.ts 199)
// ─────────────────────────────────────────────────────────────────────────────
suite('Debug Module — findNetcoredbg() resolution via the adapter factory', () => {
  const factory = new SharpLspDebugAdapterFactory();
  const fakeSession = {
    id: 'sess-resolve',
    type: 'sharplsp-coreclr',
    name: 'Debug',
  } as unknown as vscode.DebugSession;

  let tmpDir: string;
  let savedNetcoredbgPath: string | undefined;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  setup(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-netcoredbg-'));
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    savedNetcoredbgPath = cfg.get<string>('debug.netcoredbgPath');
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
  });

  teardown(async () => {
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update(
      'debug.netcoredbgPath',
      savedNetcoredbgPath,
      vscode.ConfigurationTarget.Global,
    );
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Resolve the descriptor and assert it is an executable, returning its command. */
  function resolveCommand(): string {
    const descriptor = factory.createDebugAdapterDescriptor(fakeSession);
    assert.ok(descriptor instanceof vscode.DebugAdapterExecutable);
    assert.deepStrictEqual(descriptor.args, ['--interpreter=vscode']);
    return descriptor.command;
  }

  test('an existing configured netcoredbgPath wins over candidates and PATH', async () => {
    const exe = path.join(tmpDir, 'configured-netcoredbg');
    fs.writeFileSync(exe, '#!/bin/sh\n', 'utf-8');
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('debug.netcoredbgPath', exe, vscode.ConfigurationTarget.Global);

    // Configured path branch (debug.ts 186-188): the descriptor uses it verbatim.
    assert.strictEqual(resolveCommand(), exe);
  });

  test('a configured netcoredbgPath that does NOT exist falls through past the config branch', async () => {
    const missing = path.join(tmpDir, 'ghost', 'netcoredbg');
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('debug.netcoredbgPath', missing, vscode.ConfigurationTarget.Global);

    // fs.existsSync(configured) is false → the config branch is skipped. With no
    // candidate created and HOME pointed at an empty temp dir, the result is the
    // bare PATH command. (Confirms 186's guard rejects a non-existent path.)
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
    assert.strictEqual(resolveCommand(), 'netcoredbg');
  });

  test('an empty configured netcoredbgPath is treated as unset and skips the config branch', async () => {
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('debug.netcoredbgPath', '', vscode.ConfigurationTarget.Global);

    // length === 0 → config branch skipped; empty HOME has no candidate → PATH.
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
    assert.strictEqual(resolveCommand(), 'netcoredbg');
  });

  test('resolves the first existing candidate (~/.dotnet/tools/netcoredbg) when config is unset', async () => {
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('debug.netcoredbgPath', undefined, vscode.ConfigurationTarget.Global);

    // Point HOME at our temp dir and materialise the FIRST candidate so the
    // candidates loop (debug.ts 192-195) returns it before reaching PATH.
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
    const exeName = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';
    const toolsDir = path.join(tmpDir, '.dotnet', 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const candidate = path.join(toolsDir, exeName);
    fs.writeFileSync(candidate, '#!/bin/sh\n', 'utf-8');

    // The candidate must be exactly the first entry getNetcoredbgCandidates() lists.
    assert.strictEqual(getNetcoredbgCandidates()[0], candidate);
    assert.strictEqual(resolveCommand(), candidate);
  });

  test('falls back to the bare PATH command when nothing is configured and no candidate exists', async () => {
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('debug.netcoredbgPath', undefined, vscode.ConfigurationTarget.Global);

    // Empty HOME → none of the five candidates exist → PATH fallback (debug.ts 199).
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
    const exeName = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';
    for (const candidate of getNetcoredbgCandidates()) {
      assert.ok(!fs.existsSync(candidate), `candidate must not exist: ${candidate}`);
    }
    assert.strictEqual(
      resolveCommand(),
      exeName === 'netcoredbg.exe' ? 'netcoredbg.exe' : 'netcoredbg',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findProjectFile() loop-exhaustion branch (debug.ts 244): the walk reaches the
// filesystem root through readable ancestors WITHOUT finding a project and
// WITHOUT current ever equalling stopPath, so the while loop ends naturally and
// the trailing `return undefined` executes.
// ─────────────────────────────────────────────────────────────────────────────
suite('Debug Module — findProjectFile() walks to the root and returns undefined', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-debug-root-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('exhausts the ancestor chain to the filesystem root (stopPath never matched)', () => {
    // start is a real, readable, project-free directory; stopPath is an
    // unrelated path that is NEVER on start's ancestor chain, so the early
    // `current === stopPath` exit can never fire. The walk climbs every readable
    // ancestor up to '/', where path.dirname('/') === '/' makes current undefined
    // and the loop terminates at the trailing `return undefined` (debug.ts 244).
    const deep = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    const unrelatedStop = path.join(tmpDir, 'sibling', 'never-on-the-chain');
    const entry = findProjectFile(deep, unrelatedStop);
    assert.strictEqual(entry, undefined);
  });

  test('returns undefined when no project lies anywhere up to the root', () => {
    // Single-level readable directory whose stopPath is also never matched.
    const start = path.join(tmpDir, 'leaf');
    fs.mkdirSync(start, { recursive: true });
    assert.strictEqual(findProjectFile(start, path.join(tmpDir, 'not-an-ancestor')), undefined);
  });
});
