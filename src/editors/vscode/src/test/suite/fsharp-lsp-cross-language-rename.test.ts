import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  FSHARP_REFACTOR_TIMEOUT_MS,
  changedFileNames,
  editCount,
  requestPrepareRename,
  requestRename,
  tokenRange,
} from './fsharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  applyWorkspaceEdit,
  assertWorkspaceEditSafe,
  openFixtureDocument,
  revertDocument,
  waitForMatchingDiagnostics,
  type OpenFixture,
} from './refactor-test-helpers';
import { closeAllEditors } from './test-helpers';

// Both foreign-sidecar directions are mandatory. [RENAME-CROSSLANGUAGE]
interface CrossRenameSpec {
  readonly name: string;
  readonly originFile: string;
  readonly foreignFile: string;
  readonly target: string;
  readonly newName: string;
  readonly expectedFiles: readonly string[];
  readonly originOccurrences: number;
  readonly foreignOccurrences: number;
}

suite('Real LSP — cross-language rename', () => {
  suiteSetup(activateRealSharpLsp);
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);

  for (const spec of crossLanguageSpecs()) {
    test(`${spec.name} edits both languages, applies, and reverses`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 3);
      await runCrossLanguageRename(spec);
    });
  }
});

function crossLanguageSpecs(): readonly CrossRenameSpec[] {
  return [
    {
      name: 'C# origin → F# reference', originFile: 'CrossLanguageCSharp.cs',
      foreignFile: 'fsharp/CrossLanguage.fs', target: 'CSharpOrigin',
      newName: 'RenamedCSharpOrigin',
      expectedFiles: ['CrossLanguage.fs', 'CrossLanguageCSharp.cs'],
      originOccurrences: 2, foreignOccurrences: 1,
    },
    {
      name: 'F# origin → C# reference', originFile: 'fsharp/CrossLanguage.fs',
      foreignFile: 'crosslanguage/FSharpConsumer.cs', target: 'FSharpOrigin',
      newName: 'RenamedFSharpOrigin',
      expectedFiles: ['CrossLanguage.fs', 'FSharpConsumer.cs'],
      originOccurrences: 2, foreignOccurrences: 1,
    },
  ];
}

async function runCrossLanguageRename(spec: CrossRenameSpec): Promise<void> {
  const origin = await openFixtureDocument(spec.originFile);
  const foreign = await openFixtureDocument(spec.foreignFile);
  const originalOrigin = origin.document.getText();
  const originalForeign = foreign.document.getText();
  try {
    assertInitialSources(origin, foreign, spec);
    const range = tokenRange(origin.document, spec.target);
    await assertPrepare(origin.uri, range, spec.target);
    const edit = await requestRename(
      origin.uri, range.start.translate(0, 1), spec.newName, FSHARP_REFACTOR_TIMEOUT_MS,
    );
    await assertCrossLanguageEdit(edit, spec.target, spec.newName, spec);
    await applyCrossLanguageEdit(origin, foreign, edit, originalOrigin, originalForeign, spec);
    await reverseCrossLanguageEdit(origin, foreign, originalOrigin, originalForeign, spec);
  } finally {
    await revertDocument(foreign.document);
    await revertDocument(origin.document);
  }
}

function assertInitialSources(
  origin: OpenFixture,
  foreign: OpenFixture,
  spec: CrossRenameSpec,
): void {
  assert.ok(!origin.document.isDirty);
  assert.ok(!foreign.document.isDirty);
  assert.strictEqual(count(origin.document.getText(), spec.target), spec.originOccurrences);
  assert.strictEqual(count(foreign.document.getText(), spec.target), spec.foreignOccurrences);
  assert.notStrictEqual(origin.uri.toString(), foreign.uri.toString());
}

async function assertPrepare(
  uri: vscode.Uri,
  range: vscode.Range,
  placeholder: string,
): Promise<void> {
  const prepare = await requestPrepareRename(uri, range.start.translate(0, 1));
  assert.ok(prepare);
  assert.strictEqual(prepare.placeholder, placeholder);
  assert.strictEqual(prepare.range.start.line, range.start.line);
  assert.strictEqual(prepare.range.start.character, range.start.character);
  assert.strictEqual(prepare.range.end.line, range.end.line);
  assert.strictEqual(prepare.range.end.character, range.end.character);
}

async function assertCrossLanguageEdit(
  edit: vscode.WorkspaceEdit,
  oldName: string,
  newName: string,
  spec: CrossRenameSpec,
): Promise<void> {
  const expectedCount = spec.originOccurrences + spec.foreignOccurrences;
  assert.strictEqual(edit.size, 2, 'both language documents must be present');
  assert.strictEqual(editCount(edit), expectedCount);
  assert.deepStrictEqual(changedFileNames(edit).sort(), [...spec.expectedFiles].sort());
  const snapshots = await assertWorkspaceEditSafe(edit);
  assert.strictEqual(snapshots.length, 2);
  assert.ok(snapshots.every((item) => item.edits.length >= 1));
  assert.ok(snapshots.flatMap((item) => item.replacedText).every((text) => text === oldName));
  assert.ok(snapshots.flatMap((item) => item.edits).every((item) => item.newText === newName));
}

async function applyCrossLanguageEdit(
  origin: OpenFixture,
  foreign: OpenFixture,
  edit: vscode.WorkspaceEdit,
  originalOrigin: string,
  originalForeign: string,
  spec: CrossRenameSpec,
): Promise<void> {
  const originVersion = origin.document.version;
  const foreignVersion = foreign.document.version;
  await applyWorkspaceEdit(edit);
  assert.ok(origin.document.version > originVersion);
  assert.ok(foreign.document.version > foreignVersion);
  assert.strictEqual(origin.document.getText(), originalOrigin.replaceAll(spec.target, spec.newName));
  assert.strictEqual(foreign.document.getText(), originalForeign.replaceAll(spec.target, spec.newName));
  assert.ok(origin.document.isDirty);
  assert.ok(foreign.document.isDirty);
  await assertNoErrors(origin.uri);
  await assertNoErrors(foreign.uri);
}

async function reverseCrossLanguageEdit(
  origin: OpenFixture,
  foreign: OpenFixture,
  originalOrigin: string,
  originalForeign: string,
  spec: CrossRenameSpec,
): Promise<void> {
  const range = tokenRange(origin.document, spec.newName);
  await assertPrepare(origin.uri, range, spec.newName);
  const reverse = await requestRename(
    origin.uri, range.start.translate(0, 1), spec.target, FSHARP_REFACTOR_TIMEOUT_MS,
  );
  await assertCrossLanguageEdit(reverse, spec.newName, spec.target, spec);
  await applyWorkspaceEdit(reverse);
  assert.strictEqual(origin.document.getText(), originalOrigin);
  assert.strictEqual(foreign.document.getText(), originalForeign);
  assert.ok(origin.document.isDirty);
  assert.ok(foreign.document.isDirty);
  await assertPrepare(origin.uri, tokenRange(origin.document, spec.target), spec.target);
}

async function assertNoErrors(uri: vscode.Uri): Promise<void> {
  const diagnostics = await waitForMatchingDiagnostics(
    uri,
    (items) => items.every((item) => item.severity !== vscode.DiagnosticSeverity.Error),
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
  assert.ok(diagnostics.every((item) => item.severity !== vscode.DiagnosticSeverity.Error));
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
