// Assertion library for real [SE-CONTEXT-SORT-MEMBERS] interactions.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

export const CLASS_ANCHORS: Readonly<Record<string, string>> = {
  Alpha: 'public string Alpha()',
  AlphaConstant: 'public const int AlphaConstant',
  Beta: 'public string Beta()',
  Omega: 'public string Omega',
  SortMembersCommand: 'public SortMembersCommand()',
  Zebra: 'private string Zebra()',
  _zeta: 'private readonly int _zeta',
};

interface LspRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

interface TreeNodeShape {
  readonly children: readonly TreeNodeShape[];
  readonly sortName: string;
  readonly symbolUri?: string;
  readonly symbolRange?: LspRange;
  readonly parent?: TreeNodeShape;
}

export function assertClassRange(document: vscode.TextDocument, range: LspRange): void {
  assert.strictEqual(range.start.line, 2, 'class range starts on the declaration line');
  assert.strictEqual(range.start.character, 0, 'class range starts before its public modifier');
  assert.ok(range.end.line > range.start.line, 'class range spans its body');
  assert.ok(range.end.line < document.lineCount, 'class range ends inside the live document');
  assert.ok(range.end.character >= 1, 'class range includes its closing brace');
  const text = document.getText(toRange(range));
  assert.ok(text.startsWith('public sealed class SortMembersCommand'));
  assert.ok(text.includes(CLASS_ANCHORS.AlphaConstant ?? 'missing-anchor'));
  assert.ok(text.includes(CLASS_ANCHORS.Zebra ?? 'missing-anchor'));
  assert.ok(text.trimEnd().endsWith('}'));
}

export function assertTreeChildren(node: TreeNodeShape, expected: readonly string[]): void {
  const names = node.children.map((child) => child.sortName).sort();
  assert.strictEqual(node.children.length, expected.length);
  assert.deepStrictEqual(names, [...expected].sort());
  for (const child of node.children) {
    assert.strictEqual(child.parent, node, `${child.sortName} keeps its parent link`);
    assert.strictEqual(child.symbolUri, node.symbolUri, `${child.sortName} keeps the fixture URI`);
    assert.ok(child.symbolRange, `${child.sortName} keeps a real symbol range`);
  }
}

export function assertOrderedSymbols(
  previous: vscode.DocumentSymbol | undefined,
  current: vscode.DocumentSymbol | undefined,
): void {
  assert.ok(previous && current, 'ordered symbol entries must be present');
  assert.ok(previous.range.start.isBefore(current.range.start));
}

export function assertChildSymbol(
  document: vscode.TextDocument,
  symbol: vscode.DocumentSymbol,
): void {
  assert.ok(symbol.name.length > 0, 'member symbol has a name');
  assert.ok(
    symbol.range.contains(symbol.selectionRange),
    `${symbol.name} selection stays in range`,
  );
  assert.strictEqual(document.getText(symbol.selectionRange), symbol.name);
  assert.ok(symbol.range.start.isBeforeOrEqual(symbol.range.end));
  assert.ok(symbol.selectionRange.start.isBeforeOrEqual(symbol.selectionRange.end));
  assert.ok(symbol.range.end.line < document.lineCount);
}

export function assertAnchoredOrder(
  text: string,
  expected: readonly string[],
  anchors: Readonly<Record<string, string>> = CLASS_ANCHORS,
): void {
  let previous = -1;
  for (const name of expected) {
    const anchor = anchors[name];
    assert.ok(anchor, `${name} must have an assertion anchor`);
    const current = text.indexOf(anchor);
    assert.ok(current >= 0, `${name} declaration must remain present`);
    assert.ok(current > previous, `${name} must follow the preceding sorted member`);
    previous = current;
  }
}

export function assertDecorations(text: string): void {
  const comment = text.indexOf('helper must travel with its attribute.');
  const attribute = text.indexOf('[System.Obsolete("private-helper")]');
  const zebra = text.indexOf(CLASS_ANCHORS.Zebra ?? 'missing-anchor');
  const documentation = text.indexOf('/// <summary>Second public method.</summary>');
  const beta = text.indexOf(CLASS_ANCHORS.Beta ?? 'missing-anchor');
  assert.ok(comment >= 0 && attribute >= 0 && zebra >= 0);
  assert.ok(documentation >= 0 && beta >= 0);
  assert.ok(comment < attribute && attribute < zebra, 'comment and attribute travel with Zebra');
  assert.ok(documentation < beta, 'documentation travels with Beta');
  assert.strictEqual(occurrences(text, '[System.Obsolete("private-helper")]'), 1);
  assert.strictEqual(occurrences(text, '/// <summary>Second public method.</summary>'), 1);
}

export function assertBodySentinels(text: string): void {
  for (const value of ['ALPHA', 'BETA']) {
    assert.ok(text.includes(`return "${value}";`), `${value} body must survive`);
    assert.strictEqual(occurrences(text, `return "${value}";`), 1);
  }
  const zebra = text.includes('LIVE-ZEBRA') ? 'LIVE-ZEBRA' : 'ZEBRA';
  assert.ok(text.includes(`return "${zebra}";`), `${zebra} body must survive`);
  assert.strictEqual(occurrences(text, `return "${zebra}";`), 1);
  assert.ok(text.includes('= "OMEGA";'));
  assert.ok(text.includes('_zeta = 7;') || text.includes('_zeta = 99;'));
  assert.ok(text.includes('AlphaConstant = 1;'));
}

export function assertBlankLineBetween(text: string, left: string, right: string): void {
  const leftIndex = text.indexOf(CLASS_ANCHORS[left] ?? 'missing-anchor');
  const rightIndex = text.indexOf(CLASS_ANCHORS[right] ?? 'missing-anchor');
  assert.ok(leftIndex >= 0 && rightIndex >= 0);
  assert.ok(leftIndex < rightIndex, `${left} must precede ${right}`);
  const between = text.slice(leftIndex, rightIndex);
  assert.match(between, /\r?\n\s*\r?\n/, `${left}/${right} groups need a blank separator`);
}

export function assertLiveSentinels(text: string): void {
  assert.ok(text.includes('return "LIVE-ZEBRA";'));
  assert.ok(text.includes('_zeta = 99;'));
  assert.ok(text.includes('Unsaved helper must travel'));
  assert.ok(!text.includes('return "ZEBRA";'));
  assert.ok(!text.includes('_zeta = 7;'));
  assert.strictEqual(occurrences(text, 'LIVE-ZEBRA'), 1);
  assert.strictEqual(occurrences(text, '_zeta = 99'), 1);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function toRange(range: LspRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}
