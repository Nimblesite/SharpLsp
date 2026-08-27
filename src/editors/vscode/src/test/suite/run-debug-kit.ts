// Driving and observing RUN and DEBUG from the extension host.
//
// Spec: [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-NODEBUG],
// [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS].
//
// Two rules shape everything here:
//
//  1. A test may only IMPORT identifiers that exist today. Commands that the
//     run/debug work still has to add are referenced as literal id strings —
//     that compiles now and fails at runtime, which is the point.
//  2. A resolved `executeCommand` promise proves nothing: the desktop host
//     swallows errors inside command handlers, and `startDebugging` is fired
//     and discarded today. So every assertion is made against something the
//     workbench itself reports — a session event, a task process event, a
//     terminal, or the extension's own manifest.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getNetcoredbgCandidates } from '../../debug.js';
import { EXTENSION_ID, pollUntilResult, sleep } from './test-helpers';

/** Registered by the extension today. */
export const CMD_DEBUG_PROGRAM = 'sharplsp.debugProgram';

/**
 * NOT registered today — [DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS] requires it.
 * Deliberately a literal, never an import: importing a constant that does not
 * exist would break the build instead of failing the test.
 */
export const CMD_RUN_PROGRAM = 'sharplsp.runProgram';

/** VS Code's own F5 handler. */
export const CMD_VSCODE_DEBUG_START = 'workbench.action.debug.start';

/** VS Code's own Ctrl/Cmd+F5 handler — `debug.start` with `noDebug: true`. */
export const CMD_VSCODE_DEBUG_RUN = 'workbench.action.debug.run';

/** The shipped debugger type, from package.json and constants.ts alike. */
export const DEBUG_TYPE_ID = 'sharplsp-coreclr';

/** Long enough for a cold restore + build of a fixture project on CI. */
export const BUILD_TIMEOUT_MS = 300_000;

/** How long to wait for the workbench to report a session or a task. */
export const OBSERVE_TIMEOUT_MS = 60_000;

/** Settle window for proving that NOTHING happened. */
export const QUIET_MS = 2_500;

/**
 * A `WorkspaceFolder` rooted at `root`, for direct provider calls.
 *
 * Real folders come from `vscode.workspace.workspaceFolders`; a provider,
 * factory or `startDebugging` call that must be pointed at a scratch tree needs
 * one built by hand, and this is the single builder for it.
 */
export function fakeFolder(root: string, index = 0): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(root), name: path.basename(root), index };
}

/**
 * The configuration VS Code hands a provider on F5 with no launch.json.
 *
 * `DebugConfiguration` declares `type`/`name`/`request` as non-optional
 * `string`, which is a lie on this path — VS Code builds the object with
 * `Object.create(null)` and it arrives with those keys ABSENT. The cast is what
 * lets a test express the real shape the typings forbid.
 */
export function emptyF5Config(): vscode.DebugConfiguration {
  return {} as vscode.DebugConfiguration;
}

/** The same shape after JSON transport: keys present, values undefined. */
export function undefinedF5Config(): vscode.DebugConfiguration {
  return {
    type: undefined,
    request: undefined,
    name: undefined,
  } as unknown as vscode.DebugConfiguration;
}

/** The legacy empty-string shape earlier code was written against. */
export function legacyF5Config(): vscode.DebugConfiguration {
  return { type: '', request: '', name: '' };
}

/**
 * The extension's manifest, as VS Code itself parsed it.
 *
 * MERGED, not authored: VS Code folds its own core debug attributes into every
 * `contributes.debuggers` entry it loads, so this object holds `name`, `type`,
 * `request`, `preLaunchTask` and the rest whether or not we declared them. Use
 * {@link authoredPackageJson} to ask what THIS repository actually ships.
 */
export function packageJson(): Record<string, any> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the VSIX host`);
  return extension.packageJSON;
}

/**
 * The manifest as it is authored ON DISK, before VS Code merges anything in.
 *
 * The only way to tell an attribute this repository declares from one core
 * injected at load time — and so the only way to prove we do not re-declare,
 * and thereby misdescribe, an attribute core owns.
 */
export function authoredPackageJson(): Record<string, any> {
  const manifest = path.resolve(__dirname, '../../..', 'package.json');
  assert.ok(fs.existsSync(manifest), `the authored manifest must exist at ${manifest}`);
  return JSON.parse(fs.readFileSync(manifest, 'utf-8'));
}

/** The `configurationAttributes` block exactly as authored on disk. */
export function authoredConfigurationAttributes(): Record<string, any> {
  const debuggers: unknown = authoredPackageJson().contributes?.debuggers;
  assert.ok(Array.isArray(debuggers), 'the authored manifest must declare contributes.debuggers');
  const entry = debuggers.find((item) => item?.type === DEBUG_TYPE_ID);
  assert.ok(entry, `the authored manifest must declare the '${DEBUG_TYPE_ID}' debugger`);
  const attributes: unknown = entry.configurationAttributes;
  assert.ok(attributes, 'the authored debugger must declare configurationAttributes');
  return attributes as Record<string, any>;
}

/** The `contributes` block of the manifest. */
export function contributes(): Record<string, any> {
  const block = packageJson().contributes;
  assert.ok(block, 'the manifest must declare a contributes block');
  return block;
}

/** The single `sharplsp-coreclr` entry of `contributes.debuggers`. */
export function debuggerContribution(): Record<string, any> {
  const debuggers: unknown = contributes().debuggers;
  assert.ok(Array.isArray(debuggers), 'contributes.debuggers must be an array');
  const entry = debuggers.find((item) => item?.type === DEBUG_TYPE_ID);
  assert.ok(entry, `contributes.debuggers must declare type '${DEBUG_TYPE_ID}'`);
  return entry;
}

/** Menu entries contributed to `menu`, or an empty list when absent. */
export function menuItems(menu: string): Record<string, any>[] {
  const items: unknown = contributes().menus?.[menu];
  return Array.isArray(items) ? items : [];
}

/**
 * True when the bundled/installed netcoredbg is present.
 *
 * Session-starting tests skip on `false` rather than passing quietly: a test
 * that silently succeeds because no debugger exists is worse than no test.
 */
export function adapterAvailable(): boolean {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const candidates = getNetcoredbgCandidates(extension?.extensionPath);
  return candidates.some((candidate) => fs.existsSync(candidate));
}

/** One observed debug session and the configuration it was started with. */
export interface ObservedSession {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly configuration: Record<string, any>;
  readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
}

/**
 * Records every debug session that starts and terminates while armed.
 *
 * Arm it BEFORE the interaction: `onDidStartDebugSession` fires only after the
 * adapter's launch round-trip succeeded, so subscribing afterwards races.
 */
export class DebugSessionRecorder {
  private readonly startedSessions: ObservedSession[] = [];
  private readonly terminatedIds: string[] = [];
  private readonly liveSessions: vscode.DebugSession[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this.liveSessions.push(session);
        this.startedSessions.push({
          id: session.id,
          type: session.type,
          name: session.name,
          configuration: session.configuration,
          workspaceFolder: session.workspaceFolder,
        });
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.terminatedIds.push(session.id);
      }),
    );
  }

  /** Every session observed so far, in start order. */
  public get started(): readonly ObservedSession[] {
    return this.startedSessions;
  }

  /** Ids of sessions that have terminated. */
  public get terminated(): readonly string[] {
    return this.terminatedIds;
  }

  /** Live session objects of the SharpLsp debug type, in start order. */
  public get liveOurs(): readonly vscode.DebugSession[] {
    return this.liveSessions.filter((session) => session.type === DEBUG_TYPE_ID);
  }

  /** Sessions of the SharpLsp debug type only, ignoring neighbouring suites. */
  public get ours(): readonly ObservedSession[] {
    return this.startedSessions.filter((session) => session.type === DEBUG_TYPE_ID);
  }

  /** Wait for at least `count` SharpLsp sessions; returns what was observed. */
  public async waitForSessions(
    count = 1,
    timeoutMs = OBSERVE_TIMEOUT_MS,
  ): Promise<readonly ObservedSession[]> {
    return pollUntilResult(
      async () => this.ours,
      (sessions) => sessions.length >= count,
      timeoutMs,
      100,
    );
  }

  /** Settle, then assert no SharpLsp session started. Proves a clean refusal. */
  public async assertNoSession(reason: string, quietMs = QUIET_MS): Promise<void> {
    await sleep(quietMs);
    assert.deepStrictEqual(
      this.ours.map((session) => session.name),
      [],
      `${reason}; sessions seen: ${JSON.stringify(this.ours.map((s) => s.configuration))}`,
    );
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

/** One observed task execution and the process result it produced. */
export interface ObservedTask {
  readonly name: string;
  readonly source: string;
  readonly definitionType: string;
  readonly command: string | undefined;
  readonly args: readonly string[];
}

/** Flatten a task's execution into readable command + args. */
function executionOf(task: vscode.Task): { command: string | undefined; args: string[] } {
  const execution = task.execution;
  if (execution instanceof vscode.ProcessExecution) {
    return { command: execution.process, args: [...execution.args] };
  }
  if (execution instanceof vscode.ShellExecution) {
    const command = execution.command;
    const name = typeof command === 'string' ? command : command?.value;
    // A ShellExecution built from a whole command LINE carries no args at all.
    const args = (execution.args ?? []).map((arg) => (typeof arg === 'string' ? arg : arg.value));
    return { command: name, args };
  }
  return { command: undefined, args: [] };
}

/**
 * Records every task the extension starts and every task process that ends.
 *
 * A script run must be dispatched as a `vscode.Task`, not typed into a terminal
 * ([DEBUG-FEATURES-LAUNCH-SCRIPT] rule 1) — precisely so that its command, its
 * arguments and its exit code are observable here. `Terminal.sendText` has no
 * read-back API, so a terminal-based run can assert nothing about what it ran.
 */
export class TaskRecorder {
  private readonly startedTasks: ObservedTask[] = [];
  private readonly exitCodes: number[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.tasks.onDidStartTask((event) => {
        const task = event.execution.task;
        const { command, args } = executionOf(task);
        this.startedTasks.push({
          name: task.name,
          source: task.source,
          definitionType: task.definition.type,
          command,
          args,
        });
      }),
      vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.exitCode !== undefined) this.exitCodes.push(event.exitCode);
      }),
    );
  }

  /** Every task observed so far, in start order. */
  public get started(): readonly ObservedTask[] {
    return this.startedTasks;
  }

  /** Exit codes of task processes that have finished. */
  public get exits(): readonly number[] {
    return this.exitCodes;
  }

  /** Tasks whose command is the `dotnet` CLI — the run paths we care about. */
  public get dotnetTasks(): readonly ObservedTask[] {
    return this.startedTasks.filter((task) => task.command?.endsWith('dotnet') === true);
  }

  /** Wait for at least `count` `dotnet` tasks to start. */
  public async waitForDotnetTasks(
    count = 1,
    timeoutMs = OBSERVE_TIMEOUT_MS,
  ): Promise<readonly ObservedTask[]> {
    return pollUntilResult(
      async () => this.dotnetTasks,
      (tasks) => tasks.length >= count,
      timeoutMs,
      100,
    );
  }

  /** Wait for at least `count` task processes to report an exit code. */
  public async waitForExits(count = 1, timeoutMs = OBSERVE_TIMEOUT_MS): Promise<readonly number[]> {
    return pollUntilResult(
      async () => this.exits,
      (codes) => codes.length >= count,
      timeoutMs,
      100,
    );
  }

  /** Settle, then assert no task ran. Proves a refusal did not run anything. */
  public async assertNoTask(reason: string, quietMs = QUIET_MS): Promise<void> {
    await sleep(quietMs);
    assert.deepStrictEqual(
      this.dotnetTasks.map((task) => `${task.command ?? '?'} ${task.args.join(' ')}`),
      [],
      reason,
    );
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

/** Wait for a terminal with `name` to appear. */
export async function waitForTerminal(
  name: string,
  timeoutMs = OBSERVE_TIMEOUT_MS,
): Promise<vscode.Terminal | undefined> {
  const terminals = await pollUntilResult(
    async () => vscode.window.terminals,
    (open) => open.some((terminal) => terminal.name === name),
    timeoutMs,
    100,
  );
  return terminals.find((terminal) => terminal.name === name);
}

/** Open `file` and make it the active editor, so target resolution sees it. */
export async function focusDocument(file: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  assert.strictEqual(
    vscode.window.activeTextEditor?.document.uri.fsPath,
    document.uri.fsPath,
    'the fixture document must be the active editor before resolving a target',
  );
  return editor;
}

/** How long a teardown waits for a stopped session to report its termination. */
const SETTLE_TIMEOUT_MS = 20_000;

/**
 * Stop any session a test started AND wait for the workbench to report it gone.
 *
 * `stopDebugging()` only asks; `onDidTerminateDebugSession` lands afterwards. A
 * teardown that returns before it does leaks the previous test's termination
 * into the NEXT test's recorder, where it reads as "a session this test never
 * started has ended" — a failure with no relationship to the test that reports
 * it. Settling here is what keeps each test's recorders describing only its own
 * sessions. Safe when there is nothing to stop: the wait is skipped entirely.
 */
export async function stopAnyDebugSession(): Promise<void> {
  const active = vscode.debug.activeDebugSession;
  if (active === undefined) return;
  const ended = new Set<string>();
  const listener = vscode.debug.onDidTerminateDebugSession((session) => ended.add(session.id));
  try {
    await vscode.debug.stopDebugging();
  } catch {
    // Already gone between the check and the request — still settle below.
  }
  await pollUntilResult(
    async () => ended,
    (ids) => ids.has(active.id),
    SETTLE_TIMEOUT_MS,
    50,
  );
  listener.dispose();
}

/**
 * Invoke a command that may not exist yet and report the outcome instead of
 * throwing, so a test can assert on BOTH the missing-command state today and
 * the real behaviour once the command lands.
 */
export interface CommandOutcome {
  readonly rejected: boolean;
  readonly message: string;
}

export async function invokeCommand(id: string, ...args: unknown[]): Promise<CommandOutcome> {
  try {
    await vscode.commands.executeCommand(id, ...args);
    return { rejected: false, message: '' };
  } catch (error) {
    return { rejected: true, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Assert a command is registered, naming what is missing when it is not. */
export async function assertCommandRegistered(id: string): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes(id),
    `'${id}' must be a registered command; registered sharplsp commands: ` +
      commands
        .filter((name) => name.startsWith('sharplsp.'))
        .sort()
        .join(', '),
  );
}
