import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  FSHARP_COLD_TIMEOUT_MS,
  fsharpFixturePath,
  openFSharpFixture,
  positionOf,
} from './fsharp-helpers';
import {
  activateRealSharpLsp,
  replaceDocumentText,
  waitForCodeActions,
  waitForResolvedCodeActions,
} from './refactor-test-helpers';
import { closeAllEditors, pollUntilResult } from './test-helpers';

// Real-LSP analyzer fixes for [ANALYZERS-FSAC-PARITY] and [ANALYZERS-FSAC-CODEFIX-INTERFACE-STUB].
const CODEFIX_FILE = 'CodeFixes.fs';
const ORIGINAL = fs.readFileSync(fsharpFixturePath(CODEFIX_FILE), 'utf8');
const IMPL_FILE = 'Implement.fs';
const IMPL_ORIGINAL = fs.readFileSync(fsharpFixturePath(IMPL_FILE), 'utf8');
const IMPL_INCOMPLETE = `module FSharpFixtures.Implement

type IShape =
    abstract member Area: unit -> float
    abstract member Name: string

type Square() =
    interface IShape
`;

interface Fixture {
  readonly doc: vscode.TextDocument;
  readonly uri: vscode.Uri;
}

suite('F# LSP — Code Fixes (FSAC parity)', defineAnalyzerFixSuite);
suite('F# LSP — Implement Interface (FSAC parity)', defineInterfaceFixSuite);

function defineAnalyzerFixSuite(): void {
  suiteSetup(activateRealSharpLsp);
  suiteTeardown(cleanupAnalyzerFixture);
  teardown(cleanupAnalyzerFixture);
  test('remove unused open lists, resolves, and deletes exactly one line', runRemoveTest);
  test('simplify name lists, resolves, and deletes only the qualifier', runSimplifyTest);
  test('both analyzer hints publish exact codes, severities, and ranges', runHintTest);
}

function defineInterfaceFixSuite(): void {
  suiteSetup(activateRealSharpLsp);
  suiteTeardown(cleanupInterfaceFixture);
  teardown(cleanupInterfaceFixture);
  test('implement interface resolves and inserts both missing members', runInterfaceTest);
}

async function runRemoveTest(this: Mocha.Context): Promise<void> {
  this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);
  const fixture = await openFSharpFixture(CODEFIX_FILE);
  const openLine = positionOf(fixture.doc, 'open System.Text').line;
  const range = fixture.doc.lineAt(openLine).range;
  const action = await inspectAction(fixture.uri, range, 'Remove unused open', false);
  assertRemoveEdit(action, fixture.uri, openLine);
  await applyRemove(fixture, action);
}

async function runSimplifyTest(this: Mocha.Context): Promise<void> {
  this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);
  const fixture = await openFSharpFixture(CODEFIX_FILE);
  const start = positionOf(fixture.doc, 'System.DateTime.MinValue');
  const range = new vscode.Range(start, start.translate(0, 'System.DateTime'.length));
  const action = await inspectAction(fixture.uri, range, 'Simplify name', false);
  assertSimplifyEdit(fixture, action);
  await applySimplify(fixture, action);
}

async function runHintTest(this: Mocha.Context): Promise<void> {
  this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);
  const fixture = await openFSharpFixture(CODEFIX_FILE);
  const diagnostics = await pollUntilResult(
    async () => vscode.languages.getDiagnostics(fixture.uri),
    hasBothAnalyzerHints,
    FSHARP_COLD_TIMEOUT_MS,
    2_000,
  );
  assertAnalyzerHints(fixture.doc, diagnostics);
}

async function runInterfaceTest(this: Mocha.Context): Promise<void> {
  this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);
  const fixture = await openFSharpFixture(IMPL_FILE);
  await replaceDocumentText(fixture.doc, IMPL_INCOMPLETE);
  assert.ok(fixture.doc.isDirty, 'incomplete interface must be an unsaved overlay');
  const start = positionOf(fixture.doc, 'interface IShape', 'interface '.length);
  const range = new vscode.Range(start, start.translate(0, 'IShape'.length));
  const action = await inspectAction(fixture.uri, range, 'Implement interface', true);
  assertInterfaceEdit(action, fixture.uri);
  await applyInterface(fixture, action);
}

async function inspectAction(
  uri: vscode.Uri,
  range: vscode.Range,
  title: string,
  preferred: boolean,
): Promise<vscode.CodeAction> {
  const query = {
    uri,
    range,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: (items: vscode.CodeAction[]) => items.some((item) => item.title === title),
    timeoutMs: FSHARP_COLD_TIMEOUT_MS,
  };
  const raw = unique(await waitForCodeActions(query), title);
  assertActionMetadata(raw, title, preferred, false);
  const resolved = unique(await waitForResolvedCodeActions(query), title);
  assertActionMetadata(resolved, title, preferred, true);
  return resolved;
}

function unique(actions: readonly vscode.CodeAction[], title: string): vscode.CodeAction {
  const matches = actions.filter((item) => item.title === title);
  assert.strictEqual(matches.length, 1, `expected one ${title}`);
  const action = matches[0];
  assert.ok(action);
  return action;
}

function assertActionMetadata(
  action: vscode.CodeAction,
  title: string,
  preferred: boolean,
  resolved: boolean,
): void {
  assert.strictEqual(action.title, title);
  assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.strictEqual(action.isPreferred, preferred);
  if (resolved) assert.ok(action.edit);
  else assert.strictEqual(action.edit, undefined);
}

function assertRemoveEdit(action: vscode.CodeAction, uri: vscode.Uri, line: number): void {
  assert.ok(action.edit);
  const edits = action.edit.get(uri);
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0]?.newText, '');
  assert.strictEqual(edits[0]?.range.start.line, line);
  assert.strictEqual(edits[0]?.range.start.character, 0);
  assert.strictEqual(edits[0]?.range.end.line, line + 1);
  assert.strictEqual(edits[0]?.range.end.character, 0);
}

async function applyRemove(fixture: Fixture, action: vscode.CodeAction): Promise<void> {
  assert.ok(action.edit);
  assert.ok(fixture.doc.getText().includes('open System.Text'));
  assert.ok(await vscode.workspace.applyEdit(action.edit));
  const after = fixture.doc.getText();
  assert.ok(!after.includes('open System.Text'));
  assert.ok(after.includes('open System\n'));
  assert.ok(after.includes('DateTime.Now'));
}

function assertSimplifyEdit(fixture: Fixture, action: vscode.CodeAction): void {
  assert.ok(action.edit);
  const edits = action.edit.get(fixture.uri);
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0]?.newText, '');
  assert.strictEqual(fixture.doc.getText(edits[0]?.range), 'System.');
  assert.ok(!edits[0]?.range.isEmpty);
}

async function applySimplify(fixture: Fixture, action: vscode.CodeAction): Promise<void> {
  assert.ok(action.edit);
  assert.ok(fixture.doc.getText().includes('System.DateTime.MinValue'));
  assert.ok(await vscode.workspace.applyEdit(action.edit));
  const after = fixture.doc.getText();
  assert.ok(after.includes('let minimum = DateTime.MinValue'));
  assert.ok(!after.includes('System.DateTime.MinValue'));
}

function hasBothAnalyzerHints(diagnostics: readonly vscode.Diagnostic[]): boolean {
  return (
    diagnostics.some((item) => codeOf(item) === 'SLSPF0102') &&
    diagnostics.some((item) => codeOf(item) === 'SLSPF0103')
  );
}

function assertAnalyzerHints(
  doc: vscode.TextDocument,
  diagnostics: readonly vscode.Diagnostic[],
): void {
  const unused = diagnostics.filter((item) => codeOf(item) === 'SLSPF0102');
  const simplify = diagnostics.filter((item) => codeOf(item) === 'SLSPF0103');
  assert.ok(unused.length >= 1);
  assert.ok(simplify.length >= 1);
  assert.ok(unused.every((item) => item.severity === vscode.DiagnosticSeverity.Hint));
  assert.ok(simplify.every((item) => item.severity === vscode.DiagnosticSeverity.Hint));
  const line = positionOf(doc, 'open System.Text').line;
  assert.ok(unused.some((item) => item.range.start.line === line));
}

function assertInterfaceEdit(action: vscode.CodeAction, uri: vscode.Uri): void {
  assert.ok(action.edit);
  const edits = action.edit.get(uri);
  assert.strictEqual(edits.length, 1);
  const text = edits[0]?.newText ?? '';
  assert.match(text, /member/);
  assert.match(text, /Area/);
  assert.match(text, /Name/);
  assert.ok(edits[0]?.range.isEmpty);
}

async function applyInterface(fixture: Fixture, action: vscode.CodeAction): Promise<void> {
  assert.ok(action.edit);
  const before = fixture.doc.getText();
  assert.ok(await vscode.workspace.applyEdit(action.edit));
  const after = fixture.doc.getText();
  assert.ok(after.length > before.length);
  assert.ok(after.includes('Area'));
  assert.ok(after.includes('Name'));
  assert.ok(after.includes('member'));
}

function codeOf(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (code === undefined || code === null) return '';
  if (typeof code === 'object') return String(code.value);
  return String(code);
}

async function cleanupAnalyzerFixture(): Promise<void> {
  fs.writeFileSync(fsharpFixturePath(CODEFIX_FILE), ORIGINAL, 'utf8');
  await revertDirtyEditors();
  await closeAllEditors();
}

async function cleanupInterfaceFixture(): Promise<void> {
  fs.writeFileSync(fsharpFixturePath(IMPL_FILE), IMPL_ORIGINAL, 'utf8');
  await revertDirtyEditors();
  await closeAllEditors();
}

async function revertDirtyEditors(): Promise<void> {
  for (const editor of vscode.window.visibleTextEditors) {
    if (!editor.document.isDirty) continue;
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}
