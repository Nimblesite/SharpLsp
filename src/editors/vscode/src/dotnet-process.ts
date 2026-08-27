/**
 * One place where the Test Explorer shells out to `dotnet`.
 *
 * Discovery (`test-discovery.ts`) and execution (`testing.ts`) previously each
 * carried their own `execFile` wrapper with different timeouts, different buffer
 * limits and different failure semantics — the run path capped stdout at Node's
 * 1 MiB default and gave up after 60 s, which a cold `dotnet test` on Windows
 * blows through during restore alone. Both now go through this module.
 *
 * The runner NEVER throws: it resolves a {@link DotnetRun} describing what the
 * process produced, and the caller decides whether that is usable. A killed
 * process is reported separately from a non-zero exit, because killed output is
 * TRUNCATED and must never be parsed as if it were complete.
 *
 * Implements [TEST-ENV-LOCALE].
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { CancellationToken } from 'vscode';
import { info } from './log.js';
import { err, ok, type Result } from './result.js';
import { getErrorMessage } from './utils.js';

/**
 * `dotnet test` restores, builds and then runs. On a cold Windows agent the
 * restore alone can take minutes, so the ceiling is generous; the caller's
 * cancellation, not this timeout, is the normal way a run ends early.
 */
export const DOTNET_TIMEOUT_MS = 600_000;

/** A full solution build log easily exceeds Node's 1 MiB default. */
export const DOTNET_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Every outcome this module reports is decided by matching ENGLISH text that the
 * .NET CLI and VSTest emit ("Passed!", "Error Message:", "Test run for "). Those
 * strings are localized, so on a non-English machine — a German or Japanese
 * Windows install is the common case — the parse silently fails and every test
 * reads as failed. Pinning the CLI's UI language makes the output we parse
 * deterministic regardless of the host's locale.
 */
export const DOTNET_CLI_LANGUAGE = 'en-US';

/** What a `dotnet` invocation produced. Never an exception. */
export interface DotnetRun {
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn failure or non-zero exit. */
  readonly failed: boolean;
  /**
   * Killed by the timeout or a signal. `stdout` is truncated at an arbitrary
   * point, so a partial listing must not be mistaken for a complete one.
   */
  readonly killed: boolean;
  /** Diagnostic for logs when `failed` is true. */
  readonly errorMessage: string | undefined;
}

/**
 * Absolute path to the `dotnet` executable resolved at activation
 * ([DIST-RUNTIME-ACQUIRE]). `dotnet` is NOT necessarily on `$PATH` — an
 * off-PATH SDK install is exactly what the acquisition step exists to handle —
 * so discovery and test runs must use the resolved path when there is one.
 */
let dotnetExecutable = 'dotnet';

/** Point every subsequent invocation at a specific `dotnet` executable. */
export function configureDotnet(executablePath: string | undefined): void {
  dotnetExecutable =
    executablePath === undefined || executablePath === '' ? 'dotnet' : executablePath;
}

/** The executable currently in use, for logging and assertions. */
export function currentDotnetExecutable(): string {
  return dotnetExecutable;
}

/** The environment a `dotnet` child inherits, with the UI language pinned. */
function dotnetEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DOTNET_CLI_UI_LANGUAGE: DOTNET_CLI_LANGUAGE };
}

/**
 * Run `dotnet` and resolve with everything it produced. Never rejects.
 *
 * `signal` is the caller's STOP: aborting it TERMINATES the invocation and
 * everything it spawned, instead of leaving the caller awaiting a process it no
 * longer wants. Without it, a Test Explorer run that batches the whole selection
 * into one `dotnet test` could not be stopped at all once the batch had started.
 *
 * Built on `spawn`, not `execFile`: `execFile` DROPS the `detached` option, and
 * without a process group of its own only the `dotnet` parent can be signalled —
 * leaving the testhost GRANDCHILD running the very tests the user just stopped.
 */
export async function runDotnet(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<DotnetRun> {
  if (signal?.aborted === true) return terminated(EMPTY, CANCELLED);
  return await new Promise<DotnetRun>((resolve) => {
    const capture: Capture = { stdout: '', stderr: '', reason: undefined };
    const child = spawn(dotnetExecutable, [...args], spawnOptions(cwd));
    absorbOutput(capture, child);
    const timer = setTimeout(() => {
      kill(capture, child, `timed out after ${String(timeoutMs)}ms`);
    }, timeoutMs);
    const detach = watchAbort(capture, child, signal);
    const settle = (run: DotnetRun): void => {
      clearTimeout(timer);
      detach();
      resolve(run);
    };
    child.once('error', (error: Error) => {
      settle({ ...capture, failed: true, killed: false, errorMessage: error.message });
    });
    child.once('close', (code, signalName) => {
      settle(toRun(capture, code, signalName));
    });
  });
}

/** A live `AbortSignal`, and the subscription keeping it fed. */
export interface Cancellation {
  readonly signal: AbortSignal;
  /** Unsubscribe from the token. Always call it once the run has settled. */
  readonly dispose: () => void;
}

/**
 * Bridge VS Code's ⏹ onto the {@link AbortSignal} {@link runDotnet} takes.
 *
 * It lives here rather than at each call site so every `dotnet` invocation the
 * extension makes can be made stoppable the same way.
 */
export function cancellationSignal(token: CancellationToken): Cancellation {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const subscription = token.onCancellationRequested(() => {
    controller.abort();
  });
  return {
    signal: controller.signal,
    dispose: () => {
      subscription.dispose();
    },
  };
}

/** Why a child was terminated, when the reason was cancellation. */
const CANCELLED = 'cancelled';

/** The output of an invocation that never produced any. */
const EMPTY: Capture = { stdout: '', stderr: '', reason: undefined };

/** Output accumulated so far, plus why (if at all) the child was terminated. */
interface Capture {
  stdout: string;
  stderr: string;
  /** Set once this module kills the child: timeout, overflow or cancellation. */
  reason: string | undefined;
}

/**
 * Spawn options for one invocation.
 *
 * On POSIX the child is `detached` so it LEADS ITS OWN PROCESS GROUP, which is
 * what makes {@link terminateTree} able to reap the testhost grandchild too.
 * Windows has no such groups, so `taskkill /T` walks the tree there instead.
 */
function spawnOptions(cwd: string): SpawnOptions {
  return {
    cwd,
    env: dotnetEnv(),
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
}

/** Stream both pipes into `capture`, enforcing the output ceiling as they grow. */
function absorbOutput(capture: Capture, child: ChildProcess): void {
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    capture.stdout += chunk;
    enforceCeiling(capture, child);
  });
  child.stderr?.on('data', (chunk: string) => {
    capture.stderr += chunk;
    enforceCeiling(capture, child);
  });
}

/** A run whose output outgrew the ceiling is killed; its output is truncated. */
function enforceCeiling(capture: Capture, child: ChildProcess): void {
  if (capture.stdout.length + capture.stderr.length <= DOTNET_MAX_BUFFER) return;
  kill(capture, child, `output exceeded ${String(DOTNET_MAX_BUFFER)} bytes`);
}

/** Terminate `child` when `signal` aborts; the returned function unsubscribes. */
function watchAbort(
  capture: Capture,
  child: ChildProcess,
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => {
    kill(capture, child, CANCELLED);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}

/** Terminate the tree once, recording why so the caller can be told. */
function kill(capture: Capture, child: ChildProcess, reason: string): void {
  if (capture.reason !== undefined) return;
  capture.reason = reason;
  info(`Terminating dotnet (pid ${String(child.pid ?? -1)}): ${reason}`);
  terminateTree(child);
}

/** How long a tree gets to exit on SIGTERM before it is SIGKILLed. */
const TREE_KILL_GRACE_MS = 3_000;

/** Kill the child AND everything it spawned — the tests live in a grandchild. */
function terminateTree(child: ChildProcess): void {
  const pid = child.pid;
  // A REAL pid or nothing. `process.kill(-0, …)` signals the CALLER'S OWN
  // process group, which in the extension host is every VS Code process there
  // is; a spawn that failed reports `undefined`, and `-undefined` is `NaN`.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    info(`Refusing to terminate a dotnet invocation with no real pid (${String(pid)})`);
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }).unref();
    return;
  }
  report(killGroup(pid, 'SIGTERM'), pid);
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      report(killGroup(pid, 'SIGKILL'), pid);
  }, TREE_KILL_GRACE_MS).unref();
}

/** Signal a whole process GROUP, reporting rather than throwing on failure. */
function killGroup(pid: number, signal: NodeJS.Signals): Result<void> {
  try {
    process.kill(-pid, signal);
    return ok(undefined);
  } catch (error: unknown) {
    return err(getErrorMessage(error));
  }
}

/** Log a failed kill; an already-reaped tree is the ordinary reason. */
function report(outcome: Result<void>, pid: number): void {
  if (!outcome.ok) info(`Could not signal dotnet process group ${String(pid)}: ${outcome.error}`);
}

/** Shape a finished child into a {@link DotnetRun}. */
function toRun(
  capture: Capture,
  code: number | null,
  signalName: NodeJS.Signals | null,
): DotnetRun {
  if (capture.reason !== undefined) return terminated(capture, capture.reason);
  if (signalName !== null) return terminated(capture, `killed by ${signalName}`);
  if (code === 0) return { ...capture, failed: false, killed: false, errorMessage: undefined };
  const trimmed = capture.stderr.trim();
  return {
    ...capture,
    failed: true,
    killed: false,
    errorMessage: trimmed === '' ? `dotnet exited with code ${String(code ?? -1)}` : trimmed,
  };
}

/**
 * A run the child did NOT complete on its own terms.
 *
 * `killed` is reported separately from a non-zero exit because killed output is
 * TRUNCATED at an arbitrary point and must never be parsed as a complete
 * listing — see {@link DotnetRun}.
 */
function terminated(capture: Capture, reason: string): DotnetRun {
  return {
    stdout: capture.stdout,
    stderr: capture.stderr,
    failed: true,
    killed: true,
    errorMessage: `dotnet was terminated: ${reason}`,
  };
}
