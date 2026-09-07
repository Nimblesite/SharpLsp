// Protocol invariants every LSP reply must satisfy, whatever the fixture.
//
// Spec: LSP 3.17 `textDocument/documentSymbol`, `foldingRange`,
// `selectionRange`, `completion`; [SHARPLSP-ARCHITECTURE-ROUTING],
// [SHARPLSP-FEATURES-NAVIGATION], [SHARPLSP-FEATURES-INTELLIGENCE],
// [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
//
// "The name I expected is in the list" is the weakest thing a reply can be
// asked. A documentSymbol reply that names `Foo` and hands back a range past
// the end of the buffer, a selectionRange chain that does not contain the
// caret, or a completion item with no `textEdit` all pass a name check and all
// break the editor. The invariants below are the ones the protocol guarantees,
// so every suite can assert them against every reply it already fetched — no
// extra round trip, no fixture-specific expectation.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/** The last position in a document — the end of its final line. */
export function documentEnd(document: vscode.TextDocument): vscode.Position {
  return document.lineAt(Math.max(document.lineCount - 1, 0)).range.end;
}

/**
 * Every invariant LSP 3.17 states about a `DocumentSymbol` tree, asserted
 * recursively.
 *
 * `selectionRange` must be contained in `range`, `range` must lie inside the
 * document, and a child must lie inside its parent. A tree that violates any of
 * them breaks breadcrumbs and the outline view even though every name is right.
 */
export function assertSymbolTree(
  symbols: readonly vscode.DocumentSymbol[],
  document: vscode.TextDocument,
): number {
  const end = documentEnd(document);
  let counted = 0;
  const walk = (nodes: readonly vscode.DocumentSymbol[], parent?: vscode.DocumentSymbol): void => {
    for (const symbol of nodes) {
      counted += 1;
      const where = `${document.uri.fsPath}: symbol '${symbol.name}'`;
      assert.ok(symbol.name.length > 0, `${where} must be named`);
      assert.strictEqual(symbol.name, symbol.name.trim(), `${where} must not be padded`);
      assert.ok(
        symbol.range.contains(symbol.selectionRange),
        `${where} selectionRange must sit inside range (LSP 3.17)`,
      );
      assert.ok(
        symbol.range.end.isBeforeOrEqual(end),
        `${where} range must not run past the end of the document`,
      );
      assert.ok(
        symbol.range.start.isBeforeOrEqual(symbol.range.end),
        `${where} range must not be inverted`,
      );
      if (parent) {
        assert.ok(
          parent.range.contains(symbol.range),
          `${where} must sit inside its parent '${parent.name}'`,
        );
      }
      walk(symbol.children, symbol);
    }
  };
  walk(symbols);
  return counted;
}

/** The symbol with this name, anywhere in the tree, asserted to exist. */
export function symbolNamed(
  symbols: readonly vscode.DocumentSymbol[],
  name: string,
): vscode.DocumentSymbol {
  const found = findSymbol(symbols, name);
  assert.ok(found, `the outline must contain '${name}'`);
  return found;
}

function findSymbol(
  symbols: readonly vscode.DocumentSymbol[],
  name: string,
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.name === name) return symbol;
    const nested = findSymbol(symbol.children, name);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Assert a symbol's kind AND that its `selectionRange` really covers its own
 * identifier in the buffer.
 *
 * The kind drives the outline icon and the breadcrumb; the selection range is
 * what "Go to Symbol" jumps to. A symbol whose selectionRange lands on the
 * wrong token navigates the user somewhere else entirely.
 */
export function assertSymbolShape(
  symbol: vscode.DocumentSymbol,
  kind: vscode.SymbolKind,
  document: vscode.TextDocument,
): void {
  assert.strictEqual(
    symbol.kind,
    kind,
    `'${symbol.name}' must be ${vscode.SymbolKind[kind]}, got ${vscode.SymbolKind[symbol.kind]}`,
  );
  const selected = document.getText(symbol.selectionRange);
  assert.ok(
    selected.includes(lastSegment(symbol.name)),
    `'${symbol.name}' selectionRange must cover its own identifier, covers '${selected}'`,
  );
  assert.ok(
    symbol.selectionRange.start.line === symbol.selectionRange.end.line,
    `'${symbol.name}' identifier must not straddle a line break`,
  );
}

function lastSegment(name: string): string {
  const bare = name.split('(')[0] ?? name;
  return bare.split('.').pop() ?? bare;
}

/**
 * Every invariant a `foldingRange` reply must satisfy.
 *
 * A range that ends before it starts, runs past the last line, or repeats
 * another range gives the gutter a chevron that folds nothing or folds twice.
 */
export function assertFoldingRanges(
  ranges: readonly vscode.FoldingRange[],
  document: vscode.TextDocument,
): void {
  const seen = new Set<string>();
  for (const range of ranges) {
    const where = `folding range ${range.start}-${range.end}`;
    assert.ok(range.end > range.start, `${where} must span more than one line to be foldable`);
    assert.ok(range.start >= 0, `${where} must start inside the document`);
    assert.ok(
      range.end < document.lineCount,
      `${where} must end inside the document (${document.lineCount} lines)`,
    );
    const key = `${range.start}:${range.end}:${String(range.kind)}`;
    assert.strictEqual(seen.has(key), false, `${where} is reported twice`);
    seen.add(key);
  }
}

/**
 * A `selectionRange` chain, walked outward.
 *
 * The innermost range must contain the caret and every parent must STRICTLY
 * contain its child — a chain with a repeated range makes the shrink/expand
 * keybinding stall on a level that never changes the selection.
 *
 * Returns the depth so a caller can assert how far the chain reaches.
 */
export function assertSelectionChain(
  chain: vscode.SelectionRange,
  caret: vscode.Position,
  document: vscode.TextDocument,
): number {
  assert.ok(chain.range.contains(caret), 'the innermost selection range must contain the caret');
  let depth = 1;
  let current = chain;
  while (current.parent) {
    const parent = current.parent;
    assert.ok(
      parent.range.contains(current.range),
      `selection level ${depth} must sit inside level ${depth + 1}`,
    );
    assert.strictEqual(
      parent.range.isEqual(current.range),
      false,
      `selection level ${depth + 1} must be STRICTLY larger, or expand-selection stalls`,
    );
    current = parent;
    depth += 1;
  }
  assert.ok(
    current.range.end.isBeforeOrEqual(documentEnd(document)),
    'the outermost selection range must stay inside the document',
  );
  assert.ok(
    current.range.start.isBeforeOrEqual(chain.range.start),
    'the outermost range must start at or before the innermost one',
  );
  return depth;
}

/**
 * Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
 *
 * Every item must carry an explicit edit range covering the identifier span AT
 * the caret. Without one the editor falls back to its own word-boundary
 * heuristic, which appends after a member-access trigger and duplicates the
 * identifier — `Console.WriteLineWriteLine` (GitHub #178).
 */
export function assertCompletionEditSpans(
  items: readonly vscode.CompletionItem[],
  caret: vscode.Position,
): void {
  assert.ok(items.length > 0, 'a completion list with no items cannot carry edit semantics');
  for (const item of items) {
    const label = item.label.toString();
    const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing;
    assert.ok(range, `'${label}' must carry an explicit textEdit range, not a bare insertText`);
    assert.strictEqual(
      range.start.line,
      caret.line,
      `'${label}' edit must stay on the caret's line`,
    );
    assert.ok(
      range.start.character <= caret.character,
      `'${label}' edit must start at or before the caret`,
    );
    assert.ok(
      range.end.character >= caret.character,
      `'${label}' edit must reach the caret, or accepting it duplicates the typed prefix`,
    );
  }
}
