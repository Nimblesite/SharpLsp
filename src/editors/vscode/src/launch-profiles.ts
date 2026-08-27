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
  return isRecord(value) && isRecord(value['profiles']);
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
  const entries = Object.entries(value).filter(([, item]) => typeof item === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : undefined;
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
 * Profiles for a target. A candidate that exists but is not a profiles document
 * must not abort the scan — the next candidate is still tried.
 */
export function readProfiles(target: string): LaunchProfile[] {
  const found: LaunchProfile[] = [];
  for (const candidate of profileCandidates(target)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      found.push(...parseProfiles(fs.readFileSync(candidate, 'utf-8')));
    } catch {
      // Unreadable candidate — keep scanning.
    }
  }
  return found;
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
