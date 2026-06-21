import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import { FSHARP_COLD_TIMEOUT_MS, openFSharpFixture } from './fsharp-helpers';

/**
 * Blanket end-to-end coverage for F# syntax-only features served by the Rust
 * host via tree-sitter: document symbols, folding ranges, and selection ranges.
 *
 * These are EXPECTED to fail until the ionide/tree-sitter-fsharp grammar is
 * integrated into the host (INFRASTRUCTURE-PLAN.md). The Rust host currently
 * bails with "F# tree-sitter grammar not yet integrated". Drive the fix via
 * /fix-bug. C# already has full syntax coverage; F# must match it.
 */

const SYNTAX_TIMEOUT_MS = 30_000;

suite('F# LSP — Document Symbols', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('returns type, module, and member symbols for an F# file', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + SYNTAX_TIMEOUT_MS);
    const domain = await openFSharpFixture('Domain.fs');
    const symbols = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          domain.uri,
        )) ?? [],
      (items) => items.length > 0,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    const names = flattenSymbolNames(symbols);
    assert.ok(names.includes('Shape'), 'document symbols must include the Shape type');
    assert.ok(names.includes('Person'), 'document symbols must include the Person record');
    assert.ok(names.includes('IAnimal'), 'document symbols must include the IAnimal interface');
  });

  test('returns module and nested function symbols', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + SYNTAX_TIMEOUT_MS);
    const library = await openFSharpFixture('Library.fs');
    const symbols = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          library.uri,
        )) ?? [],
      (items) => items.length > 0,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    const names = flattenSymbolNames(symbols);
    assert.ok(names.includes('Geometry'), 'document symbols must include the Geometry module');
    assert.ok(
      names.some((n) => n.includes('area')),
      'document symbols must include the area function',
    );
    assert.ok(names.includes('Greeter'), 'document symbols must include the Greeter class');
  });
});

suite('F# LSP — Folding Ranges', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('returns folding ranges for type and module bodies', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + SYNTAX_TIMEOUT_MS);
    const library = await openFSharpFixture('Library.fs');
    const ranges = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.FoldingRange[]>(
          'vscode.executeFoldingRangeProvider',
          library.uri,
        )) ?? [],
      (items) => items.length >= 2,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    assert.ok(ranges.length >= 2, `Library.fs must expose ≥2 folding ranges, got ${ranges.length}`);
    assert.ok(
      ranges.every((r) => r.end > r.start),
      'every folding range must span more than one line',
    );
  });
});

suite('F# LSP — Selection Ranges', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('returns expanding selection ranges from a cursor position', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + SYNTAX_TIMEOUT_MS);
    const library = await openFSharpFixture('Library.fs');
    const text = library.doc.getText();
    const position = library.doc.positionAt(text.indexOf('Math.PI'));
    const ranges = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.SelectionRange[]>(
          'vscode.executeSelectionRangeProvider',
          library.uri,
          [position],
        )) ?? [],
      (items) => items.length > 0,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    assert.ok(ranges.length > 0, 'must return at least one selection range');
    let depth = 0;
    let current: vscode.SelectionRange | undefined = ranges[0];
    while (current) {
      depth++;
      current = current.parent;
    }
    assert.ok(depth >= 2, `selection range chain must expand outward (depth ${depth})`);
  });
});

// ── Local helpers ─────────────────────────────────────────────────

function flattenSymbolNames(symbols: vscode.DocumentSymbol[]): string[] {
  const names: string[] = [];
  const walk = (list: vscode.DocumentSymbol[]): void => {
    for (const sym of list) {
      names.push(sym.name);
      if (sym.children.length > 0) {
        walk(sym.children);
      }
    }
  };
  walk(symbols);
  return names;
}
