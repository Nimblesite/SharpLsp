import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  closeAllEditors,
  openCSharpFile,
  replaceDocumentContent,
  setupLspTestSuite,
  teardownLspTestSuite,
  waitForDiagnostics,
  waitForDiagnosticsCleared,
  waitForDocumentSymbols,
  LSP_RESPONSE_TIMEOUT_MS,
} from "./test-helpers";

suite("Diagnostics / Problems Panel", () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite("diagnostics-");
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // ── Error Detection ───────────────────────────────────────────

  test("file with type error shows diagnostics", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    const content = `namespace DiagTest
{
    public class Broken
    {
        public int Foo()
        {
            return "not an int";
        }
    }
}`;
    const { uri } = await openCSharpFile(tmpDir, "Broken.cs", content);
    await waitForDocumentSymbols(uri);

    const diagnostics = await waitForDiagnostics(uri);
    assert.ok(diagnostics.length > 0, "Must have at least one diagnostic");

    const error = diagnostics.find(
      (d) => d.severity === vscode.DiagnosticSeverity.Error,
    );
    assert.ok(error, "Must have at least one error-level diagnostic");
    assert.ok(
      error.message.length > 0,
      "Error diagnostic must have a message",
    );
  });

  test("file with missing type shows diagnostics", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    const content = `namespace DiagTest
{
    public class UseMissing
    {
        public NonExistentType Foo() { return null; }
    }
}`;
    const { uri } = await openCSharpFile(tmpDir, "UseMissing.cs", content);
    await waitForDocumentSymbols(uri);

    const diagnostics = await waitForDiagnostics(uri);
    assert.ok(diagnostics.length > 0, "Must have diagnostics for missing type");

    const csError = diagnostics.find((d) =>
      d.message.includes("NonExistentType"),
    );
    assert.ok(csError, "Diagnostic must reference the missing type name");
  });

  // ── Clean Files ───────────────────────────────────────────────

  test("valid file has no error diagnostics", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    const content = `namespace DiagTest
{
    public class Valid
    {
        public int Add(int a, int b) { return a + b; }
    }
}`;
    const { uri } = await openCSharpFile(tmpDir, "Valid.cs", content);
    await waitForDocumentSymbols(uri);

    // Give the server time to publish diagnostics (or not).
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const diagnostics = vscode.languages.getDiagnostics(uri);
    const errors = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error,
    );
    assert.strictEqual(
      errors.length,
      0,
      "Valid file should have no error diagnostics",
    );
  });

  // ── Edit Cycle ────────────────────────────────────────────────

  test("fixing an error clears the diagnostic", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 4);
    const broken = `namespace DiagTest
{
    public class EditCycle
    {
        public int Foo() { return "bad"; }
    }
}`;
    const { doc, uri } = await openCSharpFile(tmpDir, "EditCycle.cs", broken);
    await waitForDocumentSymbols(uri);

    // Wait for error diagnostics to appear.
    const diagnostics = await waitForDiagnostics(uri);
    assert.ok(diagnostics.length > 0, "Must have diagnostics for broken code");

    // Fix the error.
    const fixed = `namespace DiagTest
{
    public class EditCycle
    {
        public int Foo() { return 42; }
    }
}`;
    await replaceDocumentContent(doc, fixed);

    // Wait for diagnostics to clear.
    const cleared = await waitForDiagnosticsCleared(uri, LSP_RESPONSE_TIMEOUT_MS * 2);
    const errors = cleared.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error,
    );
    assert.strictEqual(
      errors.length,
      0,
      "Diagnostics should clear after fixing the error",
    );
  });

  // ── Diagnostic Properties ─────────────────────────────────────

  test("diagnostics have correct severity and range", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    const content = `namespace DiagTest
{
    public class RangeCheck
    {
        public void Foo()
        {
            int x = "wrong";
        }
    }
}`;
    const { uri } = await openCSharpFile(tmpDir, "RangeCheck.cs", content);
    await waitForDocumentSymbols(uri);

    const diagnostics = await waitForDiagnostics(uri);
    assert.ok(diagnostics.length > 0, "Must have diagnostics");

    const error = diagnostics.find(
      (d) => d.severity === vscode.DiagnosticSeverity.Error,
    );
    assert.ok(error, "Must have an error diagnostic");
    assert.ok(error.range.start.line >= 0, "Range start line must be valid");
    assert.ok(
      error.range.start.character >= 0,
      "Range start character must be valid",
    );
    assert.ok(
      error.source === "forge-csharp",
      "Diagnostic source must be 'forge-csharp'",
    );
  });

  // ── Close Clears ──────────────────────────────────────────────

  test("closing a document clears its diagnostics", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);
    const content = `namespace DiagTest
{
    public class CloseClear
    {
        public int Foo() { return "bad"; }
    }
}`;
    const { uri } = await openCSharpFile(tmpDir, "CloseClear.cs", content);
    await waitForDocumentSymbols(uri);

    // Wait for error diagnostics to appear.
    const diagnostics = await waitForDiagnostics(uri);
    assert.ok(diagnostics.length > 0, "Must have diagnostics before close");

    // Close the document.
    await closeAllEditors();

    // Diagnostics should be cleared.
    const after = await waitForDiagnosticsCleared(uri);
    assert.strictEqual(
      after.length,
      0,
      "Diagnostics must be empty after closing the document",
    );
  });
});
