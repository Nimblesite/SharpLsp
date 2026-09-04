// The SYNTAX-ONLY tier: documentSymbol, foldingRange, selectionRange.
//
// Spec: [SHARPLSP-ARCHITECTURE-ROUTING] (Rust/tree-sitter, <5ms),
// [SHARPLSP-FEATURES-NAVIGATION] (document symbols, breadcrumbs),
// [SHARPLSP-PERFORMANCE] (outline <10ms, folding <5ms), LSP 3.17.
//
// "The name I expected is in the list" is the weakest question that can be
// asked of any of these replies. A tree that names every symbol and hands back
// a range past the end of the buffer breaks breadcrumbs; a folding range that
// ends before it starts gives the gutter a chevron that folds nothing; a
// selection chain that does not contain the caret makes expand-selection jump
// somewhere else. Every test here asserts the KIND, the RANGE and the SHAPE,
// then drives the editor with the reply to prove the editor can use it.
//
// The semantic tier — completion, definition, references, highlights, inlay
// hints, code actions — lives in lsp-integration-semantic.test.ts.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  flattenSymbolNames,
  loadFixtureSolution,
  openCSharpFile,
  openExistingFile,
  openSharpLspPanel,
  replaceDocumentContent,
  setupLspTestSuite,
  settleForScreenshot,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  waitForSelectionRanges,
} from './test-helpers';
import {
  assertFoldingRanges,
  assertSelectionChain,
  assertSymbolShape,
  assertSymbolTree,
  symbolNamed,
} from './lsp-invariants-kit';
import { ACTIVATION_MS, LSP_RESPONSE_MS } from './test-timeouts';

suite('LSP Integration — Document Symbols', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('symbols-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('returns class and method symbols for a C# file', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Test {
  public class Foo {
    public void Bar() { }
    public int Baz { get; set; }
  }
}`;
    // Interaction 1 — the outline names every declaration in the file.
    const { uri, doc } = await openCSharpFile(tmpDir, 'symbols.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    assert.ok(symbols.length > 0, 'Should return at least one symbol');
    const names = flattenSymbolNames(symbols);
    assert.ok(names.includes('Foo'), 'Should contain class Foo');
    assert.ok(names.includes('Bar'), 'Should contain method Bar');
    assert.ok(names.includes('Baz'), 'Should contain property Baz');

    // Interaction 2 — every reply obeys the protocol: selectionRange inside
    // range, range inside the document, child inside parent.
    const counted = assertSymbolTree(symbols, doc);
    assert.ok(counted >= 4, `namespace, class, method and property at least, got ${counted}`);

    // Interaction 3 — each symbol carries the KIND its outline icon is drawn
    // from, and a selectionRange that really covers its own identifier.
    assertSymbolShape(symbolNamed(symbols, 'Foo'), vscode.SymbolKind.Class, doc);
    assertSymbolShape(symbolNamed(symbols, 'Bar'), vscode.SymbolKind.Method, doc);
    assertSymbolShape(symbolNamed(symbols, 'Baz'), vscode.SymbolKind.Property, doc);

    // Interaction 4 — the tree is a HIERARCHY, not a flat list: breadcrumbs
    // read Test > Foo > Bar, so Bar must be a child of Foo, not a sibling.
    const foo = symbolNamed(symbols, 'Foo');
    const children = foo.children.map((child) => child.name);
    assert.deepStrictEqual(children, ['Bar', 'Baz'], 'Foo owns Bar and Baz, in source order');
    assert.ok(foo.range.contains(symbolNamed(symbols, 'Bar').range), 'Bar sits inside Foo');
    assert.strictEqual(symbols.length, 1, 'one top-level symbol: the namespace');
  });

  test('returns namespace symbol', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = 'namespace MyApp.Models { public class Item { } }';
    // Interaction 1 — the dotted namespace reaches the outline.
    const { uri, doc } = await openCSharpFile(tmpDir, 'ns.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);
    assert.ok(
      names.some((name) => name.includes('MyApp')),
      'Should contain the namespace symbol',
    );
    assertSymbolTree(symbols, doc);

    // Interaction 2 — it is a NAMESPACE, and it is the root of the tree. A
    // namespace reported as a class puts the wrong icon on every breadcrumb.
    const root = symbols[0];
    assert.ok(root, 'the outline must have a root symbol');
    assert.strictEqual(root.kind, vscode.SymbolKind.Namespace, 'the root is a namespace');
    assert.ok(root.name.includes('MyApp'), `the root names the namespace, got '${root.name}'`);
    assert.strictEqual(symbols.length, 1, 'a single-namespace file has one root');

    // Interaction 3 — the namespace CONTAINS the type declared inside it, and
    // its range spans the whole declaration rather than just the keyword.
    const item = symbolNamed(symbols, 'Item');
    assert.ok(root.range.contains(item.range), 'the namespace must contain Item');
    assertSymbolShape(item, vscode.SymbolKind.Class, doc);
    assert.strictEqual(root.range.start.line, 0, 'the namespace starts on the first line');
  });

  test('returns nested class symbols with hierarchy', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace N {
  public class Outer {
    public class Inner {
      public void InnerMethod() { }
    }
    public void OuterMethod() { }
  }
}`;
    // Interaction 1 — Outer owns its members.
    const { uri, doc } = await openCSharpFile(tmpDir, 'nested.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const outer = symbolNamed(symbols, 'Outer');
    assert.ok(outer.children.length > 0, 'Outer should have child symbols');
    const innerNames = outer.children.map((child) => child.name);
    assert.ok(innerNames.includes('Inner'), 'Outer should contain Inner');
    assert.ok(innerNames.includes('OuterMethod'), 'Outer should contain OuterMethod');

    // Interaction 2 — the nesting goes all the way down. A tree that flattens
    // Inner's method to Outer gives the wrong breadcrumb trail.
    const inner = symbolNamed(symbols, 'Inner');
    assert.deepStrictEqual(
      inner.children.map((child) => child.name),
      ['InnerMethod'],
      'Inner owns InnerMethod alone',
    );
    assert.ok(inner.range.contains(symbolNamed(symbols, 'InnerMethod').range), 'and contains it');
    assert.ok(outer.range.contains(inner.range), 'and Outer contains Inner');

    // Interaction 3 — kinds and protocol invariants across the whole tree.
    assertSymbolTree(symbols, doc);
    assertSymbolShape(outer, vscode.SymbolKind.Class, doc);
    assertSymbolShape(inner, vscode.SymbolKind.Class, doc);
    assertSymbolShape(symbolNamed(symbols, 'InnerMethod'), vscode.SymbolKind.Method, doc);
    assertSymbolShape(symbolNamed(symbols, 'OuterMethod'), vscode.SymbolKind.Method, doc);
  });

  test('returns interface and enum symbols', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace T {
  public interface IService { void Execute(); }
  public enum Color { Red, Green, Blue }
}`;
    // Interaction 1 — both type shapes reach the outline.
    const { uri, doc } = await openCSharpFile(tmpDir, 'iface-enum.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);
    assert.ok(names.includes('IService'), 'Should contain interface');
    assert.ok(names.includes('Color'), 'Should contain enum');
    assertSymbolTree(symbols, doc);

    // Interaction 2 — an interface is not a class and an enum is not either.
    // The outline icon is drawn from the kind, and so is workspace-symbol
    // filtering, so a wrong kind is a wrong search result.
    assertSymbolShape(symbolNamed(symbols, 'IService'), vscode.SymbolKind.Interface, doc);
    assertSymbolShape(symbolNamed(symbols, 'Color'), vscode.SymbolKind.Enum, doc);
    assertSymbolShape(symbolNamed(symbols, 'Execute'), vscode.SymbolKind.Method, doc);

    // Interaction 3 — the enum's members are its children, all three of them.
    const color = symbolNamed(symbols, 'Color');
    assert.deepStrictEqual(
      color.children.map((child) => child.name),
      ['Red', 'Green', 'Blue'],
      'the enum owns its members in declaration order',
    );
    assert.ok(color.range.contains(color.children[0]?.range ?? color.range), 'and contains them');
    assert.deepStrictEqual(
      symbolNamed(symbols, 'IService').children.map((child) => child.name),
      ['Execute'],
      'and the interface owns its one method',
    );
  });

  test('returns empty array for file with no declarations', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — a comment-only file declares nothing, so the outline is
    // empty rather than carrying a phantom root.
    const { uri, doc } = await openCSharpFile(tmpDir, 'empty-decl.cs', '// Just a comment\n');
    const empty = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    assert.strictEqual(empty?.length ?? 0, 0, 'Empty file should have zero symbols');
    assert.strictEqual(doc.getText().trim(), '// Just a comment', 'the buffer really is bare');

    // Interaction 2 — the user types a class in, and the outline appears
    // WITHOUT a reload. [VSCODE-REACTIVITY-SPEC]: the tree follows the buffer.
    await replaceDocumentContent(doc, 'class Appears { void M() { } }\n');
    const filled = await waitForDocumentSymbols(uri);
    assert.ok(filled.length > 0, 'typing a declaration must populate the outline');
    assert.ok(flattenSymbolNames(filled).includes('Appears'), 'and name what was typed');
    assertSymbolTree(filled, doc);

    // Interaction 3 — deleting it again empties the outline. A tree that keeps
    // a stale symbol navigates the user to a declaration that no longer exists.
    await replaceDocumentContent(doc, '// Just a comment\n');
    const cleared = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    assert.strictEqual(cleared?.length ?? 0, 0, 'removing the declaration must empty the outline');
    assert.strictEqual(
      flattenSymbolNames(cleared ?? []).includes('Appears'),
      false,
      'and leave no stale symbol behind',
    );
  });

  test('returns struct symbol', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace T {
  public struct Point {
    public int X;
    public int Y;
  }
}`;
    // Interaction 1 — the struct reaches the outline.
    const { uri, doc } = await openCSharpFile(tmpDir, 'struct.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    assert.ok(flattenSymbolNames(symbols).includes('Point'), 'Should contain struct Point');
    assertSymbolTree(symbols, doc);

    // Interaction 2 — a struct is a Struct, not a Class. The distinction is
    // the whole point of the declaration and drives the outline icon.
    const point = symbolNamed(symbols, 'Point');
    assertSymbolShape(point, vscode.SymbolKind.Struct, doc);
    assert.notStrictEqual(point.kind, vscode.SymbolKind.Class, 'a struct is not a class');

    // Interaction 3 — its fields are its children, and they are Fields.
    assert.deepStrictEqual(
      point.children.map((child) => child.name),
      ['X', 'Y'],
      'the struct owns both fields in declaration order',
    );
    assertSymbolShape(symbolNamed(symbols, 'X'), vscode.SymbolKind.Field, doc);
    assertSymbolShape(symbolNamed(symbols, 'Y'), vscode.SymbolKind.Field, doc);
  });

  test('returns record symbol', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = 'namespace T { public record Person(string Name, int Age); }';
    // Interaction 1 — the record reaches the outline.
    const { uri, doc } = await openCSharpFile(tmpDir, 'record.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    assert.ok(flattenSymbolNames(symbols).includes('Person'), 'Should contain record Person');
    assertSymbolTree(symbols, doc);

    // Interaction 2 — a record is a TYPE. Whether the outline draws it as a
    // class or a struct, it must never land on a member kind: a record
    // reported as a method or a variable is unusable from Go to Symbol.
    const person = symbolNamed(symbols, 'Person');
    assert.ok(
      [vscode.SymbolKind.Class, vscode.SymbolKind.Struct].includes(person.kind),
      `a record must be a type kind, got ${vscode.SymbolKind[person.kind]}`,
    );
    assert.notStrictEqual(person.kind, vscode.SymbolKind.Method, 'a record is not a method');
    assert.notStrictEqual(person.kind, vscode.SymbolKind.Variable, 'nor a variable');

    // Interaction 3 — its selectionRange covers `Person` and not the whole
    // positional parameter list, so Go to Symbol lands on the name.
    assertSymbolShape(person, person.kind, doc);
    assert.strictEqual(
      doc.getText(person.selectionRange).includes('('),
      false,
      'the identifier span must stop before the positional parameter list',
    );
    assert.ok(person.range.contains(person.selectionRange), 'and sit inside the declaration');
  });
});

suite('LSP Integration — Folding Ranges', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('folding-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('returns folding ranges for class and method bodies', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Test {
  public class Foo {
    public void Bar() {
      var x = 1;
      var y = 2;
    }

    public void Baz() {
      var z = 3;
    }
  }
}`;
    // Interaction 1 — one chevron per block: namespace, class, two methods.
    const { uri, doc } = await openCSharpFile(tmpDir, 'fold.cs', content);
    const ranges = await waitForFoldingRanges(uri);
    assert.ok(ranges.length >= 3, `Expected ≥3 folding ranges, got ${ranges.length}`);
    assertFoldingRanges(ranges, doc);

    // Interaction 2 — the outermost range is the namespace and it CONTAINS the
    // rest. A flat set of ranges cannot render nested chevrons.
    const outermost = ranges.reduce((widest, range) =>
      range.end - range.start > widest.end - widest.start ? range : widest,
    );
    assert.strictEqual(outermost.start, 0, 'the widest range starts at the namespace');
    assert.ok(outermost.end >= doc.lineCount - 2, 'and reaches the end of the file');
    const nested = ranges.filter(
      (range) =>
        range !== outermost && range.start >= outermost.start && range.end <= outermost.end,
    );
    assert.ok(
      nested.length >= 2,
      `the namespace must nest the class and its methods, got ${nested.length}`,
    );

    // Interaction 3 — the editor can USE them: folding everything collapses the
    // buffer, and unfolding restores exactly what was visible before.
    const editor = await vscode.window.showTextDocument(doc);
    const visible = () =>
      editor.visibleRanges.reduce((sum, range) => sum + range.end.line - range.start.line + 1, 0);
    const before = visible();
    await vscode.commands.executeCommand('editor.foldAll');
    assert.ok(visible() < before, `folding must hide lines: ${before} -> ${visible()}`);
    await vscode.commands.executeCommand('editor.unfoldAll');
    assert.strictEqual(visible(), before, 'and unfolding must restore every line');
  });

  test('returns folding ranges for region directives', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `public class C {
  #region Methods
  public void A() { }
  public void B() { }
  #endregion
}`;
    // Interaction 1 — a #region is foldable, and it is tagged as a Region.
    const { uri, doc } = await openCSharpFile(tmpDir, 'region.cs', content);
    const ranges = await waitForFoldingRanges(uri);
    assert.ok(ranges.length >= 1, 'Should have at least one folding range');
    assertFoldingRanges(ranges, doc);
    const regionRange = ranges.find((range) => range.kind === vscode.FoldingRangeKind.Region);
    assert.ok(regionRange, 'Should have a region folding range');

    // Interaction 2 — it covers the directive pair EXACTLY. A region range
    // that starts on the class swallows members the user meant to keep open.
    assert.strictEqual(regionRange.start, 1, 'the region starts on the #region line');
    assert.strictEqual(regionRange.end, 4, 'and ends on the #endregion line');
    assert.strictEqual(
      doc.lineAt(regionRange.start).text.trim().startsWith('#region'),
      true,
      'the start line really is the directive',
    );
    assert.strictEqual(
      doc.lineAt(regionRange.end).text.trim().startsWith('#endregion'),
      true,
      'and the end line closes it',
    );

    // Interaction 3 — the class body folds too, and it is NOT tagged Region:
    // only the directive pair is a region.
    const plain = ranges.filter((range) => range.kind !== vscode.FoldingRangeKind.Region);
    assert.ok(plain.length >= 1, 'the class body must fold as well');
    assert.strictEqual(
      ranges.filter((range) => range.kind === vscode.FoldingRangeKind.Region).length,
      1,
      'exactly one region, matching the one directive pair',
    );
  });

  test('returns folding ranges for using directives', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `using System;
using System.Collections.Generic;
using System.Linq;

namespace Test {
  public class C { }
}`;
    // Interaction 1 — the file folds at all, and every range is well formed.
    const { uri, doc } = await openCSharpFile(tmpDir, 'usings.cs', content);
    const ranges = await waitForFoldingRanges(uri);
    assert.ok(ranges.length >= 1, `Expected ≥1 folding ranges, got ${String(ranges.length)}`);
    assertFoldingRanges(ranges, doc);

    // Interaction 2 — the using block is folded as IMPORTS. LSP 3.17 defines
    // the `imports` kind precisely so an editor can collapse the header of
    // every file at once; a plain range there is a header that never collapses
    // with "Fold Imports", which is what this test's name promises.
    const imports = ranges.filter((range) => range.kind === vscode.FoldingRangeKind.Imports);
    assert.ok(imports.length >= 1, 'the using block must fold as FoldingRangeKind.Imports');
    const header = imports[0];
    assert.ok(header, 'the imports range must be readable');
    assert.strictEqual(header.start, 0, 'the imports range starts on the first using');
    assert.strictEqual(header.end, 2, 'and ends on the last one, not on the namespace');

    // Interaction 3 — the namespace block folds separately, so collapsing the
    // header leaves the code below it visible.
    const body = ranges.filter((range) => range.kind !== vscode.FoldingRangeKind.Imports);
    assert.ok(body.length >= 1, 'the namespace must fold independently of the header');
    assert.ok(
      body.every((range) => range.start >= 4),
      'and every non-import range starts at or after the namespace',
    );
  });

  test('nested classes produce nested folding ranges', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace N {
  class Outer {
    class Inner {
      void Method() {
        var x = 1;
      }
    }
  }
}`;
    // Interaction 1 — one chevron per level of nesting.
    const { uri, doc } = await openCSharpFile(tmpDir, 'nested-fold.cs', content);
    const ranges = await waitForFoldingRanges(uri);
    assert.ok(
      ranges.length >= 4,
      `Expected ≥4 folding ranges for nested classes, got ${ranges.length}`,
    );
    assertFoldingRanges(ranges, doc);

    // Interaction 2 — the ranges really NEST. Four ranges that all start on
    // line 0 are four chevrons that fold the same thing.
    const sorted = [...ranges].sort((left, right) => left.start - right.start);
    const starts = sorted.map((range) => range.start);
    assert.strictEqual(new Set(starts).size, starts.length, 'each level folds at its own line');
    for (let index = 1; index < sorted.length; index += 1) {
      const inner = sorted[index];
      const outer = sorted[index - 1];
      assert.ok(inner && outer, 'the sorted ranges must be readable');
      assert.ok(inner.start > outer.start, 'each level starts strictly inside the previous one');
      assert.ok(inner.end <= outer.end, 'and ends at or before it');
    }

    // Interaction 3 — folding the OUTERMOST level hides every inner one, which
    // is what nesting buys the user.
    const editor = await vscode.window.showTextDocument(doc);
    const visible = () =>
      editor.visibleRanges.reduce((sum, range) => sum + range.end.line - range.start.line + 1, 0);
    const before = visible();
    await vscode.commands.executeCommand('editor.foldAll');
    assert.ok(visible() < before, `folding must collapse the nest: ${before} -> ${visible()}`);
    assert.ok(visible() <= 3, `a fully folded nest shows the namespace line, got ${visible()}`);
  });
});

suite('LSP Integration — Selection Ranges', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('selection-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('returns selection ranges expanding from cursor position', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace Test {
  public class Foo {
    public void Bar() {
      var x = 42;
    }
  }
}`;
    // Interaction 1 — the caret on `x` yields a chain that expands outward.
    const { uri, doc } = await openCSharpFile(tmpDir, 'sel.cs', content);
    const position = new vscode.Position(3, 10);
    const ranges = await waitForSelectionRanges(uri, [position]);
    assert.ok(ranges.length > 0, 'Should return at least one selection range');
    const chain = ranges[0];
    assert.ok(chain, 'the chain for the one requested position must be readable');
    const depth = assertSelectionChain(chain, position, doc);
    assert.ok(depth >= 3, `Selection range chain should have ≥3 levels, got ${depth}`);

    // Interaction 2 — the innermost level is the IDENTIFIER under the caret,
    // not the whole statement. Expand-selection starting at the statement
    // skips the level the user pressed the key for.
    assert.strictEqual(doc.getText(chain.range), 'x', 'the first level selects the identifier');
    assert.strictEqual(chain.range.start.line, position.line, 'and stays on the caret line');
    assert.ok(chain.parent, 'and it has somewhere to expand to');

    // Interaction 3 — a level along the chain covers the whole declaration
    // statement, and the outermost covers the file.
    const levels: string[] = [];
    for (
      let current: vscode.SelectionRange | undefined = chain;
      current;
      current = current.parent
    ) {
      levels.push(doc.getText(current.range));
    }
    assert.ok(
      levels.some((text) => text.trim() === 'var x = 42;'),
      `expanding must pass through the statement; saw ${levels.length} levels`,
    );
    assert.ok(
      levels.some((text) => text.includes('class Foo')),
      'and through the class declaration',
    );
    assert.strictEqual(levels.length, depth, 'every level was walked exactly once');
  });

  test('returns selection ranges for multiple positions', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `class C {
  int a = 1;
  int b = 2;
}`;
    // Interaction 1 — one chain per requested position, in request order.
    const { uri, doc } = await openCSharpFile(tmpDir, 'sel-multi.cs', content);
    const positions = [new vscode.Position(1, 6), new vscode.Position(2, 6)];
    const ranges = await waitForSelectionRanges(uri, positions);
    assert.strictEqual(ranges.length, 2, 'Should return one selection range per position');
    const [first, second] = ranges;
    assert.ok(first && second, 'both chains must be readable');

    // Interaction 2 — each chain belongs to ITS OWN caret. A provider that
    // answers both positions with one chain silently moves the second cursor.
    const firstDepth = assertSelectionChain(first, positions[0]!, doc);
    const secondDepth = assertSelectionChain(second, positions[1]!, doc);
    assert.strictEqual(doc.getText(first.range), 'a', 'the first chain selects a');
    assert.strictEqual(doc.getText(second.range), 'b', 'and the second selects b');
    assert.strictEqual(first.range.isEqual(second.range), false, 'the two chains are distinct');

    // Interaction 3 — both chains reach the same enclosing class, so a
    // multi-cursor expand ends with both selections on the same construct.
    assert.ok(firstDepth >= 2 && secondDepth >= 2, 'both chains expand at least once');
    const outermostOf = (chain: vscode.SelectionRange): vscode.SelectionRange => {
      let current = chain;
      while (current.parent) current = current.parent;
      return current;
    };
    assert.strictEqual(
      outermostOf(first).range.isEqual(outermostOf(second).range),
      true,
      'both carets expand to the same outermost construct',
    );
  });

  test('selection ranges at class level expand to file', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const content = `namespace N {
  class MyClass {
    void M() { }
  }
}`;
    // Interaction 1 — a caret on the class name yields a chain.
    const { uri, doc } = await openCSharpFile(tmpDir, 'sel-class.cs', content);
    const position = new vscode.Position(1, 8);
    const ranges = await waitForSelectionRanges(uri, [position]);
    assert.ok(ranges.length > 0, 'Should return selection ranges');
    const chain = ranges[0];
    assert.ok(chain, 'the chain must be readable');
    const depth = assertSelectionChain(chain, position, doc);

    // Interaction 2 — the innermost level is the class NAME, and expanding
    // reaches the class declaration itself.
    assert.strictEqual(doc.getText(chain.range), 'MyClass', 'the first level selects the name');
    const texts: string[] = [];
    for (
      let current: vscode.SelectionRange | undefined = chain;
      current;
      current = current.parent
    ) {
      texts.push(doc.getText(current.range));
    }
    assert.ok(
      texts.some((text) => text.includes('void M()')),
      'expanding must reach the whole class body',
    );
    assert.ok(depth >= 3, `name, class, namespace at least; got ${depth} levels`);

    // Interaction 3 — the outermost range covers the file, so one more press
    // of expand-selection selects everything.
    let outermost = chain;
    while (outermost.parent) outermost = outermost.parent;
    assert.ok(
      outermost.range.start.line <= 1,
      'Outermost range should start near beginning of file',
    );
    assert.ok(outermost.range.end.line >= doc.lineCount - 2, 'and reach the last line');
    assert.ok(outermost.range.contains(chain.range), 'and contain where the user started');
  });
});

suite('LSP Integration — Fixture Files', () => {
  let fixtureDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    // The fixture workspace is opened by the test runner.
    fixtureDir = path.resolve(__dirname, '../../../test-fixtures/workspace');
  });

  suiteTeardown(async () => {
    await closeAllEditors();
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('Calculator.cs returns symbols for class, methods, properties', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — every declaration in the committed fixture is named.
    const { uri, doc } = await openExistingFile(fixtureDir, 'Calculator.cs');
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);
    for (const required of [
      'Calculator',
      'Add',
      'Subtract',
      'Divide',
      'ICalculator',
      'Operation',
    ]) {
      assert.ok(names.includes(required), `Should find ${required}`);
    }

    // Interaction 2 — every one of them obeys the protocol and carries the
    // kind its outline icon and Go-to-Symbol filter are drawn from.
    assertSymbolTree(symbols, doc);
    assertSymbolShape(symbolNamed(symbols, 'Calculator'), vscode.SymbolKind.Class, doc);
    assertSymbolShape(symbolNamed(symbols, 'ICalculator'), vscode.SymbolKind.Interface, doc);
    assertSymbolShape(symbolNamed(symbols, 'Operation'), vscode.SymbolKind.Enum, doc);
    assertSymbolShape(symbolNamed(symbols, 'Add'), vscode.SymbolKind.Method, doc);

    // Interaction 3 — the methods belong to the CLASS, not to the file. A flat
    // outline over a real fixture is the defect a synthetic one never shows.
    const calculator = symbolNamed(symbols, 'Calculator');
    const members = calculator.children.map((child) => child.name);
    for (const method of ['Add', 'Subtract', 'Divide']) {
      assert.ok(members.includes(method), `Calculator owns ${method}, got ${members.join(', ')}`);
      assert.ok(
        calculator.range.contains(symbolNamed(symbols, method).range),
        `and ${method} sits inside it`,
      );
    }

    // Load fixture solution so Solution Explorer is populated in the screenshot.
    if (process.env['SHARPLSP_SCREENSHOTS']) {
      await loadFixtureSolution(fixtureDir);
    }
    await openSharpLspPanel();
    await takeScreenshot('vscode-getting-started-page.png');
  });

  test('Calculator.cs has folding ranges for regions', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — the fixture folds, and every range is well formed.
    const { uri, doc } = await openExistingFile(fixtureDir, 'Calculator.cs');
    const editor = await vscode.window.showTextDocument(doc);
    const ranges = await waitForFoldingRanges(uri);
    assert.ok(ranges.length >= 5, `Expected ≥5 folding ranges, got ${ranges.length}`);
    assertFoldingRanges(ranges, doc);

    // Interaction 2 — the #region/#endregion pairs are tagged Region and each
    // one really straddles its directives in the committed source.
    const regionRanges = ranges.filter((range) => range.kind === vscode.FoldingRangeKind.Region);
    assert.ok(regionRanges.length >= 2, `Expected ≥2 #region ranges, got ${regionRanges.length}`);
    for (const range of regionRanges) {
      assert.ok(
        range.end > range.start,
        `Region range must span >1 line: ${range.start}–${range.end}`,
      );
      assert.ok(
        doc.lineAt(range.start).text.includes('#region'),
        `region range ${range.start}–${range.end} must start on a #region directive`,
      );
      assert.ok(
        doc.lineAt(range.end).text.includes('#endregion'),
        `region range ${range.start}–${range.end} must end on an #endregion directive`,
      );
    }

    // Interaction 3 — the editor collapses on them and comes back.
    const visible = () =>
      editor.visibleRanges.reduce((sum, range) => sum + range.end.line - range.start.line + 1, 0);
    const linesBefore = visible();
    assert.ok(
      linesBefore > 10,
      `File must have >10 visible lines before folding, got ${linesBefore}`,
    );
    await vscode.commands.executeCommand('editor.foldAll');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const linesAfter = visible();
    assert.ok(
      linesAfter < linesBefore,
      `Folding must reduce visible lines: before=${linesBefore} after=${linesAfter}`,
    );
    assert.ok(linesAfter <= 5, `After foldAll, should have ≤5 visible lines, got ${linesAfter}`);
    await vscode.commands.executeCommand('editor.unfoldAll');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(visible(), linesBefore, 'and unfolding restores every line');

    // Keep the editor focused so the folded regions are clearly visible.
    await vscode.commands.executeCommand('editor.foldAll');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await settleForScreenshot(500);
    await takeScreenshot('code-folding.png');
  });

  test('Nested.cs returns nested class hierarchy', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — every nested declaration is named.
    const { uri, doc } = await openExistingFile(fixtureDir, 'Nested.cs');
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);
    for (const required of ['Outer', 'Inner', 'AnotherInner', 'InnerMethod', 'OuterMethod']) {
      assert.ok(names.includes(required), `Should find ${required}`);
    }

    // Interaction 2 — the hierarchy is real: both inner classes are children
    // of Outer, and InnerMethod is a child of Inner rather than of Outer.
    assertSymbolTree(symbols, doc);
    const outer = symbolNamed(symbols, 'Outer');
    const outerChildren = outer.children.map((child) => child.name);
    assert.ok(outerChildren.includes('Inner'), `Outer owns Inner, got ${outerChildren.join(', ')}`);
    assert.ok(outerChildren.includes('AnotherInner'), 'and AnotherInner');
    assert.strictEqual(
      outerChildren.includes('InnerMethod'),
      false,
      'InnerMethod belongs to Inner, not to Outer',
    );

    // Interaction 3 — kinds, so the outline draws a class icon at every level.
    assertSymbolShape(outer, vscode.SymbolKind.Class, doc);
    assertSymbolShape(symbolNamed(symbols, 'Inner'), vscode.SymbolKind.Class, doc);
    assertSymbolShape(symbolNamed(symbols, 'AnotherInner'), vscode.SymbolKind.Class, doc);
    assertSymbolShape(symbolNamed(symbols, 'InnerMethod'), vscode.SymbolKind.Method, doc);

    // Keep editor focused so nested class structure is visible.
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await settleForScreenshot(500);
    await takeScreenshot('nested-classes.png');
  });

  test('Empty.cs returns no symbols', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — the committed fixture really is declaration-free, so the
    // assertion below is about the provider and not about the fixture.
    const { uri, doc } = await openExistingFile(fixtureDir, 'Empty.cs');
    assert.strictEqual(doc.languageId, 'csharp', 'Empty.cs still opens as C#');
    assert.strictEqual(
      doc.getText().includes('class'),
      false,
      'the fixture declares no type — otherwise this test proves nothing',
    );

    // Interaction 2 — the outline is empty, not a phantom root.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    assert.strictEqual(symbols?.length ?? 0, 0, 'Empty.cs should have zero symbols');
    assert.deepStrictEqual(flattenSymbolNames(symbols ?? []), [], 'and name nothing at all');

    // Interaction 3 — the other syntax-tier providers agree: nothing to fold,
    // and no chevron in the gutter. A provider that invents a range for an
    // empty file puts a fold marker on a file with nothing to hide.
    const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      uri,
    );
    assertFoldingRanges(folds ?? [], doc);
    assert.strictEqual(folds?.length ?? 0, 0, 'a declaration-free file folds nowhere');
    assert.strictEqual(doc.isDirty, false, 'and reading it left the buffer untouched');
  });
});
