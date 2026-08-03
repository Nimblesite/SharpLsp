import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  applyWorkspaceEdit,
  openFixtureDocument,
  preparedRenameAt,
  replaceDocumentText,
  waitForCodeActions,
  waitForMatchingDiagnostics,
  waitForResolvedCodeActions,
  type OpenFixture,
  type PrepareRenameResult,
  type WorkspaceEditSnapshot,
} from './refactor-test-helpers';
import { pollUntilResult } from './test-helpers';

// Assertion helpers shared by the real-LSP F# suites. [ANALYZERS-FSAC-PARITY]

export type { PrepareRenameResult } from './refactor-test-helpers';

export const FSHARP_REFACTOR_TIMEOUT_MS = 120_000;

export async function openOverlay(relativePath: string, source: string): Promise<OpenFixture> {
  const fixture = await openFixtureDocument(relativePath);
  await replaceDocumentText(fixture.document, source);
  assert.strictEqual(fixture.document.getText(), source);
  assert.ok(fixture.document.isDirty, 'overlay fixture must remain unsaved');
  return fixture;
}

export async function diagnosticWithCode(
  uri: vscode.Uri,
  code: string,
): Promise<vscode.Diagnostic[]> {
  return waitForMatchingDiagnostics(
    uri,
    (diagnostics) => diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === code),
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
}

export async function diagnosticGone(uri: vscode.Uri, code: string): Promise<vscode.Diagnostic[]> {
  return waitForMatchingDiagnostics(
    uri,
    (diagnostics) => diagnostics.every((diagnostic) => diagnosticCode(diagnostic) !== code),
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
}

export async function quickFixes(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<vscode.CodeAction[]> {
  return waitForCodeActions({
    uri,
    range,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: () => true,
    timeoutMs: FSHARP_REFACTOR_TIMEOUT_MS,
  });
}

export async function resolvedQuickFixes(
  uri: vscode.Uri,
  range: vscode.Range,
  title: string,
): Promise<vscode.CodeAction[]> {
  return waitForResolvedCodeActions({
    uri,
    range,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: (actions) => actions.some((action) => action.title === title),
    timeoutMs: FSHARP_REFACTOR_TIMEOUT_MS,
  });
}

export async function applyAction(action: vscode.CodeAction): Promise<WorkspaceEditSnapshot[]> {
  assert.ok(action.edit, `${action.title} must have an edit before application`);
  return applyWorkspaceEdit(action.edit);
}

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

function sameRange(left: vscode.Range, right: PrepareRenameResult['range']): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

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

export function uniqueAction(
  actions: readonly vscode.CodeAction[],
  title: string,
): vscode.CodeAction {
  const matches = actions.filter((action) => action.title === title);
  assert.strictEqual(matches.length, 1, `expected one ${title}; got ${matches.length}`);
  const action = matches[0];
  assert.ok(action, `${title} must exist`);
  return action;
}

export function assertQuickFix(action: vscode.CodeAction, title: string, preferred: boolean): void {
  assert.strictEqual(action.title, title);
  assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.strictEqual(action.isPreferred, preferred);
  assert.ok(action.edit, `${title} must resolve to a WorkspaceEdit`);
}

export function singleEdit(action: vscode.CodeAction, uri: vscode.Uri): vscode.TextEdit {
  assert.ok(action.edit, `${action.title} must have a resolved edit`);
  const edits = action.edit.get(uri);
  assert.strictEqual(edits.length, 1, `${action.title} must produce one edit`);
  const edit = edits[0];
  assert.ok(edit, `${action.title} edit must exist`);
  return edit;
}

export function assertInsertion(edit: vscode.TextEdit, expected: string): void {
  assert.strictEqual(edit.newText, expected);
  assert.ok(edit.range.isEmpty, 'insertion must have a zero-width range');
  assert.strictEqual(edit.range.start.line, edit.range.end.line);
  assert.strictEqual(edit.range.start.character, edit.range.end.character);
}

export function assertReplacement(
  document: vscode.TextDocument,
  edit: vscode.TextEdit,
  before: string,
  after: string,
): void {
  assert.strictEqual(document.getText(edit.range), before);
  assert.strictEqual(edit.newText, after);
  assert.ok(!edit.range.isEmpty, 'replacement must cover source text');
}

export function assertNoAction(actions: readonly vscode.CodeAction[], title: string): void {
  assert.ok(!actions.some((action) => action.title === title), `${title} must not be offered`);
}

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

export async function requestPrepareRename(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<PrepareRenameResult | null> {
  return preparedRenameAt(uri, position);
}

export function editCount(edit: vscode.WorkspaceEdit): number {
  return edit.entries().reduce((total, [, edits]) => total + edits.length, 0);
}

export function changedFileNames(edit: vscode.WorkspaceEdit): string[] {
  return edit.entries().map(([uri]) => uri.path.split('/').at(-1) ?? uri.path);
}

export function diagnosticCode(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (typeof code === 'object' && code !== null) {
    return String(code.value);
  }
  return code === undefined ? '' : String(code);
}

export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
