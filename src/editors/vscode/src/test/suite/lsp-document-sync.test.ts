import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  openCSharpFile,
  replaceDocumentContent,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  pollProvider,
  pollSymbols,
  assertContainsAll,
  openCSharpOutline,
  flattenSymbolNames,
} from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { useLspTestSuite } from './lsp-suite-kit';

// The baseline file must itself be FOLDABLE. A single-line
// `class C { void M() { } }` has no multi-line region, so the folding
// provider correctly returns nothing and a poll for a non-empty result can
// never succeed — it just burned its whole budget and then compared against
// a baseline of 0 ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
const CHANGE_FOLD_CS = `class C {
  void M() {
    var a = 1;
  }
}`;

const REMOVE_TEST_CS = `class A { void X() { } }
class B { void Y() { } }`;

suite('LSP Document Synchronization', () => {
  const tmpDir = useLspTestSuite('docsync-');

  // ── didOpen ──────────────────────────────────────────────────

  test('opening a C# file makes it available to the LSP server', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { symbols } = await openCSharpOutline(
      tmpDir(),
      'open-test.cs',
      'class OpenTest { void M() { } }',
    );
    const names = flattenSymbolNames(symbols);
    assert.ok(names.includes('OpenTest'), 'Should find OpenTest symbol');
  });

  // ── didChange ────────────────────────────────────────────────

  test('editing a document updates symbols from the LSP', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { doc, uri } = await openCSharpFile(
      tmpDir(),
      'change-test.cs',
      'class Original { void OldMethod() { } }',
    );

    // Verify initial symbols.
    let symbols = await waitForDocumentSymbols(uri);
    let names = flattenSymbolNames(symbols);
    assert.ok(names.includes('Original'), 'Should find Original initially');

    // Edit the document — add a new class.
    const newContent = `class Original { void OldMethod() { } }
class Added { void NewMethod() { } }`;
    const editApplied = await replaceDocumentContent(doc, newContent);
    assert.ok(editApplied, 'Edit should be applied');

    // Wait for the server to pick up the change.
    symbols = await pollSymbols(
      uri,
      (syms) => flattenSymbolNames(syms).includes('Added'),
      LSP_RESPONSE_MS,
    );

    names = flattenSymbolNames(symbols);
    assertContainsAll(names, ['Original', 'Added', 'NewMethod'], 'names');
  });

  test('editing a document updates folding ranges', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const { doc, uri } = await openCSharpFile(tmpDir(), 'change-fold.cs', CHANGE_FOLD_CS);

    // Initial folding — the class body and the one method body.
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
    const updated = await pollProvider<vscode.FoldingRange>(
      'vscode.executeFoldingRangeProvider',
      [uri],
      (ranges) => ranges.length > initialCount,
      LSP_RESPONSE_MS,
    );

    assert.ok(
      updated.length > initialCount,
      `Folding ranges should increase after adding methods: ${initialCount} → ${updated.length}`,
    );
  });

  test('removing content updates symbols accordingly', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    const { doc, uri } = await openCSharpFile(tmpDir(), 'remove-test.cs', REMOVE_TEST_CS);

    let symbols = await waitForDocumentSymbols(uri);
    let names = flattenSymbolNames(symbols);
    assertContainsAll(names, ['A', 'B'], 'Should find');

    // Remove class B.
    await replaceDocumentContent(doc, 'class A { void X() { } }');

    symbols = await pollSymbols(
      uri,
      (syms) => !flattenSymbolNames(syms).includes('B'),
      LSP_RESPONSE_MS,
    );

    names = flattenSymbolNames(symbols);
    assert.ok(names.includes('A'), 'Should still find A');
    assert.ok(!names.includes('B'), 'B should be gone after removal');
  });

  // ── didClose ─────────────────────────────────────────────────

  test('closing a document frees it from the server', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openCSharpFile(tmpDir(), 'close-test.cs', 'class CloseTest { }');
    await waitForDocumentSymbols(uri);

    // Close the file.
    await closeAllEditors();

    // Opening a different file should still work — server didn't crash.
    const { uri: uri2 } = await openCSharpFile(
      tmpDir(),
      'after-close.cs',
      'class AfterClose { void M() { } }',
    );
    const symbols = await waitForDocumentSymbols(uri2);
    assert.ok(symbols.length > 0, 'Server should work after closing a file');
  });

  // ── Full Cycle ───────────────────────────────────────────────

  test('full open-edit-close cycle maintains server stability', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    // Open.
    const { doc, uri } = await openCSharpFile(tmpDir(), 'full-cycle.cs', 'class Step1 { }');
    let symbols = await waitForDocumentSymbols(uri);
    assert.ok(flattenSymbolNames(symbols).includes('Step1'), 'Step 1: Should find Step1');

    // Edit.
    await replaceDocumentContent(doc, 'class Step1 { }\nclass Step2 { void M() { } }');
    symbols = await pollSymbols(
      uri,
      (syms) => flattenSymbolNames(syms).includes('Step2'),
      LSP_RESPONSE_MS,
    );
    assert.ok(
      flattenSymbolNames(symbols).includes('Step2'),
      'Step 2: Should find Step2 after edit',
    );

    // Close.
    await closeAllEditors();

    // Verify server is still responsive.
    const { uri: finalUri } = await openCSharpFile(tmpDir(), 'final.cs', 'class Final { }');
    const finalSymbols = await waitForDocumentSymbols(finalUri);
    assert.ok(
      flattenSymbolNames(finalSymbols).includes('Final'),
      'Step 3: Server should respond after full cycle',
    );
  });

  // ── Rapid Edits ──────────────────────────────────────────────

  test('rapid successive edits resolve correctly', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { doc, uri } = await openCSharpFile(tmpDir(), 'rapid-edit.cs', 'class V0 { }');

    // Fire off several rapid edits.
    for (let i = 1; i <= 5; i++) {
      await replaceDocumentContent(doc, `class V${i} { void M${i}() { } }`);
    }

    // The server should eventually settle on the final version.
    const symbols = await pollSymbols(
      uri,
      (syms) => flattenSymbolNames(syms).includes('V5'),
      LSP_RESPONSE_MS,
    );

    const names = flattenSymbolNames(symbols);
    assertContainsAll(names, ['V5', 'M5'], 'Should settle on');
  });
});

// ── Helpers ──────────────────────────────────────────────────────
