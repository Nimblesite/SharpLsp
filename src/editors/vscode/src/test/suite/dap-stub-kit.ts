// The stub DAP adapter: a built F# console app that speaks netcoredbg's wire
// and misbehaves on demand, so router recoveries are tested deterministically.
// See dap-shutdown-wedge.test.ts for why a stub, and why an apphost.
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle".
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DapRouter } from '../../dap-router';
import { isRecord, type DapMessage } from '../../dap-emulate';
import { buildProjectXml, writeProject } from './dotnet-project-kit';
import { TFM, buildProject, isolateFromRepoMsbuild } from './run-debug-fixtures';
import { COMMAND_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { eq, pollUntilResult, removeDirRecursive } from './test-helpers';

/** How long this suite gives the router's own deadline to fire. */
export const TEST_DEADLINE_MS = 400;

/**
 * Budget for one wait on the stub: a response, or the router's synthesised
 * `terminated`. The stub answers in milliseconds and the deadline under test
 * is TEST_DEADLINE_MS, so COMMAND_MS is more than ten times what either
 * needs, and sits well under the default test ceiling — a wait that could
 * outlive its test would be killed by mocha with no diagnostic.
 */
export const WAIT_MS = COMMAND_MS;

/** The stub reads this file beside its apphost to learn how to misbehave. */
const BEHAVIOUR_FILE = 'behaviour.txt';

/** What the stub does after answering a stop request. */
export const BEHAVIOUR = {
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
  /**
   * Refuses the FIRST `configurationDone` it is ever sent — across respawns —
   * with E_FAIL, as netcoredbg does when a launched runtime misses its 5s
   * startup wait on a cold machine; every later process answers it.
   */
  coldStart: 'coldStart',
  /** Refuses every `configurationDone`: a runtime that never starts in time. */
  coldStartAlways: 'coldStartAlways',
} as const;

/** netcoredbg's answer when it cannot evaluate the exception object (#496). */
export const UNKNOWN_MODULE_DESCRIPTION =
  "Exception thrown: 'System.ApplicationException' in <unknown module>";

/** What the stub's `$exception.Message` evaluate answers. */
export const EXCEPTION_MESSAGE_RESULT = 'unhandled-by-design';

/** netcoredbg's answer when the launched runtime missed its startup wait. */
export const STARTUP_REFUSAL = "Failed command 'configurationDone' : 0x80004005";

/** Beside the apphost: each process's `spawn`, then every command it was sent. */
const COMMANDS_FILE = 'commands.log';

/** Beside the apphost: present once a cold start has refused once. */
const COLD_MARKER = 'cold.seen';

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

let besideStub (name: string) = Path.Combine(AppContext.BaseDirectory, name)

let cold = behaviour = "${BEHAVIOUR.coldStart}" || behaviour = "${BEHAVIOUR.coldStartAlways}"

let record (entry: string) =
    if cold then File.AppendAllText(besideStub "${COMMANDS_FILE}", entry + "\n")

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
    record "spawn"
    let hidesExceptionMessage =
        behaviour = "${BEHAVIOUR.unknownModuleException}"
        || behaviour = "${BEHAVIOUR.unknownModuleExceptionSilent}"
    while true do
        use request = JsonDocument.Parse(readBody (contentLength ()))
        let root = request.RootElement
        if root.GetProperty("type").GetString() = "request" then
            let command = root.GetProperty("command").GetString()
            let requestSeq = root.GetProperty("seq").GetInt32()
            record command
            // vanish: gone before the disconnect is answered
            if behaviour = "${BEHAVIOUR.vanish}" && command = "disconnect" then exit 0
            // cancelThreads: the first threads request is aborted by a resume
            if behaviour = "${BEHAVIOUR.cancelThreads}" && command = "threads" && not threadsCancelled then
                threadsCancelled <- true
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = false; message = "${THREADS_CANCELLED}"; body = {| |} |}
            // coldStart: the launched runtime missed netcoredbg's startup wait
            elif cold && command = "configurationDone" && (behaviour = "${BEHAVIOUR.coldStartAlways}" || not (File.Exists(besideStub "${COLD_MARKER}"))) then
                File.WriteAllText(besideStub "${COLD_MARKER}", "")
                send {| \`\`type\`\` = "response"; seq = 0; request_seq = requestSeq; command = command; success = false; message = "${STARTUP_REFUSAL}"; body = {| |} |}
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
            // netcoredbg announces it is ready for configuration once initialized
            if cold && command = "initialize" then
                send {| \`\`type\`\` = "event"; seq = 0; event = "initialized"; body = {| |} |}
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
export class WedgeDriver {
  public readonly emitted: DapMessage[] = [];
  private readonly router: DapRouter;
  private seq = 0;

  constructor(
    apphost: string,
    deadlineMs: number,
    private readonly outDir = '',
  ) {
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
    return this.matching((message) => message.type === 'event' && message.event === name);
  }

  /** Every answer to `command` the router has sent the client so far. */
  public answers(command: string): DapMessage[] {
    return this.matching((message) => message.type === 'response' && message.command === command);
  }

  /** The messages among what the router emitted that `predicate` accepts. */
  private matching(predicate: (message: DapMessage) => boolean): DapMessage[] {
    return this.emitted.filter(predicate);
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

  /** What the stub recorded: `spawn` per process, then each command it was sent. */
  public commands(): string[] {
    const file = path.join(this.outDir, COMMANDS_FILE);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  }

  public dispose(): void {
    this.router.dispose();
  }
}

/** The stub ANSWERED `command`: a wedge is a silence, never a refused request. */
export async function assertAnswered(
  driver: WedgeDriver,
  command: string,
  why: string,
): Promise<void> {
  eq((await driver.request(command)).success, true, why);
}

/**
 * Build the stub once for the calling suite, and remove it after. The returned
 * `start` tells the stub how to misbehave, then puts a fresh router over it.
 */
export function useStub(prefix: string): (behaviour: string) => WedgeDriver {
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
    rmSync(path.join(built.outDir, COMMANDS_FILE), { force: true });
    rmSync(path.join(built.outDir, COLD_MARKER), { force: true });
    return new WedgeDriver(built.apphost, TEST_DEADLINE_MS, built.outDir);
  };
}
