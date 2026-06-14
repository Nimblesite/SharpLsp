// Implements [DIST-FAILURE-UX]: logging must be best-effort and never crash the
// extension host. Regression guard for the e2e failure where vscode-languageclient
// pipes the language server's stderr straight to the output channel's append(),
// and a line arriving during extension-host teardown threw an UNCAUGHT
// "Channel has been closed" that aborted the whole VS Code test run.
import * as assert from 'node:assert/strict';
import type { LogOutputChannel } from 'vscode';
import { guardChannel } from '../../channel-guard.js';

/** A channel whose every write throws — exactly how the RPC channel behaves once closed. */
function closedChannel(): LogOutputChannel {
  const closed = (): never => {
    throw new Error('Channel has been closed');
  };
  const stub = {
    name: 'stub',
    append: closed,
    appendLine: closed,
    replace: closed,
    trace: closed,
    debug: closed,
    info: closed,
    warn: closed,
    error: closed,
  };
  return stub as unknown as LogOutputChannel;
}

suite('channel guard teardown safety [DIST-FAILURE-UX]', () => {
  test('guarded writes do not throw when the underlying channel is closed', () => {
    const guarded = guardChannel(closedChannel());

    // These are exactly the calls vscode-languageclient makes when it forwards a
    // late stderr line during host teardown — they must be swallowed, not thrown.
    assert.doesNotThrow(() => {
      guarded.append('late stderr line');
    });
    assert.doesNotThrow(() => {
      guarded.appendLine('late stderr line');
    });
    assert.doesNotThrow(() => {
      guarded.error('late error');
    });
    assert.doesNotThrow(() => {
      guarded.info('late info');
    });
  });

  test('guarded writes are forwarded to the underlying channel while it is open', () => {
    const seen: string[] = [];
    const stub = {
      name: 'open',
      append: (value: string) => {
        seen.push(`append:${value}`);
      },
      appendLine: (value: string) => {
        seen.push(`line:${value}`);
      },
    };

    const guarded = guardChannel(stub as unknown as LogOutputChannel);
    guarded.append('hello');
    guarded.appendLine('world');

    assert.deepStrictEqual(seen, ['append:hello', 'line:world']);
  });

  test('non-write members (name) are passed through unchanged', () => {
    const guarded = guardChannel(closedChannel());
    assert.strictEqual(guarded.name, 'stub');
  });
});
