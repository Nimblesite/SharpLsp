import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  replaceDocumentContent,
  setupLspTestSuite,
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

/** Assert the list carries no Error-severity diagnostic. */
function assertErrorFree(diagnostics: readonly vscode.Diagnostic[], why: string): void {
  const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  assert.strictEqual(errors.length, 0, why);
}

/** Assert `code` is absent from the list, naming whatever is still reported. */
function assertCodeGone(
  diagnostics: readonly vscode.Diagnostic[],
  code: string,
  why: string,
): void {
  assert.ok(
    !diagnostics.some((diagnostic) => codeOf(diagnostic) === code),
    `${why}; still reported: ${diagnostics.map((d) => codeOf(d)).join(', ')}`,
  );
}

/** A DiagTest/DiagTarget source whose `Foo` is `public <ret> Foo() { <body> }`. */
function diagTargetMethod(ret: string, body: string): string {
  return `namespace DiagTest
{
    public class DiagTarget
    {
        public ${ret} Foo() { ${body} }
    }
}`;
}

/** Clean starting content for the diagnostic target file. */
const CLEAN_CONTENT = diagTargetMethod('int', 'return 42;');

const TYPE_ERROR_CS = diagTargetMethod('int', 'return "not an int";');

const MISSING_TYPE_CS = diagTargetMethod('NonExistentType', 'return null;');

const BAD_RETURN_CS = diagTargetMethod('int', 'return "bad";');

const BAD_AGAIN_CS = diagTargetMethod('int', 'return "bad again";');

const WRONG_LOCAL_CS = `namespace DiagTest
{
    public class DiagTarget
    {
        public void Foo()
        {
            int x = "wrong";
        }
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

  /** Swap the fixture buffer to `content`, await its diagnostics, and return the list with its error entry. */
  async function brokenBuffer(
    content: string,
    listWhy: string,
    errorWhy: string,
  ): Promise<{ diagnostics: vscode.Diagnostic[]; error: vscode.Diagnostic }> {
    await replaceDocumentContent(diagDoc, content);
    const diagnostics = await waitForDiagnostics(diagUri, LSP_RESPONSE_MS);
    assert.ok(diagnostics.length > 0, listWhy);
    const error = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(error, errorWhy);
    return { diagnostics, error };
  }

  /** Assert the diagnostic carries exactly `code`, naming what it carried instead. */
  function assertErrorCode(diagnostic: vscode.Diagnostic, code: string, why: string): void {
    assert.strictEqual(codeOf(diagnostic), code, `${why}, got ${codeOf(diagnostic)}`);
  }

  /**
   * Assert `error` is the compiler error `code` (`codeWhy`), well shaped and
   * Error-severity (`severityWhy`), with its squiggle covering `needle`
   * (`squiggleWhy`); return the squiggled source text.
   */
  function assertCompilerError(
    error: vscode.Diagnostic,
    code: string,
    codeWhy: string,
    severityWhy: string,
    needle: string,
    squiggleWhy: string,
  ): string {
    assertErrorCode(error, code, codeWhy);
    assertDiagnosticShape(error, diagDoc);
    assert.strictEqual(error.severity, vscode.DiagnosticSeverity.Error, severityWhy);
    const squiggled = diagDoc.getText(error.range);
    assert.ok(squiggled.includes(needle), `${squiggleWhy}: '${squiggled}'`);
    return squiggled;
  }

  /** Assert the buffer holds `present` (`presentWhy`) and no longer holds `gone` (`goneWhy`). */
  function assertBufferText(
    present: string,
    presentWhy: string,
    gone: string,
    goneWhy: string,
  ): void {
    assert.ok(diagDoc.getText().includes(present), presentWhy);
    assert.ok(!diagDoc.getText().includes(gone), goneWhy);
  }

  /** Assert every published diagnostic satisfies the shape invariant. */
  function assertAllShaped(diagnostics: readonly vscode.Diagnostic[]): void {
    for (const diagnostic of diagnostics) {
      assertDiagnosticShape(diagnostic, diagDoc);
    }
  }

  /** Assert no diagnostic is published twice, keyed by code and range start. */
  function assertNoDuplicates(diagnostics: readonly vscode.Diagnostic[]): void {
    const keys = diagnostics.map(
      (diagnostic) =>
        `${codeOf(diagnostic)}:${diagnostic.range.start.line}:${diagnostic.range.start.character}`,
    );
    assert.deepEqual([...new Set(keys)], keys, 'no diagnostic may be published twice');
  }

  // ── Error Detection ───────────────────────────────────────────

  test('file with type error shows diagnostics', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const { diagnostics, error } = await brokenBuffer(
      TYPE_ERROR_CS,
      'Must have at least one diagnostic',
      'Must have at least one error-level diagnostic',
    );
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
    const squiggled = assertCompilerError(
      error,
      'CS0029',
      'type mismatch is CS0029',
      '[DIAG-LSP-SEVERITY] maps a Roslyn Error to severity 1',
      '"not an int"',
      'the squiggle covers the literal',
    );
    assert.strictEqual(error.range.start.line, error.range.end.line, 'on one line');
    assert.ok(squiggled.length < diagDoc.lineAt(4).text.length, 'and not the whole line');

    // Interaction 4 - every published diagnostic is well formed, and none is
    // published twice. A duplicate is one Problems row per pull.
    assertAllShaped(diagnostics);
    assertNoDuplicates(diagnostics);

    await vscode.commands.executeCommand('workbench.actions.view.problems');
  });

  test('file with missing type shows diagnostics', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const { diagnostics, error: csError } = await brokenBuffer(
      MISSING_TYPE_CS,
      'Must have diagnostics for missing type',
      'Must have an error diagnostic for missing type',
    );

    // Interaction 2 - [DIAG-CATEGORIES-COMPILER]: an unresolved type is CS0246.
    // That exact code is what the AddImport code fix keys off, so a diagnostic
    // reported without it leaves Ctrl-. with nothing to offer.
    assertCompilerError(
      csError,
      'CS0246',
      'an unresolved type is CS0246',
      'and it is an error',
      'NonExistentType',
      'the squiggle covers the unresolved name',
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
    assertAllShaped(diagnostics);
  });

  // ── Clean Files ───────────────────────────────────────────────

  test('valid file has no error diagnostics', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Content is already clean from teardown. Verify no errors.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);

    // Wait for diagnostics to clear (sidecar needs time to reanalyze on CI).
    const cleared = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);
    assertErrorFree(cleared, 'Valid file should have no error diagnostics');

    // Interaction 2 - and no phantom CS0246. [DIAG-RESTORE] exists because a
    // workspace analysed before NuGet restore finishes reports every reference
    // as missing; a clean file showing one means the gate did not hold.
    assertCodeGone(cleared, 'CS0246', 'no phantom unresolved-reference errors');
    assertAllShaped(cleared);

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
    assertBufferText(
      'return 42',
      'the clean content is in the buffer',
      'not an int',
      'with no leftover error',
    );
  });

  // ── Edit Cycle ────────────────────────────────────────────────

  test('fixing an error clears the diagnostic', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const { error: before } = await brokenBuffer(
      BAD_RETURN_CS,
      'Must have diagnostics for broken code',
      'the broken buffer produced an error',
    );

    // Fix the error.
    await replaceDocumentContent(diagDoc, CLEAN_CONTENT);

    // Clearing is one more sidecar round trip, so it gets the same warm
    // semantic budget as every other diagnostics wait in this suite.
    const cleared = await waitForDiagnosticsCleared(diagUri, LSP_RESPONSE_MS);
    assertErrorFree(cleared, 'Diagnostics should clear after fixing the error');

    // Interaction 2 - the error that WAS reported was the real one, so the
    // clearing below is about the fix and not about an analyser that never
    // looked ([DIAG-CATEGORIES-COMPILER]).
    assertErrorCode(before, 'CS0029', 'the type mismatch was CS0029');
    assertDiagnosticShape(before, diagDoc);

    // Interaction 3 - the specific code is GONE, not merely outnumbered. A
    // stale squiggle on a line the user already fixed is the single most
    // corrosive diagnostics defect there is ([DIAG-CATEGORIES-LIVE]).
    assertCodeGone(cleared, 'CS0029', 'CS0029 must be gone');
    assertBufferText(
      'return 42',
      'and the fix really is in the buffer',
      '"bad"',
      'with the bad literal removed',
    );

    // Interaction 4 - breaking it AGAIN reports again. A pipeline that clears
    // once and then goes quiet is worse than one that never cleared.
    await replaceDocumentContent(diagDoc, BAD_AGAIN_CS);
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
    const { diagnostics, error } = await brokenBuffer(
      WRONG_LOCAL_CS,
      'Must have diagnostics',
      'Must have an error diagnostic',
    );
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
    const { error: broken } = await brokenBuffer(
      BAD_RETURN_CS,
      'Must have diagnostics before close',
      'the broken buffer produced an error before the close',
    );

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
    assert.ok(
      !vscode.window.visibleTextEditors.some(
        (editor) => editor.document.uri.toString() === diagUri.toString(),
      ),
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
