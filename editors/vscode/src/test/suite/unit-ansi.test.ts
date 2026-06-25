import * as assert from 'node:assert/strict';
import type { OutputChannel, ViewColumn } from 'vscode';
import { stripAnsi, createAnsiStrippingChannel } from '../../output-filter.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

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

/**
 * A richer fake that records EVERY method invocation (not just writes), so the
 * non-writing wrapper methods (clear/show/hide/dispose) can be asserted to
 * delegate to the inner channel. `show` records the single boolean argument it
 * is forwarded so we can pin the overload-collapsing behaviour.
 */
interface RecordingChannel {
  readonly channel: OutputChannel;
  readonly appended: string[];
  readonly appendedLines: string[];
  readonly replaced: string[];
  readonly calls: string[];
  readonly showArgs: (boolean | undefined)[];
}

function recordingChannel(name = 'rec'): RecordingChannel {
  const appended: string[] = [];
  const appendedLines: string[] = [];
  const replaced: string[] = [];
  const calls: string[] = [];
  const showArgs: (boolean | undefined)[] = [];
  const channel: OutputChannel = {
    name,
    append: (value: string): void => {
      appended.push(value);
      calls.push('append');
    },
    appendLine: (value: string): void => {
      appendedLines.push(value);
      calls.push('appendLine');
    },
    replace: (value: string): void => {
      replaced.push(value);
      calls.push('replace');
    },
    clear: (): void => {
      calls.push('clear');
    },
    show: ((preserveFocus?: boolean): void => {
      showArgs.push(preserveFocus);
      calls.push('show');
    }) as OutputChannel['show'],
    hide: (): void => {
      calls.push('hide');
    },
    dispose: (): void => {
      calls.push('dispose');
    },
  };
  return { channel, appended, appendedLines, replaced, calls, showArgs };
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

// ─────────────────────────────────────────────────────────────────────────────
// stripAnsi — non-CSI / non-OSC escape sequences (output-filter.ts:50-52).
// `skipEscapeSequence` falls through to "ESC + one following byte" for any
// escape whose second byte is neither '[' (CSI) nor ']' (OSC).
// ─────────────────────────────────────────────────────────────────────────────
suite('Output Filter — non-CSI/OSC escape sequences (skipEscapeSequence fallthrough)', () => {
  test('strips a bare two-byte escape (ESC + single letter) like RIS reset (ESC c)', () => {
    const text = `before${ESC}cafter`;
    // ESC consumes itself + 'c'; the rest ("after") survives.
    assert.strictEqual(stripAnsi(text), 'beforeafter');
  });

  test('strips ESC M (reverse line feed) leaving surrounding text', () => {
    const text = `top${ESC}Mbottom`;
    assert.strictEqual(stripAnsi(text), 'topbottom');
  });

  test('strips ESC 7 (save cursor) and ESC 8 (restore cursor) sequences', () => {
    const text = `${ESC}7keep${ESC}8more`;
    assert.strictEqual(stripAnsi(text), 'keepmore');
  });

  test('strips ESC = (application keypad) — non-bracket second byte', () => {
    const text = `x${ESC}=y`;
    assert.strictEqual(stripAnsi(text), 'xy');
  });

  test('a trailing lone ESC at end of string consumes itself plus the (absent) next byte', () => {
    const text = `done${ESC}`;
    // start+2 runs past the end; slice clamps, so the visible text is "done".
    assert.strictEqual(stripAnsi(text), 'done');
    assert.ok(!stripAnsi(text).includes(ESC), 'no ESC remains');
  });

  test('mixes CSI, OSC, and bare-escape forms in one string', () => {
    const text = `${ESC}[1mA${ESC}cB${ESC}]0;title${BEL}C${ESC}[0m`;
    assert.strictEqual(stripAnsi(text), 'ABC', 'every escape family is removed');
    assert.ok(!stripAnsi(text).includes(ESC));
  });

  test('OSC terminated by ESC backslash (ST) is fully removed', () => {
    const text = `${ESC}]8;;http://example.com${ESC}\\link${ESC}]8;;${ESC}\\`;
    assert.strictEqual(stripAnsi(text), 'link', 'ST-terminated OSC hyperlinks stripped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAnsiStrippingChannel — the non-writing wrapper methods delegate to the
// inner channel (output-filter.ts:89 replace, 92 clear, 95-96 show, 99 hide,
// 102 dispose), and `replace` strips ANSI before forwarding.
// ─────────────────────────────────────────────────────────────────────────────
suite('Output Filter — channel wrapper delegation', () => {
  test('replace() strips ANSI and forwards to inner.replace (line 89)', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.replace(`${ESC}[2mfresh${ESC}[0m content`);
    assert.deepStrictEqual(rec.replaced, ['fresh content'], 'replace value is ANSI-stripped');
    assert.deepStrictEqual(rec.calls, ['replace'], 'only replace was invoked');
  });

  test('clear() delegates to inner.clear (line 92)', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.clear();
    assert.deepStrictEqual(rec.calls, ['clear'], 'clear forwarded once');
  });

  test('show() with no argument forwards undefined (lines 95-96)', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.show();
    assert.deepStrictEqual(rec.calls, ['show'], 'show forwarded');
    assert.deepStrictEqual(rec.showArgs, [undefined], 'no preserveFocus passed through');
  });

  test('show(true) — a boolean first arg is treated as preserveFocus (lines 95-96)', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.show(true);
    assert.deepStrictEqual(rec.showArgs, [true], 'boolean column collapses to preserveFocus=true');
  });

  test('show(ViewColumn, preserveFocus) — column ignored, preserveFocus forwarded (lines 95-96)', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    // Deprecated 2-arg overload: first arg is a ViewColumn (number), not a boolean.
    // Call through a non-deprecated alias so we still exercise the wrapper's
    // 2-arg branch (output-filter.ts:95-96) without tripping the deprecation lint.
    const column = 1 as unknown as ViewColumn;
    const twoArg = wrapped as unknown as {
      show(col: ViewColumn, preserveFocus: boolean): void;
    };
    twoArg.show(column, true);
    assert.deepStrictEqual(
      rec.showArgs,
      [true],
      'non-boolean column is dropped, preserveFocus forwarded',
    );
  });

  test('show(false) forwards false', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.show(false);
    assert.deepStrictEqual(rec.showArgs, [false]);
  });

  test('hide() delegates to inner.hide (line 99)', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.hide();
    assert.deepStrictEqual(rec.calls, ['hide'], 'hide forwarded once');
  });

  test('dispose() delegates to inner.dispose (line 102)', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.dispose();
    assert.deepStrictEqual(rec.calls, ['dispose'], 'dispose forwarded once');
  });

  test('append() forwards ANSI-stripped text to inner.append', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.append(`${ESC}[31mred${ESC}[0m`);
    assert.deepStrictEqual(rec.appended, ['red']);
    assert.deepStrictEqual(rec.calls, ['append']);
  });

  test('appendLine() forwards ANSI-stripped text to inner.appendLine', () => {
    const rec = recordingChannel();
    const wrapped = createAnsiStrippingChannel(rec.channel);
    wrapped.appendLine(`${ESC}[32mok${ESC}[0m`);
    assert.deepStrictEqual(rec.appendedLines, ['ok']);
    assert.deepStrictEqual(rec.calls, ['appendLine']);
  });

  test('a full lifecycle drives every wrapper method in order', () => {
    const rec = recordingChannel('lifecycle');
    const wrapped = createAnsiStrippingChannel(rec.channel);
    assert.strictEqual(wrapped.name, 'lifecycle', 'name reflects inner channel');
    wrapped.append('a');
    wrapped.appendLine('b');
    wrapped.replace('c');
    wrapped.clear();
    wrapped.show();
    wrapped.hide();
    wrapped.dispose();
    assert.deepStrictEqual(rec.calls, [
      'append',
      'appendLine',
      'replace',
      'clear',
      'show',
      'hide',
      'dispose',
    ]);
  });
});
