// Genuine upstream lint oracle and real compiler/editor state. [DIAG-CATEGORIES-ANALYZER]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type {
  Diagnostic,
  DocumentDiagnosticReport,
  LanguageClient,
  WorkspaceDiagnosticReport,
} from 'vscode-languageclient/node';
import { directoryOf, joinPath, samePath } from '../../paths';
import {
  ACCURACY_CASES,
  activateAccuracyFixture,
  assertCompilerProblem,
  assertFileStillClosed,
  assertFullDiagnosticReport,
  assertNoCompilerErrors,
  firstDiagnosticReport,
  teardownAccuracyFixture,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { diagnosticCode } from './document-anchors';
import { dotnet } from './dotnet-project-kit';
import { fixtureSolutionPath } from './real-repo-helpers';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';
import { pollUntilResult, removeDirRecursive, replaceDocumentContent } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

export const LINT_SOURCE =
  'module DiagnosticAccuracy.Closed\n\nlet isDifferent value = not (value = 1)\n';
export const CLEAN_LINT_SOURCE =
  'module DiagnosticAccuracy.Closed\n\nlet isDifferent value = value <> 1\n';
export const SUPPRESSED_LINT_SOURCE =
  'module DiagnosticAccuracy.Closed\n\n// fsharplint:disable-next-line Hints\nlet isDifferent value = not (value = 1)\n';
export const LINT_RANGE = { start: { line: 2, character: 24 }, end: { line: 2, character: 39 } };
const ORACLE_FINDING = {
  Code: 'FL0065',
  StartLine: 2,
  StartCharacter: 24,
  EndLine: 2,
  EndCharacter: 39,
};

interface OracleFinding {
  Code: string;
  StartLine: number;
  StartCharacter: number;
  EndLine: number;
  EndCharacter: number;
}
export interface OracleReply {
  Success: boolean;
  Failure: string;
  Findings: OracleFinding[];
}

/** Build the independent upstream implementation once, outside the server's compiler context. */
export async function buildLintOracle(): Promise<string> {
  const root = fs.mkdtempSync(joinPath(os.tmpdir(), 'slsp-lint-oracle-'));
  isolateFromRepoMsbuild(root);
  const source = joinPath(directoryOf(fixtureSolutionPath()), '..', 'diagnostic-lint');
  fs.cpSync(source, root, { recursive: true });
  await dotnet(['build', 'LintOracle.fsproj', '--nologo', '--disable-build-servers'], root);
  return root;
}

/** Both lint suites share one independently compiled oracle per suite. */
function lintOracleLifetime(): () => string {
  let oracle: string;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    oracle = await buildLintOracle();
  });
  suiteTeardown(() => removeDirRecursive(oracle));
  return () => oracle;
}

/** Keep setup/teardown identical for all real lint regression suites. */
export function useLintFixture(bind: (fixture: AccuracyFixture, oracle: string) => void): void {
  const oracle = lintOracleLifetime();
  let fixture: AccuracyFixture;
  setup(async function () {
    this.timeout(2 * FIXTURE_BUILD_MS);
    fixture = await lintFixture(oracle());
    bind(fixture, oracle());
  });
  teardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    if (fixture) await teardownAccuracyFixture(fixture);
  });
}

/** Real lint cannot report success if parsing, type checking or linter progress failed. */
export async function assertLintOracle(
  root: string,
  source: string,
  count: number,
  config?: string,
): Promise<void> {
  const report = await readLintOracle(root, source, config);
  const findings = report.Findings.filter((finding) => finding.Code === 'FL0065');
  assert.equal(findings.length, count, 'the independent real linter establishes exact truth');
  if (count === 1) assert.deepEqual(findings[0], ORACLE_FINDING);
}

/** Invoke the same independent compiler/linter for additional rule and failure assertions. */
export async function readLintOracle(
  root: string,
  source: string,
  config?: string,
): Promise<OracleReply> {
  const input = joinPath(root, 'Input.fs');
  fs.writeFileSync(input, source);
  const binary = joinPath(root, 'bin', 'Debug', 'net10.0', 'LintOracle.dll');
  const args = config === undefined ? [binary, input] : [binary, input, config];
  const report = JSON.parse(await dotnet(args, root)) as OracleReply;
  assert.equal(report.Success, true);
  assert.equal(report.Failure, '');
  return report;
}

/** Establish the actual compiler and its refresh first, then replace the closed compiler error by lint-only code. */
export async function lintFixture(oracle: string): Promise<AccuracyFixture> {
  const fixture = await activateAccuracyFixture('slsp-lint-accuracy-', ACCURACY_CASES[0]);
  await assertCompilerProblem(fixture, fixture.closedUri, 1, 1);
  await writeLintSource(fixture, oracle, LINT_SOURCE, 1);
  await assertCompilerProblem(fixture, fixture.closedUri, 0, 1);
  assertFileStillClosed(fixture);
  return fixture;
}

/** Every saved transition is independently compiler-clean and has actual upstream lint truth. */
export async function writeLintSource(
  fixture: AccuracyFixture,
  oracle: string,
  source: string,
  count: number,
): Promise<void> {
  await assertLintOracle(oracle, source, count);
  fs.writeFileSync(fixture.closedUri.fsPath, source);
  await dotnet(
    ['build', fixture.solution, '--no-restore', '--nologo', '--disable-build-servers'],
    fixture.root,
  );
  assertFileStillClosed(fixture);
}

/** Problems must converge without any manual pull, hover, build command, or file notification. */
export async function assertLintProblems(
  fixture: AccuracyFixture,
  count: number,
  code = 'FL0065',
  range = LINT_RANGE,
): Promise<void> {
  const found = await pollUntilResult(
    async () =>
      vscode.languages
        .getDiagnostics(fixture.closedUri)
        .filter((item) => diagnosticCode(item) === code),
    (items) => items.length === count,
    LSP_RESPONSE_MS,
  );
  assert.equal(found.length, count);
  for (const item of found) assertLintEditorItem(item, range);
  assertNoCompilerErrors(fixture.closedUri);
}

/** The actual editor preserves the same warning source, severity, range and message. */
function assertLintEditorItem(item: vscode.Diagnostic, range: typeof LINT_RANGE): void {
  assert.equal(item.source, 'sharplsp-fsharp');
  assert.equal(item.severity, vscode.DiagnosticSeverity.Warning);
  assert.ok(
    item.range.isEqual(
      new vscode.Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character,
      ),
    ),
  );
  assert.ok(item.message.length > 0);
}

/** Raw pull payloads agree with the independently checked rule and exact range. */
export function assertLintItems(
  items: readonly Diagnostic[],
  count: number,
  code = 'FL0065',
  range = LINT_RANGE,
): void {
  const lint = items.filter((item) => item.code === code);
  assert.equal(lint.length, count);
  for (const item of lint) {
    assert.equal(item.source, 'sharplsp-fsharp');
    assert.equal(item.severity, 2);
    assert.deepEqual(item.range, range);
    assert.ok(
      typeof item.message === 'string' ? item.message.length > 0 : item.message.value.length > 0,
    );
  }
  assert.deepEqual(
    items.filter((item) => item.severity === 1),
    [],
  );
}

/** A successful report is checked once; only explicit supersession may retry. */
export async function assertLintDocument(
  fixture: AccuracyFixture,
  count: number,
  code = 'FL0065',
  range = LINT_RANGE,
): Promise<string> {
  const client = fixture.api.getLspClient();
  assert.ok(client);
  const report = await firstDiagnosticReport<DocumentDiagnosticReport>(
    client,
    'textDocument/diagnostic',
    { textDocument: { uri: fixture.closedUri.toString() } },
  );
  assertFullDiagnosticReport(report);
  assertLintItems(report.items, count, code, range);
  return report.resultId;
}

/** Workspace scope must discover the same unopened lint finding as document pulls. */
export async function assertLintWorkspace(fixture: AccuracyFixture, count: number): Promise<void> {
  const client = fixture.api.getLspClient();
  assert.ok(client);
  const report = await firstDiagnosticReport<WorkspaceDiagnosticReport>(
    client,
    'workspace/diagnostic',
    { previousResultIds: [] },
  );
  assertLintWorkspaceReport(fixture, report, count);
}

/** A successful workspace response cannot omit the selected source or its exact rule. */
function assertLintWorkspaceReport(
  fixture: AccuracyFixture,
  report: WorkspaceDiagnosticReport,
  count: number,
): void {
  const selected = fixture.closedUri.fsPath;
  const source = report.items.find((item) => samePath(vscode.Uri.parse(item.uri).fsPath, selected));
  assert.ok(source);
  assert.equal(source.kind, 'full');
  if (source.kind !== 'full') assert.fail('the first selected lint report must be full');
  assert.ok(source.resultId);
  assertLintItems(source.items, count);
  assertFileStillClosed(fixture);
}

/** Each unsaved edit has independent lint truth before Problems is checked. */
export async function assertUnsavedLintStep(
  fixture: AccuracyFixture,
  oracle: string,
  document: vscode.TextDocument,
  source: string,
  count: number,
): Promise<void> {
  await assertLintOracle(oracle, source, count);
  assert.equal(await replaceDocumentContent(document, source), true);
  assert.equal(document.isDirty, true);
  await assertLintProblems(fixture, count);
}

/** A live policy change affects lint while preserving the independently proven compiler error. */
export async function assertLintToggleStep(
  fixture: AccuracyFixture,
  client: LanguageClient,
  enabled: boolean,
  count: number,
): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', {
    settings: { sharplsp: { diagnostics: { analyzers_enabled: enabled } } },
  });
  await assertLintProblems(fixture, count);
  await assertCompilerProblem(fixture, fixture.entryUri, 1, 1);
}

/** Revert policy and the unsaved entry only after every compiler-preservation assertion. */
export async function restoreLintSettings(
  client: LanguageClient,
  document: vscode.TextDocument,
): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', { settings: { sharplsp: {} } });
  assert.equal(await replaceDocumentContent(document, ACCURACY_CASES[0].source), true);
  await document.save();
}
