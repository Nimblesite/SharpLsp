/**
 * Output-channel filtering for the SharpLsp server log.
 *
 * The language client forwards the server's raw stderr into the user-facing
 * "SharpLsp" Output panel. That stream can contain ANSI escape sequences (e.g.
 * terminal color codes) which render as garbage in the panel. We strip them
 * defensively before anything reaches the channel. See issue #78 / [DIST-CLEAN-OUTPUT].
 *
 * The stripper is a small character scanner (no regular expressions, per the
 * project's "use real parsers, not regex" rule).
 */
import type { LogOutputChannel, OutputChannel, ViewColumn } from 'vscode';

const ESC = '\u001b';
const BEL = '\u0007';

/** A CSI sequence's final byte is in the range 0x40–0x7E (`@` … `~`). */
function isCsiFinalByte(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

/** Index just past a CSI sequence (`ESC [` … final byte) starting at `open`. */
function skipCsi(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length && !isCsiFinalByte(text[i] ?? '')) {
    i += 1;
  }
  return i + 1;
}

/** Index just past an OSC sequence (`ESC ]` … `BEL` or `ESC \`) starting at `open`. */
function skipOsc(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length && text[i] !== BEL && !(text[i] === ESC && text[i + 1] === '\\')) {
    i += 1;
  }
  return text[i] === ESC ? i + 2 : i + 1;
}

/** Index just past the escape sequence that starts at `start` (an `ESC`). */
function skipEscapeSequence(text: string, start: number): number {
  const next = text[start + 1];
  if (next === '[') {
    return skipCsi(text, start + 1);
  }
  if (next === ']') {
    return skipOsc(text, start + 1);
  }
  // Any other escape consumes ESC plus a single following byte.
  return start + 2;
}

/** Remove ANSI escape sequences (color codes, cursor moves, OSC, …) from `text`. */
export function stripAnsi(text: string): string {
  if (!text.includes(ESC)) {
    return text;
  }
  const parts: string[] = [];
  let segmentStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC) {
      parts.push(text.slice(segmentStart, i));
      i = skipEscapeSequence(text, i);
      segmentStart = i;
    } else {
      i += 1;
    }
  }
  parts.push(text.slice(segmentStart));
  return parts.join('');
}

/** Forward the free-text writes with ANSI stripped. */
function writeMethods(
  inner: LogOutputChannel,
): Pick<OutputChannel, 'append' | 'appendLine' | 'replace'> {
  return {
    append: (value: string): void => {
      inner.append(stripAnsi(value));
    },
    appendLine: (value: string): void => {
      inner.appendLine(stripAnsi(value));
    },
    replace: (value: string): void => {
      inner.replace(stripAnsi(value));
    },
  };
}

/**
 * Forward the level-tagged log methods with ANSI stripped from the message.
 * An `Error` passed to `error` is forwarded as-is: its message is rendered by
 * the channel, not written as raw text, so it carries no escape sequences.
 */
function logMethods(
  inner: LogOutputChannel,
): Pick<LogOutputChannel, 'trace' | 'debug' | 'info' | 'warn' | 'error'> {
  return {
    trace: (message: string, ...args: unknown[]): void => {
      inner.trace(stripAnsi(message), ...args);
    },
    debug: (message: string, ...args: unknown[]): void => {
      inner.debug(stripAnsi(message), ...args);
    },
    info: (message: string, ...args: unknown[]): void => {
      inner.info(stripAnsi(message), ...args);
    },
    warn: (message: string, ...args: unknown[]): void => {
      inner.warn(stripAnsi(message), ...args);
    },
    error: (error: string | Error, ...args: unknown[]): void => {
      inner.error(typeof error === 'string' ? stripAnsi(error) : error, ...args);
    },
  };
}

/** Forward the non-writing operations unchanged. */
function lifecycleMethods(
  inner: LogOutputChannel,
): Pick<OutputChannel, 'clear' | 'show' | 'hide' | 'dispose'> {
  return {
    clear: (): void => {
      inner.clear();
    },
    show: (column?: ViewColumn | boolean, preserveFocus?: boolean): void => {
      // Forward only the non-deprecated single-argument `show` overload.
      inner.show(typeof column === 'boolean' ? column : preserveFocus);
    },
    hide: (): void => {
      inner.hide();
    },
    dispose: (): void => {
      inner.dispose();
    },
  };
}

/**
 * Wrap a log output channel so every write has ANSI escape sequences stripped.
 * Non-writing operations (show/hide/clear/dispose) delegate unchanged.
 *
 * `vscode-languageclient` v10 types `LanguageClientOptions.outputChannel` as a
 * `LogOutputChannel`, so the wrapper forwards the log-level surface too.
 * `name`, `logLevel`, and `onDidChangeLogLevel` are getters rather than copied
 * values: the user can change the channel's log level at any time, and a
 * snapshot would silently report a stale level forever.
 */
export function createAnsiStrippingChannel(inner: LogOutputChannel): LogOutputChannel {
  return {
    get name(): string {
      return inner.name;
    },
    get logLevel() {
      return inner.logLevel;
    },
    get onDidChangeLogLevel() {
      return inner.onDidChangeLogLevel;
    },
    ...writeMethods(inner),
    ...logMethods(inner),
    ...lifecycleMethods(inner),
  };
}
