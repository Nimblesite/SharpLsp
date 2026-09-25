/**
 * Level-appropriate forwarding of the language server's stderr.
 *
 * Implements [DIST-CLEAN-OUTPUT] rule 5: the panel shows a line at the level
 * the host wrote it.
 *
 * The Rust host writes ALL of its `tracing` output to stderr — stdout is the
 * LSP protocol — so stderr carries INFO and DEBUG lines as much as errors.
 * vscode-languageclient's default `stdioOptions` tags every stderr line
 * `error`, so the level column in the SharpLsp channel carried no information:
 * one CI leg logged 1850 `[error]` lines, none of them an error, and the one
 * line that mattered was drowned.
 *
 * A `tracing_subscriber::fmt` line is `<timestamp> <LEVEL> <target>: <message>`.
 * The channel renders its own timestamp and level, so both prefix tokens are
 * dropped and the remainder is written at the host's level. A line carrying no
 * level (a panic message, a backtrace frame, a sidecar `FATAL:`) is forwarded
 * as written, at `error`: an unclassifiable line on stderr is more likely a
 * failure than not, and a failure must never be made quieter than it was.
 */
import * as readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { LogOutputChannel } from 'vscode';
import type { StdioOptions } from 'vscode-languageclient/node';
import { stripAnsi } from './output-filter.js';

/** The level-tagged write methods of {@link LogOutputChannel}. */
export type ChannelLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** A stderr line, classified: where it goes and what is left to show. */
export interface ClassifiedLine {
  readonly level: ChannelLevel;
  readonly message: string;
}

/** The level names `tracing` prints (right-aligned to five columns). */
const LEVELS: ReadonlyMap<string, ChannelLevel> = new Map([
  ['TRACE', 'trace'],
  ['DEBUG', 'debug'],
  ['INFO', 'info'],
  ['WARN', 'warn'],
  ['ERROR', 'error'],
]);

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

/** Split off the first whitespace-delimited token: `[token, rest]`. */
function nextToken(text: string): readonly [string, string] {
  const trimmed = text.trimStart();
  let end = 0;
  while (end < trimmed.length && !isSpace(trimmed[end] ?? '')) {
    end += 1;
  }
  return [trimmed.slice(0, end), trimmed.slice(end).trimStart()];
}

/**
 * Read the level off a host stderr line and drop the prefix the channel
 * renders itself. The level is the second token (after the timestamp), or the
 * first when the host was built without one; anything else is an `error` line
 * shown as written. A level name INSIDE a message is never read as its level.
 */
export function classifyServerLine(line: string): ClassifiedLine {
  const plain = stripAnsi(line);
  const [first, afterFirst] = nextToken(plain);
  const [second, afterSecond] = nextToken(afterFirst);
  const stamped = LEVELS.get(second);
  if (stamped !== undefined) {
    return { level: stamped, message: afterSecond };
  }
  const bare = LEVELS.get(first);
  if (bare !== undefined) {
    return { level: bare, message: afterFirst };
  }
  return { level: 'error', message: plain };
}

/** Write one stderr line at the host's level; a blank line says nothing. */
export function writeServerLine(channel: LogOutputChannel, line: string): void {
  if (line.trim() === '') {
    return;
  }
  const { level, message } = classifyServerLine(line);
  channel[level](message);
}

/** Hand every line of `input` to `write`, CRLF or LF, across chunk boundaries. */
function forwardLines(input: Readable, write: (line: string) => void): void {
  readline
    .createInterface({ input, crlfDelay: Infinity, terminal: false, historySize: 0 })
    .on('line', write);
}

/**
 * The client's stdio handling. stdout stays at `info`, as the client's own
 * default has it — it is only piped when stdout is not the protocol stream.
 * stderr is written at the level the host gave each line.
 */
export function serverStdioOptions(): Required<StdioOptions> {
  return {
    stdout: (input, channel): void => {
      forwardLines(input, (line) => {
        channel.info(line);
      });
    },
    stderr: (input, channel): void => {
      forwardLines(input, (line) => {
        writeServerLine(channel, line);
      });
    },
  };
}
