/**
 * The SharpLsp channel shows each server stderr line at the level the host
 * wrote — [DIST-CLEAN-OUTPUT] rule 5.
 *
 * The Rust host writes ALL of its `tracing` output to stderr (stdout is the
 * protocol), and vscode-languageclient's default `stdioOptions` tags every
 * stderr line `error`. The run on 198fb161 logged 1850 `[error]` lines in one
 * debug leg, none of them an error, so the level column carried no information
 * and the one line that mattered was drowned. These tests pin the level a line
 * is shown at, from the pure classifier up to the option the live client is
 * constructed with.
 */
import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from '../../constants.js';
import type { SharpLspExtensionApi } from '../../extension.js';
import { classifyServerLine, serverStdioOptions } from '../../server-stderr.js';
import { recordingChannel } from './fsi-build-kit.js';
import { activateRealSharpLsp } from './refactor-test-helpers';
import { EXTENSION_ID, pollUntilResult } from './test-helpers';
import { ACTIVATION_MS, COMMAND_MS, FAST_MS, POLL_INTERVAL_MS } from './test-timeouts';

const STAMP = '2026-09-23T04:11:44.163792Z';

/** Each level's line exactly as `tracing_subscriber::fmt` writes it. */
const TRACE_LINE = `${STAMP} TRACE sharplsp::router: dispatch method=textDocument/hover`;
const DEBUG_LINE = `${STAMP} DEBUG sharplsp::vfs: didChange uri=file:///x.cs version=2`;
const INFO_TEXT =
  'sharplsp::sidecar::manager: Sidecar request sidecar=C# (Roslyn) method=ping id=297';
const INFO_LINE = `${STAMP}  INFO ${INFO_TEXT}`;
const WARN_LINE = `${STAMP}  WARN sharplsp::sidecar::manager: Sidecar slow sidecar=F# (FCS) ms=1200`;
const ERROR_TEXT = 'sharplsp: SharpLsp LSP exited with error: boom';
const ERROR_LINE = `${STAMP} ERROR ${ERROR_TEXT}`;

const HOST_LINES: readonly (readonly [string, string])[] = [
  [TRACE_LINE, 'trace'],
  [DEBUG_LINE, 'debug'],
  [INFO_LINE, 'info'],
  [WARN_LINE, 'warn'],
  [ERROR_LINE, 'error'],
];

/** Pipe `chunks` through a stdio handler and wait for the stream to drain. */
async function pipe(
  handler: (input: Readable, channel: ReturnType<typeof recordingChannel>) => void,
  chunks: readonly string[],
): Promise<string[]> {
  const channel = recordingChannel('SharpLsp');
  const input = Readable.from(chunks);
  handler(input, channel);
  await once(input, 'end');
  return channel.logged;
}

suite('Server stderr is shown at the level the host wrote', () => {
  test('every tracing level is forwarded as itself, with the channel-rendered prefix dropped', function () {
    this.timeout(FAST_MS);
    for (const [line, level] of HOST_LINES) {
      const shown = classifyServerLine(line);
      assert.strictEqual(shown.level, level, line);
      assert.ok(
        !shown.message.includes(STAMP),
        `the channel stamps its own time: ${shown.message}`,
      );
      assert.ok(
        !shown.message.startsWith(level.toUpperCase()),
        `and renders its own level: ${shown.message}`,
      );
      assert.ok(shown.message.startsWith('sharplsp'), `the target survives: ${shown.message}`);
    }
    assert.strictEqual(classifyServerLine(INFO_LINE).message, INFO_TEXT);
  });

  test('a span prefix and a colored level token classify the same as a plain line', function () {
    this.timeout(FAST_MS);
    const spanned = classifyServerLine(
      `${STAMP}  INFO request{method="textDocument/hover"}: sharplsp::router: handled ms=3`,
    );
    assert.strictEqual(spanned.level, 'info');
    assert.strictEqual(
      spanned.message,
      'request{method="textDocument/hover"}: sharplsp::router: handled ms=3',
    );

    // Defence in depth: the host only colors a TTY, but a colored level token
    // must still be read as the level, not fall through to `error`.
    const colored = classifyServerLine(
      `${STAMP} \u001b[33m WARN\u001b[0m \u001b[2msharplsp\u001b[0m\u001b[2m:\u001b[0m disk low`,
    );
    assert.strictEqual(colored.level, 'warn');
    assert.strictEqual(colored.message, 'sharplsp: disk low');
  });

  test('a line that carries no level is shown as written, at error', function () {
    this.timeout(FAST_MS);
    const panic = "thread 'main' panicked at src/main.rs:12:5:";
    assert.deepStrictEqual(classifyServerLine(panic), { level: 'error', message: panic });
    const fatal = 'FATAL: sidecar could not resolve a .NET SDK';
    assert.deepStrictEqual(classifyServerLine(fatal), { level: 'error', message: fatal });
    // A message whose TEXT mentions a level is not reclassified by it.
    const mention = `${STAMP} ERROR sharplsp: INFO level requested but denied`;
    assert.strictEqual(classifyServerLine(mention).level, 'error');
  });

  test('the stderr handler splits chunks into lines, keeps order and skips blank lines', async function () {
    this.timeout(COMMAND_MS);
    const logged = await pipe(serverStdioOptions().stderr, [
      `${TRACE_LINE}\n${DEBUG_LINE}\r\n`,
      INFO_LINE.slice(0, 20),
      `${INFO_LINE.slice(20)}\n\n   \n${WARN_LINE}\n`,
      `${ERROR_LINE}\nno level here\n`,
    ]);
    assert.deepStrictEqual(logged, [
      'trace:sharplsp::router: dispatch method=textDocument/hover',
      'debug:sharplsp::vfs: didChange uri=file:///x.cs version=2',
      `info:${INFO_TEXT}`,
      'warn:sharplsp::sidecar::manager: Sidecar slow sidecar=F# (FCS) ms=1200',
      `error:${ERROR_TEXT}`,
      'error:no level here',
    ]);
  });

  test('the stdout handler keeps the client default: every line at info', async function () {
    this.timeout(COMMAND_MS);
    const logged = await pipe(serverStdioOptions().stdout, ['one\ntwo\n', `${ERROR_LINE}\n`]);
    assert.deepStrictEqual(logged, ['info:one', 'info:two', `info:${ERROR_LINE}`]);
  });

  suite('the live client', () => {
    let channelLog: string;

    suiteSetup(async function () {
      this.timeout(ACTIVATION_MS);
      await activateRealSharpLsp();
      const api = vscode.extensions.getExtension(EXTENSION_ID)?.exports as SharpLspExtensionApi;
      channelLog = path.join(api.logUri.fsPath, `${OUTPUT_CHANNEL_NAME}.log`);
    });

    test("files the running host's INFO lines under info in the channel log, none under error", async function () {
      this.timeout(COMMAND_MS);
      // The channel is write-only from the extension host; its log file is not.
      const lines = await pollUntilResult(
        () => Promise.resolve(channelLogLines(channelLog)),
        (found) => found.some((line) => line.includes(STARTING)),
        COMMAND_MS - FAST_MS,
        POLL_INTERVAL_MS,
        `${channelLog} to hold the host's '${STARTING}' line`,
      );
      const starting = lines.filter((line) => line.includes(STARTING));
      for (const line of starting) {
        assert.ok(
          line.includes('[info]'),
          `the host wrote it at INFO, the channel shows info: ${line}`,
        );
      }
      // The symptom this fixes: a whole tracing line, level token and all,
      // filed under the channel's own error level.
      const misfiled = lines.filter(
        (line) => line.includes('[error]') && TRACING_LEVELS.some((token) => line.includes(token)),
      );
      assert.deepStrictEqual(
        misfiled,
        [],
        'no host line is shown at a level it was not written at',
      );
    });
  });
});

/** The host's first line, as `tracing` writes it after the level token. */
const STARTING = 'sharplsp: SharpLsp LSP starting';

/** A raw level token surviving into a channel line means the line was not classified. */
const TRACING_LEVELS = [' TRACE ', ' DEBUG ', ' INFO ', ' WARN ', ' ERROR '];

/** Every line the SharpLsp channel has logged so far; none until its file exists. */
function channelLogLines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
}
