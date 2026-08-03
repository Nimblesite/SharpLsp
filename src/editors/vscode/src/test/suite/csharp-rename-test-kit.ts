// Shared real-LSP rename driver for [RENAME-TESTS] and [RENAME-COVERAGE].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { positionOf, rangeOf } from './csharp-refactor-test-kit';
import {
  applyWorkspaceEdit,
  openFixtureDocument,
  preparedRenameAt,
  revertDocument,
  sendRealLspRequest,
  type LspPosition,
  type LspRange,
  type OpenFixture,
  type PrepareRenameResult,
  type WorkspaceEditSnapshot,
} from './refactor-test-helpers';
import { LSP_RESPONSE_TIMEOUT_MS, pollUntilResult } from './test-helpers';

export type RenameFixtureKey = 'symbols' | 'usage' | 'edge';

export interface RenameFixtureSet {
  readonly symbols: OpenFixture;
  readonly usage: OpenFixture;
  readonly edge: OpenFixture;
  readonly baselines: Readonly<Record<RenameFixtureKey, string>>;
}

export interface RenameCase {
  readonly label: string;
  readonly fixture: RenameFixtureKey;
  readonly snippet: string;
  readonly focus?: string;
  readonly occurrence?: number;
  readonly oldName: string;
  readonly newName: string;
  readonly editCount: number;
  readonly files: readonly RenameFixtureKey[];
  readonly after?: Readonly<Partial<Record<RenameFixtureKey, readonly string[]>>>;
}

export type { LspPosition, LspRange, PrepareRenameResult } from './refactor-test-helpers';

export interface RawRenameDocumentEdit {
  readonly textDocument: { readonly uri: string; readonly version: number | null };
  readonly edits: readonly { readonly range: LspRange; readonly newText: string }[];
}

export interface RawRenameEdit {
  readonly documentChanges?: readonly RawRenameDocumentEdit[];
}

export async function openRenameFixtures(): Promise<RenameFixtureSet> {
  const symbols = await openFixtureDocument('RenameSymbols.cs');
  const usage = await openFixtureDocument('RenameUsage.cs');
  const edge = await openFixtureDocument('RenameEdge.cs');
  return {
    symbols,
    usage,
    edge,
    baselines: {
      symbols: symbols.document.getText(),
      usage: usage.document.getText(),
      edge: edge.document.getText(),
    },
  };
}

export function fixtureOf(fixtures: RenameFixtureSet, key: RenameFixtureKey): OpenFixture {
  return fixtures[key];
}

function lspPosition(position: vscode.Position): LspPosition {
  return { line: position.line, character: position.character };
}

function lspRange(range: vscode.Range): LspRange {
  return { start: lspPosition(range.start), end: lspPosition(range.end) };
}

export async function prepareAt(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<PrepareRenameResult | null> {
  return preparedRenameAt(uri, position);
}

export async function waitForPrepare(
  uri: vscode.Uri,
  position: vscode.Position,
  placeholder: string,
): Promise<PrepareRenameResult> {
  const result = await pollUntilResult(
    async () => prepareAt(uri, position),
    (item) => item?.placeholder === placeholder,
    LSP_RESPONSE_TIMEOUT_MS,
    250,
  );
  assert.ok(result, `prepareRename must return ${placeholder}`);
  return result;
}

function assertPrepareResult(
  result: PrepareRenameResult | null,
  range: vscode.Range,
  placeholder: string,
): void {
  assert.ok(result, `prepareRename must allow ${placeholder}`);
  assert.strictEqual(result.placeholder, placeholder);
  assert.deepStrictEqual(result.range, lspRange(range));
  assert.strictEqual(result.range.end.character - result.range.start.character, placeholder.length);
}

async function assertPrepareCoverage(
  document: vscode.TextDocument,
  renameCase: RenameCase,
): Promise<vscode.Range> {
  const range = rangeOf(
    document,
    renameCase.snippet,
    renameCase.focus ?? renameCase.oldName,
    renameCase.occurrence,
  );
  const positions = [
    range.start,
    range.start.translate(0, Math.floor(renameCase.oldName.length / 2)),
    range.end.translate(0, -1),
  ];
  for (const position of positions) {
    assertPrepareResult(await prepareAt(document.uri, position), range, renameCase.oldName);
  }
  return range;
}

export async function rawRenameAt(
  uri: vscode.Uri,
  position: vscode.Position,
  newName: string,
): Promise<RawRenameEdit | null> {
  return sendRealLspRequest<RawRenameEdit | null>('textDocument/rename', {
    textDocument: { uri: uri.toString() },
    position: lspPosition(position),
    newName,
  });
}

export async function providerRename(
  uri: vscode.Uri,
  position: vscode.Position,
  newName: string,
): Promise<vscode.WorkspaceEdit | undefined> {
  return vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
    'vscode.executeDocumentRenameProvider',
    uri,
    position,
    newName,
  );
}

function expectedUris(fixtures: RenameFixtureSet, keys: readonly RenameFixtureKey[]): string[] {
  return keys.map((key) => fixtureOf(fixtures, key).uri.toString()).sort();
}

function expectedPaths(fixtures: RenameFixtureSet, keys: readonly RenameFixtureKey[]): string[] {
  return keys.map((key) => fixtureOf(fixtures, key).uri.fsPath.toLowerCase()).sort();
}

function assertRawEdit(
  edit: RawRenameEdit | null,
  fixtures: RenameFixtureSet,
  renameCase: RenameCase,
): void {
  assert.ok(edit?.documentChanges, 'raw textDocument/rename must return documentChanges');
  const changes = edit.documentChanges;
  const paths = changes
    .map((item) => vscode.Uri.parse(item.textDocument.uri).fsPath.toLowerCase())
    .sort();
  assert.deepStrictEqual(paths, expectedPaths(fixtures, renameCase.files));
  assert.ok(changes.every((item) => item.textDocument.version === null));
  const edits = changes.flatMap((item) => item.edits);
  assert.strictEqual(edits.length, renameCase.editCount);
  assert.ok(edits.every((item) => item.newText === renameCase.newName));
}

function assertSnapshotFiles(
  snapshots: readonly WorkspaceEditSnapshot[],
  fixtures: RenameFixtureSet,
  keys: readonly RenameFixtureKey[],
): void {
  assert.deepStrictEqual(
    snapshots.map((item) => item.uri.toString()).sort(),
    expectedUris(fixtures, keys),
  );
  assert.ok(snapshots.every((item) => item.document !== undefined));
}

function assertTokenEdits(
  snapshots: readonly WorkspaceEditSnapshot[],
  oldName: string,
  newName: string,
  editCount: number,
): void {
  const edits = snapshots.flatMap((item) => item.edits);
  const replaced = snapshots.flatMap((item) => item.replacedText);
  assert.strictEqual(
    edits.length,
    editCount,
    'rename must produce one granular edit per occurrence',
  );
  assert.ok(edits.every((item) => item.newText === newName));
  assert.ok(edits.every((item) => !item.range.isEmpty && item.range.isSingleLine));
  assert.ok(
    replaced.every((text) => text === oldName),
    `every replaced token must be ${oldName}`,
  );
}

function captureVersions(fixtures: RenameFixtureSet): ReadonlyMap<string, number> {
  const openFixtures = [fixtures.symbols, fixtures.usage, fixtures.edge];
  return new Map(openFixtures.map((fixture) => [fixture.uri.toString(), fixture.document.version]));
}

function assertAppliedVersions(
  snapshots: readonly WorkspaceEditSnapshot[],
  versions: ReadonlyMap<string, number>,
): void {
  for (const snapshot of snapshots) {
    assert.ok(snapshot.document, `rename target must already be open: ${snapshot.uri.fsPath}`);
    assert.ok(snapshot.document.version > (versions.get(snapshot.uri.toString()) ?? -1));
    assert.ok(snapshot.document.isDirty, 'applied rename must leave every changed document dirty');
  }
}

function assertLiteralAndCommentSentinels(fixtures: RenameFixtureSet): void {
  const symbols = fixtures.symbols.document.getText();
  assert.ok(symbols.includes('"RenameClass RenameMethod renameLocal"'));
  assert.ok(
    symbols.includes('// RenameClass RenameMethod renameLocal must remain untouched in comments.'),
  );
  const edge = fixtures.edge.document.getText();
  if (fixtures.baselines.edge.includes('"PartialRenameTarget PartialMember"')) {
    assert.ok(edge.includes('"PartialRenameTarget PartialMember"'));
    assert.ok(
      edge.includes('// PartialRenameTarget and PartialMember stay unchanged in this comment.'),
    );
  }
}

function assertCaseFragments(fixtures: RenameFixtureSet, renameCase: RenameCase): void {
  for (const key of ['symbols', 'usage', 'edge'] as const) {
    const source = fixtureOf(fixtures, key).document.getText();
    for (const fragment of renameCase.after?.[key] ?? [])
      assert.ok(source.includes(fragment), fragment);
  }
}

async function applyAndAssert(
  edit: vscode.WorkspaceEdit,
  fixtures: RenameFixtureSet,
  renameCase: RenameCase,
): Promise<WorkspaceEditSnapshot[]> {
  const versions = captureVersions(fixtures);
  const snapshots = await applyWorkspaceEdit(edit);
  assertSnapshotFiles(snapshots, fixtures, renameCase.files);
  assertTokenEdits(snapshots, renameCase.oldName, renameCase.newName, renameCase.editCount);
  assertAppliedVersions(snapshots, versions);
  assertLiteralAndCommentSentinels(fixtures);
  assertCaseFragments(fixtures, renameCase);
  return snapshots;
}

async function assertRenamedPrepare(
  document: vscode.TextDocument,
  originalRange: vscode.Range,
  newName: string,
): Promise<void> {
  const result = await waitForPrepare(document.uri, originalRange.start, newName);
  const expected = new vscode.Range(
    originalRange.start,
    originalRange.start.translate(0, newName.length),
  );
  assertPrepareResult(result, expected, newName);
}

async function obtainRenameEdit(
  fixture: OpenFixture,
  range: vscode.Range,
  renameCase: RenameCase,
  fixtures: RenameFixtureSet,
): Promise<vscode.WorkspaceEdit> {
  assertRawEdit(
    await rawRenameAt(fixture.uri, range.start, renameCase.newName),
    fixtures,
    renameCase,
  );
  const edit = await providerRename(fixture.uri, range.start, renameCase.newName);
  assert.ok(edit, `VS Code rename provider must return an edit for ${renameCase.label}`);
  assert.strictEqual(edit.size, renameCase.files.length);
  return edit;
}

async function reverseRename(
  fixture: OpenFixture,
  range: vscode.Range,
  renameCase: RenameCase,
  fixtures: RenameFixtureSet,
): Promise<void> {
  const edit = await providerRename(fixture.uri, range.start, renameCase.oldName);
  assert.ok(edit, `reverse rename must return an edit for ${renameCase.label}`);
  const snapshots = await applyWorkspaceEdit(edit);
  assertSnapshotFiles(snapshots, fixtures, renameCase.files);
  assertTokenEdits(snapshots, renameCase.newName, renameCase.oldName, renameCase.editCount);
}

export async function revertRenameFixtures(fixtures: RenameFixtureSet): Promise<void> {
  for (const key of ['symbols', 'usage', 'edge'] as const) {
    const fixture = fixtureOf(fixtures, key);
    await revertDocument(fixture.document);
    assert.strictEqual(fixture.document.getText(), fixtures.baselines[key]);
    assert.ok(!fixture.document.isDirty);
  }
}

export async function exerciseRename(
  fixtures: RenameFixtureSet,
  renameCase: RenameCase,
  revertToDisk = true,
): Promise<void> {
  const fixture = fixtureOf(fixtures, renameCase.fixture);
  const range = await assertPrepareCoverage(fixture.document, renameCase);
  const edit = await obtainRenameEdit(fixture, range, renameCase, fixtures);
  await applyAndAssert(edit, fixtures, renameCase);
  await assertRenamedPrepare(fixture.document, range, renameCase.newName);
  await reverseRename(fixture, range, renameCase, fixtures);
  for (const key of ['symbols', 'usage', 'edge'] as const) {
    assert.strictEqual(fixtureOf(fixtures, key).document.getText(), fixtures.baselines[key]);
  }
  if (revertToDisk) await revertRenameFixtures(fixtures);
}

export function positionForCase(
  fixtures: RenameFixtureSet,
  renameCase: RenameCase,
): vscode.Position {
  const document = fixtureOf(fixtures, renameCase.fixture).document;
  return positionOf(
    document,
    renameCase.snippet,
    renameCase.focus ?? renameCase.oldName,
    renameCase.occurrence,
  );
}
