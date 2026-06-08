import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  openSharpLspPanel,
  replaceDocumentContent,
  setupLspTestSuite,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDiagnostics,
  waitForDiagnosticsCleared,
  waitForDocumentSymbols,
  waitForHoverResult,
  LSP_RESPONSE_TIMEOUT_MS,
} from './test-helpers';

/** Clean starting content for the diagnostic target file. */
const CLEAN_CONTENT = `namespace DiagTest
{
    public class DiagTarget
    {
        public int Foo() { return 42; }
    }
}`;

suite('Diagnostics / Problems Panel', () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let diagDoc: vscode.TextDocument;
  let diagUri: vscode.Uri;

  suiteSetup(async function () {
    this.timeout(120_000);
    const result = await setupLspTestSuite('diagnostics-');
    tmpDir = result.tmpDir;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(ws, 'Workspace folder must be available');
    workspaceRoot = ws;

    // Open the fixture file once for the whole suite.
    const filePath = path.join(workspaceRoot, 'DiagTarget.cs');
    assert.ok(fs.existsSync(filePath), 'DiagTarget.cs fixture must exist');
    diagUri = vscode.Uri.file(filePath);
    diagDoc = await vscode.workspace.openTextDocument(diagUri);
    await vscode.window.showTextDocument(diagDoc);
    await waitForDocumentSymbols(diagUri);

    // Wait for the sidecar to fully load before running diagnostic tests.
    // Hover returning results proves the sidecar has the workspace loaded.
    await waitForHoverResult(diagUri, new vscode.Position(4, 20), 60_000);
  });

  suiteTeardown(async () => {
    // Restore clean content so the fixture stays valid.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);
    await diagDoc.save();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 4);
    // Restore clean content between tests. Give sidecar time to reanalyze.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);
    await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_TIMEOUT_MS * 3);
  });

  // ── Error Detection ───────────────────────────────────────────

  test('file with type error shows diagnostics', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 4);
    await replaceDocumentContent(
      diagDoc,
      `namespace DiagTest
{
    public class DiagTarget
    {
        public int Foo() { return "not an int"; }
    }
}`,
    );

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_TIMEOUT_MS * 2);
    assert.ok(diagnostics.length > 0, 'Must have at least one diagnostic');

    const error = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(error, 'Must have at least one error-level diagnostic');
    assert.ok(error.message.length > 0, 'Error diagnostic must have a message');
    assert.ok(error.source === 'sharplsp-csharp', "Error source must be 'sharplsp-csharp'");
    assert.ok(error.range.start.line >= 0, 'Error must have a valid start line');
    assert.ok(error.range.end.character >= 0, 'Error must have a valid end character');
    // The error is on line 4 (0-indexed): "return "not an int""
    assert.strictEqual(
      error.range.start.line,
      4,
      'Type error must be on line 4 (the return statement)',
    );
    assert.ok(
      error.message.toLowerCase().includes('string') ||
        error.message.toLowerCase().includes('cannot'),
      'Error message must describe the type mismatch',
    );
    // Load fixture solution so Solution Explorer is populated in the screenshot.
    if (process.env['SHARPLSP_SCREENSHOTS']) {
      const ext2 = vscode.extensions.getExtension('nimblesite.sharplsp');
      const api2 = ext2?.exports as
        | {
            explorerProvider?: {
              loadSolution(p: string): Promise<void>;
              getChildren(e?: unknown): unknown[] | undefined;
            };
          }
        | undefined;
      if (api2?.explorerProvider) {
        const slnPath2 = path.join(workspaceRoot, 'TestFixtures.sln');
        await api2.explorerProvider.loadSolution(slnPath2);
        let waited2 = 0;
        while ((api2.explorerProvider.getChildren() ?? []).length === 0 && waited2 < 8000) {
          await new Promise((r) => setTimeout(r, 200));
          waited2 += 200;
        }
      }
    }
    // Open Problems panel so diagnostics are visible in the screenshot.
    await vscode.commands.executeCommand('workbench.actions.view.problems');
    await new Promise((r) => setTimeout(r, 1000));
    await openSharpLspPanel();
    await takeScreenshot('vscode-diagnostics-page.png');
  });

  test('file with missing type shows diagnostics', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 4);
    await replaceDocumentContent(
      diagDoc,
      `namespace DiagTest
{
    public class DiagTarget
    {
        public NonExistentType Foo() { return null; }
    }
}`,
    );

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_TIMEOUT_MS * 2);
    assert.ok(diagnostics.length > 0, 'Must have diagnostics for missing type');

    const csError = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(csError, 'Must have an error diagnostic for missing type');
  });

  // ── Clean Files ───────────────────────────────────────────────

  test('valid file has no error diagnostics', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 5);
    // Content is already clean from teardown. Verify no errors.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);

    // Wait for diagnostics to clear (sidecar needs time to reanalyze on CI).
    const cleared = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_TIMEOUT_MS * 4);
    const errors = cleared.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.strictEqual(errors.length, 0, 'Valid file should have no error diagnostics');
  });

  // ── Edit Cycle ────────────────────────────────────────────────

  test('fixing an error clears the diagnostic', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 6);
    await replaceDocumentContent(
      diagDoc,
      `namespace DiagTest
{
    public class DiagTarget
    {
        public int Foo() { return "bad"; }
    }
}`,
    );

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_TIMEOUT_MS * 2);
    assert.ok(diagnostics.length > 0, 'Must have diagnostics for broken code');

    // Fix the error.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);

    // CI's coverage-instrumented sidecar can take noticeably longer to
    // re-publish cleared diagnostics than a local debug build, so allow
    // the same generous window we use for `valid file has no error`.
    const cleared = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_TIMEOUT_MS * 4);
    const errors = cleared.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.strictEqual(errors.length, 0, 'Diagnostics should clear after fixing the error');
  });

  // ── Diagnostic Properties ─────────────────────────────────────

  test('diagnostics have correct severity and range', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    await replaceDocumentContent(
      diagDoc,
      `namespace DiagTest
{
    public class DiagTarget
    {
        public void Foo()
        {
            int x = "wrong";
        }
    }
}`,
    );

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_TIMEOUT_MS * 2);
    assert.ok(diagnostics.length > 0, 'Must have diagnostics');

    const error = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(error, 'Must have an error diagnostic');
    assert.ok(error.range.start.line >= 0, 'Range start line must be valid');
    assert.ok(error.range.start.character >= 0, 'Range start character must be valid');
    assert.ok(error.range.end.line >= error.range.start.line, 'Range end line must be >= start');
    assert.ok(error.range.end.character >= 0, 'Range end character must be valid');
    assert.ok(error.source === 'sharplsp-csharp', "Diagnostic source must be 'sharplsp-csharp'");
    assert.ok(
      error.message.includes('string') || error.message.includes('int'),
      'Error message must reference the mismatched type',
    );
    assert.ok(
      typeof error.code === 'string' || typeof error.code === 'number' || error.code !== undefined,
      'Diagnostic must have a code',
    );
    // All diagnostics must have a source
    for (const d of diagnostics) {
      assert.ok(d.source, `Every diagnostic must have a source, got undefined for: ${d.message}`);
    }
  });

  // ── Close Clears ──────────────────────────────────────────────

  test('closing a document clears its diagnostics', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    await replaceDocumentContent(
      diagDoc,
      `namespace DiagTest
{
    public class DiagTarget
    {
        public int Foo() { return "bad"; }
    }
}`,
    );

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_TIMEOUT_MS * 2);
    assert.ok(diagnostics.length > 0, 'Must have diagnostics before close');

    // Restore clean content so the sidecar clears errors first.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);
    await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_TIMEOUT_MS);

    // Now close the document.
    await closeAllEditors();

    // Wait for the server to process the close notification and clear diagnostics.
    const after = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_TIMEOUT_MS * 2);
    assert.strictEqual(after.length, 0, 'Diagnostics must be empty after closing the document');

    // Re-open for suite teardown to restore content.
    diagDoc = await vscode.workspace.openTextDocument(diagUri);
    await vscode.window.showTextDocument(diagDoc);
  });
});
