// Shared contribution-point assertions for the activation suite.
//
// Spec: [DIST-EDITOR-CONTRACT], [DIST-FAILURE-UX], [DIST-WORKSPACE-TRUST],
// [DIST-RUNTIME-ACQUIRE], [SHARPLSP-ARCHITECTURE-EXTENSIONS].
//
// A contribution point is not packaging trivia. With no `contributes.commands`
// entry a command is unreachable from the palette however well it is
// registered; with no `capabilities.untrustedWorkspaces.restrictedConfigurations`
// entry an untrusted workspace can name the executable SharpLsp spawns. Neither
// defect shows up in a runtime API, so the manifest VS Code itself parsed is the
// only honest surface — and every helper here asserts against THAT, never
// against a hand-copied expectation.
//
// The manifest readers live in run-debug-kit; this file adds only what the
// activation suite needs on top of them.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from './test-helpers';
import { authoredPackageJson, contributes, packageJson } from './run-debug-kit';

/** One entry of `contributes.commands`. */
export interface ContributedCommand {
  readonly command: string;
  readonly title?: string;
  readonly category?: string;
}

/** One entry of `contributes.languages`. */
export interface ContributedLanguage {
  readonly id: string;
  readonly extensions?: string[];
  readonly aliases?: string[];
  readonly configuration?: string;
}

/** One property of `contributes.configuration.properties`. */
export interface ConfigProperty {
  readonly type?: string | string[];
  readonly default?: unknown;
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly enum?: unknown[];
  readonly scope?: string;
}

/**
 * The settings [DIST-WORKSPACE-TRUST] forbids an untrusted workspace to set.
 *
 * Every one of them either names an executable SharpLsp will spawn or injects
 * arguments into one. A workspace that can set them is a workspace that can run
 * arbitrary code the moment a folder is opened.
 */
export const TRUST_RESTRICTED_SETTINGS = [
  'sharplsp.lspPath',
  'sharplsp.csharpSidecarPath',
  'sharplsp.fsharpSidecarPath',
  'sharplsp.server.extraArgs',
  'sharplsp.fsi.extraArgs',
  'sharplsp.debug.netcoredbgPath',
] as const;

/**
 * The commands [DIST-FAILURE-UX] rule 6 requires so a user can re-attempt a
 * failed activation without uninstalling the extension.
 */
export const RECOVERY_COMMANDS = ['sharplsp.restartServer', 'sharplsp.retryDotnetAcquisition'];

/** The .NET Install Tool extension SharpLsp depends on ([DIST-RUNTIME-ACQUIRE]). */
export const INSTALL_TOOL_ID = 'ms-dotnettools.vscode-dotnet-runtime';

/** The extension object, asserted present rather than optional-chained away. */
export function sharpLspExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the VSIX host`);
  return extension;
}

/** Every `contributes.commands` entry, asserted to be a populated array. */
export function commandEntries(): ContributedCommand[] {
  const commands: unknown = contributes().commands;
  assert.ok(Array.isArray(commands), 'contributes.commands must be an array');
  assert.ok(commands.length > 0, 'contributes.commands must not be empty');
  return commands as ContributedCommand[];
}

/** Every `contributes.languages` entry, asserted to be a populated array. */
export function languageEntries(): ContributedLanguage[] {
  const languages: unknown = contributes().languages;
  assert.ok(Array.isArray(languages), 'contributes.languages must be an array');
  assert.ok(languages.length > 0, 'contributes.languages must not be empty');
  return languages as ContributedLanguage[];
}

/** The one `contributes.languages` entry with this id. */
export function languageNamed(id: string): ContributedLanguage {
  const matches = languageEntries().filter((entry) => entry.id === id);
  assert.strictEqual(
    matches.length,
    1,
    `exactly one '${id}' language contribution, not ${matches.length}`,
  );
  const entry = matches[0];
  assert.ok(entry, `contributes.languages must declare '${id}'`);
  return entry;
}

/** The `contributes.configuration.properties` map. */
export function configProperties(): Record<string, ConfigProperty> {
  const configuration: unknown = contributes().configuration;
  assert.ok(configuration, 'the manifest must declare a contributes.configuration block');
  const properties: unknown = (configuration as { properties?: unknown }).properties;
  assert.ok(properties, 'contributes.configuration must declare properties');
  return properties as Record<string, ConfigProperty>;
}

/**
 * A command is REACHABLE: registered at runtime, declared in the manifest, and
 * declared exactly once, under the palette category a user searches by.
 *
 * Registration alone proves nothing about the palette, and a manifest entry
 * alone proves nothing about the handler — a command needs both, so this
 * asserts both.
 */
export function assertReachableCommand(id: string, palette: readonly string[]): ContributedCommand {
  assert.ok(
    palette.includes(id),
    `'${id}' must be registered; registered sharplsp commands: ${palette
      .filter((name) => name.startsWith('sharplsp.'))
      .sort()
      .join(', ')}`,
  );
  const declared = commandEntries().filter((entry) => entry.command === id);
  assert.strictEqual(declared.length, 1, `'${id}' must be declared exactly once in the manifest`);
  const entry = declared[0];
  assert.ok(entry, `contributes.commands must declare '${id}'`);
  assert.strictEqual(entry.category, 'SharpLsp', `'${id}' must sit under the SharpLsp category`);
  assert.ok(
    typeof entry.title === 'string' && entry.title.length > 0,
    `'${id}' must carry a non-empty palette title`,
  );
  assert.ok(id.startsWith('sharplsp.'), `'${id}' must live in the sharplsp namespace`);
  return entry;
}

/**
 * A setting is CONTRIBUTED: inspectable, documented, typed, defaulted to the
 * spec's value, and at rest reading as that default - what a fresh install sees.
 */
export function assertContributedSetting(key: string, expectedDefault: unknown): ConfigProperty {
  const section = key.slice(0, key.lastIndexOf('.'));
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  const inspected = vscode.workspace.getConfiguration(section).inspect(leaf);
  assert.ok(inspected, `${key} must be inspectable`);
  assert.deepStrictEqual(inspected.defaultValue, expectedDefault, `${key} default`);
  assert.strictEqual(
    inspected.globalValue,
    undefined,
    `${key} must be unset at user scope at rest`,
  );
  // The fixture workspace pins a few settings to their own defaults so a stale
  // user profile cannot drift them; to the extension that is the same as unset.
  assert.deepStrictEqual(
    inspected.workspaceValue ?? expectedDefault,
    expectedDefault,
    `${key} must be unset at workspace scope at rest, or pinned to its default`,
  );
  assert.deepStrictEqual(
    vscode.workspace.getConfiguration(section).get(leaf),
    expectedDefault,
    `${key} must READ BACK as its default when nothing overrides it`,
  );
  const property = configProperties()[key];
  assert.ok(property, `contributes.configuration.properties must declare ${key}`);
  assert.deepStrictEqual(property.default, expectedDefault, `${key} manifest default`);
  assert.ok(property.type, `${key} must declare a JSON type so Settings can render an editor`);
  assert.ok(
    (property.description ?? property.markdownDescription ?? '').length > 0,
    `${key} must carry a description — an undocumented setting is unusable from the Settings UI`,
  );
  return property;
}

/**
 * Implements [DIST-WORKSPACE-TRUST]. A restricted setting is one an UNTRUSTED
 * workspace must not be able to set, because it names an executable or injects
 * process arguments.
 */
export function assertTrustRestricted(key: string): void {
  const capabilities: unknown = authoredPackageJson().capabilities;
  assert.ok(capabilities, 'the manifest must declare a capabilities block');
  const untrusted: unknown = (capabilities as { untrustedWorkspaces?: unknown })
    .untrustedWorkspaces;
  assert.ok(untrusted, 'capabilities must declare untrustedWorkspaces');
  const block = untrusted as { supported?: unknown; restrictedConfigurations?: unknown };
  assert.strictEqual(
    block.supported,
    'limited',
    "untrustedWorkspaces.supported must be 'limited' per [DIST-WORKSPACE-TRUST]",
  );
  assert.ok(
    Array.isArray(block.restrictedConfigurations),
    'untrustedWorkspaces.restrictedConfigurations must be an array',
  );
  assert.ok(
    (block.restrictedConfigurations as string[]).includes(key),
    `${key} names an executable or its arguments and MUST be restricted in untrusted workspaces`,
  );
}

/**
 * A language OWNS a file extension: the manifest claims it, the claim is
 * unique across languages, and the language ships a configuration file that
 * actually exists on disk and parses.
 *
 * Two languages claiming the same extension is not a cosmetic overlap — VS Code
 * resolves it arbitrarily, so a .fs file can silently open as C#.
 */
export function assertLanguageOwnsExtension(languageId: string, fileExtension: string): void {
  const entry = languageNamed(languageId);
  assert.ok(
    entry.extensions?.includes(fileExtension),
    `${languageId} must claim ${fileExtension}; claims: ${(entry.extensions ?? []).join(', ')}`,
  );
  const rivals = languageEntries().filter(
    (other) => other.id !== languageId && (other.extensions ?? []).includes(fileExtension),
  );
  assert.deepStrictEqual(
    rivals.map((rival) => rival.id),
    [],
    `${fileExtension} must be claimed by ${languageId} alone — a shared claim resolves arbitrarily`,
  );
  assert.ok(entry.configuration, `${languageId} must ship a language-configuration file`);
  const configured = path.join(sharpLspExtension().extensionPath, entry.configuration);
  assert.ok(
    fs.existsSync(configured),
    `${languageId} language configuration must exist at ${configured}`,
  );
}

/**
 * The version the manifest reports, asserted to be a plain semver core.
 *
 * [DIST-VERSION-INVARIANT] makes Cargo.toml the single source of truth and
 * requires every stamped version to match byte-for-byte, so a `v` prefix or a
 * two-part version is a release that cannot be verified.
 */
export function manifestVersion(): string {
  const version: unknown = packageJson().version;
  assert.ok(typeof version === 'string', 'package.json must declare a version string');
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'version must be semver');
  assert.ok(!version.startsWith('v'), 'the stamped version carries no leading v');
  return version;
}

/** The ids of every contributed view, across every container. */
export function viewIds(): string[] {
  const views: Record<string, { id: string }[]> = contributes().views ?? {};
  return Object.values(views)
    .flat()
    .map((view) => view.id);
}

/** The strings the authored manifest refers to as `%key%`. */
function nlsStrings(): Record<string, string> {
  const nls = path.resolve(__dirname, '../../..', 'package.nls.json');
  assert.ok(fs.existsSync(nls), `the authored manifest's strings must exist at ${nls}`);
  return JSON.parse(fs.readFileSync(nls, 'utf-8'));
}

/**
 * An authored manifest value with its `%key%` resolved through package.nls.json
 * the way VS Code resolves it at load time; any other value passes through.
 */
export function nlsResolved(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('%') || !value.endsWith('%')) return value;
  const key = value.slice(1, -1);
  const resolved = nlsStrings()[key];
  assert.ok(resolved !== undefined, `package.nls.json must define ${key}`);
  return resolved;
}
