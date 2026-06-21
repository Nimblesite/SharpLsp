import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fsi from '../../fsi.js';

suite('FSI Module — exports', () => {
  test('registerFsiCommands is exported as a function', () => {
    assert.strictEqual(typeof fsi.registerFsiCommands, 'function');
  });

  test('module loads without throwing', () => {
    assert.ok(fsi !== undefined);
  });
});

suite('FSI Module — extractSignature() let bindings', () => {
  test('simple let binding becomes a val with generic type', () => {
    assert.strictEqual(fsi.extractSignature('let foo = 1'), "val foo : 'a\n");
  });

  test('let binding with parameters still produces a single val line', () => {
    assert.strictEqual(fsi.extractSignature('let add x y = x + y'), "val add : 'a\n");
  });

  test('leading indentation is preserved before the val keyword', () => {
    assert.strictEqual(fsi.extractSignature('  let bar = 2'), "  val bar : 'a\n");
  });

  test('tab indentation is preserved verbatim', () => {
    assert.strictEqual(fsi.extractSignature('\tlet tabbed = 3'), "\tval tabbed : 'a\n");
  });

  test('multiple spaces between let and the name still resolve the name', () => {
    assert.strictEqual(fsi.extractSignature('let   spaced = 9'), "val spaced : 'a\n");
  });

  test('underscores and digits are valid identifier characters', () => {
    assert.strictEqual(fsi.extractSignature('let my_value2 = 0'), "val my_value2 : 'a\n");
  });

  test('let binding name capture stops at the first non-word character', () => {
    // \w+ matches caf and stops at the unicode é.
    assert.strictEqual(fsi.extractSignature('let café = 1'), "val caf : 'a\n");
  });

  test('let private bindings are excluded entirely', () => {
    assert.strictEqual(fsi.extractSignature('let private secret = 5'), '\n');
  });

  test('indented let private bindings are excluded entirely', () => {
    assert.strictEqual(fsi.extractSignature('    let private hidden = 5'), '\n');
  });

  test('let mutable is treated like a normal let binding', () => {
    // trimmed starts with "let " and not "let private"; \w+ captures "mutable".
    assert.strictEqual(fsi.extractSignature('let mutable counter = 0'), "val mutable : 'a\n");
  });

  test('let rec is treated like a normal let binding capturing "rec"', () => {
    assert.strictEqual(fsi.extractSignature('let rec loop n = loop n'), "val rec : 'a\n");
  });

  test('let with no identifier (equals sign next) produces no val line', () => {
    assert.strictEqual(fsi.extractSignature('let = 1'), '\n');
  });

  test('bare "let" without trailing space is not a let binding', () => {
    assert.strictEqual(fsi.extractSignature('let'), '\n');
  });

  test('token "let123" is not a let binding (no space after let)', () => {
    assert.strictEqual(fsi.extractSignature('let123 = 1'), '\n');
  });
});

suite('FSI Module — extractSignature() declarations passed through', () => {
  test('module declaration is preserved verbatim', () => {
    assert.strictEqual(fsi.extractSignature('module Foo'), 'module Foo\n');
  });

  test('namespace declaration is preserved verbatim', () => {
    assert.strictEqual(fsi.extractSignature('namespace Bar.Baz'), 'namespace Bar.Baz\n');
  });

  test('type declaration is preserved verbatim including indentation', () => {
    assert.strictEqual(
      fsi.extractSignature('  type Point = { X: int }'),
      '  type Point = { X: int }\n',
    );
  });

  test('existing val line is passed through unchanged', () => {
    assert.strictEqual(fsi.extractSignature('val existing : int'), 'val existing : int\n');
  });

  test('member declaration is passed through unchanged', () => {
    assert.strictEqual(
      fsi.extractSignature('  member this.Area = 1.0'),
      '  member this.Area = 1.0\n',
    );
  });

  test('module declaration keeps its leading whitespace', () => {
    assert.strictEqual(fsi.extractSignature('   module Nested'), '   module Nested\n');
  });
});

suite('FSI Module — extractSignature() dropped lines', () => {
  test('a plain comment line is dropped', () => {
    assert.strictEqual(fsi.extractSignature('// just a comment'), '\n');
  });

  test('an expression line with no keyword is dropped', () => {
    assert.strictEqual(fsi.extractSignature('printfn "hello"'), '\n');
  });

  test('open directive is dropped (no matching branch)', () => {
    assert.strictEqual(fsi.extractSignature('open System'), '\n');
  });

  test('a do binding is dropped', () => {
    assert.strictEqual(fsi.extractSignature('do printfn "x"'), '\n');
  });

  test('the word "module" without a trailing space is dropped', () => {
    assert.strictEqual(fsi.extractSignature('moduleX'), '\n');
  });

  test('the word "type" without a trailing space is dropped', () => {
    assert.strictEqual(fsi.extractSignature('typeof<int>'), '\n');
  });
});

suite('FSI Module — extractSignature() whitespace and empties', () => {
  test('empty string input yields a single trailing newline', () => {
    assert.strictEqual(fsi.extractSignature(''), '\n');
  });

  test('a blank line is preserved as an empty signature line', () => {
    // One blank line -> sigLines = [''] -> join = '' -> + '\n' -> '\n'.
    assert.strictEqual(fsi.extractSignature(''), '\n');
  });

  test('whitespace-only line is normalized to an empty line', () => {
    // trimmed === '' branch pushes '' (original whitespace discarded).
    assert.strictEqual(fsi.extractSignature('    '), '\n');
  });

  test('two blank lines produce two empty signature lines', () => {
    // sigLines = ['', ''] -> join('\n') = '\n' -> + '\n' = '\n\n'.
    assert.strictEqual(fsi.extractSignature('\n'), '\n\n');
  });

  test('three blank lines produce three empty signature lines', () => {
    assert.strictEqual(fsi.extractSignature('\n\n'), '\n\n\n');
  });
});

suite('FSI Module — extractSignature() multi-line and mixed source', () => {
  test('module + public let + private let produces only module and val', () => {
    const source = ['module M', 'let pub = 1', 'let private priv = 2'].join('\n');
    // Lines: 'module M' -> kept, 'let pub = 1' -> val, 'let private priv = 2' -> dropped.
    assert.strictEqual(fsi.extractSignature(source), "module M\nval pub : 'a\n");
  });

  test('blank lines between bindings are preserved in order', () => {
    const source = ['let a = 1', '', 'let b = 2'].join('\n');
    assert.strictEqual(fsi.extractSignature(source), "val a : 'a\n\nval b : 'a\n");
  });

  test('comment lines are removed from the middle of a block', () => {
    const source = ['namespace N', '// comment', 'let value = 42'].join('\n');
    assert.strictEqual(fsi.extractSignature(source), "namespace N\nval value : 'a\n");
  });

  test('a realistic module is reduced to its signature surface', () => {
    const source = [
      'module Geometry',
      '',
      'type Shape = Circle | Square',
      '',
      'let area s = 3.14',
      'let private helper x = x',
      'open System',
    ].join('\n');
    const expected = [
      'module Geometry',
      '',
      'type Shape = Circle | Square',
      '',
      "val area : 'a",
      '',
    ].join('\n');
    // sigLines for the source above:
    // ['module Geometry', '', 'type Shape = Circle | Square', '',
    //  "val area : 'a"] then private/open dropped -> join + '\n'.
    assert.strictEqual(
      fsi.extractSignature(source),
      "module Geometry\n\ntype Shape = Circle | Square\n\nval area : 'a\n",
    );
    assert.ok(expected.length > 0);
  });

  test('trailing newline in source adds a trailing empty signature line', () => {
    const source = 'let only = 1\n';
    // Lines: ['let only = 1', ''] -> ["val only : 'a", ''] -> join + '\n'.
    assert.strictEqual(fsi.extractSignature(source), "val only : 'a\n\n");
  });

  test('every output ends with exactly one terminating newline beyond content', () => {
    const out = fsi.extractSignature('let x = 1');
    assert.ok(out.endsWith('\n'));
    assert.strictEqual(out.endsWith('\n\n'), false);
  });

  test('carriage returns are not stripped from passed-through declarations', () => {
    // split('\n') leaves the trailing \r on the line; trim() only affects the
    // branch test, the pushed value is the untrimmed original line.
    const source = 'module Win\r\nlet y = 1';
    // 'module Win\r' kept verbatim (trimmed startsWith 'module ' is true);
    // 'let y = 1' -> val.
    assert.strictEqual(fsi.extractSignature(source), "module Win\r\nval y : 'a\n");
  });

  test('special regex characters in the rest of a let line do not break extraction', () => {
    assert.strictEqual(fsi.extractSignature('let pattern = ".*+?[](){}|^$"'), "val pattern : 'a\n");
  });
});

interface FakeDocOptions {
  readonly fsPath: string;
}

function fakeDoc(options: FakeDocOptions): vscode.TextDocument {
  return {
    uri: { fsPath: options.fsPath },
  } as unknown as vscode.TextDocument;
}

suite('FSI Module — isFSharpSourceDocument()', () => {
  test('a .fs file is recognized as an F# source document', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/tmp/Program.fs' })), true);
  });

  test('a Windows-style .fs path is recognized', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: 'C:\\src\\Lib.fs' })), true);
  });

  test('a .fsx script file is NOT an F# source document', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/tmp/script.fsx' })), false);
  });

  test('a .fsi signature file is NOT an F# source document', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/tmp/Lib.fsi' })), false);
  });

  test('a .cs file is NOT an F# source document', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/tmp/Program.cs' })), false);
  });

  test('a file with no extension is NOT an F# source document', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/tmp/Makefile' })), false);
  });

  test('undefined document returns false (optional chaining short-circuits)', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(undefined), false);
  });

  test('the check is suffix-based: .fs anywhere but the end is false', () => {
    assert.strictEqual(
      fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/tmp/.fs.directory/file.txt' })),
      false,
    );
  });

  test('a path that merely contains "fs" without the dot is false', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/tmp/configs' })), false);
  });

  test('a filename that is exactly ".fs" is recognized', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '.fs' })), true);
  });

  test('languageId is irrelevant — only the path suffix matters', () => {
    // Even with a non-fsharp languageId, a .fs path is accepted.
    const doc = {
      uri: { fsPath: '/tmp/Weird.fs' },
      languageId: 'plaintext',
    } as unknown as vscode.TextDocument;
    assert.strictEqual(fsi.isFSharpSourceDocument(doc), true);
  });

  test('an empty fsPath returns false', () => {
    assert.strictEqual(fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '' })), false);
  });

  test('return value strictly equals a boolean, never truthy/undefined', () => {
    const truthy = fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/a/b.fs' }));
    const falsy = fsi.isFSharpSourceDocument(fakeDoc({ fsPath: '/a/b.txt' }));
    assert.strictEqual(typeof truthy, 'boolean');
    assert.strictEqual(typeof falsy, 'boolean');
  });
});
