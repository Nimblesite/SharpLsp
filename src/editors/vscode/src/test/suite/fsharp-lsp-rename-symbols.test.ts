import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  RENAME_DECLARATIONS_SOURCE,
  RENAME_SCENARIOS,
  RENAME_SENTINEL,
  RENAME_USAGES_SOURCE,
  type RenameScenario,
} from './fsharp-rename-fixtures';
import {
  FSHARP_REFACTOR_TIMEOUT_MS,
  changedFileNames,
  countOccurrences,
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

// Project-wide matrix through the shipped client. [RENAME-FSHARP-PREPARE] [RENAME-FSHARP-APPLY]
const DECLARATIONS_FILE = 'fsharp/RenameDeclarations.fs';
const USAGES_FILE = 'fsharp/RenameUsages.fs';

interface RenameFixture {
  readonly declarations: Awaited<ReturnType<typeof openOverlay>>;
  readonly usages: Awaited<ReturnType<typeof openOverlay>>;
}

suite('F# real LSP — rename every symbol category', () => {
  suiteSetup(activateRealSharpLsp);
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);

  for (const scenario of RENAME_SCENARIOS) {
    test(`${scenario.name}: prepare, multi-edit apply, recheck, and undo`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 3);
      await runRename(scenario);
    });
  }
});

async function runRename(scenario: RenameScenario): Promise<void> {
  const fixture = await openRenameFixture();
  try {
    const range = tokenRange(fixture.declarations.document, scenario.target);
    const position = interiorPosition(range);
    await assertPrepare(fixture.declarations.uri, range, position, scenario.target);
    const edit = await requestRename(
      fixture.declarations.uri, position, scenario.newName, FSHARP_REFACTOR_TIMEOUT_MS,
    );
    await inspectRenameEdit(edit, scenario);
    await applyAndVerify(fixture, edit, scenario);
    await undoAndRequery(fixture, scenario);
  } finally {
    await cleanupRenameFixture(fixture);
  }
}

async function openRenameFixture(): Promise<RenameFixture> {
  const declarations = await openOverlay(DECLARATIONS_FILE, RENAME_DECLARATIONS_SOURCE);
  const usages = await openOverlay(USAGES_FILE, RENAME_USAGES_SOURCE);
  assert.ok(declarations.document.isDirty);
  assert.ok(usages.document.isDirty);
  assert.notStrictEqual(declarations.uri.toString(), usages.uri.toString());
  return { declarations, usages };
}

function interiorPosition(range: vscode.Range): vscode.Position {
  const width = range.end.character - range.start.character;
  return range.start.translate(0, Math.min(1, Math.max(0, width - 1)));
}

async function assertPrepare(
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

async function inspectRenameEdit(
  edit: vscode.WorkspaceEdit,
  scenario: RenameScenario,
): Promise<void> {
  assert.strictEqual(editCount(edit), scenario.minimumEdits, 'rename edit count must be exact');
  assert.strictEqual(edit.size, scenario.crossFile ? 2 : 1);
  assert.deepStrictEqual(changedFileNames(edit).sort(), expectedFiles(scenario));
  const snapshots = await assertWorkspaceEditSafe(edit);
  assert.strictEqual(snapshots.length, scenario.crossFile ? 2 : 1);
  assert.ok(snapshots.every((snapshot) => snapshot.edits.length > 0));
  assert.ok(snapshots.flatMap((snapshot) => snapshot.edits)
    .every((textEdit) => textEdit.newText === scenario.newName));
  assert.ok(snapshots.flatMap((snapshot) => snapshot.replacedText)
    .every((text) => text === scenario.target));
}

function expectedFiles(scenario: RenameScenario): string[] {
  return scenario.crossFile
    ? ['RenameDeclarations.fs', 'RenameUsages.fs']
    : ['RenameDeclarations.fs'];
}

async function applyAndVerify(
  fixture: RenameFixture,
  edit: vscode.WorkspaceEdit,
  scenario: RenameScenario,
): Promise<void> {
  const declarationVersion = fixture.declarations.document.version;
  const usageVersion = fixture.usages.document.version;
  const snapshots = await applyWorkspaceEdit(edit);
  assert.strictEqual(snapshots.length, scenario.crossFile ? 2 : 1);
  assert.ok(fixture.declarations.document.version > declarationVersion);
  assertUsageVersion(fixture, usageVersion, scenario.crossFile);
  assertRenamedText(fixture, scenario);
  await assertNoCompilerErrors(fixture);
  const newRange = tokenRange(fixture.declarations.document, scenario.newName);
  await assertPrepare(
    fixture.declarations.uri, newRange, interiorPosition(newRange), scenario.newName,
  );
}

function assertUsageVersion(
  fixture: RenameFixture,
  before: number,
  changed: boolean,
): void {
  if (changed) assert.ok(fixture.usages.document.version > before);
  else assert.strictEqual(fixture.usages.document.version, before);
  assert.ok(fixture.declarations.document.isDirty);
  assert.ok(fixture.usages.document.isDirty);
}

function assertRenamedText(fixture: RenameFixture, scenario: RenameScenario): void {
  const declarationCode = sourceWithoutSentinels(fixture.declarations.document.getText());
  const usageCode = sourceWithoutSentinels(fixture.usages.document.getText());
  const changedCode = declarationCode + usageCode;
  assert.strictEqual(countOccurrences(changedCode, scenario.newName), scenario.minimumEdits);
  assert.strictEqual(countOccurrences(changedCode, scenario.target), 0);
  assertSentinels(fixture.declarations.document.getText());
  assertSentinels(fixture.usages.document.getText());
}

function sourceWithoutSentinels(source: string): string {
  return source.split('\n').filter((line) =>
    !line.trimStart().startsWith('//') && !line.includes('let textSentinel ='),
  ).join('\n');
}

function assertSentinels(source: string): void {
  assert.ok(source.includes(`// ${RENAME_SENTINEL}`));
  assert.ok(source.includes(`let textSentinel = "${RENAME_SENTINEL}"`));
  assert.strictEqual(countOccurrences(source, RENAME_SENTINEL), 2);
}

async function assertNoCompilerErrors(fixture: RenameFixture): Promise<void> {
  const noErrors = (items: readonly vscode.Diagnostic[]): boolean =>
    items.every((item) => item.severity !== vscode.DiagnosticSeverity.Error);
  const declarations = await waitForMatchingDiagnostics(
    fixture.declarations.uri, noErrors, FSHARP_REFACTOR_TIMEOUT_MS,
  );
  const usages = await waitForMatchingDiagnostics(
    fixture.usages.uri, noErrors, FSHARP_REFACTOR_TIMEOUT_MS,
  );
  assert.ok(noErrors(declarations));
  assert.ok(noErrors(usages));
}

async function undoAndRequery(
  fixture: RenameFixture,
  scenario: RenameScenario,
): Promise<void> {
  await undoAction(fixture.declarations.document, RENAME_DECLARATIONS_SOURCE);
  assert.strictEqual(fixture.usages.document.getText(), RENAME_USAGES_SOURCE);
  assert.ok(fixture.usages.document.isDirty);
  const range = tokenRange(fixture.declarations.document, scenario.target);
  const position = interiorPosition(range);
  await assertPrepare(fixture.declarations.uri, range, position, scenario.target);
  const replay = await requestRename(
    fixture.declarations.uri, position, scenario.newName, FSHARP_REFACTOR_TIMEOUT_MS,
  );
  assert.strictEqual(editCount(replay), scenario.minimumEdits);
  assert.deepStrictEqual(changedFileNames(replay).sort(), expectedFiles(scenario));
}

async function cleanupRenameFixture(fixture: RenameFixture): Promise<void> {
  await revertDocument(fixture.usages.document);
  await revertDocument(fixture.declarations.document);
  assert.ok(!fixture.usages.document.isDirty);
  assert.ok(!fixture.declarations.document.isDirty);
}
