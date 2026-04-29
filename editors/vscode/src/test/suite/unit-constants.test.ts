import * as assert from 'node:assert/strict';
import {
  EXTENSION_ID,
  EXTENSION_NAME,
  OUTPUT_CHANNEL_NAME,
  TRACE_CHANNEL_NAME,
  SERVER_BINARY,
  SERVER_BINARY_WIN,
  CONFIG_SECTION,
  CONFIG_SERVER_PATH,
  CONFIG_SERVER_EXTRA_ARGS,
  CONFIG_LOGGING_LEVEL,
  CMD_RESTART_SERVER,
  CMD_SHOW_OUTPUT,
  CMD_SHOW_TRACE,
} from '../../constants.js';

suite('Constants', () => {
  test('EXTENSION_ID is the publisher.name identifier', () => {
    assert.strictEqual(EXTENSION_ID, 'sharplsp');
    assert.ok(EXTENSION_ID.length > 0, 'Must not be empty');
  });

  test('EXTENSION_NAME is the display name', () => {
    assert.strictEqual(EXTENSION_NAME, 'SharpLsp');
  });

  test('OUTPUT_CHANNEL_NAME is human-readable', () => {
    assert.strictEqual(OUTPUT_CHANNEL_NAME, 'SharpLsp');
    assert.ok(
      !OUTPUT_CHANNEL_NAME.includes('lsp'),
      'Channel name should be user-facing, not internal',
    );
  });

  test('TRACE_CHANNEL_NAME is distinct from the main channel', () => {
    assert.strictEqual(TRACE_CHANNEL_NAME, 'SharpLsp Trace');
    assert.notStrictEqual(
      TRACE_CHANNEL_NAME,
      OUTPUT_CHANNEL_NAME,
      'Trace channel must differ from main channel',
    );
  });

  test('SERVER_BINARY is the unix binary name', () => {
    assert.strictEqual(SERVER_BINARY, 'sharplsp-lsp');
    assert.ok(!SERVER_BINARY.includes('.exe'), 'Unix binary should not have .exe');
  });

  test('SERVER_BINARY_WIN is the windows binary name', () => {
    assert.strictEqual(SERVER_BINARY_WIN, 'sharplsp-lsp.exe');
    assert.ok(SERVER_BINARY_WIN.endsWith('.exe'), 'Windows binary must end with .exe');
  });

  test('SERVER_BINARY_WIN derives from SERVER_BINARY', () => {
    assert.strictEqual(
      SERVER_BINARY_WIN,
      `${SERVER_BINARY}.exe`,
      'Windows binary should be unix binary + .exe',
    );
  });

  test('CONFIG_SECTION is the top-level config key', () => {
    assert.strictEqual(CONFIG_SECTION, 'sharplsp');
  });

  test('CONFIG_SERVER_PATH is the lspPath setting key', () => {
    assert.strictEqual(CONFIG_SERVER_PATH, 'lspPath');
    assert.ok(CONFIG_SERVER_PATH.endsWith('Path'));
  });

  test('CONFIG_SERVER_EXTRA_ARGS is the server.extraArgs setting key', () => {
    assert.strictEqual(CONFIG_SERVER_EXTRA_ARGS, 'server.extraArgs');
    assert.ok(CONFIG_SERVER_EXTRA_ARGS.startsWith('server.'));
  });

  test('CONFIG_LOGGING_LEVEL is the logging.level setting key', () => {
    assert.strictEqual(CONFIG_LOGGING_LEVEL, 'logging.level');
    assert.ok(CONFIG_LOGGING_LEVEL.startsWith('logging.'));
  });

  test('CMD_RESTART_SERVER follows sharplsp.* command pattern', () => {
    assert.strictEqual(CMD_RESTART_SERVER, 'sharplsp.restartServer');
    assert.ok(CMD_RESTART_SERVER.startsWith('sharplsp.'));
  });

  test('CMD_SHOW_OUTPUT follows sharplsp.* command pattern', () => {
    assert.strictEqual(CMD_SHOW_OUTPUT, 'sharplsp.showOutput');
    assert.ok(CMD_SHOW_OUTPUT.startsWith('sharplsp.'));
  });

  test('CMD_SHOW_TRACE follows sharplsp.* command pattern', () => {
    assert.strictEqual(CMD_SHOW_TRACE, 'sharplsp.showTraceOutput');
    assert.ok(CMD_SHOW_TRACE.startsWith('sharplsp.'));
  });

  test('all command constants are unique', () => {
    const commands = [CMD_RESTART_SERVER, CMD_SHOW_OUTPUT, CMD_SHOW_TRACE];
    const unique = new Set(commands);
    assert.strictEqual(unique.size, commands.length, 'All commands must be unique');
  });

  test('all config keys are unique', () => {
    const keys = [CONFIG_SERVER_PATH, CONFIG_SERVER_EXTRA_ARGS, CONFIG_LOGGING_LEVEL];
    const unique = new Set(keys);
    assert.strictEqual(unique.size, keys.length, 'All config keys must be unique');
  });
});
