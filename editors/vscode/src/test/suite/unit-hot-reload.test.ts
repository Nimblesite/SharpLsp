import * as assert from 'node:assert/strict';
import * as hotReload from '../../hot-reload.js';

suite('HotReload Module — exports', () => {
  test('registerHotReloadCommands is exported as a function', () => {
    assert.strictEqual(typeof hotReload.registerHotReloadCommands, 'function');
  });

  test('isHotReloadRunning is exported as a function', () => {
    assert.strictEqual(typeof hotReload.isHotReloadRunning, 'function');
  });
});

suite('HotReload Module — isHotReloadRunning()', () => {
  test('returns false initially when no session has been started', () => {
    assert.strictEqual(hotReload.isHotReloadRunning(), false);
  });

  test('returns a boolean value', () => {
    const result = hotReload.isHotReloadRunning();
    assert.ok(typeof result === 'boolean');
  });

  test('returns false consistently when called multiple times without starting', () => {
    assert.strictEqual(hotReload.isHotReloadRunning(), false);
    assert.strictEqual(hotReload.isHotReloadRunning(), false);
    assert.strictEqual(hotReload.isHotReloadRunning(), false);
  });
});
