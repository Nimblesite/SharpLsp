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

suite('FSI Module — fsiTerminalOptions()', () => {
  test('falls back to bare "dotnet" on PATH when no SDK path is known', () => {
    const opts = fsi.fsiTerminalOptions(undefined, []);
    assert.strictEqual(opts.shellPath, 'dotnet');
  });

  test('an empty SDK path also falls back to bare "dotnet"', () => {
    const opts = fsi.fsiTerminalOptions('', []);
    assert.strictEqual(opts.shellPath, 'dotnet');
  });

  test('uses the resolved SDK dotnet executable when provided (off-PATH install)', () => {
    // The exact case after an off-PATH SDK install via the .NET Install Tool.
    const opts = fsi.fsiTerminalOptions('/usr/share/dotnet/dotnet', []);
    assert.strictEqual(opts.shellPath, '/usr/share/dotnet/dotnet');
  });

  test('a Windows SDK path is used verbatim as the shell path', () => {
    const opts = fsi.fsiTerminalOptions('C:\\Program Files\\dotnet\\dotnet.exe', []);
    assert.strictEqual(opts.shellPath, 'C:\\Program Files\\dotnet\\dotnet.exe');
  });

  test('shellArgs always starts with the "fsi" verb', () => {
    const opts = fsi.fsiTerminalOptions(undefined, []);
    assert.deepStrictEqual([...opts.shellArgs], ['fsi']);
  });

  test('extra args follow the "fsi" verb in order', () => {
    const opts = fsi.fsiTerminalOptions('/x/dotnet', ['--define:DEBUG', '--use:setup.fsx']);
    assert.deepStrictEqual([...opts.shellArgs], ['fsi', '--define:DEBUG', '--use:setup.fsx']);
  });

  test('the terminal name is always "F# Interactive"', () => {
    assert.strictEqual(fsi.fsiTerminalOptions('/x/dotnet', ['--a']).name, 'F# Interactive');
  });

  test("does not mutate the caller's extraArgs array", () => {
    const extra = ['--define:DEBUG'];
    const opts = fsi.fsiTerminalOptions(undefined, extra);
    assert.strictEqual(extra.length, 1, 'input array must not be mutated');
    assert.notStrictEqual(opts.shellArgs, extra, 'returns a fresh args array');
  });

  test('the SDK path is used together with extra args (combined case)', () => {
    const opts = fsi.fsiTerminalOptions('/usr/share/dotnet/dotnet', ['--readline-']);
    assert.strictEqual(opts.shellPath, '/usr/share/dotnet/dotnet');
    assert.deepStrictEqual([...opts.shellArgs], ['fsi', '--readline-']);
  });
});

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

suite('FSI Module — fsiTerminalOptions() extra args & cwd/env independence', () => {
  test('the returned name, shellPath and shellArgs together form the full launch spec', () => {
    const opts = fsi.fsiTerminalOptions('/opt/dotnet/dotnet', ['--define:RELEASE']);
    assert.deepStrictEqual(
      { name: opts.name, shellPath: opts.shellPath, shellArgs: [...opts.shellArgs] },
      {
        name: 'F# Interactive',
        shellPath: '/opt/dotnet/dotnet',
        shellArgs: ['fsi', '--define:RELEASE'],
      },
    );
  });

  test('many extra args are appended after "fsi" in their original order', () => {
    const extra = ['--use:bootstrap.fsx', '--define:DEBUG', '--optimize+', '--nologo'];
    const opts = fsi.fsiTerminalOptions(undefined, extra);
    assert.deepStrictEqual([...opts.shellArgs], ['fsi', ...extra]);
    assert.strictEqual(opts.shellArgs[0], 'fsi');
    assert.strictEqual(opts.shellArgs[opts.shellArgs.length - 1], '--nologo');
  });

  test('a dotnet executable path that itself contains spaces is preserved verbatim', () => {
    const opts = fsi.fsiTerminalOptions('/Program Files/dotnet/dotnet', []);
    assert.strictEqual(opts.shellPath, '/Program Files/dotnet/dotnet');
  });

  test('whitespace-only dotnet path is treated as present (not the empty-string fallback)', () => {
    // The source falls back only on undefined or exactly '' — a single space is truthy.
    const opts = fsi.fsiTerminalOptions(' ', []);
    assert.strictEqual(opts.shellPath, ' ');
  });

  test('shellArgs is a distinct array from the result of any other call (no shared state)', () => {
    const a = fsi.fsiTerminalOptions(undefined, ['--x']);
    const b = fsi.fsiTerminalOptions(undefined, ['--y']);
    assert.notStrictEqual(a.shellArgs, b.shellArgs);
    assert.deepStrictEqual([...a.shellArgs], ['fsi', '--x']);
    assert.deepStrictEqual([...b.shellArgs], ['fsi', '--y']);
  });

  test('a single extra arg is positioned immediately after the fsi verb', () => {
    const opts = fsi.fsiTerminalOptions('dotnet', ['--readline-']);
    assert.strictEqual(opts.shellArgs.length, 2);
    assert.strictEqual(opts.shellArgs[1], '--readline-');
  });
});

suite('FSI Module — extractSignature() function-style let bindings', () => {
  test('a multi-parameter let function captures only the function name', () => {
    assert.strictEqual(fsi.extractSignature('let f a b = a + b'), "val f : 'a\n");
  });

  test('a curried let with type annotations still yields one val line', () => {
    assert.strictEqual(
      fsi.extractSignature('let combine (a: int) (b: int) : int = a + b'),
      "val combine : 'a\n",
    );
  });

  test('an inline-record-returning let still produces a generic val', () => {
    assert.strictEqual(
      fsi.extractSignature('let makePoint x y = { X = x; Y = y }'),
      "val makePoint : 'a\n",
    );
  });

  test('a let binding inside a type body (member-like indentation) yields an indented val', () => {
    assert.strictEqual(fsi.extractSignature('        let inner z = z'), "        val inner : 'a\n");
  });
});

suite('FSI Module — extractSignature() type and member declarations', () => {
  test('a discriminated-union type header passes through verbatim', () => {
    assert.strictEqual(
      fsi.extractSignature('type Color = Red | Green | Blue'),
      'type Color = Red | Green | Blue\n',
    );
  });

  test('a record type with an opening brace passes through verbatim', () => {
    assert.strictEqual(
      fsi.extractSignature('type Vec = { X: float; Y: float }'),
      'type Vec = { X: float; Y: float }\n',
    );
  });

  test('a bare type header ending in = passes through verbatim', () => {
    assert.strictEqual(fsi.extractSignature('type Tree ='), 'type Tree =\n');
  });

  test('a member with parameters passes through verbatim including indentation', () => {
    assert.strictEqual(
      fsi.extractSignature('    member this.Scale (k: float) = k'),
      '    member this.Scale (k: float) = k\n',
    );
  });

  test('a full type declaration block keeps headers, members and union cases', () => {
    const source = [
      'type Shape =',
      '  | Circle of float',
      '  member this.Area = 3.14',
      'let private impl x = x',
    ].join('\n');
    // 'type Shape =' kept; '| Circle of float' dropped (no keyword);
    // 'member this.Area...' kept; 'let private impl...' dropped.
    assert.strictEqual(fsi.extractSignature(source), 'type Shape =\n  member this.Area = 3.14\n');
  });
});

suite('FSI Module — extractSignature() let-private prefix boundary', () => {
  test('"let private" is a prefix match, so "let privateData" is also dropped', () => {
    // trimmed.startsWith('let private') is true for "let privateData = 1" even
    // though privateData is a public-looking binding — the guard is prefix-only.
    assert.strictEqual(fsi.extractSignature('let privateData = 1'), '\n');
  });

  test('indented "let private" with extra spaces before the name is dropped', () => {
    assert.strictEqual(fsi.extractSignature('      let private   hidden = 2'), '\n');
  });

  test('"let publicish" (not the private prefix) becomes a val', () => {
    assert.strictEqual(fsi.extractSignature('let publicish = 3'), "val publicish : 'a\n");
  });

  test('a block mixing private-prefixed and normal lets keeps only the normal ones', () => {
    const source = [
      'let alpha = 1',
      'let private beta = 2',
      'let privateGamma = 3',
      'let delta = 4',
    ].join('\n');
    // alpha -> val; private beta dropped; privateGamma dropped (prefix); delta -> val.
    assert.strictEqual(fsi.extractSignature(source), "val alpha : 'a\nval delta : 'a\n");
  });

  test('"val"-prefixed and "member"-prefixed lines coexist with let conversions', () => {
    const source = ['val existing : int', 'let computed = 0', 'member this.M () = ()'].join('\n');
    assert.strictEqual(
      fsi.extractSignature(source),
      "val existing : int\nval computed : 'a\nmember this.M () = ()\n",
    );
  });
});

suite('FSI Module — fsiTerminalOptions() exhaustive field assertions', () => {
  test('the no-SDK, no-extra-args case yields the complete default launch spec', () => {
    const opts = fsi.fsiTerminalOptions(undefined, []);
    assert.deepStrictEqual(
      { name: opts.name, shellPath: opts.shellPath, shellArgs: [...opts.shellArgs] },
      { name: 'F# Interactive', shellPath: 'dotnet', shellArgs: ['fsi'] },
    );
  });

  test('the empty-string SDK path with extra args still falls back to bare dotnet', () => {
    const opts = fsi.fsiTerminalOptions('', ['--nologo']);
    assert.deepStrictEqual(
      { name: opts.name, shellPath: opts.shellPath, shellArgs: [...opts.shellArgs] },
      { name: 'F# Interactive', shellPath: 'dotnet', shellArgs: ['fsi', '--nologo'] },
    );
  });
});
