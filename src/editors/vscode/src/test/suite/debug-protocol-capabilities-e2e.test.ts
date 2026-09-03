// The DAP handshake and the capability table, read off the live adapter.
//
// Implements [DEBUG-PROTOCOL] ("SharpLsp targets DAP specification version
// 1.71.0") and [DEBUG-PROTOCOL-CAPABILITIES] — that section IS a table of
// `initialize`-response flags, so it is asserted here row by row, in both
// directions.
//
// Over-claiming is as harmful as under-claiming. VS Code enables UI purely from
// these flags: advertise `supportsStepBack` and the toolbar grows reverse-step
// buttons that do nothing; advertise `supportsDataBreakpoints` and the Variables
// panel offers "Break on Value Change" for a feature the Phase Four column marks
// "No". So the No rows are asserted too.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ENV_PROBE, ENV_UNSET, MODE } from './debug-fixture-programs';
import {
  CMD_CONTINUE,
  CMD_STOP,
  evaluate,
  scopesOf,
  stackFrames,
  threadsOf,
  variableNamed,
  variablesOf,
} from './debug-drive-kit';
import { armBreakpoints, assertCleanSession, startDebuggee, useDebuggee } from './debug-suite-kit';
import { DEBUG_TYPE_ID } from './run-debug-kit';
import { comparablePath, deepEq, eq, neq, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS } from './test-timeouts';

/** The Phase Four column of [DEBUG-PROTOCOL-CAPABILITIES], "Yes" rows. */
const PHASE_FOUR_YES: readonly { flag: string; note: string }[] = [
  { flag: 'supportsConditionalBreakpoints', note: 'C# expression condition' },
  { flag: 'supportsHitConditionalBreakpoints', note: '>, >=, ==, % operators' },
  { flag: 'supportsLogPoints', note: 'Phase 4: conditional bp + continue (emulated)' },
  { flag: 'supportsEvaluateForHovers', note: 'Expression evaluation in hover' },
  { flag: 'supportsSetVariable', note: 'Modify variable values at breakpoint' },
  { flag: 'supportsExceptionOptions', note: 'Filter by type, user code, etc.' },
  { flag: 'supportsTerminateRequest', note: 'graceful stop from the debug toolbar' },
  { flag: 'supportsRestartRequest', note: 'the Restart button' },
  { flag: 'supportsVariableType', note: 'the Variables panel type column' },
  { flag: 'supportsANSIStyling', note: 'DAP 1.69+ terminal color output' },
  { flag: 'supportsGotoTargetsRequest', note: 'Run to cursor via goto' },
];

/** The Phase Four column's "No" rows — Phase 5 or later, or out of scope. */
const PHASE_FOUR_NO: readonly { flag: string; note: string }[] = [
  { flag: 'supportsRestartFrame', note: 'Phase 5: ICorDebugILFrame::SetIP' },
  { flag: 'supportsStepBack', note: 'P3 — post Phase 5; requires runtime support' },
  { flag: 'supportsDataBreakpoints', note: 'Phase 5: field value polling / watchpoints' },
  { flag: 'supportsReadMemoryRequest', note: 'Phase 5: raw memory inspection' },
  { flag: 'supportsWriteMemoryRequest', note: 'Phase 5: raw memory write' },
  { flag: 'supportsSingleThreadExecutionRequests', note: 'Phase 5' },
  { flag: 'supportsInstructionBreakpoints', note: 'Phase 5: IL offset breakpoints' },
  { flag: 'supportsCompletionsRequest', note: 'Phase 5: via the Roslyn C# sidecar' },
  { flag: 'supportsLocationReference', note: 'Phase 5: DAP 1.68+ location navigation' },
];

/** The DAP handshake order [DEBUG-PROTOCOL] pins, as request command names. */
const HANDSHAKE_PREFIX: readonly string[] = ['initialize', 'launch'];

suite('Debug protocol — the DAP 1.71.0 handshake and the capability table', () => {
  const debuggee = useDebuggee('debug-caps-cs-', 'csharp');

  // Implements [DEBUG-PROTOCOL-CAPABILITIES], the Phase Four "Yes" column.
  test('every Phase Four capability the table marks Yes is advertised', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a real session, so the handshake is real.
    armBreakpoints(fixture, 'main-accumulate');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    await recorder.waitForStops(1);
    const capabilities = recorder.capabilities();
    eq(typeof capabilities, 'object', 'the initialize response must carry a capabilities body');

    // Interaction 2 — every Yes row, asserted individually so the failure names
    // the row that regressed rather than "the table changed".
    for (const { flag, note } of PHASE_FOUR_YES) {
      eq(
        capabilities[flag],
        true,
        `${flag} (${note}) is marked Yes for Phase 4. VS Code builds its debug UI from the ` +
          'initialize response alone, so an unadvertised capability is an ABSENT feature no ' +
          'matter what the adapter can actually do',
      );
    }
    eq(
      PHASE_FOUR_YES.filter(({ flag }) => capabilities[flag] !== true).length,
      0,
      'and not one of the Yes rows is missing',
    );
    eq(
      new Set(PHASE_FOUR_YES.map(({ flag }) => flag)).size,
      PHASE_FOUR_YES.length,
      'the table itself lists each flag once - a duplicated row asserts nothing twice over',
    );

    // Interaction 3 — a capability the table marks Partial must still be there.
    eq(
      capabilities['supportsDisassembleRequest'],
      true,
      'the table marks supportsDisassembleRequest "Partial" for Phase 4; Partial is not None, ' +
        'and without the flag the Disassembly view cannot be opened at all',
    );

    // Interaction 4 — the exception filters that back the Yes rows.
    const filters: unknown = capabilities['exceptionBreakpointFilters'];
    assert.ok(Array.isArray(filters), 'exception filters must accompany supportsExceptionOptions');
    assert.ok(filters.length >= 2, 'at least "all" and an unhandled-only filter must be offered');
    assertCleanSession(debuggee(), 'reading the Yes column');
    // Interaction 5 - the capability body must be a real object with real
    // flags, not an empty bag that trivially satisfies every "No" assertion.
    eq(Object.keys(recorder.capabilities()).length >= 10, true, 'the initialize response carries a populated capability body');
    eq(recorder.responses('initialize').length, 1, 'answered exactly once');
    eq(recorder.responses('initialize').every((response) => response.success), true, 'and successfully');
    eq(recorder.events('initialized').length, 1, 'with one initialized event unlocking configuration');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  // Implements [DEBUG-PROTOCOL-CAPABILITIES], the Phase Four "No" column.
  test('no Phase Five capability is over-claimed in Phase Four', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a real session.
    armBreakpoints(fixture, 'main-accumulate');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    await recorder.waitForStops(1);
    const capabilities = recorder.capabilities();

    // Interaction 2 — every No row.
    for (const { flag, note } of PHASE_FOUR_NO) {
      neq(
        capabilities[flag],
        true,
        `${flag} (${note}) is "No" in the Phase Four column. Advertising it enables the ` +
          'matching VS Code affordance — reverse-step buttons, "Break on Value Change", the ' +
          'memory viewer — for a feature that is not implemented, which is a worse experience ' +
          'than its absence',
      );
    }
    eq(
      PHASE_FOUR_NO.filter(({ flag }) => capabilities[flag] === true).length,
      0,
      'and not one of the No rows is over-claimed',
    );
    eq(
      PHASE_FOUR_NO.some(({ flag }) => PHASE_FOUR_YES.some((row) => row.flag === flag)),
      false,
      'no flag may appear in both columns — the table would then assert nothing at all',
    );

    // Interaction 3 — the gaps [DEBUG-ADAPTER-GAPS] records must not be papered
    // over by claiming a capability whose implementation is a no-op.
    eq(
      capabilities['supportsStepBack'],
      undefined,
      'the table marks supportsStepBack "No" in BOTH phases: it requires runtime support that ' +
        'does not exist, so the flag must be absent rather than present-and-false-adjacent',
    );
    assertCleanSession(debuggee(), 'reading the No column');
    // Interaction 4 - the No column is only meaningful against a populated Yes
    // column. An adapter advertising nothing satisfies every No row vacuously.
    eq(PHASE_FOUR_YES.filter(({ flag }) => recorder.capabilities()[flag] === true).length, PHASE_FOUR_YES.length, 'every Yes row really is advertised');
    eq(Object.keys(recorder.capabilities()).length >= 10, true, 'so the capability body is genuinely populated');
    eq(recorder.responses('initialize').length, 1, 'from one initialize response');
    eq(recorder.events('initialized').length, 1, 'and one initialized event');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-PROTOCOL]: the dialect the workbench and adapter agree on.
  test('the initialize request pins the dialect the whole suite depends on', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a real session.
    armBreakpoints(fixture, 'main-accumulate');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    await recorder.waitForStops(1);

    // Interaction 2 — the adapter must be addressed by the shipped type id.
    const initialize = requireAt(recorder.requests('initialize'), 0, 'the initialize request');
    eq(
      initialize.args['adapterID'],
      DEBUG_TYPE_ID,
      '[DEBUG-FEATURES-LAUNCH-OUTPUT] rule 4: the debug type is a single value across the ' +
        'manifest, the constants module and the specification',
    );

    // Interaction 3 — the numbering the whole suite's line assertions rest on.
    eq(
      initialize.args['linesStartAt1'],
      true,
      'VS Code negotiates 1-based lines; every DAP line in this suite is read as 1-based and ' +
        'every editor position as 0-based, and the two must not be confused',
    );
    eq(initialize.args['columnsStartAt1'], true, 'columns are 1-based too');
    eq(
      initialize.args['pathFormat'],
      'path',
      'source locations must travel as filesystem paths, not as opaque source references — ' +
        'that is what makes "Navigate to source from frame" work without a `source` round-trip',
    );

    // Interaction 4 — the handshake must be ordered, not merely complete.
    const order = recorder.requestOrder();
    deepEq(
      order.slice(0, HANDSHAKE_PREFIX.length),
      [...HANDSHAKE_PREFIX],
      `the DAP launch sequence begins with initialize then launch; observed: ${order.join(' -> ')}`,
    );
    eq(
      order.includes('configurationDone'),
      true,
      'the workbench must finish configuration with `configurationDone`; without it the ' +
        'adapter never learns that breakpoint setup is complete and may resume too early',
    );
    eq(
      order.indexOf('configurationDone') > order.indexOf('setBreakpoints'),
      true,
      'breakpoints must be configured BEFORE configurationDone, or the debuggee races past ' +
        `them on startup; observed: ${order.join(' -> ')}`,
    );
    eq(
      recorder.events('initialized').length,
      1,
      'the adapter must send exactly one `initialized` event: it is what unlocks the ' +
        'configuration phase',
    );
    assertCleanSession(debuggee(), 'the DAP handshake');
    // Interaction 5 - the handshake is a SEQUENCE, and every step of it was
    // answered. An unanswered step leaves the session half-configured.
    eq(recorder.responses('initialize').every((response) => response.success), true, 'initialize was answered successfully');
    eq(recorder.responses('launch').every((response) => response.success), true, 'and launch');
    eq(recorder.responses('setBreakpoints').every((response) => response.success), true, 'and every breakpoint sync');
    eq(recorder.responses('configurationDone').every((response) => response.success), true, 'and configurationDone');
    deepEq(recorder.exits, [], 'with the adapter process alive throughout');
  });

  // Implements [DEBUG-FEATURES-LAUNCH]: "Pass args, env, cwd, program",
  // "Launch with environment variables | launch (env) | P1" and "Launch with
  // custom working directory | launch (cwd) | P1". A launch attribute the
  // workbench drops is a launch configuration the user wrote for nothing.
  test('the launch request carries every attribute the configuration declared', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — launch with a mode argument and an environment probe.
    armBreakpoints(fixture, 'main-env');
    await startDebuggee(debuggee(), {
      mode: MODE.plain,
      justMyCode: true,
      env: { [ENV_PROBE]: 'capabilities-probe' },
    });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the statement that reads the environment');

    // Interaction 2 — the request the workbench actually sent.
    const launch = requireAt(recorder.requests('launch'), 0, 'the launch request');
    eq(String(launch.args['type'] ?? ''), DEBUG_TYPE_ID, 'launched as the shipped debug type');
    eq(
      comparablePath(String(launch.args['program'] ?? '')),
      comparablePath(fixture.dll),
      'the program attribute must address the built assembly, not the project',
    );
    eq(
      typeof launch.args['cwd'],
      'string',
      'a working directory must be sent; without it the debuggee resolves relative paths ' +
        'against whatever directory the extension host happens to be in',
    );
    deepEq(launch.args['args'], [MODE.plain], 'argv is forwarded verbatim, in order');
    eq(launch.args['justMyCode'], true, 'and Just My Code, a P1 launch-config row, travels too');
    const env: unknown = launch.args['env'];
    assert.ok(typeof env === 'object' && env !== null, 'env must travel as an object');
    eq(
      (env as Record<string, unknown>)[ENV_PROBE],
      'capabilities-probe',
      'with the variable the configuration set',
    );

    // Interaction 3 — and the debuggee must actually SEE it. An env block the
    // adapter accepted and dropped is indistinguishable from one it honoured,
    // until the program reads the variable.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await recorder.waitForOutput('env=capabilities-probe');
    eq(
      recorder.outputText().includes('env=capabilities-probe'),
      true,
      'the launched process really ran with the environment the user configured',
    );
    eq(
      recorder.outputText().includes(ENV_UNSET),
      false,
      'and not with the fixture default, which is what a dropped env block would show',
    );
    assertCleanSession(debuggee(), 'a launch carrying every attribute');
    // Interaction 4 - the launch attributes travelled INSIDE one launch
    // request, and the session that carried them was a complete one.
    eq(recorder.requests('launch').length, 1, 'exactly one launch request for one session');
    eq(recorder.events('initialized').length, 1, 'behind one initialized event');
    eq(recorder.requestedCommands().includes('configurationDone'), true, 'with configuration finished');
    eq(recorder.stops().length >= 1, true, 'and the debuggee really reached the gate');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-PROTOCOL]: the five requests EVERY debug panel is built
  // on. A capability flag says the adapter claims to support something; these
  // are the round trips that say it does.
  test('the adapter answers threads, stackTrace, scopes, variables and evaluate', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — one real stop, which is what every panel renders from.
    armBreakpoints(fixture, 'accumulate-store');
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the statement');
    neq(stop.threadId, 0, 'the stop names a thread, which is what the Call Stack view keys on');
    eq(stop.allThreadsStopped, true, 'and a full stop, not a single-thread one Phase 4 disclaims');

    // Interaction 2 — Call Stack: threads, then frames, then scopes.
    const threads = await threadsOf(session);
    eq(threads.length >= 1, true, 'a stopped process has at least one thread to show');
    eq(
      threads.some((thread) => Number(thread['id']) === stop.threadId),
      true,
      'and the stopped thread is among them - a Call Stack view cannot render otherwise',
    );
    const frames = await stackFrames(session, stop.threadId);
    eq(frames.length >= 2, true, 'the stop is inside a call, so there are frames beneath it');
    const frame = requireAt(frames, 0, 'the top frame');
    eq(frame.line > 0, true, 'the top frame carries a 1-based line');
    eq(frame.column > 0, true, 'and a 1-based column');
    const scopes = await scopesOf(session, frame.id);
    eq(scopes.length >= 1, true, 'the Variables panel needs at least one scope');
    const locals = scopes.find((scope) => scope.name.toLowerCase().includes('local'));
    assert.ok(locals, 'and one of them must be Locals');
    eq(locals.expensive, false, 'which must not be marked expensive, or the panel will not open');

    // Interaction 3 — Variables and Watch, over the SAME frame.
    const variables = await variablesOf(session, locals.reference);
    eq(variables.length >= 1, true, 'the locals scope holds the variables in scope');
    eq(
      variables.every((variable) => variable.name !== ''),
      true,
      'every variable is named - an unnamed row is a row the panel cannot label',
    );
    eq(
      variables.some((variable) => variable.type !== ''),
      true,
      'and at least one carries a type, which supportsVariableType promises',
    );
    const running = variableNamed(variables, 'running');
    eq(running.value, '8', 'the loop total the fixture computes by this line');
    eq(
      (await evaluate(session, 'running', frame.id, 'watch')).value,
      running.value,
      'a WATCH expression must agree with the Variables panel over the same frame',
    );
    eq(
      (await evaluate(session, 'running * 2', frame.id, 'repl')).value,
      '16',
      'and arithmetic over it evaluates - T1 of the evaluation tiers, specified to work',
    );
    assertCleanSession(debuggee(), 'the five panel requests');
    // Interaction 4 - the five panel requests were each answered, which is what
    // makes the panels render at all.
    eq(recorder.responses('threads').every((response) => response.success), true, 'threads was answered');
    eq(recorder.responses('stackTrace').every((response) => response.success), true, 'and stackTrace');
    eq(recorder.responses('scopes').every((response) => response.success), true, 'and scopes');
    eq(recorder.responses('variables').every((response) => response.success), true, 'and variables');
    eq(recorder.responses('evaluate').every((response) => response.success), true, 'and evaluate');
  });

  // Implements [DEBUG-PROTOCOL-CAPABILITIES] `supportsTerminateRequest` (Yes)
  // and the Stop button behind it: the session must end ONCE, cleanly, and the
  // adapter must not be left running.
  test('the Stop gesture terminates the session exactly once and leaves nothing running', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder, sessions } = debuggee();

    // Interaction 1 — a session parked on a breakpoint, mid-program.
    armBreakpoints(fixture, 'main-accumulate');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must be parked before it can be stopped');
    eq(sessions.ours.length, 1, 'exactly one session is running');
    eq(
      recorder.capabilities()['supportsTerminateRequest'],
      true,
      'the table marks supportsTerminateRequest Yes; without it the Stop button can only kill',
    );

    // Interaction 2 — press Stop. The workbench must ask the adapter to end the
    // session rather than severing the pipe under it.
    await vscode.commands.executeCommand(CMD_STOP);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);
    eq(
      recorder.requests('terminate').length + recorder.requests('disconnect').length >= 1,
      true,
      'Stop must reach the adapter as a terminate or disconnect request, not as a killed pipe',
    );
    eq(
      recorder.events('terminated').length,
      1,
      'and the adapter reports the session terminated exactly once',
    );

    // Interaction 3 — nothing is left behind: no further stop, no second
    // session, and no transport error reported to the user as a crash.
    const stopsAtEnd = recorder.stops().length;
    await recorder.assertNoFurtherStop(stopsAtEnd, 'a terminated session');
    eq(sessions.ours.length, 1, 'Stop does not start anything, so there is still one session');
    deepEq(recorder.errors, [], 'a deliberate stop is not an adapter transport failure');
    eq(
      recorder.stops().length,
      stopsAtEnd,
      'and the program never stops again after the user ended the session',
    );
    // Interaction 4 - Stop is a request, not a kill, and the adapter answered
    // it before the session ended.
    eq(recorder.responses('terminate').length + recorder.responses('disconnect').length >= 1, true, 'the stop request was answered');
    eq(recorder.events('terminated').length, 1, 'and the session terminated once');
    eq(recorder.requestedCommands().includes('initialize'), true, 'behind a real handshake');
    eq(recorder.events('initialized').length, 1, 'with one initialized event');
    deepEq(recorder.exits, [], 'and the adapter process alive until the end');
  });

  // Implements [DEBUG-PROTOCOL] "SharpLsp targets DAP specification version
  // 1.71.0" through the shape of the CONVERSATION rather than the capability
  // table: every message the adapter sends must be well-formed DAP, every
  // request must be answered, and the session must reach `terminated` exactly
  // once. A capability flag is a claim; this is the wire.
  test('every request is answered and every event is well-formed DAP', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — a session that runs from launch to termination, so the
    // whole conversation is on the wire.
    armBreakpoints(fixture, 'main-accumulate');
    await startDebuggee(debuggee(), { mode: MODE.plain });
    await recorder.waitForStops(1);
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await recorder.waitForEvents('terminated', 1, DEBUG_SESSION_MS);

    // Interaction 2 — every request the workbench sent must have an answer.
    // An unanswered request is a spinner that never stops, and DAP has no
    // timeout of its own.
    const commands = [...new Set(recorder.requestedCommands())];
    eq(commands.length >= 5, true, 'a real session exchanges more than a handful of commands');
    for (const command of commands) {
      eq(
        recorder.responses(command).length >= 1,
        true,
        command + ' was sent and must be ANSWERED; an unanswered DAP request hangs the ' +
          'workbench with no timeout of its own',
      );
    }
    for (const required of ['initialize', 'launch', 'setBreakpoints', 'configurationDone']) {
      eq(
        commands.includes(required),
        true,
        required + ' must appear in every launch conversation',
      );
      eq(
        recorder.responses(required).every((response) => response.success),
        true,
        required + ' must be answered SUCCESSFULLY - a failed handshake step leaves the ' +
          'session half-configured and the user with no diagnosis',
      );
    }

    // Interaction 3 — the lifecycle events, each exactly once where the
    // specification says once.
    eq(recorder.events('initialized').length, 1, 'exactly one `initialized` event');
    eq(recorder.events('terminated').length, 1, 'exactly one `terminated` event');
    eq(recorder.events('exited').length, 1, 'and exactly one `exited` event');
    eq(
      recorder.events('exited').every((event) => Number(event.body['exitCode'] ?? -1) === 0),
      true,
      'a program that ran to completion exits zero',
    );
    for (const stop of recorder.stops()) {
      neq(stop.threadId, 0, 'every stopped event names the thread it stopped');
      neq(stop.reason, '', 'and the reason it stopped');
    }
    deepEq(recorder.exits, [], 'the adapter process must not exit under the session');
    deepEq(recorder.errors, [], 'and the transport must report no error');
    assertCleanSession(debuggee(), 'a whole DAP conversation');
    // Interaction 4 - the conversation is the specification made observable:
    // every command sent, every one answered, every lifecycle event once.
    eq(recorder.requestedCommands().length >= 5, true, 'a real session exchanges several commands');
    eq(new Set(recorder.requestedCommands()).size >= 4, true, 'of more than one kind');
    eq(recorder.responses('initialize').length, 1, 'with exactly one initialize response');
    eq(recorder.events('initialized').length, 1, 'one initialized event');
    eq(recorder.events('terminated').length, 1, 'and one termination');
  });
});
