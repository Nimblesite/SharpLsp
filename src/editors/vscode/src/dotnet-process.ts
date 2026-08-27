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

import { execFile } from 'node:child_process';

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
  dotnetExecutable = executablePath === undefined || executablePath === '' ? 'dotnet' : executablePath;
}

/** The executable currently in use, for logging and assertions. */
export function currentDotnetExecutable(): string {
  return dotnetExecutable;
}

/** The environment a `dotnet` child inherits, with the UI language pinned. */
function dotnetEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DOTNET_CLI_UI_LANGUAGE: DOTNET_CLI_LANGUAGE };
}

/** Run `dotnet` and resolve with everything it produced. Never rejects. */
export async function runDotnet(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = DOTNET_TIMEOUT_MS,
): Promise<DotnetRun> {
  return new Promise<DotnetRun>((resolve) => {
    execFile(
      dotnetExecutable,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: DOTNET_MAX_BUFFER, env: dotnetEnv() },
      (error, stdout, stderr) => {
        resolve(toRun(error, stdout, stderr));
      },
    );
  });
}

/** Node's code when it kills a child for overflowing `maxBuffer`. */
const MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/** Shape an `execFile` callback triple into a {@link DotnetRun}. */
function toRun(error: ExecFileError | null, stdout: string, stderr: string): DotnetRun {
  if (error === null) {
    return { stdout, stderr, failed: false, killed: false, errorMessage: undefined };
  }
  const trimmedErr = stderr.trim();
  return {
    stdout,
    stderr,
    failed: true,
    killed: wasKilled(error),
    errorMessage: trimmedErr === '' ? error.message : trimmedErr,
  };
}

/** What `execFile` reports on failure, beyond a plain Error. */
interface ExecFileError extends Error {
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
  readonly code?: string | number;
}

/**
 * True when the child was TERMINATED rather than merely exiting non-zero.
 *
 * `killed` covers the timeout, a signal covers an external kill, and Node
 * reports a `maxBuffer` overflow with its own code after killing the child. All
 * three leave stdout truncated at an arbitrary point, so the output must never
 * be parsed as a complete listing.
 */
function wasKilled(error: ExecFileError): boolean {
  return (
    error.killed === true ||
    (error.signal !== undefined && error.signal !== null) ||
    error.code === MAXBUFFER_CODE
  );
}
