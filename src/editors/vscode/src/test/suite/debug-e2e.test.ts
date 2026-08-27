import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as vscode from 'vscode';
import { SharpLspLaunchProvider } from '../../debug.js';
import {
  BUILD_TIMEOUT_MS,
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  contributes,
  debuggerContribution,
  emptyF5Config,
  fakeFolder,
  focusDocument,
  legacyF5Config,
  stopAnyDebugSession,
  undefinedF5Config,
} from './run-debug-kit';
import {
  TFM,
  buildProject,
  writeCSharpConsole,
  writeLaunchSettings,
  writeRawLaunchSettings,
} from './run-debug-fixtures';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { closeAllEditors, comparablePath, removeDirRecursive } from './test-helpers';

// Spec: [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-BUILD],
// [DEBUG-FEATURES-LAUNCH-NODEBUG], [DEBUG-FEATURES-LAUNCH-DYNAMIC]. The F5
// contract: what the provider must make of the object VS Code hands it on F5
// with no launch.json, and whether the manifest teaches the defaults the live
// provider produces. Only `SharpLspLaunchProvider` is imported: the internal
// resolvers implement the hardcoded `bin/Debug/<tfm>/` ladder that
// [DEBUG-FEATURES-LAUNCH-BUILD] calls non-conforming, so pinning their return
// values would pin the defect. Neighbouring ground: target resolution in
// run-debug-target, profile parsing in run-debug-profiles, manifest shape in
// run-debug-contributions, commands in run-debug-commands, netcoredbg in
// debug-adapter-e2e. registerDebugAdapter() is never called — the extension
// registered provider, factory and command at activation.

/** The real `node:fs` module object, not the getter-backed namespace copy. */
const realFs = createRequire(__filename)('node:fs') as typeof fs;

/** Frameworks no surface may still name once the resolver settled on `TFM`. */
const STALE_FRAMEWORKS: readonly string[] = ['net6.0', 'net7.0', 'net8.0', 'net9.0'];

const provider = new SharpLspLaunchProvider();

/** Per-test fixtures shared by both suites in this file. */
interface Harness {
  readonly tmpDir: string;
  readonly stubs: UiStubs;
  readonly recorder: DebugSessionRecorder;
}

/** Register mocha setup/teardown for a suite and hand back an accessor. */
function useHarness(prefix: string): () => Harness {
  let current: Harness | undefined;
  setup(() => {
    current = {
      tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
      stubs: installUiStubs(),
      recorder: new DebugSessionRecorder(),
    };
  });
  teardown(async () => {
    const active = current;
    current = undefined;
    if (active === undefined) return;
    active.recorder.dispose();
    active.stubs.restore();
    await stopAnyDebugSession();
    await closeAllEditors();
    removeDirRecursive(active.tmpDir);
  });
  return () => {
    if (current === undefined) assert.fail('the harness must be created in setup');
    return current;
  };
}

/** Resolve through the provider, failing loudly when it prevents the session. */
function resolveConfig(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
): vscode.DebugConfiguration {
  const result = provider.resolveDebugConfiguration(folder, config);
  assert.ok(result, 'a folder holding one runnable project must yield a config, not a refusal');
  return result as vscode.DebugConfiguration;
}

/** Assert the provider tolerates `config`; F5 must never surface a TypeError. */
function assertResolves(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
  why: string,
): void {
  assert.doesNotThrow(() => provider.resolveDebugConfiguration(folder, config), why);
}

/** Compare two filesystem paths with case/separator normalisation. */
function assertSamePath(actual: unknown, expected: string, message: string): void {
  assert.strictEqual(comparablePath(String(actual)), comparablePath(expected), message);
}

/** [B05] A resolved config with a falsy `type` is discarded SILENTLY by VS Code. */
function assertLaunchable(resolved: vscode.DebugConfiguration, label: string): void {
  assert.strictEqual(typeof resolved.type, 'string', `${label}: type must be a string`);
  assert.strictEqual(resolved.type, DEBUG_TYPE_ID, `${label}: type must name this debugger`);
  assert.notStrictEqual(resolved.type, '', `${label}: a falsy type is discarded silently`);
  assert.strictEqual(resolved.request, 'launch', `${label}: F5 synthesises a launch request`);
  assert.strictEqual(typeof resolved.name, 'string', `${label}: name must be a string`);
  assert.notStrictEqual(resolved.name, '', `${label}: an unnamed session cannot be shown`);
  assert.strictEqual(resolved.justMyCode, true, `${label}: justMyCode defaults on`);
  assert.strictEqual(typeof resolved.program, 'string', `${label}: a launch names a program`);
}

/**
 * [DEBUG-FEATURES-LAUNCH-NOCONFIG]'s "Synthesized configuration" block lists
 * `console: integratedTerminal`; [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 1 makes it
 * the default — a console app reading stdin is unusable without it.
 */
function assertSynthesised(resolved: vscode.DebugConfiguration, label: string): void {
  assertLaunchable(resolved, label);
  assert.strictEqual(resolved.name, 'Launch .NET Project', `${label}: the synthesised name`);
  assert.strictEqual(resolved.console, 'integratedTerminal', `${label}: stdin must work`);
}

/**
 * [B06] `dotnet: build` is contributed by the proprietary Microsoft C# extension:
 * on a SharpLsp-only install the pre-launch step fails and no session starts.
 */
function assertBuildTaskContributed(resolved: vscode.DebugConfiguration, label: string): void {
  assert.notStrictEqual(
    resolved.preLaunchTask,
    'dotnet: build',
    `${label}: 'dotnet: build' belongs to the C# extension, not to SharpLsp`,
  );
  if (resolved.preLaunchTask === undefined) return;
  const task = String(resolved.preLaunchTask);
  const declared: unknown = contributes().taskDefinitions;
  assert.ok(Array.isArray(declared), `${label}: a preLaunchTask needs contributes.taskDefinitions`);
  const types = declared.map((definition) => String(definition?.type));
  const named = task.split(':')[0]?.trim() ?? '';
  const seen = types.join(', ') || '<none>';
  assert.ok(types.includes(named), `${label}: '${task}' is an undeclared task type; have: ${seen}`);
}

/** A launch that saw no usable profile carries neither `env` nor `args`. */
function assertNoProfileValues(resolved: vscode.DebugConfiguration, label: string): void {
  assert.strictEqual(resolved.env, undefined, `${label}: an unusable profile supplies no env`);
  assert.strictEqual(resolved.args, undefined, `${label}: and no args`);
}

/** Which superseded target frameworks a manifest string still names. */
function staleFrameworks(text: string): string[] {
  return STALE_FRAMEWORKS.filter((framework) => text.includes(framework));
}

/**
 * How many times `dir` itself is listed while `run` executes. Resolving a launch
 * target lists the project directory, so this measures how often the target was
 * resolved — the only way to tell "once per invocation" from "once per profile"
 * when both produce byte-identical strings.
 */
function countScans<T>(dir: string, run: () => T): { result: T; scans: number } {
  const original = realFs.readdirSync;
  let scans = 0;
  realFs.readdirSync = ((target: fs.PathLike, options?: unknown): unknown => {
    if (comparablePath(String(target)) === comparablePath(dir)) scans += 1;
    return (original as (t: fs.PathLike, o?: unknown) => unknown)(target, options);
  }) as unknown as typeof fs.readdirSync;
  try {
    return { result: run(), scans };
  } finally {
    realFs.readdirSync = original;
  }
}

/** Generate configurations for `folder`, typed as the array they must be. */
function provideFor(folder: vscode.WorkspaceFolder): vscode.DebugConfiguration[] {
  return provider.provideDebugConfigurations(folder) as vscode.DebugConfiguration[];
}

suite('Debug E2E — F5 with no launch.json', () => {
  const harness = useHarness('sharplsp-debug-noconfig-e2e-');

  // Implements [DEBUG-FEATURES-LAUNCH-NOCONFIG] rules 1-5, [DEBUG-FEATURES-LAUNCH-BUILD] rules 1-3.
  test('every no-config shape resolves to the same launchable, idempotent config', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { tmpDir, stubs, recorder } = harness();
    const project = writeCSharpConsole(path.join(tmpDir, 'Console1'), 'Console1');
    const folder = fakeFolder(project.dir);

    // 1. The user builds the project, so MSBuild — not a guessed layout — says
    //    where the assembly is. [DEBUG-FEATURES-LAUNCH-BUILD] rule 3.
    await buildProject(project);
    const built = path.join(project.dir, 'bin', 'Debug', TFM, `${project.assemblyName}.dll`);
    assert.strictEqual(fs.existsSync(built), true, `dotnet build must produce ${built}`);

    // 2. The user opens Program.cs, then presses F5. The shape VS Code really
    //    builds has type/request/name ABSENT, not empty. B01
    const editor = await focusDocument(project.sourceFile);
    assert.strictEqual(editor.document.languageId, 'csharp', 'the fixture is a C# document');
    const absent = 'B01: a bare {} must not throw — `config.type.length` on an absent field ';
    assertResolves(folder, emptyF5Config(), absent + "raises TypeError: reading 'length'");
    const bare = resolveConfig(folder, emptyF5Config());
    assertSynthesised(bare, 'bare {}');
    assertBuildTaskContributed(bare, 'bare {}');
    assertSamePath(bare.program, built, 'B01: F5 targets the assembly MSBuild actually produced');
    assert.strictEqual(fs.existsSync(String(bare.program)), true, 'B01: which exists on disk');
    assertSamePath(bare.cwd, project.dir, 'B01: cwd is the project dir, not the workspace root');
    assertNoProfileValues(bare, 'B01: no launchSettings.json exists');
    assert.strictEqual(bare.noDebug, undefined, 'B01: plain F5 never invents noDebug');

    // 3. The same object after JSON transport: keys present, values undefined. B02
    const undef = 'B02: an explicitly-undefined type is absent, not dereferenceable';
    assertResolves(folder, undefinedF5Config(), undef);
    const transported = resolveConfig(folder, undefinedF5Config());
    assertSynthesised(transported, '{type:undefined}');
    assertBuildTaskContributed(transported, '{type:undefined}');
    assertSamePath(transported.program, built, 'B02: same target as the bare shape');
    assert.deepStrictEqual(transported, bare, 'B02: transport must not change what F5 gives');

    // 4. The legacy empty-string shape stays accepted — the absence guard must
    //    not NARROW the input set the provider already handles. B03
    const legacy = resolveConfig(folder, legacyF5Config());
    assertSynthesised(legacy, "{type:''}");
    assert.deepStrictEqual(legacy, bare, 'B03: the absence guard must not narrow the input set');

    // 5. VS Code changed `type`, so it re-enters the chain with what the
    //    provider just produced. That pass must be a fixed point. B04
    const second = resolveConfig(folder, structuredClone(bare));
    assert.deepStrictEqual(second, bare, 'B04: resolveDebugConfiguration must be idempotent');
    assert.deepStrictEqual(second.args, bare.args, 'B04: args must not be duplicated on re-entry');
    assert.deepStrictEqual(second.env, bare.env, 'B04: env must not be re-merged on re-entry');
    const third = resolveConfig(folder, structuredClone(second));
    assert.deepStrictEqual(third, second, 'B04: a third pass is still a fixed point');
    assert.strictEqual(third.name, bare.name, 'B04: the name is not re-suffixed each pass');

    // 6. Nothing user-visible, and nothing launched, from resolving alone.
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'a resolvable folder shows no error');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'and no warning');
    assert.deepStrictEqual(stubs.log.infoMessages, [], 'and no information toast');
    assert.deepStrictEqual(stubs.log.quickPickItems, [], 'one project needs no disambiguation');
    await recorder.assertNoSession('resolving a config must not start a session by itself');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-NOCONFIG] rule 2, [DEBUG-FEATURES-LAUNCH-PROFILES] rules 2, 4.
  test('an unsound launchSettings.json never blocks F5; a sound one supplies env and args', async function () {
    this.timeout(60_000);
    const { tmpDir, stubs, recorder } = harness();
    const project = writeCSharpConsole(path.join(tmpDir, 'Profiles'), 'Profiles');
    const folder = fakeFolder(project.dir);

    // 1. No profile file at all. B10
    const clean = resolveConfig(folder, emptyF5Config());
    assertSynthesised(clean, 'no launchSettings.json');
    assertNoProfileValues(clean, 'no launchSettings.json');

    // 2. The user saves a half-typed document. Parsing must be TOTAL. B10
    writeRawLaunchSettings(project.dir, '{ "profiles": ');
    assertResolves(folder, emptyF5Config(), 'B10: F5 survives a truncated profile file');
    const truncated = resolveConfig(folder, emptyF5Config());
    assertSynthesised(truncated, 'truncated launchSettings');
    assertNoProfileValues(truncated, 'B10: a document that did not parse');
    assertSamePath(truncated.program, String(clean.program), 'B10: same target as with no file');

    // 3. `{"profiles": null}` — a presence-only type guard admits it and then
    //    `Object.entries(null)` throws inside the provider. B10 / rule 4.
    for (const body of [
      '{ "profiles": null }',
      '{ "profiles": "text" }',
      '{ "profiles": [1,2] }',
    ]) {
      writeRawLaunchSettings(project.dir, body);
      assertResolves(folder, emptyF5Config(), `B10: '${body}' must yield no profiles, not a throw`);
      const unsound = resolveConfig(folder, emptyF5Config());
      assertSynthesised(unsound, body);
      assertNoProfileValues(unsound, `B10: ${body}`);
    }

    // 4. The user repairs the document. One `Project` profile is eligible; the
    //    IISExpress one is not. [DEBUG-FEATURES-LAUNCH-PROFILES] mapping table.
    writeLaunchSettings(project.dir, {
      profiles: {
        IIS: { commandName: 'IISExpress', environmentVariables: { WHICH: 'iis' } },
        Web: {
          commandName: 'Project',
          environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
          commandLineArgs: '--port 5000',
        },
      },
    });
    const launch = resolveConfig(folder, { type: DEBUG_TYPE_ID, name: 'L', request: 'launch' });
    const dev = { ASPNETCORE_ENVIRONMENT: 'Development' };
    assert.deepStrictEqual(launch.env, dev, 'the Project profile beats the IISExpress one');
    assert.deepStrictEqual(launch.args, ['--port', '5000'], 'commandLineArgs become argv');
    assert.strictEqual(launch.env?.WHICH, undefined, 'the IISExpress env must not leak in');
    assertSamePath(launch.program, String(clean.program), 'a profile does not move the target');

    // 5. Profiles apply only to launch requests. Rule 2.
    const attach = resolveConfig(folder, { type: DEBUG_TYPE_ID, name: 'A', request: 'attach' });
    assertNoProfileValues(attach, 'an attach configuration');
    assert.strictEqual(attach.request, 'attach', 'and stays an attach request');

    // 6. A launch.json that already states env/args wins per the mapping table.
    const preset = resolveConfig(folder, {
      type: DEBUG_TYPE_ID,
      name: 'L',
      request: 'launch',
      env: { WHICH: 'explicit' },
      args: ['kept'],
    });
    assert.deepStrictEqual(preset.env, { WHICH: 'explicit' }, 'an explicit env survives');
    assert.deepStrictEqual(preset.args, ['kept'], 'and explicit args survive');
    assert.notDeepStrictEqual(preset.env, dev, 'the profile must not clobber it');

    assert.deepStrictEqual(stubs.log.errorMessages, [], 'broken profiles are not an error toast');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'nor a warning during resolution');
    await recorder.assertNoSession('reading launch profiles must not start a session');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-NODEBUG] rules 1 and 3.
  test('Ctrl/Cmd+F5 keeps noDebug through resolution and resolves the same target as F5', async function () {
    this.timeout(60_000);
    const { tmpDir, stubs, recorder } = harness();
    const project = writeCSharpConsole(path.join(tmpDir, 'NoDebug'), 'NoDebug');
    const folder = fakeFolder(project.dir);
    const runShape = (): vscode.DebugConfiguration =>
      ({ noDebug: true }) as unknown as vscode.DebugConfiguration;

    // 1. Ctrl/Cmd+F5: VS Code stamps noDebug BEFORE the provider chain runs. B17
    assertResolves(folder, runShape(), 'B17: `{ noDebug: true }` is the Ctrl/Cmd+F5 shape');
    const run = resolveConfig(folder, runShape());
    assertSynthesised(run, 'Ctrl/Cmd+F5');
    assert.strictEqual(run.noDebug, true, 'B17: the flag must survive resolution');
    assertSamePath(run.cwd, project.dir, 'B17: run uses the project directory');

    // 2. Plain F5 on the same folder: one field apart, same target. Rule 1.
    const debugged = resolveConfig(folder, emptyF5Config());
    assert.strictEqual(debugged.noDebug, undefined, 'B17: the provider must never invent noDebug');
    assertSamePath(debugged.program, String(run.program), 'run and debug resolve one target');
    assertSamePath(debugged.cwd, String(run.cwd), 'and the identical working directory');
    assert.strictEqual(debugged.name, run.name, 'and carry the same session name');
    assert.deepStrictEqual(
      { ...run, noDebug: undefined },
      { ...debugged, noDebug: undefined },
      'B17: run and debug differ in noDebug and in nothing else',
    );

    // 3. Re-entry keeps the flag; `noDebug: false` is passed through, never read
    //    as "debug after all". Rule 3.
    const reRun = resolveConfig(folder, structuredClone(run));
    assert.strictEqual(reRun.noDebug, true, 'B17: a second resolve pass must not clear noDebug');
    assert.deepStrictEqual(reRun, run, 'B17: and must change nothing else');
    const cleared = resolveConfig(folder, { ...structuredClone(run), noDebug: false });
    assert.notStrictEqual(
      cleared.noDebug,
      undefined,
      'B17: the key is passed through, not dropped',
    );
    assert.strictEqual(cleared.noDebug, false, 'B17: verbatim — the provider must not reinterpret');
    assertSamePath(
      cleared.program,
      String(run.program),
      'B17: the same target resolves regardless',
    );

    // 4. The user adds a profile. It must reach run and debug identically.
    writeLaunchSettings(project.dir, {
      profiles: {
        App: { commandName: 'Project', environmentVariables: { M: 'run' }, commandLineArgs: '-f' },
      },
    });
    const runProfile = resolveConfig(folder, runShape());
    const debugProfile = resolveConfig(folder, emptyF5Config());
    assert.strictEqual(runProfile.noDebug, true, 'B17: still set once profiles are involved');
    assert.deepStrictEqual(runProfile.env, { M: 'run' }, 'the profile env reaches the run');
    assert.deepStrictEqual(runProfile.args, ['-f'], 'and so do the profile args');
    assert.deepStrictEqual(runProfile.env, debugProfile.env, 'run and debug share env');
    assert.deepStrictEqual(runProfile.args, debugProfile.args, 'and share args');
    assertSamePath(runProfile.program, String(debugProfile.program), 'and share the program');

    assert.deepStrictEqual(stubs.log.warningMessages, [], 'no warning is shown while resolving');
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'and no error');
    await recorder.assertNoSession('resolving a run configuration must not start a session');
  });
});

suite('Debug E2E — launch targets and dynamic configurations', () => {
  const harness = useHarness('sharplsp-debug-dynamic-e2e-');

  // Implements [DEBUG-FEATURES-LAUNCH-DYNAMIC] rules 3, 4 and 5.
  test('the manifest offers initial configurations and snippets the live provider agrees with', async function () {
    this.timeout(60_000);
    const { tmpDir, stubs, recorder } = harness();
    const project = writeCSharpConsole(path.join(tmpDir, 'Agree'), 'Agree');
    const folder = fakeFolder(project.dir);

    // 1. The live provider is the reference: whatever framework IT targets is
    //    the one every manifest surface has to teach. Rule 5.
    const generated = provideFor(folder);
    assert.strictEqual(generated.length, 1, 'a project with no profiles yields one configuration');
    const resolverProgram = String(generated[0]?.program);
    const wanted = `${path.sep}${TFM}${path.sep}`;
    assert.ok(
      comparablePath(resolverProgram).includes(comparablePath(wanted)),
      `the resolver must target the project's declared ${TFM}; got ${resolverProgram}`,
    );
    assert.deepStrictEqual(staleFrameworks(resolverProgram), [], 'and no superseded framework');

    // 2. The manifest names one debugger for both languages. Rule 4.
    const entry = debuggerContribution();
    assert.strictEqual(entry.type, DEBUG_TYPE_ID, 'one debugger type across manifest and code');
    assert.deepStrictEqual(entry.languages, ['csharp', 'fsharp'], 'the F5 auto-pick needs both');
    assert.strictEqual(generated[0]?.type, entry.type, 'the provider emits the contributed type');

    // 3. The user clicks "create a launch.json file". Rule 3.
    const initial: unknown = entry.initialConfigurations;
    assert.ok(Array.isArray(initial), 'B53: contributes.debuggers[].initialConfigurations exists');
    assert.notStrictEqual(initial.length, 0, 'B53: an empty list generates an empty launch.json');
    assert.deepStrictEqual(
      initial.map((config) => String(config?.type)),
      initial.map(() => DEBUG_TYPE_ID),
      'B53: every generated entry names this debugger',
    );
    for (const config of initial) {
      const request = String(config?.request);
      assert.ok(['launch', 'attach'].includes(request), `B53: launch or attach; got ${request}`);
      assert.strictEqual(typeof config?.name, 'string', 'B53: each entry is named');
      assert.notStrictEqual(String(config?.name), '', 'B53: with a non-empty name');
      if (typeof config?.program !== 'string') continue;
      assert.deepStrictEqual(staleFrameworks(config.program), [], `B53/B54: ${config.program}`);
      assert.ok(config.program.includes(TFM), `B53/B54: must teach ${TFM}: ${config.program}`);
    }

    // 4. The user types a quote in launch.json and picks the launch snippet. B54
    const snippets: unknown = entry.configurationSnippets;
    assert.ok(Array.isArray(snippets), 'configurationSnippets must be an array');
    const snippet = snippets.find((item) => item?.body?.request === 'launch');
    assert.ok(snippet, 'a launch snippet must exist');
    assert.strictEqual(String(snippet.body.type), DEBUG_TYPE_ID, 'and name this debugger');
    const snippetProgram = String(snippet.body.program);
    assert.deepStrictEqual(
      staleFrameworks(snippetProgram),
      [],
      `B54: the snippet teaches a framework the resolver does not prefer: ${snippetProgram}`,
    );
    assert.ok(
      snippetProgram.includes(TFM),
      `B54: the snippet must teach ${TFM}: ${snippetProgram}`,
    );
    assert.strictEqual(snippet.body.cwd, '${workspaceFolder}', 'B54: the snippet runs from there');
    const attach = snippets.find((item) => item?.body?.request === 'attach');
    assert.ok(attach, 'the attach snippet must survive the change');
    assert.strictEqual(String(attach.body.type), DEBUG_TYPE_ID, 'and keep the one debugger type');

    assert.deepStrictEqual(stubs.log.errorMessages, [], 'reading the manifest shows nothing');
    await recorder.assertNoSession('reading the manifest must not start a session');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-DYNAMIC] rule 6.
  test('provideDebugConfigurations emits one config per profile and resolves the target once', async function () {
    this.timeout(60_000);
    const { tmpDir, stubs, recorder } = harness();

    // 1. A window with no folder open generates nothing at all.
    const none = provider.provideDebugConfigurations(undefined);
    assert.deepStrictEqual(none, [], 'a folderless window generates no configurations');

    // 2. One project, no profiles: exactly one default configuration.
    const solo = writeCSharpConsole(path.join(tmpDir, 'Solo'), 'Solo');
    const folder = fakeFolder(solo.dir);
    const defaults = provideFor(folder);
    assert.strictEqual(defaults.length, 1, 'exactly one default configuration');
    assert.strictEqual(defaults[0]?.name, 'Launch .NET Project', 'named for the generated file');
    assert.strictEqual(defaults[0]?.type, DEBUG_TYPE_ID, 'typed as this debugger');
    assert.strictEqual(defaults[0]?.request, 'launch', 'and as a launch request');
    assert.strictEqual(defaults[0]?.justMyCode, true, 'with justMyCode on');
    assertSamePath(defaults[0]?.cwd, solo.dir, 'and rooted at the project directory');
    const soloProgram = String(defaults[0]?.program);
    assert.strictEqual(path.basename(soloProgram), 'Solo.dll', 'wired to the project assembly');
    assertNoProfileValues(defaults[0] as vscode.DebugConfiguration, 'no profiles exist');

    // 3. The user adds ONE Project profile — measure the filesystem work it costs.
    writeLaunchSettings(solo.dir, { profiles: { one: { commandName: 'Project' } } });
    const single = countScans(solo.dir, () => provideFor(folder));
    assert.deepStrictEqual(
      single.result.map((config) => config.name),
      ['Launch: one'],
      'one profile yields one configuration, named after it',
    );
    assertSamePath(single.result[0]?.program, soloProgram, 'the target did not move');
    assert.notStrictEqual(single.scans, 0, 'the scan counter must observe the resolver');

    // 4. The user adds two more, plus an IISExpress one that is not eligible.
    writeLaunchSettings(solo.dir, {
      profiles: {
        alpha: { commandName: 'Project' },
        beta: { commandName: 'Project', commandLineArgs: 'x y' },
        gamma: { commandName: 'Project', environmentVariables: { G: '1' } },
        IIS: { commandName: 'IISExpress' },
      },
    });
    const many = countScans(solo.dir, () => provideFor(folder));
    const configs = many.result;
    assert.strictEqual(configs.length, 3, 'IISExpress is not an eligible launch profile');
    assert.deepStrictEqual(
      configs.map((config) => config.name).sort(),
      ['Launch: alpha', 'Launch: beta', 'Launch: gamma'],
      'one config per Project profile, named after it — the list is reactive to the edit',
    );
    const beta = configs.find((config) => config.name === 'Launch: beta');
    const gamma = configs.find((config) => config.name === 'Launch: gamma');
    assert.deepStrictEqual(beta?.args, ['x', 'y'], 'commandLineArgs reach that config only');
    assert.deepStrictEqual(gamma?.env, { G: '1' }, 'and environmentVariables likewise');
    assert.strictEqual(beta?.env, undefined, 'a profile without env contributes none');
    assert.strictEqual(gamma?.args, undefined, 'and one without args contributes none');
    assert.deepStrictEqual(
      configs.map((config) => comparablePath(String(config.program))),
      configs.map(() => comparablePath(soloProgram)),
      'B55: every generated config shares the one resolved target',
    );
    assert.strictEqual(
      many.scans,
      single.scans,
      'B55: the launch target must be resolved once per invocation, not once per profile ' +
        `(${single.scans} directory scans for 1 profile vs ${many.scans} for 3)`,
    );

    // 5. Generating configurations is silent and launches nothing.
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'generating configurations warns nobody');
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'and reports no error');
    assert.deepStrictEqual(stubs.log.quickPickItems, [], 'and asks the user nothing');
    await recorder.assertNoSession('generating configurations must not start a session');
  });
});
