import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { detectRuntimePlatform } from '../../platform.js';

// ── Constants ────────────────────────────────────────────────────

export const EXTENSION_ID = 'nimblesite.sharplsp';
export const SERVER_START_TIMEOUT_MS = 30_000;
export const LSP_RESPONSE_TIMEOUT_MS = 15_000;
export const POLL_INTERVAL_MS = 100;

// ── Binary Discovery ─────────────────────────────────────────────

/**
 * Find the sharplsp binary.
 *
 * Priority:
 *   1. `SHARPLSP_EXECUTABLE_PATH` env var
 *   2. Bundled binary under `bin/<platform>/`
 *   3. Legacy bundled binary under `bin/`
 */
export function findSharpLspBinary(): string | undefined {
  const envPath = process.env['SHARPLSP_EXECUTABLE_PATH'];
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const binaryName = process.platform === 'win32' ? 'sharplsp.exe' : 'sharplsp';
  const platform = detectRuntimePlatform();

  // __dirname at runtime: editors/vscode/out/test/suite/
  const extensionRoot = path.resolve(__dirname, '../../..');

  const bundled = path.join(extensionRoot, 'bin', platform, binaryName);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const legacyBundled = path.join(extensionRoot, 'bin', binaryName);
  if (fs.existsSync(legacyBundled)) {
    return legacyBundled;
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

/**
 * Flatten a hierarchical DocumentSymbol tree into a flat list of names,
 * recursing through children. `executeDocumentSymbolProvider` returns NESTED
 * symbols (e.g. a class under its namespace), so name lookups must walk the
 * whole tree, not just the top level.
 */
export function flattenSymbolNames(symbols: vscode.DocumentSymbol[]): string[] {
  const names: string[] = [];
  const walk = (list: vscode.DocumentSymbol[]): void => {
    for (const symbol of list) {
      names.push(symbol.name);
      walk(symbol.children);
    }
  };
  walk(symbols);
  return names;
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

/** Close all open editors and dismiss the bottom panel. */
export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // Also dismiss the bottom panel. An Output/Trace channel left shown by a prior
  // test (e.g. showTraceOutput / "Show Log" routing) otherwise stays the active
  // item and pollutes window.activeTextEditor and editor.foldAll in the NEXT
  // test — the root cause of the cross-test focus-race flakiness. closePanel is a
  // no-op when nothing is open, so this is always safe.
  await vscode.commands.executeCommand('workbench.action.closePanel');
}

// ── Suite Setup / Teardown ───────────────────────────────────────

/**
 * Standard setup for an LSP test suite:
 *   - Creates a temp directory
 *   - Activates the SharpLsp extension
 *   - Waits until the server responds to a documentSymbol request
 */
export async function setupLspTestSuite(tmpDirPrefix: string): Promise<{
  tmpDir: string;
  sharplspBinary: string | undefined;
}> {
  const tmpDir = fs.mkdtempSync(
    path.join(process.env['TMPDIR'] ?? '/tmp', `sharplsp-test-${tmpDirPrefix}`),
  );

  const sharplspBinary = findSharpLspBinary();

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

  return { tmpDir, sharplspBinary };
}

/** Remove the temp directory created by `setupLspTestSuite`. */
export function teardownLspTestSuite(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

// ── Screenshots ──────────────────────────────────────────────────

const SCREENSHOT_OUT_DIR = path.resolve(__dirname, '../../../../../website/src/assets/screenshots');

/**
 * Open the SharpLsp activity bar panel (shows Solution Explorer + Profiler).
 * Only does anything when SHARPLSP_SCREENSHOTS=1 is set.
 */
export async function openSharpLspPanel(): Promise<void> {
  if (!process.env['SHARPLSP_SCREENSHOTS']) return;
  await vscode.commands.executeCommand('workbench.view.extension.sharplsp-explorer');
  await sleep(1500);
}

/**
 * Open the SharpLsp activity bar panel focused on the Profiler view.
 * Only does anything when SHARPLSP_SCREENSHOTS=1 is set.
 */
export async function openSharpLspPanelProfiler(): Promise<void> {
  if (!process.env['SHARPLSP_SCREENSHOTS']) return;
  await vscode.commands.executeCommand('workbench.view.extension.sharplsp-explorer');
  await sleep(600);
  await vscode.commands.executeCommand('sharplsp.profiler.refresh');
  await sleep(1200);
}

/**
 * Signal the Playwright sidecar (screenshots/sidecar.mjs) to take a screenshot
 * of the VS Code window via CDP. Writes a .signal file and waits for the PNG.
 * Call this after assertions prove the feature is live and visible.
 * Only runs when SHARPLSP_SCREENSHOTS=1 is set.
 */
export async function takeScreenshot(filename: string): Promise<void> {
  if (!process.env['SHARPLSP_SCREENSHOTS']) return;
  fs.mkdirSync(SCREENSHOT_OUT_DIR, { recursive: true });
  const tempFilename = `${filename}.tmp-${process.pid.toString()}.png`;
  const signalPath = path.join(SCREENSHOT_OUT_DIR, `${tempFilename}.signal`);
  const outPath = path.join(SCREENSHOT_OUT_DIR, filename);
  const tempPath = path.join(SCREENSHOT_OUT_DIR, tempFilename);
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  fs.writeFileSync(signalPath, filename, 'utf8');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(tempPath)) {
      fs.renameSync(tempPath, outPath);
      console.log(`[screenshot] ${filename}`);
      return;
    }
    await sleep(100);
  }
  throw new Error(`Sidecar did not write ${filename} within 15s`);
}

// ── Utilities ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
