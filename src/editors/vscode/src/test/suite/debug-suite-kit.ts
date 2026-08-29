// The per-suite harness: a built debuggee, a live session, and breakpoints.
//
// Spec: [DEBUG-FEATURES-LAUNCH], [DEBUG-FEATURES-LAUNCH-OUTPUT],
// [DEBUG-FEATURES-BREAKPOINTS], [DEBUG-ARCHITECTURE-NETCOREDBG].
//
// The suites in this family are about what happens ONCE a session is running, so
// they hand `startDebugging` a complete, explicit configuration rather than
// leaning on the F5 resolver — target resolution has its own suites
// (run-debug-target, run-debug-build, run-debug-commands) and duplicating it
// here would make a stepping failure look like a resolver failure.
//
// Nothing in this file skips. [DEBUG-ARCHITECTURE-NETCOREDBG] requires the VSIX
// to bundle a netcoredbg for every platform in its matrix, so "no debugger
// installed" is a FAILURE of the shipped product, not a reason to report green.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DapRecorder } from './debug-dap-kit';
import { COMMAND_MS, DEBUG_SESSION_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import {
  MODE,
  writeCSharpStepTarget,
  writeFSharpStepTarget,
  type DebugFixture,
} from './debug-fixture-programs';
import {
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  fakeFolder,
  stopAnyDebugSession,
} from './run-debug-kit';
import { buildProject, isolateFromRepoMsbuild } from './run-debug-fixtures';
import {
  closeAllEditors,
  pollUntilResult,
  removeDirRecursive,
  requireWorkspaceRoot,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** Which debuggee a suite drives. F# is never the reduced case. */
export type Language = 'csharp' | 'fsharp';

/** Everything a test in this family needs, rebuilt per test where cheap. */
export interface Debuggee {
  readonly fixture: DebugFixture;
  readonly folder: vscode.WorkspaceFolder;
  readonly recorder: DapRecorder;
  readonly stubs: UiStubs;
  readonly sessions: DebugSessionRecorder;
}

/** The launch attributes a case varies. Every one is in the declared schema. */
export interface LaunchOptions {
  /** `argv[0]`, selecting which branch of the debuggee runs. */
  readonly mode?: string;
  /** `stopAtEntry` — declared in `configurationAttributes.launch.properties`. */
  readonly stopAtEntry?: boolean;
  /** `justMyCode` — [DEBUG-FEATURES-STEPPING] "Just My Code", P1. */
  readonly justMyCode?: boolean;
  /** Ctrl/Cmd+F5 semantics: run the session with breakpoints disarmed. */
  readonly noDebug?: boolean;
  /** `env` — [DEBUG-FEATURES-LAUNCH] "Launch with environment variables", P1. */
  readonly env?: Readonly<Record<string, string>>;
  /** Anything else a single case needs to prove, merged last. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * The launch configuration every suite in this family starts from.
 *
 * `console` is pinned to `internalConsole` so the debuggee's stdout arrives as
 * DAP `output` events and can be asserted. [DEBUG-FEATURES-LAUNCH-OUTPUT] makes
 * `integratedTerminal` the DEFAULT — that default is asserted where it belongs,
 * in the manifest suite — but a terminal has no read-back API, so a test that
 * used it could assert nothing about what the program printed.
 */
export function launchConfigFor(
  fixture: DebugFixture,
  options: LaunchOptions = {},
): vscode.DebugConfiguration {
  return {
    type: DEBUG_TYPE_ID,
    request: 'launch',
    name: `Debug ${fixture.assemblyName}`,
    program: fixture.dll,
    args: [options.mode ?? MODE.plain],
    cwd: fixture.dir,
    env: { ...(options.env ?? {}) },
    console: 'internalConsole',
    stopAtEntry: options.stopAtEntry ?? false,
    justMyCode: options.justMyCode ?? true,
    ...(options.extra ?? {}),
  };
}

/** A `SourceBreakpoint` on the statement `anchor` addresses. */
export function breakpointAt(
  fixture: DebugFixture,
  anchor: string,
  extras: {
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
    enabled?: boolean;
  } = {},
): vscode.SourceBreakpoint {
  const location = new vscode.Location(fixture.uri, fixture.source.position(anchor));
  return new vscode.SourceBreakpoint(
    location,
    extras.enabled ?? true,
    extras.condition,
    extras.hitCondition,
    extras.logMessage,
  );
}

/** Arm breakpoints on each anchor and return them in the order given. */
export function armBreakpoints(
  fixture: DebugFixture,
  ...anchors: readonly string[]
): vscode.SourceBreakpoint[] {
  const breakpoints = anchors.map((anchor) => breakpointAt(fixture, anchor));
  vscode.debug.addBreakpoints(breakpoints);
  return breakpoints;
}

/** Remove every breakpoint in the workbench. Leaking one poisons the next test. */
export function clearAllBreakpoints(): void {
  vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  assert.deepStrictEqual(
    vscode.debug.breakpoints.map((breakpoint) => breakpoint.id),
    [],
    'the workbench must forget every breakpoint between tests',
  );
}

/**
 * Start the session and prove it really started.
 *
 * `startDebugging` resolving `false` is how VS Code reports "no adapter", "the
 * program does not exist" and "a provider cancelled" alike, and
 * [DEBUG-FEATURES-LAUNCH-NODEBUG] rule 4 requires that value to be observed
 * rather than discarded — so it is asserted here, with the reason named.
 */
export async function startDebuggee(
  debuggee: Debuggee,
  options: LaunchOptions = {},
): Promise<vscode.DebugSession> {
  const config = launchConfigFor(debuggee.fixture, options);
  assert.strictEqual(fs.existsSync(String(config['program'])), true, missingProgram(config));
  const started = await vscode.debug.startDebugging(debuggee.folder, config, {
    noDebug: options.noDebug ?? false,
  });
  assert.strictEqual(started, true, refusedLaunch(debuggee));
  return waitForSession();
}

/** The message a missing build produces — a fixture bug, not a product bug. */
function missingProgram(config: vscode.DebugConfiguration): string {
  return `the fixture build must have produced ${String(config['program'])} before a launch`;
}

/** The message a refused launch produces, naming what the product must ship. */
function refusedLaunch(debuggee: Debuggee): string {
  return (
    `vscode.debug.startDebugging refused to launch ${debuggee.fixture.assemblyName}. ` +
    '[DEBUG-ARCHITECTURE-NETCOREDBG] requires the VSIX to bundle a netcoredbg 3.2.0-1092 for ' +
    'every platform in its matrix and [DEBUG-ADAPTER-NETCOREDBG] makes it the Phase Four ' +
    'adapter, so a refusal here means the shipped extension cannot debug at all on this host. ' +
    `Adapter errors seen: ${JSON.stringify(debuggee.recorder.errors)}`
  );
}

/** Wait until the workbench reports an ACTIVE session of the shipped type. */
async function waitForSession(): Promise<vscode.DebugSession> {
  const session = await pollUntilResult(
    async () => vscode.debug.activeDebugSession,
    (current) => current?.type === DEBUG_TYPE_ID,
    DEBUG_SESSION_MS,
    50,
  );
  assert.ok(session, 'a started launch must leave an active debug session');
  assert.strictEqual(session.type, DEBUG_TYPE_ID, 'the active session must be the SharpLsp one');
  return session;
}

/** Stop the session and wait for the workbench to forget it. */
export async function stopDebuggee(): Promise<void> {
  await stopAnyDebugSession();
  // Only reached once the terminate event has already fired, so the workbench
  // clears the active session in milliseconds. A command-scale budget keeps
  // this pair of waits inside the teardown ceiling above.
  await pollUntilResult(
    async () => vscode.debug.activeDebugSession,
    (session) => session === undefined,
    COMMAND_MS,
    50,
  );
}

/** Write and build the debuggee for `language` under `scratchDir`. */
async function materialise(scratchDir: string, language: Language): Promise<DebugFixture> {
  isolateFromRepoMsbuild(scratchDir);
  const dir = path.join(scratchDir, language === 'fsharp' ? 'FsStepTarget' : 'StepTarget');
  const fixture = language === 'fsharp' ? writeFSharpStepTarget(dir) : writeCSharpStepTarget(dir);
  await buildProject(fixture);
  assert.strictEqual(fs.existsSync(fixture.dll), true, `the debuggee must build to ${fixture.dll}`);
  return fixture;
}

/**
 * Register the mocha hooks every suite in this family shares and hand back an
 * accessor for the current test's harness.
 *
 * The scratch tree lives INSIDE the opened workspace folder: a session started
 * against a temp directory has no `workspaceFolder`, which is a different and
 * separately specified refusal path.
 */
export function useDebuggee(prefix: string, language: Language): () => Debuggee {
  let fixture: DebugFixture;
  let scratchDir: string;
  let current: Debuggee | undefined;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    scratchDir = fs.mkdtempSync(path.join(requireWorkspaceRoot(), prefix));
    fixture = await materialise(scratchDir, language);
  });

  suiteTeardown(() => {
    removeDirRecursive(scratchDir);
  });

  setup(() => {
    clearAllBreakpoints();
    current = {
      fixture,
      folder: fakeFolder(requireWorkspaceRoot()),
      recorder: new DapRecorder(),
      stubs: installUiStubs(),
      sessions: new DebugSessionRecorder(),
    };
  });

  teardown(async function () {
    // Awaits stopAnyDebugSession's DEBUG_SESSION_MS poll; the ceiling must sit
    // above it so the poll's own message wins ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    this.timeout(DEBUG_SESSION_MS + 5_000);
    const active = current;
    current = undefined;
    if (active === undefined) return;
    await stopDebuggee();
    clearAllBreakpoints();
    active.sessions.dispose();
    active.recorder.dispose();
    active.stubs.restore();
    await closeAllEditors();
  });

  return () => {
    assert.ok(current, 'the debuggee harness must be created in setup');
    return current;
  };
}

/**
 * Assert the adapter BOUND each armed breakpoint to the line it was set on.
 *
 * A `verified: false` breakpoint is the silent failure mode of debugging: the
 * gutter shows a hollow marker, the program runs straight past, and nothing is
 * reported. A breakpoint the adapter silently SLID to another line is worse —
 * it stops, so the session looks healthy, while the user is inspecting state
 * from a statement they did not choose.
 */
export function assertBreakpointsBound(
  recorder: DapRecorder,
  fixture: DebugFixture,
  anchors: readonly string[],
  why: string,
): void {
  const responses = recorder.responses('setBreakpoints');
  assert.ok(responses.length > 0, `${why}: the workbench must send \`setBreakpoints\``);
  const bound = lastBoundBreakpoints(responses);
  assert.strictEqual(bound.length, anchors.length, `${why}: one bound breakpoint per armed line`);

  // [DEBUG-FEATURES-BREAKPOINTS-VERIFY]: a breakpoint armed before its module is
  // loaded answers `verified: false` and verifies later by a `breakpoint` event.
  // The EFFECTIVE state is the response merged with those events; asserting the
  // response alone tests the adapter's scheduling, not whether it bound.
  const verifiedLater = new Set(
    recorder
      .events('breakpoint')
      .filter((event) => event.body['breakpoint']?.verified === true)
      .map((event) => Number(event.body['breakpoint']?.id)),
  );
  const effective = bound.map(
    (entry) => entry['verified'] === true || verifiedLater.has(Number(entry['id'])),
  );
  assert.deepStrictEqual(
    effective,
    anchors.map(() => true),
    `${why}: every breakpoint must verify, in the response or by a later ` +
      `\`breakpoint\` event; unverified ones never stop the debuggee`,
  );
  assert.deepStrictEqual(
    bound.map((entry) => Number(entry['line'])),
    anchors.map((anchor) => fixture.source.dapLine(anchor)),
    `${why}: a bound breakpoint must stay on the line the user set it on`,
  );
}

/** The `breakpoints` array of the most recent `setBreakpoints` response. */
function lastBoundBreakpoints(
  responses: readonly { body: Record<string, any> }[],
): Record<string, any>[] {
  const body = responses[responses.length - 1]?.body ?? {};
  const bound: unknown = body['breakpoints'];
  assert.ok(Array.isArray(bound), '`setBreakpoints` must answer with a breakpoints array');
  return bound as Record<string, any>[];
}

/**
 * Assert the debuggee ran to completion and reported the exit code.
 *
 * DAP separates `exited` (the debuggee process ended, carrying `exitCode`) from
 * `terminated` (the debug session ended). A session that reports one without the
 * other leaves the workbench either showing a dead session or losing the exit
 * code the user needs.
 */
export async function assertRanToCompletion(
  recorder: DapRecorder,
  expectedExitCode: number,
  why: string,
): Promise<void> {
  const exited = await recorder.waitForEvents('exited', 1);
  assert.strictEqual(
    Number(exited[0]?.body['exitCode']),
    expectedExitCode,
    `${why}: the debuggee must exit ${String(expectedExitCode)}`,
  );
  const terminated = await recorder.waitForEvents('terminated', 1);
  assert.strictEqual(terminated.length >= 1, true, `${why}: the session must report termination`);
}

/** Every user-visible refusal the extension issued while a case ran. */
export function refusalsOf(stubs: UiStubs): string[] {
  return [...stubs.log.errorMessages, ...stubs.log.warningMessages];
}

/** Assert a healthy session: no refusal toast, no adapter transport error. */
export function assertCleanSession(debuggee: Debuggee, why: string): void {
  assert.deepStrictEqual(refusalsOf(debuggee.stubs), [], `${why}: a working session warns nobody`);
  assert.deepStrictEqual(
    debuggee.recorder.errors,
    [],
    `${why}: the DAP transport must not error; [DEBUG-ARCHITECTURE-ROUTER] makes adapter ` +
      'lifecycle the host’s responsibility, and a transport error is a lost session',
  );
  assert.deepStrictEqual(debuggee.stubs.log.infoMessages, [], `${why}: and shows no info toast`);
}
