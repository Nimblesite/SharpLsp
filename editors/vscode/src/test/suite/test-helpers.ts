import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

// ── Constants ────────────────────────────────────────────────────

export const EXTENSION_ID = 'forge-lsp.forge';
export const SERVER_START_TIMEOUT_MS = 30_000;
export const LSP_RESPONSE_TIMEOUT_MS = 15_000;
export const POLL_INTERVAL_MS = 100;

// ── Binary Discovery ─────────────────────────────────────────────

/**
 * Find the forge-lsp binary.
 *
 * Priority:
 *   1. `FORGE_EXECUTABLE_PATH` env var
 *   2. `target/release/forge-lsp` relative to repo root
 *   3. `target/debug/forge-lsp` relative to repo root
 */
export function findForgeBinary(): string | undefined {
  const envPath = process.env['FORGE_EXECUTABLE_PATH'];
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const binaryName = process.platform === 'win32' ? 'forge-lsp.exe' : 'forge-lsp';

  // __dirname at runtime: editors/vscode/out/test/suite/
  // Repo root: 5 levels up
  const repoRoot = path.resolve(__dirname, '../../../../..');

  const release = path.join(repoRoot, 'target', 'release', binaryName);
  if (fs.existsSync(release)) {
    return release;
  }

  const debug = path.join(repoRoot, 'target', 'debug', binaryName);
  if (fs.existsSync(debug)) {
    return debug;
  }

  return undefined;
}

// ── Polling ──────────────────────────────────────────────────────

/**
 * Poll a function until a predicate is satisfied or timeout expires.
 * Returns the last result from `fn`.
 */
export async function pollUntilResult<T>(
  fn: () => PromiseLike<T>,
  predicate: (result: T) => boolean,
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
  intervalMs: number = POLL_INTERVAL_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();

  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }

  return last;
}

/** Wait for document symbols to be returned by the LSP server. */
export async function waitForDocumentSymbols(
  uri: vscode.Uri,
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
): Promise<vscode.DocumentSymbol[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      return result ?? [];
    },
    (symbols) => symbols.length > 0,
    timeoutMs,
  );
}

/** Wait for folding ranges to be returned by the LSP server. */
export async function waitForFoldingRanges(
  uri: vscode.Uri,
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
): Promise<vscode.FoldingRange[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
        'vscode.executeFoldingRangeProvider',
        uri,
      );
      return result ?? [];
    },
    (ranges) => ranges.length > 0,
    timeoutMs,
  );
}

/** Wait for selection ranges to be returned by the LSP server. */
export async function waitForSelectionRanges(
  uri: vscode.Uri,
  positions: vscode.Position[],
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
): Promise<vscode.SelectionRange[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.SelectionRange[]>(
        'vscode.executeSelectionRangeProvider',
        uri,
        positions,
      );
      return result ?? [];
    },
    (ranges) => ranges.length > 0,
    timeoutMs,
  );
}

/** Wait for hover result at a position. Returns the Hover or undefined. */
export async function waitForHoverResult(
  uri: vscode.Uri,
  position: vscode.Position,
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
): Promise<vscode.Hover[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        position,
      );
      return result ?? [];
    },
    (hovers) => hovers.length > 0,
    timeoutMs,
  );
}

/** Wait for diagnostics to appear on a document. */
export async function waitForDiagnostics(
  uri: vscode.Uri,
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
): Promise<vscode.Diagnostic[]> {
  return pollUntilResult(
    async () => vscode.languages.getDiagnostics(uri),
    (diagnostics) => diagnostics.length > 0,
    timeoutMs,
  );
}

/** Wait for diagnostics to be cleared (empty) on a document. */
export async function waitForDiagnosticsCleared(
  uri: vscode.Uri,
  timeoutMs: number = LSP_RESPONSE_TIMEOUT_MS,
): Promise<vscode.Diagnostic[]> {
  return pollUntilResult(
    async () => vscode.languages.getDiagnostics(uri),
    (diagnostics) => diagnostics.length === 0,
    timeoutMs,
  );
}

// ── File Management ──────────────────────────────────────────────

/** Create a temporary C# file, open it in the editor, return doc + uri. */
export async function openCSharpFile(
  tmpDir: string,
  filename: string,
  content: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  return openFile(tmpDir, filename, content);
}

/** Create a temporary F# file, open it in the editor, return doc + uri. */
export async function openFSharpFile(
  tmpDir: string,
  filename: string,
  content: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  return openFile(tmpDir, filename, content);
}

async function openFile(
  tmpDir: string,
  filename: string,
  content: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  return { doc, uri };
}

/** Replace the entire content of a document. */
export async function replaceDocumentContent(
  doc: vscode.TextDocument,
  newContent: string,
): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(doc.lineCount, 0),
  );
  edit.replace(doc.uri, fullRange, newContent);
  return vscode.workspace.applyEdit(edit);
}

/** Close all open editors. */
export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

// ── Suite Setup / Teardown ───────────────────────────────────────

/**
 * Standard setup for an LSP test suite:
 *   - Creates a temp directory
 *   - Activates the Forge extension
 *   - Waits until the server responds to a documentSymbol request
 */
export async function setupLspTestSuite(tmpDirPrefix: string): Promise<{
  tmpDir: string;
  forgeBinary: string | undefined;
}> {
  const tmpDir = fs.mkdtempSync(
    path.join(process.env['TMPDIR'] ?? '/tmp', `forge-test-${tmpDirPrefix}`),
  );

  const forgeBinary = findForgeBinary();

  // Activate the extension by opening a C# file.
  const probeContent = 'namespace Probe { class Probe { } }\n';
  const { uri } = await openCSharpFile(tmpDir, 'probe.cs', probeContent);

  // Poll until the server is ready — documentSymbol returns results.
  await pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      return result ?? [];
    },
    (symbols) => symbols.length > 0,
    SERVER_START_TIMEOUT_MS,
    500,
  );

  await closeAllEditors();

  return { tmpDir, forgeBinary };
}

/** Remove the temp directory created by `setupLspTestSuite`. */
export function teardownLspTestSuite(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

// ── Utilities ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
