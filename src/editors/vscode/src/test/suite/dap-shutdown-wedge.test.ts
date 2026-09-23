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
import { eq, pollUntilResult, removeDirRecursive } from './test-helpers';

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
} as const;

const STUB_NAME = 'WedgedAdapter';

/**
 * The stub. Every request is answered `success: true`; what follows a
 * `terminate` or `disconnect` is decided by the behaviour file. The process
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
    while true do
        use request = JsonDocument.Parse(readBody (contentLength ()))
        let root = request.RootElement
        if root.GetProperty("type").GetString() = "request" then
            let command = root.GetProperty("command").GetString()
            send {| \`\`type\`\` = "response"; seq = 0; request_seq = root.GetProperty("seq").GetInt32(); command = command; success = true; body = {| |} |}
            if behaviour = "${BEHAVIOUR.honest}" && (command = "terminate" || command = "disconnect") then
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
  public async request(command: string): Promise<DapMessage> {
    const seq = ++this.seq;
    this.router.handleMessage({ type: 'request', seq, command, arguments: {} });
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

suite('An adapter that stops answering the request to stop', () => {
  let dir = '';
  let apphost = '';
  let outDir = '';

  suiteSetup(async function () {
    // A real `dotnet build` of the F# stub: NuGet restore of FSharp.Core plus
    // the F# compiler, once for the suite. Cold on a CI runner that is tens of
    // seconds — the same budget every other suite that builds a fixture uses.
    this.timeout(FIXTURE_BUILD_MS);
    dir = mkdtempSync(path.join(tmpdir(), 'sharplsp-wedge-'));
    ({ apphost, outDir } = await buildStub(dir));
  });

  suiteTeardown(() => {
    removeDirRecursive(dir);
  });

  const behave = (behaviour: string): void => {
    writeFileSync(path.join(outDir, BEHAVIOUR_FILE), behaviour, 'utf8');
  };

  test('terminate that is answered but never honoured still ends the session', async () => {
    behave(BEHAVIOUR.wedge);
    const driver = new WedgeDriver(apphost, TEST_DEADLINE_MS);
    try {
      eq((await driver.request('initialize')).success, true, 'the stub is speaking DAP');
      eq(driver.events('terminated').length, 0, 'nothing has ended the session yet');

      const stop = await driver.request('terminate');
      eq(stop.success, true, 'the adapter ANSWERS terminate — that is the whole trap');
      eq(driver.events('terminated').length, 0, 'answering it is not ending it: none yet');

      const ended = await driver.awaitTerminated();
      eq(ended.length, 1, 'the router ended the session exactly once');
      const told = driver.console();
      assert.ok(
        told.includes('netcoredbg'),
        `the user is told WHICH component stopped answering: ${told}`,
      );
      assert.ok(told.includes('stop'), `and WHAT it stopped answering: ${told}`);
    } finally {
      driver.dispose();
    }
  });

  test('disconnect is owed an end on the same deadline as terminate', async () => {
    behave(BEHAVIOUR.wedge);
    const driver = new WedgeDriver(apphost, TEST_DEADLINE_MS);
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
    behave(BEHAVIOUR.honest);
    const driver = new WedgeDriver(apphost, TEST_DEADLINE_MS);
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

  test('a restart inside the deadline retires it along with the adapter it was owed by', async () => {
    behave(BEHAVIOUR.wedge);
    const driver = new WedgeDriver(apphost, TEST_DEADLINE_MS);
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
    behave(BEHAVIOUR.wedge);
    const driver = new WedgeDriver(apphost, TEST_DEADLINE_MS);
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
