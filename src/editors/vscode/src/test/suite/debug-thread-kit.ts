// The thread a debugging gesture acts on: waiting for the workbench's focus to
// reach it, and checking the request the gesture then put on the wire.
//
// `vscode.debug.activeStackItem` is the thread or frame the workbench acts on:
// the yellow instruction pointer is drawn from it, and F10 / F11 / Shift+F11 step
// it. VS Code moves it AFTER a `stopped` event, once it has fetched the stopped
// thread's top frame, so a driver that reads the wire directly is ahead of the
// focus and must wait for it before making a gesture.
//
// Spec: [DEBUG-FEATURES-STEPPING], [DEBUG-FEATURES-STACK].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DapRecorder } from './debug-dap-kit';
import { pollUntilResult } from './test-helpers';
import { DEBUG_SESSION_MS, SETTLE_MS } from './test-timeouts';

/** Wait until VS Code's own stack-item focus catches up with the adapter. */
export async function waitForActiveFrame(
  timeoutMs = DEBUG_SESSION_MS,
): Promise<vscode.DebugStackFrame> {
  const item = await pollUntilResult(
    async () => vscode.debug.activeStackItem,
    (current) => current instanceof vscode.DebugStackFrame,
    timeoutMs,
    50,
  );
  assert.ok(
    item instanceof vscode.DebugStackFrame,
    'a stopped session must focus a stack frame; `vscode.debug.activeStackItem` is what the ' +
      'editor uses to place the yellow instruction pointer, so an unfocused stop leaves the ' +
      'user staring at an unmarked file',
  );
  return item;
}

/** The session and thread the workbench currently focuses — small enough to print on a timeout. */
function focusedThread(): { sessionId: string | undefined; threadId: number | undefined } {
  const item = vscode.debug.activeStackItem;
  return { sessionId: item?.session.id, threadId: item?.threadId };
}

/**
 * Wait until the workbench focuses `threadId` in `session`.
 *
 * This is the focus F10, F11 and Shift+F11 act on. It lands one `stackTrace`
 * round trip after the `stopped` event, which is workbench settling rather than
 * a command round trip — hence `SETTLE_MS`, and a healthy run never spends it.
 * A larger budget would only push the step's own wait past the test ceiling.
 * When it runs out, `pollUntilResult` reports the last `{ sessionId, threadId }`
 * the workbench focused, which is the diagnosis: which thread F10 would have
 * stepped instead.
 */
export async function waitForFocusOn(
  session: vscode.DebugSession,
  threadId: number,
  timeoutMs = SETTLE_MS,
): Promise<void> {
  await pollUntilResult(
    async () => focusedThread(),
    (focus) => focus.sessionId === session.id && focus.threadId === threadId,
    timeoutMs,
    50,
  );
}

/**
 * Assert the gesture put exactly one `request` on the wire, naming `threadId`.
 *
 * Sound because the command's promise resolves only after the adapter has
 * ANSWERED the request, and the tracker records a request before it leaves the
 * workbench — so by the time the gesture returns, the request is on the record.
 * Counting from `sentBefore` keeps an earlier request, or one made by another
 * tracked session, from standing in for this gesture's.
 */
export function assertSteppedThread(
  recorder: DapRecorder,
  request: string,
  sentBefore: number,
  threadId: number,
): void {
  const sent = recorder.requests(request);
  assert.strictEqual(
    sent.length,
    sentBefore + 1,
    `the gesture must send exactly one '${request}' request; it sent ${String(sent.length - sentBefore)}`,
  );
  const stepped = sent[sent.length - 1]!.args['threadId'];
  assert.strictEqual(
    Number(stepped),
    threadId,
    `'${request}' must step the thread the debuggee stopped on (${String(threadId)}), ` +
      `not thread ${String(stepped)}`,
  );
}
