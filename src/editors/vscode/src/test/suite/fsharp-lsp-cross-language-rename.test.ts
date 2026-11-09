import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  assertNoErrorDiagnostics,
  changedFileNames,
  countOccurrences,
  editCount,
  assertPrepareRename,
  renamePreparedToken,
  requestRename,
  tokenRange,
} from './fsharp-refactor-test-kit';
import {
  applyWorkspaceEdit,
  assertWorkspaceEditSafe,
  openFixtureDocument,
  type OpenFixture,
  fullDocumentRange,
} from './refactor-test-helpers';
import { rebuildAndRestartRealLsp } from './cross-language-kit';
import { closeAllEditors } from './test-helpers';
import { fileNameOf } from '../../paths';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

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

/** The two language fixtures one rename crosses. */
interface CrossRenameSite {
  readonly originFile: string;
  readonly foreignFile: string;
}

/** The C# fixture owns the symbol; the F# fixture references it. */
const CSHARP_ORIGIN: CrossRenameSite = {
  originFile: 'CrossLanguageCSharp.cs',
  foreignFile: 'fsharp/CrossLanguage.fs',
};

/** The F# fixture owns the symbol; the C# fixture references it. */
const FSHARP_ORIGIN: CrossRenameSite = {
  originFile: 'fsharp/CrossLanguage.fs',
  foreignFile: 'crosslanguage/FSharpConsumer.cs',
};

interface CrossRenameFixture {
  readonly origin: OpenFixture;
  readonly foreign: OpenFixture;
  readonly originalOrigin: string;
  readonly originalForeign: string;
}

/** Every cross-language case, as the arguments `crossRenameSpec` takes. */
const CROSS_RENAMES: readonly (readonly [string, CrossRenameSite, string, string, number])[] = [
  ['C# origin -> F# reference', CSHARP_ORIGIN, 'CSharpOrigin', 'BridgedCSharpType', 2],
  ['F# origin -> C# reference', FSHARP_ORIGIN, 'FSharpOrigin', 'BridgedFSharpType', 3],
  ['C# member -> F# reference', CSHARP_ORIGIN, 'CSharpValue', 'BridgedCSharpMember', 2],
  ['F# member -> C# reference', FSHARP_ORIGIN, 'FSharpValue', 'BridgedFSharpMember', 2],
];

function crossLanguageSpecs(): readonly CrossRenameSpec[] {
  return CROSS_RENAMES.map(([name, site, target, newName, originOccurrences]) =>
    crossRenameSpec(name, site, target, newName, originOccurrences),
  );
}

suite('Real LSP - cross-language rename', () => {
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await rebuildAndRestartRealLsp();
  });
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);

  for (const spec of crossLanguageSpecs()) {
    test(`${spec.name} edits both languages, applies, and reverses`, async function () {
      this.timeout(DOTNET_CLI_MS);
      await runCrossLanguageRename(spec);
    });
  }
});

/** One cross-language rename: `target` becomes `newName` in both language fixtures. */
function crossRenameSpec(
  name: string,
  site: CrossRenameSite,
  target: string,
  newName: string,
  originOccurrences: number,
  foreignOccurrences = 1,
): CrossRenameSpec {
  return {
    name,
    ...site,
    target,
    newName,
    expectedFiles: [fileNameOf(site.originFile), fileNameOf(site.foreignFile)],
    originOccurrences,
    foreignOccurrences,
  };
}

async function runCrossLanguageRename(spec: CrossRenameSpec): Promise<void> {
  const fixture = await openCrossRenameFixture(spec);
  let completed = false;
  try {
    await runCrossLanguageLifecycle(fixture, spec);
    completed = true;
  } finally {
    if (!completed) await restoreOriginalFixture(fixture);
  }
}

async function openCrossRenameFixture(spec: CrossRenameSpec): Promise<CrossRenameFixture> {
  const origin = await openFixtureDocument(spec.originFile);
  const foreign = await openFixtureDocument(spec.foreignFile);
  return {
    origin,
    foreign,
    originalOrigin: origin.document.getText(),
    originalForeign: foreign.document.getText(),
  };
}

async function runCrossLanguageLifecycle(
  fixture: CrossRenameFixture,
  spec: CrossRenameSpec,
): Promise<void> {
  assertInitialSources(fixture.origin, fixture.foreign, spec);
  const range = tokenRange(fixture.origin.document, spec.target);
  await assertPrepare(fixture.origin.uri, range, spec.target);
  const edit = await requestRename(
    fixture.origin.uri,
    range.start.translate(0, 1),
    spec.newName,
    LSP_RESPONSE_MS,
  );
  await assertCrossLanguageEdit(edit, spec.target, spec.newName, spec);
  await applyCrossLanguageEdit(fixture, edit, spec);
  await reverseCrossLanguageEdit(fixture, spec);
}

function assertInitialSources(
  origin: OpenFixture,
  foreign: OpenFixture,
  spec: CrossRenameSpec,
): void {
  assert.ok(!origin.document.isDirty);
  assert.ok(!foreign.document.isDirty);
  assert.strictEqual(
    countOccurrences(origin.document.getText(), spec.target),
    spec.originOccurrences,
  );
  assert.strictEqual(
    countOccurrences(foreign.document.getText(), spec.target),
    spec.foreignOccurrences,
  );
  assert.strictEqual(countOccurrences(origin.document.getText(), spec.newName), 0);
  assert.strictEqual(countOccurrences(foreign.document.getText(), spec.newName), 1);
  assert.notStrictEqual(origin.uri.toString(), foreign.uri.toString());
}

async function assertPrepare(
  uri: vscode.Uri,
  range: vscode.Range,
  placeholder: string,
): Promise<void> {
  await assertPrepareRename(uri, range, range.start.translate(0, 1), placeholder);
}

async function assertCrossLanguageEdit(
  edit: vscode.WorkspaceEdit,
  oldName: string,
  newName: string,
  spec: CrossRenameSpec,
): Promise<void> {
  const expectedCount = spec.originOccurrences + spec.foreignOccurrences;
  const files = changedFileNames(edit);
  assert.strictEqual(
    edit.size,
    2,
    `both language documents must be present; files=${JSON.stringify(files)} edits=${editCount(edit)}`,
  );
  assert.strictEqual(editCount(edit), expectedCount);
  assert.deepStrictEqual(files.sort(), [...spec.expectedFiles].sort());
  const snapshots = await assertWorkspaceEditSafe(edit);
  assert.strictEqual(snapshots.length, 2);
  assert.ok(snapshots.every((item) => item.edits.length >= 1));
  assertSnapshotTexts(snapshots, oldName, newName);
}

function assertSnapshotTexts(
  snapshots: Awaited<ReturnType<typeof assertWorkspaceEditSafe>>,
  oldName: string,
  newName: string,
): void {
  const replaced = snapshots.flatMap((item) => item.replacedText);
  const inserted = snapshots.flatMap((item) => item.edits).map((item) => item.newText);
  assert.ok(
    replaced.every((text) => text === oldName),
    `replaced ${JSON.stringify(replaced)}`,
  );
  assert.ok(
    inserted.every((text) => text === newName),
    `inserted ${JSON.stringify(inserted)}`,
  );
}

async function applyCrossLanguageEdit(
  fixture: CrossRenameFixture,
  edit: vscode.WorkspaceEdit,
  spec: CrossRenameSpec,
): Promise<void> {
  await applyToBoth(fixture, edit);
  assertAppliedTexts(fixture, spec);
  await persistFixtureState(fixture);
}

/** Apply `edit` to both language documents, proving each overlay advanced. */
async function applyToBoth(fixture: CrossRenameFixture, edit: vscode.WorkspaceEdit): Promise<void> {
  const originVersion = fixture.origin.document.version;
  const foreignVersion = fixture.foreign.document.version;
  await applyWorkspaceEdit(edit);
  assert.ok(fixture.origin.document.version > originVersion);
  assert.ok(fixture.foreign.document.version > foreignVersion);
}

function assertAppliedTexts(fixture: CrossRenameFixture, spec: CrossRenameSpec): void {
  assert.strictEqual(
    fixture.origin.document.getText(),
    fixture.originalOrigin.replaceAll(spec.target, spec.newName),
  );
  assert.strictEqual(
    fixture.foreign.document.getText(),
    fixture.originalForeign.replaceAll(spec.target, spec.newName),
  );
  assert.ok(fixture.origin.document.isDirty);
  assert.ok(fixture.foreign.document.isDirty);
  assert.strictEqual(
    countOccurrences(fixture.origin.document.getText(), spec.newName),
    spec.originOccurrences,
  );
  assert.strictEqual(countOccurrences(fixture.foreign.document.getText(), spec.newName), 2);
}

async function reverseCrossLanguageEdit(
  fixture: CrossRenameFixture,
  spec: CrossRenameSpec,
): Promise<void> {
  const reverse = await requestReverseEdit(fixture, spec);
  await assertCrossLanguageEdit(reverse, spec.newName, spec.target, spec);
  await applyToBoth(fixture, reverse);
  assertOriginalTexts(fixture, spec);
  await assertOriginalPrepare(fixture, spec);
  await persistFixtureState(fixture);
  await assertOriginalPrepare(fixture, spec);
}

async function requestReverseEdit(
  fixture: CrossRenameFixture,
  spec: CrossRenameSpec,
): Promise<vscode.WorkspaceEdit> {
  const { edit } = await renamePreparedToken(fixture.origin, spec.newName, spec.target);
  return edit;
}

async function assertOriginalPrepare(
  fixture: CrossRenameFixture,
  spec: CrossRenameSpec,
): Promise<void> {
  await assertPrepare(
    fixture.origin.uri,
    tokenRange(fixture.origin.document, spec.target),
    spec.target,
  );
}

/** Both documents hold exactly the text they were opened with. */
function assertOriginalContent(fixture: CrossRenameFixture): void {
  assert.strictEqual(fixture.origin.document.getText(), fixture.originalOrigin);
  assert.strictEqual(fixture.foreign.document.getText(), fixture.originalForeign);
}

function assertOriginalTexts(fixture: CrossRenameFixture, spec: CrossRenameSpec): void {
  assertOriginalContent(fixture);
  assert.ok(fixture.origin.document.isDirty);
  assert.ok(fixture.foreign.document.isDirty);
  assert.strictEqual(countOccurrences(fixture.origin.document.getText(), spec.newName), 0);
  assert.strictEqual(countOccurrences(fixture.foreign.document.getText(), spec.newName), 1);
}

/** Both language documents carry no Error diagnostics. */
async function assertBothErrorFree(fixture: CrossRenameFixture): Promise<void> {
  await assertNoErrorDiagnostics(fixture.origin.uri);
  await assertNoErrorDiagnostics(fixture.foreign.uri);
}

async function persistFixtureState(fixture: CrossRenameFixture): Promise<void> {
  const expectedOrigin = fixture.origin.document.getText();
  const expectedForeign = fixture.foreign.document.getText();
  await saveFixtureDocuments(fixture);
  await assertFixtureDisk(fixture, expectedOrigin, expectedForeign);
  await rebuildAndRestartRealLsp();
  assert.strictEqual(fixture.origin.document.getText(), expectedOrigin);
  assert.strictEqual(fixture.foreign.document.getText(), expectedForeign);
  assertBothSaved(fixture);
  await assertBothErrorFree(fixture);
}

/** Both language documents match what is on disk. */
function assertBothSaved(fixture: CrossRenameFixture): void {
  assert.ok(!fixture.origin.document.isDirty);
  assert.ok(!fixture.foreign.document.isDirty);
}

async function saveFixtureDocuments(fixture: CrossRenameFixture): Promise<void> {
  const originVersion = fixture.origin.document.version;
  const foreignVersion = fixture.foreign.document.version;
  assert.strictEqual(fixture.origin.uri.scheme, 'file');
  assert.strictEqual(fixture.foreign.uri.scheme, 'file');
  assert.ok(await fixture.origin.document.save(), 'origin document must save');
  assert.ok(await fixture.foreign.document.save(), 'foreign document must save');
  assert.strictEqual(fixture.origin.document.version, originVersion);
  assert.strictEqual(fixture.foreign.document.version, foreignVersion);
  assertBothSaved(fixture);
}

async function assertFixtureDisk(
  fixture: CrossRenameFixture,
  expectedOrigin: string,
  expectedForeign: string,
): Promise<void> {
  const [originDisk, foreignDisk] = await Promise.all([
    readFile(fixture.origin.uri.fsPath, 'utf8'),
    readFile(fixture.foreign.uri.fsPath, 'utf8'),
  ]);
  assert.strictEqual(originDisk, expectedOrigin);
  assert.strictEqual(foreignDisk, expectedForeign);
}

async function restoreOriginalFixture(fixture: CrossRenameFixture): Promise<void> {
  const restoration = new vscode.WorkspaceEdit();
  restoration.replace(
    fixture.origin.uri,
    fullDocumentRange(fixture.origin.document),
    fixture.originalOrigin,
  );
  restoration.replace(
    fixture.foreign.uri,
    fullDocumentRange(fixture.foreign.document),
    fixture.originalForeign,
  );
  await applyWorkspaceEdit(restoration);
  assertOriginalContent(fixture);
  await persistFixtureState(fixture);
}
