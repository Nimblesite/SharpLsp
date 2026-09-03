// Debugging a unit test through the Test Explorer's Debug profile.
//
// Implements [DEBUG-FEATURES-TESTS]: the selection runs in ONE `dotnet test`
// with `VSTEST_HOST_DEBUG=1`, each test host prints `Process Id: <pid>, Name:
// <name>` and waits, and SharpLsp attaches the `sharplsp-coreclr` debugger to
// that waiting TEST HOST child — never to the parent `dotnet test`, which only
// spawns the host and loads no user code. The attach configuration carries
// `justMyCode: true` ("Just My Code in test context | launch config | P1") and
// the [DEBUG-FEATURES-TESTS] marker dap-attach.ts uses to resume the host's
// own `Debugger.Break()` so the first visible stop is the user's breakpoint.
//
// The run's output is mirrored into a live `SharpLsp Test Debug` terminal —
// the run itself must be spawned by the extension so this module can read the
// host announcements, so the terminal is a pseudoterminal fed the same stream.
// A debug run never writes the result cache: its outcomes are distorted by the
// debugging itself (a session stopped mid-test reports nothing), so the last
// REAL run's result stands.
//
// Nothing here throws: attach refusals surface through the attach resolver's
// one-message contract and ABORT the run — a test host left waiting for a
// debugger that never comes would wedge the controller's queue forever.
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './constants';
import { whenDebugSessionConfigured } from './debug';
import { TEST_HOST_ATTACH_FLAG } from './dap-attach';
import { error, info, warn } from './log';
import { runTests, type TestRunOptions, type TestRunOutcome } from './test-execution';
import { filterBatches } from './test-filter';
import { runTarget } from './test-targets';

/**
 * The child environment of a test DEBUG run.
 *
 * `VSTEST_HOST_DEBUG=1` makes every test host announce its pid and wait for a
 * debugger. `VSTEST_RUNNER_DEBUG=0` pins the PARENT runner to NOT wait even if
 * the user's environment set it: the runner announces the same-shaped line,
 * and attaching to it is exactly the wrong-process defect this module exists
 * to prevent. Spec: [DEBUG-FEATURES-TESTS].
 */
export const TEST_HOST_DEBUG_ENV: Readonly<Record<string, string>> = {
  VSTEST_HOST_DEBUG: '1',
  VSTEST_RUNNER_DEBUG: '0',
};

/** The terminal the Debug profile mirrors the run's output into. */
export const TEST_DEBUG_TERMINAL_NAME = 'SharpLsp Test Debug';

/**
 * How long a debug run may live. A debuggee parked on a breakpoint is the
 * POINT of the exercise, so the ordinary `dotnet` ceiling (10 minutes) would
 * kill the run under the user mid-thought; ⏹ and stopping the debug session
 * are the intended exits, and this ceiling only reaps a run nobody ended.
 */
const DEBUG_RUN_CEILING_MS = 24 * 60 * 60 * 1_000;

/** The stable prefix of VSTest's waiting-host announcement, en-US pinned. */
const PROCESS_ID_PREFIX = 'Process Id:';

/** What the debug flow needs from the owning test controller. */
export interface TestDebugHost {
  /** Serialise behind every other `dotnet` invocation the controller makes. */
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  /** Report a finished invocation onto the RUN — never onto the result cache. */
  finish(run: vscode.TestRun, tests: readonly vscode.TestItem[], outcome: TestRunOutcome): void;
}

/** ASCII digits only, checked per UTF-16 unit — a pid is never a surrogate. */
function isAllDigits(candidate: string): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

/**
 * The pid a waiting test host announced on `line`, or undefined.
 *
 * The contract is VSTest's own console line, `Process Id: {0}, Name: {1}`,
 * printed by the HOST about itself — the parent never prints it with
 * `VSTEST_RUNNER_DEBUG` pinned off. The digits are validated whole: a partial
 * `parseInt` would accept a corrupted line and aim the debugger at noise.
 */
export function announcedTestHostPid(line: string): number | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PROCESS_ID_PREFIX)) return undefined;
  const rest = trimmed.slice(PROCESS_ID_PREFIX.length);
  const comma = rest.indexOf(',');
  const digits = (comma === -1 ? rest : rest.slice(0, comma)).trim();
  if (digits.length === 0 || !isAllDigits(digits)) return undefined;
  const pid = Number.parseInt(digits, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Watches a debug run's live output for waiting test hosts, once each.
 *
 * Chunk boundaries fall anywhere, so lines are reassembled before parsing; a
 * solution with several test projects announces one host PER ASSEMBLY, and
 * every one of them is waiting — each new pid is handed on exactly once.
 */
export class TestHostWatcher {
  private tail = '';
  private readonly announced = new Set<number>();

  constructor(private readonly onHost: (pid: number) => void) {}

  /** Feed one raw output chunk; complete lines are scanned for announcements. */
  public absorb(chunk: string): void {
    const lines = (this.tail + chunk).split('\n');
    this.tail = lines.pop() ?? '';
    for (const line of lines) this.offer(line);
  }

  private offer(line: string): void {
    const pid = announcedTestHostPid(line);
    if (pid === undefined || this.announced.has(pid)) return;
    this.announced.add(pid);
    this.onHost(pid);
  }
}

/** The attach configuration aimed at one waiting test host. */
export function testHostAttachConfig(pid: number, label: string): vscode.DebugConfiguration {
  return {
    type: DEBUG_TYPE,
    request: 'attach',
    name: label,
    processId: pid,
    justMyCode: true,
    [TEST_HOST_ATTACH_FLAG]: true,
  };
}

/**
 * A read-only pseudoterminal mirroring the debug run's output.
 *
 * VS Code only delivers pseudoterminal writes after `open`, so early output is
 * buffered. The USER closing the terminal cancels the run; the run ending
 * closes the terminal.
 */
class DebugRunTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;
  private buffered = '';
  private opened = false;
  private ended = false;

  constructor(private readonly onUserClose: () => void) {}

  public open(): void {
    this.opened = true;
    if (this.buffered.length > 0) {
      this.writeEmitter.fire(this.buffered);
      this.buffered = '';
    }
  }

  /** VS Code's notice that the USER disposed the terminal. */
  public close(): void {
    if (this.ended) return;
    // Closing the terminal is a STOP gesture: it aborts the `dotnet test` tree
    // and with it the host being debugged. Said out loud, because the symptom
    // otherwise is a debug session that dies seconds after it attached with
    // nothing anywhere explaining why.
    info('Test debug: the run terminal was closed; aborting the run');
    this.onUserClose();
  }

  /** Mirror one output chunk, normalised to the CRLF terminals require. */
  public write(chunk: string): void {
    const text = chunk.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
    if (!this.opened) {
      this.buffered += text;
      return;
    }
    this.writeEmitter.fire(text);
  }

  /** The run is over; close the terminal window. */
  public end(): void {
    if (this.ended) return;
    this.ended = true;
    this.closeEmitter.fire();
  }
}

/**
 * Debug `tests`: one `dotnet test` under VSTEST_HOST_DEBUG, attached to each
 * waiting host. Resolves once the first attach attempt settles OR the run
 * ends without ever producing a waiting host (a build failure), whichever
 * comes first — the run itself continues until the debugged tests finish, and
 * its outcomes land on `run` when they do.
 */
export async function debugSelectedTests(
  host: TestDebugHost,
  run: vscode.TestRun,
  tests: readonly vscode.TestItem[],
  token: vscode.CancellationToken,
  cwd: string,
  filterIds: readonly string[] = tests.map((test) => test.id),
): Promise<void> {
  await new DebugRunFlow(host, run, tests, cwd, filterIds).start(token);
}

/** One Debug-profile gesture: the run, its terminal, and its attaches. */
class DebugRunFlow {
  /** Aborting kills the whole `dotnet test` tree — no host is left waiting. */
  private readonly stop = new AbortController();
  private readonly terminal = new DebugRunTerminal(() => {
    this.stop.abort();
  });
  private onFirstAttach: () => void = () => undefined;
  private readonly attached = new Promise<void>((resolve) => {
    this.onFirstAttach = resolve;
  });
  private readonly watcher = new TestHostWatcher((pid) => {
    void this.attach(pid);
  });

  constructor(
    private readonly host: TestDebugHost,
    private readonly run: vscode.TestRun,
    private readonly tests: readonly vscode.TestItem[],
    private readonly cwd: string,
    private readonly filterIds: readonly string[],
  ) {}

  /** Race "a session exists" against "the run died before any host waited". */
  public async start(token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) this.stop.abort();
    const bridge = token.onCancellationRequested(() => {
      this.stop.abort();
    });
    vscode.window.createTerminal({ name: TEST_DEBUG_TERMINAL_NAME, pty: this.terminal }).show(true);
    try {
      await Promise.race([this.attached, this.settle()]);
    } finally {
      bridge.dispose();
    }
  }

  /** Run the invocation to completion and report it, whatever start() raced. */
  private async settle(): Promise<void> {
    try {
      const outcome = await this.invoke();
      const failure = outcome.failure === undefined ? '' : `; failure: ${outcome.failure}`;
      info(`Test debug: the run ended with ${String(outcome.results.size)} result(s)${failure}`);
      this.host.finish(this.run, this.tests, outcome);
    } catch (cause) {
      error(`Test debug run failed to settle: ${String(cause)}`);
    } finally {
      this.run.end();
      this.terminal.end();
    }
  }

  /** One queued, cancellable `dotnet test` with the host-debug environment. */
  private async invoke(): Promise<TestRunOutcome> {
    // A debug run is ALWAYS one invocation: every VSTest host under
    // `VSTEST_HOST_DEBUG=1` WAITS for a debugger attach, so chunking a huge
    // selection into batches would strand the second host's tests. A selection
    // too big for one command line runs UNFILTERED instead — every test in the
    // project runs, breakpoints in the selection still hit, and the run never
    // dies with `spawn ENAMETOOLONG` before a host can wait.
    const oversized = filterBatches(this.filterIds).length > 1;
    if (oversized) {
      warn(
        `Test debug: selection exceeds one command line; running unfiltered instead of ${String(
          this.filterIds.length,
        )} filtered tests`,
      );
    }
    const ids = oversized ? [] : this.filterIds;
    const target = runTarget();
    const options: TestRunOptions = {
      signal: this.stop.signal,
      timeoutMs: DEBUG_RUN_CEILING_MS,
      hooks: {
        env: TEST_HOST_DEBUG_ENV,
        onOutput: (chunk) => {
          this.watcher.absorb(chunk);
          this.terminal.write(chunk);
        },
      },
      ...(target === undefined ? {} : { target }),
    };
    return await this.host.enqueue(async () => await runTests(ids, this.cwd, options));
  }

  /**
   * Attach the SharpLsp debugger to one waiting test host. A refusal is
   * already reported by the attach resolver's one-message contract
   * ([DEBUG-FEATURES-LAUNCH-SCRIPT] rule 6 as the attach path inherits it),
   * and ABORTS the run: an unattached host waits forever.
   */
  private async attach(pid: number): Promise<void> {
    info(`Test debug: attaching to waiting test host pid ${String(pid)}`);
    try {
      const config = testHostAttachConfig(pid, this.label());
      // Latched BEFORE the session can start: `onDidStartDebugSession` fires
      // while `startDebugging` is still resolving, so a listener registered
      // afterwards would miss its own session.
      const session = this.captureSession(pid);
      const started = await vscode.debug.startDebugging(this.folder(), config);
      if (!started) {
        warn(`Test debug: the workbench refused the attach to pid ${String(pid)}`);
        this.stop.abort();
      } else {
        await this.settleSession(await session, pid);
      }
    } catch (cause) {
      warn(`Test debug: attach to pid ${String(pid)} threw: ${String(cause)}`);
      this.stop.abort();
    } finally {
      this.onFirstAttach();
    }
  }

  /**
   * The session the next `startDebugging` produces, matched by the pid this
   * flow aimed it at.
   *
   * Never rejects and never leaks the listener: the caller always awaits it,
   * and {@link settleSession} tolerates `undefined` for the case where the
   * workbench started something this flow cannot identify.
   */
  private async captureSession(pid: number): Promise<vscode.DebugSession | undefined> {
    return await new Promise((resolve) => {
      const listener = vscode.debug.onDidStartDebugSession((candidate) => {
        // Matched on the pid, not the session NAME: two hosts of one solution
        // are attached under labels that differ only by the tests selected, and
        // the workbench is free to decorate a name it displays. The pid is the
        // identity this flow actually chose.
        if (Number(candidate.configuration['processId']) !== pid) return;
        listener.dispose();
        resolve(candidate);
      });
      // The workbench refusing the attach resolves `startDebugging` without
      // ever starting a session; the caller's `await` must not hang on that.
      this.stop.signal.addEventListener('abort', () => {
        listener.dispose();
        resolve(undefined);
      });
    });
  }

  /**
   * Wait for the workbench to finish CONFIGURING the session, not merely to
   * have created it.
   *
   * `startDebugging` resolves once the session exists — before the breakpoints
   * it is about to send have been acknowledged and before `configurationDone`.
   * Reporting the attach as settled there is what makes the Debug press look
   * like it did nothing: the run hands control back while the debugger is still
   * coming up, so the user's breakpoint is not armed when the waiting host
   * resumes (issue #233). Spec: [DEBUG-FEATURES-TESTS].
   */
  private async settleSession(
    session: vscode.DebugSession | undefined,
    pid: number,
  ): Promise<void> {
    if (session === undefined) return;
    await whenDebugSessionConfigured(session);
    info(`Test debug: session for pid ${String(pid)} is configured and running`);
  }

  /** The workspace folder the debug session is scoped to. */
  private folder(): vscode.WorkspaceFolder | undefined {
    return (
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.cwd)) ??
      vscode.workspace.workspaceFolders?.[0]
    );
  }

  /** A session name the user can identify in the debug toolbar. */
  private label(): string {
    const first = this.tests[0]?.label ?? 'tests';
    return this.tests.length === 1
      ? `Debug test: ${first}`
      : `Debug ${String(this.tests.length)} tests`;
  }
}
