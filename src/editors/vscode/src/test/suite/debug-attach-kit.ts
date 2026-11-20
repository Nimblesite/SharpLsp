// What every attach suite shares: a debuggee started OUTSIDE the debugger, the
// attach configuration of [DEBUG-FEATURES-LAUNCH]'s schema, the headless Pause
// gesture, and the teardown that never leaks a spawned process.
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type * as vscode from 'vscode';
import { MODE, type DebugFixture } from './debug-fixture-programs';
import { stackFrames } from './debug-drive-kit';
import { DEBUG_TYPE_ID } from './run-debug-kit';
import { pollUntilResult } from './test-helpers';
import { PROCESS_START_MS, SETTLE_MS } from './test-timeouts';

/** A running debuggee the test owns, plus the output it has produced. */
export interface RunningDebuggee {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly output: () => string;
}

/** Every child this suite spawned, so teardown can never leak one. */
export const spawned: ChildProcess[] = [];

/** Start the fixture assembly outside the debugger and wait until it is alive. */
export async function startOutsideDebugger(dll: string, cwd: string): Promise<RunningDebuggee> {
  let text = '';
  const child = spawn('dotnet', [dll, MODE.wait], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(child);
  child.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  const pid = child.pid ?? 0;
  assert.ok(pid > 0, 'the fixture process must start outside the debugger before an attach');
  await pollUntilResult(
    async () => text,
    (seen) => seen.includes('boxed=8'),
    PROCESS_START_MS,
    100,
  );
  assert.ok(
    text.includes('boxed=8'),
    `the debuggee must be running before an attach; saw: ${text}`,
  );
  return { child, pid, output: () => text };
}

/** The attach configuration of [DEBUG-FEATURES-LAUNCH]'s schema block. */
export function attachConfig(extra: Record<string, unknown>): vscode.DebugConfiguration {
  return {
    type: DEBUG_TYPE_ID,
    request: 'attach',
    name: 'Attach to Process',
    justMyCode: true,
    ...extra,
  };
}

/** Start the fixture outside the debugger, asserted ALIVE: the premise of every attach. */
export async function startAliveOutside(
  fixture: DebugFixture,
  why: string,
): Promise<RunningDebuggee> {
  const running = await startOutsideDebugger(fixture.dll, fixture.dir);
  assert.ok(isAlive(running.pid), why);
  return running;
}

/** True while the process is still alive — signal 0 probes without signalling. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when an attach session shows netcoredbg's broken attach stack walk.
 *
 * Upstream defect (Samsung/netcoredbg #199, #205): the `attach` request ACKs,
 * `threads` eventually lists the paused thread and the `pause` stop arrives,
 * but `stackTrace` answers an empty frame list forever — the ICorDebug stack
 * walk never engages for a process netcoredbg did not launch itself. No
 * SharpLsp-side fix exists: the frames are simply not reported. [DEBUG-GAPS]
 * "Attach error `0x80070057`" documents the refusal half of the same defect;
 * the retry the spec commits to recovers the refusal, not this.
 */
export function attachStackUnwalkable(frames: readonly { readonly id: number }[]): boolean {
  return frames.length === 0 || frames.every((frame) => frame.id <= 0);
}

/**
 * Read the stack, treating the upstream attach defect as "unwalkable".
 *
 * netcoredbg's broken attach stack walk shows up two ways: frames that carry no
 * usable id, and — on the Windows runner — a `stackTrace` request that fails
 * outright with 0x80070057 (E_INVALIDARG). Both are the same upstream defect and
 * get the same treatment the suite already documents below. Every other error
 * still propagates: a swallowed `stackTrace` failure would hide a real one.
 */
export async function walkAttachedStack(
  session: vscode.DebugSession,
  threadId: number,
): Promise<Awaited<ReturnType<typeof stackFrames>>> {
  try {
    return await stackFrames(session, threadId);
  } catch (error) {
    if (String(error).includes('0x80070057')) return [];
    throw error;
  }
}

/** Wait for attach configuration to finish, then issue the headless Pause gesture. */
export async function pauseAttached(session: vscode.DebugSession): Promise<number> {
  const threadId = await pollUntilResult(
    async () => {
      try {
        const threads: unknown = await session.customRequest('threads');
        if (typeof threads !== 'object' || threads === null) return 0;
        const listed: unknown = (threads as Record<string, unknown>)['threads'];
        if (!Array.isArray(listed)) return 0;
        const first = listed[0];
        return typeof first === 'object' && first !== null
          ? Number((first as Record<string, unknown>)['id'] ?? 0)
          : 0;
      } catch {
        // The session object exists before netcoredbg has finished attaching.
        return 0;
      }
    },
    (candidate) => candidate > 0,
    60_000,
    100,
  );
  assert.ok(threadId > 0, 'an attached process must expose a live thread before it can be paused');
  await session.customRequest('pause', { threadId });
  return threadId;
}

/**
 * Kill every child the attach suites spawned and wait until each is gone.
 *
 * Killing is asynchronous, and this suite resolves debuggees BY NAME.
 *
 * Signalling and moving on let the next test spawn a second `StepTarget`
 * while the previous one was still dying, so a name that must resolve to
 * exactly one pid briefly matched two and the attach refused to start.
 * Wait for each child to actually be gone ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 */
export async function killSpawned(): Promise<void> {
  const killed: number[] = [];
  while (spawned.length > 0) {
    const child = spawned.pop();
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      if (child.pid !== undefined) killed.push(child.pid);
    }
  }
  for (const pid of killed) {
    await pollUntilResult(
      async () => isAlive(pid),
      (alive) => !alive,
      SETTLE_MS,
      50,
    );
  }
}
