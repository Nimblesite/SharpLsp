// Driving and asserting a run/debug REFUSAL.
//
// Spec: [DEBUG-FEATURES-LAUNCH-SCRIPT], [DEBUG-FEATURES-LAUNCH-TARGET]. Every
// unsupported document kind owes the user the same four things — exactly one
// message, naming its own reason, no prompt, and neither a session nor a task —
// so the obligation is written once here rather than per suite.
import * as assert from 'node:assert/strict';
import { DebugSessionRecorder, TaskRecorder, invokeCommand } from './run-debug-kit';
import type { UiStubs } from './ui-stubs';

// The sentence `debugCurrentProject` emits today for EVERY unresolved target.
const LEGACY_REFUSAL = 'No .csproj or .fsproj found';

// A task recorder plus a session recorder, armed together before one action.
export interface Probe {
  readonly tasks: TaskRecorder;
  readonly sessions: DebugSessionRecorder;
}
const armed: Probe[] = [];

/** Arm BOTH recorders and register them for teardown. Never after the action. */
export function armProbe(): Probe {
  const probe = { tasks: new TaskRecorder(), sessions: new DebugSessionRecorder() };
  armed.push(probe);
  return probe;
}
export function disposeArmed(): void {
  for (const probe of armed) {
    probe.tasks.dispose();
    probe.sessions.dispose();
  }
  armed.length = 0;
}

export interface MessageCounts {
  readonly warnings: number;
  readonly errors: number;
  readonly infos: number;
}
const NO_MESSAGES: MessageCounts = { warnings: 0, errors: 0, infos: 0 };
export function messageCounts(stubs: UiStubs): MessageCounts {
  const { warningMessages: w, errorMessages: e, infoMessages: i } = stubs.log;
  return { warnings: w.length, errors: e.length, infos: i.length };
}

// Sliced PER CHANNEL: slicing a flattened warning+error+info list by an earlier
// flattened length mis-reports which message is new once two channels are used.
export function messagesSince(stubs: UiStubs, since: MessageCounts): string[] {
  const { warningMessages: w, errorMessages: e, infoMessages: i } = stubs.log;
  return [...w.slice(since.warnings), ...e.slice(since.errors), ...i.slice(since.infos)];
}
export function messagesOf(stubs: UiStubs): string[] {
  return messagesSince(stubs, NO_MESSAGES);
}

/** A refusal must name its own reason, not borrow an unrelated one. */
export function assertOmits(message: string, forbidden: string, why: string): void {
  const mentions = message.includes(forbidden);
  assert.strictEqual(mentions, false, `${why}: must not mention '${forbidden}': '${message}'`);
}

export function assertNamedRefusal(message: string, needles: readonly string[], why: string): void {
  assert.strictEqual(typeof message, 'string', `${why}: a refusal is a string message`);
  assert.notStrictEqual(message.trim().length, 0, `${why}: an empty message is a silent no-op`);
  assertOmits(message, LEGACY_REFUSAL, `${why}: the generic project-not-found sentence`);
  const lowered = message.toLowerCase();
  for (const needle of needles) {
    const named = lowered.includes(needle);
    assert.strictEqual(named, true, `${why}: must name '${needle}': '${message}'`);
  }
}

export function assertNoPrompts(stubs: UiStubs, why: string): void {
  assert.deepStrictEqual(stubs.log.quickPickItems, [], `${why}: must not open a quick pick`);
  assert.deepStrictEqual(stubs.log.inputBoxOptions, [], `${why}: must not open an input box`);
  assert.deepStrictEqual(stubs.log.openDialogOptions, [], `${why}: must not open a file dialog`);
}
export function assertNoRecordedTasks(probe: Probe, why: string): void {
  const ran = probe.tasks.dotnetTasks.map((task) => task.args.join(' '));
  assert.deepStrictEqual(ran, [], why);
}

/** Drive one refusal and assert every obligation of rule 6. */
export async function expectRefusal(
  commandId: string,
  probe: Probe,
  stubs: UiStubs,
  needles: readonly string[],
  why: string,
): Promise<string> {
  const before = messageCounts(stubs);
  const outcome = await invokeCommand(commandId);
  const clean = { rejected: false, message: '' };
  assert.deepStrictEqual({ ...outcome }, clean, `${why}: must refuse with a message, not reject`);
  const shown = messagesSince(stubs, before);
  assert.strictEqual(shown.length, 1, `${why}: exactly one message, saw ${JSON.stringify(shown)}`);
  const message = shown[0] ?? '';
  assertNamedRefusal(message, needles, why);
  assertNoPrompts(stubs, `${why}: a refusal`);
  await probe.sessions.assertNoSession(`${why}: a refusal starts no debug session`);
  await probe.tasks.assertNoTask(`${why}: a refusal runs no task`);
  return message;
}

let toolHomeBefore: string | undefined;
let toolHomeHidden = false;

/**
 * Make `dotnet tool list --global` report an EMPTY set, for real.
 *
 * B47's premise is a machine with no `dotnet-script` installed. On a developer
 * box that tool is frequently present, and the case then silently inverts into
 * its opposite — the tool resolves, the run is dispatched, and the refusal this
 * test exists for is never exercised. `DOTNET_CLI_HOME` is where the CLI keeps
 * its global tool store, so an empty directory IS an installation with no global
 * tools: `hasDotnetScript` runs its real `dotnet` process against a real, empty
 * store. Nothing is stubbed, and the assertion still fails if the refusal path
 * regresses.
 */
export function withoutGlobalTools(home: string): void {
  toolHomeBefore = process.env.DOTNET_CLI_HOME;
  toolHomeHidden = true;
  process.env.DOTNET_CLI_HOME = home;
}

export function restoreGlobalTools(): void {
  if (!toolHomeHidden) return;
  toolHomeHidden = false;
  if (toolHomeBefore === undefined) delete process.env.DOTNET_CLI_HOME;
  else process.env.DOTNET_CLI_HOME = toolHomeBefore;
}
