// Real build-oracle fixtures. Implements [DIAG-TRUTH-GUARANTEES], [DIAG-ARCHITECTURE-SCOPE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  ResponseError,
  type DocumentDiagnosticParams,
  type DocumentDiagnosticReport,
  type LanguageClient,
  type WorkspaceDiagnosticParams,
  type WorkspaceDiagnosticReport,
} from 'vscode-languageclient/node';
import { joinPath, samePath } from '../../paths';
import type { SharpLspExtensionApi } from '../../extension';
import {
  buildProjectXml,
  createSolution,
  dotnet,
  writeProject,
  type ProjectOptions,
} from './dotnet-project-kit';
import { diagnosticCode } from './document-anchors';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import { activateWithScratch, teardownFixtureSolution } from './test-explorer-kit';
import { closeAllEditors, pollUntilResult, removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

/** Retry only an explicitly incomplete snapshot; inspect the first successful report as-is. */
export async function firstDiagnosticReport<
  Report extends DocumentDiagnosticReport | WorkspaceDiagnosticReport,
>(
  client: LanguageClient,
  method: 'textDocument/diagnostic' | 'workspace/diagnostic',
  params: DocumentDiagnosticParams | WorkspaceDiagnosticParams,
  timeoutMs = LSP_RESPONSE_MS,
  waitingFor = 'the first successful diagnostic report',
): Promise<Report> {
  const report = await pollUntilResult(
    () => client.sendRequest<Report>(method, params).catch(retryIncompleteDiagnostic),
    (result) => result !== undefined,
    timeoutMs,
    100,
    waitingFor,
  );
  assert.ok(report);
  return report;
}

/** Cancellation, malformed requests and every other error remain immediate failures. */
export function retryIncompleteDiagnostic(error: unknown): undefined {
  assert.ok(error instanceof ResponseError);
  assert.equal(error.code, -32802, 'only explicitly incomplete snapshots can retry');
  assert.deepEqual(error.data, { retriggerRequest: true });
  return undefined;
}

export const ACCURACY_CASES = [
  {
    language: 'F#',
    project: 'AccuracyFs.fsproj',
    entry: 'Entry.fs',
    closed: 'Closed.fs',
    source: 'module DiagnosticAccuracy.Entry\nlet value = 42\n',
    broken: 'module DiagnosticAccuracy.Closed\nlet answer: int = "not an int"\n',
    clean: 'module DiagnosticAccuracy.Closed\nlet answer: int = 42\n',
    dependent:
      'module DiagnosticAccuracy.Closed\nlet answer: int = DiagnosticAccuracy.Entry.value\n',
    changedApi: 'module DiagnosticAccuracy.Entry\nlet value = "changed API"\n',
    brokenEntry: 'module DiagnosticAccuracy.Entry\nlet value: int = "broken entry"\n',
    code: 'FS0001',
    sourceTag: 'sharplsp-fsharp',
    hover: new vscode.Position(1, 5),
  },
  {
    language: 'C#',
    project: 'AccuracyCs.csproj',
    entry: 'Entry.cs',
    closed: 'Closed.cs',
    source:
      'namespace DiagnosticAccuracy;\npublic static class Entry {\n    public static int Value => 42;\n}\n',
    broken:
      'namespace DiagnosticAccuracy;\npublic static class Closed { public static int Value => "not an int"; }\n',
    clean:
      'namespace DiagnosticAccuracy;\npublic static class Closed { public static int Value => 42; }\n',
    dependent:
      'namespace DiagnosticAccuracy;\npublic static class Closed { public static int Value => Entry.Value; }\n',
    changedApi:
      'namespace DiagnosticAccuracy;\npublic static class Entry {\n    public static string Value => "changed API";\n}\n',
    brokenEntry:
      'namespace DiagnosticAccuracy;\npublic static class Entry {\n    public static int Value => "broken entry";\n}\n',
    code: 'CS0029',
    sourceTag: 'sharplsp-csharp',
    hover: new vscode.Position(2, 24),
  },
] as const;

export interface AccuracyCase {
  readonly language: 'F#' | 'C#';
  readonly project: string;
  readonly entry: string;
  readonly closed: string;
  readonly source: string;
  readonly broken: string;
  readonly clean: string;
  readonly dependent: string;
  readonly changedApi: string;
  readonly brokenEntry: string;
  readonly code: string;
  readonly sourceTag: string;
  readonly hover: vscode.Position;
}
export interface AccuracyFixture {
  readonly api: SharpLspExtensionApi;
  readonly root: string;
  readonly solution: string;
  readonly entryUri: vscode.Uri;
  readonly closedUri: vscode.Uri;
  readonly scenario: AccuracyCase;
}

/** Every first successful pull carries a complete report and a nonempty opaque identity. */
export function assertFullDiagnosticReport(
  report: DocumentDiagnosticReport,
): asserts report is Extract<DocumentDiagnosticReport, { kind: 'full' }> & { resultId: string } {
  assert.equal(report.kind, 'full');
  if (report.kind !== 'full') assert.fail('a fresh pull must contain the complete report');
  assert.equal(typeof report.resultId, 'string');
  assert.ok(report.resultId);
}

/** Every document's diagnostics by code, severity and line, so a count mismatch names them. */
export function describeWorkspaceReport(report: WorkspaceDiagnosticReport): string {
  return report.items
    .map((item) => {
      const found =
        item.kind === 'full'
          ? item.items.map(
              (diagnostic) =>
                `${String(diagnostic.code)}/${String(diagnostic.severity)}@${String(diagnostic.range.start.line)}`,
            )
          : ['unchanged'];
      return `${item.uri}: ${found.join(', ')}`;
    })
    .join('; ');
}

/** Read the first successful closed-file report without changing its assertions or retry policy. */
export async function readClosedDiagnosticReport(
  fixture: AccuracyFixture,
): Promise<Extract<DocumentDiagnosticReport, { kind: 'full' }> & { resultId: string }> {
  const client = fixture.api.getLspClient();
  assert.ok(client);
  const method = 'textDocument/diagnostic';
  const params = { textDocument: { uri: fixture.closedUri.toString() } };
  const report = await firstDiagnosticReport<DocumentDiagnosticReport>(client, method, params);
  assertFullDiagnosticReport(report);
  return report;
}

/** Every successful first pull must carry the independently SDK-proven error. */
export function assertCompilerReport(
  fixture: AccuracyFixture,
  report: DocumentDiagnosticReport,
): void {
  assertFullDiagnosticReport(report);
  const errors = report.items.filter((item) => item.code === fixture.scenario.code);
  assert.equal(errors.length, 1, 'the real build failure is present exactly once');
  assert.equal(errors[0]?.severity, 1);
  assert.equal(errors[0]?.source, fixture.scenario.sourceTag);
  assert.equal(errors[0]?.range.start.line, 1);
  assert.ok(errors[0]?.message);
  assert.ok(report.resultId);
}

/** The project XML: both files compiled for F#, SDK globbing for C#. */
export function accuracyProjectXml(scenario: AccuracyCase, options: ProjectOptions): string {
  return buildProjectXml({
    ...options,
    compileIncludes: scenario.language === 'F#' ? [scenario.entry, scenario.closed] : [],
  });
}

/**
 * Write the two-file project with its `.editorconfig`, break the closed file on
 * disk, and hand back where both files landed.
 */
async function writeBrokenProject(
  root: string,
  scenario: AccuracyCase,
  options: ProjectOptions,
  editorConfig?: string,
): Promise<{ project: string; closedUri: vscode.Uri }> {
  isolateFromRepoMsbuild(root);
  if (editorConfig !== undefined) fs.writeFileSync(joinPath(root, '.editorconfig'), editorConfig);
  const project = writeProject(
    joinPath(root, 'Project'),
    scenario.project,
    accuracyProjectXml(scenario, options),
    scenario.entry,
    scenario.source,
  );
  const closedUri = vscode.Uri.file(joinPath(project, scenario.closed));
  fs.writeFileSync(closedUri.fsPath, scenario.broken);
  return { project, closedUri };
}

/** Restore a real two-file project and prove its closed-file error with the real compiler. */
export async function writeAccuracyFixture(
  api: SharpLspExtensionApi,
  root: string,
  scenario: AccuracyCase,
  options: ProjectOptions = {},
  editorConfig?: string,
): Promise<AccuracyFixture> {
  const { project, closedUri } = await writeBrokenProject(root, scenario, options, editorConfig);
  const solution = await createSolution(root, 'Accuracy', [project]);
  await dotnet(['restore', solution, '--nologo'], root);
  await assert.rejects(
    dotnet(['build', solution, '--no-restore', '--nologo'], root),
    new RegExp(scenario.code),
    'the exact closed-file diagnostic is a real build error',
  );
  return {
    api,
    root,
    solution,
    entryUri: vscode.Uri.file(joinPath(project, scenario.entry)),
    closedUri,
    scenario,
  };
}

/**
 * Activate the extension over a fresh scratch root, write `scenario` into it as
 * a real project, and load the solution in the SERVER and then the TREE — the
 * same order as a user picking the solution. Suites still open the file they
 * exercise and gate on a semantic hover before asserting.
 */
export async function activateAccuracyFixture(
  prefix: string,
  scenario: AccuracyCase,
  options: ProjectOptions = {},
  editorConfig?: string,
): Promise<AccuracyFixture> {
  const { api, root } = await activateWithScratch(prefix);
  const fixture = await writeAccuracyFixture(api, root, scenario, options, editorConfig);
  await loadAccuracyFixture(fixture);
  return fixture;
}

/** Select the same real solution in the language server and reactive project tree. */
export async function loadAccuracyFixture(fixture: AccuracyFixture): Promise<void> {
  await loadSolutionInServer(fixture.solution);
  await fixture.api.explorerProvider.loadSolution(fixture.solution);
}

/** Put the default fixture solution back FIRST, then clear the tree and delete the scratch. */
export async function teardownAccuracyFixture(fixture: AccuracyFixture): Promise<void> {
  await closeAllEditors();
  await loadSolutionInServer(fixtureSolutionPath());
  await teardownFixtureSolution(fixture.api, fixture.root, removeDirRecursive);
}

/** Register restoration before the scratch suite removes its root. */
export function useAccuracyTeardown(fixture: () => AccuracyFixture | undefined): void {
  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const current = fixture();
    if (current) await teardownAccuracyFixture(current);
  });
}

/** Compiler-owned diagnostics must appear once, at their actual source and severity. */
export async function assertClosedProblem(fixture: AccuracyFixture, count: number): Promise<void> {
  await assertCompilerProblem(fixture, fixture.closedUri, count, 1);
}

/** Poll Problems until the scenario's code holds exactly `count` entries. */
function pollCompilerDiagnostics(
  fixture: AccuracyFixture,
  uri: vscode.Uri,
  count: number,
): Promise<vscode.Diagnostic[]> {
  return pollUntilResult(
    async () =>
      vscode.languages
        .getDiagnostics(uri)
        .filter((diagnostic) => diagnosticCode(diagnostic) === fixture.scenario.code),
    (found) => found.length === count,
    LSP_RESPONSE_MS,
  );
}

/** Check actual Problems entries, including their identity, origin, location and message. */
export async function assertCompilerProblem(
  fixture: AccuracyFixture,
  uri: vscode.Uri,
  count: number,
  line: number,
): Promise<void> {
  const diagnostics = await pollCompilerDiagnostics(fixture, uri, count);
  assert.equal(
    diagnostics.length,
    count,
    `${fixture.scenario.code}: Problems must reflect the current closed file`,
  );
  for (const diagnostic of diagnostics) {
    assertCompilerDiagnostic(fixture, diagnostic, line);
  }
}

/** One Problems entry: real Error severity, our source tag, the actual line, a real message. */
function assertCompilerDiagnostic(
  fixture: AccuracyFixture,
  diagnostic: vscode.Diagnostic,
  line: number,
): void {
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(diagnostic.source, fixture.scenario.sourceTag);
  assert.equal(diagnostic.range.start.line, line);
  assert.ok(diagnostic.message.length > 0);
}

/** Neither protocol pulls nor the Problems view may require opening the erroneous file. */
export function assertFileStillClosed(fixture: AccuracyFixture): void {
  assert.equal(
    vscode.workspace.textDocuments.some((document) =>
      samePath(document.uri.fsPath, fixture.closedUri.fsPath),
    ),
    false,
    'the erroneous file was never opened',
  );
}

/** Assert clean compiler truth immediately after the caller's positive readiness barrier. */
export function assertNoCompilerErrors(uri: vscode.Uri): void {
  assert.deepEqual(
    vscode.languages
      .getDiagnostics(uri)
      .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error),
    [],
  );
}

/** Independently verify project validity with the SDK compiler. */
export async function assertProjectBuild(
  fixture: AccuracyFixture,
  scenario: { readonly buildCode: string },
  broken: boolean,
): Promise<void> {
  const build = dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root);
  if (broken)
    await assert.rejects(
      build,
      new RegExp(scenario.buildCode),
      'the real compiler rejects this project',
    );
  else await build;
}
