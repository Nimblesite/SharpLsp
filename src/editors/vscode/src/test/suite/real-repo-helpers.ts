// Shared harness for the real-world repository e2e stress suites.
//
// Clones pinned tags of real, popular .NET repos into <repo-root>/src/fixtures/real-world/
// (gitignored — never committed), restores them once, and exposes interaction
// + resource-sampling helpers. Tests drive REAL solutions through the REAL
// extension host and assert on the LSP results and on the server processes'
// memory/CPU footprint.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID, removeDirRecursive, waitForHoverResult } from './test-helpers';
export {
  assertCpuSettles,
  assertServerResourceBounds,
  sampleServerProcesses,
  type ProcessSample,
} from './real-repo-process-helpers';

export interface RealRepoSpec {
  /** Directory name under src/fixtures/real-world/. */
  name: string;
  url: string;
  /** Pinned tag — keeps anchors deterministic across runs. */
  tag: string;
  /** Solution file relative to the clone root. */
  sln: string;
}

export const SERILOG: RealRepoSpec = {
  name: 'serilog',
  url: 'https://github.com/serilog/serilog',
  tag: 'v4.4.0',
  sln: 'Serilog.sln',
};

export const FLUENT_VALIDATION: RealRepoSpec = {
  name: 'fluentvalidation',
  url: 'https://github.com/FluentValidation/FluentValidation',
  tag: '12.1.1',
  sln: 'FluentValidation.sln',
};

export const FSTOOLKIT: RealRepoSpec = {
  name: 'fstoolkit',
  url: 'https://github.com/demystifyfp/FsToolkit.ErrorHandling',
  tag: '5.2.0',
  sln: 'FsToolkit.ErrorHandling.sln',
};

/** <repo-root>/src/fixtures/real-world — out/test/suite is five levels below src. */
export function realWorldFixturesRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'fixtures', 'real-world');
}

const RESTORED_MARKER = '.sharplsp-restored';

/**
 * Clone (shallow, pinned tag) and `dotnet restore` a real repo, once.
 * Subsequent runs reuse the existing clone. The clone's `global.json` is
 * removed so the fixture restores with whatever modern SDK is installed —
 * the same workspace-independent SDK policy the sidecar applies per
 * [DIST-SDK-DISCOVERY]; the LSP behavior under test is identical.
 */
export function ensureRepoReady(spec: RealRepoSpec): string {
  const root = realWorldFixturesRoot();
  fs.mkdirSync(root, { recursive: true });
  const repoDir = path.join(root, spec.name);
  if (!fs.existsSync(path.join(repoDir, spec.sln))) {
    removeDirRecursive(repoDir);
    execFileSync('git', ['clone', '--depth', '1', '--branch', spec.tag, spec.url, spec.name], {
      cwd: root,
      stdio: 'pipe',
      timeout: 600_000,
    });
  }
  const globalJson = path.join(repoDir, 'global.json');
  if (fs.existsSync(globalJson)) fs.rmSync(globalJson);
  if (!fs.existsSync(path.join(repoDir, RESTORED_MARKER))) {
    // NuGetAudit=false: the fixture is pinned to an upstream tag, but NuGet's
    // advisory database moves independently. When a CVE is published against any
    // transitive package the pinned tag happens to use, NU1903 is raised and the
    // repo's own TreatWarningsAsErrors turns restore into a hard failure — CI breaks
    // with no change on our side, on a repository we do not control. This fixture
    // exists to drive the LSP against real-world code, not to audit that code's
    // dependencies. Same normalisation as removing global.json above.
    try {
      execFileSync('dotnet', ['restore', spec.sln, '-p:NuGetAudit=false'], {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 900_000,
      });
    } catch (err: unknown) {
      // stdio:'pipe' captures NuGet's diagnostics and the default rethrow discards
      // them, leaving only "Command failed: dotnet restore". Surface them.
      const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
      const detail = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim();
      throw new Error(`dotnet restore ${spec.sln} failed:\n${detail || (e.message ?? '')}`, {
        cause: err,
      });
    }
    fs.writeFileSync(path.join(repoDir, RESTORED_MARKER), spec.tag);
  }
  return repoDir;
}

/**
 * Point the LSP server (and its sidecars) at an explicit solution via the
 * `sharplsp/loadSolution` request — the same request the extension sends
 * when a user picks a solution. The server acks immediately and loads the
 * solution asynchronously; callers must poll semantic readiness afterwards
 * (see waitForSemanticReady).
 */
export async function loadSolutionInServer(solutionPath: string): Promise<void> {
  assert.ok(fs.existsSync(solutionPath), `solution must exist: ${solutionPath}`);
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be loaded');
  const api = (await ext.activate()) as {
    getLspClient: () =>
      { sendRequest: (method: string, params: unknown) => Promise<unknown> } | undefined;
  };
  const client = api.getLspClient();
  assert.ok(client, 'LSP client must be running');
  const response = (await client.sendRequest('sharplsp/loadSolution', {
    solutionPath,
  })) as { success?: boolean };
  assert.strictEqual(response.success, true, 'sharplsp/loadSolution must ack');
}

/** The default e2e fixture solution — restored after each real-repo suite. */
export function fixtureSolutionPath(): string {
  return path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'test-fixtures',
    'workspace',
    'TestFixtures.sln',
  );
}

/**
 * Wait until SEMANTIC features answer for a position (hover non-empty).
 * Syntax features (documentSymbol) answer from tree-sitter immediately and
 * prove nothing about the sidecar's solution load.
 */
export async function waitForSemanticReady(
  uri: vscode.Uri,
  position: vscode.Position,
  timeoutMs: number,
): Promise<void> {
  const hovers = await waitForHoverResult(uri, position, timeoutMs);
  assert.ok(
    hovers.length > 0,
    `sidecar semantics never came up for ${uri.fsPath} within ${timeoutMs.toString()}ms`,
  );
}

/** Open a file from the cloned repo in a visible editor. */
export async function openRepoFile(
  repoDir: string,
  relativePath: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri; editor: vscode.TextEditor }> {
  const uri = vscode.Uri.file(path.join(repoDir, relativePath));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  return { doc, uri, editor };
}

/**
 * Locate `snippet` in the document and return the position of
 * `focus` (a substring of the snippet; defaults to its start).
 * Fails the test if either is absent — anchors must exist at the pinned tag.
 */
export function positionOf(
  doc: vscode.TextDocument,
  snippet: string,
  focus?: string,
): vscode.Position {
  const text = doc.getText();
  const snippetIndex = text.indexOf(snippet);
  assert.ok(snippetIndex >= 0, `anchor snippet not found in ${doc.fileName}: ${snippet}`);
  const focusOffset = focus === undefined ? 0 : snippet.indexOf(focus);
  assert.ok(focusOffset >= 0, `focus '${focus ?? ''}' must be inside the snippet`);
  return doc.positionAt(snippetIndex + focusOffset);
}

/** Assert a range is internally sane and inside the document. */
export function assertSaneRange(
  doc: vscode.TextDocument,
  range: vscode.Range,
  label: string,
): void {
  assert.ok(range.start.isBeforeOrEqual(range.end), `${label}: start must not follow end`);
  assert.ok(range.end.line < doc.lineCount, `${label}: range must stay inside the document`);
}

// ── Server process sampling (memory / CPU stress assertions) ──────

// ── Shared assertion helpers (used identically by every suite) ─────

/** CompletionItem.label is string | CompletionItemLabel — normalize to text. */
export function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

/** Assert at least one location came back and return the first. */
export function firstLocation(locations: vscode.Location[], label: string): vscode.Location {
  const first = locations[0];
  assert.ok(first, `${label}: at least one location expected`);
  return first;
}

/** Depth of a SelectionRange chain (how many times the selection expands). */
export function selectionDepth(range: vscode.SelectionRange | undefined, label: string): number {
  assert.ok(range, `${label}: selection ranges must answer`);
  let depth = 0;
  for (let node = range.parent; node !== undefined; node = node.parent) depth += 1;
  return depth;
}

/** Assert a diagnostics list contains an Error and return the first one. */
export function firstError(diagnostics: vscode.Diagnostic[], label: string): vscode.Diagnostic {
  const error = diagnostics.find((d) => d.severity === vscode.DiagnosticSeverity.Error);
  assert.ok(error, `${label}: at least one Error diagnostic expected`);
  return error;
}

/**
 * Wait until a document carries at least one Error diagnostic and return it.
 * Real-world files legitimately carry standing warnings/hints (unused opens,
 * lint), so waiting for *any* diagnostic returns long before the semantic
 * check of an injected error completes — the wait must be severity-aware.
 */
export async function waitForError(
  uri: vscode.Uri,
  timeoutMs: number,
  predicate: (diagnostic: vscode.Diagnostic) => boolean = () => true,
): Promise<vscode.Diagnostic> {
  const currentError = (): vscode.Diagnostic | undefined =>
    vscode.languages
      .getDiagnostics(uri)
      .find((item) => item.severity === vscode.DiagnosticSeverity.Error && predicate(item));
  const deadline = Date.now() + timeoutMs;
  while (currentError() === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const error = currentError();
  assert.ok(error, 'the requested Error diagnostic must surface');
  return error;
}

function errorDiagnosticKeys(uri: vscode.Uri): string[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error)
    .map((item) => {
      const code =
        typeof item.code === 'object' && item.code !== null ? item.code.value : item.code;
      return JSON.stringify([
        item.source ?? '',
        String(code ?? ''),
        item.message,
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
      ]);
    })
    .sort();
}

/**
 * Wait until the file's error diagnostics stop changing for 2s.
 *
 * `minimumErrors` guards against returning a baseline the language server has
 * not finished populating. Set it only when the file genuinely must report that
 * many errors — a value the source cannot reach makes this unsatisfiable, and
 * the loop will burn the whole timeout waiting for a count that never arrives.
 * The failure therefore reports what it actually observed, so a wrong
 * expectation is distinguishable from a slow one.
 */
export async function waitForStableErrorBaseline(
  uri: vscode.Uri,
  timeoutMs: number,
  minimumErrors = 0,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let previous = errorDiagnosticKeys(uri);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = errorDiagnosticKeys(uri);
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      previous = current;
      stableSince = Date.now();
    } else if (current.length >= minimumErrors && Date.now() - stableSince >= 2_000) {
      return current;
    }
  }
  const settled = errorDiagnosticKeys(uri);
  assert.fail(
    `Error diagnostic baseline never stabilized: wanted at least ${String(minimumErrors)} ` +
      `error(s) unchanged for 2s within ${String(timeoutMs)}ms, but settled on ${String(settled.length)}: ` +
      JSON.stringify(settled),
  );
}

export async function waitForErrorBaseline(
  uri: vscode.Uri,
  expected: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (JSON.stringify(errorDiagnosticKeys(uri)) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepStrictEqual(
    errorDiagnosticKeys(uri),
    expected,
    'Error diagnostics must return to their exact pre-edit baseline',
  );
}

/**
 * Wait until a document carries zero Error diagnostics, then assert it.
 * Real-world files may legitimately keep warnings/hints — asserting on a
 * fully empty diagnostics list would flake; errors are the contract.
 */
export async function waitForErrorsCleared(uri: vscode.Uri, timeoutMs: number): Promise<void> {
  const currentErrors = (): vscode.Diagnostic[] =>
    vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  const deadline = Date.now() + timeoutMs;
  while (currentErrors().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.strictEqual(currentErrors().length, 0, 'Error diagnostics must clear after the revert');
}
