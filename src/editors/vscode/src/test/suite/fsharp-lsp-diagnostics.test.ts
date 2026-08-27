import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import { FSHARP_COLD_TIMEOUT_MS, fsharpFixturePath, openFSharpFixture } from './fsharp-helpers';

/**
 * Blanket end-to-end coverage for F# diagnostics via the REAL release LSP and
 * the FCS + FSharpLint pipeline in the sidecar.
 *
 * `DiagnosticsTarget.fs` is the designated scratch file (last in compile order).
 * Tests overwrite it on disk and restore the original content in teardown.
 */

const DIAG_TIMEOUT_MS = 60_000;
const VALID_CONTENT = fs.readFileSync(fsharpFixturePath('DiagnosticsTarget.fs'), 'utf8');

function restoreDiagnosticsTarget(): void {
  fs.writeFileSync(fsharpFixturePath('DiagnosticsTarget.fs'), VALID_CONTENT, 'utf8');
}

suite('F# LSP — Diagnostics', () => {
  suiteTeardown(async () => {
    restoreDiagnosticsTarget();
    await closeAllEditors();
  });

  teardown(async () => {
    restoreDiagnosticsTarget();
    await closeAllEditors();
  });

  test('reports an FCS type error for a saved file', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + DIAG_TIMEOUT_MS);
    // Write a type error to disk BEFORE opening, so the sidecar (which reads
    // from disk) sees it on first analysis.
    fs.writeFileSync(
      fsharpFixturePath('DiagnosticsTarget.fs'),
      [
        'namespace FSharpFixtures',
        '',
        'module DiagnosticsTarget =',
        '',
        '    // Type error: int binding initialised with a string.',
        '    let broken : int = "this is not an int"',
      ].join('\n'),
      'utf8',
    );

    const { uri } = await openFSharpFixture('DiagnosticsTarget.fs');
    const diagnostics = await pollUntilResult(
      async () => vscode.languages.getDiagnostics(uri),
      (items) => items.some((d) => d.severity === vscode.DiagnosticSeverity.Error),
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(errors.length > 0, 'a type-mismatched F# binding must produce an error diagnostic');
    assert.ok(
      errors.some((d) => /FS\d{4}/.test(String(d.code ?? '')) || /type/i.test(d.message)),
      'the diagnostic must look like an FCS type error',
    );
  });

  test('clears diagnostics when the file is corrected', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + DIAG_TIMEOUT_MS);
    // Start with an error on disk.
    fs.writeFileSync(
      fsharpFixturePath('DiagnosticsTarget.fs'),
      [
        'namespace FSharpFixtures',
        '',
        'module DiagnosticsTarget =',
        '    let broken : int = "nope"',
      ].join('\n'),
      'utf8',
    );
    const { uri } = await openFSharpFixture('DiagnosticsTarget.fs');
    await pollUntilResult(
      async () => vscode.languages.getDiagnostics(uri),
      (items) => items.some((d) => d.severity === vscode.DiagnosticSeverity.Error),
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );

    // Correct the file on disk and re-open to force a fresh pull.
    restoreDiagnosticsTarget();
    await closeAllEditors();
    await openFSharpFixture('DiagnosticsTarget.fs');
    const cleared = await pollUntilResult(
      async () => vscode.languages.getDiagnostics(uri),
      (items) => items.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length === 0,
      DIAG_TIMEOUT_MS,
      2_000,
    );
    assert.strictEqual(
      cleared.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
      0,
      'corrected file must clear its error diagnostics',
    );
  });

  test('a valid F# fixture file has no error diagnostics', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + DIAG_TIMEOUT_MS);
    const { uri } = await openFSharpFixture('Library.fs');
    // Give the pull pipeline time to run, then assert no errors surfaced.
    await pollUntilResult(
      async () => vscode.languages.getDiagnostics(uri),
      () => true,
      20_000,
      2_000,
    );
    const errors = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.strictEqual(errors.length, 0, `Library.fs must be error-free, got: ${describe(errors)}`);
  });
});

function describe(diags: vscode.Diagnostic[]): string {
  return diags.map((d) => `${String(d.code)}:${d.message}`).join(' | ');
}
