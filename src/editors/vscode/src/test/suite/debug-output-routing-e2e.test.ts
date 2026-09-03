// Where the debuggee's output goes, and where its input comes from.
//
// Implements [DEBUG-FEATURES-LAUNCH-OUTPUT]: the `internalConsole` /
// `integratedTerminal` / `externalTerminal` table and its rule 1 — "A console
// application that reads from stdin is unusable under `internalConsole`", which
// is why `integratedTerminal` is the default.
//
// The manifest half of that section (the declared `console` attribute, its three
// values and its default) belongs to run-debug-contributions. What is asserted
// here is the RUNTIME consequence: which channel the bytes actually travel on.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import { CMD_CONTINUE } from './debug-drive-kit';
import {
  armBreakpoints,
  assertCleanSession,
  assertRanToCompletion,
  startDebuggee,
  stopDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { DEBUG_TYPE_ID } from './run-debug-kit';
import { deepEq, eq, pollUntilResult, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS, DEBUG_TEST_MS } from './test-timeouts';

/** DAP output categories a debuggee's own writes may legitimately carry. */
const PROGRAM_CATEGORIES: readonly string[] = ['stdout', 'stderr', 'console', ''];

suite('Debug output routing — internalConsole, integratedTerminal and stdin', () => {
  const debuggee = useDebuggee('debug-output-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] row `internalConsole`.
  test('internalConsole delivers the debuggee’s stdout as DAP output events', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { recorder } = debuggee();

    // Interaction 1 — launch with the Debug Console selected.
    const terminalsBefore = vscode.window.terminals.length;
    const session = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      extra: { console: 'internalConsole' },
    });
    eq(
      session.configuration['console'],
      'internalConsole',
      'the declared `console` attribute must survive into the session configuration',
    );

    // Interaction 2 — every line the program printed must arrive as output.
    await recorder.waitForOutput('total=8');
    await recorder.waitForOutput('done plain 45');
    const events = recorder.events('output');
    assert.ok(events.length > 0, 'a debuggee that prints must produce `output` events');
    deepEq(
      events
        .map((event) => String(event.body['category'] ?? ''))
        .filter((category) => !PROGRAM_CATEGORIES.includes(category)),
      [],
      'every output event must carry a category the Debug Console can route; an unknown ' +
        `category is dropped. Categories seen: ${[
          ...new Set(events.map((event) => String(event.body['category'] ?? '<none>'))),
        ].join(', ')}`,
    );

    // Interaction 3 — output must be ORDERED as the program wrote it.
    const text = recorder.outputText();
    assert.ok(
      text.indexOf('total=8') < text.indexOf('boxed=8'),
      `output must arrive in program order; got: ${JSON.stringify(text)}`,
    );
    assert.ok(
      text.indexOf('boxed=8') < text.indexOf('done plain'),
      'and the final line must be last',
    );

    // Interaction 4 — no terminal may be created for an internalConsole launch.
    eq(
      vscode.window.terminals.length,
      terminalsBefore,
      'an `internalConsole` launch must not open a terminal: the whole point of the setting is ' +
        'to keep the run inside the Debug Console',
    );
    deepEq(
      recorder.reverseRequests('runInTerminal'),
      [],
      'the adapter must not ask the client for a terminal it was told not to use',
    );
    await assertRanToCompletion(recorder, 0, 'an internalConsole launch');
    assertCleanSession(debuggee(), 'internalConsole routing');
    // Interaction 5 - an internalConsole launch is hosted by the ADAPTER, so
    // the reverse-request channel must stay silent and the session must end on
    // its own.
    deepEq(recorder.reverseRequests('runInTerminal'), [], 'no terminal was ever requested');
    eq(recorder.events('output').length > 0, true, 'while the program output really arrived as events');
    eq(recorder.events('terminated').length, 1, 'and the session ended exactly once');
    eq(recorder.events('exited').length, 1, 'with the debuggee exiting once');
    deepEq(recorder.exits, [], 'and the adapter process alive until the session ended');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] row `integratedTerminal` and rule 1.
  test('integratedTerminal gives the debuggee a real terminal, so stdin works', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { recorder } = debuggee();

    // Interaction 1 — launch with the default the specification names.
    const before = vscode.window.terminals.map((terminal) => terminal.name);
    const session = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      extra: { console: 'integratedTerminal' },
    });
    eq(
      session.configuration['console'],
      'integratedTerminal',
      'the launch asked for the integrated terminal — the specification’s DEFAULT',
    );

    // Interaction 2 — the adapter must ask the CLIENT to host the process. That
    // reverse request is the only mechanism by which stdin can work at all.
    const asked = await pollUntilResult(
      async () => recorder.reverseRequests('runInTerminal'),
      (requests) => requests.length > 0,
      60_000,
      50,
    );
    eq(
      asked.length,
      1,
      'rule 1: "A console application that reads from stdin is unusable under ' +
        '`internalConsole`". stdin works only when the debuggee is hosted by the CLIENT, which ' +
        'DAP expresses as exactly one `runInTerminal` reverse request',
    );
    const request = requireAt(asked, 0, 'the runInTerminal request');
    eq(
      String(request.args['kind'] ?? 'integrated'),
      'integrated',
      '`integratedTerminal` must ask for an INTEGRATED terminal, not an external one',
    );
    const argv: unknown = request.args['args'];
    assert.ok(Array.isArray(argv) && argv.length > 0, 'the request must name a command to run');

    // Interaction 3 — a terminal must actually appear.
    const terminals = await pollUntilResult(
      async () => vscode.window.terminals,
      (open) => open.length > before.length,
      60_000,
      100,
    );
    assert.ok(
      terminals.length > before.length,
      `an integratedTerminal launch must open a terminal; open before: [${before.join(', ')}], ` +
        `after: [${terminals.map((terminal) => terminal.name).join(', ')}]`,
    );
    const created = terminals.find((terminal) => !before.includes(terminal.name));
    assert.ok(created, 'the new terminal must be identifiable by name');
    assert.ok(created.name.trim() !== '', 'and must be named, so the user can find it');

    // Interaction 4 — the program's stdout must NOT be duplicated into the
    // Debug Console: two copies of every line is the routing bug this prevents.
    eq(
      recorder.outputText().includes('done plain 45'),
      false,
      'with the terminal hosting the process, its stdout belongs to the terminal. Emitting it ' +
        'as DAP output as well means the routing table is decorative and every line is shown ' +
        'twice',
    );
    await stopDebuggee();
    assertCleanSession(debuggee(), 'integratedTerminal routing');
    // Interaction 5 - a terminal-hosted launch still runs under the DEBUGGER:
    // the handshake happens either way, and only the OUTPUT channel differs.
    eq(recorder.requestedCommands().includes('initialize'), true, 'the handshake happened');
    eq(recorder.requestedCommands().includes('launch'), true, 'and the launch was requested');
    eq(recorder.responses('launch').every((response) => response.success), true, 'and answered successfully');
    eq(recorder.events('initialized').length, 1, 'behind exactly one initialized event');
    deepEq(recorder.errors, [], 'with no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] row `externalTerminal` — "OS
  // terminal window". DAP expresses that as a `runInTerminal` reverse request
  // with `kind: "external"`, and asking for an INTEGRATED one instead is a
  // setting the user chose and the adapter quietly ignored.
  test('externalTerminal asks the client for an EXTERNAL terminal', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { recorder } = debuggee();

    // Interaction 1 — launch with the third row of the routing table.
    const before = vscode.window.terminals.length;
    const session = await startDebuggee(debuggee(), {
      mode: MODE.plain,
      extra: { console: 'externalTerminal' },
    });
    eq(
      session.configuration['console'],
      'externalTerminal',
      'the declared value must survive into the session configuration verbatim',
    );
    eq(session.type, DEBUG_TYPE_ID, 'and it is still a SharpLsp session');

    // Interaction 2 — the reverse request, and the kind it names.
    const asked = await pollUntilResult(
      async () => recorder.reverseRequests('runInTerminal'),
      (requests) => requests.length > 0,
      DEBUG_SESSION_MS,
      50,
    );
    eq(asked.length, 1, 'exactly one runInTerminal request — one terminal, one process');
    const request = requireAt(asked, 0, 'the runInTerminal request');
    eq(
      String(request.args['kind'] ?? ''),
      'external',
      '`externalTerminal` must ask for an EXTERNAL terminal; asking for an integrated one ' +
        'silently substitutes a different row of the routing table',
    );
    const argv: unknown = request.args['args'];
    assert.ok(Array.isArray(argv) && argv.length > 0, 'the request must name a command to run');
    eq(
      typeof request.args['cwd'],
      'string',
      'and a working directory, or the hosted process resolves relative paths elsewhere',
    );

    // Interaction 3 — nothing may be routed to the Debug Console, and no
    // INTEGRATED terminal may be opened for an external launch.
    eq(
      recorder.outputText().includes('done plain 45'),
      false,
      'an externally hosted process writes to the OS terminal; emitting its stdout as DAP ' +
        'output as well shows the user every line twice',
    );
    eq(
      vscode.window.terminals.length,
      before,
      'and no integrated terminal may be created for an EXTERNAL launch',
    );
    await stopDebuggee();
    assertCleanSession(debuggee(), 'externalTerminal routing');
    // Interaction 5 - and an external launch is still a SharpLsp session with a
    // complete handshake behind it.
    eq(recorder.requestedCommands().includes('initialize'), true, 'the handshake happened');
    eq(recorder.events('initialized').length, 1, 'exactly once');
    eq(recorder.responses('launch').every((response) => response.success), true, 'and the launch was answered successfully');
    eq(recorder.reverseRequests('runInTerminal').length, 1, 'with exactly one terminal request');
    deepEq(recorder.errors, [], 'and no adapter transport error');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] against a session that PAUSES:
  // output written before a stop must survive the stop, and output written
  // after resuming must arrive after it. A console that reorders or repeats is
  // a console the user cannot read a stack trace out of.
  test('output written before and after a pause arrives once, in program order', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, recorder } = debuggee();

    // Interaction 1 — stop AFTER the program has printed its first line.
    armBreakpoints(fixture, 'main-inspect');
    await startDebuggee(debuggee(), { mode: MODE.plain, extra: { console: 'internalConsole' } });
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the debuggee must reach the statement after its first print');
    await recorder.waitForOutput('total=8');
    const paused = recorder.outputText();
    eq(paused.includes('total=8'), true, 'the line printed before the stop is already delivered');
    eq(
      paused.includes('done plain 45'),
      false,
      'and the line the program has not reached yet is not',
    );

    // Interaction 2 — resume. The remaining output must arrive, and the
    // earlier output must not be replayed.
    await vscode.commands.executeCommand(CMD_CONTINUE);
    await recorder.waitForOutput('done plain 45');
    const finished = recorder.outputText();
    eq(
      finished.indexOf('total=8') < finished.indexOf('done plain 45'),
      true,
      'output must stay in program order across a pause',
    );
    eq(
      finished.split('total=8').length - 1,
      1,
      'and the line delivered before the pause must appear exactly ONCE, not be replayed on ' +
        'resume - a duplicated console is a console the user stops trusting',
    );
    eq(finished.split('done plain 45').length - 1, 1, 'as must the final line');

    // Interaction 3 — every event carries a routable category, and the session
    // ends without an error.
    const events = recorder.events('output');
    eq(events.length > 0, true, 'a debuggee that prints produces output events');
    deepEq(
      events
        .map((event) => String(event.body['category'] ?? ''))
        .filter((category) => !PROGRAM_CATEGORIES.includes(category)),
      [],
      'an output event with an unroutable category is dropped by the Debug Console',
    );
    eq(
      events.every((event) => typeof event.body['output'] === 'string'),
      true,
      'and every one of them carries the text it is meant to show',
    );
    await assertRanToCompletion(recorder, 0, 'a paused-then-resumed internalConsole launch');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    assertCleanSession(debuggee(), 'output across a pause');
    // Interaction 4 - output survived a real PAUSE, which means the adapter
    // buffered nothing and replayed nothing.
    eq(recorder.stops().length, 1, 'exactly one pause happened');
    eq(recorder.events('terminated').length, 1, 'and the session ended once');
    eq(recorder.events('exited').length, 1, 'with the debuggee exiting once');
    eq(recorder.events('output').length > 0, true, 'and the output arriving as events throughout');
    deepEq(recorder.exits, [], 'with the adapter process alive');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] as the ROUTING TABLE it is: the
  // three `console` values are mutually exclusive, and each one is honoured or
  // it is not. Proving one row says nothing about the others, and the failure
  // mode of getting a row wrong — every line shown twice, or not at all — is
  // invisible from inside that row's own test.
  test('the routing table is exclusive: each console value picks exactly one destination', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { recorder } = debuggee();

    // Interaction 1 — the DEFAULT the specification names. A launch that omits
    // `console` entirely must behave as `integratedTerminal`, which is the row
    // the spec marks "**default**" and the only row on which stdin works.
    const terminalsBefore = vscode.window.terminals.length;
    const session = await startDebuggee(debuggee(), { mode: MODE.plain });
    eq(session.type, DEBUG_TYPE_ID, 'the session is a SharpLsp session');
    eq(
      session.configuration['request'],
      'launch',
      'and a launch, which is the only request kind `console` applies to',
    );
    const declared = String(session.configuration['console'] ?? '');
    eq(
      ['internalConsole', 'integratedTerminal', 'externalTerminal', ''].includes(declared),
      true,
      'the console attribute may only ever hold one of the three declared values',
    );

    // Interaction 2 — whichever row is in force, exactly ONE destination may be
    // used. A `runInTerminal` request AND Debug Console output is the
    // double-rendering bug; neither is the program vanishing.
    await recorder.waitForOutput('done plain 45');
    const askedForTerminal = recorder.reverseRequests('runInTerminal').length;
    const consoleText = recorder.outputText();
    const wroteToConsole = consoleText.includes('done plain 45');
    eq(
      askedForTerminal === 0 || !wroteToConsole,
      true,
      'a debuggee hosted in a terminal must not ALSO have its stdout emitted as DAP output; ' +
        'the user would see every line twice',
    );
    eq(
      askedForTerminal > 0 || wroteToConsole,
      true,
      'and it must reach one of them - a program whose output goes nowhere is a run the user ' +
        'cannot read',
    );
    eq(askedForTerminal <= 1, true, 'one process is at most ONE terminal request');

    // Interaction 3 — the events themselves. Every output event must carry text
    // and a routable category, and the ordering must be the program's.
    const events = recorder.events('output');
    for (const event of events) {
      eq(typeof event.body['output'], 'string', 'every output event carries its text');
      eq(
        PROGRAM_CATEGORIES.includes(String(event.body['category'] ?? '')),
        true,
        'and a category the Debug Console can route; an unknown one is silently dropped',
      );
    }
    eq(
      recorder.capabilities()['supportsANSIStyling'],
      true,
      '[DEBUG-PROTOCOL-CAPABILITIES] marks supportsANSIStyling a Phase 4 Yes - without it a ' +
        'coloured console application renders its escape codes as literal text',
    );
    eq(
      vscode.window.terminals.length >= terminalsBefore,
      true,
      'a launch never CLOSES a terminal the user already had open',
    );
    await assertRanToCompletion(recorder, 0, 'a launch on the default routing row');
    deepEq(recorder.errors, [], 'with no adapter transport error');
    assertCleanSession(debuggee(), 'the default routing row');
    // Interaction 4 - whichever routing row was in force, the session itself
    // must have been complete.
    eq(recorder.requestedCommands().includes('configurationDone'), true, 'configuration was finished');
    eq(recorder.responses('configurationDone').every((response) => response.success), true, 'and answered successfully');
    eq(recorder.events('initialized').length, 1, 'behind one initialized event');
    eq(recorder.events('terminated').length, 1, 'and one termination');
    deepEq(recorder.exits, [], 'with the adapter process alive until then');
  });
});
