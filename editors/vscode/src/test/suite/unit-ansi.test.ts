import * as assert from 'node:assert/strict';
import type { OutputChannel } from 'vscode';
import { stripAnsi, createAnsiStrippingChannel } from '../../output-filter.js';

const ESC = String.fromCharCode(0x1b);

const noop = (): void => {
  // no-op
};

/** A minimal in-memory OutputChannel that records what was written. */
function fakeChannel(): { channel: OutputChannel; writes: string[] } {
  const writes: string[] = [];
  const channel: OutputChannel = {
    name: 'fake',
    append: (value: string): void => {
      writes.push(value);
    },
    appendLine: (value: string): void => {
      writes.push(value);
    },
    replace: (value: string): void => {
      writes.push(value);
    },
    clear: noop,
    show: noop,
    hide: noop,
    dispose: noop,
  };
  return { channel, writes };
}

suite('Output Filter — ANSI stripping', () => {
  // ── stripAnsi() ──────────────────────────────────────────────
  test('strips SGR color codes from a tracing line (issue #78 repro)', () => {
    const line = `${ESC}[2m2026-06-14T04:28:01Z${ESC}[0m ${ESC}[32m INFO${ESC}[0m sharplsp: starting`;
    assert.strictEqual(stripAnsi(line), '2026-06-14T04:28:01Z  INFO sharplsp: starting');
  });

  test('leaves plain text unchanged', () => {
    assert.strictEqual(stripAnsi('plain message, no escapes'), 'plain message, no escapes');
  });

  test('leaves an empty string unchanged', () => {
    assert.strictEqual(stripAnsi(''), '');
  });

  test('removes every ESC byte it encounters', () => {
    const noisy = `${ESC}[1mbold${ESC}[0m and ${ESC}[31mred${ESC}[0m`;
    const result = stripAnsi(noisy);
    assert.ok(!result.includes(ESC), 'no ESC byte must remain');
    assert.strictEqual(result, 'bold and red');
  });

  test('strips an OSC sequence terminated by BEL', () => {
    const osc = `${ESC}]0;window title${String.fromCharCode(0x07)}body`;
    assert.strictEqual(stripAnsi(osc), 'body');
  });

  // ── createAnsiStrippingChannel() ─────────────────────────────
  test('appendLine reaches the inner channel with ANSI removed', () => {
    const { channel, writes } = fakeChannel();
    const wrapped = createAnsiStrippingChannel(channel);
    wrapped.appendLine(`${ESC}[2mhello${ESC}[0m`);
    assert.deepStrictEqual(writes, ['hello']);
  });

  test('append reaches the inner channel with ANSI removed', () => {
    const { channel, writes } = fakeChannel();
    const wrapped = createAnsiStrippingChannel(channel);
    wrapped.append(`${ESC}[31mx${ESC}[0m`);
    assert.deepStrictEqual(writes, ['x']);
  });

  test('preserves the inner channel name', () => {
    const { channel } = fakeChannel();
    const wrapped = createAnsiStrippingChannel(channel);
    assert.strictEqual(wrapped.name, 'fake');
  });
});
