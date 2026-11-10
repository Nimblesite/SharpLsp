// Protocol invariants every LSP reply must satisfy, whatever the fixture.
//
// Spec: LSP 3.17 `textDocument/documentSymbol`, `foldingRange`,
// `selectionRange`, `completion`, `textDocument/hover`; [SHARPLSP-ARCHITECTURE-ROUTING],
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
import {
  flattenSymbolNames,
  openCSharpFile,
  openCSharpOutline,
  openExistingFile,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  waitForSelectionRanges,
} from './test-helpers';

/** The last position in a document — the end of its final line. */
export function documentEnd(document: vscode.TextDocument): vscode.Position {
  return document.lineAt(Math.max(document.lineCount - 1, 0)).range.end;
}

/** Assert each named symbol carries the given kind and a selectionRange over its own identifier. */
export function assertSymbolKinds(
  symbols: readonly vscode.DocumentSymbol[],
  document: vscode.TextDocument,
  expectations: readonly (readonly [string, vscode.SymbolKind])[],
): void {
  for (const [name, kind] of expectations) {
    assertSymbolShape(symbolNamed(symbols, name), kind, document);
  }
}

/** Assert the flattened outline names every entry of `required`, reporting the missing name. */
export function assertNamesAll(names: readonly string[], required: readonly string[]): void {
  for (const name of required) assert.ok(names.includes(name), `Should find ${name}`);
}

/** Assert every named symbol carries its kind, then that the whole outline obeys LSP 3.17. */
export function assertOutlineKinds(
  symbols: readonly vscode.DocumentSymbol[],
  document: vscode.TextDocument,
  expectations: readonly (readonly [string, vscode.SymbolKind])[],
): void {
  assertSymbolTree(symbols, document);
  assertSymbolKinds(symbols, document, expectations);
}

/** Create a C# buffer, await its folding ranges, and assert at least `min` well-formed ones. */
export async function foldingRangesFor(
  tmpDir: string,
  filename: string,
  content: string,
  min: number,
  why: string,
): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument; ranges: vscode.FoldingRange[] }> {
  const { uri, doc } = await openCSharpFile(tmpDir, filename, content);
  const ranges = await waitForFoldingRanges(uri);
  assert.ok(ranges.length >= min, `${why}, got ${ranges.length}`);
  assertFoldingRanges(ranges, doc);
  return { uri, doc, ranges };
}

/** The number of buffer lines currently visible in the editor. */
export function visibleLines(editor: vscode.TextEditor): number {
  return editor.visibleRanges.reduce(
    (sum, range) => sum + range.end.line - range.start.line + 1,
    0,
  );
}

/** Fold the whole buffer and assert that hides lines; returns the folded line count. */
export async function assertFoldAllHidesLines(
  editor: vscode.TextEditor,
  why: string,
): Promise<number> {
  const before = visibleLines(editor);
  await vscode.commands.executeCommand('editor.foldAll');
  const folded = visibleLines(editor);
  assert.ok(folded < before, `${why}: ${before} -> ${folded}`);
  return folded;
}

/** Fold the whole buffer, assert that hides lines, unfold, and assert every line comes back. */
export async function assertFoldCycle(editor: vscode.TextEditor, why: string): Promise<void> {
  const before = visibleLines(editor);
  await assertFoldAllHidesLines(editor, why);
  await vscode.commands.executeCommand('editor.unfoldAll');
  assert.strictEqual(visibleLines(editor), before, 'unfolding must restore every line');
}

/** Create a C# buffer, expand the selection at `caret`, and return the asserted chain with its depth. */
export async function selectionChainFor(
  tmpDir: string,
  filename: string,
  content: string,
  caret: vscode.Position,
): Promise<{ doc: vscode.TextDocument; chain: vscode.SelectionRange; depth: number }> {
  const { uri, doc } = await openCSharpFile(tmpDir, filename, content);
  const ranges = await waitForSelectionRanges(uri, [caret]);
  assert.ok(ranges.length > 0, 'Should return at least one selection range');
  const chain = ranges[0];
  assert.ok(chain, 'the chain must be readable');
  return { doc, chain, depth: assertSelectionChain(chain, caret, doc) };
}

/** Create a C# buffer with the caret at `line:character` and return its asserted chain. */
export async function selectionChainAt(
  tmpDir: string,
  filename: string,
  content: string,
  line: number,
  character: number,
): Promise<{ doc: vscode.TextDocument; chain: vscode.SelectionRange; depth: number }> {
  return selectionChainFor(tmpDir, filename, content, new vscode.Position(line, character));
}

/** The text of every level of a selection chain, innermost first. */
export function selectionChainTexts(
  chain: vscode.SelectionRange,
  document: vscode.TextDocument,
): string[] {
  const texts: string[] = [];
  for (let current: vscode.SelectionRange | undefined = chain; current; current = current.parent) {
    texts.push(document.getText(current.range));
  }
  return texts;
}

/** Run the outline provider and assert it reports no symbols; returns the (asserted empty) list. */
export async function assertOutlineEmpty(
  uri: vscode.Uri,
  why: string,
): Promise<vscode.DocumentSymbol[]> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    uri,
  );
  assert.strictEqual(symbols?.length ?? 0, 0, why);
  return symbols ?? [];
}

/** Create a C# buffer, await its outline, and assert `name` is among the symbols; returns the tree. */
export async function outlineNamed(
  tmpDir: string,
  filename: string,
  content: string,
  name: string,
  why: string,
): Promise<{
  doc: vscode.TextDocument;
  symbols: vscode.DocumentSymbol[];
  symbol: vscode.DocumentSymbol;
}> {
  const { doc, symbols } = await openCSharpOutline(tmpDir, filename, content);
  assert.ok(flattenSymbolNames(symbols).includes(name), why);
  assertSymbolTree(symbols, doc);
  return { doc, symbols, symbol: symbolNamed(symbols, name) };
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

/**
 * The DIRECT child of `parent` (a symbol, or the outline's root list) named
 * `name`, asserted to exist — and to be `kind`, when given. Nesting is the
 * claim: a type the outline hoisted to the wrong level fails here.
 */
export function childNamed(
  parent: vscode.DocumentSymbol | readonly vscode.DocumentSymbol[],
  name: string,
  kind?: vscode.SymbolKind,
): vscode.DocumentSymbol {
  const [children, owner] =
    'children' in parent ? [parent.children, `'${parent.name}'`] : [parent, 'the outline root'];
  const found = children.find((symbol) => symbol.name === name);
  assert.ok(found, `'${name}' must be a direct child of ${owner}`);
  if (kind !== undefined) {
    assert.strictEqual(
      found.kind,
      kind,
      `'${name}' must be ${vscode.SymbolKind[kind]}, got ${vscode.SymbolKind[found.kind]}`,
    );
  }
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
 * Asserts each (symbol, kind) pair via {@link assertSymbolShape} and the whole
 * reply via {@link assertSymbolTree} — the kinds-and-containment bundle every
 * outline fixture re-asserts after opening its document.
 */
export function assertSymbolShapesAndTree(
  symbols: readonly vscode.DocumentSymbol[],
  document: vscode.TextDocument,
  pairs: readonly (readonly [vscode.DocumentSymbol, vscode.SymbolKind])[],
): void {
  for (const [symbol, kind] of pairs) assertSymbolShape(symbol, kind, document);
  assertSymbolTree(symbols, document);
}

/** Open a committed fixture and return its outline with the flattened symbol names. */
export async function existingOutline(
  directory: string,
  filename: string,
): Promise<{
  uri: vscode.Uri;
  doc: vscode.TextDocument;
  symbols: vscode.DocumentSymbol[];
  names: string[];
}> {
  const { uri, doc } = await openExistingFile(directory, filename);
  const symbols = await waitForDocumentSymbols(uri);
  return { uri, doc, symbols, names: flattenSymbolNames(symbols) };
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
    assert.ok(!seen.has(key), `${where} is reported twice`);
    seen.add(key);
  }
}

/** Assert a `#region` range opens on the region directive and closes on the endregion one. */
export function assertRegionDelimited(
  document: vscode.TextDocument,
  range: vscode.FoldingRange,
): void {
  const where = `region range ${String(range.start)}–${String(range.end)}`;
  assert.ok(
    document.lineAt(range.start).text.includes('#region'),
    `${where} must start on a #region directive`,
  );
  assert.ok(
    document.lineAt(range.end).text.includes('#endregion'),
    `${where} must end on an #endregion directive`,
  );
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
    assert.ok(
      !parent.range.isEqual(current.range),
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
