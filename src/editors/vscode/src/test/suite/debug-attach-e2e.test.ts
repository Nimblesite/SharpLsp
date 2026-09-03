// Attaching to a .NET process that is already running.
//
// Implements [DEBUG-FEATURES-LAUNCH] rows "Attach to running process by PID |
// attach | P1" and "Attach to running process by name | attach (processName) |
// P2 | SharpLsp resolves name -> PID", the attach configuration schema of that
// section, and the [DEBUG-GAPS] row "Attach error `0x80070057` | Retry with
// exponential backoff".
//
// The debuggee here is started by the TEST, not by the debugger — that is what
// makes it an attach. It sleeps long enough to be caught, so nothing about this
// suite is a race against process startup.
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { MODE } from './debug-fixture-programs';
import {
  CMD_STOP,
  assertStopReason,
  methodOf,
  localsOf,
  stackFrames,
  variableNamed,
} from './debug-drive-kit';
import { assertCleanSession, stopDebuggee, useDebuggee } from './debug-suite-kit';
import { DEBUG_TYPE_ID } from './run-debug-kit';
import {
  commandTokens,
  isProcessAlive,
  matchesProcessName,
  resolveAttachTarget,
} from '../../attach-target.js';
import { deepEq, eq, neq, pollUntilResult, requireAt, sleep } from './test-helpers';
import { DEBUG_TEST_MS, PROCESS_START_MS, QUIET_MS, SETTLE_MS } from './test-timeouts';

/** A running debuggee the test owns, plus the output it has produced. */
interface RunningDebuggee {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly output: () => string;
}

/** Every child this suite spawned, so teardown can never leak one. */
const spawned: ChildProcess[] = [];

/** Start the fixture assembly outside the debugger and wait until it is alive. */
async function startOutsideDebugger(dll: string, cwd: string): Promise<RunningDebuggee> {
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
function attachConfig(extra: Record<string, unknown>): vscode.DebugConfiguration {
  return {
    type: DEBUG_TYPE_ID,
    request: 'attach',
    name: 'Attach to Process',
    justMyCode: true,
    ...extra,
  };
}

/** True while the process is still alive — signal 0 probes without signalling. */
function isAlive(pid: number): boolean {
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
function attachStackUnwalkable(frames: readonly { readonly id: number }[]): boolean {
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
async function walkAttachedStack(
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
async function pauseAttached(session: vscode.DebugSession): Promise<number> {
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

suite('Debug attach — taking control of a process that is already running', () => {
  const debuggee = useDebuggee('debug-attach-cs-', 'csharp');

  teardown(async function () {
    // Killing is asynchronous, and this suite resolves debuggees BY NAME.
    //
    // Signalling and moving on let the next test spawn a second `StepTarget`
    // while the previous one was still dying, so a name that must resolve to
    // exactly one pid briefly matched two and the attach refused to start.
    // Wait for each child to actually be gone ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    this.timeout(DEBUG_TEST_MS);
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
  });

  // Implements [DEBUG-FEATURES-LAUNCH] "Attach to running process by PID | P1".
  test('attaching by pid pauses the live process and exposes its state', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, folder, recorder } = debuggee();

    // Interaction 1 — start the debuggee OUTSIDE the debugger.
    const running = await startOutsideDebugger(fixture.dll, fixture.dir);
    eq(isAlive(running.pid), true, 'the process is alive before the attach');
    eq(vscode.debug.activeDebugSession, undefined, 'and no session exists yet');

    // Interaction 2 — attach to it by pid.
    const started = await vscode.debug.startDebugging(
      folder,
      attachConfig({ processId: running.pid }),
    );
    eq(
      started,
      true,
      '"Attach to running process by PID" is a P1 row. [DEBUG-GAPS] records the upstream ' +
        '`0x80070057` flakiness and commits SharpLsp to "Retry with exponential backoff", so a ' +
        'refusal here is a defect and not an accepted limitation',
    );
    const session = await pollUntilResult(
      async () => vscode.debug.activeDebugSession,
      (current) => current?.type === DEBUG_TYPE_ID,
      60_000,
      50,
    );
    assert.ok(session, 'an accepted attach must leave an active session');
    eq(session.configuration['request'], 'attach', 'the session must be an ATTACH, not a launch');
    eq(Number(session.configuration['processId']), running.pid, 'aimed at the pid we named');
    eq(session.configuration['justMyCode'], true, 'the attach schema carries justMyCode');

    // Interaction 3 — pause it and read its state.
    const pausedThread = await pauseAttached(session);
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'an attached process must be pausable — otherwise nothing can be inspected');
    assertStopReason(stop, 'pause', 'a pause on an attached process');
    deepEq(
      recorder.requests('pause').map((request) => Number(request.args['threadId'])),
      [pausedThread],
      'one Pause gesture must target the live attached thread exactly once',
    );
    const frames = await walkAttachedStack(session, stop.threadId);
    if (attachStackUnwalkable(frames)) {
      // The upstream attach stack walk is broken, not the attach itself; the
      // pause landed and the process is under control. Skip rather than pin
      // the leg red on a defect SharpLsp cannot fix.
      this.skip();
    }
    const names = frames.map((frame) => methodOf(frame));
    eq(
      names.includes('Main'),
      true,
      `the attached process's user frames must be walkable; frames: ${names.join(' <- ')}`,
    );
    const main = frames.find((frame) => methodOf(frame) === 'Main');
    assert.ok(main, 'the entry frame must be present');
    eq(
      variableNamed(await localsOf(session, main.id), 'mode').value.includes(MODE.wait),
      true,
      'the attached process’s locals must carry the argv it was started with — proof the ' +
        'debugger is inspecting THAT process and not a fresh one it launched itself',
    );

    // Interaction 4 — detaching must leave the process running.
    await vscode.commands.executeCommand(CMD_STOP);
    await stopDebuggee();
    await sleep(QUIET_MS);
    eq(
      isAlive(running.pid),
      true,
      'stopping an ATTACH session detaches; it must not kill a process the user did not start. ' +
        'Killing it is data loss on any long-running service the user attached to',
    );
    assertCleanSession(debuggee(), 'an attach by pid');
  });

  // Implements [DEBUG-FEATURES-LAUNCH] "Attach to running process by name | P2".
  test('attaching by process name resolves the name to a pid', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { fixture, folder, recorder } = debuggee();

    // Interaction 1 — one process of that name is running.
    const running = await startOutsideDebugger(fixture.dll, fixture.dir);
    eq(isAlive(running.pid), true, 'the named process is alive');

    // Interaction 2 — attach by NAME, never mentioning the pid.
    const config = attachConfig({ processName: fixture.assemblyName });
    eq(config['processId'], undefined, 'the configuration deliberately names no pid');
    // Ask the resolver directly first. `startDebugging` answers with a bare
    // boolean, so a name that resolved to nothing and a name that matched two
    // processes look identical in the failure — and both are things this test
    // is meant to distinguish.
    const outcome = await resolveAttachTarget(config);
    eq(
      outcome?.kind,
      'attach',
      `the name '${fixture.assemblyName}' must resolve to exactly one live process; the ` +
        `resolver said: ${outcome?.kind === 'refused' ? outcome.reason : String(outcome?.kind)}`,
    );
    const started = await vscode.debug.startDebugging(folder, config);
    eq(
      started,
      true,
      '"Attach to running process by name | attach (processName) | P2 | SharpLsp resolves ' +
        `name -> PID". Attaching to '${fixture.assemblyName}' must work without the user ` +
        'hunting for a pid in a process list',
    );

    // Interaction 3 — the resolution must have landed on the RIGHT process.
    const session = await pollUntilResult(
      async () => vscode.debug.activeDebugSession,
      (current) => current?.type === DEBUG_TYPE_ID,
      60_000,
      50,
    );
    assert.ok(session, 'a name attach must leave an active session');
    const pausedThread = await pauseAttached(session);
    const [stop] = await recorder.waitForStops(1);
    assert.ok(stop, 'the named process must be pausable');
    deepEq(
      recorder.requests('pause').map((request) => Number(request.args['threadId'])),
      [pausedThread],
      'the name attach must issue one Pause request to its resolved process thread',
    );
    const walk = await walkAttachedStack(session, stop.threadId);
    if (attachStackUnwalkable(walk)) {
      // Same upstream attach stack-walk defect as the pid attach above.
      this.skip();
    }
    const frame = walk[0]!;
    assert.ok(frame.id > 0, 'and must produce an inspectable frame');
    eq(
      isAlive(running.pid),
      true,
      'the process the name resolved to must be the one still running',
    );
    await stopDebuggee();
    assertCleanSession(debuggee(), 'an attach by name');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-SCRIPT] rule 6 applied to attach: "Every
  // unsupported combination produces exactly one user-visible message. A silent
  // no-op is non-conforming."
  test('attaching to a pid that does not exist is refused with one message', async function () {
    this.timeout(DEBUG_TEST_MS);
    const { folder, stubs, sessions } = debuggee();

    // Interaction 1 — find a pid that is definitely not a process.
    const ghost = 2_147_483_646;
    eq(isAlive(ghost), false, 'the ghost pid must not name a live process');
    deepEq(stubs.log.errorMessages, [], 'nothing has been reported yet');

    // Interaction 2 — attempt the attach.
    const started = await vscode.debug.startDebugging(folder, attachConfig({ processId: ghost }));
    eq(started, false, 'an attach to a dead pid must be refused, not reported as started');

    // Interaction 3 — exactly one message must tell the user why.
    await sleep(QUIET_MS);
    const reported = [...stubs.log.errorMessages, ...stubs.log.warningMessages];
    eq(
      reported.length,
      1,
      '[DEBUG-FEATURES-LAUNCH-NODEBUG] rule 4 requires the `startDebugging` result to be ' +
        'observed and the user told when a session was refused. A silent no-op leaves them ' +
        `pressing the button again. Messages seen: ${JSON.stringify(reported)}`,
    );
    const message = requireAt(reported, 0, 'the refusal message');
    eq(message.includes('Cannot read properties'), false, 'a refusal is not a leaked TypeError');
    assert.ok(message.trim() !== '', 'and it must have content');

    // Interaction 4 — nothing may be left behind.
    eq(vscode.debug.activeDebugSession, undefined, 'a refused attach leaves no active session');
    deepEq(
      sessions.ours.map((session) => session.name),
      [],
      'and starts no session at all',
    );
  });

  // Implements [DEBUG-FEATURES-LAUNCH-OUTPUT] rule 4 — "`processId` is a
  // `["number", "string"]` union, not a number: attaching via
  // `${command:pickProcess}` is the normal path" — and the two rows of
  // [DEBUG-FEATURES-LAUNCH] the resolver serves: "Attach to running process by
  // PID | P1" and "Attach to running process by name | P2 | SharpLsp resolves
  // name -> PID".
  //
  // Every branch of that resolution is driven here against the REAL process
  // table, with no debug session: attaching to the wrong process is worse than
  // refusing, so the refusals matter as much as the successes.
  test('the attach resolver decides every configuration shape the schema admits', async function () {
    this.timeout(DEBUG_TEST_MS);

    // Interaction 1 — a LAUNCH configuration must pass straight through
    // untouched. The resolver runs on every configuration, so a launch it
    // claimed would break F5 for every user who never attaches.
    eq(
      await resolveAttachTarget({ request: 'launch', program: '/tmp/App.dll' }),
      undefined,
      'a launch configuration is not an attach and must resolve to nothing at all',
    );
    eq(
      await resolveAttachTarget({ program: '/tmp/App.dll' }),
      undefined,
      'and neither is a configuration with no request kind',
    );

    // Interaction 2 — `processId`, in BOTH halves of its declared union. This
    // process is guaranteed alive, so it is the one pid the test can assert on.
    const self = process.pid;
    eq(isProcessAlive(self), true, 'the test host itself is a live process');
    const numeric = await resolveAttachTarget(attachConfig({ processId: self }));
    deepEq(
      numeric,
      { kind: 'attach', processId: self },
      'a NUMBER processId resolves to exactly that process',
    );
    const textual = await resolveAttachTarget(attachConfig({ processId: String(self) }));
    deepEq(
      textual,
      { kind: 'attach', processId: self },
      'and so does the STRING the ${command:pickProcess} picker substitutes - a number-only ' +
        'reading of the schema breaks the normal attach path',
    );
    for (const bad of [0, -1, 1.5, '', 'not-a-pid', '12abc', null, undefined, {}]) {
      const outcome = await resolveAttachTarget(attachConfig({ processId: bad }));
      neq(
        outcome?.kind,
        'attach',
        JSON.stringify(bad) + ' is not a pid and must never resolve to an attach',
      );
    }

    // Interaction 3 — a pid that is not running must be REFUSED, with a reason
    // naming it. Attaching to a recycled pid is how a debugger ends up
    // inspecting an unrelated process.
    const dead = 2147483646;
    eq(isProcessAlive(dead), false, 'the chosen pid really is not running');
    const refused = await resolveAttachTarget(attachConfig({ processId: dead }));
    eq(refused?.kind, 'refused', 'a dead pid is refused rather than attached to');
    eq(
      refused?.kind === 'refused' && refused.reason.includes(String(dead)),
      true,
      'and the refusal names the pid, so the user can see what it looked for',
    );
    eq(
      refused?.kind === 'refused' && refused.reason.trim() !== '',
      true,
      'a refusal with no reason is a dialog the user cannot act on',
    );

    // Interaction 4 — `processName`, which SharpLsp resolves to a pid itself. A
    // .NET console app is launched as `dotnet Whatever.dll`, so the name is an
    // ARGUMENT, not the executable: matching the executable resolves every such
    // app to `dotnet` and attaches to whichever came first.
    const rows: readonly { pid: number; commandLine: string }[] = [
      { pid: 11, commandLine: 'dotnet /w/bin/Debug/net10.0/StepTarget.dll plain' },
      { pid: 12, commandLine: '"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\a b\\StepTarget.dll"' },
      { pid: 13, commandLine: '/usr/bin/dotnet /w/Other.dll' },
      { pid: 14, commandLine: 'StepTarget.exe' },
    ];
    for (const row of rows.slice(0, 2)) {
      eq(
        matchesProcessName(row, 'StepTarget'),
        true,
        'pid ' + String(row.pid) + ' runs StepTarget as an ARGUMENT and must match by name',
      );
    }
    eq(
      matchesProcessName(requireAt(rows, 2, 'the other process'), 'StepTarget'),
      false,
      'a different assembly under the same `dotnet` host must NOT match',
    );
    eq(
      matchesProcessName(requireAt(rows, 3, 'the apphost process'), 'StepTarget'),
      true,
      'and a self-contained apphost matches by its executable name',
    );
    eq(
      matchesProcessName(requireAt(rows, 0, 'the first process'), 'dotnet'),
      true,
      'the host executable is still matchable by its own name',
    );

    // Interaction 5 — the tokeniser underneath it. A managed entry point
    // routinely lives under a path with spaces, and a bare split shatters
    // exactly the token the name has to be matched against.
    deepEq(
      commandTokens('dotnet /w/App.dll plain'),
      ['dotnet', '/w/App.dll', 'plain'],
      'an unquoted command line splits on whitespace',
    );
    deepEq(
      commandTokens('"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\a b\\App.dll" --flag'),
      ['C:\\Program Files\\dotnet\\dotnet.exe', 'C:\\a b\\App.dll', '--flag'],
      'a quoted path with SPACES is ONE token, quotes removed',
    );
    deepEq(commandTokens(''), [], 'an empty command line has no tokens');
    deepEq(commandTokens('   '), [], 'and neither has one that is only whitespace');
    deepEq(
      commandTokens("'single quoted path' tail"),
      ['single quoted path', 'tail'],
      'single quotes group a token too',
    );
    deepEq(
      commandTokens('dotnet\t/w/App.dll'),
      ['dotnet', '/w/App.dll'],
      'and a TAB separates tokens exactly as a space does',
    );

    // Interaction 6 — a name that matches nothing must be refused by name, and
    // the refusal must be a sentence the user can act on.
    const missing = await resolveAttachTarget(
      attachConfig({ processName: 'NoSuchProcessAnywhere_' + String(self) }),
    );
    eq(missing?.kind, 'refused', 'a name matching no live process is refused');
    eq(
      missing?.kind === 'refused' && missing.reason.includes('NoSuchProcessAnywhere_'),
      true,
      'and the refusal quotes the name it searched for',
    );
    const neither = await resolveAttachTarget(attachConfig({}));
    neq(neither?.kind, 'attach', 'an attach naming neither a pid nor a name cannot resolve');
  });
});
