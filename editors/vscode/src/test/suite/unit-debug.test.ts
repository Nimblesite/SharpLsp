import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
  applyLaunchProfile,
  findEntryProject,
  findProjectFile,
  getNetcoredbgCandidates,
  isLaunchSettings,
  projectEntryFromFile,
  readLaunchProfiles,
} from '../../debug.js';

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
    writeLaunchSettings(
      tmpDir,
      JSON.stringify({ profiles: { Web: { commandName: 'Project' } } }),
    );
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
      assert.ok(
        candidate.endsWith(exe),
        `expected ${candidate} to end with ${exe}`,
      );
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
    assert.strictEqual(
      entry.dll,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'FSharpLib.dll'),
    );
  });

  test('derives the dll name from the basename only, not the directory', () => {
    const nested = path.join(tmpDir, 'src', 'Service');
    fs.mkdirSync(nested, { recursive: true });
    const projFile = path.join(nested, 'Service.Api.csproj');
    const entry = projectEntryFromFile(projFile);
    // Multi-dot name: extname is '.csproj', so only that is stripped.
    assert.strictEqual(
      entry.dll,
      path.join(nested, 'bin', 'Debug', 'net10.0', 'Service.Api.dll'),
    );
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
    assert.strictEqual(
      entry.dll,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Direct.dll'),
    );
  });

  test('finds a .fsproj directly in the start directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'Lib.fsproj'), '<Project />', 'utf-8');
    const entry = findProjectFile(tmpDir, tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(
      entry.dll,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Lib.dll'),
    );
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
    assert.strictEqual(
      entry.dll,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Root.dll'),
    );
  });

  test('returns the nearest project when both child and ancestor have one', () => {
    fs.writeFileSync(path.join(tmpDir, 'Outer.csproj'), '<Project />', 'utf-8');
    const child = path.join(tmpDir, 'inner');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'Inner.csproj'), '<Project />', 'utf-8');
    const entry = findProjectFile(child, tmpDir);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.cwd, child);
    assert.strictEqual(
      entry.dll,
      path.join(child, 'bin', 'Debug', 'net10.0', 'Inner.dll'),
    );
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
    assert.strictEqual(
      entry.dll,
      path.join(tmpDir, 'bin', 'Debug', 'net10.0', 'Entry.dll'),
    );
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

  function makeConfig(overrides: Partial<vscode.DebugConfiguration> = {}): vscode.DebugConfiguration {
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
          Web: { commandName: 'Project', environmentVariables: { WHICH: 'web' }, commandLineArgs: 'a b c' },
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
