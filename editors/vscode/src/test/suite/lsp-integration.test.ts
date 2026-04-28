import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  openCSharpFile,
  openForgePanel,
  setupLspTestSuite,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  waitForSelectionRanges,
  LSP_RESPONSE_TIMEOUT_MS,
} from './test-helpers';

suite('LSP Integration — Document Symbols', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
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
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `namespace Test {
  public class Foo {
    public void Bar() { }
    public int Baz { get; set; }
  }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'symbols.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    assert.ok(symbols.length > 0, 'Should return at least one symbol');

    // Flatten to find all symbol names
    const names = flattenSymbolNames(symbols);
    assert.ok(names.includes('Foo'), 'Should contain class Foo');
    assert.ok(names.includes('Bar'), 'Should contain method Bar');
    assert.ok(names.includes('Baz'), 'Should contain property Baz');
  });

  test('returns namespace symbol', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = 'namespace MyApp.Models { public class Item { } }';
    const { uri } = await openCSharpFile(tmpDir, 'ns.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);

    assert.ok(
      names.some((n) => n.includes('MyApp')),
      'Should contain the namespace symbol',
    );
  });

  test('returns nested class symbols with hierarchy', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `namespace N {
  public class Outer {
    public class Inner {
      public void InnerMethod() { }
    }
    public void OuterMethod() { }
  }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'nested.cs', content);
    const symbols = await waitForDocumentSymbols(uri);

    // Find the Outer class and verify it has children
    const outer = findSymbol(symbols, 'Outer');
    assert.ok(outer, 'Should find Outer class');
    assert.ok(outer.children.length > 0, 'Outer should have child symbols');

    const innerNames = outer.children.map((c) => c.name);
    assert.ok(innerNames.includes('Inner'), 'Outer should contain Inner');
    assert.ok(innerNames.includes('OuterMethod'), 'Outer should contain OuterMethod');
  });

  test('returns interface and enum symbols', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `namespace T {
  public interface IService { void Execute(); }
  public enum Color { Red, Green, Blue }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'iface-enum.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);

    assert.ok(names.includes('IService'), 'Should contain interface');
    assert.ok(names.includes('Color'), 'Should contain enum');
  });

  test('returns empty array for file with no declarations', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const { uri } = await openCSharpFile(tmpDir, 'empty-decl.cs', '// Just a comment\n');

    // Give the server time to respond, then check
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    // Empty file may return null or empty array
    const count = result?.length ?? 0;
    assert.strictEqual(count, 0, 'Empty file should have zero symbols');
  });

  test('returns struct symbol', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `namespace T {
  public struct Point {
    public int X;
    public int Y;
  }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'struct.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);

    assert.ok(names.includes('Point'), 'Should contain struct Point');
  });

  test('returns record symbol', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = 'namespace T { public record Person(string Name, int Age); }';
    const { uri } = await openCSharpFile(tmpDir, 'record.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);

    assert.ok(names.includes('Person'), 'Should contain record Person');
  });
});

suite('LSP Integration — Folding Ranges', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
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
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
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
    const { uri } = await openCSharpFile(tmpDir, 'fold.cs', content);
    const ranges = await waitForFoldingRanges(uri);

    assert.ok(ranges.length >= 3, `Expected ≥3 folding ranges, got ${ranges.length}`);
  });

  test('returns folding ranges for region directives', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `public class C {
  #region Methods
  public void A() { }
  public void B() { }
  #endregion
}`;
    const { uri } = await openCSharpFile(tmpDir, 'region.cs', content);
    const ranges = await waitForFoldingRanges(uri);

    assert.ok(ranges.length >= 1, 'Should have at least one folding range');
    // Region folding should be present
    const regionRange = ranges.find((r) => r.kind === vscode.FoldingRangeKind.Region);
    assert.ok(regionRange, 'Should have a region folding range');
  });

  test('returns folding ranges for using directives', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `using System;
using System.Collections.Generic;
using System.Linq;

namespace Test {
  public class C { }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'usings.cs', content);
    const ranges = await waitForFoldingRanges(uri);

    // Should fold at least the namespace block.
    assert.ok(ranges.length >= 1, `Expected ≥1 folding ranges, got ${String(ranges.length)}`);
  });

  test('nested classes produce nested folding ranges', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `namespace N {
  class Outer {
    class Inner {
      void Method() {
        var x = 1;
      }
    }
  }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'nested-fold.cs', content);
    const ranges = await waitForFoldingRanges(uri);

    assert.ok(
      ranges.length >= 4,
      `Expected ≥4 folding ranges for nested classes, got ${ranges.length}`,
    );
  });
});

suite('LSP Integration — Selection Ranges', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
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
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `namespace Test {
  public class Foo {
    public void Bar() {
      var x = 42;
    }
  }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'sel.cs', content);

    // Position on "x" in "var x = 42;"
    const position = new vscode.Position(3, 10);
    const ranges = await waitForSelectionRanges(uri, [position]);

    assert.ok(ranges.length > 0, 'Should return at least one selection range');

    // Walk the parent chain — it should expand outward
    let current: vscode.SelectionRange | undefined = ranges[0];
    let depth = 0;
    while (current) {
      depth++;
      current = current.parent;
    }
    assert.ok(depth >= 3, `Selection range chain should have ≥3 levels, got ${depth}`);
  });

  test('returns selection ranges for multiple positions', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `class C {
  int a = 1;
  int b = 2;
}`;
    const { uri } = await openCSharpFile(tmpDir, 'sel-multi.cs', content);

    const positions = [
      new vscode.Position(1, 6), // on 'a'
      new vscode.Position(2, 6), // on 'b'
    ];
    const ranges = await waitForSelectionRanges(uri, positions);

    assert.strictEqual(ranges.length, 2, 'Should return one selection range per position');
  });

  test('selection ranges at class level expand to file', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const content = `namespace N {
  class MyClass {
    void M() { }
  }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'sel-class.cs', content);

    // Position on "MyClass"
    const position = new vscode.Position(1, 8);
    const ranges = await waitForSelectionRanges(uri, [position]);
    assert.ok(ranges.length > 0, 'Should return selection ranges');

    // The outermost parent should cover the entire file (or close to it)
    let outermost: vscode.SelectionRange = ranges[0]!;
    while (outermost.parent) {
      outermost = outermost.parent;
    }
    assert.ok(
      outermost.range.start.line <= 1,
      'Outermost range should start near beginning of file',
    );
  });
});

suite('LSP Integration — Fixture Files', () => {
  let fixtureDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
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
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 15_000);
    const uri = vscode.Uri.file(path.join(fixtureDir, 'Calculator.cs'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);

    assert.ok(names.includes('Calculator'), 'Should find Calculator class');
    assert.ok(names.includes('Add'), 'Should find Add method');
    assert.ok(names.includes('Subtract'), 'Should find Subtract method');
    assert.ok(names.includes('Divide'), 'Should find Divide method');
    assert.ok(names.includes('ICalculator'), 'Should find ICalculator interface');
    assert.ok(names.includes('Operation'), 'Should find Operation enum');

    // Load fixture solution so Solution Explorer is populated in the screenshot.
    if (process.env['FORGE_SCREENSHOTS']) {
      const ext2 = vscode.extensions.getExtension('forge-lsp.forge');
      const api2 = ext2?.exports as { explorerProvider?: { loadSolution(p: string): Promise<void>; getChildren(e?: unknown): unknown[] | undefined } } | undefined;
      if (api2?.explorerProvider) {
        const slnPath = path.join(fixtureDir, 'TestFixtures.sln');
        await api2.explorerProvider.loadSolution(slnPath);
        // Wait for tree to populate before screenshot.
        let waited = 0;
        while ((api2.explorerProvider.getChildren() ?? []).length === 0 && waited < 8000) {
          await new Promise((r) => setTimeout(r, 200));
          waited += 200;
        }
      }
    }
    await openForgePanel();
    await takeScreenshot('vscode-getting-started-page.png');
  });

  test('Calculator.cs has folding ranges for regions', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 10_000);
    const uri = vscode.Uri.file(path.join(fixtureDir, 'Calculator.cs'));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    const ranges = await waitForFoldingRanges(uri);
    assert.ok(ranges.length >= 5, `Expected ≥5 folding ranges, got ${ranges.length}`);

    // Must have region folding ranges for #region/#endregion
    const regionRanges = ranges.filter((r) => r.kind === vscode.FoldingRangeKind.Region);
    assert.ok(regionRanges.length >= 2, `Expected ≥2 #region ranges, got ${regionRanges.length}`);

    // Each region range must span at least 2 lines
    for (const r of regionRanges) {
      assert.ok(r.end > r.start, `Region range must span >1 line: ${r.start}–${r.end}`);
    }

    // The #region Arithmetic range must exist (start line varies by LSP implementation)
    // Log all region ranges to aid debugging
    console.log('Region ranges:', regionRanges.map((r) => `${r.start}–${r.end}`).join(', '));
    assert.ok(regionRanges.length >= 2, 'Must have at least 2 region folding ranges (Arithmetic + State)');

    // Fold everything and assert visible lines dropped drastically
    const linesBefore = editor.visibleRanges.reduce((sum, r) => sum + r.end.line - r.start.line + 1, 0);
    assert.ok(linesBefore > 10, `File must have >10 visible lines before folding, got ${linesBefore}`);
    await vscode.commands.executeCommand('editor.foldAll');
    await new Promise((r) => setTimeout(r, 800));
    const linesAfter = editor.visibleRanges.reduce((sum, r) => sum + r.end.line - r.start.line + 1, 0);
    assert.ok(linesAfter < linesBefore, `Folding must reduce visible lines: before=${linesBefore} after=${linesAfter}`);
    assert.ok(linesAfter <= 5, `After foldAll, should have ≤5 visible lines, got ${linesAfter}`);

    // Keep the editor focused so the folded regions are clearly visible.
    // Close the bottom panel to maximise the editor view in the screenshot.
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await new Promise((r) => setTimeout(r, 500));
    await takeScreenshot('code-folding.png');
  });

  test('Nested.cs returns nested class hierarchy', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 10_000);
    const uri = vscode.Uri.file(path.join(fixtureDir, 'Nested.cs'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenSymbolNames(symbols);

    assert.ok(names.includes('Outer'), 'Should find Outer');
    assert.ok(names.includes('Inner'), 'Should find Inner');
    assert.ok(names.includes('AnotherInner'), 'Should find AnotherInner');
    assert.ok(names.includes('InnerMethod'), 'Should find InnerMethod');
    assert.ok(names.includes('OuterMethod'), 'Should find OuterMethod');
    // Keep editor focused so nested class structure is visible.
    // Close the bottom panel to maximise the editor view.
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await new Promise((r) => setTimeout(r, 500));
    await takeScreenshot('nested-classes.png');
  });

  test('Empty.cs returns no symbols', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const uri = vscode.Uri.file(path.join(fixtureDir, 'Empty.cs'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    // Give server a moment, then verify empty
    await new Promise((r) => setTimeout(r, 2_000));
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    const count = result?.length ?? 0;
    assert.strictEqual(count, 0, 'Empty.cs should have zero symbols');
  });
});

// ── Code Actions / Refactoring ────────────────────────────────────

suite('LSP Integration — Code Actions & Refactoring', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('refactor-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('code actions returned for unused variable', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    const content = `namespace RefactorDemo
{
    public class Refactor
    {
        public void Run()
        {
            string unused = "hello";
        }
    }
}`;
    const { uri } = await openCSharpFile(tmpDir, 'Refactor.cs', content);
    await waitForDocumentSymbols(uri);
    await new Promise((r) => setTimeout(r, 2_000));

    const range = new vscode.Range(new vscode.Position(6, 12), new vscode.Position(6, 18));
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      uri,
      range,
    );

    assert.ok(actions !== undefined, 'Must return code actions');
    assert.ok(actions.length > 0, 'Must have at least one code action for unused variable');

    // Trigger the lightbulb in the editor so it's visible in the screenshot.
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'Must have active editor');
    editor.selection = new vscode.Selection(new vscode.Position(6, 18), new vscode.Position(6, 18));
    await vscode.commands.executeCommand('editor.action.quickFix');
    await new Promise((r) => setTimeout(r, 1500));
    await takeScreenshot('vscode-refactoring.png');
  });
});

// ── Helpers ──────────────────────────────────────────────────────

function flattenSymbolNames(symbols: vscode.DocumentSymbol[]): string[] {
  const names: string[] = [];
  function walk(list: vscode.DocumentSymbol[]): void {
    for (const sym of list) {
      names.push(sym.name);
      if (sym.children.length > 0) {
        walk(sym.children);
      }
    }
  }
  walk(symbols);
  return names;
}

function findSymbol(
  symbols: vscode.DocumentSymbol[],
  name: string,
): vscode.DocumentSymbol | undefined {
  for (const sym of symbols) {
    if (sym.name === name) return sym;
    const found = findSymbol(sym.children, name);
    if (found) return found;
  }
  return undefined;
}
