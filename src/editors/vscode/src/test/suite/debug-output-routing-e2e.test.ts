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
import {
  assertCleanSession,
  assertRanToCompletion,
  startDebuggee,
  stopDebuggee,
  useDebuggee,
} from './debug-suite-kit';
import { deepEq, eq, pollUntilResult, requireAt } from './test-helpers';
import { DEBUG_SESSION_MS } from './test-timeouts';

/** DAP output categories a debuggee's own writes may legitimately carry. */
const PROGRAM_CATEGORIES: readonly string[] = ['stdout', 'stderr', 'console', ''];

suite('Debug output routing — internalConsole, integratedTerminal and stdin', () => {
  const debuggee = useDebuggee('debug-output-cs-', 'csharp');

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] row `internalConsole`.
  test('internalConsole delivers the debuggee’s stdout as DAP output events', async function () {
    this.timeout(DEBUG_SESSION_MS);
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
  });

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] row `integratedTerminal` and rule 1.
  test('integratedTerminal gives the debuggee a real terminal, so stdin works', async function () {
    this.timeout(DEBUG_SESSION_MS);
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
  });
});
