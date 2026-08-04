import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  applyWorkspaceEdit,
  replaceDocumentText,
  revertDocument,
  runEditorHistory,
  sendRealLspRequest,
  waitForCodeActions,
  waitForMatchingDiagnostics,
  waitForResolvedCodeActions,
  type OpenFixture,
  type WorkspaceEditSnapshot,
} from './refactor-test-helpers';

export interface RawCodeAction {
  readonly title: string;
  readonly kind?: string;
  readonly isPreferred?: boolean;
  readonly data?: { readonly id?: number; readonly uri?: string };
  readonly edit?: unknown;
}

interface RawDiagnostic {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly severity?: number;
  readonly code?: string | number | { readonly value?: string | number };
  readonly message: string;
}

interface RawDiagnosticReport {
  readonly kind: string;
  readonly items: readonly RawDiagnostic[];
}

export interface OccurrenceExpectation {
  readonly fragment: string;
  readonly count: number;
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
  readonly postApplySnippet?: string;
  readonly postApplyFocus?: string;
  readonly presentAfter: readonly string[];
  readonly absentAfter: readonly string[];
  readonly patternsAfter?: readonly RegExp[];
  readonly occurrencesAfter?: readonly OccurrenceExpectation[];
  readonly diagnosticCode?: string;
  readonly mustDisappear?: boolean;
  readonly requeryTitleCount?: number;
  readonly skipOutsideRange?: boolean;
  /**
   * Query with a collapsed caret at the focus start instead of a selection.
   * Roslyn gates several member-level providers (Generate Equals, argument
   * wrapping) on a caret; a selection suppresses them exactly as it does in VS.
   */
  readonly caretOnly?: boolean;
}

export function codeOf(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (typeof code === 'object' && code !== null) return String(code.value);
  return code === undefined ? '' : String(code);
}

function rawCodeOf(diagnostic: RawDiagnostic): string {
  const code = diagnostic.code;
  if (typeof code === 'object' && code !== null) return String(code.value ?? '');
  return code === undefined ? '' : String(code);
}

function errorSignatures(diagnostics: readonly RawDiagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error + 1)
    .map((diagnostic) => `${rawCodeOf(diagnostic)}\u001f${diagnostic.message}`)
    .sort();
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

export function rangeAfterAction(
  fixture: OpenFixture,
  original: vscode.Range,
  snippet?: string,
  focus?: string,
): vscode.Range {
  return snippet ? rangeOf(fixture.document, snippet, focus ?? snippet) : original;
}

function toLspPosition(position: vscode.Position): {
  readonly line: number;
  readonly character: number;
} {
  return { line: position.line, character: position.character };
}

export async function rawCodeActions(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<RawCodeAction[]> {
  return rawCodeActionsBetween(uri, range.start, range.end);
}

async function rawCodeActionsBetween(
  uri: vscode.Uri,
  start: vscode.Position,
  end: vscode.Position,
): Promise<RawCodeAction[]> {
  const result = await sendRealLspRequest<RawCodeAction[] | null>('textDocument/codeAction', {
    textDocument: { uri: uri.toString() },
    range: { start: toLspPosition(start), end: toLspPosition(end) },
    context: { diagnostics: [] },
  });
  assert.ok(Array.isArray(result), 'the real LSP must return a code-action array');
  return result;
}

async function pullDiagnostics(uri: vscode.Uri): Promise<readonly RawDiagnostic[]> {
  const report = await sendRealLspRequest<RawDiagnosticReport>('textDocument/diagnostic', {
    textDocument: { uri: uri.toString() },
  });
  assert.strictEqual(report.kind, 'full');
  assert.ok(Array.isArray(report.items), 'the real LSP must return diagnostic items');
  for (const diagnostic of report.items) assertDiagnosticShape(diagnostic);
  return report.items;
}

function assertDiagnosticShape(diagnostic: RawDiagnostic): void {
  assert.ok(diagnostic.message.length > 0, 'every diagnostic must have a message');
  assert.ok(diagnostic.range.start.line >= 0 && diagnostic.range.start.character >= 0);
  assert.ok(diagnostic.range.end.line >= diagnostic.range.start.line);
  if (diagnostic.range.end.line === diagnostic.range.start.line)
    assert.ok(diagnostic.range.end.character >= diagnostic.range.start.character);
  if (diagnostic.severity !== undefined)
    assert.ok(diagnostic.severity >= 1 && diagnostic.severity <= 4);
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

export function assertFreshActionDataIds(
  after: readonly RawCodeAction[],
  before: readonly RawCodeAction[],
): void {
  const oldIds = new Set(before.map((action) => action.data?.id));
  assert.ok(
    after.every((action) => !oldIds.has(action.data?.id)),
    'requery must mint fresh data ids',
  );
}

export function assertSingleDocumentEdit(
  snapshots: readonly WorkspaceEditSnapshot[],
  fixture: OpenFixture,
): void {
  assert.strictEqual(snapshots.length, 1, 'a local action must change exactly one document');
  assert.strictEqual(snapshots[0]?.uri.toString(), fixture.uri.toString());
  assert.ok((snapshots[0]?.edits.length ?? 0) >= 1);
  assert.ok((snapshots[0]?.replacedText.length ?? 0) >= 1);
}

export function assertRawTitles(
  actions: readonly RawCodeAction[],
  titles: readonly string[],
  kind: string,
): void {
  const offered = actions.map((action) => `${action.kind}::${action.title}`).join(' | ');
  for (const title of titles) {
    const matches = actions.filter((action) => action.title === title);
    assert.strictEqual(
      matches.length,
      1,
      `expected exactly one raw action titled ${title}; offered: ${offered === '' ? '(none)' : offered}`,
    );
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
    case 'refactor.extract':
      return vscode.CodeActionKind.RefactorExtract;
    case 'refactor.inline':
      return vscode.CodeActionKind.RefactorInline;
    case 'refactor.rewrite':
      return vscode.CodeActionKind.RefactorRewrite;
    case 'source.organizeImports':
      return vscode.CodeActionKind.SourceOrganizeImports;
    case 'quickfix':
      return vscode.CodeActionKind.QuickFix;
    default:
      return vscode.CodeActionKind.Refactor;
  }
}

async function assertRequiredDiagnostic(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
): Promise<void> {
  if (actionCase.diagnosticCode === undefined) return;
  const diagnostics = await waitForMatchingDiagnostics(fixture.uri, (items) =>
    items.some((item) => codeOf(item) === actionCase.diagnosticCode),
  );
  const matches = diagnostics.filter((item) => codeOf(item) === actionCase.diagnosticCode);
  assert.ok(matches.length >= 1, `missing ${actionCase.diagnosticCode}`);
  assert.ok(matches.every((item) => item.message.length > 0));
  assert.ok(matches.every((item) => !item.range.isEmpty));
}

async function captureErrorBaseline(fixture: OpenFixture): Promise<readonly string[]> {
  return errorSignatures(await pullDiagnostics(fixture.uri));
}

async function assertNoNewErrors(fixture: OpenFixture, baseline: readonly string[]): Promise<void> {
  const current = errorSignatures(await pullDiagnostics(fixture.uri));
  const newErrors = current.filter((signature) => !baseline.includes(signature));
  assert.deepStrictEqual(newErrors, [], 'the refactor must not introduce diagnostics errors');
}

async function assertBaselineRestored(
  fixture: OpenFixture,
  baseline: readonly string[],
): Promise<void> {
  assert.deepStrictEqual(errorSignatures(await pullDiagnostics(fixture.uri)), baseline);
}

function middleOf(document: vscode.TextDocument, range: vscode.Range): vscode.Position {
  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  return document.positionAt(start + Math.floor((end - start) / 2));
}

async function assertRawProbe(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  start: vscode.Position,
  end: vscode.Position,
): Promise<void> {
  const actions = await rawCodeActionsBetween(fixture.uri, start, end);
  assertRawActionData(actions, fixture.uri);
  assert.ok(actions.every((action) => action.title.length > 0));
  assert.ok(actions.every((action) => action.edit === undefined));
  assert.ok(actions.filter((action) => action.title === actionCase.title).length <= 1);
}

async function assertCaretProviderProbe(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  position: vscode.Position,
): Promise<void> {
  const actions = await waitForCodeActions({
    uri: fixture.uri,
    range: new vscode.Range(position, position),
    kind: vscodeKind(actionCase.kind),
    predicate: () => true,
  });
  assert.ok(actions.every((action) => action.title.length > 0));
}

async function assertBoundaryRanges(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  range: vscode.Range,
): Promise<void> {
  const middle = middleOf(fixture.document, range);
  await assertRawProbe(fixture, actionCase, range.start, range.start);
  await assertRawProbe(fixture, actionCase, middle, middle);
  await assertRawProbe(fixture, actionCase, range.end, range.end);
  await assertRawProbe(fixture, actionCase, range.end, range.start);
  await assertCaretProviderProbe(fixture, actionCase, range.start);
  await assertCaretProviderProbe(fixture, actionCase, range.end);
}

async function assertOutsideActionRange(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
): Promise<void> {
  if (actionCase.skipOutsideRange) return;
  const range = rangeOf(fixture.document, actionCase.outsideSnippet ?? 'namespace');
  const raw = await rawCodeActions(fixture.uri, range);
  assert.ok(!raw.some((action) => action.title === actionCase.title));
  const actions = await waitForCodeActions({
    uri: fixture.uri,
    range,
    kind: vscodeKind(actionCase.kind),
    predicate: () => true,
  });
  assert.ok(!actions.some((action) => action.title === actionCase.title));
}

function discoveryRange(
  document: vscode.TextDocument,
  actionCase: ActionLifecycleCase,
): vscode.Range {
  const range = rangeOf(document, actionCase.snippet, actionCase.focus);
  return actionCase.caretOnly ? new vscode.Range(range.start, range.start) : range;
}

async function discoverAction(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
): Promise<{ readonly range: vscode.Range; readonly raw: RawCodeAction[] }> {
  const range = discoveryRange(fixture.document, actionCase);
  const actions = await waitForCodeActions({
    uri: fixture.uri,
    range,
    kind: vscodeKind(actionCase.kind),
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
    uri: fixture.uri,
    range,
    kind: vscodeKind(actionCase.kind),
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
): Promise<string> {
  const version = fixture.document.version;
  const snapshots = await applyWorkspaceEdit(edit);
  assertSingleDocumentEdit(snapshots, fixture);
  assert.ok(fixture.document.version > version);
  assert.ok(fixture.document.isDirty);
  const source = fixture.document.getText();
  assertFragments(source, actionCase.presentAfter, actionCase.absentAfter);
  for (const pattern of actionCase.patternsAfter ?? []) assert.match(source, pattern);
  for (const expected of actionCase.occurrencesAfter ?? []) {
    assert.strictEqual(source.split(expected.fragment).length - 1, expected.count);
  }
  return source;
}

async function assertActionRequery(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  originalRange: vscode.Range,
  before: readonly RawCodeAction[],
): Promise<readonly RawCodeAction[]> {
  const range = rangeAfterAction(
    fixture,
    originalRange,
    actionCase.postApplySnippet,
    actionCase.postApplyFocus,
  );
  const after = await rawCodeActions(fixture.uri, range);
  assertRawActionData(after, fixture.uri);
  assertFreshActionDataIds(after, before);
  const matches = after.filter((action) => action.title === actionCase.title);
  if (actionCase.mustDisappear) assert.strictEqual(matches.length, 0);
  if (actionCase.requeryTitleCount !== undefined)
    assert.strictEqual(matches.length, actionCase.requeryTitleCount);
  return after;
}

async function undoToSource(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  before: readonly RawCodeAction[],
): Promise<Awaited<ReturnType<typeof discoverAction>>> {
  await runEditorHistory(fixture.document, 'undo', actionCase.source);
  const discovered = await discoverAction(fixture, actionCase);
  assertFreshActionDataIds(discovered.raw, before);
  return discovered;
}

async function assertRedo(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  transformed: string,
  discovered: Awaited<ReturnType<typeof discoverAction>>,
  baseline: readonly string[],
): Promise<readonly RawCodeAction[]> {
  await runEditorHistory(fixture.document, 'redo', transformed);
  const after = await assertActionRequery(fixture, actionCase, discovered.range, discovered.raw);
  await assertNoNewErrors(fixture, baseline);
  return after;
}

async function retryAction(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
  discovered: Awaited<ReturnType<typeof discoverAction>>,
  transformed: string,
): Promise<void> {
  const edit = await resolveAction(fixture, actionCase, discovered.range);
  assert.strictEqual(await applyAction(fixture, actionCase, edit), transformed);
  await assertActionRequery(fixture, actionCase, discovered.range, discovered.raw);
}

async function prepareSource(
  fixture: OpenFixture,
  actionCase: ActionLifecycleCase,
): Promise<readonly string[]> {
  await replaceDocumentText(fixture.document, actionCase.source);
  await assertRequiredDiagnostic(fixture, actionCase);
  const baseline = await captureErrorBaseline(fixture);
  await assertOutsideActionRange(fixture, actionCase);
  return baseline;
}

async function restoreCommitted(fixture: OpenFixture, committedText: string): Promise<void> {
  await revertDocument(fixture.document);
  assert.strictEqual(fixture.document.getText(), committedText);
  assert.ok(!fixture.document.isDirty);
}

export async function exerciseCodeAction(
  fixture: OpenFixture,
  committedText: string,
  actionCase: ActionLifecycleCase,
): Promise<void> {
  const baseline = await prepareSource(fixture, actionCase);
  const discovered = await discoverAction(fixture, actionCase);
  await assertBoundaryRanges(fixture, actionCase, discovered.range);
  const edit = await resolveAction(fixture, actionCase, discovered.range);
  const transformed = await applyAction(fixture, actionCase, edit);
  await assertActionRequery(fixture, actionCase, discovered.range, discovered.raw);
  await assertNoNewErrors(fixture, baseline);
  const afterUndo = await undoToSource(fixture, actionCase, discovered.raw);
  await assertBaselineRestored(fixture, baseline);
  const afterRedo = await assertRedo(fixture, actionCase, transformed, afterUndo, baseline);
  const retry = await undoToSource(fixture, actionCase, afterRedo);
  await assertBaselineRestored(fixture, baseline);
  await retryAction(fixture, actionCase, retry, transformed);
  await assertNoNewErrors(fixture, baseline);
  await restoreCommitted(fixture, committedText);
}
