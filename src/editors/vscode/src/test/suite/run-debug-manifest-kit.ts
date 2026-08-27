// Manifest readers and expectations for the run/debug contribution suite.
//
// Spec: [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS], [DEBUG-FEATURES-LAUNCH-OUTPUT],
// [DEBUG-FEATURES-LAUNCH-DYNAMIC], [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION].
//
// Split out of run-debug-contributions.test.ts so both files clear the 500-line
// ceiling. Everything here reads the LIVE manifest through the run/debug kit, so
// an expectation can never drift from what VS Code actually parsed.
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
import { SharpLspBuildTaskProvider } from '../../build.js';
import * as constants from '../../constants.js';
import {
  CMD_DEBUG_PROGRAM,
  CMD_RUN_PROGRAM,
  contributes,
  debuggerContribution,
  menuItems,
} from './run-debug-kit';

export const { DEBUG_TYPE } = constants;
/** Every command this extension owns carries this prefix. */
export const PREFIX = 'sharplsp.';
/** The languages both the breakpoint and the debugger contribution must serve. */
export const LANGS = ['csharp', 'fsharp'];
/** The two run/debug command ids, in the order the menus must present them. */
export const RUN_DEBUG = [CMD_RUN_PROGRAM, CMD_DEBUG_PROGRAM];
/** The task type `build.ts` registers with `vscode.tasks.registerTaskProvider`. */
export const BUILD_TYPE = SharpLspBuildTaskProvider.Type;
/** The verbs `SharpLspBuildTaskProvider.provideTasks` emits, in order. */
export const VERBS = ['build', 'rebuild', 'clean'];
/** The menus [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS] places both commands in. */
export const MENUS = ['editor/title/run', 'editor/context', 'view/item/context'];
/** Menus that already carry SharpLsp items and must survive the run/debug work. */
export const EXISTING_MENUS = ['editor/context', 'view/title', 'debug/toolbar', 'view/item/context'];
/** Attributes core injects and overwrites; a hand-rolled copy misdescribes them. */
export const CORE_INJECTED = (
  'name type request preLaunchTask postDebugTask presentation ' +
  'internalConsoleOptions debugServer suppressMultipleSessionWarning serverReadyAction'
).split(' ');
/** The launch schema of [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 3, sorted. */
export const LAUNCH_SCHEMA = (
  'args console cwd env hotReload justMyCode program ' +
  'requireExactSource stopAtEntry symbolOptions'
).split(' ');
export const ACCIDENT =
  'both must be listed: C# breakpoints are impossible today, and F# works only by accident ' +
  'because the built-in ms-vscode.js-debug happens to contribute fsharp (rule 3)';
export const UNCONDITIONAL =
  'an entry declares only `language`: a `when` tied to server state makes the gutter appear ' +
  'and disappear as the language server cycles (rule 2)';
export const DECLARED_SCHEMA =
  'the declared schema must match [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 3 exactly — debug.ts ' +
  'writes justMyCode on every resolve, so leaving it undeclared makes launch.json IntelliSense ' +
  'flag a valid, extension-authored attribute as an error';
export const CORE_OWNED =
  'attributes VS Code core injects must NOT be re-declared: core overwrites them and a ' +
  'hand-rolled copy misdescribes them in launch.json';

/** Assert `value` is a non-empty string — two independently failing checks. */
export function assertNonEmptyString(value: unknown, label: string): void {
  assert.strictEqual(typeof value, 'string', `${label} must be declared as a string`);
  assert.notStrictEqual(String(value).trim(), '', `${label} must not be empty`);
}

/** Assert one JSON-schema property: it exists, has `type`, and documents itself. */
export function assertSchemaProperty(props: Record<string, any>, key: string, type: string): void {
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
export function sharpLspIds(): string[] {
  return commandEntries()
    .map((entry) => String(entry.command))
    .filter((id) => id.startsWith(PREFIX))
    .sort();
}

/** The single manifest entry for `id`; fails naming what IS contributed. */
export function commandEntry(id: string): Record<string, any> {
  const matches = commandEntries().filter((entry) => entry.command === id);
  const seen = sharpLspIds().join(', ');
  assert.strictEqual(matches.length, 1, `'${id}' contributed exactly once; have: ${seen}`);
  return matches[0]!;
}

/** Every `CMD_*` value the constants module exports — each one names a command. */
export function commandConstants(): string[] {
  return Object.entries(constants)
    .filter(([name]) => name.startsWith('CMD_'))
    .map(([, value]) => value)
    .sort();
}

/** The `[command, group]` pairs `menu` declares for run and debug, in order. */
export function runDebugPlacement(menu: string): string[][] {
  return menuItems(menu)
    .filter((item) => RUN_DEBUG.includes(String(item.command)))
    .map((item) => [String(item.command), String(item.group)]);
}

/** The `[command, group]` pairs a menu must declare — run first, debug second. */
export function expectedPairs(group: string): string[][] {
  return RUN_DEBUG.map((id, index) => [id, `${group}@${index + 1}`]);
}

/** The `configurationAttributes` block of the debugger contribution. */
export function configurationAttributes(): Record<string, any> {
  const attributes = debuggerContribution().configurationAttributes;
  assert.ok(attributes?.launch, 'the debugger must declare configurationAttributes.launch');
  return attributes;
}

/** The `configurationSnippets` array of the debugger contribution. */
export function snippets(): Record<string, any>[] {
  const list: unknown = debuggerContribution().configurationSnippets;
  assert.ok(Array.isArray(list), 'contributes.debuggers[].configurationSnippets must exist');
  return list;
}

/** The `body` of every `configurationSnippets` entry. */
export function snippetBodies(): Record<string, any>[] {
  return snippets().map((snippet) => snippet.body ?? {});
}

/** `initialConfigurations` — [DEBUG-FEATURES-LAUNCH-DYNAMIC] rule 3. */
export function initialConfigurations(): Record<string, any>[] {
  const entry = debuggerContribution();
  const configurations: unknown = entry.initialConfigurations;
  const keys = Object.keys(entry).join(', ');
  const reason = `initialConfigurations must supply a launch.json body; keys: ${keys}`;
  assert.ok(Array.isArray(configurations), reason);
  return configurations;
}

/** `contributes.taskDefinitions` — [DEBUG-FEATURES-LAUNCH-BUILD] rule 2. */
export function taskDefinitions(): Record<string, any>[] {
  const block = contributes();
  const definitions: unknown = block.taskDefinitions;
  const keys = Object.keys(block).join(', ');
  const reason = `contributes.taskDefinitions must declare build.ts's type; keys: ${keys}`;
  assert.ok(Array.isArray(definitions), reason);
  return definitions;
}

/** The `netX.Y` PATH SEGMENTS of a program path — never a substring match. */
export function frameworkSegments(program: string): string[] {
  return program
    .split('/')
    .flatMap((segment) => segment.split('\\'))
    .filter((segment) => segment.startsWith('net'));
}
