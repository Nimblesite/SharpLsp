import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BUILD_TIMEOUT_MS,
  DEBUG_TYPE_ID,
  debuggerContribution,
  emptyF5Config,
  fakeFolder,
  focusDocument,
  legacyF5Config,
  undefinedF5Config,
} from './run-debug-kit';
import {
  TFM,
  buildProject,
  writeCSharpConsole,
  writeLaunchSettings,
  writeRawLaunchSettings,
} from './run-debug-fixtures';
import { comparablePath } from './test-helpers';
import {
  assertBuildTaskContributed,
  assertNoProfileValues,
  assertResolves,
  assertSamePath,
  assertSynthesised,
  countScans,
  provideFor,
  provider,
  resolveConfig,
  staleFrameworks,
  useHarness,
} from './debug-e2e-kit';

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
    await assertResolves(folder, emptyF5Config(), absent + "raises TypeError: reading 'length'");
    const bare = await resolveConfig(folder, emptyF5Config());
    assertSynthesised(bare, 'bare {}');
    assertBuildTaskContributed(bare, 'bare {}');
    assertSamePath(bare.program, built, 'B01: F5 targets the assembly MSBuild actually produced');
    assert.strictEqual(fs.existsSync(String(bare.program)), true, 'B01: which exists on disk');
    assertSamePath(bare.cwd, project.dir, 'B01: cwd is the project dir, not the workspace root');
    assertNoProfileValues(bare, 'B01: no launchSettings.json exists');
    assert.strictEqual(bare.noDebug, undefined, 'B01: plain F5 never invents noDebug');

    // 3. The same object after JSON transport: keys present, values undefined. B02
    const undef = 'B02: an explicitly-undefined type is absent, not dereferenceable';
    await assertResolves(folder, undefinedF5Config(), undef);
    const transported = await resolveConfig(folder, undefinedF5Config());
    assertSynthesised(transported, '{type:undefined}');
    assertBuildTaskContributed(transported, '{type:undefined}');
    assertSamePath(transported.program, built, 'B02: same target as the bare shape');
    assert.deepStrictEqual(transported, bare, 'B02: transport must not change what F5 gives');

    // 4. The legacy empty-string shape stays accepted — the absence guard must
    //    not NARROW the input set the provider already handles. B03
    const legacy = await resolveConfig(folder, legacyF5Config());
    assertSynthesised(legacy, "{type:''}");
    assert.deepStrictEqual(legacy, bare, 'B03: the absence guard must not narrow the input set');

    // 5. VS Code changed `type`, so it re-enters the chain with what the
    //    provider just produced. That pass must be a fixed point. B04
    const second = await resolveConfig(folder, structuredClone(bare));
    assert.deepStrictEqual(second, bare, 'B04: resolveDebugConfiguration must be idempotent');
    assert.deepStrictEqual(second.args, bare.args, 'B04: args must not be duplicated on re-entry');
    assert.deepStrictEqual(second.env, bare.env, 'B04: env must not be re-merged on re-entry');
    const third = await resolveConfig(folder, structuredClone(second));
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
    const clean = await resolveConfig(folder, emptyF5Config());
    assertSynthesised(clean, 'no launchSettings.json');
    assertNoProfileValues(clean, 'no launchSettings.json');

    // 2. The user saves a half-typed document. Parsing must be TOTAL. B10
    writeRawLaunchSettings(project.dir, '{ "profiles": ');
    await assertResolves(folder, emptyF5Config(), 'B10: F5 survives a truncated profile file');
    const truncated = await resolveConfig(folder, emptyF5Config());
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
      await assertResolves(
        folder,
        emptyF5Config(),
        `B10: '${body}' must yield no profiles, not a throw`,
      );
      const unsound = await resolveConfig(folder, emptyF5Config());
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
    const launch = await resolveConfig(folder, {
      type: DEBUG_TYPE_ID,
      name: 'L',
      request: 'launch',
    });
    // Captured before the deepStrictEqual below: that assertion is a TypeScript
    // assertion function, so it NARROWS `launch.env` to the compared shape and a
    // later lookup of a key outside that shape stops compiling.
    const launchEnv: Record<string, string> = launch.env;
    assert.deepStrictEqual(
      launchEnv,
      { ASPNETCORE_ENVIRONMENT: 'Development' },
      'the Project profile beats the IISExpress one',
    );
    assert.deepStrictEqual(launch.args, ['--port', '5000'], 'commandLineArgs become argv');
    assert.deepStrictEqual(
      Object.keys(launchEnv).sort(),
      ['ASPNETCORE_ENVIRONMENT'],
      'the IISExpress env must not leak in',
    );
    assertSamePath(launch.program, String(clean.program), 'a profile does not move the target');

    // 5. Profiles apply only to launch requests. Rule 2.
    const attach = await resolveConfig(folder, {
      type: DEBUG_TYPE_ID,
      name: 'A',
      request: 'attach',
    });
    assertNoProfileValues(attach, 'an attach configuration');
    assert.strictEqual(attach.request, 'attach', 'and stays an attach request');

    // 6. A launch.json that already states env/args wins per the mapping table.
    const preset = await resolveConfig(folder, {
      type: DEBUG_TYPE_ID,
      name: 'L',
      request: 'launch',
      env: { WHICH: 'explicit' },
      args: ['kept'],
    });
    assert.deepStrictEqual(preset.env, { WHICH: 'explicit' }, 'an explicit env survives');
    assert.deepStrictEqual(preset.args, ['kept'], 'and explicit args survive');
    assert.notDeepStrictEqual(
      preset.env,
      { ASPNETCORE_ENVIRONMENT: 'Development' },
      'the profile must not clobber it',
    );

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
    await assertResolves(folder, runShape(), 'B17: `{ noDebug: true }` is the Ctrl/Cmd+F5 shape');
    const run = await resolveConfig(folder, runShape());
    assertSynthesised(run, 'Ctrl/Cmd+F5');
    assert.strictEqual(run.noDebug, true, 'B17: the flag must survive resolution');
    assertSamePath(run.cwd, project.dir, 'B17: run uses the project directory');

    // 2. Plain F5 on the same folder: one field apart, same target. Rule 1.
    const debugged = await resolveConfig(folder, emptyF5Config());
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
    const reRun = await resolveConfig(folder, structuredClone(run));
    assert.strictEqual(reRun.noDebug, true, 'B17: a second resolve pass must not clear noDebug');
    assert.deepStrictEqual(reRun, run, 'B17: and must change nothing else');
    const cleared = await resolveConfig(folder, { ...structuredClone(run), noDebug: false });
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
    const runProfile = await resolveConfig(folder, runShape());
    const debugProfile = await resolveConfig(folder, emptyF5Config());
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
    const generated = await provideFor(folder);
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
    const none = await provider.provideDebugConfigurations(undefined);
    assert.deepStrictEqual(none, [], 'a folderless window generates no configurations');

    // 2. One project, no profiles: exactly one default configuration.
    const solo = writeCSharpConsole(path.join(tmpDir, 'Solo'), 'Solo');
    const folder = fakeFolder(solo.dir);
    const defaults = await provideFor(folder);
    assert.strictEqual(defaults.length, 1, 'exactly one default configuration');
    assert.strictEqual(defaults[0]?.name, 'Launch .NET Project', 'named for the generated file');
    assert.strictEqual(defaults[0]?.type, DEBUG_TYPE_ID, 'typed as this debugger');
    assert.strictEqual(defaults[0]?.request, 'launch', 'and as a launch request');
    assert.strictEqual(defaults[0]?.justMyCode, true, 'with justMyCode on');
    assertSamePath(defaults[0]?.cwd, solo.dir, 'and rooted at the project directory');
    const soloProgram = String(defaults[0]?.program);
    assert.strictEqual(path.basename(soloProgram), 'Solo.dll', 'wired to the project assembly');
    assertNoProfileValues(defaults[0], 'no profiles exist');

    // 3. The user adds ONE Project profile — measure the filesystem work it costs.
    writeLaunchSettings(solo.dir, { profiles: { one: { commandName: 'Project' } } });
    const single = await countScans(solo.dir, async () => provideFor(folder));
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
    const many = await countScans(solo.dir, async () => provideFor(folder));
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
