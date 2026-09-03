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
  CMD_STEP_INTO,
  CMD_STEP_OUT,
  assertFrameSource,
  assertStoppedAt,
  localsOf,
  methodOf,
  stackFrames,
  stepToFrame,
  threadsOf,
  topFrame,
  variableNamed,
  waitForActiveFrame,
} from './debug-drive-kit';
import { armBreakpoints, assertCleanSession, startDebuggee, useDebuggee } from './debug-suite-kit';
import { comparablePath, deepEq, eq, neq, pollUntilResult, requireAt } from './test-helpers';
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
    // Interaction 5 - the stack was READ, not inferred: the request went out
    // and came back, and the workbench focused a frame off the back of it.
    eq(
      recorder.requests('stackTrace').length >= 1,
      true,
      'the workbench really asked for the stack',
    );
    eq(
      recorder.responses('stackTrace').every((response) => response.success),
      true,
      'and the adapter answered',
    );
    eq(
      recorder.requests('threads').length >= 1,
      true,
      'after enumerating the threads it belongs to',
    );
    eq(recorder.stops().length, 1, 'with the debuggee paused exactly once');
    deepEq(recorder.errors, [], 'and no adapter transport error');
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
    // Interaction 4 - selecting a caller is `scopes` + `variables` against THAT
    // frame id, and nothing else changes.
    eq(recorder.requests('scopes').length >= 1, true, 'the caller frame scopes were read');
    eq(recorder.requests('variables').length >= 1, true, 'and its variables');
    eq(
      recorder.responses('variables').every((response) => response.success),
      true,
      'each answered successfully',
    );
    eq(recorder.stops().length, 1, 'without resuming the debuggee');
    deepEq(recorder.errors, [], 'and with no adapter transport error');
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
    // Interaction 4 - the async reconstruction happens on the STACK response,
    // so the request must have gone out and been answered.
    eq(recorder.requests('stackTrace').length >= 1, true, 'the async stack was read');
    eq(
      recorder.responses('stackTrace').every((response) => response.success),
      true,
      'and answered',
    );
    eq(recorder.stops().length >= 1, true, 'from a real stop');
    eq(recorder.events('terminated').length <= 1, true, 'in a session that ended at most once');
    deepEq(recorder.errors, [], 'with no adapter transport error');
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
    // Interaction 4 - threads are what the Call Stack panel groups by, so the
    // enumeration is load-bearing rather than incidental.
    eq(recorder.requests('threads').length >= 1, true, 'the threads were enumerated');
    eq(
      recorder.responses('threads').every((response) => response.success),
      true,
      'and the request answered',
    );
    eq(
      recorder.stops().every((entry) => entry.threadId !== 0),
      true,
      'every stop named a thread',
    );
    eq(recorder.events('terminated').length <= 1, true, 'and the session ended at most once');
    deepEq(recorder.exits, [], 'with the adapter process alive throughout');
  });

  // Implements [DEBUG-FEATURES-STEPPING] "Just My Code (skip non-user code) |
  // launch config | P1" as the Call Stack panel sees it: the user own frames
  // must be distinguishable from the runtime frames beneath them. A stack in
  // which every frame looks like user code is a stack the user has to read the
  // paths off to navigate.
  test('the user frames are distinguishable from the runtime frames beneath them', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop three user frames deep, so there are runtime frames
    // under them.
    armBreakpoints(fixture, 'add-body');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain, justMyCode: true });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint inside Add');
    const frames = await stackFrames(session, stop.threadId);
    eq(frames.length >= 3, true, 'at least the three user frames are reported');

    // Interaction 2 — the user frames: all in the fixture file, all named after
    // a method the fixture declares, all with a real line.
    const declared = ['Add', 'Accumulate', 'Main'];
    const userFrames = frames.filter((frame) => {
      return comparablePath(frame.sourcePath) === comparablePath(fixture.sourceFile);
    });
    eq(userFrames.length >= 3, true, 'three frames resolve to the file the user wrote');
    for (const frame of userFrames) {
      eq(declared.includes(methodOf(frame)), true, methodOf(frame) + ' is a fixture method');
      eq(frame.line > 0, true, methodOf(frame) + ' carries a 1-based line to navigate to');
      eq(fs.existsSync(frame.sourcePath), true, methodOf(frame) + ' source exists on disk');
      eq(frame.id > 0, true, methodOf(frame) + ' carries a usable frame handle');
    }

    // Interaction 3 — and no frame the user is shown may be named after a
    // compiler-generated shape. `MoveNext` and `<Method>d__N` are the two the
    // specification calls out by name.
    for (const frame of userFrames) {
      for (const hint of GENERATED_HINTS) {
        eq(
          frame.name.includes(hint),
          false,
          'a frame the user reads must not be named after the compiler-generated shape ' +
            hint +
            '; DAP reported ' +
            JSON.stringify(frame.name),
        );
      }
    }
    eq(
      new Set(frames.map((frame) => frame.id)).size,
      frames.length,
      'every frame in the whole stack carries a DISTINCT handle, or selecting one reads another',
    );
    eq(
      frames.filter((frame) => {
        return comparablePath(frame.sourcePath) !== comparablePath(fixture.sourceFile);
      }).length >= 1,
      true,
      'and the runtime frames really are present beneath them - a stack that stopped at Main ' +
        'is a truncated stack, not a filtered one',
    );
    assertCleanSession(debuggee(), 'distinguishing user frames');
    // Interaction 4 - Just My Code is a LAUNCH attribute, so it has to have
    // travelled with the launch this stack belongs to.
    eq(recorder.requests('launch').length, 1, 'one launch request for one session');
    eq(
      recorder.responses('launch').every((response) => response.success),
      true,
      'answered successfully',
    );
    eq(recorder.requests('stackTrace').length >= 1, true, 'and the stack really was read from it');
    eq(recorder.stops().length, 1, 'with the debuggee paused once');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  // The project HARD RULE that every screen is reactive, applied to the Call
  // Stack panel: a step changes the stack, and the panel must re-read it. A
  // stack cached at the first stop points the user at the wrong line for the
  // rest of the session.
  test('the stack is re-read after every step and tracks the new position', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop at the top of the loop body.
    armBreakpoints(fixture, 'accumulate-call');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the call inside the loop');
    const before = await stackFrames(session, stop.threadId);
    eq(methodOf(requireAt(before, 0, 'the first frame')), 'Accumulate', 'stopped in the caller');
    eq(
      requireAt(before, 0, 'the first frame').line,
      fixture.source.dapLine('accumulate-call'),
      'on the call statement',
    );

    // Interaction 2 — step INTO. The stack must be one frame deeper, and the
    // innermost frame must be the callee, on the callee first line.
    const into = await stepToFrame(recorder, CMD_STEP_INTO);
    const deeper = await stackFrames(session, into.stop.threadId);
    eq(deeper.length, before.length + 1, 'a step into pushes exactly one frame');
    eq(methodOf(requireAt(deeper, 0, 'the new innermost frame')), 'Add', 'and the callee is it');
    eq(
      requireAt(deeper, 0, 'the new innermost frame').line,
      fixture.source.dapLine('add-body'),
      'parked on the callee first statement',
    );
    eq(
      methodOf(requireAt(deeper, 1, 'the caller frame')),
      'Accumulate',
      'with the caller directly beneath',
    );
    neq(
      requireAt(deeper, 0, 'the new innermost frame').id,
      requireAt(before, 0, 'the old innermost frame').id,
      'and a fresh frame handle - reusing the old one is how a cached panel presents',
    );

    // Interaction 3 — step OUT. The stack must shrink back to exactly what it
    // was, and the panel must be readable at every point in between.
    const out = await stepToFrame(recorder, CMD_STEP_OUT);
    const shallower = await stackFrames(session, out.stop.threadId);
    eq(shallower.length, before.length, 'a step out pops exactly the frame it entered');
    eq(
      methodOf(requireAt(shallower, 0, 'the frame after stepping out')),
      'Accumulate',
      'back in the caller',
    );
    deepEq(
      shallower.slice(0, 2).map((frame) => methodOf(frame)),
      before.slice(0, 2).map((frame) => methodOf(frame)),
      'and the whole visible chain is what it was before the excursion',
    );
    eq(
      variableNamed(await localsOf(session, requireAt(shallower, 0, 'the frame').id), 'index')
        .value,
      '1',
      'with the caller own loop state still readable, still on the first pass',
    );
    eq(recorder.stops().length, 3, 'three stops: the breakpoint, the step in, the step out');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    assertCleanSession(debuggee(), 're-reading the stack after each step');
    // Interaction 4 - three stack reads, one per stop, each its own round trip.
    // A cached stack would show as fewer requests than stops.
    eq(recorder.requests('stackTrace').length >= 3, true, 'the stack was re-read after each step');
    eq(
      recorder.responses('stackTrace').every((response) => response.success),
      true,
      'each read answered',
    );
    eq(recorder.requests('stepIn').length >= 1, true, 'the step into really reached the adapter');
    eq(recorder.requests('stepOut').length >= 1, true, 'and so did the step out');
    eq(recorder.stops().length, 3, 'with exactly three stops behind them');
  });

  // Implements [DEBUG-FEATURES-STACK] "Call stack display | stackTrace | P1"
  // read TWICE. A stopped process is not moving, so two reads must agree; a
  // stack that differs between reads means the adapter is answering from
  // something other than the process.
  test('reading the same stopped stack twice answers identically, frame for frame', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — one deep stop.
    armBreakpoints(fixture, 'add-body');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the breakpoint inside Add');
    const first = await stackFrames(session, stop.threadId);
    eq(first.length >= 3, true, 'the stop is at least three user frames deep');

    // Interaction 2 — read it again. Names, lines and sources must match.
    const second = await stackFrames(session, stop.threadId);
    eq(second.length, first.length, 'the same stopped stack has the same depth on both reads');
    deepEq(
      second.map((frame) => methodOf(frame)),
      first.map((frame) => methodOf(frame)),
      'and the same frames, in the same order',
    );
    deepEq(
      second.map((frame) => frame.line),
      first.map((frame) => frame.line),
      'each parked on the same line',
    );
    deepEq(
      second.map((frame) => comparablePath(frame.sourcePath)),
      first.map((frame) => comparablePath(frame.sourcePath)),
      'and attributed to the same source',
    );

    // Interaction 3 — and the frames of the second read are usable: their
    // locals must read the same values as the first read.
    const firstTop = requireAt(first, 0, 'the first read innermost frame');
    const secondTop = requireAt(second, 0, 'the second read innermost frame');
    deepEq(
      (await localsOf(session, secondTop.id)).map((local) => local.name + '=' + local.value),
      (await localsOf(session, firstTop.id)).map((local) => local.name + '=' + local.value),
      'and reading either handle gives the same locals',
    );
    const threads = await threadsOf(session);
    eq(threads.length >= 1, true, 'the stopped process reports its threads');
    eq(
      threads.some((thread) => Number(thread['id']) === stop.threadId),
      true,
      'including the one that stopped, which is what the panel groups the stack under',
    );
    eq(
      threads.every((thread) => String(thread['name'] ?? '') !== ''),
      true,
      'and every thread is named, or the Call Stack panel shows an unlabelled group',
    );
    assertCleanSession(debuggee(), 'reading a stopped stack twice');
    // Interaction 4 - two reads of one stopped stack are two REQUESTS, and both
    // were answered. A cached second read would show as one.
    eq(recorder.requests('stackTrace').length >= 2, true, 'the stack really was read twice');
    eq(recorder.responses('stackTrace').length >= 2, true, 'and answered twice');
    eq(
      recorder.responses('stackTrace').every((response) => response.success),
      true,
      'both successfully',
    );
    eq(recorder.stops().length, 1, 'from the one stop');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });
});
