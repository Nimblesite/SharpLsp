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

/**
 * `text` collapsed onto ONE line, for somewhere that can only render one.
 *
 * A CodeLens title is the case that forces it: a TRX `ErrorInfo` carries the
 * assertion, its expected/actual block and often a stack trace, newline
 * separated, and a lens shows the first line and drops the rest. Trimming each
 * part before joining also disposes of the `\r` half of a CRLF, so the result
 * is the same on either platform.
 */
/** Resolve after `ms` milliseconds — the one delay every poller waits on. */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function singleLine(text: string): string {
  return text
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}
