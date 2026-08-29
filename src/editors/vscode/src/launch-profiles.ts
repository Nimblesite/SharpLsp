// Reading launch profiles for a resolved target.
//
// Implements [DEBUG-FEATURES-LAUNCH-PROFILES].
//
// Three defects this replaces: the old type guard accepted `{"profiles": null}`
// (only the KEY was checked) and threw downstream in `Object.entries`; the
// candidate list held the workspace root twice and never looked at the resolved
// project, so the near-universal `src/App/App.csproj` layout found nothing; and
// `commandLineArgs.split(' ')` shredded every quoted argument.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isIgnoredDir } from './launch-target';

/** One entry of a `launchSettings.json` / `<app>.run.json` profiles map. */
export interface LaunchProfile {
  readonly name: string;
  readonly commandName: string;
  readonly commandLineArgs?: string;
  readonly environmentVariables?: Readonly<Record<string, string>>;
  readonly applicationUrl?: string;
}

/** ASP.NET reads its listening URLs from this variable. */
const URLS_VARIABLE = 'ASPNETCORE_URLS';

/** Only `Project` profiles describe launching the project itself. */
const PROJECT_COMMAND = 'Project';

/** A plain, non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sound type guard for a launch-settings document.
 *
 * Checking only that a `profiles` KEY exists admits `{"profiles": null}`,
 * `{"profiles": "text"}` and `{"profiles": [1,2]}`; each then throws in
 * `Object.entries` or on a property read, inside `resolveDebugConfiguration`,
 * which aborts F5.
 */
export function isLaunchSettings(value: unknown): value is { profiles: Record<string, unknown> } {
  return isRecord(value) && isRecord(value.profiles);
}

/** A string property, or undefined when absent or the wrong type. */
function stringOf(bag: Record<string, unknown>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === 'string' ? value : undefined;
}

/** An all-string record property, or undefined. */
function envOf(bag: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = bag[key];
  if (!isRecord(value)) return undefined;
  const strings: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string') strings[name] = item;
  }
  return Object.keys(strings).length > 0 ? strings : undefined;
}

/** Build a profile from one entry, ignoring anything malformed. */
function toProfile(name: string, raw: unknown): LaunchProfile | undefined {
  if (!isRecord(raw)) return undefined;
  const commandName = stringOf(raw, 'commandName') ?? '';
  const profile: LaunchProfile = {
    name,
    commandName,
    ...optional('commandLineArgs', stringOf(raw, 'commandLineArgs')),
    ...optional('applicationUrl', stringOf(raw, 'applicationUrl')),
    ...optional('environmentVariables', envOf(raw, 'environmentVariables')),
  };
  return profile;
}

/** Spread helper: omit the key entirely when the value is undefined. */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** Parse a profiles document; any malformed input yields an empty list. */
export function parseProfiles(text: string): LaunchProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isLaunchSettings(parsed)) return [];
  return Object.entries(parsed.profiles)
    .map(([name, raw]) => toProfile(name, raw))
    .filter((profile): profile is LaunchProfile => profile !== undefined);
}

/**
 * Candidate profile files for a target, most specific first.
 *
 * A project's profiles live beside the PROJECT, not at the workspace root; a
 * file-based app has no `Properties/` directory and uses a sibling
 * `<entry>.run.json` instead.
 */
export function profileCandidates(target: string): string[] {
  const directory = path.dirname(target);
  const stem = path.basename(target, path.extname(target));
  return [
    path.join(directory, 'Properties', 'launchSettings.json'),
    path.join(directory, `${stem}.run.json`),
  ];
}

/**
 * Profiles held by ONE candidate document.
 *
 * Total by construction: a missing file, a directory sitting where the file
 * should be, and an unreadable or unsound document all yield no profiles rather
 * than throwing. `readFileSync` already distinguishes those cases for us, so an
 * `existsSync` pre-check would only add a race without removing the `catch`.
 */
function readProfileDocument(file: string): LaunchProfile[] {
  try {
    return parseProfiles(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Profiles for a target. A candidate that exists but is not a profiles document
 * must not abort the scan — the next candidate is still tried.
 */
export function readProfiles(target: string): LaunchProfile[] {
  return profileCandidates(target).flatMap(readProfileDocument);
}

/** Profiles eligible for launching the project itself. */
export function projectProfiles(profiles: readonly LaunchProfile[]): LaunchProfile[] {
  return profiles.filter((profile) => profile.commandName === PROJECT_COMMAND);
}

/** Tokenizer states for {@link tokenizeArgs}. */
type QuoteState = 'bare' | 'single' | 'double';

/**
 * Split a `commandLineArgs` string into argv.
 *
 * A character-by-character state machine, not a split or a regex: `--name "John
 * Smith"` is THREE broken tokens with embedded quote characters under
 * `split(' ')`, so any profile whose arguments contain a path with a space
 * launches the program with the wrong `argv`.
 */
export function tokenizeArgs(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let state: QuoteState = 'bare';
  let escaped = false;

  for (const character of commandLine) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && state !== 'single') {
      escaped = true;
      started = true;
      continue;
    }
    if (state === 'bare' && (character === '"' || character === "'")) {
      state = character === '"' ? 'double' : 'single';
      started = true;
      continue;
    }
    if ((state === 'double' && character === '"') || (state === 'single' && character === "'")) {
      state = 'bare';
      continue;
    }
    if (state === 'bare' && (character === ' ' || character === '\t')) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The `args` a profile contributes, or undefined when it contributes none. */
export function profileArgs(profile: LaunchProfile): string[] | undefined {
  const commandLine = profile.commandLineArgs ?? '';
  if (commandLine.trim().length === 0) return undefined;
  return tokenizeArgs(commandLine);
}

/**
 * The `env` a profile contributes: its own variables plus `applicationUrl`
 * mapped verbatim onto ASPNETCORE_URLS, including the `;`-separated multi-URL
 * form. An explicit variable in the profile wins over the derived one.
 */
export function profileEnv(profile: LaunchProfile): Record<string, string> | undefined {
  const declared = profile.environmentVariables ?? {};
  const url = profile.applicationUrl;
  const merged: Record<string, string> =
    url !== undefined && url.length > 0 ? { [URLS_VARIABLE]: url, ...declared } : { ...declared };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Profiles under `rootPath`, keyed by name.
 *
 * Scans the directory itself AND one level of subdirectories that hold a
 * project. The canonical .NET layout puts the solution at the root and the
 * profiles at `src/App/Properties/launchSettings.json`, so a scan of the root
 * alone silently drops every environment variable, argument and URL the
 * developer configured.
 */
export function readLaunchProfiles(rootPath: string): Record<string, LaunchProfile> {
  const found: Record<string, LaunchProfile> = {};
  for (const document of profileDocuments(rootPath)) {
    for (const profile of readProfileDocument(document)) {
      found[profile.name] ??= profile;
    }
  }
  return found;
}

/**
 * Every candidate profile DOCUMENT at or beneath `rootPath`, bounded in depth.
 *
 * Keyed on the documents themselves rather than on the project files that own
 * them. Deriving candidates from discovered `.csproj`/`.fsproj` files made two
 * whole layouts invisible: a directory holding `Properties/launchSettings.json`
 * with no project beside it, and a file-based app, which by definition has no
 * project at all and keeps its profiles in a sibling `<entry>.run.json`.
 *
 * The canonical .NET layout is `MySln.sln` at the root with the projects under
 * `src/App/App.csproj`, so a scan that stops at the first level still finds
 * nothing. The depth bound keeps a large repository from being walked whole.
 */
function profileDocuments(rootPath: string, depth = PROFILE_SCAN_DEPTH): string[] {
  const documents = [path.join(rootPath, 'Properties', 'launchSettings.json')];
  for (const entry of safeEntries(rootPath)) {
    const child = path.join(rootPath, entry);
    if (isRunJson(entry)) documents.push(child);
    else if (depth > 0 && isDirectory(child) && !isIgnoredDir(entry)) {
      documents.push(...profileDocuments(child, depth - 1));
    }
  }
  return documents;
}

/** A file-based app's profiles live in `<entry>.run.json` beside the entry. */
function isRunJson(name: string): boolean {
  return name.toLowerCase().endsWith('.run.json');
}

/** Deep enough for `root/src/App/App.csproj`, shallow enough to stay cheap. */
const PROFILE_SCAN_DEPTH = 3;

function safeEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Apply the single eligible `Project` profile under `rootPath` onto `config`.
 *
 * Fields the caller already set always win: a launch.json that states `env` or
 * `args` is the user's explicit choice and a profile must not clobber it.
 */
export function applyLaunchProfile(rootPath: string, config: Record<string, unknown>): void {
  const profile = projectProfiles(Object.values(readLaunchProfiles(rootPath)))[0];
  if (profile === undefined) return;
  const args = profileArgs(profile);
  if (args !== undefined && config.args === undefined) config.args = args;
  const env = profileEnv(profile);
  if (env !== undefined) config.env = mergeProfileEnv(env, config.env);
}

/**
 * Profile variables underneath whatever the configuration already stated.
 *
 * Per-KEY, not all-or-nothing: a launch.json that pins one variable is an
 * explicit choice about THAT variable, and dropping the profile's other
 * variables because of it silently changes how the program runs.
 */
export function mergeProfileEnv(
  fromProfile: Record<string, string>,
  existing: unknown,
): Record<string, string> {
  const merged: Record<string, string> = { ...fromProfile };
  if (!isRecord(existing)) return merged;
  for (const [key, value] of Object.entries(existing)) {
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}
