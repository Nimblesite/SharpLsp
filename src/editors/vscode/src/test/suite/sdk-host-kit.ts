import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as dotnetRoots from '../../dotnet-roots.js';
import { candidateDotnetRoots, dotnetExecutable } from '../../dotnet-roots.js';
import { installedSdkVersions, parseSdkVersion } from '../../global-json.js';
import { SETTLE_MS } from './test-timeouts.js';

// Implements [DIST-RUNTIME-ACQUIRE]. Copy real installations, never empty SDK directories.

export type Language = 'CSharp' | 'FSharp';

/**
 * What hostfxr returns when the root ships no framework the app can use.
 *
 * ONE condition, two encodings. The host fails with `FrameworkMissingFailure`,
 * `0x80008096`. POSIX truncates a process exit status to its low byte, so it
 * arrives as 150 — `0x96` — while Windows preserves the whole 32-bit value and
 * reports 2147516566. Asserting a bare 150 everywhere therefore passed on
 * Ubuntu and failed on Windows against a host that had done exactly the right
 * thing, and said so on stderr while doing it (#297 CI).
 */
export const FRAMEWORK_MISSING_EXIT = process.platform === 'win32' ? 0x8000_8096 : 150;

/** What it prints while exiting that way, on either platform. */
export const FRAMEWORK_MISSING_MESSAGE = 'You must install or update .NET';

/** Where hostfxr looks for shared frameworks, relative to a root. */
export const FRAMEWORK = path.join('shared', 'Microsoft.NETCore.App');

const FXR = path.join('host', 'fxr');

/** Directory names under one component of a root, or nothing when unreadable. */
export function namesUnder(root: string, component: string): string[] {
  try {
    return fs.readdirSync(path.join(root, component));
  } catch {
    return [];
  }
}

export const realSdks = (root: string): string[] => namesUnder(root, 'sdk');
export const realRuntimes = (root: string): string[] => namesUnder(root, FRAMEWORK);

/** Ordering key for a version directory name; anything unparsable sorts below all. */
function order(version: string): readonly number[] {
  const parsed = parseSdkVersion(version);
  if (parsed === undefined) return [-1, -1, -1, -1];
  return [parsed.major, parsed.minor, parsed.band, parsed.patch];
}

/** A release, as opposed to a prerelease of the same number, which sorts below it. */
function isRelease(version: string): boolean {
  return !(version.split('+')[0] ?? '').includes('-');
}

function newerThan(left: string, right: string): boolean {
  const a = order(left);
  const b = order(right);
  const at = a.findIndex((value, index) => value !== b[index]);
  if (at >= 0) return a[at]! > (b[at] ?? -1);
  return isRelease(left) && !isRelease(right);
}

/**
 * The newest installed directory whose name starts with `prefix`.
 *
 * These names are VERSIONS, so they are ordered numerically. A lexicographic
 * `sort()` ranks `9.0.9` above `9.0.14` and `10.0.99` above `10.0.100`, which
 * stages an SDK older than the one the machine really has newest. Nothing
 * fails when it does — the fixture is still a real installation — so the suite
 * silently stops copying the install it says it copies.
 */
export function newestVersion(names: readonly string[], prefix: string): string | undefined {
  return names
    .filter((name) => name.startsWith(prefix))
    .reduce<string | undefined>(
      (best, name) => (best === undefined || newerThan(name, best) ? name : best),
      undefined,
    );
}

export function sdkSource(major: number): string {
  const prefix = `${String(major)}.`;
  const root = candidateDotnetRoots().find((candidate) =>
    installedSdkVersions(dotnetExecutable(candidate)).some((sdk) => sdk.startsWith(prefix)),
  );
  assert.ok(root, `SDK ${String(major)} must be installed (CI provisions SDKs 9 and 10)`);
  return root;
}

/**
 * A real installed root carrying a real >= 10 runtime: the source of the muxer,
 * hostfxr and the runtime bits every composed fixture needs to genuinely launch.
 */
export function realSource(): string {
  const found = candidateDotnetRoots().find((root) =>
    realRuntimes(root).some((version) => version.startsWith('10.')),
  );
  assert.ok(found, 'a real .NET 10 runtime is required to compose hosts that really start');
  return found;
}

const CLONE = { recursive: true, mode: fs.constants.COPYFILE_FICLONE } as const;

export function cloneInto(source: string, relative: string, target: string): void {
  fs.cpSync(path.join(source, relative), target, CLONE);
}

/**
 * `cloneInto` without holding the event loop. The suites run INSIDE the extension
 * host, so a synchronous copy freezes it: VS Code flags it unresponsive and mocha
 * cannot fire the timeout that would have named the hook (Windows `workspace`).
 */
async function cloneAsync(source: string, relative: string, target: string): Promise<void> {
  await fs.promises.cp(path.join(source, relative), target, CLONE);
}

/**
 * A launchable root carrying ONE real SDK, hostfxr and runtime of `major`.
 *
 * Exactly one version per component, never every installed one. `fs.cpSync` is
 * synchronous, so copying every 9.x and 10.x an agent ships blocks the event
 * loop for minutes and mocha cannot fire its own timeout until it returns: the
 * hook reported `Timeout of 120000ms exceeded` after sixteen minutes of wall
 * clock, by which point the whole chunk had been killed and no failure was ever
 * printed (#297 CI, Windows `workspace`).
 */
export function copySdkMajor(source: string, target: string, major: number): string {
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(dotnetExecutable(source), dotnetExecutable(target));
  for (const component of ['sdk', FXR, FRAMEWORK]) {
    const version = newestVersion(namesUnder(source, component), `${String(major)}.`);
    assert.ok(version, `${component} must supply .NET ${String(major)}`);
    cloneInto(source, path.join(component, version), path.join(target, component, version));
  }
  return dotnetExecutable(target);
}

/** Every hostfxr the source ships: the muxer picks the newest it can find. */
async function copyFxr(source: string, root: string): Promise<void> {
  const versions = namesUnder(source, FXR).map((version) => path.join(FXR, version));
  await Promise.all(versions.map((fxr) => cloneAsync(source, fxr, path.join(root, fxr))));
}

/** Real runtime bits, advertised under the version name being tested. */
async function copyRuntime(source: string, root: string, advertised: string): Promise<void> {
  const real = newestVersion(realRuntimes(source), '10.') ?? realRuntimes(source)[0];
  assert.ok(real, 'the source install must carry a real runtime to compose from');
  await cloneAsync(source, path.join(FRAMEWORK, real), path.join(root, FRAMEWORK, advertised));
}

/** Where the machine's newest real SDK of `major` lives: its root and its `sdk/<version>`. */
function realSdk(major: number): { source: string; relative: string } {
  const source = sdkSource(major);
  const real = newestVersion(realSdks(source), `${String(major)}.`);
  assert.ok(real, `SDK ${String(major)} must be a real installed directory, never composed`);
  return { source, relative: path.join('sdk', real) };
}

/**
 * Give the root a REAL SDK of `major`, copied from wherever one really is.
 *
 * Nothing here is ever fabricated by name. `installedSdkVersions` reads
 * directory names, so an empty directory would satisfy every predicate under
 * test while proving nothing about a machine that could really build — the
 * suite would keep passing and quietly stop meaning what it says. A missing
 * SDK is a fixture prerequisite, and `sdkSource` fails the test saying so.
 *
 * SDK majors live in different roots on an ordinary machine — here `~/.dotnet`
 * carries 10.0.100 and 10.0.303 with no 9.x, while `/usr/local/share/dotnet`
 * carries 9.0.312 — so each major is sourced independently.
 */
export function stageSdk(root: string, major: number): void {
  const { source, relative } = realSdk(major);
  const sibling = siblingCopy(root, relative);
  if (sibling === undefined) cloneInto(source, relative, path.join(root, relative));
  else linkTree(sibling, path.join(root, relative));
}

/**
 * The copy of `relative` a root composed beside `root` already holds. Seven roots
 * share two SDKs, and on an agent without reflinks copying each SDK again took the
 * floor suite's setup past its budget (Windows `workspace`).
 */
function siblingCopy(root: string, relative: string): string | undefined {
  const scratch = path.dirname(root);
  return fs
    .readdirSync(scratch)
    .map((name) => path.join(scratch, name, relative))
    .find((copy) => copy !== path.join(root, relative) && fs.existsSync(copy));
}

/**
 * `from` rebuilt at `to` from hard links: the same real bits at a third of a copy's
 * cost. Only a copy this scratch owns is ever linked, so no test can write through a
 * link into the machine's own install.
 */
function linkTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const [source, target] = [path.join(from, entry.name), path.join(to, entry.name)];
    if (entry.isDirectory()) linkTree(source, target);
    else fs.linkSync(source, target);
  }
}

/** Where a scratch keeps the one real SDK copy per major that its roots link. */
const SDK_STORE = 'sdk-store';

/** One copy per scratch and SDK, however many roots composed in parallel ask for it. */
const storedSdks = new Map<string, Promise<string>>();

/**
 * The scratch's OWN copy of the machine's real SDK of `major`, made once, off the
 * event loop. Roots link this copy and never the machine's install: the extension
 * host's Node 24 `rmSync` descends through a Windows junction and empties what it
 * points at, so a link into the install put it one fallen-back teardown from being
 * wiped, on a runner that is an administrator. Only a copy this scratch owns is
 * ever linked, as `linkTree` requires.
 */
function storedSdk(scratch: string, major: number): Promise<string> {
  const { source, relative } = realSdk(major);
  const stored = path.join(scratch, SDK_STORE, relative);
  const copied = storedSdks.get(stored) ?? cloneAsync(source, relative, stored).then(() => stored);
  storedSdks.set(stored, copied);
  return copied;
}

/**
 * The scratch's real SDK of `major`, LINKED into `root`: one call per root, where
 * a copy is 400 MB in ~3,800 files, and seven roots took the floor suite's setup
 * past its budget (Windows `workspace`). hostfxr follows the link exactly as
 * `installedSdkVersions` does. Only for roots that never RUN their SDK: a build
 * resolves its packs and runtime through the link's target, not the root composed.
 */
async function linkSdk(scratch: string, root: string, major: number): Promise<void> {
  const stored = await storedSdk(scratch, major);
  fs.mkdirSync(path.join(root, 'sdk'), { recursive: true });
  fs.symlinkSync(stored, path.join(root, 'sdk', path.basename(stored)), 'junction');
}

/**
 * A real, launchable root advertising exactly one SDK and one runtime.
 *
 * The muxer is COPIED, never symlinked: it resolves its root from its own real
 * path, so a symlinked one reports the SOURCE root's runtimes and every
 * assertion against it would silently be about the wrong machine.
 *
 * `runtimeAs` renames real runtime bits to the version under test. hostfxr
 * selects frameworks by directory NAME, which is the mechanism being tested;
 * the binaries inside stay real, so the process genuinely starts whenever the
 * name says it may.
 */
export async function composeRoot(
  scratch: string,
  source: string,
  name: string,
  sdkMajor: number,
  runtimeAs: string,
): Promise<string> {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  installMuxer(source, root);
  await Promise.all([
    linkSdk(scratch, root, sdkMajor),
    copyFxr(source, root),
    copyRuntime(source, root, runtimeAs),
  ]);
  return dotnetExecutable(root);
}

/**
 * Put `file` in the muxer's place, UNLINKING first.
 *
 * Overwriting a signed Mach-O in place keeps the inode, and macOS has already
 * cached that inode's code signature: the restored binary no longer matches
 * it, so the kernel kills the next launch with SIGKILL and the failure reads
 * as a hung process rather than a rejected signature. Unlinking makes the copy
 * a new inode, which is validated afresh.
 */
export function replaceMuxer(host: string, file: string): void {
  fs.rmSync(host, { force: true });
  fs.copyFileSync(file, host);
  fs.chmodSync(host, 0o755);
}

/** Restore the real muxer, for suites that break it to fail the probe. */
export function installMuxer(source: string, root: string): void {
  replaceMuxer(dotnetExecutable(root), dotnetExecutable(source));
}

/**
 * Roll-forward the AGENT injected, never the fixture.
 *
 * hostfxr reads these before the app's own `runtimeconfig.json`, so a runner
 * that exports one decides the launch these suites exist to observe: the oracle
 * would be measuring the machine rather than the root under test.
 */
const HOST_ENV_OVERRIDES = [
  'DOTNET_ROLL_FORWARD',
  'DOTNET_ROLL_FORWARD_TO_PRERELEASE',
  'DOTNET_ROLL_FORWARD_ON_NO_CANDIDATE_FX',
];

export function runHost(host: string, cwd: string, args: string[]) {
  const inherited = Object.entries(process.env).filter(
    ([name]) => !HOST_ENV_OVERRIDES.includes(name),
  );
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(inherited),
    DOTNET_ROOT: path.dirname(host),
    DOTNET_MULTILEVEL_LOOKUP: '0',
  };
  return spawnSync(host, args, { cwd, encoding: 'utf8', timeout: SETTLE_MS, env });
}

/** Launch one real staged sidecar on `host` and hand back everything it said. */
export function launchSidecar(host: string, cwd: string, language: Language) {
  const dll = path.resolve(__dirname, '../../../bin/all', `SharpLsp.Sidecar.${language}.dll`);
  assert.ok(fs.existsSync(dll), `the test must execute the staged release sidecars: ${dll}`);
  return runHost(host, cwd, [dll, '--version']);
}

/**
 * Everything the host reported, so a failure names the cause rather than a
 * bare exit code. An opaque `expected 150, got null` cost a whole CI round
 * trip; `error=spawnSync ETIMEDOUT` would have named it on the first.
 */
export function describeRun(label: string, run: ReturnType<typeof runHost>): string {
  return (
    `${label}: status=${String(run.status)} signal=${String(run.signal)} ` +
    `error=${run.error?.message ?? 'none'} ` +
    `stdout=${(run.stdout ?? '').trim()} stderr=${(run.stderr ?? '').trim()}`
  );
}

/** Exercise hostfxr version selection with real runtime bits under one advertised version. */
export function selectRuntimeVersion(root: string, version: string): void {
  const parent = path.join(root, FRAMEWORK);
  const versions = fs.readdirSync(parent);
  assert.ok(versions.length > 0);
  const source = path.join(root, 'runtime-source');
  fs.renameSync(parent, source);
  fs.mkdirSync(parent);
  cloneInto(source, versions[0]!, path.join(parent, version));
}

export function assertSidecarsRun(host: string, cwd: string): void {
  for (const language of ['FSharp', 'CSharp'] as const) {
    const run = launchSidecar(host, cwd, language);
    assert.equal(run.status, 0, describeRun(`${language} must start on ${host}`, run));
    assert.ok(
      run.stdout.startsWith(`sharplsp-sidecar-${language.toLowerCase()} `),
      describeRun(`${language} must identify itself`, run),
    );
    assert.equal(run.signal, null, describeRun(`${language} must exit normally`, run));
  }
}

/** Only replace editor/installer boundaries; SDK selection and executable hosts stay real. */
export function stubSdkWorkspace(
  root: string,
  find: () => string | undefined,
  acquire: (version: string) => string,
): () => void {
  const folders = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  const execute = vscode.commands.executeCommand;
  const candidates = dotnetRoots.candidateDotnetRoots;
  Object.defineProperty(dotnetRoots, 'candidateDotnetRoots', {
    configurable: true,
    value: () => [process.env['DOTNET_ROOT']],
  });
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    get: () => [{ uri: vscode.Uri.file(root), name: 'sdk-host-regression', index: 0 }],
  });
  vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
    if (command === 'dotnet.findPath') return { dotnetPath: find() };
    if (command === 'dotnet.acquireGlobalSDK') {
      const context = args[0] as { version: string; mode: string };
      assert.equal(context.mode, 'sdk', 'sidecars need MSBuild as well as the runtime');
      return { dotnetPath: acquire(context.version) };
    }
    return await execute(command, ...args);
  }) as typeof execute;
  return () => {
    vscode.commands.executeCommand = execute;
    Object.defineProperty(dotnetRoots, 'candidateDotnetRoots', { value: candidates });
    assert.ok(folders, 'VS Code must expose the workspaceFolders descriptor');
    Object.defineProperty(vscode.workspace, 'workspaceFolders', folders);
  };
}
