// The Call Stack panel: physical frames, per-frame state, source navigation,
// threads, and the logical async chain.
//
// Implements [DEBUG-FEATURES-STACK] ("Call stack display", "Navigate to source
// from frame", both P1) and [DEBUG-FEATURES-STACK-ASYNC] ("Logical async call
// stack | stackTrace (enriched) | P1").
//
// Clicking a frame in the Call Stack panel is `scopes` + `variables` against
// THAT frame's id — nothing else changes. So "selecting a caller shows the
// caller's state" is asserted by reading a non-zero frame id, which is exactly
// what the panel does.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  assertFrameSource,
  assertStoppedAt,
  localsOf,
  methodOf,
  stackFrames,
  threadsOf,
  topFrame,
  variableNamed,
  waitForActiveFrame,
} from './debug-drive-kit';
import { armBreakpoints, assertCleanSession, startDebuggee, useDebuggee } from './debug-suite-kit';
import { comparablePath, deepEq, eq, pollUntilResult, requireAt } from './test-helpers';
import { DEBUG_TEST_MS, LSP_RESPONSE_MS } from './test-timeouts';

/** The logical await chain the sidecar must reconstruct, innermost first. */
const ASYNC_CHAIN = ['LeafAsync', 'MiddleAsync', 'RootAsync'] as const;

/** Compiler-generated shapes the user must never be shown as a frame name. */
const GENERATED_HINTS: readonly string[] = ['MoveNext', 'd__'];

suite('Debug call stack — frames, per-frame state, threads and async chains', () => {
  const debuggee = useDebuggee('debug-stack-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-STACK] "Call stack display" and "Navigate to
  // source from frame", both P1.
  test('every physical frame is listed, named, located and navigable', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop three user frames deep.
    armBreakpoints(fixture, 'add-body');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint inside Add');
    assertStoppedAt(
      await topFrame(session, stop.threadId),
      fixture,
      'add-body',
      'Add',
      'the innermost frame',
    );

    // Interaction 2 — the chain must be complete and correctly ordered.
    const frames = await stackFrames(session, stop.threadId);
    assert.ok(
      frames.length >= 3,
      `at least three user frames must be reported; got ${frames.length}`,
    );
    deepEq(
      frames.slice(0, 3).map((frame) => methodOf(frame)),
      ['Add', 'Accumulate', 'Main'],
      'DAP orders `stackTrace` innermost-first; a reversed or truncated chain makes the Call ' +
        'Stack panel unusable for tracing how execution arrived here',
    );
    deepEq(
      frames.slice(0, 3).map((frame) => frame.line),
      [
        fixture.source.dapLine('add-body'),
        fixture.source.dapLine('accumulate-call'),
        fixture.source.dapLine('main-accumulate'),
      ],
      'each frame must be parked on the statement executing IN it',
    );
    deepEq(
      frames.slice(0, 3).map((frame) => frame.id > 0),
      [true, true, true],
      'every frame needs a non-zero id: it is the handle `scopes` and `evaluate` take',
    );
    eq(
      new Set(frames.slice(0, 3).map((frame) => frame.id)).size,
      3,
      'frame ids must be distinct, or selecting a caller reads the callee',
    );

    // Interaction 3 — "Navigate to source from frame": each frame must carry a
    // path that really exists, so clicking it opens the file.
    for (const frame of frames.slice(0, 3)) {
      assertFrameSource(frame, fixture, `the ${methodOf(frame)} frame`);
      eq(
        fs.existsSync(frame.sourcePath),
        true,
        `"Navigate to source from frame" is P1: ${frame.sourcePath} must exist on disk, or ` +
          'clicking the frame opens an empty editor',
      );
    }

    // Interaction 4 — the workbench must focus the innermost frame itself.
    const focused = await waitForActiveFrame();
    eq(focused.threadId, stop.threadId, 'the focused stack item must be on the stopped thread');
    eq(focused.session.id, session.id, 'and must belong to this session');
    eq(
      comparablePath(vscode.window.activeTextEditor?.document.uri.fsPath ?? ''),
      comparablePath(fixture.sourceFile),
      'stopping must reveal the debuggee source in the editor; leaving the previous document ' +
        'focused hides the instruction pointer the user is looking for',
    );
    assertCleanSession(debuggee(), 'reading the call stack');
  });

  // Implements [DEBUG-FEATURES-STACK] — selecting a frame is per-frame state.
  test('selecting a caller frame reads that frame’s own locals', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop in the innermost frame.
    armBreakpoints(fixture, 'add-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint');
    const frames = await stackFrames(session, stop.threadId);

    // Interaction 2 — the innermost frame's locals are Add's.
    const inner = requireAt(frames, 0, 'the Add frame');
    const innerLocals = await localsOf(session, inner.id);
    eq(variableNamed(innerLocals, 'sum').value, '3', 'Add computed 2 + 1');
    deepEq(
      innerLocals.map((local) => local.name).includes('running'),
      false,
      'the callee must not be shown its caller’s locals',
    );

    // Interaction 3 — click the CALLER: its locals are Accumulate's.
    const caller = requireAt(frames, 1, 'the Accumulate frame');
    const callerLocals = await localsOf(session, caller.id);
    eq(
      variableNamed(callerLocals, 'running').value,
      '2',
      'selecting a caller frame must read THAT frame’s state: `running` is still the seed ' +
        'because the assignment on this line has not completed',
    );
    eq(variableNamed(callerLocals, 'index').value, '1', 'and the loop is on its first iteration');
    deepEq(
      callerLocals.map((local) => local.name).includes('sum'),
      false,
      'the caller must not be shown the callee’s locals: that would mean `scopes` ignored the ' +
        'frame id and served whatever frame the adapter last stopped in',
    );

    // Interaction 4 — the outermost frame's locals are Main's.
    const outer = requireAt(frames, 2, 'the Main frame');
    const outerLocals = await localsOf(session, outer.id);
    eq(
      variableNamed(outerLocals, 'mode').value.includes(MODE.plain),
      true,
      'Main’s locals must include the argument it parsed',
    );
    eq(new Set([inner.id, caller.id, outer.id]).size, 3, 'three frames, three distinct handles');
    assertCleanSession(debuggee(), 'selecting frames');
  });

  // Implements [DEBUG-FEATURES-STACK-ASYNC] "Logical async call stack |
  // stackTrace (enriched) | P1".
  test('an awaited chain reports the LOGICAL async stack, not raw MoveNext frames', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop at the bottom of a three-deep await chain.
    armBreakpoints(fixture, 'leaf-return');
    const session = await startDebuggee(debuggee(), { mode: MODE.async });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint inside LeafAsync');
    const frame = await topFrame(session, stop.threadId);
    assertStoppedAt(frame, fixture, 'leaf-return', 'LeafAsync', 'the innermost async frame');

    // Interaction 2 — the awaiters must appear, in await order.
    //
    // Read the stack until the chain is THERE, rather than once and hope. The
    // DapRouter and the C# sidecar reconstruct the logical frames, so a
    // `stackTrace` answered before the sidecar has the debuggee's project
    // loaded forwards netcoredbg's physical frames untouched. Reading once made
    // this a race whose failure ("Frames reported: LeafAsync") is a dangerous
    // ambiguity: it looks identical to the reconstruction being broken. The
    // poll's own message names the frames it actually saw, and its budget sits
    // below this test's ceiling ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    const names = await pollUntilResult(
      async () => (await stackFrames(session, stop.threadId)).map((c) => methodOf(c)),
      (seen) => ASYNC_CHAIN.every((wanted) => seen.includes(wanted)),
      LSP_RESPONSE_MS,
    );
    // Re-read once the chain is present, for the assertions below that need the
    // frames themselves rather than their names.
    const frames = await stackFrames(session, stop.threadId);
    deepEq(
      ASYNC_CHAIN.filter((wanted) => names.includes(wanted)),
      [...ASYNC_CHAIN],
      '[DEBUG-FEATURES-STACK-ASYNC]: netcoredbg reports physical MoveNext frames; the ' +
        'DapRouter and the C# sidecar MUST reconstruct the logical chain and inject the ' +
        `awaiting frames before forwarding \`stackTrace\`. Frames reported: ${names.join(' <- ')}`,
    );
    eq(
      names.indexOf('MiddleAsync') > names.indexOf('LeafAsync'),
      true,
      'the awaiter must sit BELOW the awaited frame: a chain in the wrong order tells the ' +
        'user the opposite of what happened',
    );
    eq(
      names.indexOf('RootAsync') > names.indexOf('MiddleAsync'),
      true,
      'and the whole chain must be ordered, not just its first pair',
    );

    // Interaction 3 — compiler machinery must not leak into the panel.
    deepEq(
      frames
        .map((current) => current.name)
        .filter((name) => GENERATED_HINTS.some((hint) => name.includes(hint))),
      [],
      'a frame named `<RootAsync>d__3.MoveNext` is the RAW physical stack. The reconstruction ' +
        'exists precisely so the user sees their own method names',
    );

    // Interaction 4 — the awaiting frames must be inspectable, not decorative.
    const middle = frames.find((current) => methodOf(current) === 'MiddleAsync');
    assert.ok(middle, 'the MiddleAsync frame must be present to be inspected');
    assertFrameSource(middle, fixture, 'the reconstructed awaiting frame');
    eq(
      variableNamed(await localsOf(session, middle.id), 'seed').value,
      '1',
      'an injected logical frame must still serve `scopes`/`variables` for its own state; a ' +
        'frame that cannot be inspected is a label, not a call stack entry',
    );
    await vscode.commands.executeCommand(CMD_CONTINUE);
    assertCleanSession(debuggee(), 'an async call stack');
  });

  // Implements [DEBUG-FEATURES-STACK] — the thread list the panel groups by.
  test('threads are enumerated and the stopped thread is identified', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop anywhere.
    armBreakpoints(fixture, 'main-accumulate');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint');

    // Interaction 2 — `threads` must list the thread the stop named.
    const threads = await threadsOf(session);
    assert.ok(threads.length > 0, 'a running .NET process has at least a main thread');
    const ids = threads.map((thread) => Number(thread['id']));
    eq(
      ids.includes(stop.threadId),
      true,
      `the stopped thread ${stop.threadId} must appear in the \`threads\` response; the Call ` +
        `Stack panel groups by it. Reported: ${ids.join(', ')}`,
    );
    deepEq(
      threads.map((thread) => String(thread['name']).trim() === ''),
      threads.map(() => false),
      'every thread needs a name; an unnamed thread renders as a blank row',
    );
    eq(new Set(ids).size, ids.length, 'thread ids must be unique');

    // Interaction 3 — the stop must say whether it froze the world.
    eq(
      typeof stop.allThreadsStopped,
      'boolean',
      'DAP `allThreadsStopped` tells the panel whether the other threads are still running',
    );
    const focused = await waitForActiveFrame();
    eq(focused.threadId, stop.threadId, 'the focused frame is on the thread that stopped');
    assertCleanSession(debuggee(), 'enumerating threads');
  });
});
