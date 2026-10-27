// An adapter that answers the request to stop and then goes silent.
//
// netcoredbg does exactly this: it answers `terminate`, then sends neither
// `exited` nor `terminated` and does not exit (issue #260, the non-crash side).
// The router's adapter-death path never runs, because the adapter is not dead.
// Nothing fires `terminated`, so VS Code keeps the session in the debug toolbar
// with no way to close it and the debuggee outlives the session that owned it.
//
// Driven against a STUB adapter rather than netcoredbg: the wedge is a race
// that reproduces roughly one run in six against the real thing, and a test for
// it has to be deterministic. The stub speaks the same DAP framing and wedges
// on demand, every time.
//
// The stub is a built F# console app, run through its apphost. That is the one
// executable shape that spawns on every platform under the router's fixed
// argv: the router passes `--interpreter=vscode` and no `shell`, so a `.cmd`
// launcher is refused outright on Windows (EINVAL since the BatBadBut fix) and
// a script host rejects the flag as a bad option. An apphost hands argv to
// `main`, which ignores it.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle".
import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DapRouter } from '../../dap-router';
import { SHUTDOWN_DEADLINE_MS } from '../../dap-shutdown';
import { isRecord, type DapMessage } from '../../dap-emulate';
import { buildProjectXml, writeProject } from './dotnet-project-kit';
import { TFM, buildProject, isolateFromRepoMsbuild } from './run-debug-fixtures';
import { COMMAND_MS, DEBUG_SESSION_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { eq, pollUntilResult, removeDirRecursive, assertContainsAll } from './test-helpers';

/** How long this suite gives the router's own deadline to fire. */
const TEST_DEADLINE_MS = 400;

/**
 * Budget for one wait on the stub: a response, or the router's synthesised
 * `terminated`. The stub answers in milliseconds and the deadline under test
 * is TEST_DEADLINE_MS, so COMMAND_MS is more than ten times what either
 * needs, and sits well under the default test ceiling — a wait that could
 * outlive its test would be killed by mocha with no diagnostic.
 */
const WAIT_MS = COMMAND_MS;

/** The stub reads this file beside its apphost to learn how to misbehave. */
const BEHAVIOUR_FILE = 'behaviour.txt';

/** What the stub does after answering a stop request. */
const BEHAVIOUR = {
  /** Answers, then nothing: the #260 wedge. */
  wedge: 'wedge',
  /** Answers, then sends `terminated` as a healthy adapter does. */
  honest: 'honest',
  /**
   * Honest about `terminate`, then exits on the client's `disconnect` without
   * answering it: netcoredbg on Windows once its debuggee has ended.
   */
  vanish: 'vanish',
  /**
   * Refuses the FIRST `threads` request as cancelled, as netcoredbg does when
   * the debuggee resumes while that request is still in flight (#508).
   */
  cancelThreads: 'cancelThreads',
  /**
   * Answers `exceptionInfo` naming `<unknown module>` with no `details.message`
   * and an empty stack, as netcoredbg does when it cannot evaluate the
   * exception object on the stop (#496); `stackTrace` and `evaluate` still
   * answer, so the router can recover the message.
   */
  unknownModuleException: 'unknownModuleException',
  /** The same, except the `evaluate` fallback fails too. */
  unknownModuleExceptionSilent: 'unknownModuleExceptionSilent',
} as const;

/** netcoredbg's answer when it cannot evaluate the exception object (#496). */
const UNKNOWN_MODULE_DESCRIPTION =
  "Exception thrown: 'System.ApplicationException' in <unknown module>";

/** What the stub's `$exception.Message` evaluate answers. */
const EXCEPTION_MESSAGE_RESULT = 'unhandled-by-design';

/** netcoredbg's own words for a `threads` request a resume aborted. */
const THREADS_CANCELLED = "Error processing 'threads' request. The operation was canceled.";

const STUB_NAME = 'WedgedAdapter';

/**
 * The stub. Every request is answered `success: true` unless the behaviour file
 * cancels a `threads` request; what follows a `terminate` or `disconnect` is
 * decided by the behaviour file too. The process
 * itself ends only when its stdin closes — the router never closes it before
 * the deadline, so while the router waits the stub is alive and silent, exactly
 * as a wedged netcoredbg is.
 */
const STUB_SOURCE = `
open System
open System.IO
open System.Text
open System.Text.Json

let input = Console.OpenStandardInput()
let output = Console.OpenStandardOutput()

let behaviour =
    let beside = Path.Combine(AppContext.BaseDirectory, "${BEHAVIOUR_FILE}")
    if File.Exists beside then File.ReadAllText(beside).Trim() else "${BEHAVIOUR.wedge}"

let readLine () =
    let line = StringBuilder()
    let mutable fin = false
    while not fin do
        let b = input.ReadByte()
        if b < 0 then exit 0
        elif b = int '\\n' then fin <- true
        elif b <> int '\\r' then line.Append(char b) |> ignore
    line.ToString()

let readBody (length: int) =
    let buffer = Array.zeroCreate<byte> length
    let mutable offset = 0
    while offset < length do
        let got = input.Read(buffer, offset, length - offset)
        if got <= 0 then exit 0
        offset <- offset + got
    Encoding.UTF8.GetString buffer

let send (message: obj) =
    let body = JsonSerializer.SerializeToUtf8Bytes message
    let header = Encoding.ASCII.GetBytes(sprintf "Content-Length: %d\\r\\n\\r\\n" body.Length)
    output.Write(header, 0, header.Length)
    output.Write(body, 0, body.Length)
    output.Flush()

let contentLength () =
    let mutable length = 0
    let mutable line = readLine ()
    while line <> "" do
        if line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase) then
            length <- int (line.Substring(15).Trim())
        line <- readLine ()
    length

[<EntryPoint>]
let main _argv =
    let mutable threadsCancelled = false
    let hidesExceptionMessage =
        behaviour = "${BEHAVIOUR.unknownModuleException}"
        || behaviour = "${BEHAVIOUR.unknownModuleExceptionSilent}"
    while true do
        use request = JsonDocument.Parse(readBody (contentLength ()))
        let root = request.RootElement
        if root.GetProperty("type").GetString() = "request" then
            let command = root.GetProperty("command").GetString()
            let requestSeq = root.GetProperty("seq").GetInt32()
            // vanish: gone before the disconnect is answered
            if behaviour = "${BEHAVIOUR.vanish}" && command = "disconnect" then exit 0
            // cancelThreads: the first threads request is aborted by a resume
            if behaviour = "${BEHAVIOUR.cancelThreads}" && command = "threads" && not threadsCancelled then
                threadsCancelled <- true
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = false; message = "${THREADS_CANCELLED}"; body = {| |} |}
            // #496: the exception object could not be evaluated on this stop,
            // so exceptionInfo names the module but carries no message
            elif hidesExceptionMessage && command = "exceptionInfo" then
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = true; body = {| description = "${UNKNOWN_MODULE_DESCRIPTION}"; details = {| typeName = "System.ApplicationException"; stackTrace = "" |} |} |}
            elif hidesExceptionMessage && command = "stackTrace" then
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = true; body = {| stackFrames = [| {| id = 1000; name = "Program.throws" |} |] |} |}
            elif hidesExceptionMessage && command = "evaluate" && behaviour = "${BEHAVIOUR.unknownModuleExceptionSilent}" then
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = false; message = "the exception object is not evaluable"; body = {| |} |}
            elif hidesExceptionMessage && command = "evaluate" then
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = true; body = {| result = "${EXCEPTION_MESSAGE_RESULT}" |} |}
            else
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = true; body = {| |} |}
            // #496: announce the exception stop whose panel the client asks about
            if hidesExceptionMessage && command = "initialize" then
                send {| \`\`type\`\` = "event"; seq = 0; event = "stopped"; body = {| reason = "exception"; threadId = 7; text = "${UNKNOWN_MODULE_DESCRIPTION}" |} |}
            if behaviour <> "${BEHAVIOUR.wedge}" && (command = "terminate" || command = "disconnect") then
                send {| \`\`type\`\` = "event"; seq = 0; event = "terminated"; body = {| |} |}
            // wedge: and then nothing — no exited, no terminated, and the process stays up
    0
`;

/** Write and build the stub once; return its apphost and output directory. */
async function buildStub(dir: string): Promise<{ apphost: string; outDir: string }> {
  isolateFromRepoMsbuild(dir);
  writeProject(
    dir,
    `${STUB_NAME}.fsproj`,
    buildProjectXml({
      properties: { OutputType: 'Exe', TargetFramework: TFM },
      compileIncludes: ['Program.fs'],
      packages: [{ id: 'FSharp.Core', version: '10.1.302' }],
    }),
    'Program.fs',
    STUB_SOURCE,
  );
  await buildProject({
    projectFile: path.join(dir, `${STUB_NAME}.fsproj`),
    sourceFile: path.join(dir, 'Program.fs'),
    dir,
    assemblyName: STUB_NAME,
  });
  const outDir = path.join(dir, 'bin', 'Debug', TFM);
  const apphost = path.join(outDir, process.platform === 'win32' ? `${STUB_NAME}.exe` : STUB_NAME);
  return { apphost, outDir };
}

/** Drive one router against the stub, collecting everything it emits. */
class WedgeDriver {
  public readonly emitted: DapMessage[] = [];
  private readonly router: DapRouter;
  private seq = 0;

  constructor(apphost: string, deadlineMs: number) {
    this.router = new DapRouter(apphost, deadlineMs);
    this.router.onDidSendMessage((message) => {
      this.emitted.push({ ...(message as DapMessage) });
    });
  }

  /** Send a request and wait for the stub's response to come back through. */
  public async request(command: string, args: Record<string, unknown> = {}): Promise<DapMessage> {
    const seq = ++this.seq;
    this.router.handleMessage({ type: 'request', seq, command, arguments: args });
    const answer = await pollUntilResult(
      async () => this.emitted.find((m) => m.type === 'response' && m.request_seq === seq),
      (m) => m !== undefined,
      WAIT_MS,
      10,
    );
    assert.ok(answer, `the stub answered ${command}`);
    return answer;
  }

  /** Every event of one name the router has fired so far. */
  public events(name: string): DapMessage[] {
    return this.emitted.filter((m) => m.type === 'event' && m.event === name);
  }

  /** Every answer to `command` the router has sent the client so far. */
  public answers(command: string): DapMessage[] {
    return this.emitted.filter((m) => m.type === 'response' && m.command === command);
  }

  /** Wait for a `terminated` event to reach the client. */
  public async awaitTerminated(): Promise<DapMessage[]> {
    return await pollUntilResult(
      async () => this.events('terminated'),
      (found) => found.length > 0,
      WAIT_MS,
      10,
    );
  }

  /** Everything the router wrote to the debug console, as one string. */
  public console(): string {
    return this.events('output')
      .map((m) => (isRecord(m.body) ? String(m.body.output ?? '') : ''))
      .join('');
  }

  public dispose(): void {
    this.router.dispose();
  }
}

/**
 * Build the stub once for the calling suite, and remove it after. The returned
 * `start` tells the stub how to misbehave, then puts a fresh router over it.
 */
function useStub(prefix: string): (behaviour: string) => WedgeDriver {
  let dir = '';
  let built = { apphost: '', outDir: '' };
  suiteSetup(async function () {
    // A real `dotnet build` of the F# stub: NuGet restore of FSharp.Core plus
    // the F# compiler, once for the suite. Cold on a CI runner that is tens of
    // seconds — the same budget every other suite that builds a fixture uses.
    this.timeout(FIXTURE_BUILD_MS);
    dir = mkdtempSync(path.join(tmpdir(), prefix));
    built = await buildStub(dir);
  });
  suiteTeardown(() => {
    removeDirRecursive(dir);
  });
  return (behaviour) => {
    writeFileSync(path.join(built.outDir, BEHAVIOUR_FILE), behaviour, 'utf8');
    return new WedgeDriver(built.apphost, TEST_DEADLINE_MS);
  };
}

suite('An adapter that stops answering the request to stop', () => {
  const start = useStub('sharplsp-wedge-');

  test('terminate that is answered but never honoured still ends the session', async () => {
    const driver = start(BEHAVIOUR.wedge);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq(driver.events('terminated').length, 0, 'nothing has ended the session yet');

      const stop = await driver.request('terminate');
      eq(stop.success, true, 'the adapter ANSWERS terminate — that is the whole trap');
      eq(driver.events('terminated').length, 0, 'answering it is not ending it: none yet');

      const ended = await driver.awaitTerminated();
      eq(ended.length, 1, 'the router ended the session exactly once');
      const told = driver.console();
      assertContainsAll(told, ['netcoredbg', 'stop'], 'told');
    } finally {
      driver.dispose();
    }
  });

  test('disconnect is owed an end on the same deadline as terminate', async () => {
    const driver = start(BEHAVIOUR.wedge);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('disconnect')).success, true, 'the adapter answers disconnect too');
      eq(driver.events('terminated').length, 0, 'answering disconnect did not end the session');

      const ended = await driver.awaitTerminated();
      eq(ended.length, 1, 'the router ended the session after disconnect went unhonoured');
    } finally {
      driver.dispose();
    }
  });

  test('an adapter that honours the stop is never second-guessed', async () => {
    const driver = start(BEHAVIOUR.honest);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('terminate')).success, true, 'terminate is answered');
      const ended = await driver.awaitTerminated();
      eq(ended.length, 1, "the adapter's own terminated reached the client");

      await new Promise((resolve) => setTimeout(resolve, TEST_DEADLINE_MS * 4));
      eq(driver.events('terminated').length, 1, 'and the deadline, disarmed, added no second one');
      eq(driver.console(), '', 'nothing was said to the user: nothing went wrong');
    } finally {
      driver.dispose();
    }
  });

  // VS Code replies to `terminated` with `disconnect` and holds the session
  // until that is answered: a launch made meanwhile found the dead session
  // still active, and a breakpoint edit reached an adapter that refused it.
  test('a disconnect the adapter exits on is answered for it', async () => {
    const driver = start(BEHAVIOUR.vanish);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('terminate')).success, true, 'terminate is answered');
      eq((await driver.awaitTerminated()).length, 1, "the adapter's own terminated arrived");

      const reply = await driver.request('disconnect');
      eq(reply.success, true, 'a gone adapter IS the disconnected state: the router answers');
      eq(reply.command, 'disconnect', 'the answer is to the disconnect itself');
      eq(driver.events('terminated').length, 1, 'the end was announced once, not again');
      eq(driver.console(), '', 'a session that ended cleanly reports no failure');
    } finally {
      driver.dispose();
    }
  });

  test('a restart inside the deadline retires it along with the adapter it was owed by', async () => {
    const driver = start(BEHAVIOUR.wedge);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq(
        (await driver.request('terminate')).success,
        true,
        'the first adapter answers the stop, then wedges',
      );
      // Stop visibly did nothing, so the user's next click is Restart. The
      // wedged adapter is retired as `replaced` — its death is ordered, never
      // reported — and a fresh one takes over the session.
      eq((await driver.request('restart')).success, true, 'restart is accepted');

      await new Promise((resolve) => setTimeout(resolve, TEST_DEADLINE_MS * 4));
      eq(
        driver.events('terminated').length,
        0,
        'the deadline the RETIRED adapter owed did not end the session the restart began',
      );
      eq(driver.console(), '', 'and the user was not told a replaced adapter stopped answering');
      eq(
        (await driver.request('threads')).success,
        true,
        'the restarted adapter is alive and answering',
      );

      // Retired, not disabled: a stop the NEW adapter wedges on is owed its own end.
      eq(
        (await driver.request('terminate')).success,
        true,
        'the restarted adapter answers a stop, then wedges',
      );
      const ended = await driver.awaitTerminated();
      eq(ended.length, 1, 'the router ended the session exactly once, on the fresh deadline');
    } finally {
      driver.dispose();
    }
  });

  test('a request that is not a stop request arms nothing', async () => {
    const driver = start(BEHAVIOUR.wedge);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq((await driver.request('threads')).success, true, 'an ordinary request is answered');
      await new Promise((resolve) => setTimeout(resolve, TEST_DEADLINE_MS * 4));
      eq(driver.events('terminated').length, 0, 'a session nobody asked to stop is never ended');
    } finally {
      driver.dispose();
    }
  });

  test('the shipped deadline leaves the teardown poll room to observe the end', () => {
    assert.ok(
      SHUTDOWN_DEADLINE_MS < DEBUG_SESSION_MS,
      `the router must give up before the teardown poll does: ${String(SHUTDOWN_DEADLINE_MS)} vs ${String(DEBUG_SESSION_MS)}`,
    );
    assert.ok(
      DEBUG_SESSION_MS - SHUTDOWN_DEADLINE_MS >= SHUTDOWN_DEADLINE_MS,
      'and leave at least another full deadline for the workbench to drop the session',
    );
    assert.ok(
      SHUTDOWN_DEADLINE_MS >= 10_000,
      `a healthy teardown must never be mistaken for a wedge: ${String(SHUTDOWN_DEADLINE_MS)}`,
    );
  });
});

// netcoredbg aborts a `threads` request still in flight when the debuggee
// resumes — the router's own `continue` past its injected entry stop, or the
// user's — and answers it "The operation was canceled". The workbench asked for
// that list on its own, so the Call Stack panel logged an error for a list one
// round trip away (#508). Implements [DEBUG-ADAPTER-GAPS].
suite('An adapter that cancels a threads request under a resume', () => {
  const start = useStub('sharplsp-threads-');

  test('the cancelled threads request is asked again and the client gets the list', async () => {
    const driver = start(BEHAVIOUR.cancelThreads);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');

      // Interaction 1 — the adapter cancels the client's threads request.
      const listed = await driver.request('threads');
      eq(listed.success, true, `the client gets the thread list: ${String(listed.message)}`);
      eq(listed.command, 'threads', 'as the answer to its own threads request');
      eq(
        driver.answers('threads').length,
        1,
        'exactly one answer reached the client, never the cancellation too',
      );

      // Interaction 2 — the adapter answers the next one itself.
      const again = await driver.request('threads');
      eq(again.success, true, 'a threads request the adapter answers is forwarded as it is');
      eq(again.request_seq, Number(listed.request_seq) + 1, 'answering the request that asked');
      eq(driver.events('terminated').length, 0, 'and nothing about this ends the session');
    } finally {
      driver.dispose();
    }
  });
});

// netcoredbg sometimes cannot evaluate the exception object on a stop: every
// `exceptionInfo` reply then names the type but carries no message and no stack
// ("Exception thrown: 'System.ApplicationException' in <unknown module>"), and
// re-asking never fills it in (#496). The router must recover the message
// another way — `evaluate` of `$exception.Message` in the stopped thread's top
// frame — and splice it into the reply before the client sees it. Implements
// [DEBUG-ADAPTER-GAPS].
suite('An adapter that answers exceptionInfo without the message', () => {
  const start = useStub('sharplsp-exception-');

  /** The reply's `details`, the part of the reply the panel shows. */
  const detailsOf = (message: DapMessage): Record<string, unknown> =>
    isRecord(message.body) && isRecord(message.body.details) ? message.body.details : {};

  /** A router over a stub told to `behave`, once its exception stop reached the client. */
  const stoppedOnException = async (behave: string): Promise<WedgeDriver> => {
    const driver = start(behave);
    eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
    await pollUntilResult(
      async () => driver.events('stopped'),
      (stops) => stops.length === 1,
      WAIT_MS,
      10,
      'the exception stop to reach the client',
    );
    return driver;
  };

  /** The reply's description, the line the panel heads with. */
  const descriptionOf = (message: DapMessage): string =>
    isRecord(message.body) ? String(message.body.description ?? '') : '';

  /** The session keeps serving requests, and nothing ended it. */
  const assertSessionLives = async (driver: WedgeDriver, why: string): Promise<void> => {
    eq((await driver.request('threads')).success, true, `${why}: the session keeps serving`);
    eq(driver.events('terminated').length, 0, `${why}: and nothing ended it`);
  };

  test('the message is recovered from $exception.Message and reaches the client', async () => {
    const driver = await stoppedOnException(BEHAVIOUR.unknownModuleException);
    try {
      // Interaction 1 — the reply the client receives must carry the message.
      const info = await driver.request('exceptionInfo', { threadId: 7 });
      eq(info.success, true, 'exceptionInfo succeeds');
      eq(
        detailsOf(info).message,
        EXCEPTION_MESSAGE_RESULT,
        'details.message was recovered through evaluate',
      );
      assertContainsAll(
        descriptionOf(info),
        [UNKNOWN_MODULE_DESCRIPTION, EXCEPTION_MESSAGE_RESULT],
        'the description, carrying the message too',
      );
      eq(driver.answers('exceptionInfo').length, 1, 'exactly one exceptionInfo answer');

      // Interaction 2 — the session is unaffected by the rescue.
      await assertSessionLives(driver, 'after the rescue');
    } finally {
      driver.dispose();
    }
  });

  test('a fallback that fails forwards the original reply and the session continues', async () => {
    const driver = await stoppedOnException(BEHAVIOUR.unknownModuleExceptionSilent);
    try {
      // Interaction 1 — the original reply arrives unchanged: nothing invented.
      const info = await driver.request('exceptionInfo', { threadId: 7 });
      eq(info.success, true, 'the original reply was forwarded');
      eq(detailsOf(info).message, undefined, 'no message was invented for the panel');
      assertContainsAll(descriptionOf(info), [UNKNOWN_MODULE_DESCRIPTION], 'its description');

      // Interaction 2 — a retried ask behaves the same, and the session lives on.
      const retry = await driver.request('exceptionInfo', { threadId: 7 });
      eq(retry.success, true, 'the retry is answered too');
      eq(driver.answers('exceptionInfo').length, 2, 'one answer per ask, never a duplicate');
      await assertSessionLives(driver, 'after the gap');
    } finally {
      driver.dispose();
    }
  });
});
