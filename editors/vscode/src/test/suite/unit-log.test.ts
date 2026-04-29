import * as assert from 'node:assert/strict';
import * as log from '../../log.js';
import { OUTPUT_CHANNEL_NAME, TRACE_CHANNEL_NAME } from '../../constants.js';

suite('Log Module — Output Channels', () => {
  // Dispose only once at the end of the suite to avoid
  // DisposableStore errors from VSCode's extension host when
  // channels are re-created between every test.
  suiteTeardown(() => {
    log.dispose();
  });

  // ── output() ─────────────────────────────────────────────────
  test('output() returns an OutputChannel', () => {
    const channel = log.output();
    assert.ok(channel, 'Must return an output channel');
    assert.ok(typeof channel.appendLine === 'function', 'Must have appendLine');
    assert.ok(typeof channel.dispose === 'function', 'Must have dispose');
  });

  test('output() returns the same instance on repeated calls (lazy singleton)', () => {
    const first = log.output();
    const second = log.output();
    assert.strictEqual(first, second, 'Must return the same channel instance');
  });

  test('output() channel has the correct name', () => {
    const channel = log.output();
    assert.strictEqual(
      channel.name,
      OUTPUT_CHANNEL_NAME,
      `Channel name must be '${OUTPUT_CHANNEL_NAME}'`,
    );
  });

  test('output() creates a new instance after dispose()', () => {
    const before = log.output();
    log.dispose();
    const recreated = log.output();
    assert.ok(recreated, 'Must create a new channel after dispose');
    assert.strictEqual(recreated.name, OUTPUT_CHANNEL_NAME);
    assert.notStrictEqual(before, recreated, 'New instance should differ from old');
  });

  // ── trace() ──────────────────────────────────────────────────
  test('trace() returns an OutputChannel', () => {
    const channel = log.trace();
    assert.ok(channel, 'Must return an output channel');
    assert.ok(typeof channel.appendLine === 'function', 'Must have appendLine');
    assert.ok(typeof channel.dispose === 'function', 'Must have dispose');
  });

  test('trace() returns the same instance on repeated calls (lazy singleton)', () => {
    const first = log.trace();
    const second = log.trace();
    assert.strictEqual(first, second, 'Must return the same channel instance');
  });

  test('trace() channel has the correct name', () => {
    const channel = log.trace();
    assert.strictEqual(
      channel.name,
      TRACE_CHANNEL_NAME,
      `Channel name must be '${TRACE_CHANNEL_NAME}'`,
    );
  });

  test('trace() creates a new instance after dispose()', () => {
    const before = log.trace();
    log.dispose();
    const recreated = log.trace();
    assert.ok(recreated, 'Must create a new channel after dispose');
    assert.strictEqual(recreated.name, TRACE_CHANNEL_NAME);
    assert.notStrictEqual(before, recreated, 'New instance should differ from old');
  });

  // ── output() and trace() are distinct ────────────────────────
  test('output() and trace() return different channels', () => {
    const out = log.output();
    const tr = log.trace();
    assert.notStrictEqual(out, tr, 'Output and trace must be distinct');
    assert.notStrictEqual(out.name, tr.name, 'Channel names must differ');
  });

  // ── info() ───────────────────────────────────────────────────
  test('info() does not throw', () => {
    assert.doesNotThrow(() => {
      log.info('test message');
    });
  });

  test('info() can be called with an empty string', () => {
    assert.doesNotThrow(() => {
      log.info('');
    });
  });

  test('info() can be called with a long message', () => {
    const longMessage = 'x'.repeat(10_000);
    assert.doesNotThrow(() => {
      log.info(longMessage);
    });
  });

  test('info() can be called with special characters', () => {
    assert.doesNotThrow(() => {
      log.info('Special chars: ñ é ü ö — 日本語 中文 🔥');
    });
  });

  test('info() can be called multiple times in succession', () => {
    assert.doesNotThrow(() => {
      for (let i = 0; i < 100; i++) {
        log.info(`Message ${i}`);
      }
    });
  });

  test('info() writes to the output channel (does not throw after output() is called)', () => {
    const channel = log.output();
    assert.ok(channel, 'Channel must exist before info()');
    assert.doesNotThrow(() => {
      log.info('after explicit output() call');
    });
  });

  // ── dispose() ────────────────────────────────────────────────
  test('dispose() does not throw when no channels exist', () => {
    log.dispose();
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test('dispose() does not throw when only output channel exists', () => {
    log.output();
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test('dispose() does not throw when only trace channel exists', () => {
    log.trace();
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test('dispose() does not throw when both channels exist', () => {
    log.output();
    log.trace();
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test('dispose() can be called multiple times safely (idempotent)', () => {
    log.output();
    log.trace();
    log.dispose();
    log.dispose();
    log.dispose();
    assert.ok(true, 'Multiple dispose() calls should not throw');
  });

  test('info() works after dispose() and re-creation', () => {
    log.info('before dispose');
    log.dispose();
    assert.doesNotThrow(() => {
      log.info('after dispose and re-creation');
    });
  });

  // ── warn() ───────────────────────────────────────────────────
  test('warn() does not throw', () => {
    assert.doesNotThrow(() => {
      log.warn('test warning');
    });
  });

  test('warn() can be called with an empty string', () => {
    assert.doesNotThrow(() => {
      log.warn('');
    });
  });

  test('warn() can be called with special characters', () => {
    assert.doesNotThrow(() => {
      log.warn('Warn: ñ é — 日本語 🔥');
    });
  });

  test('warn() can be called multiple times in succession', () => {
    assert.doesNotThrow(() => {
      for (let i = 0; i < 50; i++) {
        log.warn(`Warning ${i}`);
      }
    });
  });

  test('warn() writes to the output channel (does not throw after output() is called)', () => {
    const channel = log.output();
    assert.ok(channel, 'Channel must exist before warn()');
    assert.doesNotThrow(() => {
      log.warn('after explicit output() call');
    });
  });

  test('warn() works after dispose() and re-creation', () => {
    log.warn('before dispose');
    log.dispose();
    assert.doesNotThrow(() => {
      log.warn('after dispose and re-creation');
    });
  });

  // ── error() ──────────────────────────────────────────────────
  test('error() does not throw', () => {
    assert.doesNotThrow(() => {
      log.error('test error');
    });
  });

  test('error() can be called with an empty string', () => {
    assert.doesNotThrow(() => {
      log.error('');
    });
  });

  test('error() can be called with special characters', () => {
    assert.doesNotThrow(() => {
      log.error('Error: ñ é — 日本語 🔥');
    });
  });

  test('error() can be called multiple times in succession', () => {
    assert.doesNotThrow(() => {
      for (let i = 0; i < 50; i++) {
        log.error(`Error ${i}`);
      }
    });
  });

  test('error() works after dispose() and re-creation', () => {
    log.error('before dispose');
    log.dispose();
    assert.doesNotThrow(() => {
      log.error('after dispose and re-creation');
    });
  });

  // ── traceInfo() ──────────────────────────────────────────────
  test('traceInfo() does not throw', () => {
    assert.doesNotThrow(() => {
      log.traceInfo('test trace message');
    });
  });

  test('traceInfo() can be called with an empty string', () => {
    assert.doesNotThrow(() => {
      log.traceInfo('');
    });
  });

  test('traceInfo() can be called with special characters', () => {
    assert.doesNotThrow(() => {
      log.traceInfo('Trace: ñ é — 日本語 🔥');
    });
  });

  test('traceInfo() can be called multiple times in succession', () => {
    assert.doesNotThrow(() => {
      for (let i = 0; i < 50; i++) {
        log.traceInfo(`Trace ${i}`);
      }
    });
  });

  test('traceInfo() writes to the trace channel (does not throw after trace() is called)', () => {
    const channel = log.trace();
    assert.ok(channel, 'Trace channel must exist before traceInfo()');
    assert.doesNotThrow(() => {
      log.traceInfo('after explicit trace() call');
    });
  });

  test('traceInfo() works after dispose() and re-creation', () => {
    log.traceInfo('before dispose');
    log.dispose();
    assert.doesNotThrow(() => {
      log.traceInfo('after dispose and re-creation');
    });
  });

  // ── logFilePath() ─────────────────────────────────────────────
  test('logFilePath() returns a non-empty string', () => {
    const p = log.logFilePath();
    assert.ok(typeof p === 'string' && p.length > 0, 'logFilePath must return a non-empty string');
  });

  test('logFilePath() ends with sharplsp-vscode.log', () => {
    const p = log.logFilePath();
    assert.ok(p.endsWith('sharplsp-vscode.log'), `logFilePath must end with sharplsp-vscode.log, got ${p}`);
  });

  test('logFilePath() returns the same value on repeated calls', () => {
    const first = log.logFilePath();
    const second = log.logFilePath();
    assert.strictEqual(first, second, 'logFilePath must be stable');
  });

  // ── Mixed usage ───────────────────────────────────────────────
  test('all log functions work together without throwing', () => {
    assert.doesNotThrow(() => {
      log.info('info message');
      log.warn('warn message');
      log.error('error message');
      log.traceInfo('trace message');
    });
  });

  test('all log functions work after fresh dispose/recreate cycle', () => {
    log.dispose();
    assert.doesNotThrow(() => {
      log.info('info after recreate');
      log.warn('warn after recreate');
      log.error('error after recreate');
      log.traceInfo('trace after recreate');
    });
  });
});
