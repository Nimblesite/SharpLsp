// Real-LSP lifecycle for the [SHARPLSP-FEATURES-REFACTORING] organize-imports capability.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  assertFreshActionDataIds,
  assertRawActionData,
  assertRawTitles,
  assertSingleDocumentEdit,
  onlyAction,
  rangeOf,
  rawCodeActions,
  type RawCodeAction,
} from './csharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  applyWorkspaceEdit,
  openFixtureDocument,
  replaceDocumentText,
  revertDocument,
  waitForResolvedCodeActions,
  type OpenFixture,
} from './refactor-test-helpers';

const FILE = 'RefactorCore.cs';
const TEST_TIMEOUT_MS = 180_000;
const TITLE = 'Sort Usings';
const SOURCE = 'using System.Text;\nusing System;\nnamespace SharpLsp.TestFixtures.Refactors;\n';

suite('C# real LSP - organize imports', () => {
  let fixture: OpenFixture;
  let committedText = '';

  suiteSetup(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await activateRealSharpLsp();
    fixture = await openFixtureDocument(FILE);
    committedText = fixture.document.getText();
  });

  teardown(async () => revertDocument(fixture.document));

  test('advertised action is listed, resolved, applied, requeried, and reverted', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await runOrganizeImports(fixture, committedText);
  });
});

async function discover(
  fixture: OpenFixture,
  range: vscode.Range,
): Promise<{ readonly action: vscode.CodeAction; readonly raw: RawCodeAction[] }> {
  const raw = await rawCodeActions(fixture.uri, range);
  assertRawTitles(raw, [TITLE], 'source.organizeImports');
  assertRawActionData(raw, fixture.uri);
  const actions = await waitForResolvedCodeActions({
    uri: fixture.uri,
    range,
    kind: vscode.CodeActionKind.SourceOrganizeImports,
    predicate: (items) => items.some((item) => item.title === TITLE && item.edit),
  });
  const action = onlyAction(actions, TITLE);
  assert.ok(action.edit);
  assert.strictEqual(action.kind?.value, 'source.organizeImports');
  return { action, raw };
}

function assertApplied(fixture: OpenFixture, previousVersion: number): void {
  assert.ok(fixture.document.version > previousVersion);
  assert.ok(fixture.document.isDirty);
  const source = fixture.document.getText();
  assert.ok(source.startsWith('using System;\nusing System.Text;'));
  assert.ok(source.endsWith('namespace SharpLsp.TestFixtures.Refactors;\n'));
  assert.ok(!source.startsWith('using System.Text;\nusing System;'));
}

async function runOrganizeImports(fixture: OpenFixture, committedText: string): Promise<void> {
  await replaceDocumentText(fixture.document, SOURCE);
  const range = rangeOf(fixture.document, 'using System.Text;');
  const discovered = await discover(fixture, range);
  const version = fixture.document.version;
  const snapshots = await applyWorkspaceEdit(discovered.action.edit!);
  assertSingleDocumentEdit(snapshots, fixture);
  assertApplied(fixture, version);
  const after = await rawCodeActions(fixture.uri, rangeOf(fixture.document, 'using System;'));
  assertRawActionData(after, fixture.uri);
  assertFreshActionDataIds(after, discovered.raw);
  await revertDocument(fixture.document);
  assert.strictEqual(fixture.document.getText(), committedText);
  assert.ok(!fixture.document.isDirty);
}
