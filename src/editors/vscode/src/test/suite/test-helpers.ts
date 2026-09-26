import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { detectRuntimePlatform, exeName } from '../../platform.js';
import { removeDirRecursive } from '../../utils';
import { LSP_RESPONSE_MS, POLL_INTERVAL_MS, READINESS_MS, SIDECAR_COLD_MS } from './test-timeouts';

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
 *   3. Bundled binary under `bin/`
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

  const bundledBinary = path.join(extensionRoot, 'bin', binaryName);
  if (fs.existsSync(bundledBinary)) {
    return bundledBinary;
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
  waitingFor = 'a condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();

  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }

  if (!predicate(last)) {
    assert.fail(
      `Timed out after ${String(timeoutMs)}ms polling for ${waitingFor}, which never held. ` +
        `Last observed value: ${describePolled(last)}`,
    );
  }
  return last;
}

/**
 * Poll a `vscode.execute…Provider` command with `args` until `until` holds over
 * its reply, an absent reply reading as `[]`. Fails as `pollUntilResult` does,
 * naming the command, so a provider that never answers reports itself.
 */
export async function pollProvider<T>(
  command: string,
  args: readonly unknown[],
  until: (reply: T[]) => boolean,
  timeoutMs: number = LSP_RESPONSE_MS,
  intervalMs: number = POLL_INTERVAL_MS,
  waitingFor = `${command} to answer as expected`,
): Promise<T[]> {
  return pollUntilResult(
    async () => (await vscode.commands.executeCommand<T[]>(command, ...args)) ?? [],
    until,
    timeoutMs,
    intervalMs,
    waitingFor,
  );
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
 *
 * CALL THIS ONLY ON A FILE WHOSE FIXTURE IS KNOWN TO PRODUCE A CODE ACTION.
 * "Roslyn has loaded the project" and "Roslyn offers an action at line 0 of this
 * file" are not the same claim: the cross-language rename fixtures are loaded
 * and offer nothing there, and F#'s FCS makes no such promise at all. Wired into
 * a shared opener this waited out the whole budget and then failed suites that
 * were never broken — a warm-up that can fail on a healthy file is worse than no
 * warm-up. Hence an explicit call, per suite, on a fixture that has been checked.
 */
export async function warmSemanticEngine(
  uri: vscode.Uri,
  timeoutMs: number = SIDECAR_COLD_MS,
): Promise<void> {
  const start = new vscode.Position(0, 0);
  await pollProvider<vscode.CodeAction>(
    'vscode.executeCodeActionProvider',
    [uri, new vscode.Range(start, start)],
    (actions) => actions.length > 0,
    timeoutMs,
  );
}

/** A text to search, or a set, map (by key) or list to look entries up in. */
export type Haystack<T> = string | ReadonlySet<T> | ReadonlyMap<T, unknown> | readonly unknown[];

/**
 * Assert `haystack` holds EVERY one of `needles` — by substring in a string, by
 * membership otherwise. One failure names every missing needle and what the
 * haystack held, where a run of single asserts stops at the first miss.
 */
export function assertContainsAll<T>(
  haystack: Haystack<NoInfer<T>>,
  needles: readonly T[],
  what: string,
): void {
  const entries = typeof haystack === 'string' ? undefined : entriesOf(haystack);
  const missing = needles.filter((needle) =>
    entries === undefined ? !String(haystack).includes(String(needle)) : !entries.includes(needle),
  );
  const held = entries === undefined ? String(haystack).slice(0, 400) : JSON.stringify(entries);
  assert.deepStrictEqual(missing, [], `${what}: missing ${JSON.stringify(missing)} from ${held}`);
}

/**
 * Assert `haystack` holds NONE of `needles`, naming every one that slipped in
 * and what the haystack held.
 */
export function assertContainsNone<T>(
  haystack: Haystack<NoInfer<T>>,
  needles: readonly T[],
  what: string,
): void {
  const entries = typeof haystack === 'string' ? undefined : entriesOf(haystack);
  const present = needles.filter((needle) =>
    entries === undefined ? String(haystack).includes(String(needle)) : entries.includes(needle),
  );
  const held = entries === undefined ? String(haystack).slice(0, 400) : JSON.stringify(entries);
  assert.deepStrictEqual(present, [], `${what}: unexpected ${JSON.stringify(present)} in ${held}`);
}

/** What a set, map or list holds: a set's members, a map's keys, a list's items. */
function entriesOf<T>(haystack: Exclude<Haystack<T>, string>): readonly unknown[] {
  return Array.isArray(haystack) ? haystack : [...(haystack as ReadonlySet<T>).keys()];
}

/** Poll the document-symbol provider for `uri` until `until` holds over its reply. */
export async function pollSymbols(
  uri: vscode.Uri,
  until: (symbols: vscode.DocumentSymbol[]) => boolean,
  timeoutMs: number = LSP_RESPONSE_MS,
  intervalMs: number = POLL_INTERVAL_MS,
): Promise<vscode.DocumentSymbol[]> {
  return pollProvider('vscode.executeDocumentSymbolProvider', [uri], until, timeoutMs, intervalMs);
}

/** Wait for document symbols to be returned by the LSP server. */
export async function waitForDocumentSymbols(
  uri: vscode.Uri,
  timeoutMs: number = LSP_RESPONSE_MS,
): Promise<vscode.DocumentSymbol[]> {
  return pollSymbols(uri, (symbols) => symbols.length > 0, timeoutMs);
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
  return pollProvider<vscode.FoldingRange>(
    'vscode.executeFoldingRangeProvider',
    [uri],
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
  return pollProvider<vscode.SelectionRange>(
    'vscode.executeSelectionRangeProvider',
    [uri, positions],
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
  return pollProvider<vscode.Hover>(
    'vscode.executeHoverProvider',
    [uri, position],
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

/** Create and open a C# file, then wait for the outline the server reports for it. */
export async function openCSharpOutline(
  tmpDir: string,
  filename: string,
  content: string,
  timeoutMs: number = LSP_RESPONSE_MS,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri; symbols: vscode.DocumentSymbol[] }> {
  const opened = await openCSharpFile(tmpDir, filename, content);
  return { ...opened, symbols: await waitForDocumentSymbols(opened.uri, timeoutMs) };
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

/**
 * Open a file that ALREADY exists on disk and show it.
 *
 * The committed fixture workspace is the input to every semantic suite; a
 * helper that writes content first would overwrite the very fixture under test.
 */
export async function openExistingFile(
  directory: string,
  filename: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  const uri = vscode.Uri.file(path.join(directory, filename));
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

  // Poll until the server is ready — documentSymbol returns results. The
  // budget sits under the `ACTIVATION_MS` hook every caller runs this in, so a
  // server that never answers is reported HERE, by name, and not by mocha's
  // generic hook timeout ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
  await pollProvider<vscode.DocumentSymbol>(
    'vscode.executeDocumentSymbolProvider',
    [uri],
    (symbols) => symbols.length > 0,
    READINESS_MS,
    500,
    `the SharpLsp server (${sharplspBinary ?? 'no staged binary found'}) to answer documentSymbol for the probe file`,
  );

  await closeAllEditors();

  return { tmpDir, sharplspBinary };
}

/**
 * Recursively delete a scratch directory, tolerating Windows file-handle races.
 *
 * Teardown hooks flaked on the Windows runners while the identical code was
 * stable on Linux: a spawned child still held a file open. Cleanup failure must
 * never fail an otherwise-passing test. Use this everywhere instead of a bare
 * rmSync — it is the production helper, so the retry policy has one home.
 * Implements [DIST-CI-WIN-VSIX].
 */
export { removeDirRecursive };

/** Remove the temp directory created by `setupLspTestSuite`. */
export function teardownLspTestSuite(tmpDir: string): void {
  removeDirRecursive(tmpDir);
}

// ── Screenshots ──────────────────────────────────────────────────

const SCREENSHOT_OUT_DIR = path.resolve(__dirname, '../../../../../website/src/assets/screenshots');

/**
 * Load the fixture solution into the Solution Explorer so a documentation
 * screenshot has content.
 *
 * Screenshot-only plumbing: it resolves the explorer through the extension's
 * published API and waits for the tree to populate. A no-op when the extension
 * publishes no explorer.
 */
export async function loadFixtureSolution(workspaceRoot: string): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const api = extension?.exports as
    | {
        explorerProvider?: {
          loadSolution(solutionPath: string): Promise<void>;
          getChildren(element?: unknown): unknown[] | undefined;
        };
      }
    | undefined;
  const provider = api?.explorerProvider;
  if (!provider) return;
  await provider.loadSolution(path.join(workspaceRoot, 'TestFixtures.sln'));
  let waited = 0;
  while ((provider.getChildren() ?? []).length === 0 && waited < 8000) {
    await sleep(200);
    waited += 200;
  }
}

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

/**
 * Pause for the workbench to RENDER, but only when a screenshot will actually
 * be taken.
 *
 * {@link takeScreenshot} and {@link openSharpLspPanel} both return immediately
 * unless `SHARPLSP_SCREENSHOTS` is set, so a bare `sleep` before one of them is
 * time CI spends waiting for a picture it is never going to capture. Every such
 * pause goes through here instead.
 *
 * This is deliberately a SLEEP and not a poll: what it waits for is the
 * compositor painting a widget that is already open, which nothing in the
 * extension API reports. That is also why it must never be load-bearing for an
 * assertion - a test that needs a condition to hold polls for the condition
 * with {@link pollUntilResult}, which fails loudly when it never does.
 */
export async function settleForScreenshot(ms: number): Promise<void> {
  if (!process.env['SHARPLSP_SCREENSHOTS']) return;
  await sleep(ms);
}

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
