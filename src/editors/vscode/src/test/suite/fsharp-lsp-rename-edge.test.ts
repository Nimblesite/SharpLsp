import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  RENAME_EDGE_SOURCE,
  RENAME_DECLARATIONS_SOURCE,
  RENAME_NAMESPACE_SOURCE,
  RENAME_NAMESPACE_USAGE_SOURCE,
} from './fsharp-rename-fixtures';
import {
  FSHARP_REFACTOR_TIMEOUT_MS,
  changedFileNames,
  editCount,
  openOverlay,
  requestPrepareRename,
  requestRename,
  tokenRange,
  undoAction,
} from './fsharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  applyWorkspaceEdit,
  assertWorkspaceEditSafe,
  revertDocument,
  waitForMatchingDiagnostics,
} from './refactor-test-helpers';
import { closeAllEditors } from './test-helpers';

// Real-LSP rejection/live-overlay boundaries. [RENAME-FSHARP-PREPARE] [RENAME-FSHARP-APPLY]
const TARGET_FILE = 'fsharp/RenameEdge.fs';
const DECLARATIONS_FILE = 'fsharp/RenameDeclarations.fs';
const NAMESPACE_FILE = 'fsharp/RenameNamespace.fs';
const NAMESPACE_USAGE_FILE = 'fsharp/RenameNamespaceUsage.fs';
const VALID_NAMES = ['renamedName', "renamedName'", '``renamed value``'] as const;
const INVALID_NAMES = ['', '1bad', 'bad-name', 'two words', 'let', 'value.with.dot'] as const;

suite('F# real LSP — rename edge cases', defineRenameEdgeSuite);

function defineRenameEdgeSuite(): void {
  suiteSetup(activateRealSharpLsp);
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);
  registerValidNameTests();
  registerInvalidNameTests();
  registerMetadataTests();
  registerRenameBoundaryTests();
}

function registerValidNameTests(): void {
  for (const newName of VALID_NAMES) {
    test(`unsaved overlay renames to ${JSON.stringify(newName)} and undoes cleanly`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
      await runUnsavedRename(newName);
    });
  }
}

function registerInvalidNameTests(): void {
  for (const invalidName of INVALID_NAMES) {
    test(`rejects invalid F# identifier ${JSON.stringify(invalidName)}`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS);
      await assertInvalidName(invalidName);
    });
  }
}

function registerMetadataTests(): void {
  for (const metadataName of ['System', 'String', 'Empty'] as const) {
    test(`rejects external metadata symbol ${metadataName}`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS);
      await assertMetadataRejected(metadataName);
    });
  }
}

function registerRenameBoundaryTests(): void {
  test('rejects prepare and rename on whitespace, literals, comments, and strings', async function () {
    this.timeout(FSHARP_REFACTOR_TIMEOUT_MS);
    await assertTriviaRejected();
  });
  test('rejects an indexer Item name whose F# uses have no identifier token', async function () {
    this.timeout(FSHARP_REFACTOR_TIMEOUT_MS);
    await assertIndexerRejected();
  });

  test('renames a namespace across files and reverses the rename', async function () {
    this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
    await assertNamespaceRename();
  });
}

async function runUnsavedRename(newName: string): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, RENAME_EDGE_SOURCE);
  try {
    const range = tokenRange(fixture.document, 'unsavedName');
    await assertPrepareAtEveryTokenPosition(fixture.uri, range, 'unsavedName');
    const edit = await requestRename(
      fixture.uri, range.start.translate(0, 1), newName, FSHARP_REFACTOR_TIMEOUT_MS,
    );
    await assertUnsavedEdit(edit, fixture.uri, newName);
    await applyUnsavedEdit(fixture, edit, newName);
    await undoUnsavedEdit(fixture, newName);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function assertPrepareAtEveryTokenPosition(
  uri: vscode.Uri,
  range: vscode.Range,
  placeholder: string,
): Promise<void> {
  for (const position of [range.start, range.start.translate(0, 1), range.end.translate(0, -1)]) {
    const prepare = await requestPrepareRename(uri, position);
    assert.ok(prepare);
    assert.strictEqual(prepare.placeholder, placeholder);
    assert.strictEqual(prepare.range.start.character, range.start.character);
    assert.strictEqual(prepare.range.end.character, range.end.character);
  }
}

async function assertUnsavedEdit(
  edit: vscode.WorkspaceEdit,
  uri: vscode.Uri,
  newName: string,
): Promise<void> {
  assert.strictEqual(edit.size, 1);
  assert.strictEqual(editCount(edit), 2);
  assert.strictEqual(edit.get(uri).length, 2);
  const snapshots = await assertWorkspaceEditSafe(edit);
  assert.strictEqual(snapshots.length, 1);
  assert.deepStrictEqual(snapshots[0]?.replacedText, ['unsavedName', 'unsavedName']);
  assert.ok(snapshots[0]?.edits.every((item) => item.newText === newName));
  assert.ok(snapshots[0]?.edits.every((item) => !item.range.isEmpty));
}

async function applyUnsavedEdit(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  edit: vscode.WorkspaceEdit,
  newName: string,
): Promise<void> {
  const version = fixture.document.version;
  await applyWorkspaceEdit(edit);
  assert.ok(fixture.document.version > version);
  assert.strictEqual(fixture.document.getText(), renamedEdgeSource(newName));
  assert.ok(fixture.document.getText().includes('// unsavedName in a comment'));
  assert.ok(fixture.document.getText().includes('let stringValue = "unsavedName"'));
  assert.ok(fixture.document.isDirty);
  await assertNoErrors(fixture.uri);
  const renamedRange = tokenRange(fixture.document, newName);
  const prepare = await requestPrepareRename(fixture.uri, renamedRange.start.translate(0, 1));
  assert.ok(prepare);
  assert.strictEqual(prepare.placeholder, newName);
}

async function undoUnsavedEdit(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  newName: string,
): Promise<void> {
  await undoAction(fixture.document, RENAME_EDGE_SOURCE);
  const range = tokenRange(fixture.document, 'unsavedName');
  const replay = await requestRename(
    fixture.uri, range.start.translate(0, 1), newName, FSHARP_REFACTOR_TIMEOUT_MS,
  );
  assert.strictEqual(editCount(replay), 2);
  assert.ok(replay.get(fixture.uri).every((item) => item.newText === newName));
  assert.strictEqual(fixture.document.getText(), RENAME_EDGE_SOURCE);
}

function renamedEdgeSource(newName: string): string {
  return RENAME_EDGE_SOURCE
    .replace('let unsavedName value', `let ${newName} value`)
    .replace('= unsavedName 2', `= ${newName} 2`);
}

async function assertInvalidName(invalidName: string): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, RENAME_EDGE_SOURCE);
  try {
    const range = tokenRange(fixture.document, 'unsavedName');
    const prepare = await requestPrepareRename(fixture.uri, range.start.translate(0, 1));
    assert.ok(prepare, 'the source symbol itself must remain renameable');
    const beforeVersion = fixture.document.version;
    const result = await executeRenameOnce(fixture.uri, range.start, invalidName);
    assert.ok(result === undefined || result.size === 0, 'invalid name must produce no edits');
    assert.strictEqual(fixture.document.version, beforeVersion);
    assert.strictEqual(fixture.document.getText(), RENAME_EDGE_SOURCE);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function assertTriviaRejected(): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, RENAME_EDGE_SOURCE);
  try {
    const positions = triviaPositions(fixture.document);
    for (const position of positions) {
      assert.strictEqual(await requestPrepareRename(fixture.uri, position), null);
      const result = await executeRenameOnce(fixture.uri, position, 'renamedTrivia');
      assert.ok(result === undefined || result.size === 0);
    }
    assert.strictEqual(fixture.document.getText(), RENAME_EDGE_SOURCE);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
  }
}

function triviaPositions(document: vscode.TextDocument): readonly vscode.Position[] {
  return [
    new vscode.Position(1, 0),
    tokenRange(document, '2').start,
    tokenRange(document, 'unsavedName', 2).start.translate(0, 1),
    tokenRange(document, 'unsavedName', 3).start.translate(0, 1),
  ];
}

async function assertMetadataRejected(name: string): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, RENAME_EDGE_SOURCE);
  try {
    const range = tokenRange(fixture.document, name);
    assert.strictEqual(await requestPrepareRename(fixture.uri, range.start.translate(0, 1)), null);
    const result = await executeRenameOnce(fixture.uri, range.start, `Renamed${name}`);
    assert.ok(result === undefined || result.size === 0);
    assert.strictEqual(fixture.document.getText(), RENAME_EDGE_SOURCE);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function assertIndexerRejected(): Promise<void> {
  const fixture = await openOverlay(DECLARATIONS_FILE, RENAME_DECLARATIONS_SOURCE);
  try {
    const range = tokenRange(fixture.document, 'Item');
    const prepare = await requestPrepareRename(fixture.uri, range.start.translate(0, 1));
    assert.strictEqual(prepare, null, 'F# indexer call sites use .[i], not the Item token');
    const result = await executeRenameOnce(fixture.uri, range.start, 'Lookup');
    assert.ok(result === undefined || result.size === 0);
    assert.strictEqual(fixture.document.getText(), RENAME_DECLARATIONS_SOURCE);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function assertNamespaceRename(): Promise<void> {
  const definition = await openOverlay(NAMESPACE_FILE, RENAME_NAMESPACE_SOURCE);
  const usage = await openOverlay(NAMESPACE_USAGE_FILE, RENAME_NAMESPACE_USAGE_SOURCE);
  try {
    const range = tokenRange(definition.document, 'RenameNamespace');
    await assertPrepareAtEveryTokenPosition(definition.uri, range, 'RenameNamespace');
    const edit = await requestRename(
      definition.uri, range.start.translate(0, 1), 'RenamedNamespace', FSHARP_REFACTOR_TIMEOUT_MS,
    );
    await assertNamespaceEdit(edit, 'RenameNamespace', 'RenamedNamespace');
    await applyWorkspaceEdit(edit);
    assertNamespaceTexts(definition.document, usage.document, 'RenamedNamespace');
    await assertNoErrors(definition.uri);
    await assertNoErrors(usage.uri);
    await reverseNamespaceRename(definition, usage);
  } finally {
    await revertDocument(usage.document);
    await revertDocument(definition.document);
  }
}

async function assertNamespaceEdit(
  edit: vscode.WorkspaceEdit,
  oldName: string,
  newName: string,
): Promise<void> {
  assert.strictEqual(edit.size, 2);
  assert.strictEqual(editCount(edit), 2);
  assert.deepStrictEqual(
    changedFileNames(edit).sort(), ['RenameNamespace.fs', 'RenameNamespaceUsage.fs'],
  );
  const snapshots = await assertWorkspaceEditSafe(edit);
  assert.strictEqual(snapshots.length, 2);
  assert.ok(snapshots.flatMap((item) => item.replacedText).every((text) => text === oldName));
  assert.ok(snapshots.flatMap((item) => item.edits).every((item) => item.newText === newName));
}

function assertNamespaceTexts(
  definition: vscode.TextDocument,
  usage: vscode.TextDocument,
  name: string,
): void {
  assert.strictEqual(
    definition.getText(), RENAME_NAMESPACE_SOURCE.replace('RenameNamespace', name),
  );
  assert.strictEqual(
    usage.getText(), RENAME_NAMESPACE_USAGE_SOURCE.replace('RenameNamespace', name),
  );
  assert.ok(definition.isDirty);
  assert.ok(usage.isDirty);
}

async function reverseNamespaceRename(
  definition: Awaited<ReturnType<typeof openOverlay>>,
  usage: Awaited<ReturnType<typeof openOverlay>>,
): Promise<void> {
  const range = tokenRange(definition.document, 'RenamedNamespace');
  await assertPrepareAtEveryTokenPosition(definition.uri, range, 'RenamedNamespace');
  const reverse = await requestRename(
    definition.uri, range.start.translate(0, 1), 'RenameNamespace', FSHARP_REFACTOR_TIMEOUT_MS,
  );
  await assertNamespaceEdit(reverse, 'RenamedNamespace', 'RenameNamespace');
  await applyWorkspaceEdit(reverse);
  assertNamespaceTexts(definition.document, usage.document, 'RenameNamespace');
  const restored = tokenRange(definition.document, 'RenameNamespace');
  await assertPrepareAtEveryTokenPosition(definition.uri, restored, 'RenameNamespace');
}

async function executeRenameOnce(
  uri: vscode.Uri,
  position: vscode.Position,
  newName: string,
): Promise<vscode.WorkspaceEdit | undefined> {
  try {
    return await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider', uri, position, newName,
    );
  } catch (error: unknown) {
    assert.match(String(error), /rename|invalid|request/i);
    return undefined;
  }
}

async function assertNoErrors(uri: vscode.Uri): Promise<void> {
  const diagnostics = await waitForMatchingDiagnostics(
    uri,
    (items) => items.every((item) => item.severity !== vscode.DiagnosticSeverity.Error),
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
  assert.ok(diagnostics.every((item) => item.severity !== vscode.DiagnosticSeverity.Error));
}
