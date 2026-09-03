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
export function singleLine(text: string): string {
  return text
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}
