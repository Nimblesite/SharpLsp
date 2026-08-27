// Harness and assertions for the F5 / no-launch.json suite.
//
// Spec: [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-BUILD],
// [DEBUG-FEATURES-LAUNCH-DYNAMIC].
//
// Split out of debug-e2e.test.ts so it clears the 500-line ceiling. Each
// `assert*` bundles the checks that belong to one step of a gesture, so the
// suite reads as a sequence of interactions without thinning the assertions.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as vscode from 'vscode';
import { SharpLspLaunchProvider } from '../../debug.js';
import {
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  contributes,
  stopAnyDebugSession,
} from './run-debug-kit';
import { closeAllEditors, comparablePath, removeDirRecursive } from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';

// Spec: [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-BUILD],
// [DEBUG-FEATURES-LAUNCH-NODEBUG], [DEBUG-FEATURES-LAUNCH-DYNAMIC]. The F5
// contract: what the provider must make of the object VS Code hands it on F5
// with no launch.json, and whether the manifest teaches the defaults the live
// provider produces. Only `SharpLspLaunchProvider` is imported: the internal
// resolvers implement the hardcoded `bin/Debug/<tfm>/` ladder that
// [DEBUG-FEATURES-LAUNCH-BUILD] calls non-conforming, so pinning their return
// values would pin the defect. Neighbouring ground: target resolution in
// run-debug-target, profile parsing in run-debug-profiles, manifest shape in
// run-debug-contributions, commands in run-debug-commands, netcoredbg in
// debug-adapter-e2e. registerDebugAdapter() is never called — the extension
// registered provider, factory and command at activation.

/** The real `node:fs` module object, not the getter-backed namespace copy. */
const realFs = createRequire(__filename)('node:fs') as typeof fs;

/** Frameworks no surface may still name once the resolver settled on `TFM`. */
const STALE_FRAMEWORKS: readonly string[] = ['net6.0', 'net7.0', 'net8.0', 'net9.0'];

export const provider = new SharpLspLaunchProvider();

/** Per-test fixtures shared by both suites in this file. */
interface Harness {
  readonly tmpDir: string;
  readonly stubs: UiStubs;
  readonly recorder: DebugSessionRecorder;
}

/** Register mocha setup/teardown for a suite and hand back an accessor. */
export function useHarness(prefix: string): () => Harness {
  let current: Harness | undefined;
  setup(() => {
    current = {
      tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
      stubs: installUiStubs(),
      recorder: new DebugSessionRecorder(),
    };
  });
  teardown(async () => {
    const active = current;
    current = undefined;
    if (active === undefined) return;
    active.recorder.dispose();
    active.stubs.restore();
    await stopAnyDebugSession();
    await closeAllEditors();
    removeDirRecursive(active.tmpDir);
  });
  return () => {
    if (current === undefined) assert.fail('the harness must be created in setup');
    return current;
  };
}

/** Resolve through the provider, failing loudly when it prevents the session. */
export async function resolveConfig(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
): Promise<vscode.DebugConfiguration> {
  const result = await provider.resolveDebugConfiguration(folder, config);
  assert.ok(result, 'a folder holding one runnable project must yield a config, not a refusal');
  return result;
}

/** Assert the provider tolerates `config`; F5 must never surface a TypeError. */
export async function assertResolves(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
  why: string,
): Promise<void> {
  // Resolution is async, so a synchronous doesNotThrow would pass on a rejected
  // promise — the exact failure this guards.
  await assert.doesNotReject(async () => provider.resolveDebugConfiguration(folder, config), why);
}

/** Compare two filesystem paths with case/separator normalisation. */
export function assertSamePath(actual: unknown, expected: string, message: string): void {
  assert.strictEqual(comparablePath(String(actual)), comparablePath(expected), message);
}

/** [B05] A resolved config with a falsy `type` is discarded SILENTLY by VS Code. */
function assertLaunchable(resolved: vscode.DebugConfiguration, label: string): void {
  assert.strictEqual(typeof resolved.type, 'string', `${label}: type must be a string`);
  assert.strictEqual(resolved.type, DEBUG_TYPE_ID, `${label}: type must name this debugger`);
  assert.notStrictEqual(resolved.type, '', `${label}: a falsy type is discarded silently`);
  assert.strictEqual(resolved.request, 'launch', `${label}: F5 synthesises a launch request`);
  assert.strictEqual(typeof resolved.name, 'string', `${label}: name must be a string`);
  assert.notStrictEqual(resolved.name, '', `${label}: an unnamed session cannot be shown`);
  assert.strictEqual(resolved.justMyCode, true, `${label}: justMyCode defaults on`);
  assert.strictEqual(typeof resolved.program, 'string', `${label}: a launch names a program`);
}

/**
 * [DEBUG-FEATURES-LAUNCH-NOCONFIG]'s "Synthesized configuration" block lists
 * `console: integratedTerminal`; [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 1 makes it
 * the default — a console app reading stdin is unusable without it.
 */
export function assertSynthesised(resolved: vscode.DebugConfiguration, label: string): void {
  assertLaunchable(resolved, label);
  assert.strictEqual(resolved.name, 'Launch .NET Project', `${label}: the synthesised name`);
  assert.strictEqual(resolved.console, 'integratedTerminal', `${label}: stdin must work`);
}

/**
 * [B06] `dotnet: build` is contributed by the proprietary Microsoft C# extension:
 * on a SharpLsp-only install the pre-launch step fails and no session starts.
 */
export function assertBuildTaskContributed(
  resolved: vscode.DebugConfiguration,
  label: string,
): void {
  assert.notStrictEqual(
    resolved.preLaunchTask,
    'dotnet: build',
    `${label}: 'dotnet: build' belongs to the C# extension, not to SharpLsp`,
  );
  if (resolved.preLaunchTask === undefined) return;
  const task = String(resolved.preLaunchTask);
  const declared: unknown = contributes().taskDefinitions;
  assert.ok(Array.isArray(declared), `${label}: a preLaunchTask needs contributes.taskDefinitions`);
  const types = declared.map((definition) => String(definition?.type));
  const named = task.split(':')[0]?.trim() ?? '';
  const seen = types.join(', ') || '<none>';
  assert.ok(types.includes(named), `${label}: '${task}' is an undeclared task type; have: ${seen}`);
}

/** A launch that saw no usable profile carries neither `env` nor `args`. */
export function assertNoProfileValues(resolved: vscode.DebugConfiguration, label: string): void {
  assert.strictEqual(resolved.env, undefined, `${label}: an unusable profile supplies no env`);
  assert.strictEqual(resolved.args, undefined, `${label}: and no args`);
}

/** Which superseded target frameworks a manifest string still names. */
export function staleFrameworks(text: string): string[] {
  return STALE_FRAMEWORKS.filter((framework) => text.includes(framework));
}

/**
 * How many times `dir` itself is listed while `run` executes. Resolving a launch
 * target lists the project directory, so this measures how often the target was
 * resolved — the only way to tell "once per invocation" from "once per profile"
 * when both produce byte-identical strings.
 */
export async function countScans<T>(
  dir: string,
  run: () => Promise<T>,
): Promise<{ result: T; scans: number }> {
  const original = realFs.readdirSync;
  let scans = 0;
  realFs.readdirSync = ((target: fs.PathLike, options?: unknown): unknown => {
    if (comparablePath(String(target)) === comparablePath(dir)) scans += 1;
    return (original as (t: fs.PathLike, o?: unknown) => unknown)(target, options);
  }) as unknown as typeof fs.readdirSync;
  try {
    return { result: await run(), scans };
  } finally {
    realFs.readdirSync = original;
  }
}

/** Generate configurations for `folder`, typed as the array they must be. */
export async function provideFor(
  folder: vscode.WorkspaceFolder,
): Promise<vscode.DebugConfiguration[]> {
  return provider.provideDebugConfigurations(folder);
}
