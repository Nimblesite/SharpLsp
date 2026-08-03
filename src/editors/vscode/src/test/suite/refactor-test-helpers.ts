// Shared real-LSP interaction harness for [SHARPLSP-FEATURES-REFACTORING].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import {
  EXTENSION_ID,
  LSP_RESPONSE_TIMEOUT_MS,
  SERVER_START_TIMEOUT_MS,
  comparableText,
  pollUntilResult,
} from './test-helpers';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../test-fixtures/workspace');
const RESOLVE_COUNT = 1_000;
const POLL_INTERVAL_MS = 1_000;

interface SharpLspApi {
  readonly getLspClient: () => LanguageClient | undefined;
}

export interface CodeActionQuery {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
  readonly predicate: (actions: vscode.CodeAction[]) => boolean;
  readonly kind?: vscode.CodeActionKind;
  readonly timeoutMs?: number;
}

export interface OpenFixture {
  readonly document: vscode.TextDocument;
  readonly editor: vscode.TextEditor;
  readonly uri: vscode.Uri;
}

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/** Wire shape returned by textDocument/prepareRename. */
export interface PrepareRenameResult {
  readonly range: LspRange;
  readonly placeholder: string;
}

/** Shape VS Code's own `vscode.prepareRename` command resolves to. */
export interface UiPrepareRename {
  readonly range: vscode.Range;
  readonly placeholder: string;
}

export interface WorkspaceEditSnapshot {
  readonly uri: vscode.Uri;
  readonly document?: vscode.TextDocument;
  readonly edits: readonly vscode.TextEdit[];
  readonly textBefore: string;
  readonly replacedText: readonly string[];
}

/** Activate the shipped extension and prove its real LanguageClient is running. */
export async function activateRealSharpLsp(): Promise<LanguageClient> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the real VS Code test host`);
  const api = (await extension.activate()) as SharpLspApi;
  const client = api.getLspClient();
  assert.ok(client, 'SharpLsp activation must expose a real LanguageClient');
  const state = await waitForRunningState(client);
  assert.strictEqual(state, State.Running, 'the real SharpLsp LanguageClient must be running');
  return client;
}

async function waitForRunningState(client: LanguageClient): Promise<State> {
  return pollUntilResult(
    async () => client.state,
    (state) => state === State.Running,
    SERVER_START_TIMEOUT_MS,
    250,
  );
}

/** Send a request through the activated real LanguageClient. */
export async function sendRealLspRequest<T>(method: string, params: unknown): Promise<T> {
  const client = await activateRealSharpLsp();
  return client.sendRequest<T>(method, params);
}

/** Drive VS Code's real F2 prepare-rename command; undefined when the editor refuses. */
export async function uiPrepareRename(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<UiPrepareRename | undefined> {
  try {
    return await vscode.commands.executeCommand<UiPrepareRename | undefined>(
      'vscode.prepareRename',
      uri,
      position,
    );
  } catch (error: unknown) {
    assert.ok(String(error).length > 0, 'a refused rename must carry an explanatory error');
    return undefined;
  }
}

/**
 * Ask the real server for prepareRename and prove VS Code's own F2 UI command agrees.
 * Both language kits share this so the protocol and the editor can never drift apart.
 */
export async function preparedRenameAt(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<PrepareRenameResult | null> {
  const raw = await sendRealLspRequest<PrepareRenameResult | null>('textDocument/prepareRename', {
    textDocument: { uri: uri.toString() },
    position: { line: position.line, character: position.character },
  });
  assertUiAgreesWithProtocol(await uiPrepareRename(uri, position), raw, uri);
  return raw;
}

function assertUiAgreesWithProtocol(
  ui: UiPrepareRename | undefined,
  raw: PrepareRenameResult | null,
  uri: vscode.Uri,
): void {
  const where = uri.fsPath;
  if (raw === null) {
    assert.strictEqual(
      ui,
      undefined,
      `VS Code must also refuse F2 where the server does: ${where}`,
    );
    return;
  }
  assert.ok(ui, `VS Code F2 must allow the rename the server allows: ${where}`);
  assert.strictEqual(
    ui.placeholder,
    raw.placeholder,
    `F2 placeholder must match protocol: ${where}`,
  );
  assert.deepStrictEqual(
    { start: lspPosition(ui.range.start), end: lspPosition(ui.range.end) },
    raw.range,
    `F2 rename range must match protocol: ${where}`,
  );
}

function lspPosition(position: vscode.Position): LspPosition {
  return { line: position.line, character: position.character };
}

/** Poll the real VS Code code-action provider without resolving returned actions. */
export async function waitForCodeActions(query: CodeActionQuery): Promise<vscode.CodeAction[]> {
  return waitForActions(query, undefined);
}

/** Poll the real provider and force VS Code to drive codeAction/resolve. */
export async function waitForResolvedCodeActions(
  query: CodeActionQuery,
): Promise<vscode.CodeAction[]> {
  return waitForActions(query, RESOLVE_COUNT);
}

async function waitForActions(
  query: CodeActionQuery,
  resolveCount: number | undefined,
): Promise<vscode.CodeAction[]> {
  const actions = await pollUntilResult(
    async () => requestCodeActions(query, resolveCount),
    query.predicate,
    query.timeoutMs ?? LSP_RESPONSE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  assert.ok(
    query.predicate(actions),
    `code actions never became ready for ${query.uri.fsPath}; offered: ${describeActions(actions)}`,
  );
  return actions;
}

/** Name every action the server really offered, so a miss says what it got instead. */
function describeActions(actions: readonly vscode.CodeAction[]): string {
  if (actions.length === 0) return '(none)';
  return actions.map((action) => `${action.kind?.value ?? 'nokind'}::${action.title}`).join(' | ');
}

async function requestCodeActions(
  query: CodeActionQuery,
  resolveCount: number | undefined,
): Promise<vscode.CodeAction[]> {
  return (
    (await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      query.uri,
      query.range,
      query.kind?.value,
      resolveCount,
    )) ?? []
  );
}

/** Poll diagnostics and fail explicitly when the requested state never appears. */
export async function waitForMatchingDiagnostics(
  uri: vscode.Uri,
  predicate: (diagnostics: vscode.Diagnostic[]) => boolean,
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
): Promise<vscode.Diagnostic[]> {
  const diagnostics = await pollUntilResult(
    async () => vscode.languages.getDiagnostics(uri),
    predicate,
    timeoutMs,
    POLL_INTERVAL_MS,
  );
  assert.ok(
    predicate(diagnostics),
    `diagnostics never reached the requested state for ${uri.fsPath}`,
  );
  return diagnostics;
}

/** Validate every text edit, returning the exact pre-application source snapshots. */
export async function assertWorkspaceEditSafe(
  workspaceEdit: vscode.WorkspaceEdit,
): Promise<WorkspaceEditSnapshot[]> {
  assert.ok(workspaceEdit.size > 0, 'WorkspaceEdit must affect at least one resource');
  const entries = workspaceEdit.entries();
  assert.ok(entries.length > 0, 'WorkspaceEdit must contain inspectable text edits');
  return Promise.all(entries.map(async (entry) => snapshotEntry(entry)));
}

async function snapshotEntry([uri, edits]: [
  vscode.Uri,
  vscode.TextEdit[],
]): Promise<WorkspaceEditSnapshot> {
  assert.strictEqual(
    uri.scheme,
    'file',
    `WorkspaceEdit target must be a file URI: ${uri.toString()}`,
  );
  assert.ok(edits.length > 0, `WorkspaceEdit entry must contain edits: ${uri.fsPath}`);
  const document = await openExistingDocument(uri);
  if (document === undefined) return snapshotNewFile(uri, edits);
  assertEditsSafe(document, edits);
  return snapshotExistingFile(uri, document, edits);
}

async function openExistingDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    await vscode.workspace.fs.stat(uri);
    return await vscode.workspace.openTextDocument(uri);
  } catch (error: unknown) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return undefined;
    throw error;
  }
}

function snapshotNewFile(uri: vscode.Uri, edits: vscode.TextEdit[]): WorkspaceEditSnapshot {
  const origin = new vscode.Position(0, 0);
  assert.ok(
    edits.every((edit) => edit.range.start.isEqual(origin) && edit.range.end.isEqual(origin)),
    `edits for a new file must insert at 0:0: ${uri.fsPath}`,
  );
  return { uri, edits, textBefore: '', replacedText: edits.map(() => '') };
}

function snapshotExistingFile(
  uri: vscode.Uri,
  document: vscode.TextDocument,
  edits: vscode.TextEdit[],
): WorkspaceEditSnapshot {
  return {
    uri,
    document,
    edits,
    textBefore: document.getText(),
    replacedText: edits.map((edit) => document.getText(edit.range)),
  };
}

function assertEditsSafe(document: vscode.TextDocument, edits: vscode.TextEdit[]): void {
  const documentEnd = document.positionAt(document.getText().length);
  for (const edit of edits) assertRangeSafe(edit.range, documentEnd, document.uri);
  const ordered = [...edits].sort(compareEdits);
  for (let index = 1; index < ordered.length; index += 1) {
    assertSeparatedEdits(ordered[index - 1], ordered[index], document.uri);
  }
}

function assertRangeSafe(range: vscode.Range, documentEnd: vscode.Position, uri: vscode.Uri): void {
  assert.ok(range.start.isBeforeOrEqual(range.end), `edit range is reversed: ${uri.fsPath}`);
  assert.ok(range.end.isBeforeOrEqual(documentEnd), `edit range exceeds document: ${uri.fsPath}`);
}

function compareEdits(left: vscode.TextEdit, right: vscode.TextEdit): number {
  return left.range.start.compareTo(right.range.start);
}

function assertSeparatedEdits(
  previous: vscode.TextEdit | undefined,
  current: vscode.TextEdit | undefined,
  uri: vscode.Uri,
): void {
  assert.ok(previous && current, `edit ordering must be complete: ${uri.fsPath}`);
  assert.ok(
    previous.range.end.isBeforeOrEqual(current.range.start) &&
      !previous.range.isEqual(current.range),
    `WorkspaceEdit contains overlapping edits: ${uri.fsPath}`,
  );
}

/** Validate and apply a WorkspaceEdit through VS Code's real workspace model. */
export async function applyWorkspaceEdit(
  workspaceEdit: vscode.WorkspaceEdit,
): Promise<WorkspaceEditSnapshot[]> {
  const snapshots = await assertWorkspaceEditSafe(workspaceEdit);
  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  assert.ok(applied, 'VS Code must apply the resolved WorkspaceEdit');
  return snapshots;
}

/** Open a committed real-project fixture in a visible editor. */
export async function openFixtureDocument(relativePath: string): Promise<OpenFixture> {
  const uri = vscode.Uri.file(workspaceFixturePath(relativePath));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  return { document, editor, uri };
}

export function workspaceFixturePath(relativePath: string): string {
  return path.join(FIXTURE_ROOT, relativePath);
}

/** Replace the entire live buffer and assert the VFS-visible document changed. */
export async function replaceDocumentText(
  document: vscode.TextDocument,
  text: string,
): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const previousVersion = document.version;
  const applied = await editor.edit((builder) => {
    builder.replace(fullDocumentRange(document), text);
  });
  assert.ok(applied, `document replacement must apply: ${document.uri.fsPath}`);
  assert.ok(document.version > previousVersion, 'document replacement must advance its version');
  assert.strictEqual(comparableText(document.getText()), comparableText(text));
  return editor;
}

/** Drive VS Code's real undo stack and wait until the live buffer reaches the expected text. */
export async function runEditorHistory(
  document: vscode.TextDocument,
  command: 'undo' | 'redo',
  expectedText: string,
): Promise<void> {
  await vscode.window.showTextDocument(document, { preview: false });
  const previousVersion = document.version;
  await assert.doesNotReject(async () => vscode.commands.executeCommand(command));
  await waitForDocumentText(document, expectedText);
  assert.ok(document.version > previousVersion, `${command} must advance the document version`);
  assert.ok(document.isDirty, `${command} must preserve the unsaved source overlay`);
}

async function waitForDocumentText(
  document: vscode.TextDocument,
  expectedText: string,
): Promise<void> {
  const text = await pollUntilResult(
    async () => document.getText(),
    (candidate) => comparableText(candidate) === comparableText(expectedText),
    LSP_RESPONSE_TIMEOUT_MS,
    100,
  );
  assert.strictEqual(comparableText(text), comparableText(expectedText));
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    document.positionAt(document.getText().length),
  );
}

/** Revert a dirty file through the editor, restoring the committed fixture. */
export async function revertDocument(document: vscode.TextDocument): Promise<void> {
  if (!document.isDirty) return;
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand('workbench.action.files.revert');
  assert.ok(!document.isDirty, `document must be clean after revert: ${document.uri.fsPath}`);
}
