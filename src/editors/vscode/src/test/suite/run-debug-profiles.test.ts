// launchSettings.json / <app>.run.json profile handling.
// Spec: [DEBUG-FEATURES-LAUNCH-PROFILES], [DEBUG-FEATURES-LAUNCH-SCRIPT],
// [DEBUG-FEATURES-LAUNCH-OUTPUT].
//
// Every test drives the SHIPPED surface: the exported `readLaunchProfiles` /
// `isLaunchSettings` / `applyLaunchProfile` against real files on disk, plus the
// registered `SharpLspLaunchProvider`. A profile bug is only ever observable as
// the wrong `args`, the wrong `env`, or a thrown `TypeError`, so nothing here is
// mocked. `registerDebugAdapter` is NEVER called: the extension registered the
// provider at activation and a second registration corrupts the host.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  SharpLspLaunchProvider,
  applyLaunchProfile,
  isLaunchSettings,
  readLaunchProfiles,
} from '../../debug.js';
import {
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  TaskRecorder,
  emptyF5Config,
  fakeFolder,
  focusDocument,
  bareF5Config,
  stopAnyDebugSession,
  undefinedF5Config,
} from './run-debug-kit';
import {
  writeCSharpConsole,
  writeFileBasedApp,
  writeLaunchSettings,
  writeRawLaunchSettings,
  writeRunJson,
} from './run-debug-fixtures';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { closeAllEditors, comparablePath, removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS } from './test-timeouts';

/** Shorthand so every assertion helper fits one signature line. */
type Config = vscode.DebugConfiguration;
/** A quoted argument line — the case `commandLineArgs.split(' ')` shreds. */
const QUOTED_ARGS = '--name "John Smith" --path "C:/Program Files/x"';
/** What a real shell-argument parser produces from `QUOTED_ARGS`. */
const QUOTED_TOKENS = ['--name', 'John Smith', '--path', 'C:/Program Files/x'];
/** The `;`-separated multi-URL form ASP.NET Core writes into a profile. */
const APP_URLS = 'https://localhost:7042;http://localhost:5042';
/** The name a hand-written launch configuration carries in these fixtures. */
const BARE_NAME = 'Launch .NET Project';
/** The console [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 1 makes the default. */
const DEFAULT_CONSOLE = 'integratedTerminal';
/** The identity fields no profile application may ever rewrite. */
const LAUNCH_IDENTITY = { type: DEBUG_TYPE_ID, request: 'launch', name: BARE_NAME };
/** Every `profiles` value that is NOT a profile map ([..PROFILES] rule 4). */
const UNSOUND_PROFILES: readonly unknown[] = ['oops', [1, 2], 42, null, true, undefined];
/** Whole documents a user can save that must yield no profiles and no throw. */
const UNSOUND_BODIES: readonly string[] = [
  '{"profiles": "text"}',
  '{"profiles": [1,2]}',
  '{"profiles": 42}',
  '{"profiles": {',
  'nope',
  '',
];

/** A `launchSettings.json` document body around `profiles`. */
function settingsWith(profiles: Record<string, unknown>): Record<string, unknown> {
  return { profiles };
}
/** One `commandName: "Project"` profile — the only kind eligible for launch. */
function projectProfile(fields: Record<string, unknown>): Record<string, unknown> {
  return { commandName: 'Project', ...fields };
}
/** A whole document holding exactly one `Project` profile. */
function oneProfileDoc(name: string, fields: Record<string, unknown>): Record<string, unknown> {
  return settingsWith({ [name]: projectProfile(fields) });
}
/** Labels of whatever was handed to `showQuickPick` (strings or QuickPickItems). */
function pickLabels(items: readonly unknown[]): string[] {
  return items.map((item) =>
    typeof item === 'string' ? item : ((item as { label?: string }).label ?? ''),
  );
}
/** A launch config with `overrides` layered over the bare identity fields. */
function launchConfig(overrides: Record<string, unknown> = {}): Config {
  return { ...LAUNCH_IDENTITY, ...overrides };
}
/** Parse a JSON file back off disk, to prove resolving did not rewrite it. */
function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
/** Fields the caller set MUST come back byte-for-byte, never clobbered. */
function assertPreserved(config: Config, expected: Record<string, unknown>, why: string): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(config[key], value, `${why}: '${key}' must survive untouched`);
  }
}
/** `env` must be a real object holding EXACTLY the expected keys and values. */
function assertEnv(config: Config, expected: Record<string, string>, why: string): void {
  const env: unknown = config.env;
  assert.strictEqual(typeof env, 'object', `${why}: env must be an object, got ${typeof env}`);
  assert.notStrictEqual(env, null, `${why}: env must never be null`);
  assert.strictEqual(Array.isArray(env), false, `${why}: env is a map, never an array`);
  assert.deepStrictEqual(config.env, expected, `${why}: env matches exactly, key for key`);
  const keys = Object.keys(config.env).sort();
  assert.deepStrictEqual(keys, Object.keys(expected).sort(), `${why}: no extra or missing keys`);
}
/** `args` must be real argv: a string array with no shell quoting left in it. */
function assertArgv(config: Config, expected: readonly string[], why: string): void {
  assert.deepStrictEqual(config.args, [...expected], `${why}: tokens match a real shell parser`);
  assert.strictEqual(Array.isArray(config.args), true, `${why}: args must be an array`);
  assert.strictEqual(config.args.length, expected.length, `${why}: exact argv entry count`);
  const tokens = config.args as unknown[];
  const nonStrings = tokens.filter((token) => typeof token !== 'string');
  assert.deepStrictEqual(nonStrings, [], `${why}: every argv entry is a string`);
  const isBad = (t: unknown): boolean => typeof t === 'string' && (t.includes('"') || t === '');
  assert.deepStrictEqual(tokens.filter(isBad), [], `${why}: no quoted or empty argv entry`);
}
/** Everything F5 with no launch.json must synthesize, whatever shape arrives. */
function assertF5Shape(resolved: Config, why: string): void {
  assert.strictEqual(resolved.type, DEBUG_TYPE_ID, `${why}: F5 synthesizes the SharpLsp type`);
  assert.strictEqual(resolved.request, 'launch', `${why}: F5 with no launch.json is a launch`);
  assert.strictEqual(typeof resolved.name, 'string', `${why}: a session needs a name`);
  assert.notStrictEqual(resolved.name, '', `${why}: the synthesized name is not empty`);
  // [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 1 — stdin must work by default.
  assert.strictEqual(resolved.console, DEFAULT_CONSOLE, `${why}: stdin-capable console default`);
  assert.strictEqual(resolved.justMyCode, true, `${why}: justMyCode defaults to true`);
}
/** The resolved program must be the project's OWN output, under its own dir. */
function assertTarget(resolved: Config, dir: string, dll: string): void {
  assert.strictEqual(typeof resolved.program, 'string', 'program must be a path string');
  assert.strictEqual(typeof resolved.cwd, 'string', 'cwd must be a path string');
  const program = comparablePath(String(resolved.program));
  const cwd = comparablePath(String(resolved.cwd));
  assert.strictEqual(cwd, comparablePath(dir), 'cwd is the project dir, not the workspace root');
  assert.strictEqual(path.basename(program), comparablePath(dll), 'program is the project output');
  const under = program.startsWith(comparablePath(dir));
  assert.strictEqual(under, true, `program must sit under ${dir}; got ${program}`);
}
/** Resolve through the real provider, attributing a throw to the resolver. */
async function resolveVia(root: string, config: Config): Promise<Config> {
  const provider = new SharpLspLaunchProvider();
  let resolved: Config | null | undefined;
  try {
    resolved = await provider.resolveDebugConfiguration(fakeFolder(root), config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return assert.fail(
      `resolveDebugConfiguration must be total for the shape VS Code really passes on F5 ` +
        `(${JSON.stringify(config)}); it threw: ${detail}`,
    );
  }
  assert.notStrictEqual(resolved, undefined, 'returning undefined cancels the launch');
  assert.notStrictEqual(resolved, null, 'returning null abandons the launch');
  assert.strictEqual(typeof resolved, 'object', 'a resolver returns a configuration object');
  return resolved!;
}

suite('Run and Debug: launch profiles', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  let sessions: DebugSessionRecorder;
  let tasks: TaskRecorder;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-run-debug-profiles-'));
    stubs = installUiStubs();
    sessions = new DebugSessionRecorder();
    tasks = new TaskRecorder();
  });

  teardown(async () => {
    stubs.restore();
    await stopAnyDebugSession();
    sessions.dispose();
    tasks.dispose();
    await closeAllEditors();
    removeDirRecursive(tmpDir);
  });

  /** A fresh case directory under the suite's temp root. */
  function caseDir(name: string): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The near-universal `<root>/src/App/App.csproj` layout. */
  function canonicalLayout(name: string): { root: string; appDir: string; sourceFile: string } {
    const root = caseDir(name);
    const appDir = path.join(root, 'src', 'App');
    const project = writeCSharpConsole(appDir, 'App');
    return { root, appDir, sourceFile: project.sourceFile };
  }

  /** Apply `dir`'s profiles onto a fresh config; the identity must survive. */
  function applied(dir: string, overrides?: Record<string, unknown>): Config {
    const config = launchConfig(overrides);
    assert.doesNotThrow(() => {
      applyLaunchProfile(dir, config);
    }, `applying the profiles under ${dir} is total and never throws`);
    assertPreserved(config, LAUNCH_IDENTITY, 'applying a profile');
    return config;
  }

  /** Parsing MUST be total: no profiles, no exception, no mutation (rule 4). */
  function assertNoProfiles(dir: string, why: string): void {
    const config = launchConfig();
    assert.doesNotThrow(() => {
      applyLaunchProfile(dir, config);
    }, `${why}: applying profiles is total, never throws`);
    const profiles: unknown = readLaunchProfiles(dir);
    assert.deepStrictEqual(profiles, {}, `${why}: yields zero profiles`);
    const shape = Object.prototype.toString.call(profiles);
    assert.strictEqual(shape, '[object Object]', `${why}: a plain object, not ${shape}`);
    assert.strictEqual(config.args, undefined, `${why}: leaves args unset`);
    assert.strictEqual(config.env, undefined, `${why}: leaves env unset`);
    assertPreserved(config, LAUNCH_IDENTITY, why);
  }

  // Implements [DEBUG-FEATURES-LAUNCH-PROFILES] discovery + rule 2,
  // [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 1.
  test('profiles follow the resolved project across every F5 shape, an edit, and attach', async function () {
    this.timeout(DOTNET_CLI_MS);
    const { root, appDir, sourceFile } = canonicalLayout('discovery');
    const env = { MY_VAR: 'from-profile', DOTNET_ENVIRONMENT: 'Development' };
    const args = { commandLineArgs: '--mode fast' };
    const doc = oneProfileDoc('Dev', { ...args, environmentVariables: env });
    const file = writeLaunchSettings(appDir, doc);
    // Interaction 1 — the user opens the project's source file.
    const editor = await focusDocument(sourceFile);
    assert.strictEqual(editor.document.languageId, 'csharp', 'the entry point opens as C#');
    const active = comparablePath(editor.document.uri.fsPath);
    assert.strictEqual(active, comparablePath(sourceFile), 'the project source is active');
    const rootProps = fs.existsSync(path.join(root, 'Properties'));
    assert.strictEqual(rootProps, false, 'the premise: the ROOT owns no Properties/ directory');
    // Interaction 2 — discovery from the WORKSPACE ROOT, which owns no profile. B34
    const fromRoot = readLaunchProfiles(root);
    assert.deepStrictEqual(Object.keys(fromRoot), ['Dev'], 'root discovery reaches src/App');
    assert.strictEqual(fromRoot['Dev']?.commandName, 'Project', 'Dev is a Project profile');
    assert.strictEqual(fromRoot['Dev']?.commandLineArgs, '--mode fast', 'args read verbatim');
    assert.deepStrictEqual(fromRoot['Dev']?.environmentVariables, env, 'env read verbatim');
    assert.strictEqual(fromRoot['Dev']?.applicationUrl, undefined, 'an omitted field stays absent');
    assert.deepStrictEqual(readLaunchProfiles(appDir), fromRoot, 'root and project dir agree');
    const barren = readLaunchProfiles(caseDir('discovery-barren'));
    assert.deepStrictEqual(barren, {}, 'a sibling with no profile file yields no profiles');
    // Interaction 3 — the user presses F5 with no launch.json. B34, B51
    const resolved = await resolveVia(root, emptyF5Config());
    assertF5Shape(resolved, 'F5 on the real {} shape');
    assertArgv(resolved, ['--mode', 'fast'], "the subdirectory project's args");
    assertEnv(resolved, env, "the subdirectory project's env");
    assertTarget(resolved, appDir, 'App.dll');
    assert.deepStrictEqual(readJson(file), doc, 'resolving must never rewrite the profile file');
    // Interaction 4 — the same keypress, in the two other shapes it arrives as.
    const fromUndefined = await resolveVia(root, undefinedF5Config());
    assertF5Shape(fromUndefined, 'F5 on {type:undefined,...}');
    assertArgv(fromUndefined, ['--mode', 'fast'], 'the undefined-valued F5 shape');
    assertEnv(fromUndefined, env, 'the undefined-valued F5 shape');
    const fromEmptyType = await resolveVia(root, bareF5Config());
    assertF5Shape(fromEmptyType, 'F5 on the empty-string shape');
    assertEnv(fromEmptyType, env, 'the empty-string F5 shape');
    assert.deepStrictEqual(
      fromEmptyType.args,
      fromUndefined.args,
      'every F5 shape yields one argv',
    );
    assert.deepStrictEqual(fromEmptyType.env, resolved.env, 'every F5 shape yields the same env');
    // Interaction 5 — a user who chose a console in launch.json keeps it. B51
    const kept = await resolveVia(root, launchConfig({ console: 'internalConsole' }));
    assert.strictEqual(kept.console, 'internalConsole', 'a chosen console is never overwritten');
    assert.strictEqual(kept.name, BARE_NAME, 'a user-named configuration keeps its name');
    assertEnv(kept, env, 'a user-chosen console still receives the profile env');
    assertArgv(kept, ['--mode', 'fast'], 'a user-chosen console still receives profile args');
    // Interaction 6 — the user edits the profile file and presses F5 again.
    const edited = { ...env, MY_VAR: 'edited' };
    writeLaunchSettings(appDir, oneProfileDoc('Dev', { ...args, environmentVariables: edited }));
    const reresolved = await resolveVia(root, emptyF5Config());
    assertEnv(reresolved, edited, 'the profile file is re-read on every F5');
    assert.notStrictEqual(reresolved.env.MY_VAR, resolved.env.MY_VAR, 'the edit is not cached');
    assert.strictEqual(resolved.env.MY_VAR, 'from-profile', 'the earlier config is not re-mutated');
    assertArgv(reresolved, ['--mode', 'fast'], 'the unedited field is stable on a re-resolve');
    // Interaction 7 — an attach configuration must not inherit launch profiles. B40
    const attachIn = { type: DEBUG_TYPE_ID, request: 'attach', name: 'Attach', processId: 1234 };
    // Snapshot BEFORE resolving: the provider mutates the object it is handed,
    // so comparing the result against `attachIn` itself would be a tautology.
    const untouched = { ...attachIn };
    const attach = await resolveVia(root, attachIn);
    assertPreserved(attach, untouched, 'attach');
    assert.strictEqual(attach.args, undefined, 'profiles apply only to request "launch"');
    assert.strictEqual(attach.env, undefined, 'an attach config receives no profile env');
    // Nothing else may have happened: resolving is a pure transformation.
    assert.strictEqual(stubs.log.quickPickItems.length, 0, 'one profile needs no prompt');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'a valid profile warns about nothing');
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'a valid profile errors about nothing');
    assert.deepStrictEqual(stubs.log.infoMessages, [], 'resolving is silent on the happy path');
    await sessions.assertNoSession('resolving a configuration starts no debug session');
    await tasks.assertNoTask('resolving a configuration runs no task');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-PROFILES] rules 4 and 5.
  test('unsound profile documents yield nothing, throw nothing, and never abort the scan', () => {
    // Interaction 1 — the guard is asked about every shape a user can save. B36
    for (const bad of UNSOUND_PROFILES) {
      const label = JSON.stringify(bad) ?? 'undefined';
      const verdict = isLaunchSettings({ profiles: bad });
      assert.strictEqual(verdict, false, `a profiles value of ${label} is not a settings document`);
    }
    assert.strictEqual(isLaunchSettings({ unrelated: true }), false, 'no profiles key: not one');
    assert.strictEqual(isLaunchSettings(null), false, 'null is not a launch-settings document');
    assert.strictEqual(isLaunchSettings(undefined), false, 'undefined is not a document');
    assert.strictEqual(isLaunchSettings('{}'), false, 'an UNPARSED string is not a document');
    assert.strictEqual(isLaunchSettings([{ profiles: {} }]), false, 'an array is not a document');
    assert.strictEqual(isLaunchSettings({ profiles: {} }), true, 'an empty profiles map IS one');
    const populated = { profiles: { Dev: projectProfile({}) } };
    assert.strictEqual(isLaunchSettings(populated), true, 'a populated profiles map IS one');
    // Interaction 2 — the user saves `{"profiles": null}` and presses F5. B35
    const dir = caseDir('null-profiles');
    const settingsFile = writeRawLaunchSettings(dir, '{"profiles": null}');
    assertNoProfiles(dir, '{"profiles": null}');
    // Interaction 3 — the same file, edited into each remaining unsound shape.
    for (const body of UNSOUND_BODIES) {
      writeRawLaunchSettings(dir, body);
      assertNoProfiles(dir, `a launchSettings.json of '${body}'`);
    }
    // Interaction 4 — the user deletes the file entirely.
    fs.rmSync(settingsFile);
    assert.strictEqual(fs.existsSync(settingsFile), false, 'the premise: the file is really gone');
    assertNoProfiles(dir, 'a deleted launchSettings.json');
    // Interaction 5 — the candidate path exists but is a DIRECTORY.
    fs.mkdirSync(settingsFile, { recursive: true });
    assertNoProfiles(dir, 'a launchSettings.json that is a directory');
    fs.rmdirSync(settingsFile);
    // Interaction 6 — out-of-scope profile fields must not crash (mapping table).
    const browserDir = caseDir('browser-fields');
    const extras = { launchBrowser: true, launchUrl: 'swagger', dotnetRunMessages: true };
    const keep = { environmentVariables: { KEEP: 'yes' } };
    writeLaunchSettings(browserDir, oneProfileDoc('Dev', { ...extras, ...keep }));
    const browsed = applied(browserDir);
    assertEnv(browsed, { KEEP: 'yes' }, 'a profile carrying out-of-scope fields');
    assert.strictEqual(browsed.launchBrowser, undefined, 'launchBrowser must not leak onto config');
    assert.strictEqual(browsed.launchUrl, undefined, 'launchUrl must not leak onto the config');
    assert.strictEqual(browsed.args, undefined, 'a profile with no commandLineArgs sets no args');
    // Interaction 7 — a readable NON-settings candidate precedes a real one. B41
    const { root, appDir } = canonicalLayout('scan-continues');
    writeRawLaunchSettings(root, '{"unrelated": true}');
    const fields = { commandLineArgs: '--from-project', environmentVariables: { SCANNED: 'yes' } };
    writeLaunchSettings(appDir, oneProfileDoc('Dev', fields));
    const scanned = readLaunchProfiles(root);
    assert.deepStrictEqual(Object.keys(scanned), ['Dev'], 'a non-settings file cannot end a scan');
    assert.strictEqual(scanned['Dev']?.commandName, 'Project', 'the survivor is the Dev profile');
    assert.strictEqual(scanned['Dev']?.commandLineArgs, '--from-project', 'from candidate two');
    const scannedEnv = scanned['Dev']?.environmentVariables;
    assert.deepStrictEqual(scannedEnv, { SCANNED: 'yes' }, 'its env comes through verbatim');
    const continued = applied(root);
    assertArgv(continued, ['--from-project'], 'the continued scan feeds the configuration');
    assertEnv(continued, { SCANNED: 'yes' }, 'the continued scan feeds the configuration');
    // Nothing unsound is worth a modal: it is ignored, not reported as a failure.
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'unsound profiles raise no error modal');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'unsound profiles raise no warning');
    assert.deepStrictEqual(stubs.log.quickPickItems, [], 'unsound profiles prompt for nothing');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-PROFILES] mapping rules 1 and 3.
  test('profile mapping tokenizes quotes, maps applicationUrl, merges env, and asks which profile', async function () {
    this.timeout(DOTNET_CLI_MS);
    const { root, appDir, sourceFile } = canonicalLayout('mapping');
    const dev = { commandLineArgs: QUOTED_ARGS, applicationUrl: APP_URLS };
    writeLaunchSettings(
      appDir,
      oneProfileDoc('Dev', { ...dev, environmentVariables: { MY_VAR: 'profile' } }),
    );
    await focusDocument(sourceFile);
    // Interaction 1 — apply the single profile onto a bare config. B37, B38
    const config = applied(appDir);
    assertArgv(config, QUOTED_TOKENS, 'a real parser tokenizes where split(" ") shreds');
    assertEnv(config, { ASPNETCORE_URLS: APP_URLS, MY_VAR: 'profile' }, 'applicationUrl maps');
    assert.strictEqual(config.env.ASPNETCORE_URLS, APP_URLS, 'the multi-URL form is verbatim');
    assert.strictEqual(stubs.log.quickPickItems.length, 0, 'one profile is applied unprompted');
    // Interaction 2 — a user who already set args and env wins PER KEY.
    const explicit = applied(appDir, { args: ['--mine'], env: { MY_VAR: 'user' } });
    assertArgv(explicit, ['--mine'], 'an explicit args array is never replaced');
    const merged = { MY_VAR: 'user', ASPNETCORE_URLS: APP_URLS };
    assertEnv(explicit, merged, 'env merges per key: the user wins, profile-only keys are added');
    // Interaction 3 — an explicit ASPNETCORE_URLS beats the profile's applicationUrl.
    const pinned = applied(appDir, { env: { ASPNETCORE_URLS: 'http://localhost:1234' } });
    const pinnedEnv = { ASPNETCORE_URLS: 'http://localhost:1234', MY_VAR: 'profile' };
    assertEnv(pinned, pinnedEnv, 'an explicit URL wins over applicationUrl for that key');
    // Interaction 4 — whitespace-only commandLineArgs is ZERO tokens, not four empties.
    writeLaunchSettings(appDir, oneProfileDoc('Dev', { commandLineArgs: '   ' }));
    const blank = applied(appDir);
    assert.deepStrictEqual(blank.args ?? [], [], 'whitespace tokenizes to no arguments at all');
    assert.strictEqual(blank.env, undefined, 'a profile with no env and no URL sets no env');
    // Interaction 5 — non-Project profiles are ineligible.
    writeLaunchSettings(
      appDir,
      settingsWith({
        IIS: { commandName: 'IISExpress', environmentVariables: { IIS_ONLY: 'yes' } },
        Tool: { commandName: 'Executable', environmentVariables: { EXE_ONLY: 'yes' } },
        Dev: projectProfile({ environmentVariables: { DEV_ONLY: 'yes' } }),
      }),
    );
    const eligible = applied(appDir);
    assertEnv(eligible, { DEV_ONLY: 'yes' }, 'only the Project profile is eligible');
    assert.strictEqual(eligible.env.IIS_ONLY, undefined, 'an IISExpress profile is ignored');
    assert.strictEqual(eligible.env.EXE_ONLY, undefined, 'an Executable profile is ignored');
    assert.strictEqual(stubs.log.quickPickItems.length, 0, 'one ELIGIBLE profile needs no prompt');
    // Interaction 6 — two Project profiles: the user must be asked which one. B39
    writeLaunchSettings(
      appDir,
      settingsWith({
        Dev: projectProfile({
          commandLineArgs: '--dev',
          environmentVariables: { STAGE: 'dev', DEV_ONLY: 'yes' },
        }),
        Staging: projectProfile({
          commandLineArgs: QUOTED_ARGS,
          environmentVariables: { STAGE: 'staging' },
        }),
        IIS: { commandName: 'IISExpress', environmentVariables: { IIS_ONLY: 'yes' } },
      }),
    );
    stubs.queuePick('Staging');
    const chosen = await resolveVia(root, emptyF5Config());
    assertF5Shape(chosen, 'F5 with two Project profiles');
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'exactly one prompt, not zero or two');
    const labels = pickLabels(stubs.log.quickPickItems[0] ?? []);
    const offered = [...labels].sort();
    assert.deepStrictEqual(offered, ['Dev', 'Staging'], 'every eligible profile name is offered');
    assert.strictEqual(labels.includes('IIS'), false, 'an ineligible profile is never offered');
    assert.strictEqual(labels.length, 2, 'nothing is offered twice');
    assertEnv(chosen, { STAGE: 'staging' }, "the CHOSEN profile's env, not the first profile's");
    assert.strictEqual(chosen.env.DEV_ONLY, undefined, 'the first profile is not taken silently');
    assertArgv(chosen, QUOTED_TOKENS, "the chosen profile's args are tokenized too");
    const placeHolder = stubs.log.quickPickOptions[0]?.placeHolder ?? '';
    const asksForProfile = placeHolder.toLowerCase().includes('profile');
    assert.strictEqual(asksForProfile, true, `the prompt must name profiles; got '${placeHolder}'`);
    const many = stubs.log.quickPickOptions[0]?.canPickMany;
    assert.notStrictEqual(many, true, 'exactly one profile launches; the pick is single-select');
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'choosing a profile is not an error path');
    await sessions.assertNoSession('resolving a configuration starts no debug session');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-SCRIPT] rule 7, [DEBUG-FEATURES-LAUNCH-PROFILES].
  test('a file-based app reads <name>.run.json exactly as a project reads launchSettings', async function () {
    this.timeout(DOTNET_CLI_MS);
    const appRoot = caseDir('file-based');
    const entry = writeFileBasedApp(appRoot, 'app', 'hello from the file-based app');
    const fields = { commandLineArgs: QUOTED_ARGS, applicationUrl: APP_URLS };
    const runEnv = { RUN_JSON_VAR: 'yes' };
    const doc = oneProfileDoc('Dev', { ...fields, environmentVariables: runEnv });
    const runFile = writeRunJson(appRoot, 'app', doc);
    const mapped = { RUN_JSON_VAR: 'yes', ASPNETCORE_URLS: APP_URLS };
    // Interaction 1 — the user opens the single-file app.
    const editor = await focusDocument(entry);
    const opened = comparablePath(editor.document.uri.fsPath);
    assert.strictEqual(opened, comparablePath(entry), 'the app is the active document');
    assert.strictEqual(editor.document.languageId, 'csharp', 'a file-based app is a C# document');
    const hasProps = fs.existsSync(path.join(appRoot, 'Properties'));
    assert.strictEqual(hasProps, false, 'a file-based app has no Properties/ directory');
    const contents = fs.readdirSync(appRoot).sort();
    assert.deepStrictEqual(contents, ['app.cs', 'app.run.json'], 'the premise: no owning project');
    // Interaction 2 — profiles are discovered from the sibling run.json. B49
    const profiles = readLaunchProfiles(appRoot);
    assert.deepStrictEqual(Object.keys(profiles), ['Dev'], '<name>.run.json is read too');
    assert.strictEqual(profiles['Dev']?.commandName, 'Project', 'a run.json profile is a Project');
    assert.strictEqual(profiles['Dev']?.commandLineArgs, QUOTED_ARGS, 'raw args survive the read');
    assert.deepStrictEqual(profiles['Dev']?.environmentVariables, runEnv, 'its env is verbatim');
    assert.strictEqual(profiles['Dev']?.applicationUrl, APP_URLS, 'its applicationUrl is verbatim');
    // Interaction 3 — applying them mutates a config exactly as a project's do.
    const config = applied(appRoot);
    assertArgv(config, QUOTED_TOKENS, 'run.json args get the same real tokenizer');
    assertEnv(config, mapped, 'run.json env and applicationUrl map identically');
    const withUserEnv = applied(appRoot, { env: { RUN_JSON_VAR: 'user' } });
    const userWins = { RUN_JSON_VAR: 'user', ASPNETCORE_URLS: APP_URLS };
    assertEnv(withUserEnv, userWins, 'a run.json profile merges per key too');
    // Interaction 4 — pressing F5 on the file-based app. B51
    const resolved = await resolveVia(appRoot, emptyF5Config());
    assertF5Shape(resolved, 'F5 on a file-based app');
    assertArgv(resolved, QUOTED_TOKENS, 'the resolved args come from run.json');
    assertEnv(resolved, mapped, 'the resolved env comes from run.json');
    assert.deepStrictEqual(readJson(runFile), doc, 'resolving never rewrites the run.json');
    // Interaction 5 — a non-Project run.json profile is ineligible here too.
    const tool = { commandName: 'Executable', environmentVariables: { EXE_ONLY: 'yes' } };
    writeRunJson(appRoot, 'app', settingsWith({ Tool: tool }));
    const ineligible = applied(appRoot);
    assert.strictEqual(ineligible.env, undefined, 'an Executable run.json contributes no env');
    assert.strictEqual(ineligible.args, undefined, 'an Executable run.json contributes no args');
    const reread = Object.keys(readLaunchProfiles(appRoot));
    assert.deepStrictEqual(reread, ['Tool'], 'the profile is still READ, it is merely ineligible');
    // Interaction 6 — a sibling single-file app with NO run.json gets nothing.
    const bare = caseDir('file-based-bare');
    await focusDocument(writeFileBasedApp(bare, 'other'));
    assertNoProfiles(bare, 'a file-based app with no run.json');
    assert.strictEqual(stubs.log.quickPickItems.length, 0, 'one run.json profile needs no prompt');
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'a missing run.json is not an error');
    await sessions.assertNoSession('reading a run.json starts no debug session');
    await tasks.assertNoTask('reading a run.json runs no task');
  });
});
