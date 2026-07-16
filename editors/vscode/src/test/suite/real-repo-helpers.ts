// Shared harness for the real-world repository e2e stress suites.
//
// Clones pinned tags of real, popular .NET repos into <repo-root>/real-world-fixtures/
// (gitignored — never committed), restores them once, and exposes interaction
// + resource-sampling helpers. Tests drive REAL solutions through the REAL
// extension host and assert on the LSP results and on the server processes'
// memory/CPU footprint.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID, waitForHoverResult } from './test-helpers';

export interface RealRepoSpec {
  /** Directory name under real-world-fixtures/. */
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

/** <repo-root>/real-world-fixtures — out/test/suite is five levels down. */
export function realWorldFixturesRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'real-world-fixtures');
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
    fs.rmSync(repoDir, { recursive: true, force: true });
    execFileSync('git', ['clone', '--depth', '1', '--branch', spec.tag, spec.url, spec.name], {
      cwd: root,
      stdio: 'pipe',
      timeout: 600_000,
    });
  }
  const globalJson = path.join(repoDir, 'global.json');
  if (fs.existsSync(globalJson)) fs.rmSync(globalJson);
  if (!fs.existsSync(path.join(repoDir, RESTORED_MARKER))) {
    execFileSync('dotnet', ['restore', spec.sln], {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 900_000,
    });
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

export interface ProcessSample {
  pid: number;
  name: string;
  rssBytes: number;
  cpuSeconds: number;
  commandLine: string;
}

/**
 * Sample every SharpLsp server process: the Rust host binary plus the C#/F#
 * sidecars (matched by name or command line, however they were spawned).
 * Read-only: never signals or kills anything.
 */
export function sampleServerProcesses(): ProcessSample[] {
  const all = process.platform === 'win32' ? sampleWindows() : samplePosix();
  return all.filter(
    (proc) =>
      proc.name.toLowerCase().includes('sharplsp') ||
      proc.commandLine.toLowerCase().includes('sharplsp'),
  );
}

interface Win32ProcessRow {
  ProcessId: number;
  Name: string;
  CommandLine: string | null;
  WorkingSetSize: number;
  UserModeTime: number;
  KernelModeTime: number;
}

function sampleWindows(): ProcessSample[] {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'sharplsp%' OR Name='dotnet.exe'\" | " +
    'Select-Object ProcessId,Name,CommandLine,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  ).trim();
  if (raw.length === 0) return [];
  const parsed = JSON.parse(raw) as Win32ProcessRow | Win32ProcessRow[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: row.ProcessId,
    name: row.Name,
    rssBytes: row.WorkingSetSize,
    // Win32_Process times are in 100ns units.
    cpuSeconds: (row.UserModeTime + row.KernelModeTime) / 1e7,
    commandLine: row.CommandLine ?? '',
  }));
}

function samplePosix(): ProcessSample[] {
  const raw = execFileSync('ps', ['-eo', 'pid=,rss=,time=,args='], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      const [, pid, rssKb, time, args] = match ?? [];
      if (pid === undefined || rssKb === undefined || time === undefined || args === undefined) {
        return undefined;
      }
      return {
        pid: Number(pid),
        name: path.basename(args.split(' ')[0] ?? ''),
        rssBytes: Number(rssKb) * 1024,
        cpuSeconds: parsePsTime(time),
        commandLine: args,
      };
    })
    .filter((sample): sample is ProcessSample => sample !== undefined);
}

/** Parse ps TIME ([[dd-]hh:]mm:ss) into seconds. */
function parsePsTime(time: string): number {
  const dashIndex = time.indexOf('-');
  const days = dashIndex >= 0 ? Number(time.slice(0, dashIndex)) : 0;
  const clock = dashIndex >= 0 ? time.slice(dashIndex + 1) : time;
  const parts = clock.split(':').map(Number).reverse();
  const [seconds = 0, minutes = 0, hours = 0] = parts;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

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

const HOST_RSS_MAX_BYTES = 2 * 1024 ** 3; // Rust host: 2 GiB is already pathological.
const SIDECAR_RSS_MAX_BYTES = 4 * 1024 ** 3; // Roslyn/FCS on a medium repo stays well under 4 GiB.
const MAX_SIDECARS_PER_LANGUAGE = 2; // >2 of one language = the orphaned-process leak (#133).

/**
 * Assert the server fleet is alive and within resource bounds. Bounds are
 * deliberately generous — they exist to catch runaway leaks and process
 * storms, not to flake on GC timing.
 */
export function assertServerResourceBounds(samples: ProcessSample[]): void {
  assert.ok(samples.length >= 1, 'at least one SharpLsp server process must be running');
  for (const proc of samples) {
    const isHost =
      proc.name.toLowerCase().startsWith('sharplsp') && !proc.commandLine.includes('sidecar');
    const cap = isHost ? HOST_RSS_MAX_BYTES : SIDECAR_RSS_MAX_BYTES;
    const mib = Math.round(proc.rssBytes / 1024 ** 2);
    assert.ok(
      proc.rssBytes < cap,
      `${proc.name} (pid ${proc.pid.toString()}) rss ${mib.toString()} MiB exceeds ${Math.round(cap / 1024 ** 2).toString()} MiB cap`,
    );
    assert.ok(proc.cpuSeconds >= 0, `${proc.name} cpu time must be readable`);
  }
  for (const language of ['sidecar-csharp', 'sidecar-fsharp']) {
    const count = samples.filter((proc) => proc.commandLine.includes(language)).length;
    assert.ok(
      count <= MAX_SIDECARS_PER_LANGUAGE,
      `${count.toString()} ${language} processes running — process leak (expected <= ${MAX_SIDECARS_PER_LANGUAGE.toString()})`,
    );
  }
}

/**
 * Assert CPU settles after a burst. Background analysis (solution-wide
 * diagnostics sweeps, FCS checks) legitimately runs hot right after a storm,
 * so "settles" means SOME `windowMs` window stays under `maxCpuSeconds`
 * within a minute — only a permanently pegged fleet (runaway loop) fails.
 */
export async function assertCpuSettles(windowMs: number, maxCpuSeconds: number): Promise<void> {
  const attempts = 12;
  let lastDelta = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = totalCpuSeconds(sampleServerProcesses());
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    lastDelta = totalCpuSeconds(sampleServerProcesses()) - before;
    if (lastDelta < maxCpuSeconds) return;
  }
  assert.fail(
    `server fleet never settled: still burning ${lastDelta.toFixed(1)} cpu-seconds per ` +
      `${windowMs.toString()}ms window after ${attempts.toString()} windows (cap ${maxCpuSeconds.toString()}s)`,
  );
}

function totalCpuSeconds(samples: ProcessSample[]): number {
  return samples.reduce((sum, proc) => sum + proc.cpuSeconds, 0);
}
