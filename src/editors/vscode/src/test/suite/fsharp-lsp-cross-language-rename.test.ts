import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
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
  waitForMatchingDiagnostics,
  workspaceFixturePath,
  type OpenFixture,
} from './refactor-test-helpers';
import { closeAllEditors } from './test-helpers';

const execFileAsync = promisify(execFile);
const FIXTURE_SOLUTION = workspaceFixturePath('TestFixtures.slnx');
const RESTART_COMMAND = 'sharplsp.restartServer';

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

interface CrossRenameFixture {
  readonly origin: OpenFixture;
  readonly foreign: OpenFixture;
  readonly originalOrigin: string;
  readonly originalForeign: string;
}

interface BuildArtifact {
  readonly source: string;
  readonly output: string;
}

suite('Real LSP - cross-language rename', () => {
  suiteSetup(async function () {
    this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
    await rebuildAndRestartRealLsp();
  });
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);

  for (const spec of crossLanguageSpecs()) {
    test(`${spec.name} edits both languages, applies, and reverses`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 5);
      await runCrossLanguageRename(spec);
    });
  }
});

function crossLanguageSpecs(): readonly CrossRenameSpec[] {
  return [csharpOriginSpec(), fsharpOriginSpec(), csharpMemberSpec(), fsharpMemberSpec()];
}

function csharpOriginSpec(): CrossRenameSpec {
  return {
    name: 'C# origin -> F# reference',
    originFile: 'CrossLanguageCSharp.cs',
    foreignFile: 'fsharp/CrossLanguage.fs',
    target: 'CSharpOrigin',
    newName: 'BridgedCSharpType',
    expectedFiles: ['CrossLanguage.fs', 'CrossLanguageCSharp.cs'],
    originOccurrences: 2,
    foreignOccurrences: 1,
  };
}

function csharpMemberSpec(): CrossRenameSpec {
  return {
    name: 'C# member -> F# reference',
    originFile: 'CrossLanguageCSharp.cs',
    foreignFile: 'fsharp/CrossLanguage.fs',
    target: 'CSharpValue',
    newName: 'BridgedCSharpMember',
    expectedFiles: ['CrossLanguage.fs', 'CrossLanguageCSharp.cs'],
    originOccurrences: 2,
    foreignOccurrences: 1,
  };
}

function fsharpMemberSpec(): CrossRenameSpec {
  return {
    name: 'F# member -> C# reference',
    originFile: 'fsharp/CrossLanguage.fs',
    foreignFile: 'crosslanguage/FSharpConsumer.cs',
    target: 'FSharpValue',
    newName: 'BridgedFSharpMember',
    expectedFiles: ['CrossLanguage.fs', 'FSharpConsumer.cs'],
    originOccurrences: 2,
    foreignOccurrences: 1,
  };
}

function fsharpOriginSpec(): CrossRenameSpec {
  return {
    name: 'F# origin -> C# reference',
    originFile: 'fsharp/CrossLanguage.fs',
    foreignFile: 'crosslanguage/FSharpConsumer.cs',
    target: 'FSharpOrigin',
    newName: 'BridgedFSharpType',
    expectedFiles: ['CrossLanguage.fs', 'FSharpConsumer.cs'],
    originOccurrences: 3,
    foreignOccurrences: 1,
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
    FSHARP_REFACTOR_TIMEOUT_MS,
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
  assert.strictEqual(count(origin.document.getText(), spec.target), spec.originOccurrences);
  assert.strictEqual(count(foreign.document.getText(), spec.target), spec.foreignOccurrences);
  assert.strictEqual(count(origin.document.getText(), spec.newName), 0);
  assert.strictEqual(count(foreign.document.getText(), spec.newName), 1);
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
  const originVersion = fixture.origin.document.version;
  const foreignVersion = fixture.foreign.document.version;
  await applyWorkspaceEdit(edit);
  assert.ok(fixture.origin.document.version > originVersion);
  assert.ok(fixture.foreign.document.version > foreignVersion);
  assertAppliedTexts(fixture, spec);
  await persistFixtureState(fixture);
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
    count(fixture.origin.document.getText(), spec.newName),
    spec.originOccurrences,
  );
  assert.strictEqual(count(fixture.foreign.document.getText(), spec.newName), 2);
}

async function reverseCrossLanguageEdit(
  fixture: CrossRenameFixture,
  spec: CrossRenameSpec,
): Promise<void> {
  const reverse = await requestReverseEdit(fixture, spec);
  await assertCrossLanguageEdit(reverse, spec.newName, spec.target, spec);
  const originVersion = fixture.origin.document.version;
  const foreignVersion = fixture.foreign.document.version;
  await applyWorkspaceEdit(reverse);
  assert.ok(fixture.origin.document.version > originVersion);
  assert.ok(fixture.foreign.document.version > foreignVersion);
  assertOriginalTexts(fixture, spec);
  await assertOriginalPrepare(fixture, spec);
  await persistFixtureState(fixture);
  await assertOriginalPrepare(fixture, spec);
}

async function requestReverseEdit(
  fixture: CrossRenameFixture,
  spec: CrossRenameSpec,
): Promise<vscode.WorkspaceEdit> {
  const range = tokenRange(fixture.origin.document, spec.newName);
  await assertPrepare(fixture.origin.uri, range, spec.newName);
  return requestRename(
    fixture.origin.uri,
    range.start.translate(0, 1),
    spec.target,
    FSHARP_REFACTOR_TIMEOUT_MS,
  );
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

function assertOriginalTexts(fixture: CrossRenameFixture, spec: CrossRenameSpec): void {
  assert.strictEqual(fixture.origin.document.getText(), fixture.originalOrigin);
  assert.strictEqual(fixture.foreign.document.getText(), fixture.originalForeign);
  assert.ok(fixture.origin.document.isDirty);
  assert.ok(fixture.foreign.document.isDirty);
  assert.strictEqual(count(fixture.origin.document.getText(), spec.newName), 0);
  assert.strictEqual(count(fixture.foreign.document.getText(), spec.newName), 1);
}

async function assertNoErrors(uri: vscode.Uri): Promise<void> {
  try {
    const diagnostics = await waitForMatchingDiagnostics(
      uri,
      (items) => items.every((item) => item.severity !== vscode.DiagnosticSeverity.Error),
      FSHARP_REFACTOR_TIMEOUT_MS,
    );
    assert.ok(diagnostics.every((item) => item.severity !== vscode.DiagnosticSeverity.Error));
  } catch (error: unknown) {
    assert.fail(`diagnostics for ${uri.fsPath}: ${diagnosticSummary(uri)}; wait=${String(error)}`);
  }
}

function diagnosticSummary(uri: vscode.Uri): string {
  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (diagnostics.length === 0) return '<none>';
  return diagnostics
    .map((item) => {
      const start = `${item.range.start.line}:${item.range.start.character}`;
      return `[${item.severity}/${String(item.code ?? 'none')}@${start}] ${item.message}`;
    })
    .join(' | ');
}

async function persistFixtureState(fixture: CrossRenameFixture): Promise<void> {
  const expectedOrigin = fixture.origin.document.getText();
  const expectedForeign = fixture.foreign.document.getText();
  await saveFixtureDocuments(fixture);
  await assertFixtureDisk(fixture, expectedOrigin, expectedForeign);
  await rebuildAndRestartRealLsp();
  assert.strictEqual(fixture.origin.document.getText(), expectedOrigin);
  assert.strictEqual(fixture.foreign.document.getText(), expectedForeign);
  assert.ok(!fixture.origin.document.isDirty);
  assert.ok(!fixture.foreign.document.isDirty);
  await assertNoErrors(fixture.origin.uri);
  await assertNoErrors(fixture.foreign.uri);
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
  assert.ok(!fixture.origin.document.isDirty);
  assert.ok(!fixture.foreign.document.isDirty);
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

async function rebuildAndRestartRealLsp(): Promise<void> {
  await buildCrossLanguageFixtures();
  const client = await activateRealSharpLsp();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(RESTART_COMMAND), `${RESTART_COMMAND} must be registered`);
  await vscode.commands.executeCommand(RESTART_COMMAND);
  const restarted = await activateRealSharpLsp();
  assert.strictEqual(restarted, client, 'restart must leave the real LanguageClient running');
}

async function buildCrossLanguageFixtures(): Promise<void> {
  const result = await execFileAsync(
    'dotnet',
    ['build', FIXTURE_SOLUTION, '--configuration', 'Debug', '--nologo', '--verbosity', 'minimal'],
    { cwd: path.dirname(FIXTURE_SOLUTION), encoding: 'utf8', timeout: FSHARP_REFACTOR_TIMEOUT_MS },
  );
  assert.strictEqual(typeof result.stdout, 'string');
  assert.strictEqual(typeof result.stderr, 'string');
  assert.ok(result.stdout.trim().length > 0, 'real fixture build must report output');
  await Promise.all(buildArtifacts().map(assertArtifactFresh));
}

function buildArtifacts(): readonly BuildArtifact[] {
  return [
    {
      source: workspaceFixturePath('CrossLanguageCSharp.cs'),
      output: workspaceFixturePath('bin/Debug/net10.0/TestFixtures.dll'),
    },
    {
      source: workspaceFixturePath('fsharp/CrossLanguage.fs'),
      output: workspaceFixturePath('fsharp/bin/Debug/net10.0/FSharpFixtures.dll'),
    },
    {
      source: workspaceFixturePath('crosslanguage/FSharpConsumer.cs'),
      output: workspaceFixturePath('crosslanguage/bin/Debug/net10.0/CSharpConsumer.dll'),
    },
  ];
}

async function assertArtifactFresh(artifact: BuildArtifact): Promise<void> {
  const [sourceStats, outputStats] = await Promise.all([
    stat(artifact.source),
    stat(artifact.output),
  ]);
  assert.ok(sourceStats.isFile(), `${artifact.source} must be a source file`);
  assert.ok(outputStats.isFile(), `${artifact.output} must be a real assembly`);
  assert.ok(outputStats.size > 0, `${artifact.output} must not be empty`);
  assert.ok(
    outputStats.mtimeMs >= sourceStats.mtimeMs,
    `${artifact.output} is stale relative to ${artifact.source}`,
  );
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
  assert.strictEqual(fixture.origin.document.getText(), fixture.originalOrigin);
  assert.strictEqual(fixture.foreign.document.getText(), fixture.originalForeign);
  await persistFixtureState(fixture);
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    document.positionAt(document.getText().length),
  );
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
