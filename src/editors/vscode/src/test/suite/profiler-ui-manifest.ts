// Implements [VSIX]. See docs/specs/LSP-PROFILER-SPEC.md
/**
 * The live extension manifest, narrowed once for every suite that reads it.
 *
 * `vscode.Extension.packageJSON` is typed `any`, so every suite that asserted
 * against a contribution used to write its own `PackageJSON` interface and
 * assert the manifest into it. Six near-identical copies of that interface
 * drifted apart, and each `as PackageJSON` told the compiler a shape nobody
 * had checked: rename a contribution in `package.json` and the reads keep
 * type-checking while silently yielding `undefined`, so the assertion passes
 * against nothing.
 *
 * These readers narrow the manifest at the moment of reading. A contribution
 * that is missing or reshaped comes back empty rather than as a lie, which is
 * what makes the suites that assert on it fail loudly.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  asRecord,
  isRecord,
  rawField,
  recordArrayField,
  recordField,
  stringArrayField,
  stringField,
} from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';
import { EXTENSION_ID } from './profiler-ui-helpers';

/** A `contributes.commands` entry. */
export interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string | undefined;
  readonly icon?: string | Record<string, unknown> | undefined;
  readonly enablement?: string | undefined;
}

/** A `contributes.menus[*]` entry. */
export interface MenuContribution {
  readonly command: string;
  readonly when: string;
  readonly group?: string | undefined;
}

/** A `contributes.views[*]` entry. */
export interface ViewContribution {
  readonly id: string;
  readonly name: string;
  readonly when?: string | undefined;
  readonly visibility?: string | undefined;
}

/** A `contributes.viewsWelcome` entry. */
export interface WelcomeContribution {
  readonly view: string;
  readonly contents: string;
  readonly when?: string | undefined;
}

/** A `contributes.keybindings` entry. */
export interface KeybindingContribution {
  readonly command: string;
  readonly key?: string | undefined;
  readonly when?: string | undefined;
}

/** One `launch`/`attach` schema of a contributed debugger. */
export interface DebuggerConfigSection {
  readonly properties: Record<string, unknown>;
}

/** A `contributes.debuggers` entry. */
export interface DebuggerContribution {
  readonly type: string;
  readonly label: string;
  readonly configurationAttributes: {
    readonly launch?: DebuggerConfigSection | undefined;
    readonly attach?: DebuggerConfigSection | undefined;
  };
}

/** Every declared setting, keyed by its dotted configuration id. */
export type ConfigurationProperties = Record<string, Record<string, unknown>>;

/** Every contribution the manifest declares, already narrowed. */
export interface Contributes {
  readonly commands: CommandContribution[];
  readonly keybindings: KeybindingContribution[];
  readonly menus: Record<string, MenuContribution[]>;
  readonly views: Record<string, ViewContribution[]>;
  readonly viewsWelcome: WelcomeContribution[];
  readonly debuggers: DebuggerContribution[];
  readonly configurationProperties: ConfigurationProperties;
}

/** The manifest VS Code loaded for the installed extension. */
function manifest(): Record<string, unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} must be installed`);
  const packageJson: unknown = extension.packageJSON;
  return asRecord(packageJson);
}

/** The manifest's `contributes` object, or an empty one. */
function contributes(): Record<string, unknown> {
  return recordField(manifest(), 'contributes') ?? {};
}

/** The manifest's `contributes.menus` object, or an empty one. */
function menuSections(): Record<string, unknown> {
  return recordField(contributes(), 'menus') ?? {};
}

/**
 * A command's icon, which the manifest may give as a glyph or as a
 * light/dark pair. Passed through unchanged so equality assertions still
 * compare against whatever `package.json` actually declares.
 */
function iconOf(entry: Record<string, unknown>): string | Record<string, unknown> | undefined {
  const icon = rawField(entry, 'icon');
  if (typeof icon === 'string') {
    return icon;
  }
  return isRecord(icon) ? icon : undefined;
}

function toCommand(entry: Record<string, unknown>): CommandContribution {
  return {
    command: stringField(entry, 'command') ?? '',
    title: stringField(entry, 'title') ?? '',
    category: stringField(entry, 'category'),
    icon: iconOf(entry),
    enablement: stringField(entry, 'enablement'),
  };
}

function toMenu(entry: Record<string, unknown>): MenuContribution {
  return {
    command: stringField(entry, 'command') ?? '',
    when: stringField(entry, 'when') ?? '',
    group: stringField(entry, 'group'),
  };
}

function toView(entry: Record<string, unknown>): ViewContribution {
  return {
    id: stringField(entry, 'id') ?? '',
    name: stringField(entry, 'name') ?? '',
    when: stringField(entry, 'when'),
    visibility: stringField(entry, 'visibility'),
  };
}

function toWelcome(entry: Record<string, unknown>): WelcomeContribution {
  return {
    view: stringField(entry, 'view') ?? '',
    contents: stringField(entry, 'contents') ?? '',
    when: stringField(entry, 'when'),
  };
}

function toKeybinding(entry: Record<string, unknown>): KeybindingContribution {
  return {
    command: stringField(entry, 'command') ?? '',
    key: stringField(entry, 'key'),
    when: stringField(entry, 'when'),
  };
}

function toConfigSection(
  attributes: Record<string, unknown>,
  key: string,
): DebuggerConfigSection | undefined {
  const section = recordField(attributes, key);
  if (section === undefined) {
    return undefined;
  }
  return { properties: recordField(section, 'properties') ?? {} };
}

function toDebugger(entry: Record<string, unknown>): DebuggerContribution {
  const attributes = recordField(entry, 'configurationAttributes') ?? {};
  return {
    type: stringField(entry, 'type') ?? '',
    label: stringField(entry, 'label') ?? '',
    configurationAttributes: {
      launch: toConfigSection(attributes, 'launch'),
      attach: toConfigSection(attributes, 'attach'),
    },
  };
}

/** The manifest's `displayName`, or `""` when it declares none. */
export function manifestDisplayName(): string {
  return stringField(manifest(), 'displayName') ?? '';
}

/** The manifest's `activationEvents`, or `[]` when it declares none. */
export function manifestActivationEvents(): string[] {
  return stringArrayField(manifest(), 'activationEvents');
}

/** Every contributed command. */
export function manifestCommands(): CommandContribution[] {
  return recordArrayField(contributes(), 'commands').map(toCommand);
}

/** Every contributed keybinding. */
export function manifestKeybindings(): KeybindingContribution[] {
  return recordArrayField(contributes(), 'keybindings').map(toKeybinding);
}

/** The entries of one menu, e.g. `view/title` or `debug/toolBar`. */
export function manifestMenu(menuId: string): MenuContribution[] {
  return recordArrayField(menuSections(), menuId).map(toMenu);
}

/** Every contributed menu, keyed by menu id. */
export function manifestMenus(): Record<string, MenuContribution[]> {
  const sections = menuSections();
  const entries: [string, MenuContribution[]][] = Object.keys(sections).map((menuId) => [
    menuId,
    manifestMenu(menuId),
  ]);
  return Object.fromEntries(entries);
}

/** Every contributed view, keyed by the container that hosts it. */
export function manifestViews(): Record<string, ViewContribution[]> {
  const views = recordField(contributes(), 'views') ?? {};
  const entries: [string, ViewContribution[]][] = Object.keys(views).map((container) => [
    container,
    recordArrayField(views, container).map(toView),
  ]);
  return Object.fromEntries(entries);
}

/** Every contributed viewsWelcome entry. */
export function manifestViewsWelcome(): WelcomeContribution[] {
  return recordArrayField(contributes(), 'viewsWelcome').map(toWelcome);
}

/** Every contributed debugger. */
export function manifestDebuggers(): DebuggerContribution[] {
  return recordArrayField(contributes(), 'debuggers').map(toDebugger);
}

/**
 * Every declared setting.
 *
 * `contributes.configuration` is allowed to be a single section or an array of
 * them; both forms are flattened into one map so callers never branch on it.
 */
export function manifestConfigurationProperties(): ConfigurationProperties {
  const declared = rawField(contributes(), 'configuration');
  const sections = Array.isArray(declared) ? declared.filter(isRecord) : [asRecord(declared)];
  const entries: [string, Record<string, unknown>][] = sections.flatMap((section) => {
    const properties = recordField(section, 'properties') ?? {};
    return Object.keys(properties).map((key): [string, Record<string, unknown>] => [
      key,
      asRecord(properties[key]),
    ]);
  });
  return Object.fromEntries(entries);
}

/** Every contribution at once, for suites that assert across several. */
export function manifestContributes(): Contributes {
  return {
    commands: manifestCommands(),
    keybindings: manifestKeybindings(),
    menus: manifestMenus(),
    views: manifestViews(),
    viewsWelcome: manifestViewsWelcome(),
    debuggers: manifestDebuggers(),
    configurationProperties: manifestConfigurationProperties(),
  };
}
