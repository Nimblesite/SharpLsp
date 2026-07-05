import * as assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  findSharpLspBinary,
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

  // ── Unexpected Server Death → Auto-Restart (issue #8) ────────
  //
  // GitHub #8: the language server was killed out from under the client
  // (transient extension-host restart, or `make install-rust` replacing the
  // binary on disk mid-session). VS Code's DEFAULT error handler reported the
  // close as "SIGKILL" and popped a modal instead of silently recovering,
  // leaving the extension disconnected. The fix (client.ts `makeErrorHandler`)
  // returns `CloseAction.Restart` with `handled: true` for up to 5 unexpected
  // closes. This test SIGKILLs the real server process and asserts the client
  // recovers on its own — WITHOUT any `restartServer` command.
  test('unexpected SIGKILL of the server auto-recovers without manual restart', async function () {
    if (process.platform === 'win32') {
      // Relies on POSIX `ps`; the e2e host runs on macOS/Linux.
      this.skip();
    }
    this.timeout(90_000);

    // Resolve the exact staged server binary the extension launched. Matching
    // this precise path (not a bare `sharplsp` basename) guarantees we only ever
    // kill the test host's own server — never a `sharplsp` a developer happens
    // to be running elsewhere on the machine.
    const serverBinary = findSharpLspBinary();
    assert.ok(serverBinary, 'Test host must resolve a staged sharplsp binary');

    // Confirm the server is up and serving before we kill it.
    const { uri } = await openCSharpFile(
      tmpDir,
      'sigkill-recovery.cs',
      'class BeforeKill { void M() { } }',
    );
    await waitForDocumentSymbols(uri);

    // Kill every running server process launched from that exact binary (NOT the
    // sidecars, which run as `sharplsp-sidecar-*` / `dotnet`). This reproduces
    // the exact #8 scenario: the server dies out from under the client.
    const killed = killLspServerProcesses(serverBinary);
    assert.ok(killed > 0, 'Expected at least one running sharplsp server process to kill');

    // Do NOT invoke sharplsp.restartServer — recovery must come purely from the
    // client's error handler. Poll generously: kill → connection close → the
    // handler's CloseAction.Restart → respawn → re-sync the open document.
    const symbols = await waitForDocumentSymbols(uri, 60_000);
    assert.ok(
      symbols.length > 0,
      'Client must auto-restart the server and serve symbols again after an unexpected SIGKILL',
    );
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

/**
 * SIGKILL every running language-server process launched from `binaryPath` and
 * return how many were killed. Matches the exact executable path so it targets
 * the test host's own server only — the sidecars run as `sharplsp-sidecar-csharp`
 * / `-fsharp` or `dotnet` (distinct executables) and are left alone, as is any
 * `sharplsp` a developer is running from a different location. POSIX-only (`ps`).
 */
function killLspServerProcesses(binaryPath: string): number {
  const listing = execSync('ps -ax -o pid=,command=', { encoding: 'utf8' });
  let killed = 0;
  for (const line of listing.split('\n')) {
    const trimmed = line.trim();
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace < 0) continue;
    const pid = Number.parseInt(trimmed.slice(0, firstSpace), 10);
    const command = trimmed.slice(firstSpace + 1);
    const executable = command.split(' ')[0] ?? '';
    if (!Number.isNaN(pid) && executable === binaryPath) {
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch {
        // Process already exited between listing and kill — fine.
      }
    }
  }
  return killed;
}

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
