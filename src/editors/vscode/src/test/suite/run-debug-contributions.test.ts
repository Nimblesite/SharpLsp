// Manifest conformance for RUN and DEBUG.
//
// Spec: [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS], [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION],
// [DEBUG-FEATURES-LAUNCH-OUTPUT], [DEBUG-FEATURES-LAUNCH-DYNAMIC], [DEBUG-FEATURES-LAUNCH-BUILD].
//
// A contribution point is not a packaging detail: with no `contributes.breakpoints` a user
// cannot set a breakpoint in a .cs file AT ALL, and with no `contributes.taskDefinitions` the
// type build.ts registers is unreferenceable from tasks.json. Neither defect is visible to a
// runtime API — `vscode.debug.addBreakpoints` bypasses the breakpoint gate outright
// ([DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION] rule 4) — so the manifest VS Code itself parsed,
// the constants module and the live command registry are the only honest assertion surfaces.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SharpLspBuildTaskProvider } from '../../build.js';
import * as constants from '../../constants.js';
import { TFM } from './run-debug-fixtures';
import {
  CMD_DEBUG_PROGRAM,
  CMD_RUN_PROGRAM,
  DEBUG_TYPE_ID,
  assertCommandRegistered,
  contributes,
  debuggerContribution,
  menuItems,
  packageJson,
} from './run-debug-kit';
import { EXTENSION_ID } from './test-helpers';

const { DEBUG_TYPE } = constants;
/** Every command this extension owns carries this prefix. */
const PREFIX = 'sharplsp.';
/** The languages both the breakpoint and the debugger contribution must serve. */
const LANGS = ['csharp', 'fsharp'];
/** The two run/debug command ids, in the order the menus must present them. */
const RUN_DEBUG = [CMD_RUN_PROGRAM, CMD_DEBUG_PROGRAM];
/** The task type `build.ts` registers with `vscode.tasks.registerTaskProvider`. */
const BUILD_TYPE = SharpLspBuildTaskProvider.Type;
/** The verbs `SharpLspBuildTaskProvider.provideTasks` emits, in order. */
const VERBS = ['build', 'rebuild', 'clean'];
/** The menus [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS] places both commands in. */
const MENUS = ['editor/title/run', 'editor/context', 'view/item/context'];
/** Menus that already carry SharpLsp items and must survive the run/debug work. */
const EXISTING_MENUS = ['editor/context', 'view/title', 'debug/toolbar', 'view/item/context'];
/** Attributes core injects and overwrites; a hand-rolled copy misdescribes them. */
const CORE_INJECTED = (
  'name type request preLaunchTask postDebugTask presentation ' +
  'internalConsoleOptions debugServer suppressMultipleSessionWarning serverReadyAction'
).split(' ');
/** The launch schema of [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 3, sorted. */
const LAUNCH_SCHEMA = (
  'args console cwd env hotReload justMyCode program ' +
  'requireExactSource stopAtEntry symbolOptions'
).split(' ');
const ACCIDENT =
  'both must be listed: C# breakpoints are impossible today, and F# works only by accident ' +
  'because the built-in ms-vscode.js-debug happens to contribute fsharp (rule 3)';
const UNCONDITIONAL =
  'an entry declares only `language`: a `when` tied to server state makes the gutter appear ' +
  'and disappear as the language server cycles (rule 2)';
const DECLARED_SCHEMA =
  'the declared schema must match [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 3 exactly — debug.ts ' +
  'writes justMyCode on every resolve, so leaving it undeclared makes launch.json IntelliSense ' +
  'flag a valid, extension-authored attribute as an error';
const CORE_OWNED =
  'attributes VS Code core injects must NOT be re-declared: core overwrites them and a ' +
  'hand-rolled copy misdescribes them in launch.json';

/** Assert `value` is a non-empty string — two independently failing checks. */
function assertNonEmptyString(value: unknown, label: string): void {
  assert.strictEqual(typeof value, 'string', `${label} must be declared as a string`);
  assert.notStrictEqual(String(value).trim(), '', `${label} must not be empty`);
}

/** Assert one JSON-schema property: it exists, has `type`, and documents itself. */
function assertSchemaProperty(props: Record<string, any>, key: string, type: string): void {
  const property: unknown = props[key];
  assert.strictEqual(typeof property, 'object', `'${key}' must be declared as a schema object`);
  assert.strictEqual(props[key].type, type, `'${key}' must be declared with type '${type}'`);
  assertNonEmptyString(props[key].description, `the '${key}' description`);
}

/** `contributes.commands`, checked to be a list before anything reads it. */
function commandEntries(): Record<string, any>[] {
  const commands: unknown = contributes().commands;
  assert.ok(Array.isArray(commands), 'contributes.commands must be an array');
  return commands;
}

/** Contributed ids this extension owns, sorted — the diagnosable failure set. */
function sharpLspIds(): string[] {
  return commandEntries()
    .map((entry) => String(entry.command))
    .filter((id) => id.startsWith(PREFIX))
    .sort();
}

/** The single manifest entry for `id`; fails naming what IS contributed. */
function commandEntry(id: string): Record<string, any> {
  const matches = commandEntries().filter((entry) => entry.command === id);
  const seen = sharpLspIds().join(', ');
  assert.strictEqual(matches.length, 1, `'${id}' contributed exactly once; have: ${seen}`);
  return matches[0]!;
}

/** Every `CMD_*` value the constants module exports — each one names a command. */
function commandConstants(): string[] {
  return Object.entries(constants)
    .filter(([name]) => name.startsWith('CMD_'))
    .map(([, value]) => String(value))
    .sort();
}

/** The `[command, group]` pairs `menu` declares for run and debug, in order. */
function runDebugPlacement(menu: string): string[][] {
  return menuItems(menu)
    .filter((item) => RUN_DEBUG.includes(String(item.command)))
    .map((item) => [String(item.command), String(item.group)]);
}

/** The `[command, group]` pairs a menu must declare — run first, debug second. */
function expectedPairs(group: string): string[][] {
  return RUN_DEBUG.map((id, index) => [id, `${group}@${index + 1}`]);
}

/** The `configurationAttributes` block of the debugger contribution. */
function configurationAttributes(): Record<string, any> {
  const attributes = debuggerContribution().configurationAttributes;
  assert.ok(attributes?.launch, 'the debugger must declare configurationAttributes.launch');
  return attributes;
}

/** The `configurationSnippets` array of the debugger contribution. */
function snippets(): Record<string, any>[] {
  const list: unknown = debuggerContribution().configurationSnippets;
  assert.ok(Array.isArray(list), 'contributes.debuggers[].configurationSnippets must exist');
  return list;
}

/** The `body` of every `configurationSnippets` entry. */
function snippetBodies(): Record<string, any>[] {
  return snippets().map((snippet) => snippet.body ?? {});
}

/** `initialConfigurations` — [DEBUG-FEATURES-LAUNCH-DYNAMIC] rule 3. */
function initialConfigurations(): Record<string, any>[] {
  const entry = debuggerContribution();
  const configurations: unknown = entry.initialConfigurations;
  const keys = Object.keys(entry).join(', ');
  const reason = `initialConfigurations must supply a launch.json body; keys: ${keys}`;
  assert.ok(Array.isArray(configurations), reason);
  return configurations;
}

/** `contributes.taskDefinitions` — [DEBUG-FEATURES-LAUNCH-BUILD] rule 2. */
function taskDefinitions(): Record<string, any>[] {
  const block = contributes();
  const definitions: unknown = block.taskDefinitions;
  const keys = Object.keys(block).join(', ');
  const reason = `contributes.taskDefinitions must declare build.ts's type; keys: ${keys}`;
  assert.ok(Array.isArray(definitions), reason);
  return definitions;
}

/** The `netX.Y` PATH SEGMENTS of a program path — never a substring match. */
function frameworkSegments(program: string): string[] {
  return program
    .split('/')
    .flatMap((segment) => segment.split('\\'))
    .filter((segment) => segment.startsWith('net'));
}

suite('Run/Debug manifest contributions', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} must be installed in the test host`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true, 'must be active before reading the registry');
  });

  // Implements [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION], [DEBUG-FEATURES-LAUNCH-OUTPUT] r4.
  test('breakpoint languages, debugger languages and the debug type agree but stay distinct', () => {
    // 1. The user installs the extension; VS Code parses the manifest.
    const manifest = packageJson();
    const identity = `${String(manifest.publisher)}.${String(manifest.name)}`;
    assert.strictEqual(identity, EXTENSION_ID, 'the parsed manifest must be SharpLsp itself');
    assertNonEmptyString(manifest.version, 'the manifest version');
    const block = contributes();
    const blockKeys = Object.keys(block).join(', ');
    const owned: unknown = block.languages;
    assert.ok(Array.isArray(owned), 'contributes.languages must be an array');
    const ownedIds = owned.map((entry) => String(entry.id)).sort();
    assert.deepStrictEqual(ownedIds, LANGS, 'SharpLsp itself owns the csharp and fsharp ids');

    // 2. The user clicks the breakpoint gutter in a .cs file; VS Code consults
    //    contributes.breakpoints through canSetBreakpointsIn. B56
    const declared = Object.prototype.hasOwnProperty.call(block, 'breakpoints');
    const noGutter = `breakpoints become impossible in every language; keys: ${blockKeys}`;
    assert.strictEqual(declared, true, `contributes.breakpoints must exist — ${noGutter}`);
    const breakpoints: unknown = block.breakpoints;
    assert.ok(Array.isArray(breakpoints), 'contributes.breakpoints must be an array');
    assert.strictEqual(breakpoints.length, 2, 'exactly csharp and fsharp, no duplicate entries');
    const bpLangs = breakpoints.map((entry) => String(entry.language)).sort();
    assert.deepStrictEqual(bpLangs, LANGS, ACCIDENT);
    assert.strictEqual(new Set(bpLangs).size, 2, 'no language may be listed twice');
    assert.deepStrictEqual(bpLangs, ownedIds, 'every language SharpLsp owns takes breakpoints');
    const shapes = breakpoints.map((entry) => Object.keys(entry).sort());
    assert.deepStrictEqual(shapes, [['language'], ['language']], UNCONDITIONAL);
    const gates = breakpoints.map((entry) => entry.when);
    assert.deepStrictEqual(gates, [undefined, undefined], 'breakpoints stay unconditional');
    const kinds = breakpoints.map((entry) => typeof entry.language);
    assert.deepStrictEqual(kinds, ['string', 'string'], 'a breakpoint entry keys ONE language id');

    // 3. The user presses F5; VS Code picks a debugger by language. A DIFFERENT
    //    contribution point, which grants no breakpoint permission. B56
    const contribution = debuggerContribution();
    const languages: unknown = contribution.languages;
    assert.ok(Array.isArray(languages), 'debuggers[].languages must be an array');
    assert.deepStrictEqual(languages, LANGS, 'debuggers[].languages drives the F5 auto-pick');
    const entryKinds = breakpoints.map((entry) => typeof entry);
    assert.deepStrictEqual(entryKinds, ['object', 'object'], 'breakpoint entries are objects...');
    const langKinds = languages.map((language: unknown) => typeof language);
    assert.deepStrictEqual(langKinds, ['string', 'string'], '...debugger languages are strings');
    assert.notDeepStrictEqual(breakpoints, languages, 'the two must not be aliases');
    assert.deepStrictEqual([...languages].sort(), bpLangs, 'the two lists cover the same set');

    // 4. The user opens launch.json and picks a snippet: every surface naming the
    //    debug type must name the same one. B57
    assert.strictEqual(contribution.type, DEBUG_TYPE, 'manifest type === constants.DEBUG_TYPE');
    assert.strictEqual(DEBUG_TYPE, DEBUG_TYPE_ID, 'constants and the kit name one debug type');
    const debuggers: unknown = block.debuggers;
    assert.ok(Array.isArray(debuggers), 'contributes.debuggers must be an array');
    assert.strictEqual(debuggers.length, 1, 'a second debugger would split the F5 auto-pick');
    assert.strictEqual(debuggers[0], contribution, 'the only entry IS the sharplsp-coreclr one');
    const bodies = snippetBodies();
    assert.strictEqual(bodies.length, 2, 'a launch and an attach snippet are both offered');
    const types = bodies.map((body) => String(body.type));
    assert.deepStrictEqual(types, [DEBUG_TYPE, DEBUG_TYPE], `snippet bodies declare ${DEBUG_TYPE}`);
    assertNonEmptyString(contribution.label, 'the Select Debugger label');
    for (const snippet of snippets()) assertNonEmptyString(snippet.label, 'a snippet label');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS].
  test('run and debug are contributed and placed in the title, context and explorer menus', () => {
    // 1. The user opens the Command Palette and types "run". B12
    const ids = sharpLspIds();
    const have = ids.join(', ');
    assert.ok(ids.includes(CMD_DEBUG_PROGRAM), `'${CMD_DEBUG_PROGRAM}' contributed; ${have}`);
    const noRun = `no run command exists anywhere today; contributed: ${have}`;
    assert.ok(ids.includes(CMD_RUN_PROGRAM), `'${CMD_RUN_PROGRAM}' contributed — ${noRun}`);
    assert.strictEqual(new Set(ids).size, ids.length, 'no id may be contributed twice');
    for (const id of RUN_DEBUG) {
      const entry = commandEntry(id);
      assert.strictEqual(entry.command, id, `the entry for '${id}' carries its own id`);
      assertNonEmptyString(entry.title, `the palette title of '${id}'`);
      assertNonEmptyString(entry.category, `the palette category of '${id}'`);
      assertNonEmptyString(entry.icon, `the icon of '${id}' (an editor/title/run item is a button)`);
    }
    const runTitle = String(commandEntry(CMD_RUN_PROGRAM).title);
    const debugTitle = String(commandEntry(CMD_DEBUG_PROGRAM).title);
    assert.notStrictEqual(runTitle, debugTitle, 'run and debug need distinguishable titles');
    const categories = RUN_DEBUG.map((id) => String(commandEntry(id).category));
    assert.strictEqual(new Set(categories).size, 1, 'both sit under one palette category');

    // 2. The user focuses a .cs file and looks at the editor title bar. VS Code core
    //    contributes nothing to editor/title/run — it is empty unless we fill it. B13
    const menuKeys = Object.keys(contributes().menus ?? {});
    const menus = menuKeys.join(', ');
    const kept = EXISTING_MENUS.filter((menu) => !menuKeys.includes(menu));
    assert.deepStrictEqual(kept, [], `no existing menu may be dropped; menus: ${menus}`);
    assert.ok(menuKeys.includes('editor/title/run'), `editor/title/run declared; menus: ${menus}`);
    const titleRun = menuItems('editor/title/run');
    const split = `the Run-or-Debug split button needs both commands; menus: ${menus}`;
    assert.strictEqual(titleRun.length, 2, `editor/title/run must be filled — ${split}`);
    assert.deepStrictEqual(
      runDebugPlacement('editor/title/run'),
      expectedPairs('navigation'),
      'run sorts above debug: the highest-sorted item becomes the split button default',
    );
    for (const item of titleRun) {
      const when = String(item.when);
      assert.strictEqual(typeof item.when, 'string', 'every title-bar item must be gated');
      assert.ok(when.includes('LangId'), `gate on document language, not every file: ${when}`);
    }

    // 3. The user right-clicks inside that same editor. B13
    const contextPairs = runDebugPlacement('editor/context');
    assert.strictEqual(contextPairs.length, 2, 'one editor/context entry per command');
    assert.deepStrictEqual(
      contextPairs,
      expectedPairs('navigation'),
      'the editor context menu offers run before debug, mirroring the title bar; the shipped ' +
        'debugProgram entry sits at navigation@1 today and must move down to make room',
    );
    const gates = menuItems('editor/context')
      .filter((item) => RUN_DEBUG.includes(String(item.command)))
      .map((item) => String(item.when));
    assert.strictEqual(new Set(gates).size, 1, 'run and debug share ONE editor gate');
    assert.ok(gates[0]?.includes('LangId'), `the editor gate names a language: ${String(gates[0])}`);

    // 4. The user right-clicks a project node in the Solution Explorer. B14
    const viewContext = menuItems('view/item/context');
    assert.deepStrictEqual(
      runDebugPlacement('view/item/context'),
      expectedPairs('3_run'),
      'both sit in the 3_run group of view/item/context, per [SE-ACTIONS-RUN-DEBUG]',
    );
    const ours = viewContext.filter((item) => RUN_DEBUG.includes(String(item.command)));
    assert.strictEqual(ours.length, 2, 'exactly one tree entry per command');
    for (const item of ours) {
      const when = String(item.when);
      assert.ok(when.includes('viewItem == project'), `project nodes only; when: ${when}`);
      assert.ok(when.includes('view == sharplsp.solutionExplorer'), `one tree only: ${when}`);
    }

    // 5. The user right-clicks the SAME node expecting what already worked.
    const survivors = viewContext
      .filter((item) => String(item.when).includes('viewItem == project'))
      .map((item) => [String(item.command), String(item.group)]);
    const preserved = [
      [PREFIX + 'openProjectFile', '3_open'],
      [PREFIX + 'build', '2_build'],
      [PREFIX + 'rebuild', '2_build'],
      [PREFIX + 'clean', '2_build'],
    ];
    const seen = survivors.map((pair) => pair.join('@'));
    for (const pair of preserved) {
      const wanted = pair.join('@');
      assert.ok(seen.includes(wanted), `'${wanted}' survives unchanged; saw: ${seen.join(', ')}`);
    }
    assert.ok(survivors.length >= 6, `the tree keeps its old items and gains two: ${seen.length}`);
  });

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] rules 1-3.
  test('the launch schema declares what the resolver writes and nothing VS Code core injects', () => {
    // 1. The user opens launch.json and triggers IntelliSense.
    const attributes = configurationAttributes();
    const kinds = Object.keys(attributes).sort();
    assert.deepStrictEqual(kinds, ['attach', 'launch'], 'both request kinds, nothing else');
    const launch = attributes.launch;
    assert.deepStrictEqual(launch.required, ['program'], 'program is the only required attribute');
    const props = launch.properties;
    assert.strictEqual(typeof props, 'object', 'launch declares a properties object');
    assert.deepStrictEqual(Object.keys(props).sort(), LAUNCH_SCHEMA, DECLARED_SCHEMA);
    assert.strictEqual(Object.keys(props).length, 10, 'ten attributes, no more and no fewer');

    // 2. The user types `"console":` and expects the three destinations. B50
    assertSchemaProperty(props, 'console', 'string');
    assert.deepStrictEqual(
      props.console.enum,
      ['internalConsole', 'integratedTerminal', 'externalTerminal'],
      'console offers exactly the three destinations of the spec table',
    );
    const stdin = 'a console app reading stdin is unusable in the input-less debug console';
    assert.strictEqual(props.console.default, 'integratedTerminal', stdin);
    assert.ok(
      (props.console.enum as unknown[]).includes(props.console.default),
      'the declared default must be one of the declared values',
    );

    // 3. The user sets the debugger-behaviour toggles. B50
    for (const key of ['justMyCode', 'hotReload', 'requireExactSource', 'stopAtEntry']) {
      assertSchemaProperty(props, key, 'boolean');
      assert.strictEqual(typeof props[key].default, 'boolean', `'${key}' declares a default`);
    }
    assert.strictEqual(props.stopAtEntry.default, false, 'stopAtEntry defaults to false');
    const implicit = 'debug.ts sets justMyCode = true whenever the user left it unset, so the ' +
      'declared default must say so rather than contradicting the resolver';
    assert.strictEqual(props.justMyCode.default, true, implicit);
    assertSchemaProperty(props, 'symbolOptions', 'object');
    assertSchemaProperty(props, 'program', 'string');
    assertSchemaProperty(props, 'cwd', 'string');
    assertSchemaProperty(props, 'env', 'object');
    assertSchemaProperty(props, 'args', 'array');
    assert.strictEqual(props.args.items.type, 'string', 'args is an array of strings');
    assert.deepStrictEqual(props.args.default, [], 'args defaults to no arguments');

    // 4. The user types `"preLaunchTask":` — core owns that attribute's schema.
    assert.deepStrictEqual(CORE_INJECTED.filter((key) => key in props), [], CORE_OWNED);
    assert.strictEqual(CORE_INJECTED.length, 10, 'the core-injected list itself is intact');

    // 5. The user switches the configuration to `attach`.
    const attach = attributes.attach;
    assert.deepStrictEqual(attach.required, ['processId'], 'attach requires a process id');
    assert.deepStrictEqual(Object.keys(attach.properties), ['processId'], 'attach is not clobbered');
    assertSchemaProperty(attach.properties, 'processId', 'number');
    assert.notDeepStrictEqual(attach.properties, props, 'attach and launch are distinct schemas');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-DYNAMIC] rules 2, 3 and 5.
  test('activation events, initial configurations and snippets expose the resolver TFM', () => {
    // 1. The user opens a folder: VS Code reads activationEvents BEFORE the
    //    extension is active to decide what it can already offer. B52
    const events: unknown = packageJson().activationEvents;
    assert.ok(Array.isArray(events), 'the manifest must declare activationEvents');
    const declared = events.join(', ');
    const resolveEvent = `onDebugResolve:${DEBUG_TYPE}`;
    const dynamicEvent = `onDebugDynamicConfigurations:${DEBUG_TYPE}`;
    assert.ok(events.includes(resolveEvent), `'${resolveEvent}' declared; have: ${declared}`);
    assert.ok(events.includes(dynamicEvent), `'${dynamicEvent}' declared; have: ${declared}`);
    const debugEvents = events.filter((e) => e === resolveEvent || e === dynamicEvent);
    assert.strictEqual(debugEvents.length, 2, 'each debug activation event appears once');
    assert.strictEqual(new Set(events).size, events.length, 'no activation event is duplicated');
    assert.ok(!events.includes('*'), `a wildcard activation is never acceptable: ${declared}`);
    assert.ok(events.includes('onStartupFinished'), 'startup activation must not be dropped');
    const globs = ['**/*.csproj', '**/*.fsproj', '**/*.sln', '**/*.slnx'];
    assert.deepStrictEqual(
      events.filter((e) => String(e).startsWith('workspaceContains:')).sort(),
      globs.map((glob) => `workspaceContains:${glob}`),
      'adding debug activation events must not disturb the project-file ones',
    );
    assert.ok(events.length >= 7, `five existing events plus the two debug ones: ${declared}`);

    // 2. The user clicks "create a launch.json file". B52
    const initial = initialConfigurations();
    assert.ok(initial.length >= 1, 'a generated launch.json needs a configuration');
    const initialTypes = initial.map((config) => String(config.type));
    const oneType = `every initial configuration must declare type '${DEBUG_TYPE}'`;
    assert.deepStrictEqual(initialTypes, initial.map(() => DEBUG_TYPE), oneType);
    const names = initial.map((config) => String(config.name));
    assert.strictEqual(new Set(names).size, names.length, 'two configs cannot share one name');
    const generated = initial.find((config) => config.request === 'launch');
    assert.ok(generated, 'the generated launch.json must contain a launch configuration');
    assertNonEmptyString(generated.name, 'the generated configuration name');
    assertNonEmptyString(generated.program, 'the generated configuration program');
    const generatedProgram = String(generated.program);
    const relative = `must be workspace-relative; got: ${generatedProgram}`;
    assert.ok(generatedProgram.includes('${workspaceFolder}'), `the program ${relative}`);
    assert.ok(generatedProgram.endsWith('.dll'), `netcoredbg launches a managed dll: ${relative}`);
    assert.deepStrictEqual(
      frameworkSegments(generatedProgram).filter((segment) => segment !== TFM),
      [],
      `the generated configuration must not name a framework the resolver rejects (${TFM})`,
    );
    assert.strictEqual(generated.preLaunchTask, undefined, 'no undeclared task type is referenced');

    // 3. The user types a quote in launch.json and picks the launch snippet. B52
    const bodies = snippetBodies();
    assert.strictEqual(bodies.length, 2, 'a launch and an attach snippet are both offered');
    const snippet = bodies.find((body) => body.request === 'launch');
    assert.ok(snippet, 'a launch snippet must be offered');
    const program = String(snippet.program);
    assert.deepStrictEqual(
      frameworkSegments(program),
      [TFM],
      `the snippet must name exactly the framework the resolver prefers (${TFM}); the shipped ` +
        `snippet still names net9.0, teaching a path that will not resolve; program: ${program}`,
    );
    assert.ok(program.includes('${workspaceFolder}'), `the snippet is folder-relative: ${program}`);
    assert.strictEqual(snippet.cwd, '${workspaceFolder}', 'the snippet runs from the folder');
    assert.strictEqual(snippet.stopAtEntry, false, 'the snippet does not stop at entry');
    assertNonEmptyString(snippet.name, 'the launch snippet name');
    const requests = [String(snippet.request), String(generated.request)];
    assert.deepStrictEqual(requests, ['launch', 'launch'], 'snippet and generated config agree');

    // 4. The user picks the attach snippet instead.
    const attach = bodies.find((body) => body.request === 'attach');
    assert.ok(attach, 'the attach snippet must survive');
    assert.strictEqual(attach.processId, 0, 'the attach snippet keeps its placeholder pid');
    assert.strictEqual(String(attach.type), DEBUG_TYPE, 'the attach snippet names one type');
    assert.strictEqual(attach.program, undefined, 'an attach body never names a program');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-BUILD] rules 1 and 2.
  test('the build task type the code registers is declared and expresses every task provided', () => {
    // 1. The user opens tasks.json and types `"type": "sharplsp-`. B07
    const definitions = taskDefinitions();
    const types = definitions.map((definition) => String(definition.type));
    const declared = types.join(', ');
    const unusable = `build.ts registers '${BUILD_TYPE}'; declared: ${declared}`;
    assert.ok(types.includes(BUILD_TYPE), `taskDefinitions must declare it — ${unusable}`);
    assert.ok(definitions.length >= 1, 'at least one task definition must be declared');
    const mine = types.filter((type) => type === BUILD_TYPE);
    assert.strictEqual(mine.length, 1, 'the build task type is declared exactly once');
    assert.ok(!types.includes('dotnet'), `no proprietary 'dotnet' task type: ${declared}`);
    assert.strictEqual(BUILD_TYPE, 'sharplsp-build', 'the registered type is the prefixed one');

    // 2. The user asks VS Code for the SharpLsp build tasks.
    const provider = new SharpLspBuildTaskProvider();
    const provided = provider.provideTasks();
    assert.strictEqual(provided.length, 3, 'build, rebuild and clean are provided');
    const shape = provided.map((task) => [task.definition.type, task.source, task.group?.id]);
    const expected = provided.map(() => [BUILD_TYPE, 'SharpLsp', 'build']);
    const discarded = 'undeclared-type tasks are discarded; the picker groups these as Build';
    assert.deepStrictEqual(shape, expected, discarded);
    const verbs = provided.map((task) => String(task.definition.command));
    assert.deepStrictEqual(verbs, VERBS, 'the three build verbs, in picker order');
    assert.deepStrictEqual(provided.map((task) => task.name), ['Build', 'Rebuild', 'Clean'], 'labels');
    const keys = provided.map((task) => Object.keys(task.definition).sort());
    assert.deepStrictEqual(keys, provided.map(() => ['command', 'type']), 'definitions carry two keys');
    const matchers = provided.map((task) => task.problemMatchers);
    assert.deepStrictEqual(matchers, provided.map(() => ['$msCompile']), 'errors reach the Problems panel');
    const shells = provided.every((task) => task.execution instanceof vscode.ShellExecution);
    assert.strictEqual(shells, true, 'each build task is an execution the user can cancel');
    const runs = provided.map((task) => task.execution as vscode.ShellExecution);
    assert.deepStrictEqual(runs.map((run) => run.command), ['dotnet', 'dotnet', 'dotnet'], 'CLI');
    assert.deepStrictEqual(
      runs.map((run) => run.args),
      [['build'], ['build', '--no-incremental'], ['clean']],
      'rebuild is `dotnet build --no-incremental`; the manifest enum must still name it "rebuild"',
    );

    // 3. The user writes `"command": "rebuild"` in that task entry. B07
    const definition = definitions.find((entry) => entry.type === BUILD_TYPE)!;
    assert.strictEqual(typeof definition.properties, 'object', 'the definition declares properties');
    const required = 'resolveTask returns undefined without `command`, so the manifest requires it';
    assert.deepStrictEqual(definition.required, ['command'], required);
    assert.deepStrictEqual(Object.keys(definition.properties).sort(), ['command'], 'only `command`');
    assert.strictEqual(definition.properties.command.type, 'string', '`command` is a string');
    const values: unknown[] = definition.properties.command.enum ?? [];
    assert.deepStrictEqual(
      values.map((value) => String(value)).sort(),
      [...verbs].sort(),
      'the declared enum is exactly the verbs the provider produces — one source of truth',
    );

    // 4. The user saves that tasks.json entry and VS Code calls resolveTask.
    const bare = new vscode.Task({ type: BUILD_TYPE }, vscode.TaskScope.Workspace, 'x', 'SharpLsp');
    assert.strictEqual(provider.resolveTask(bare), undefined, 'a command-less entry is refused');
    const resolved = provider.resolveTask(provided[1]!);
    assert.strictEqual(resolved?.definition.command, 'rebuild', 'the verb survives the round trip');
    assert.strictEqual(resolved?.definition.type, BUILD_TYPE, 'the resolved type is unchanged');
    assert.strictEqual(resolved?.name, 'Rebuild', 'the resolved task keeps the label');

    // 5. The user presses F5 and VS Code runs the preLaunchTask.
    const bodies = [...snippetBodies(), ...initialConfigurations()];
    const proprietary = bodies.map((b) => b.preLaunchTask).filter((t) => t === 'dotnet: build');
    const missing = 'a SharpLsp-only install fails: Could not find the task (rule 1)';
    assert.deepStrictEqual(proprietary, [], `no preLaunchTask names 'dotnet: build' — ${missing}`);
    const tasks = bodies.map((b) => b.preLaunchTask).filter((t) => t !== undefined);
    const undeclared = tasks.map(String).filter((t) => !t.startsWith(BUILD_TYPE));
    assert.deepStrictEqual(undeclared, [], `every preLaunchTask names a declared type: ${declared}`);
    assert.ok(bodies.length >= 3, 'both snippets and the generated configurations were checked');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS] rules 1, 2 and 3.
  test('every contributed command is registered, constant-named and reachable from a menu', async function () {
    this.timeout(30_000);
    // 1. The user opens the Command Palette: it lists the intersection of what is
    //    contributed and what is registered.
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.ok(registered.size > 0, 'the command registry must not be empty');
    const contributed = sharpLspIds();
    assert.ok(contributed.length > 0, 'the manifest must contribute sharplsp commands');
    assert.strictEqual(new Set(contributed).size, contributed.length, 'no id contributed twice');
    const unregistered = contributed.filter((id) => !registered.has(id));
    const dead = `contributed but never registered: ${unregistered.join(', ')}`;
    assert.deepStrictEqual(unregistered, [], `a palette entry with no handler — ${dead}`);

    // 2. The user invokes a command code registered but the manifest never
    //    declared — it is unreachable from the palette. B58
    const registeredOurs = [...registered].filter((id) => id.startsWith(PREFIX)).sort();
    const uncontributed = registeredOurs.filter((id) => !contributed.includes(id));
    const invisible = `palette-invisible commands: ${uncontributed.join(', ')}`;
    assert.deepStrictEqual(uncontributed, [], `all registered ids contributed — ${invisible}`);
    assert.strictEqual(registeredOurs.length, contributed.length, 'the two sets match in size');
    assert.deepStrictEqual(registeredOurs, contributed, 'the two sets match member for member');

    // 3. A maintainer greps constants.ts. Rule 2: an id is named by a constant, and a
    //    constant naming a command that is neither registered nor contributed is dead.
    const named = commandConstants();
    assert.ok(named.length > 0, 'constants.ts must export CMD_* command ids');
    const orphans = named.filter((id) => !contributed.includes(id));
    const rot = `dead command constants — remove them or contribute them: ${orphans.join(', ')}`;
    assert.deepStrictEqual(orphans, [], rot);
    assert.deepStrictEqual(
      named.filter((id) => !registered.has(id)),
      [],
      'a CMD_* constant that names no registered command is dead code (rule 2)',
    );
    for (const id of RUN_DEBUG) {
      assert.ok(named.includes(id), `'${id}' must be a CMD_* constant, not an inline literal`);
    }

    // 4. The user runs, then debugs, the focused program. B58
    const live = registeredOurs.join(', ');
    assert.ok(registered.has(CMD_DEBUG_PROGRAM), `'${CMD_DEBUG_PROGRAM}' live; have: ${live}`);
    const noHandler = `no run command exists today; registered: ${live}`;
    assert.ok(registered.has(CMD_RUN_PROGRAM), `'${CMD_RUN_PROGRAM}' live — ${noHandler}`);
    await assertCommandRegistered(CMD_RUN_PROGRAM);
    await assertCommandRegistered(CMD_DEBUG_PROGRAM);
    const both = RUN_DEBUG.filter((id) => contributed.includes(id));
    assert.deepStrictEqual(both, RUN_DEBUG, 'run and debug are contributed as well as registered');

    // 5. The user clicks a menu item: a menu may only name a live command.
    const menuCommands = MENUS.flatMap((menu) => menuItems(menu))
      .map((item) => String(item.command))
      .filter((id) => id.startsWith(PREFIX));
    assert.ok(menuCommands.length > 0, 'the manifest must place sharplsp commands in menus');
    const places = RUN_DEBUG.map((id) => menuCommands.filter((seen) => seen === id).length);
    assert.deepStrictEqual(places, [3, 3], 'each command sits in all three menus, once each');
    const dangling = [...new Set(menuCommands)].filter((id) => !registered.has(id)).sort();
    const broken = `menu items pointing at nothing: ${dangling.join(', ')}`;
    assert.deepStrictEqual(dangling, [], `every menu item must resolve — ${broken}`);
    const unlisted = [...new Set(menuCommands)].filter((id) => !contributed.includes(id)).sort();
    assert.deepStrictEqual(unlisted, [], `every menu item is contributed: ${unlisted.join(', ')}`);
  });
});
