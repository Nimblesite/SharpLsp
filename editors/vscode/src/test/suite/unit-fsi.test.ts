import * as assert from 'node:assert/strict';
import * as fsi from '../../fsi.js';

suite('FSI Module — exports', () => {
  test('registerFsiCommands is exported as a function', () => {
    assert.strictEqual(typeof fsi.registerFsiCommands, 'function');
  });

  test('module loads without throwing', () => {
    assert.ok(fsi !== undefined);
  });
});
