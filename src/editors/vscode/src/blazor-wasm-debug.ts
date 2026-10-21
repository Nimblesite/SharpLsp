// Blazor WebAssembly launch resolution: everything a `sharplsp-blazorwasm` launch
// decides that never touches a process.
//
// Implements [DEBUG-FEATURES-LAUNCH-BLAZOR-WASM].
//
// A Blazor WebAssembly app is served by `Microsoft.AspNetCore.Components.WebAssembly
// .DevServer` (or `app.UseWebAssemblyDebugging()`), which exposes the .NET debug proxy
// at `/_framework/debug/ws-proxy`. VS Code's built-in JavaScript debugger reaches .NET
// breakpoints through that proxy when it is handed an `inspectUri`, so this tier's whole
// job is to turn a launch configuration into the `pwa-chrome`/`pwa-msedge` one js-debug
// understands. Process control lives in blazor-wasm-launch.ts.
import * as fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import type * as vscode from 'vscode';
import {
  directoryOf,
  extensionOf,
  fileNameOf,
  isAbsolutePath,
  joinPath,
  resolvePath,
} from './paths';
import { resolveLaunchTarget } from './launch-resolver';
import { projectProfiles, readProfiles, type LaunchProfile } from './launch-profiles';
import { err, ok, type Result } from './result';
import { isRecord } from './utils';

/** The name a launch that states none is listed under. */
export const DEFAULT_LAUNCH_NAME = 'Launch Blazor WebAssembly';

/** The debug type this extension contributes for Blazor WebAssembly. */
export const BLAZOR_WASM_DEBUG_TYPE = 'sharplsp-blazorwasm';

/** The SDK a standalone Blazor WebAssembly project names on its `Project` element. */
export const BLAZOR_WASM_SDK = 'Microsoft.NET.Sdk.BlazorWebAssembly';

/** The browsers js-debug ships a debug type for. */
export type BlazorWasmBrowser = 'chrome' | 'edge';

/** Chromium: the browser a `blazorwasm` template profile is written for. */
export const DEFAULT_BLAZOR_WASM_BROWSER: BlazorWasmBrowser = 'chrome';

/**
 * The `inspectUri` the `blazorwasm` template writes into `launchSettings.json`.
 *
 * A launch profile that states none still has to be debuggable, so this is the
 * fallback. `{browserInspectUri}` is deliberately LEFT in place: js-debug
 * substitutes it with the address of the browser tab it opened, which is
 * information only it has.
 */
export const DEFAULT_INSPECT_URI =
  '{wsProtocol}://{url.hostname}:{url.port}/_framework/debug/ws-proxy?browser={browserInspectUri}';

/** How long js-debug waits for the page before it gives up. */
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;

/** The two `contributes.debuggers` labels the browsers map onto. */
const BROWSER_DEBUG_TYPES: Readonly<Record<BlazorWasmBrowser, string>> = {
  chrome: 'pwa-chrome',
  edge: 'pwa-msedge',
};

/** The prefix the ASP.NET Core host logs a bound address behind. */
const LISTENING_PREFIX = 'Now listening on:';

/** The tokens a launch profile's `inspectUri` carries. */
const WS_PROTOCOL_TOKEN = '{wsProtocol}';
const HOSTNAME_TOKEN = '{url.hostname}';
const PORT_TOKEN = '{url.port}';

/** Attributes are read with an `@_` prefix, the spelling dependencies.ts uses. */
const ATTRIBUTE_PREFIX = '@_';

/** One parser for every project file this module reads. */
const projectParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
});

/**
 * A browser name from user input, defaulting to Chromium.
 *
 * `browser` arrives from a hand-written `launch.json`, so it can be absent or
 * misspelled; an unknown value MUST NOT refuse the launch, because the only
 * thing a wrong browser name changes is which of two identical debug types is
 * started.
 */
export function browserOf(value: unknown): BlazorWasmBrowser {
  return typeof value === 'string' && value.trim().toLowerCase() === 'edge' ? 'edge' : 'chrome';
}

/** The js-debug type that drives `browser`. */
export function browserDebugType(browser: BlazorWasmBrowser): string {
  return BROWSER_DEBUG_TYPES[browser];
}

/** A URL from process output, or undefined when the text is not one. */
function httpUrlOf(token: string): string | undefined {
  try {
    const parsed = new URL(token);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The first space-delimited token of `text`. */
function firstToken(text: string): string {
  const end = text.indexOf(' ');
  return end === -1 ? text : text.slice(0, end);
}

/**
 * The URL a `Now listening on: <url>` line announces.
 *
 * `dotnet run` interleaves that line with build output, restore warnings and
 * the SDK's telemetry notice, so the line is found by its prefix and the URL by
 * parsing the token after it — text that merely *contains* a URL is not an
 * announcement, which is what keeps `Content root path:` and the dev
 * certificate warning out of the answer.
 */
export function listeningUrlOf(line: string): string | undefined {
  const trimmed = line.trim();
  const at = trimmed.indexOf(LISTENING_PREFIX);
  if (at === -1) return undefined;
  return httpUrlOf(firstToken(trimmed.slice(at + LISTENING_PREFIX.length).trim()));
}

/** Every URL announced in a whole block of output, in order. */
export function listeningUrlsOf(output: string): string[] {
  return output.split('\n').flatMap((line) => {
    const url = listeningUrlOf(line);
    return url === undefined ? [] : [url];
  });
}

/** Output split into whole lines, plus the unfinished tail of the last one. */
export interface LineBuffer {
  /** The tail of a line whose newline has not arrived yet. */
  readonly pending: string;
  /** The lines completed by the chunk. */
  readonly lines: readonly string[];
}

/**
 * Split one output chunk into whole lines.
 *
 * A child's output arrives in arbitrary chunks, so `Now listening on:` lands
 * split across two of them often enough to matter; keeping the tail makes the
 * announcement findable wherever the pipe happened to cut it.
 */
export function takeLines(pending: string, chunk: string): LineBuffer {
  const parts = `${pending}${chunk}`.split('\n');
  const tail = parts.pop() ?? '';
  return { pending: tail, lines: parts };
}

/**
 * `pattern` with the host, port and socket protocol of `appUrl` filled in.
 *
 * `{browserInspectUri}` is left alone: js-debug owns it. An unparseable
 * `appUrl` leaves the pattern untouched rather than producing a half-expanded
 * URL the browser would refuse to load.
 */
export function expandInspectUri(pattern: string, appUrl: string): string {
  const parsed = urlOf(appUrl);
  if (parsed === undefined) return pattern;
  return pattern
    .replaceAll(WS_PROTOCOL_TOKEN, parsed.protocol === 'https:' ? 'wss' : 'ws')
    .replaceAll(HOSTNAME_TOKEN, parsed.hostname)
    .replaceAll(PORT_TOKEN, parsed.port);
}

/** `value` as a URL, or undefined when it is not one. */
function urlOf(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** The `inspectUri` for a launch: the profile's own, or the template's default. */
export function inspectUriFor(pattern: string | undefined, appUrl: string): string {
  const usable =
    pattern === undefined || pattern.trim().length === 0 ? DEFAULT_INSPECT_URI : pattern;
  return expandInspectUri(usable, appUrl);
}

/** Everything the browser session needs, once the app is listening. */
export interface BrowserSessionOptions {
  /** The configuration name the session is listed under. */
  readonly name: string;
  /** The URL to open. */
  readonly url: string;
  /** The .NET debug proxy URL, already expanded. */
  readonly inspectUri: string;
  readonly browser: BlazorWasmBrowser;
  /** Where js-debug maps served URLs back onto source files. */
  readonly webRoot: string;
  /** js-debug's own wait for the page. */
  readonly timeout: number;
}

/**
 * The js-debug launch configuration a Blazor WebAssembly session is handed to.
 *
 * `inspectUri` is the whole bridge: without it js-debug attaches to the browser
 * only, and every .NET breakpoint in a `.razor` file or a C# class silently
 * never binds.
 */
export function browserConfiguration(options: BrowserSessionOptions): vscode.DebugConfiguration {
  return {
    type: browserDebugType(options.browser),
    request: 'launch',
    name: options.name,
    url: options.url,
    inspectUri: options.inspectUri,
    webRoot: options.webRoot,
    timeout: options.timeout,
  };
}

/** The `wwwroot` directory a Blazor WebAssembly project serves from. */
export function webRootOf(projectFile: string): string {
  return joinPath(directoryOf(projectFile), 'wwwroot');
}

/** The `dotnet run` arguments for `projectFile`, without a shell in between. */
export function runArguments(
  projectFile: string,
  launchProfile: string | undefined,
): readonly string[] {
  const named = launchProfile === undefined ? '' : launchProfile.trim();
  const args = ['run', '--project', projectFile];
  return named.length === 0 ? args : [...args, '--launch-profile', named];
}

/**
 * The launch profile a launch runs under.
 *
 * The profile is named when the configuration says so; otherwise the project's
 * SOLE `Project` profile applies, exactly as [DEBUG-FEATURES-LAUNCH-PROFILES]
 * makes it apply to every other launch. Several profiles and no name is not an
 * ambiguity to guess at here: the dev server announces whatever URL it binds,
 * so the launch still works, it just carries no `inspectUri` of its own.
 */
export function launchProfileOf(
  projectFile: string,
  named: string | undefined,
): LaunchProfile | undefined {
  const eligible = projectProfiles(readProfiles(projectFile));
  if (named === undefined || named.trim().length === 0) {
    return eligible.length === 1 ? eligible[0] : undefined;
  }
  return eligible.find((profile) => profile.name === named);
}

/** SDK names an MSBuild `Project` element declares, in order. */
function sdkNamesOf(element: unknown): string[] {
  const sdk = isRecord(element) ? element[`${ATTRIBUTE_PREFIX}Sdk`] : undefined;
  return typeof sdk === 'string' ? sdk.split(';') : [];
}

/** True when `element` is a `Project` carrying the Blazor WebAssembly SDK. */
function isWebAssemblySdk(element: unknown): boolean {
  return sdkNamesOf(element).some(
    (name) => name.trim().toLowerCase() === BLAZOR_WASM_SDK.toLowerCase(),
  );
}

/**
 * True when project XML declares `Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"`.
 *
 * Read through a real XML parser, never by matching text: a commented-out
 * `<Project Sdk=…>` element, an `<Sdk>` item inside an `ItemGroup` and a
 * property whose VALUE happens to name the SDK all look identical to a string
 * search and are three different facts.
 */
export function isBlazorWasmProject(xml: string): boolean {
  if (xml.trim().length === 0) return false;
  try {
    const parsed: unknown = projectParser.parse(xml);
    const project = isRecord(parsed) ? parsed.Project : undefined;
    const elements = Array.isArray(project) ? project : [project];
    return elements.some(isWebAssemblySdk);
  } catch {
    return false;
  }
}

/** True when the project file on disk is a Blazor WebAssembly project. */
export function isBlazorWasmProjectFile(file: string): boolean {
  try {
    return isBlazorWasmProject(fs.readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }
}

/** The Blazor WebAssembly projects among `files`, keeping their order. */
export function blazorWasmProjects(files: readonly string[]): string[] {
  return files.filter(isBlazorWasmProjectFile);
}

/** The name a generated configuration carries for `projectFile`. */
export function configurationName(projectFile: string): string {
  return `Blazor WebAssembly: ${fileNameOf(projectFile, extensionOf(projectFile))}`;
}

/** One generated configuration, carrying nothing but what a user must choose. */
export function blazorWasmConfiguration(projectFile: string): vscode.DebugConfiguration {
  return {
    type: BLAZOR_WASM_DEBUG_TYPE,
    request: 'launch',
    name: configurationName(projectFile),
    project: projectFile,
    browser: DEFAULT_BLAZOR_WASM_BROWSER,
  };
}

/** One configuration per Blazor WebAssembly project, without prompting. */
export function blazorWasmConfigurations(files: readonly string[]): vscode.DebugConfiguration[] {
  return blazorWasmProjects(files).map(blazorWasmConfiguration);
}

/**
 * How long the app gets to announce a listening URL.
 *
 * A cold `dotnet run` restores and builds before it binds, which on a first run
 * with an empty package cache takes far longer than the bind itself; the wait is
 * generous for that reason and still bounded, so a project that never serves
 * reports itself instead of leaving a session open on nothing.
 */
export const STARTUP_TIMEOUT_MS = 180_000;

/** How a launch's startup ended. */
export type Startup =
  | { readonly kind: 'listening'; readonly url: string }
  | { readonly kind: 'exited'; readonly outcome: Result<void> }
  | { readonly kind: 'timeout' };

/** Everything one launch needs, once the project is known. */
export interface BlazorWasmRequest {
  readonly projectFile: string;
  readonly launchProfile: LaunchProfile | undefined;
  readonly browser: BlazorWasmBrowser;
  readonly url: string | undefined;
  readonly webRoot: string;
  readonly name: string;
  readonly timeout: number;
}

/** Why a launch has no project to run, in the words of a user. */
const NO_PROJECT_MESSAGE =
  'Blazor WebAssembly launch found no runnable project for this workspace.';
const NOT_A_PROJECT_MESSAGE =
  'Blazor WebAssembly launches need a .csproj/.fsproj project, not a script or a single file.';

/** A `string` field of the configuration, or undefined when absent or empty. */
export function stringField(config: vscode.DebugConfiguration, key: string): string | undefined {
  const value: unknown = config[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** A positive `number` field of the configuration, or undefined. */
export function numberField(config: vscode.DebugConfiguration, key: string): number | undefined {
  const value: unknown = config[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The project a configuration names, or the one the workspace resolves to.
 *
 * A stated `project` is the user's decision and is used as given; only a
 * MISSING one consults the resolver every other launch surface shares
 * ([DEBUG-FEATURES-LAUNCH-TARGET]).
 */
export async function resolveProject(
  folder: vscode.WorkspaceFolder | undefined,
  stated: unknown,
): Promise<Result<string>> {
  const root = folder?.uri.fsPath;
  const named = typeof stated === 'string' ? stated.trim() : '';
  if (named.length > 0) return projectAt(root, named);
  if (folder === undefined) return err(NO_PROJECT_MESSAGE);
  const resolved = await resolveLaunchTarget(undefined, folder);
  if (!resolved.ok)
    return err(resolved.error.trim().length === 0 ? NO_PROJECT_MESSAGE : resolved.error);
  if (resolved.value.kind !== 'project') return err(NOT_A_PROJECT_MESSAGE);
  return ok(resolved.value.projectFile);
}

/** `named` as an existing project path, resolved against `root` when relative. */
export function projectAt(root: string | undefined, named: string): Result<string> {
  if (root === undefined && !isAbsolutePath(named)) {
    return err(`Cannot resolve '${named}' without a workspace folder.`);
  }
  const file = isAbsolutePath(named) || root === undefined ? named : resolvePath(root, named);
  return fs.existsSync(file) ? ok(file) : err(`Blazor WebAssembly project not found: ${file}`);
}

/** The request a configuration describes, or why it cannot be launched. */
export async function requestOf(
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
): Promise<Result<BlazorWasmRequest>> {
  const project = await resolveProject(folder, config.project);
  if (!project.ok) return project;
  const named = stringField(config, 'launchProfile');
  const profile = launchProfileOf(project.value, named);
  if (named !== undefined && profile === undefined) {
    return err(
      `Launch profile '${named}' is not declared by ${fileNameOf(project.value)}. ` +
        'Add it to Properties/launchSettings.json, or omit launchProfile.',
    );
  }
  return ok({
    projectFile: project.value,
    launchProfile: profile,
    browser: browserOf(config.browser),
    url: stringField(config, 'url'),
    webRoot: stringField(config, 'webRoot') ?? webRootOf(project.value),
    name: stringField(config, 'name') ?? DEFAULT_LAUNCH_NAME,
    timeout: numberField(config, 'timeout') ?? DEFAULT_BROWSER_TIMEOUT_MS,
  });
}

/** The sentence a startup that never announced an address earns. */
export function startupFailure(outcome: Startup, projectFile: string): string {
  const named = fileNameOf(projectFile);
  if (outcome.kind === 'timeout') {
    return (
      `dotnet run for ${named} announced no listening URL within ` +
      `${String(STARTUP_TIMEOUT_MS / 1000)}s. Check that the project is a Blazor ` +
      'WebAssembly app and that Properties/launchSettings.json binds a URL.'
    );
  }
  if (outcome.kind === 'exited' && !outcome.outcome.ok) {
    return `dotnet run for ${named} stopped before it served anything: ${outcome.outcome.error}`;
  }
  return `dotnet run for ${named} exited before it announced a listening URL.`;
}
