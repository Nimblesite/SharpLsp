import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  applyWorkspaceEdit,
  replaceDocumentText,
  revertDocument,
  sendRealLspRequest,
  waitForCodeActions,
  waitForResolvedCodeActions,
  type OpenFixture,
} from './refactor-test-helpers';

export interface RawCodeAction {
  readonly title: string;
  readonly kind?: string;
  readonly isPreferred?: boolean;
  readonly data?: { readonly id?: number; readonly uri?: string };
  readonly edit?: unknown;
}

export interface ActionLifecycleCase {
  readonly label: string;
  readonly source: string;
  readonly snippet: string;
  readonly focus: string;
  readonly title: string;
  readonly kind: string;
  readonly options?: readonly string[];
  readonly outsideSnippet?: string;
  readonly presentAfter: readonly string[];
  readonly absentAfter: readonly string[];
  readonly patternsAfter?: readonly RegExp[];
}

export function codeOf(diagnostic: vscode.Diagnostic): string {
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
  return new vscode.Range(start, start.translate(0, focus.length));
}

function toLspRange(range: vscode.Range): unknown {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

export async function rawCodeActions(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<RawCodeAction[]> {
  const result = await sendRealLspRequest<RawCodeAction[] | null>('textDocument/codeAction', {
    textDocument: { uri: uri.toString() },
    range: toLspRange(range),
    context: { diagnostics: [] },
  });
  assert.ok(Array.isArray(result), 'the real LSP must return a code-action array');
  return result;
}

export function onlyAction(
  actions: readonly vscode.CodeAction[],
  title: string,
): vscode.CodeAction {
  const matches = actions.filter((action) => action.title === title);
  assert.strictEqual(matches.length, 1, `expected exactly one action titled ${title}`);
  const action = matches[0];
  assert.ok(action, `missing action titled ${title}`);
  return action;
}

export function assertRawActionData(actions: readonly RawCodeAction[], uri: vscode.Uri): void {
  const ids = actions.map((action) => action.data?.id);
  assert.ok(ids.every((id) => Number.isInteger(id) && (id ?? 0) > 0));
  assert.strictEqual(new Set(ids).size, ids.length, 'every action data id must be unique');
  assert.ok(actions.every((action) => action.data?.uri === uri.toString()));
  assert.ok(actions.every((action) => typeof action.isPreferred === 'boolean'));
}

export function assertRawTitles(
  actions: readonly RawCodeAction[],
  titles: readonly string[],
  kind: string,
): void {
  for (const title of titles) {
    const matches = actions.filter((action) => action.title === title);
    assert.strictEqual(matches.length, 1, `expected exactly one raw action titled ${title}`);
    assert.strictEqual(matches[0]?.kind, kind, `wrong kind for ${title}`);
    assert.strictEqual(matches[0]?.edit, undefined, `${title} must initially be unresolved`);
  }
}

export function assertFragments(
  source: string,
  present: readonly string[],
  absent: readonly string[],
): void {
  for (const fragment of present) assert.ok(source.includes(fragment), fragment);
  for (const fragment of absent) assert.ok(!source.includes(fragment), fragment);
}

function vscodeKind(value: string): vscode.CodeActionKind {
  switch (value) {
    case 'refactor.extract': return vscode.CodeActionKind.RefactorExtract;
    case 'refactor.inline': return vscode.CodeActionKind.RefactorInline;
    case 'refactor.rewrite': return vscode.CodeActionKind.RefactorRewrite;
    case 'source.organizeImports': return vscode.CodeActionKind.SourceOrganizeImports;
    default: return vscode.CodeActionKind.Refactor;
  }
}

async function assertOutsideActionRange(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
): Promise<void> {
  const range = rangeOf(fixture.document, actionCase.outsideSnippet ?? 'namespace');
  const raw = await rawCodeActions(fixture.uri, range);
  assert.ok(!raw.some((action) => action.title === actionCase.title));
  const actions = await waitForCodeActions({
    uri: fixture.uri, range, kind: vscodeKind(actionCase.kind), predicate: () => true,
  });
  assert.ok(!actions.some((action) => action.title === actionCase.title));
}

async function discoverAction(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
): Promise<{ readonly range: vscode.Range; readonly raw: RawCodeAction[] }> {
  const range = rangeOf(fixture.document, actionCase.snippet, actionCase.focus);
  const actions = await waitForCodeActions({
    uri: fixture.uri, range, kind: vscodeKind(actionCase.kind),
    predicate: (items) => items.some((item) => item.title === actionCase.title),
  });
  onlyAction(actions, actionCase.title);
  const raw = await rawCodeActions(fixture.uri, range);
  assertRawTitles(raw, actionCase.options ?? [actionCase.title], actionCase.kind);
  assertRawActionData(raw, fixture.uri);
  return { range, raw };
}

async function resolveAction(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  range: vscode.Range,
): Promise<vscode.WorkspaceEdit> {
  const actions = await waitForResolvedCodeActions({
    uri: fixture.uri, range, kind: vscodeKind(actionCase.kind),
    predicate: (items) => items.some((item) => item.title === actionCase.title && item.edit),
  });
  for (const title of actionCase.options ?? [actionCase.title]) onlyAction(actions, title);
  const action = onlyAction(actions, actionCase.title);
  assert.strictEqual(action.kind?.value, actionCase.kind);
  assert.ok(action.edit, `${actionCase.title} must resolve to a WorkspaceEdit`);
  return action.edit;
}

async function applyAction(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  edit: vscode.WorkspaceEdit,
): Promise<void> {
  const version = fixture.document.version;
  const snapshots = await applyWorkspaceEdit(edit);
  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0]?.uri.toString(), fixture.uri.toString());
  assert.ok((snapshots[0]?.edits.length ?? 0) >= 1);
  assert.ok(fixture.document.version > version);
  assert.ok(fixture.document.isDirty);
  const source = fixture.document.getText();
  assertFragments(source, actionCase.presentAfter, actionCase.absentAfter);
  for (const pattern of actionCase.patternsAfter ?? []) assert.match(source, pattern);
}

async function assertActionRequery(
  fixture: OpenFixture,
  range: vscode.Range,
  before: readonly RawCodeAction[],
): Promise<void> {
  const after = await rawCodeActions(fixture.uri, range);
  assertRawActionData(after, fixture.uri);
  const oldIds = new Set(before.map((action) => action.data?.id));
  assert.ok(after.every((action) => !oldIds.has(action.data?.id)));
}

export async function exerciseCodeAction(
  fixture: OpenFixture,
  committedText: string,
  actionCase: ActionLifecycleCase,
): Promise<void> {
  await replaceDocumentText(fixture.document, actionCase.source);
  await assertOutsideActionRange(fixture, actionCase);
  const discovered = await discoverAction(fixture, actionCase);
  const edit = await resolveAction(fixture, actionCase, discovered.range);
  await applyAction(fixture, actionCase, edit);
  await assertActionRequery(fixture, discovered.range, discovered.raw);
  await revertDocument(fixture.document);
  assert.strictEqual(fixture.document.getText(), committedText);
  assert.ok(!fixture.document.isDirty);
}
