import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { OpenFixture } from './refactor-test-helpers';

// Locating what a test asserts on: a diagnostic's code, and a snippet's
// position or range in a live document. [SHARPLSP-FEATURES-REFACTORING]

export function diagnosticCode(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (typeof code === 'object' && code !== null) return String(code.value);
  return code === undefined ? '' : String(code);
}

function nthIndex(source: string, needle: string, occurrence: number): number {
  let index = -1;
  for (let count = 0; count <= occurrence; count += 1) {
    index = source.indexOf(needle, index + 1);
    if (index < 0) break;
  }
  assert.notStrictEqual(index, -1, `missing occurrence ${occurrence} of ${needle}`);
  return index;
}

export function positionOf(
  document: vscode.TextDocument,
  snippet: string,
  focus: string = snippet,
  occurrence = 0,
): vscode.Position {
  const snippetIndex = nthIndex(document.getText(), snippet, occurrence);
  const focusIndex = snippet.indexOf(focus);
  assert.notStrictEqual(focusIndex, -1, `missing focus ${focus} in ${snippet}`);
  return document.positionAt(snippetIndex + focusIndex);
}

export function rangeOf(
  document: vscode.TextDocument,
  snippet: string,
  focus: string = snippet,
  occurrence = 0,
): vscode.Range {
  const start = positionOf(document, snippet, focus, occurrence);
  // Measured through the DOCUMENT, not by translating columns: a focus that
  // spans lines — the selection over the fields a constructor is generated
  // from, say — ends on a different line, and `translate(0, n)` would run off
  // the end of the first one.
  const end = document.positionAt(document.offsetAt(start) + focus.length);
  return new vscode.Range(start, end);
}

export function rangeAfterAction(
  fixture: OpenFixture,
  original: vscode.Range,
  snippet?: string,
  focus?: string,
): vscode.Range {
  return snippet ? rangeOf(fixture.document, snippet, focus ?? snippet) : original;
}
