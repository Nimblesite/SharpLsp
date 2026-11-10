// Overlay and rename lifecycle helpers for the real-LSP suites: open an unsaved
// overlay (one or two files), aim at a token, prepare it, rename it, apply the
// edit, prove the saved/unsaved state, and undo. Shared by the F# and C# rename
// suites and the F# quick-fix suites, which all open fixtures the same way.
//
// Spec: [RENAME-FSHARP-PREPARE], [RENAME-FSHARP-APPLY], [ANALYZERS-FSAC-PARITY]
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  applyWorkspaceEdit,
  openFixtureDocument,
  preparedRenameAt,
  replaceDocumentText,
  revertDocument,
  type OpenFixture,
  type PrepareRenameResult,
  type WorkspaceEditSnapshot,
} from './refactor-test-helpers';
import { pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { fileNameOf } from '../../paths';

/** Open `relativePath` as an unsaved overlay of `source`. */
export async function openOverlay(relativePath: string, source: string): Promise<OpenFixture> {
  const fixture = await openFixtureDocument(relativePath);
  await replaceDocumentText(fixture.document, source);
  assert.strictEqual(fixture.document.getText(), source);
  assert.ok(fixture.document.isDirty, 'overlay fixture must remain unsaved');
  return fixture;
}

/** Open `relativePath` as an unsaved `source` overlay, run `body`, then revert it. */
export async function withOverlay<T>(
  relativePath: string,
  source: string,
  body: (fixture: OpenFixture) => Promise<T>,
): Promise<T> {
  const fixture = await openOverlay(relativePath, source);
  try {
    return await body(fixture);
  } finally {
    await revertDocument(fixture.document);
  }
}

/** A fixture file and the overlay source it is opened with. */
export interface OverlaySite {
  readonly path: string;
  readonly source: string;
}

/** A fixture and the exact text its overlay must hold. */
export interface OverlayText {
  readonly fixture: OpenFixture;
  readonly expected: string;
}

/** Open both overlays, run `body` on them, then revert both in reverse order. */
export async function withTwoOverlays<T>(
  first: OverlaySite,
  second: OverlaySite,
  body: (first: OpenFixture, second: OpenFixture) => Promise<T>,
): Promise<T> {
  const one = await openOverlay(first.path, first.source);
  const two = await openOverlay(second.path, second.source);
  try {
    return await body(one, two);
  } finally {
    await revertDocument(two.document);
    await revertDocument(one.document);
  }
}

/** The range of occurrence `occurrence` of `needle` in `document`. */
export function tokenRange(
  document: vscode.TextDocument,
  needle: string,
  occurrence = 0,
): vscode.Range {
  let index = -1;
  for (let current = 0; current <= occurrence; current += 1) {
    index = document.getText().indexOf(needle, index + 1);
  }
  assert.ok(index >= 0, `fixture must contain occurrence ${occurrence} of ${needle}`);
  const start = document.positionAt(index);
  return new vscode.Range(start, document.positionAt(index + needle.length));
}

/** How many times `needle` occurs in `text`. */
export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every edit in `snapshot` writes `newText` over a non-empty single line. */
export function assertCleanEdits(
  snapshot: WorkspaceEditSnapshot | undefined,
  newText: string,
): void {
  assert.ok(snapshot?.edits.every((item) => item.newText === newText));
  assert.ok(snapshot?.edits.every((item) => !item.range.isEmpty && item.range.isSingleLine));
}

/** `document` still holds exactly `expected` and is still an unsaved overlay. */
export function assertOverlayUnchanged(document: vscode.TextDocument, expected: string): void {
  assert.strictEqual(document.getText(), expected);
  assert.ok(document.isDirty, 'the overlay must stay unsaved');
}

/** Apply `edit` to `fixture`, proving the edit reached its unsaved overlay. */
export async function applyToDocument(
  fixture: OpenFixture,
  edit: vscode.WorkspaceEdit,
): Promise<void> {
  const version = fixture.document.version;
  await applyWorkspaceEdit(edit);
  assert.ok(fixture.document.version > version, 'the edit must reach the overlay');
}

/** Undo the last applied edit and prove `expectedText` is back, still unsaved. */
export async function undoAction(
  document: vscode.TextDocument,
  expectedText: string,
): Promise<void> {
  const appliedVersion = document.version;
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand('undo');
  assert.ok(document.version > appliedVersion, 'undo must advance the document version');
  assert.strictEqual(document.getText(), expectedText, 'undo must restore the overlay source');
  assert.ok(document.isDirty, 'undo must leave the original unsaved overlay active');
}

/** The workspace edit `vscode.executeDocumentRenameProvider` answers, once non-empty. */
export async function requestRename(
  uri: vscode.Uri,
  position: vscode.Position,
  newName: string,
  timeoutMs: number,
): Promise<vscode.WorkspaceEdit> {
  return pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        uri,
        position,
        newName,
      )) ?? new vscode.WorkspaceEdit(),
    (edit) => edit.size > 0,
    timeoutMs,
    2_000,
  );
}

/** The wire shape `vscode.prepareRename` answers at `position`, or `null`. */
export async function requestPrepareRename(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<PrepareRenameResult | null> {
  return preparedRenameAt(uri, position);
}

// prepareRename at `position` answers exactly `expected` and `placeholder`. [RENAME-FSHARP-PREPARE]
export async function assertPrepareRename(
  uri: vscode.Uri,
  expected: vscode.Range,
  position: vscode.Position,
  placeholder: string,
): Promise<void> {
  const prepare = await requestPrepareRename(uri, position);
  assert.ok(prepare, `${placeholder} must support prepareRename`);
  assert.strictEqual(prepare.placeholder, placeholder);
  assert.strictEqual(prepare.range.start.line, expected.start.line);
  assert.strictEqual(prepare.range.start.character, expected.start.character);
  assert.strictEqual(prepare.range.end.line, expected.end.line);
  assert.strictEqual(prepare.range.end.character, expected.end.character);
}

// Every caret offset inside the token prepares the whole token. [RENAME-FSHARP-PREPARE]
export async function assertPrepareAcrossToken(
  uri: vscode.Uri,
  range: vscode.Range,
  placeholder: string,
): Promise<void> {
  assert.ok(range.isSingleLine && !range.isEmpty);
  for (let offset = 0; offset < range.end.character - range.start.character; offset += 1) {
    await assertPrepareRename(uri, range, range.start.translate(0, offset), placeholder);
  }
}

/** A token range, and the rename of that token to `newName` issued from its first character. */
export interface TokenRename {
  readonly range: vscode.Range;
  readonly edit: vscode.WorkspaceEdit;
}

/** Prove `needle` prepares across its whole token, then rename it to `newName`. */
export async function renamePreparedToken(
  fixture: OpenFixture,
  needle: string,
  newName: string,
  occurrence = 0,
): Promise<TokenRename> {
  const range = tokenRange(fixture.document, needle, occurrence);
  await assertPrepareAcrossToken(fixture.uri, range, needle);
  const edit = await requestRename(
    fixture.uri,
    range.start.translate(0, 1),
    newName,
    LSP_RESPONSE_MS,
  );
  return { range, edit };
}

/** Every range `needle` occurs at in `document`. */
function candidateRanges(document: vscode.TextDocument, needle: string): vscode.Range[] {
  const text = document.getText();
  const ranges: vscode.Range[] = [];
  let index = text.indexOf(needle);
  while (index >= 0) {
    ranges.push(
      new vscode.Range(document.positionAt(index), document.positionAt(index + needle.length)),
    );
    index = text.indexOf(needle, index + 1);
  }
  return ranges;
}

/** `left` covers exactly `right`. */
function sameRange(left: vscode.Range, right: PrepareRenameResult['range']): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

/** Occurrence `occurrence` of `needle` that the server itself prepares as `needle`. */
export async function semanticTokenRange(
  uri: vscode.Uri,
  document: vscode.TextDocument,
  needle: string,
  occurrence = 0,
): Promise<vscode.Range> {
  const matches: vscode.Range[] = [];
  for (const candidate of candidateRanges(document, needle)) {
    const prepare = await requestPrepareRename(uri, candidate.start);
    if (prepare?.placeholder === needle && sameRange(candidate, prepare.range))
      matches.push(candidate);
  }
  const match = matches[occurrence];
  assert.ok(match, `missing semantic occurrence ${occurrence} of ${needle}`);
  return match;
}

/** How many text edits `edit` carries across all of its documents. */
export function editCount(edit: vscode.WorkspaceEdit): number {
  return edit.entries().reduce((total, [, edits]) => total + edits.length, 0);
}

/** The file names `edit` touches. */
export function changedFileNames(edit: vscode.WorkspaceEdit): string[] {
  return edit.entries().map(([uri]) => fileNameOf(uri.fsPath));
}
