import * as fs from 'node:fs';

/**
 * A plain, non-null object — the only shape a parsed JSON node, an MSBuild
 * property bag or a DAP message body can take.
 *
 * `typeof null` is `'object'` and so is an array, so both are excluded
 * explicitly. Five modules had written this out identically before it was
 * given one home.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract a human-readable message from an unknown error value. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve after `ms` milliseconds — the one delay every poller waits on. */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `text` collapsed onto ONE line, for somewhere that can only render one.
 *
 * A CodeLens title is the case that forces it: a TRX `ErrorInfo` carries the
 * assertion, its expected/actual block and often a stack trace, newline
 * separated, and a lens shows the first line and drops the rest. Trimming each
 * part before joining also disposes of the `\r` half of a CRLF, so the result
 * is the same on either platform.
 */
export function singleLine(text: string): string {
  return splitTrimmed(text, '\n').join(' ');
}

/**
 * The non-blank parts of `text` split on `separator`, each trimmed: a `;`
 * MSBuild list or `PATHEXT`, a `,` glob list, the lines of a listing. Trimming
 * also disposes of the `\r` half of a CRLF line.
 */
export function splitTrimmed(text: string, separator: string): string[] {
  return text
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Escape `text` for the profiler panels, which place it only in element text
 * and double-quoted attributes. A single quote is deliberately left alone —
 * the profiler suite pins that — so do not use this for a single-quoted
 * attribute or a JS string; the NuGet browser's `esc`/`escAttr` cover those.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * `rmSync` options for a recursive delete that survives Windows file-handle races.
 *
 * `force: true` only swallows ENOENT — it does NOT retry. On Windows a directory
 * whose file a just-exited child (dotnet, VBCSCompiler, a sidecar) still holds
 * open fails with EPERM/EBUSY; Node retries exactly those codes when given
 * `maxRetries`/`retryDelay`. One home, so the retry policy cannot drift between
 * call sites. Implements [DIST-CI-WIN-VSIX].
 */
export const RETRYING_RM: fs.RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};

/**
 * Best-effort recursive delete. Once the retries are exhausted, a handle a
 * child process leaked must not fail the caller: thrown from a `finally`, it
 * would discard a result that was already complete.
 */
export function removeDirRecursive(target: string): void {
  try {
    fs.rmSync(target, RETRYING_RM);
  } catch {
    // Best-effort by contract: the caller's result stands without the delete.
  }
}
