// Manifest readers and expectations for the run/debug contribution suite.
//
// Spec: [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS], [DEBUG-FEATURES-LAUNCH-OUTPUT],
// [DEBUG-FEATURES-LAUNCH-DYNAMIC], [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION].
//
// Split out of run-debug-contributions.test.ts so both files clear the 500-line
// ceiling. Everything here reads the LIVE manifest through the run/debug kit, or
// the launch.json schema VS Code built from it, so an expectation can never drift
// from what VS Code actually parsed.
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
import { isRecord } from '../../utils.js';
import {
  CMD_DEBUG_PROGRAM,
  CMD_RUN_PROGRAM,
  DEBUG_TYPE_ID,
  authoredConfigurationAttributes,
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
export const EXISTING_MENUS = [
  'editor/context',
  'view/title',
  'debug/toolbar',
  'view/item/context',
];
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
/**
 * The attach schema of [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 3, sorted.
 *
 * `justMyCode` belongs here as well as on launch: debug.ts writes
 * `config.justMyCode ??= true` BEFORE it checks the request kind, so an attach
 * configuration receives it too, and rule 3 requires the schema to say so.
 */
export const ATTACH_SCHEMA = 'justMyCode processId'.split(' ');
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

/**
 * Assert one JSON-schema property: it exists, has `type`, and documents itself.
 *
 * `type` may be a union (`['number', 'string']`), which JSON Schema expresses as
 * an array and which real debug attributes need — `processId` accepts a literal
 * pid OR a `${command:pickProcess}` string. The union is compared EXACTLY, so
 * widening one still fails here.
 */
export function assertSchemaProperty(
  props: Record<string, any>,
  key: string,
  type: string | readonly string[],
): void {
  const property: unknown = props[key];
  assert.strictEqual(typeof property, 'object', `'${key}' must be declared as a schema object`);
  const expected = typeof type === 'string' ? type : [...type];
  const shown = typeof type === 'string' ? type : type.join(' | ');
  assert.deepStrictEqual(props[key].type, expected, `'${key}' must be declared as '${shown}'`);
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

/** The launch.json schema core's debug service registers, the one IntelliSense serves. */
const LAUNCH_JSON_SCHEMA = vscode.Uri.parse('vscode://schemas/launch');

/** How a served schema refers to a subschema it factored out into `$defs`. */
const DEFS_REF = '#/$defs/';

/** What core prepends to every request's `required`, in core's order. */
const CORE_REQUIRED = ['name', 'type', 'request'];

/**
 * The debugger's `configurationAttributes` as core's merge leaves them: the
 * `<type>:<request>` definitions of the launch.json schema core builds from the
 * contribution, the schema IntelliSense serves.
 *
 * NOT `extension.packageJSON` (#261). Core merges in the RENDERER, mutating the
 * contribution it holds, and the extension host received its copy of the manifest
 * once, at startup. Whether that copy shows the merge depends on which of the two
 * ran first, and no amount of polling in the extension host changes it.
 *
 * Core registers the schema empty at startup and adds these definitions when it
 * handles the `debuggers` contribution, which the extension host does not wait
 * for. Until then this is `{}`, and a caller polling for the merge keeps waiting.
 */
export async function configurationAttributes(): Promise<Record<string, any>> {
  const authored = authoredConfigurationAttributes();
  assert.ok(authored.launch, 'the debugger must declare configurationAttributes.launch');
  const definitions = launchDefinitions(await servedSchema(LAUNCH_JSON_SCHEMA));
  return Object.fromEntries(
    Object.entries(definitions).map(([request, definition]) => {
      const required = mergedOnce(definition.required, authored[request]?.required);
      return [request, { ...definition, required }];
    }),
  );
}

/** This debugger's `<type>:<request>` definitions in the launch schema, by request. */
function launchDefinitions(
  schema: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const definitions = isRecord(schema.definitions) ? schema.definitions : {};
  const prefix = `${DEBUG_TYPE_ID}:`;
  // `<type>:<request>` only: each request also has a `<type>:<request>:platform`.
  return Object.fromEntries(
    Object.entries(definitions).flatMap(([id, definition]): [string, Record<string, unknown>][] => {
      const request = id.startsWith(prefix) ? id.slice(prefix.length) : '';
      const own = request !== '' && !request.includes(':') && isRecord(definition);
      return own ? [[request, definition]] : [];
    }),
  );
}

/**
 * `required` as ONE merge leaves it: core's three, then the authored list.
 *
 * Core does not merge idempotently. Every rebuild of the launch schema prepends
 * its three again - the debuggers handler, then task-label and `when`-key
 * changes - so the live schema carries one copy per rebuild. Anything in front
 * of the authored list other than whole copies of core's three is not core's
 * doing, and fails here.
 */
function mergedOnce(live: unknown, authored: unknown): string[] {
  const own = Array.isArray(authored) ? authored.map(String) : [];
  const listed = Array.isArray(live) ? live.map(String) : [];
  const prepended = listed.slice(0, Math.max(0, listed.length - own.length));
  const copies = prepended.length / CORE_REQUIRED.length;
  const coreOnly = prepended.every(
    (name, index) => name === CORE_REQUIRED[index % CORE_REQUIRED.length],
  );
  const shown = `'required' is ${JSON.stringify(listed)}`;
  assert.ok(
    Number.isInteger(copies) && copies >= 1 && coreOnly,
    `core prepends its three: ${shown}`,
  );
  assert.deepStrictEqual(listed.slice(prepended.length), own, `then the authored list: ${shown}`);
  return [...CORE_REQUIRED, ...own];
}

/** A schema as VS Code serves it, with every subschema it factored into `$defs` put back. */
async function servedSchema(uri: vscode.Uri): Promise<Record<string, unknown>> {
  const served: unknown = JSON.parse(
    new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)),
  );
  assert.ok(isRecord(served), `${uri.toString()} must serve a JSON object`);
  const inflated = inflate(served, isRecord(served.$defs) ? served.$defs : {});
  return isRecord(inflated) ? inflated : {};
}

/**
 * Replace each `#/$defs/<id>` reference with the subschema it stands for.
 *
 * VS Code serves a schema compressed: a subschema that occurs more than once is
 * written once under `$defs` and referenced everywhere it occurred. The launch
 * schema repeats every attribute (the `<type>:<request>` definition and the
 * `configurations` entry share them), so read raw, `console` would be a `$ref`.
 */
function inflate(node: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((item) => inflate(item, defs));
  if (!isRecord(node)) return node;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith(DEFS_REF)) {
    return inflate(defs[ref.slice(DEFS_REF.length)], defs);
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, inflate(value, defs)]),
  );
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
