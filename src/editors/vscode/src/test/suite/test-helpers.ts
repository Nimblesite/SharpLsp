import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { detectRuntimePlatform, exeName } from '../../platform.js';
import { ACTIVATION_MS, LSP_RESPONSE_MS, POLL_INTERVAL_MS, SIDECAR_COLD_MS } from './test-timeouts';

// ── Constants ────────────────────────────────────────────────────

export const EXTENSION_ID = 'nimblesite.sharplsp';

// ── Path Comparison ──────────────────────────────────────────────

/**
 * Normalize a filesystem path for equality assertions.
 *
 * Windows paths are case-insensitive, POSIX paths are not. VS Code lowercases
 * the drive letter whenever a path travels through `Uri.fsPath`, while
 * `extensionPath` and `os.tmpdir()` preserve the original casing — so on win32
 * the very same file legitimately has two spellings. Comparing them
 * case-sensitively is a false negative that fires on every Windows run
 * ([DIST-CI-WIN-VSIX]); comparing them case-insensitively on POSIX would be
 * wrong, because there `/tmp/A` and `/tmp/a` really are different files.
 */
export function comparablePath(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

/**
 * Normalize line endings for text equality assertions.
 *
 * VS Code gives a newly created document the platform default EOL (`\r\n` on
 * Windows) and rewrites inserted text to match it, so a generator that emits
 * `\n` legitimately lands in the buffer — and then on disk — as `\r\n`. That is
 * correct behaviour: a new C# file on Windows should have Windows line endings.
 * These assertions are about CONTENT, so compare EOL-agnostically rather than
 * asserting a byte sequence the editor is entitled to choose
 * ([DIST-CI-WIN-VSIX]).
 */
export function comparableText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

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

  const binaryName = exeName('sharplsp');
  const platform = detectRuntimePlatform();

  // __dirname at runtime: src/editors/vscode/out/test/suite/
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

/** Render a polled value for a failure message without flooding the report. */
function describePolled(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/**
 * Poll a function until a predicate is satisfied, or FAIL.
 *
 * Exhausting the budget throws. It must: every caller is polling for something
 * the feature under test is supposed to make true, so a budget that runs out is
 * the feature not working. Returning the last value instead — which this used to
 * do — turned that into a silent pass wherever the caller discarded the result,
 * and into a confusing downstream assertion wherever it didn't
 * ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 */
export async function pollUntilResult<T>(
  fn: () => PromiseLike<T>,
  predicate: (result: T) => boolean,
  timeoutMs: number = LSP_RESPONSE_MS,
  intervalMs: number = POLL_INTERVAL_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();

  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }

  if (!predicate(last)) {
    assert.fail(
      `Timed out after ${String(timeoutMs)}ms polling for a condition that never held. ` +
        `Last observed value: ${describePolled(last)}`,
    );
  }
  return last;
}

/**
 * Block until the SEMANTIC engine can answer about `uri` — not just the syntax
 * one.
 *
 * `documentSymbol` is NOT a readiness probe: for C# the Rust host answers it
 * from tree-sitter in single-digit milliseconds and the sidecar never sees it.
 * A code action has to reach Roslyn, so it is the cheapest request that proves
 * the project is actually loaded.
 *
 * Call this from `suiteSetup`. Paying the cold load once per suite is what makes
 * `LSP_RESPONSE_MS` — "one semantic request answered by a WARM sidecar" — an
 * honest ceiling for every test that follows ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 */
export async function warmSemanticEngine(
  uri: vscode.Uri,
  timeoutMs: number = SIDECAR_COLD_MS,
): Promise<void> {
  const start = new vscode.Position(0, 0);
  await pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        new vscode.Range(start, start),
      )) ?? [],
    (actions) => actions.length > 0,
    timeoutMs,
  );
}

/** Wait for document symbols to be returned by the LSP server. */
export async function waitForDocumentSymbols(
  uri: vscode.Uri,
  timeoutMs: number = LSP_RESPONSE_MS,
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
  timeoutMs: number = LSP_RESPONSE_MS,
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
  timeoutMs: number = LSP_RESPONSE_MS,
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
  timeoutMs: number = LSP_RESPONSE_MS,
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
  timeoutMs: number = LSP_RESPONSE_MS,
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
  timeoutMs: number = LSP_RESPONSE_MS,
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
  // `os.tmpdir()` — NOT a hardcoded `/tmp` — is the fallback so the LSP e2e
  // suites run on Windows too (the win32 smoke subset in CI, [DIST-CI-WIN-VSIX]):
  // Windows has no `/tmp`, and `mkdtempSync('/tmp/...')` there resolves to
  // `<drive>:\tmp` and fails with ENOENT. `os.tmpdir()` honours TEMP/TMP on
  // Windows and TMPDIR on POSIX. The explicit TMPDIR override is kept for the
  // Linux CI job.
  const tmpDir = fs.mkdtempSync(
    path.join(process.env['TMPDIR'] ?? os.tmpdir(), `sharplsp-test-${tmpDirPrefix}`),
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
    ACTIVATION_MS,
    500,
  );

  await closeAllEditors();

  return { tmpDir, sharplspBinary };
}

/**
 * Recursively delete a scratch directory, tolerating Windows file-handle races.
 *
 * `force: true` only swallows ENOENT — it does NOT retry. On Windows a directory
 * whose files are still open in a spawned child (dotnet, VBCSCompiler, a sidecar)
 * fails the delete with EPERM/EBUSY, which is why teardown hooks flaked on the
 * Windows runners while the identical code is stable on Linux. Node retries exactly
 * those codes when given maxRetries/retryDelay.
 *
 * Cleanup failure must never fail an otherwise-passing test, so this is best-effort
 * after the retries are exhausted. Use this everywhere instead of a bare rmSync:
 * a per-call-site copy is how the retry policy drifts. Implements [DIST-CI-WIN-VSIX].
 */
export function removeDirRecursive(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort: a leaked handle in a child process must not fail the suite.
  }
}

/** Remove the temp directory created by `setupLspTestSuite`. */
export function teardownLspTestSuite(tmpDir: string): void {
  removeDirRecursive(tmpDir);
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Extension-host workspace ─────────────────────────────────────

/**
 * The workspace folder the extension-host tests are launched against.
 *
 * `runTest.ts` opens `test-fixtures/workspace`; a fixture written into a temp
 * directory instead lives OUTSIDE every workspace folder, which is a different
 * (and specified) refusal path — so a suite that needs a bound
 * `session.workspaceFolder` must scratch inside this root.
 */
export function requireWorkspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined || root === '') {
    throw new Error('the VSIX host must be launched with the committed fixture workspace open');
  }
  return root;
}

/**
 * Index into an observed list, failing with the observed count when short.
 *
 * `items[i]!` hides the interesting half of the failure: how many were actually
 * observed. Every wait-then-index site wants the same diagnosis.
 */
export function requireAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`${label} must exist; only ${String(items.length)} were observed`);
  }
  return item;
}

// ── Assertion shorthand ──────────────────────────────────────────

/**
 * The three assert forms every end-to-end suite here uses.
 *
 * These suites are assertion-dense by design and CLAUDE.md caps a file at 500
 * lines, so the forms are bound once — every call still asserts an exact VALUE,
 * with a message naming the contract it enforces. Binding them per file is how
 * nineteen byte-identical copies of the same four lines came to exist.
 */
export type Compare = (actual: unknown, expected: unknown, message: string) => void;

/** `assert.strictEqual`, typed for `unknown` operands. */
export const eq: Compare = assert.strictEqual;

/** `assert.notStrictEqual`, typed for `unknown` operands. */
export const neq: Compare = assert.notStrictEqual;

/** `assert.deepStrictEqual`, typed for `unknown` operands. */
export const deepEq: Compare = assert.deepStrictEqual;
