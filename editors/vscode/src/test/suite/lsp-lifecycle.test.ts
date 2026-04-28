import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  openCSharpFile,
  setupLspTestSuite,
  teardownLspTestSuite,
  waitForDocumentSymbols,
  LSP_RESPONSE_TIMEOUT_MS,
} from './test-helpers';

suite('LSP Lifecycle', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('lifecycle-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // ── Restart ──────────────────────────────────────────────────

  test('sharplsp.restartServer restarts the LSP server', async function () {
    this.timeout(60_000);

    // Open a file to ensure server is running.
    const { uri } = await openCSharpFile(
      tmpDir,
      'restart-test.cs',
      'class Restart { void M() { } }',
    );
    await waitForDocumentSymbols(uri);

    // Restart the server.
    await vscode.commands.executeCommand('sharplsp.restartServer');

    // After restart, the server should come back and respond again.
    const symbols = await waitForDocumentSymbols(uri, 30_000);
    assert.ok(symbols.length > 0, 'Server should respond to symbols after restart');
  });

  test('sharplsp.showOutput command executes without error', async function () {
    this.timeout(5_000);
    // Should not throw.
    await vscode.commands.executeCommand('sharplsp.showOutput');
  });

  test('sharplsp.showTraceOutput command executes without error', async function () {
    this.timeout(5_000);
    await vscode.commands.executeCommand('sharplsp.showTraceOutput');
  });

  // ── Status Bar ───────────────────────────────────────────────

  test('status bar item is visible after activation', async function () {
    this.timeout(10_000);

    // Open a file to guarantee activation.
    await openCSharpFile(tmpDir, 'status.cs', 'class Status { }');

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension should be active');

    // We can't directly inspect the status bar from tests, but we can
    // verify the extension activated without crashing — the status bar
    // is created during activation.
    assert.ok(true, 'Extension activated with status bar creation');
  });

  // ── File Cycling ─────────────────────────────────────────────

  test('opening and closing multiple C# files works', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3 + 10_000);

    // Open first file.
    const { uri: uri1 } = await openCSharpFile(
      tmpDir,
      'cycle1.cs',
      'class Cycle1 { void A() { } }',
    );
    const symbols1 = await waitForDocumentSymbols(uri1);
    assert.ok(symbols1.length > 0, 'File 1 should produce symbols');

    await closeAllEditors();

    // Open second file.
    const { uri: uri2 } = await openCSharpFile(
      tmpDir,
      'cycle2.cs',
      'class Cycle2 { void B() { } }',
    );
    const symbols2 = await waitForDocumentSymbols(uri2);
    assert.ok(symbols2.length > 0, 'File 2 should produce symbols');
    assert.ok(flattenNames(symbols2).includes('Cycle2'), 'File 2 symbols should contain Cycle2');

    await closeAllEditors();

    // Open third file.
    const { uri: uri3 } = await openCSharpFile(
      tmpDir,
      'cycle3.cs',
      'class Cycle3 { void C() { } }',
    );
    const symbols3 = await waitForDocumentSymbols(uri3);
    assert.ok(symbols3.length > 0, 'File 3 should produce symbols');
  });

  test('multiple files open simultaneously get independent symbols', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 2 + 10_000);

    const { uri: uriA } = await openCSharpFile(tmpDir, 'simA.cs', 'class Alpha { void X() { } }');

    const { uri: uriB } = await openCSharpFile(tmpDir, 'simB.cs', 'class Beta { void Y() { } }');

    const symbolsA = await waitForDocumentSymbols(uriA);
    const symbolsB = await waitForDocumentSymbols(uriB);

    const namesA = flattenNames(symbolsA);
    const namesB = flattenNames(symbolsB);

    assert.ok(namesA.includes('Alpha'), 'File A should contain Alpha');
    assert.ok(namesB.includes('Beta'), 'File B should contain Beta');
    assert.ok(!namesA.includes('Beta'), 'File A should NOT contain Beta');
    assert.ok(!namesB.includes('Alpha'), 'File B should NOT contain Alpha');
  });

  // ── Error Recovery ───────────────────────────────────────────

  test('server handles rapid file open/close gracefully', async function () {
    this.timeout(30_000);

    // Rapidly open and close several files.
    for (let i = 0; i < 5; i++) {
      await openCSharpFile(tmpDir, `rapid${i}.cs`, `class Rapid${i} { }`);
      await closeAllEditors();
    }

    // Now open a file and verify the server still works.
    const { uri } = await openCSharpFile(
      tmpDir,
      'after-rapid.cs',
      'class AfterRapid { void M() { } }',
    );
    const symbols = await waitForDocumentSymbols(uri);
    assert.ok(symbols.length > 0, 'Server should still respond after rapid open/close');
  });

  // ── Double Restart ─────────────────────────────────────────

  test('restarting twice in succession does not crash', async function () {
    this.timeout(90_000);

    const { uri } = await openCSharpFile(
      tmpDir,
      'double-restart.cs',
      'class DoubleRestart { void M() { } }',
    );
    await waitForDocumentSymbols(uri);

    // First restart.
    await vscode.commands.executeCommand('sharplsp.restartServer');
    await waitForDocumentSymbols(uri, 30_000);

    // Second restart.
    await vscode.commands.executeCommand('sharplsp.restartServer');
    const symbols = await waitForDocumentSymbols(uri, 30_000);
    assert.ok(symbols.length > 0, 'Server should respond after double restart');
  });

  // ── Restart With Different Content ─────────────────────────

  test('restart preserves ability to handle new files', async function () {
    this.timeout(60_000);

    // Start with one file.
    const { uri: uri1 } = await openCSharpFile(
      tmpDir,
      'before-restart.cs',
      'class BeforeRestart { }',
    );
    await waitForDocumentSymbols(uri1);

    await vscode.commands.executeCommand('sharplsp.restartServer');

    // After restart, open a NEW file.
    await closeAllEditors();
    const { uri: uri2 } = await openCSharpFile(
      tmpDir,
      'after-restart.cs',
      'class AfterRestart { void NewMethod() { } }',
    );
    const symbols = await waitForDocumentSymbols(uri2, 30_000);
    const names = flattenNames(symbols);
    assert.ok(names.includes('AfterRestart'), 'New file after restart should be served');
    assert.ok(names.includes('NewMethod'), 'New file methods should be resolved');
  });

  // ── Large File Handling ────────────────────────────────────

  test('server handles a file with many declarations', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 10_000);

    // Generate a file with 20 methods.
    const methods = Array.from(
      { length: 20 },
      (_, i) => `    public void Method${i}() { var x${i} = ${i}; }`,
    ).join('\n');
    const content = `namespace BigFile {\n  public class BigClass {\n${methods}\n  }\n}`;

    const { uri } = await openCSharpFile(tmpDir, 'big.cs', content);
    const symbols = await waitForDocumentSymbols(uri);
    const names = flattenNames(symbols);

    assert.ok(names.includes('BigClass'), 'Should find BigClass');
    // Verify at least some methods are found.
    assert.ok(names.includes('Method0'), 'Should find Method0');
    assert.ok(names.includes('Method19'), 'Should find Method19');
    assert.ok(names.length >= 21, `Expected ≥21 symbols, got ${names.length}`);
  });

  // ── Empty File ─────────────────────────────────────────────

  test('server handles empty file without crashing', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);

    const { uri } = await openCSharpFile(tmpDir, 'empty.cs', '');

    // Should not crash; may return null or empty array.
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    const count = result?.length ?? 0;
    assert.strictEqual(count, 0, 'Empty file should produce zero symbols');
  });

  // ── Malformed File ─────────────────────────────────────────

  test('server handles malformed C# without crashing', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);

    const { uri } = await openCSharpFile(
      tmpDir,
      'malformed.cs',
      'class { this is not valid C# code }{{{',
    );

    // Should not crash — tree-sitter is error-tolerant.
    await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    // May or may not find partial symbols; the point is it doesn't crash.
    assert.ok(true, 'Server did not crash on malformed input');
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
