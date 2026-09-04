import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  loadFixtureSolution,
  openSharpLspPanel,
  replaceDocumentContent,
  setupLspTestSuite,
  settleForScreenshot,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDiagnostics,
  waitForDiagnosticsCleared,
  waitForDocumentSymbols,
  waitForHoverResult,
} from './test-helpers';
import { LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

/** The source every C# diagnostic must carry, so the Problems panel can group them. */
const CSHARP_SOURCE = 'sharplsp-csharp';

/** A diagnostic's code as a plain string, whatever shape the server used. */
function codeOf(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return String((code as { value?: string | number } | undefined)?.value ?? '');
}

/**
 * Every invariant a published diagnostic must satisfy, whatever produced it.
 *
 * A diagnostic with no code cannot be suppressed, cannot be looked up, and
 * cannot be matched to a quick fix; one whose range runs past the buffer paints
 * a squiggle over nothing. Neither shows up in a "there is at least one error"
 * check ([DIAG-CATEGORIES-COMPILER], [DIAG-LSP-SEVERITY]).
 */
function assertDiagnosticShape(diagnostic: vscode.Diagnostic, document: vscode.TextDocument): void {
  const where = `${codeOf(diagnostic)} at ${diagnostic.range.start.line}`;
  assert.ok(diagnostic.message.trim().length > 0, `${where} must carry a message`);
  assert.strictEqual(diagnostic.source, CSHARP_SOURCE, `${where} must name the C# engine`);
  assert.match(codeOf(diagnostic), /^[A-Z]+\d+$/, `${where} must carry a compiler code`);
  assert.ok(
    diagnostic.range.start.isBeforeOrEqual(diagnostic.range.end),
    `${where} must not be inverted`,
  );
  assert.ok(
    diagnostic.range.end.line < document.lineCount,
    `${where} must land inside the ${document.lineCount}-line buffer`,
  );
}

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
    this.timeout(SIDECAR_COLD_MS + 5_000);
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
    await waitForHoverResult(diagUri, new vscode.Position(4, 20), SIDECAR_COLD_MS);
  });

  suiteTeardown(async () => {
    // Restore clean content so the fixture stays valid.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);
    await diagDoc.save();
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Restore clean content between tests. Give sidecar time to reanalyze.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);
    await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);
  });

  // ── Error Detection ───────────────────────────────────────────

  test('file with type error shows diagnostics', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
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

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_MS);
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

    // Interaction 2 - [DIAG-CATEGORIES-COMPILER]: a type error is CS0029.
    // Without the code the Problems panel cannot link to documentation, the
    // editor cannot offer the matching quick fix, and nothing can suppress it.
    assert.strictEqual(codeOf(error), 'CS0029', `type mismatch is CS0029, got ${codeOf(error)}`);
    assertDiagnosticShape(error, diagDoc);
    assert.strictEqual(
      error.severity,
      vscode.DiagnosticSeverity.Error,
      '[DIAG-LSP-SEVERITY] maps a Roslyn Error to severity 1',
    );

    // Interaction 3 - the squiggle covers the OFFENDING EXPRESSION, not the
    // whole method. A range that spans the declaration paints the entire body
    // red for one bad return.
    const squiggled = diagDoc.getText(error.range);
    assert.ok(
      squiggled.includes('"not an int"'),
      `the squiggle covers the literal: '${squiggled}'`,
    );
    assert.strictEqual(error.range.start.line, error.range.end.line, 'on one line');
    assert.ok(squiggled.length < diagDoc.lineAt(4).text.length, 'and not the whole line');

    // Interaction 4 - every published diagnostic is well formed, and none is
    // published twice. A duplicate is one Problems row per pull.
    for (const diagnostic of diagnostics) {
      assertDiagnosticShape(diagnostic, diagDoc);
    }
    const keys = diagnostics.map(
      (diagnostic) =>
        `${codeOf(diagnostic)}:${diagnostic.range.start.line}:${diagnostic.range.start.character}`,
    );
    assert.deepEqual([...new Set(keys)], keys, 'no diagnostic may be published twice');

    // Load fixture solution so Solution Explorer is populated in the screenshot.
    if (process.env['SHARPLSP_SCREENSHOTS']) {
      await loadFixtureSolution(workspaceRoot);
    }
    // Open Problems panel so diagnostics are visible in the screenshot.
    await vscode.commands.executeCommand('workbench.actions.view.problems');
    await settleForScreenshot(1000);
    await openSharpLspPanel();
    await takeScreenshot('vscode-diagnostics-page.png');
  });

  test('file with missing type shows diagnostics', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
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

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_MS);
    assert.ok(diagnostics.length > 0, 'Must have diagnostics for missing type');

    const csError = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(csError, 'Must have an error diagnostic for missing type');

    // Interaction 2 - [DIAG-CATEGORIES-COMPILER]: an unresolved type is CS0246.
    // That exact code is what the AddImport code fix keys off, so a diagnostic
    // reported without it leaves Ctrl-. with nothing to offer.
    assert.strictEqual(
      codeOf(csError),
      'CS0246',
      `an unresolved type is CS0246, got ${codeOf(csError)}`,
    );
    assertDiagnosticShape(csError, diagDoc);
    assert.strictEqual(csError.severity, vscode.DiagnosticSeverity.Error, 'and it is an error');

    // Interaction 3 - the squiggle sits on the TYPE NAME, which is where the
    // lightbulb has to appear for the import fix to be reachable.
    const squiggled = diagDoc.getText(csError.range);
    assert.ok(
      squiggled.includes('NonExistentType'),
      `the squiggle covers the unresolved name: '${squiggled}'`,
    );
    assert.strictEqual(csError.range.start.line, 4, 'on the declaration line');
    assert.ok(csError.message.includes('NonExistentType'), 'and the message names it');

    // Interaction 4 - it is the ONLY error. A missing return type must not
    // cascade into a wall of secondary errors the user has to read past.
    const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.strictEqual(
      errors.length,
      1,
      `one unresolved type, one error; got: ${errors.map((e) => codeOf(e)).join(', ')}`,
    );
    for (const diagnostic of diagnostics) {
      assertDiagnosticShape(diagnostic, diagDoc);
    }
  });

  // ── Clean Files ───────────────────────────────────────────────

  test('valid file has no error diagnostics', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Content is already clean from teardown. Verify no errors.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);

    // Wait for diagnostics to clear (sidecar needs time to reanalyze on CI).
    const cleared = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);
    const errors = cleared.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.strictEqual(errors.length, 0, 'Valid file should have no error diagnostics');

    // Interaction 2 - and no phantom CS0246. [DIAG-RESTORE] exists because a
    // workspace analysed before NuGet restore finishes reports every reference
    // as missing; a clean file showing one means the gate did not hold.
    assert.strictEqual(
      cleared.some((diagnostic) => codeOf(diagnostic) === 'CS0246'),
      false,
      `no phantom unresolved-reference errors: ${cleared.map((d) => codeOf(d)).join(', ')}`,
    );
    for (const diagnostic of cleared) {
      assertDiagnosticShape(diagnostic, diagDoc);
    }

    // Interaction 3 - whatever IS reported on a clean file is advisory, never
    // an error, and it is still addressable: [DIAG-CATEGORIES-ANALYZER] style
    // suggestions carry codes and sources like everything else.
    for (const diagnostic of cleared) {
      assert.notStrictEqual(
        diagnostic.severity,
        vscode.DiagnosticSeverity.Error,
        `${codeOf(diagnostic)} must not be an error on a valid file: ${diagnostic.message}`,
      );
      assert.strictEqual(diagnostic.source, CSHARP_SOURCE, 'and must name the C# engine');
    }

    // Interaction 4 - the buffer really is the clean one, so this is a
    // statement about the analyser rather than about the fixture.
    assert.ok(diagDoc.getText().includes('return 42'), 'the clean content is in the buffer');
    assert.strictEqual(diagDoc.getText().includes('not an int'), false, 'with no leftover error');
  });

  // ── Edit Cycle ────────────────────────────────────────────────

  test('fixing an error clears the diagnostic', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
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

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_MS);
    assert.ok(diagnostics.length > 0, 'Must have diagnostics for broken code');

    // Fix the error.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);

    // Clearing is one more sidecar round trip, so it gets the same warm
    // semantic budget as every other diagnostics wait in this suite.
    const cleared = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);
    const errors = cleared.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.strictEqual(errors.length, 0, 'Diagnostics should clear after fixing the error');

    // Interaction 2 - the error that WAS reported was the real one, so the
    // clearing below is about the fix and not about an analyser that never
    // looked ([DIAG-CATEGORIES-COMPILER]).
    const before = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(before, 'the broken buffer produced an error');
    assert.strictEqual(
      codeOf(before),
      'CS0029',
      `the type mismatch was CS0029, got ${codeOf(before)}`,
    );
    assertDiagnosticShape(before, diagDoc);

    // Interaction 3 - the specific code is GONE, not merely outnumbered. A
    // stale squiggle on a line the user already fixed is the single most
    // corrosive diagnostics defect there is ([DIAG-CATEGORIES-LIVE]).
    assert.strictEqual(
      cleared.some((diagnostic) => codeOf(diagnostic) === 'CS0029'),
      false,
      `CS0029 must be gone; still reported: ${cleared.map((d) => codeOf(d)).join(', ')}`,
    );
    assert.ok(diagDoc.getText().includes('return 42'), 'and the fix really is in the buffer');
    assert.strictEqual(diagDoc.getText().includes('"bad"'), false, 'with the bad literal removed');

    // Interaction 4 - breaking it AGAIN reports again. A pipeline that clears
    // once and then goes quiet is worse than one that never cleared.
    await replaceDocumentContent(
      diagDoc,
      `namespace DiagTest
{
    public class DiagTarget
    {
        public int Foo() { return "bad again"; }
    }
}`,
    );
    const again = await waitForDiagnostics(diagUri, LSP_RESPONSE_MS);
    assert.ok(again.length > 0, 'reintroducing the error must report it again');
    assert.ok(
      again.some((diagnostic) => codeOf(diagnostic) === 'CS0029'),
      `CS0029 must come back; got: ${again.map((d) => codeOf(d)).join(', ')}`,
    );
  });

  // ── Diagnostic Properties ─────────────────────────────────────

  test('diagnostics have correct severity and range', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
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

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_MS);
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
    this.timeout(LSP_RESPONSE_MS + 5_000);
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

    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_MS);
    assert.ok(diagnostics.length > 0, 'Must have diagnostics before close');

    // Restore clean content so the sidecar clears errors first.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);
    await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);

    // Now close the document.
    await closeAllEditors();

    // Wait for the server to process the close notification and clear diagnostics.
    const after = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);
    assert.strictEqual(after.length, 0, 'Diagnostics must be empty after closing the document');

    // Interaction 2 - what was reported BEFORE the close was the real error, so
    // the emptiness above is the close taking effect rather than an analyser
    // that never ran.
    const broken = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(broken, 'the broken buffer produced an error before the close');
    assert.strictEqual(codeOf(broken), 'CS0029', 'and it was the type mismatch');
    assertDiagnosticShape(broken, diagDoc);

    // Interaction 3 - the collection is EMPTY, not merely error-free. A closed
    // document that keeps warnings still occupies a row in the Problems panel
    // for a file the user is no longer looking at.
    assert.deepEqual(after, [], 'a closed document owns no diagnostics of any severity');
    assert.strictEqual(
      vscode.languages.getDiagnostics(diagUri).length,
      0,
      'and the language service agrees it has none',
    );
    assert.strictEqual(
      vscode.window.visibleTextEditors.some(
        (editor) => editor.document.uri.toString() === diagUri.toString(),
      ),
      false,
      'with no editor still showing the file',
    );

    // Re-open for suite teardown to restore content.
    diagDoc = await vscode.workspace.openTextDocument(diagUri);
    await vscode.window.showTextDocument(diagDoc);

    // Interaction 4 - re-opening it re-establishes the pipeline: the clean
    // content analyses clean, rather than resurrecting the pre-close errors.
    const reopened = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);
    assert.strictEqual(
      reopened.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
      0,
      'the reopened clean document reports no errors',
    );
    assert.ok(diagDoc.getText().includes('return 42'), 'and it really is the clean content');
  });
});
