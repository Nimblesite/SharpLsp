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
import { MODE } from './debug-fixture-programs';
import { armBreakpoints, assertCleanSession, startDebuggee, useDebuggee } from './debug-suite-kit';
import { DEBUG_TYPE_ID } from './run-debug-kit';
import { deepEq, eq, requireAt } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';

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
    const missing: string[] = [];
    for (const { flag, note } of PHASE_FOUR_YES) {
      if (capabilities[flag] !== true) missing.push(`${flag} (${note})`);
    }
    deepEq(
      missing,
      [],
      '[DEBUG-PROTOCOL-CAPABILITIES] marks these Yes for Phase 4. VS Code builds its debug UI ' +
        'from the initialize response alone, so an unadvertised capability is an ABSENT ' +
        'feature no matter what the adapter can actually do',
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
    const overclaimed: string[] = [];
    for (const { flag, note } of PHASE_FOUR_NO) {
      if (capabilities[flag] === true) overclaimed.push(`${flag} (${note})`);
    }
    deepEq(
      overclaimed,
      [],
      'these rows are "No" in the Phase Four column. Advertising one enables the matching VS ' +
        'Code affordance — reverse-step buttons, "Break on Value Change", the memory viewer — ' +
        'for a feature that is not implemented, which is a worse experience than its absence',
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
  });
});
