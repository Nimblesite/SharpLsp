// Real project analyzer and editor interactions. [DIAG-ANALYSIS-CANCELLATION]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { DocumentDiagnosticReport } from 'vscode-languageclient/node';
import { directoryOf, joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  assertCompilerProblem,
  firstDiagnosticReport,
  loadAccuracyFixture,
  teardownAccuracyFixture,
  writeAccuracyFixture,
  type AccuracyCase,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { copyPinnedFixture, dotnet } from './dotnet-project-kit';
import { fixtureSolutionPath } from './real-repo-helpers';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';
import { activateWithScratch } from './test-explorer-kit';
import { pollUntilResult, removeDirRecursive, replaceDocumentContent } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

export const SAVED_CANCELLATION_SOURCE =
  'namespace DiagnosticAccuracy;\npublic static class Closed { public static int Answer => missing; }\n';
export const HELD_CANCELLATION_SOURCE =
  'namespace DiagnosticAccuracy;\npublic static class Closed { public static string Answer => 42; }\n';
export const CLEAN_CANCELLATION_SOURCE =
  'namespace DiagnosticAccuracy;\npublic static class Closed { public static int Answer => 42; }\n';
const SCENARIO: AccuracyCase = {
  ...ACCURACY_CASES[1],
  project: 'CancellationAccuracy.csproj',
  code: 'CS0103',
  broken: SAVED_CANCELLATION_SOURCE,
  clean: CLEAN_CANCELLATION_SOURCE,
};
const ANALYZER_BUILD = [
  'build',
  'CooperativeAnalyzer.csproj',
  '-c',
  'Release',
  '--nologo',
  '--disable-build-servers',
];

export interface CancellationFixture {
  readonly accuracy: AccuracyFixture;
  readonly marker: string;
  readonly analyzerRoot: string;
}

/** The native suite and extension-host suite compile the exact same analyzer source. */
async function buildAnalyzer(): Promise<string> {
  const root = fs.mkdtempSync(joinPath(os.tmpdir(), 'slsp-cooperative-analyzer-'));
  isolateFromRepoMsbuild(root);
  const source = joinPath(directoryOf(fixtureSolutionPath()), '..', 'diagnostic-cancellation');
  copyPinnedFixture(source, root);
  await dotnet(ANALYZER_BUILD, root);
  return root;
}

/** Analyzer configuration is normal .editorconfig input, with no production test hook. */
export async function cancellationFixture(): Promise<CancellationFixture> {
  const analyzerRoot = await buildAnalyzer();
  const { api, root } = await activateWithScratch('slsp-cancellation-');
  const marker = joinPath(root, 'analyzer-cancel');
  const analyzer = joinPath(analyzerRoot, 'bin', 'Release', 'net10.0', 'CooperativeAnalyzer.dll');
  const config = `root = true\n[*.cs]\nsharplsp_cancellation_marker = ${marker}\n`;
  const accuracy = await writeAccuracyFixture(
    api,
    root,
    SCENARIO,
    {
      analyzerIncludes: [analyzer],
      properties: { EnableNETAnalyzers: 'false' },
    },
    config,
  );
  await loadAccuracyFixture(accuracy);
  return { accuracy, marker, analyzerRoot };
}

/** Only fixture-owned files and the fixture solution are restored. */
export async function disposeCancellationFixture(fixture: CancellationFixture): Promise<void> {
  releaseAnalyzer(fixture);
  await teardownAccuracyFixture(fixture.accuracy);
  removeDirRecursive(fixture.analyzerRoot);
}

/** Release on failure so teardown never needs to terminate any editor process. */
export function releaseAnalyzer(fixture: CancellationFixture): void {
  fs.writeFileSync(`${fixture.marker}.release`, 'release');
}

/** Exact PID data is written atomically by a real Roslyn semantic-model callback. */
export function analyzerPid(fixture: CancellationFixture, suffix: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(`${fixture.marker}.${suffix}`, 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Wait on actual analyzer progress, never assume a sleep means the compiler started. */
export async function waitAnalyzerSignal(
  fixture: CancellationFixture,
  suffix: string,
): Promise<number> {
  const pid = await pollUntilResult(
    async () => analyzerPid(fixture, suffix),
    (value) => value !== undefined,
    LSP_RESPONSE_MS,
  );
  assert.ok(pid !== undefined, `the actual analyzer must signal ${suffix}`);
  return pid;
}

/** A raw successful report and the real Problems collection must agree on compiler truth. */
export async function compilerReport(fixture: CancellationFixture, code?: string): Promise<string> {
  const { api, closedUri } = fixture.accuracy;
  const client = api.getLspClient();
  assert.ok(client);
  const report = await firstDiagnosticReport<DocumentDiagnosticReport>(
    client,
    'textDocument/diagnostic',
    { textDocument: { uri: closedUri.toString() } },
  );
  return assertCurrentReport(report, code);
}

/** A successful response cannot hide an error or reuse the wrong document identity. */
function assertCurrentReport(report: DocumentDiagnosticReport, code?: string): string {
  assert.equal(report.kind, 'full');
  if (report.kind !== 'full') assert.fail('a first successful report carries current truth');
  const errors = report.items.filter((item) => item.severity === 1);
  assert.equal(errors.length, code === undefined ? 0 : 1);
  if (code !== undefined) assert.equal(errors[0]?.code, code);
  assert.ok(report.resultId);
  return report.resultId;
}

/** User editing starts genuinely held compiler work; a subsequent edit must cancel it. */
export async function holdEditorAnalysis(
  fixture: CancellationFixture,
  document: vscode.TextDocument,
): Promise<number> {
  fs.writeFileSync(`${fixture.marker}.arm`, 'armed');
  assert.equal(await replaceDocumentContent(document, HELD_CANCELLATION_SOURCE), true);
  assert.equal(document.isDirty, true);
  return waitAnalyzerSignal(fixture, 'entered');
}

/** Both possible compiler failures disappear from Problems after the unsaved repair. */
export async function assertEditorRepaired(fixture: CancellationFixture): Promise<void> {
  await assertCompilerProblem(fixture.accuracy, fixture.accuracy.closedUri, 0, 1);
  const changed = {
    ...fixture.accuracy,
    scenario: { ...SCENARIO, code: 'CS0029' },
  };
  await assertCompilerProblem(changed, changed.closedUri, 0, 1);
  assert.equal(
    vscode.languages
      .getDiagnostics(changed.closedUri)
      .filter(
        (item) =>
          item.source?.startsWith('sharplsp') && item.severity === vscode.DiagnosticSeverity.Error,
      ).length,
    0,
  );
}
