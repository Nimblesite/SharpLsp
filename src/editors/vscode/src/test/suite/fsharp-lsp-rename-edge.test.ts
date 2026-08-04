import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  RENAME_EDGE_SOURCE,
  RENAME_DECLARATIONS_SOURCE,
  RENAME_NAMESPACE_SOURCE,
  RENAME_NAMESPACE_USAGE_SOURCE,
  RENAME_USAGES_SOURCE,
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
const USAGES_FILE = 'fsharp/RenameUsages.fs';
const NAMESPACE_FILE = 'fsharp/RenameNamespace.fs';
const NAMESPACE_USAGE_FILE = 'fsharp/RenameNamespaceUsage.fs';
const VALID_NAMES = ['renamedName', "renamedName'", '``renamed value``'] as const;
const INVALID_NAMES = ['', '1bad', 'bad-name', 'two words', 'let', 'value.with.dot'] as const;
type OpenOverlay = Awaited<ReturnType<typeof openOverlay>>;

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
  test('renames an indexer and keeps .[i] call sites compiling via DefaultMember', async function () {
    this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
    await assertIndexerRename();
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
      fixture.uri,
      range.start.translate(0, 1),
      newName,
      FSHARP_REFACTOR_TIMEOUT_MS,
    );
    await assertUnsavedEdit(edit, fixture.uri, 'unsavedName', newName);
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
  assert.ok(range.isSingleLine && !range.isEmpty);
  for (let offset = 0; offset < range.end.character - range.start.character; offset += 1) {
    const position = range.start.translate(0, offset);
    const prepare = await requestPrepareRename(uri, position);
    assert.ok(prepare);
    assert.strictEqual(prepare.placeholder, placeholder);
    assert.strictEqual(prepare.range.start.line, range.start.line);
    assert.strictEqual(prepare.range.start.character, range.start.character);
    assert.strictEqual(prepare.range.end.line, range.end.line);
    assert.strictEqual(prepare.range.end.character, range.end.character);
  }
}

async function assertUnsavedEdit(
  edit: vscode.WorkspaceEdit,
  uri: vscode.Uri,
  oldName: string,
  newName: string,
): Promise<void> {
  assert.strictEqual(edit.size, 1);
  assert.strictEqual(editCount(edit), 2);
  assert.strictEqual(edit.get(uri).length, 2);
  const snapshots = await assertWorkspaceEditSafe(edit);
  assert.strictEqual(snapshots.length, 1);
  assert.deepStrictEqual(snapshots[0]?.replacedText, [oldName, oldName]);
  assert.ok(snapshots[0]?.edits.every((item) => item.newText === newName));
  assert.ok(snapshots[0]?.edits.every((item) => !item.range.isEmpty && item.range.isSingleLine));
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
  await assertPrepareAtEveryTokenPosition(fixture.uri, renamedRange, newName);
  await assertReverseRenameAtBoundaries(fixture.uri, renamedRange, newName);
}

async function assertReverseRenameAtBoundaries(
  uri: vscode.Uri,
  range: vscode.Range,
  currentName: string,
): Promise<void> {
  const positions = [
    range.start,
    range.start.translate(0, 1),
    range.end.translate(0, -2),
    range.end.translate(0, -1),
  ];
  for (const position of positions) {
    const reverse = await requestRename(uri, position, 'unsavedName', FSHARP_REFACTOR_TIMEOUT_MS);
    await assertUnsavedEdit(reverse, uri, currentName, 'unsavedName');
  }
}

async function undoUnsavedEdit(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  newName: string,
): Promise<void> {
  await undoAction(fixture.document, RENAME_EDGE_SOURCE);
  const range = tokenRange(fixture.document, 'unsavedName');
  const replay = await requestRename(
    fixture.uri,
    range.start.translate(0, 1),
    newName,
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
  await assertUnsavedEdit(replay, fixture.uri, 'unsavedName', newName);
  assert.strictEqual(fixture.document.getText(), RENAME_EDGE_SOURCE);
}

function renamedEdgeSource(newName: string): string {
  return RENAME_EDGE_SOURCE.replace('let unsavedName value', `let ${newName} value`).replace(
    '= unsavedName 2',
    `= ${newName} 2`,
  );
}

async function assertInvalidName(invalidName: string): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, RENAME_EDGE_SOURCE);
  try {
    const range = tokenRange(fixture.document, 'unsavedName');
    const prepare = await requestPrepareRename(fixture.uri, range.start.translate(0, 1));
    assert.ok(prepare, 'the source symbol itself must remain renameable');
    const beforeVersion = fixture.document.version;
    await assertInvalidRenameError(fixture.uri, range.start, invalidName);
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
      const result = await executeRenameWithoutEdit(fixture.uri, position, 'renamedTrivia');
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
    const result = await executeRenameWithoutEdit(fixture.uri, range.start, `Renamed${name}`);
    assert.ok(result === undefined || result.size === 0);
    assert.strictEqual(fixture.document.getText(), RENAME_EDGE_SOURCE);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
  }
}

// An `x.[i]` call site carries no `Item` token, so renaming the member alone would
// break it. The rename must also write DefaultMember metadata for the new name —
// the usages file staying error-free is the proof it still binds.
async function assertIndexerRename(): Promise<void> {
  const declarations = await openOverlay(DECLARATIONS_FILE, RENAME_DECLARATIONS_SOURCE);
  const usages = await openOverlay(USAGES_FILE, RENAME_USAGES_SOURCE);
  try {
    await runIndexerLifecycle(declarations, usages);
  } finally {
    await revertDocument(usages.document);
    await revertDocument(declarations.document);
  }
}

async function runIndexerLifecycle(declarations: OpenOverlay, usages: OpenOverlay): Promise<void> {
  const range = tokenRange(declarations.document, 'Item');
  await assertPrepareAtEveryTokenPosition(declarations.uri, range, 'Item');
  const edit = await requestRename(
    declarations.uri,
    range.start.translate(0, 1),
    'Lookup',
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
  assert.deepStrictEqual(changedFileNames(edit).sort(), ['RenameDeclarations.fs']);
  assert.strictEqual(editCount(edit), 2, 'the member rename and its DefaultMember metadata');
  await applyWorkspaceEdit(edit);
  assert.strictEqual(declarations.document.getText(), renamedIndexerSource());
  assert.strictEqual(usages.document.getText(), RENAME_USAGES_SOURCE);
  await assertNoErrors(declarations.uri);
  await assertNoErrors(usages.uri);
  await undoAction(declarations.document, RENAME_DECLARATIONS_SOURCE);
  await assertPrepareAtEveryTokenPosition(declarations.uri, range, 'Item');
}

function renamedIndexerSource(): string {
  return RENAME_DECLARATIONS_SOURCE.replace(
    'type IndexerThing() =',
    '[<System.Reflection.DefaultMemberAttribute("Lookup")>]\ntype IndexerThing() =',
  ).replace('member _.Item with', 'member _.Lookup with');
}

async function assertNamespaceRename(): Promise<void> {
  const definition = await openOverlay(NAMESPACE_FILE, RENAME_NAMESPACE_SOURCE);
  const usage = await openOverlay(NAMESPACE_USAGE_FILE, RENAME_NAMESPACE_USAGE_SOURCE);
  try {
    await runNamespaceLifecycle(definition, usage);
  } finally {
    await revertDocument(usage.document);
    await revertDocument(definition.document);
  }
}

async function runNamespaceLifecycle(definition: OpenOverlay, usage: OpenOverlay): Promise<void> {
  const range = tokenRange(definition.document, 'RenameNamespace');
  await assertPrepareAtEveryTokenPosition(definition.uri, range, 'RenameNamespace');
  const edit = await requestRename(
    definition.uri,
    range.start.translate(0, 1),
    'RenamedNamespace',
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
  await assertNamespaceEdit(edit, 'RenameNamespace', 'RenamedNamespace');
  await applyWorkspaceEdit(edit);
  assertNamespaceTexts(definition.document, usage.document, 'RenamedNamespace');
  await assertNoErrors(definition.uri);
  await assertNoErrors(usage.uri);
  await reverseNamespaceRename(definition, usage);
}

async function assertNamespaceEdit(
  edit: vscode.WorkspaceEdit,
  oldName: string,
  newName: string,
): Promise<void> {
  assert.strictEqual(edit.size, 2);
  assert.strictEqual(editCount(edit), 2);
  assert.deepStrictEqual(changedFileNames(edit).sort(), [
    'RenameNamespace.fs',
    'RenameNamespaceUsage.fs',
  ]);
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
    definition.getText(),
    RENAME_NAMESPACE_SOURCE.replace('RenameNamespace', name),
  );
  assert.strictEqual(
    usage.getText(),
    RENAME_NAMESPACE_USAGE_SOURCE.replace('RenameNamespace', name),
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
    definition.uri,
    range.start.translate(0, 1),
    'RenameNamespace',
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
  await assertNamespaceEdit(reverse, 'RenamedNamespace', 'RenameNamespace');
  await applyWorkspaceEdit(reverse);
  assertNamespaceTexts(definition.document, usage.document, 'RenameNamespace');
  const restored = tokenRange(definition.document, 'RenameNamespace');
  await assertPrepareAtEveryTokenPosition(definition.uri, restored, 'RenameNamespace');
}

async function executeRenameWithoutEdit(
  uri: vscode.Uri,
  position: vscode.Position,
  newName: string,
): Promise<vscode.WorkspaceEdit | undefined> {
  try {
    return await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider',
      uri,
      position,
      newName,
    );
  } catch (error: unknown) {
    // VS Code resolves the rename location before editing, so a server that
    // refuses prepareRename surfaces the editor's own refusal, not "No result".
    assert.match(String(error), /No result|can't be renamed/i);
    return undefined;
  }
}

async function assertInvalidRenameError(
  uri: vscode.Uri,
  position: vscode.Position,
  newName: string,
): Promise<void> {
  await assert.rejects(
    async () =>
      vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        uri,
        position,
        newName,
      ),
    /Invalid F# rename name:/,
  );
}

async function assertNoErrors(uri: vscode.Uri): Promise<void> {
  const diagnostics = await waitForMatchingDiagnostics(
    uri,
    (items) => items.every((item) => item.severity !== vscode.DiagnosticSeverity.Error),
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
  assert.ok(diagnostics.every((item) => item.severity !== vscode.DiagnosticSeverity.Error));
}
