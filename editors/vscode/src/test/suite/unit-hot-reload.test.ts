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

suite('HotReload Module — isRelevantLanguage() exported pure helper', () => {
  test('is exported as a function', () => {
    assert.strictEqual(typeof hotReload.isRelevantLanguage, 'function');
  });

  test('accepts exactly one argument', () => {
    assert.strictEqual(hotReload.isRelevantLanguage.length, 1);
  });

  test('returns a boolean for a known language id', () => {
    assert.strictEqual(typeof hotReload.isRelevantLanguage('csharp'), 'boolean');
  });

  test('returns a boolean for an unknown language id', () => {
    assert.strictEqual(typeof hotReload.isRelevantLanguage('python'), 'boolean');
  });
});

suite('HotReload Module — isRelevantLanguage() accepted ids', () => {
  test('returns true for "csharp"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('csharp'), true);
  });

  test('returns true for "fsharp"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('fsharp'), true);
  });

  test('only "csharp" and "fsharp" are accepted (exhaustive whitelist)', () => {
    const accepted = ['csharp', 'fsharp'];
    for (const id of accepted) {
      assert.strictEqual(hotReload.isRelevantLanguage(id), true, `expected ${id} -> true`);
    }
  });
});

suite('HotReload Module — isRelevantLanguage() rejected ids', () => {
  test('returns false for "aspnetcorerazor" (not whitelisted by the source)', () => {
    // Source matches ONLY csharp/fsharp; razor is NOT relevant.
    assert.strictEqual(hotReload.isRelevantLanguage('aspnetcorerazor'), false);
  });

  test('returns false for "razor"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('razor'), false);
  });

  test('returns false for unrelated programming languages', () => {
    const unrelated = [
      'python',
      'javascript',
      'typescript',
      'rust',
      'go',
      'java',
      'cpp',
      'c',
      'ruby',
      'php',
      'json',
      'xml',
      'markdown',
      'plaintext',
    ];
    for (const id of unrelated) {
      assert.strictEqual(hotReload.isRelevantLanguage(id), false, `expected ${id} -> false`);
    }
  });

  test('returns false for vbnet (a .NET language that is NOT whitelisted)', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('vbnet'), false);
  });

  test('returns false for "fsharp-script" / superstrings of accepted ids', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('fsharp-script'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('csharp-interactive'), false);
  });
});

suite('HotReload Module — isRelevantLanguage() casing is significant', () => {
  test('returns false for uppercase "CSHARP"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('CSHARP'), false);
  });

  test('returns false for uppercase "FSHARP"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('FSHARP'), false);
  });

  test('returns false for title-case "CSharp"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('CSharp'), false);
  });

  test('returns false for mixed-case "FSharp"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('FSharp'), false);
  });

  test('returns false for "CShArP" / "fShArP"', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('CShArP'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('fShArP'), false);
  });
});

suite('HotReload Module — isRelevantLanguage() edge / malformed input', () => {
  test('returns false for the empty string', () => {
    assert.strictEqual(hotReload.isRelevantLanguage(''), false);
  });

  test('returns false for whitespace-only strings', () => {
    assert.strictEqual(hotReload.isRelevantLanguage(' '), false);
    assert.strictEqual(hotReload.isRelevantLanguage('\t'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('\n'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('   '), false);
  });

  test('returns false when the id has surrounding whitespace (no trimming)', () => {
    assert.strictEqual(hotReload.isRelevantLanguage(' csharp'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('csharp '), false);
    assert.strictEqual(hotReload.isRelevantLanguage(' csharp '), false);
    assert.strictEqual(hotReload.isRelevantLanguage('\tfsharp\n'), false);
  });

  test('returns false for strings containing special regex characters', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('c.harp'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('c*'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('csharp|fsharp'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('^csharp$'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('(csharp)'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('[csharp]'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('.*'), false);
  });

  test('returns false for unicode and emoji input', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('cshárp'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('Ｃｓｈａｒｐ'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('🔥'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('csharp🔥'), false);
  });

  test('returns false for numeric-like strings', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('0'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('123'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('-1'), false);
  });

  test('returns false for nullish values coerced through the string parameter', () => {
    // The function does strict === against string literals; non-string inputs
    // can never equal them, so the result is always false.
    assert.strictEqual(hotReload.isRelevantLanguage(undefined as unknown as string), false);
    assert.strictEqual(hotReload.isRelevantLanguage(null as unknown as string), false);
    assert.strictEqual(hotReload.isRelevantLanguage(0 as unknown as string), false);
    assert.strictEqual(hotReload.isRelevantLanguage(false as unknown as string), false);
  });

  test('is referentially pure: repeated calls yield identical results', () => {
    assert.strictEqual(hotReload.isRelevantLanguage('csharp'), true);
    assert.strictEqual(hotReload.isRelevantLanguage('csharp'), true);
    assert.strictEqual(hotReload.isRelevantLanguage('python'), false);
    assert.strictEqual(hotReload.isRelevantLanguage('python'), false);
  });
});
