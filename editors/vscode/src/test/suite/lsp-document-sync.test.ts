import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  closeAllEditors,
  openCSharpFile,
  replaceDocumentContent,
  setupLspTestSuite,
  teardownLspTestSuite,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  pollUntilResult,
  LSP_RESPONSE_TIMEOUT_MS,
} from "./test-helpers";

suite("LSP Document Synchronization", () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite("docsync-");
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // ── didOpen ──────────────────────────────────────────────────

  test("opening a C# file makes it available to the LSP server", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);

    const { uri } = await openCSharpFile(
      tmpDir,
      "open-test.cs",
      "class OpenTest { void M() { } }",
    );

    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenNames(symbols);
    assert.ok(names.includes("OpenTest"), "Should find OpenTest symbol");
  });

  // ── didChange ────────────────────────────────────────────────

  test("editing a document updates symbols from the LSP", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 2 + 10_000);

    const { doc, uri } = await openCSharpFile(
      tmpDir,
      "change-test.cs",
      "class Original { void OldMethod() { } }",
    );

    // Verify initial symbols.
    let symbols = await waitForDocumentSymbols(uri);
    let names = flattenNames(symbols);
    assert.ok(names.includes("Original"), "Should find Original initially");

    // Edit the document — add a new class.
    const newContent = `class Original { void OldMethod() { } }
class Added { void NewMethod() { } }`;
    const editApplied = await replaceDocumentContent(doc, newContent);
    assert.ok(editApplied, "Edit should be applied");

    // Wait for the server to pick up the change.
    symbols = await pollUntilResult(
      async () => {
        const result = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >("vscode.executeDocumentSymbolProvider", uri);
        return result ?? [];
      },
      (syms) => flattenNames(syms).includes("Added"),
      LSP_RESPONSE_TIMEOUT_MS * 2,
    );

    names = flattenNames(symbols);
    assert.ok(names.includes("Original"), "Should still find Original");
    assert.ok(names.includes("Added"), "Should find Added after edit");
    assert.ok(
      names.includes("NewMethod"),
      "Should find NewMethod after edit",
    );
  });

  test("editing a document updates folding ranges", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 2 + 10_000);

    const { doc, uri } = await openCSharpFile(
      tmpDir,
      "change-fold.cs",
      "class C { void M() { } }",
    );

    // Initial folding — small file, few ranges.
    const initial = await waitForFoldingRanges(uri);
    const initialCount = initial.length;

    // Expand the file with more methods.
    const expanded = `class C {
  void M1() {
    var a = 1;
  }
  void M2() {
    var b = 2;
  }
  void M3() {
    var c = 3;
  }
}`;
    await replaceDocumentContent(doc, expanded);

    // Wait for more folding ranges to appear.
    const updated = await pollUntilResult(
      async () => {
        const result = await vscode.commands.executeCommand<
          vscode.FoldingRange[]
        >("vscode.executeFoldingRangeProvider", uri);
        return result ?? [];
      },
      (ranges) => ranges.length > initialCount,
      LSP_RESPONSE_TIMEOUT_MS * 2,
    );

    assert.ok(
      updated.length > initialCount,
      `Folding ranges should increase after adding methods: ${initialCount} → ${updated.length}`,
    );
  });

  test("removing content updates symbols accordingly", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 2 + 10_000);

    const initial = `class A { void X() { } }
class B { void Y() { } }`;
    const { doc, uri } = await openCSharpFile(
      tmpDir,
      "remove-test.cs",
      initial,
    );

    let symbols = await waitForDocumentSymbols(uri);
    let names = flattenNames(symbols);
    assert.ok(names.includes("A"), "Should find A initially");
    assert.ok(names.includes("B"), "Should find B initially");

    // Remove class B.
    await replaceDocumentContent(doc, "class A { void X() { } }");

    symbols = await pollUntilResult(
      async () => {
        const result = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >("vscode.executeDocumentSymbolProvider", uri);
        return result ?? [];
      },
      (syms) => !flattenNames(syms).includes("B"),
      LSP_RESPONSE_TIMEOUT_MS * 2,
    );

    names = flattenNames(symbols);
    assert.ok(names.includes("A"), "Should still find A");
    assert.ok(!names.includes("B"), "B should be gone after removal");
  });

  // ── didClose ─────────────────────────────────────────────────

  test("closing a document frees it from the server", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);

    const { uri } = await openCSharpFile(
      tmpDir,
      "close-test.cs",
      "class CloseTest { }",
    );
    await waitForDocumentSymbols(uri);

    // Close the file.
    await closeAllEditors();

    // Opening a different file should still work — server didn't crash.
    const { uri: uri2 } = await openCSharpFile(
      tmpDir,
      "after-close.cs",
      "class AfterClose { void M() { } }",
    );
    const symbols = await waitForDocumentSymbols(uri2);
    assert.ok(symbols.length > 0, "Server should work after closing a file");
  });

  // ── Full Cycle ───────────────────────────────────────────────

  test("full open-edit-close cycle maintains server stability", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3 + 15_000);

    // Open.
    const { doc, uri } = await openCSharpFile(
      tmpDir,
      "full-cycle.cs",
      "class Step1 { }",
    );
    let symbols = await waitForDocumentSymbols(uri);
    assert.ok(
      flattenNames(symbols).includes("Step1"),
      "Step 1: Should find Step1",
    );

    // Edit.
    await replaceDocumentContent(
      doc,
      "class Step1 { }\nclass Step2 { void M() { } }",
    );
    symbols = await pollUntilResult(
      async () => {
        const result = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >("vscode.executeDocumentSymbolProvider", uri);
        return result ?? [];
      },
      (syms) => flattenNames(syms).includes("Step2"),
      LSP_RESPONSE_TIMEOUT_MS * 2,
    );
    assert.ok(
      flattenNames(symbols).includes("Step2"),
      "Step 2: Should find Step2 after edit",
    );

    // Close.
    await closeAllEditors();

    // Verify server is still responsive.
    const { uri: finalUri } = await openCSharpFile(
      tmpDir,
      "final.cs",
      "class Final { }",
    );
    const finalSymbols = await waitForDocumentSymbols(finalUri);
    assert.ok(
      flattenNames(finalSymbols).includes("Final"),
      "Step 3: Server should respond after full cycle",
    );
  });

  // ── Rapid Edits ──────────────────────────────────────────────

  test("rapid successive edits resolve correctly", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 2 + 10_000);

    const { doc, uri } = await openCSharpFile(
      tmpDir,
      "rapid-edit.cs",
      "class V0 { }",
    );

    // Fire off several rapid edits.
    for (let i = 1; i <= 5; i++) {
      await replaceDocumentContent(doc, `class V${i} { void M${i}() { } }`);
    }

    // The server should eventually settle on the final version.
    const symbols = await pollUntilResult(
      async () => {
        const result = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >("vscode.executeDocumentSymbolProvider", uri);
        return result ?? [];
      },
      (syms) => flattenNames(syms).includes("V5"),
      LSP_RESPONSE_TIMEOUT_MS * 2,
    );

    const names = flattenNames(symbols);
    assert.ok(names.includes("V5"), "Should settle on V5 after rapid edits");
    assert.ok(
      names.includes("M5"),
      "Should settle on M5 after rapid edits",
    );
  });
});

// ── Helpers ──────────────────────────────────────────────────────

function flattenNames(symbols: vscode.DocumentSymbol[]): string[] {
  const names: string[] = [];
  function walk(list: vscode.DocumentSymbol[]): void {
    for (const sym of list) {
      names.push(sym.name);
      walk(sym.children);
    }
  }
  walk(symbols);
  return names;
}
