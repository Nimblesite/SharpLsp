import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateWarmFSharp,
  assertFixApplied,
  assertInsertion,
  assertReplacement,
  diagnosticWithCode,
  diagnosticsSettled,
  openOverlay,
  quickFixes,
  resolvedQuickFixes,
  singleEdit,
  tokenRange,
  uniqueAction,
} from './fsharp-refactor-test-kit';
import { revertDocument } from './refactor-test-helpers';
import { closeAllEditors } from './test-helpers';
import { LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

// Real-project Ctrl-. coverage for [REFACTOR-IMPORT-FSHARP]. No mocked provider.
const TARGET_FILE = 'fsharp/DiagnosticsTarget.fs';
const SOURCE =
  'module FSharpFixtures.ImportFixes\n\nlet value = Path.GetTempPath()\nlet sentinel = 57\n';
const OPEN_TITLE = "Add 'open System.IO' — imports every type and module in namespace System.IO";
const QUALIFY_TITLE = "Change 'Path' to 'System.IO.Path' — qualifies this one use; no open added";

suite('F# real LSP — import fixes', () => {
  suiteSetup(async function () {
    this.timeout(SIDECAR_COLD_MS);
    await activateWarmFSharp(TARGET_FILE, SOURCE, 'FS0039');
  });
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);

  test('namespace row lists explicit titles, inserts the exact open, and clears FS0039', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const fixture = await openOverlay(TARGET_FILE, SOURCE);
    try {
      const range = tokenRange(fixture.document, 'Path');
      const diagnostics = await diagnosticWithCode(fixture.uri, 'FS0039', range);
      assert.ok(diagnostics.some((diagnostic) => diagnostic.range.isEqual(range)));
      const listed = await quickFixes(fixture.uri, range);
      assert.ok(listed.some((action) => action.title === OPEN_TITLE));
      assert.ok(listed.some((action) => action.title === QUALIFY_TITLE));
      const actions = await resolvedQuickFixes(fixture.uri, range, OPEN_TITLE);
      const action = uniqueAction(actions, OPEN_TITLE);
      assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
      assert.strictEqual(action.isPreferred, false);
      const edit = singleEdit(action, fixture.uri);
      assertInsertion(edit, 'open System.IO\n');
      assert.strictEqual(edit.range.start.line, 2);
      assert.strictEqual(edit.range.start.character, 0);
      const expected = SOURCE.replace('\n\nlet value', '\n\nopen System.IO\nlet value');
      await assertFixApplied(fixture, action, expected, 'FS0039', 'Path.GetTempPath');
      assert.strictEqual(fixture.document.getText(), expected);
      await diagnosticsSettled(fixture.uri, 'FS0039');
    } finally {
      await revertDocument(fixture.document);
    }
  });

  test('fully qualified row replaces only Path with exact text and clears FS0039', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const fixture = await openOverlay(TARGET_FILE, SOURCE);
    try {
      const range = tokenRange(fixture.document, 'Path');
      await diagnosticWithCode(fixture.uri, 'FS0039', range);
      const listed = await quickFixes(fixture.uri, range);
      assert.ok(listed.some((action) => action.title === OPEN_TITLE));
      assert.ok(listed.some((action) => action.title === QUALIFY_TITLE));
      const actions = await resolvedQuickFixes(fixture.uri, range, QUALIFY_TITLE);
      const action = uniqueAction(actions, QUALIFY_TITLE);
      assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
      assert.strictEqual(action.isPreferred, false);
      const edit = singleEdit(action, fixture.uri);
      assertReplacement(fixture.document, edit, 'Path', 'System.IO.Path');
      assert.ok(edit.range.isEqual(range));
      const expected = SOURCE.replace('Path.GetTempPath', 'System.IO.Path.GetTempPath');
      await assertFixApplied(fixture, action, expected, 'FS0039', 'System.IO.Path.GetTempPath');
      assert.strictEqual(fixture.document.getText(), expected);
      assert.ok(!fixture.document.getText().includes('open System.IO'));
      await diagnosticsSettled(fixture.uri, 'FS0039');
    } finally {
      await revertDocument(fixture.document);
    }
  });
});
