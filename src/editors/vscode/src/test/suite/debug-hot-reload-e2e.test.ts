// Hot Reload during an active debug session: edit, save, keep debugging.
//
// Implements [DEBUG-FEATURES-HOT-RELOAD] — its five-step architecture (the VFS
// detects a save, Roslyn's `WatchHotReloadService` produces deltas, the
// DapRouter applies them, subsequent calls use the new IL "without interrupting
// the session", and rude edits "report the reason and prompt a restart") and its
// "Supported hot reload edits" table.
//
// Every assertion here is about a RUNNING session. A hot reload that works by
// restarting the debuggee is not hot reload: the user loses their call stack,
// their locals, and the state they spent minutes reaching. So the session id is
// asserted unchanged across every edit.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE, type DebugFixture } from './debug-fixture-programs';
import { CMD_CONTINUE, assertStoppedAt, topFrame } from './debug-drive-kit';
import {
  armBreakpoints,
  assertRanToCompletion,
  refusalsOf,
  startDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { BUILD_TIMEOUT_MS } from './run-debug-kit';
import { deepEq, eq, requireAt, sleep } from './test-helpers';

/** Long enough for a save to reach Roslyn, produce deltas, and be applied. */
const RELOAD_SETTLE_MS = 8_000;

/** Anchors a test in this suite may rewrite; all are restored in teardown. */
const EDITABLE: readonly string[] = ['add-body', 'add-signature', 'total-field'];

/** Rewrite the whole line `anchor` addresses, then SAVE — the VFS trigger. */
async function rewriteLine(fixture: DebugFixture, anchor: string, code: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(fixture.uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(fixture.uri, document.lineAt(fixture.source.line(anchor)).range, code);
  const applied = await vscode.workspace.applyEdit(edit);
  assert.strictEqual(applied, true, `the edit on '${anchor}' must apply to the open document`);
  // Writing a line back over its own text leaves the document clean, and
  // `save()` answers false for a document with nothing to write.
  if (!document.isDirty) return;
  assert.strictEqual(await document.save(), true, 'the document must save — that is the trigger');
}

/** Put every editable line back to the text the fixture was built from. */
async function restoreFixture(fixture: DebugFixture): Promise<void> {
  for (const anchor of EDITABLE) {
    await rewriteLine(fixture, anchor, fixture.source.code(anchor));
  }
}

suite('Debug hot reload — editing a method while the debuggee is paused', () => {
  const debuggee = useDebuggee('debug-reload-cs-', 'csharp');

  // The fixture is REWRITTEN by these tests, so it is put back before each one
  // rather than after. A teardown could not do it: `useDebuggee`'s own teardown
  // is registered first, runs first, and releases the harness these lines are
  // read from — and a test that fails mid-edit would leave the next one running
  // against source its prebuilt assembly no longer matches.
  setup(async () => {
    await restoreFixture(debuggee().fixture);
  });

  // Implements [DEBUG-FEATURES-HOT-RELOAD] "Method body change | Yes" and
  // architecture steps 1–4.
  test('a method-body edit is applied to the LIVE session, without restarting it', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder, sessions } = debuggee();

    // Interaction 1 — pause before the method under edit is ever called.
    armBreakpoints(fixture, 'accumulate-entry');
    const session = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      extra: { hotReload: true },
    });
    eq(
      session.configuration['hotReload'],
      true,
      '[DEBUG-FEATURES-LAUNCH] lists "Hot Reload enabled launch | launch (hotReload: true)" and ' +
        '[DEBUG-FEATURES-LAUNCH-OUTPUT] rule 3 puts `hotReload` in the declared launch schema',
    );
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must pause before the loop runs');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'accumulate-entry',
      'Accumulate',
      'the pause before the edit',
    );

    // Interaction 2 — edit the method body and save.
    await rewriteLine(
      fixture,
      'add-body',
      '        var sum = left + right + 100;                                  // @anchor:add-body',
    );
    await sleep(RELOAD_SETTLE_MS);

    // Interaction 3 — the SESSION must have survived the edit intact.
    eq(
      vscode.debug.activeDebugSession?.id,
      session.id,
      'architecture step 4: "Subsequent calls use the new IL WITHOUT INTERRUPTING THE SESSION". ' +
        'A new session id means the debuggee was restarted and the user lost their state',
    );
    deepEq(
      recorder.events('terminated').map((event) => event.body),
      [],
      'no `terminated` event may be sent for a supported edit',
    );
    eq(sessions.ours.length, 1, 'exactly one session has existed across the edit');

    // Interaction 4 — continue: the NEW IL must be what runs.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a hot-reloaded session');
    const output = recorder.outputText();
    eq(
      output.includes('total=308'),
      true,
      'the reloaded body adds 100 per iteration: 2 -> 103 -> 205 -> 308. ' +
        `Output seen: ${JSON.stringify(output)}`,
    );
    eq(
      output.includes('total=8'),
      false,
      'the ORIGINAL IL must not have run: an edit that is accepted and then ignored is worse ' +
        'than one that is refused, because nothing tells the user their change did not apply',
    );
  });

  // Implements [DEBUG-FEATURES-HOT-RELOAD] "Add new method to existing type |
  // Yes (.NET 8+)" and "Add new static field | Yes (.NET 8+)".
  test('a new method added to an existing type is reachable from reloaded code', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — pause before the type is used.
    armBreakpoints(fixture, 'accumulate-entry');
    const session = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      extra: { hotReload: true },
    });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must pause before the loop runs');

    // Interaction 2 — add a method to the existing type, and call it.
    await rewriteLine(
      fixture,
      'total-field',
      '    public static int Total; public static int Bump(int value) => value + 1000; // @anchor:total-field',
    );
    await rewriteLine(
      fixture,
      'add-body',
      '        var sum = Bump(left + right);                                  // @anchor:add-body',
    );
    await sleep(RELOAD_SETTLE_MS);

    // Interaction 3 — the session must still be the same one.
    eq(
      vscode.debug.activeDebugSession?.id,
      session.id,
      '"Add new method to existing type" is a SUPPORTED edit on .NET 8+, so it must not force ' +
        'a restart',
    );
    deepEq(
      refusalsOf(debuggee().stubs),
      [],
      'a supported edit must not warn the user about anything',
    );

    // Interaction 4 — continue: the new method must be the one that runs.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session with a newly added method');
    eq(
      recorder.outputText().includes('total=3008'),
      true,
      'the new method adds 1000 per iteration: 2 -> 1003 -> 2005 -> 3008. ' +
        `Output seen: ${JSON.stringify(recorder.outputText())}`,
    );
  });

  // Implements [DEBUG-FEATURES-HOT-RELOAD] architecture step 5 and the
  // "Change method signature | No — requires restart" row.
  test('a rude edit is refused with a named reason and a restart prompt', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    const { fixture, recorder, stubs, sessions } = debuggee();

    // Interaction 1 — pause.
    armBreakpoints(fixture, 'accumulate-entry');
    const session = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      extra: { hotReload: true },
    });
    await recorder.waitForStops(1);
    deepEq(refusalsOf(debuggee().stubs), [], 'nothing has been reported before the edit');

    // Interaction 2 — change the method's SIGNATURE. The call site still
    // compiles (int widens to long), so this is a rude EDIT, not a build break.
    await rewriteLine(
      fixture,
      'add-signature',
      '    public static int Add(long left, int right)                        // @anchor:add-signature',
    );
    await rewriteLine(
      fixture,
      'add-body',
      '        var sum = (int)(left + right);                                 // @anchor:add-body',
    );
    await sleep(RELOAD_SETTLE_MS);

    // Interaction 3 — exactly one message, and it must say what to do.
    const reported = refusalsOf(debuggee().stubs);
    eq(
      reported.length,
      1,
      'architecture step 5: "Unsupported rude edits report the reason and prompt a restart". ' +
        'Silence is the defect — the user keeps debugging IL that no longer matches the source ' +
        `they are reading. Messages seen: ${JSON.stringify(reported)}`,
    );
    const message = requireAt(reported, 0, 'the rude-edit message');
    eq(
      message.toLowerCase().includes('restart'),
      true,
      `the message must prompt a restart, per step 5; it said: '${message}'`,
    );
    deepEq(stubs.log.infoMessages, [], 'a refused edit is not an informational notice');

    // Interaction 4 — the session must SURVIVE the refusal.
    eq(
      vscode.debug.activeDebugSession?.id,
      session.id,
      'a rude edit is refused, not fatal: killing the session on a rude edit throws away the ' +
        'state the user was inspecting without them ever choosing to restart',
    );
    eq(sessions.ours.length, 1, 'and no second session was started behind their back');
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await assertRanToCompletion(recorder, 0, 'a session after a refused rude edit');
    eq(
      recorder.outputText().includes('total=8'),
      true,
      'a refused edit leaves the ORIGINAL IL running, so the original result must appear',
    );
  });
});
