// Implements [DIAG-LSP-CAPABILITIES], [DIAG-ARCHITECTURE-SCOPE], [DIAG-TRUTH-GUARANTEES].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type {
  DocumentDiagnosticReport,
  LanguageClient,
  PreviousResultId,
  WorkspaceDiagnosticReport,
} from 'vscode-languageclient/node';
import { samePath } from '../../paths';
import {
  ACCURACY_CASES,
  activateAccuracyFixture,
  assertClosedProblem,
  assertCompilerProblem,
  assertCompilerReport,
  assertFileStillClosed,
  firstDiagnosticReport,
  teardownAccuracyFixture,
  workspaceReport,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { replaceDocumentContent, waitForHoverResult } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

const PROJECT_FILTER_STEPS = [
  [['NoSuchProject*'], 0],
  [['Accuracy*'], 1],
  [['**/Accuracy*.?sproj'], 1],
  [['Project/Accuracy*.?sproj'], 1],
] as const;

/** The workspace report must carry the closed file, with the error exactly once, from the real build. */
function assertWorkspaceReportsClosedError(
  fixture: AccuracyFixture,
  report: WorkspaceDiagnosticReport,
): void {
  const document = report.items.find((item) =>
    samePath(vscode.Uri.parse(item.uri).fsPath, fixture.closedUri.fsPath),
  );
  assert.ok(
    document,
    'workspace/diagnostic must report every loaded source, including closed files',
  );
  assertCompilerReport(fixture, document);
}

/** Every unsaved entry overlay must move the closed file's error with it, in both directions. */
async function assertOverlayRefreshesDependentErrors(
  fixture: AccuracyFixture,
  document: vscode.TextDocument,
): Promise<void> {
  const scenario = fixture.scenario;
  for (const [source, count] of [
    [scenario.changedApi, 1],
    [scenario.source, 0],
    [scenario.changedApi, 1],
  ] as const) {
    assert.equal(await replaceDocumentContent(document, source), true);
    assert.equal(document.isDirty, true, 'dependent diagnostics must follow the unsaved overlay');
    await assertClosedProblem(fixture, count);
    assertFileStillClosed(fixture);
  }
}

/** End the overlay round trip back at the saved entry and the broken closed file on disk. */
async function restoreEntryAndClosedFiles(
  fixture: AccuracyFixture,
  document: vscode.TextDocument,
): Promise<void> {
  assert.equal(await replaceDocumentContent(document, fixture.scenario.source), true);
  await document.save();
  fs.writeFileSync(fixture.closedUri.fsPath, fixture.scenario.broken);
}

/** Break the entry in the unsaved buffer: its compiler error and the closed error both show. */
async function assertBrokenEntryShowsBothErrors(
  fixture: AccuracyFixture,
  document: vscode.TextDocument,
  line: number,
): Promise<void> {
  assert.equal(await replaceDocumentContent(document, fixture.scenario.brokenEntry), true);
  await assertCompilerProblem(fixture, fixture.entryUri, 1, line);
  await assertClosedProblem(fixture, 1);
}

/** Flip solution-wide analysis; the closed error must follow it while the open entry error stays. */
async function assertSolutionAnalysisStep(
  fixture: AccuracyFixture,
  client: LanguageClient,
  enabled: boolean,
  count: number,
  line: number,
): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', {
    settings: { sharplsp: { diagnostics: { solution_wide_analysis: enabled } } },
  });
  await assertClosedProblem(fixture, count);
  await assertCompilerProblem(fixture, fixture.entryUri, 1, line);
  assertFileStillClosed(fixture);
}

/** Fix the entry back to source: its error clears while the closed file's regression stays. */
async function assertFixedEntryKeepsClosedRegression(
  fixture: AccuracyFixture,
  document: vscode.TextDocument,
  line: number,
): Promise<void> {
  assert.equal(await replaceDocumentContent(document, fixture.scenario.source), true);
  await assertCompilerProblem(fixture, fixture.entryUri, 0, line);
  await assertClosedProblem(fixture, 1);
}

/** Clear the pushed config and put the saved entry source back before the next test. */
async function restoreSolutionAnalysisState(
  fixture: AccuracyFixture,
  client: LanguageClient,
  document: vscode.TextDocument,
): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', { settings: {} });
  assert.equal(await replaceDocumentContent(document, fixture.scenario.source), true);
  await document.save();
}

/** Excluding the loaded project explicitly retires the previously reported closed error. */
function assertFilteredWorkspaceEmpty(
  fixture: AccuracyFixture,
  report: WorkspaceDiagnosticReport,
): void {
  assert.equal(report.items.length, 1, 'the prior closed report must be explicitly cleared');
  const [closed] = report.items;
  assert.ok(closed);
  assert.equal(closed.uri, fixture.closedUri.toString(), 'retirement echoes the prior report URI');
  assert.equal(closed.kind, 'full');
  if (closed.kind !== 'full') assert.fail('retirement must carry an explicit empty report');
  assert.ok(closed.resultId);
  assert.equal(closed.version, null);
  assert.deepStrictEqual(closed.items, []);
}

/** Workspace policy never hides the compiler error from an explicit document request. */
async function assertDirectPullUnfiltered(
  fixture: AccuracyFixture,
  client: LanguageClient,
): Promise<string> {
  const direct = await firstDiagnosticReport<DocumentDiagnosticReport>(
    client,
    'textDocument/diagnostic',
    {
      textDocument: { uri: fixture.closedUri.toString() },
      identifier: 'sharplsp',
    },
  );
  assert.ok(direct.resultId, 'the direct report has its own opaque identity');
  assertWorkspaceReportsClosedError(fixture, {
    items: [{ ...direct, uri: fixture.closedUri.toString(), version: null }],
  });
  assertFileStillClosed(fixture);
  return direct.resultId;
}

/** One live project scope change: wire reports, Problems, and direct compiler truth. */
async function assertProjectFilterStep(
  fixture: AccuracyFixture,
  client: LanguageClient,
  previous: PreviousResultId[],
  patterns: string[],
  count: number,
): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', {
    settings: { sharplsp: { diagnostics: { project_filter: patterns } } },
  });
  const report = await workspaceReport(client, previous);
  if (count === 0) assertFilteredWorkspaceEmpty(fixture, report);
  else assertWorkspaceReportsClosedError(fixture, report);
  await assertDirectPullUnfiltered(fixture, client);
  await assertClosedProblem(fixture, count);
}

for (const scenario of ACCURACY_CASES) {
  suite(`Diagnostic accuracy contract — ${scenario.language}`, () => {
    let fixture: AccuracyFixture;
    suiteSetup(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      fixture = await activateAccuracyFixture('slsp-diagnostic-accuracy-', scenario);
      const document = await vscode.workspace.openTextDocument(fixture.entryUri);
      await vscode.window.showTextDocument(document);
      assert.ok(
        (await waitForHoverResult(fixture.entryUri, scenario.hover, SIDECAR_COLD_MS)).length > 0,
        'the engine has loaded the real project before diagnostic assertions',
      );
    });
    suiteTeardown(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      await teardownAccuracyFixture(fixture);
    });

    test('modern VS Code negotiates document and solution pull diagnostics', function () {
      const capability =
        fixture.api.getLspClient()?.initializeResult?.capabilities.diagnosticProvider;
      assert.ok(capability, 'modern VS Code must be offered the promised pull diagnostics model');
      assert.equal(
        capability.workspaceDiagnostics,
        true,
        'solution-wide diagnostics are advertised',
      );
      assert.equal(
        capability.interFileDependencies,
        true,
        'dependency edits invalidate diagnostic truth',
      );
      assert.equal(
        capability.identifier,
        'sharplsp',
        'the client has one stable diagnostic identity',
      );
    });

    test('workspace pull includes the real compiler error in an unopened source file', async function () {
      this.timeout(LSP_RESPONSE_MS + 5_000);
      const client = fixture.api.getLspClient();
      assert.ok(client);
      const report = await workspaceReport(client);
      assertWorkspaceReportsClosedError(fixture, report);
      assertFileStillClosed(fixture);
    });

    test('Problems shows unopened errors by default without a manual pull or build', async function () {
      this.timeout(LSP_RESPONSE_MS + 5_000);
      await assertClosedProblem(fixture, 1);
      assertFileStillClosed(fixture);
    });

    test('closed-file disk fixes clear errors and later regressions reappear without a window restart', async function () {
      this.timeout(4 * LSP_RESPONSE_MS);
      for (const [source, count] of [
        [scenario.clean, 0],
        [scenario.broken, 1],
        [scenario.clean, 0],
      ] as const) {
        fs.writeFileSync(fixture.closedUri.fsPath, source);
        await assertClosedProblem(fixture, count);
        assertFileStillClosed(fixture);
        assert.equal(fs.readFileSync(fixture.closedUri.fsPath, 'utf8'), source);
      }
      fs.writeFileSync(fixture.closedUri.fsPath, scenario.broken);
    });

    test('unsaved API edits refresh dependent closed-file errors in both directions', async function () {
      this.timeout(5 * LSP_RESPONSE_MS);
      fs.writeFileSync(fixture.closedUri.fsPath, scenario.dependent);
      const document = await vscode.workspace.openTextDocument(fixture.entryUri);
      try {
        await assertOverlayRefreshesDependentErrors(fixture, document);
      } finally {
        await restoreEntryAndClosedFiles(fixture, document);
      }
    });

    test('solution analysis can be disabled and reenabled while open-file errors remain accurate', async function () {
      this.timeout(6 * LSP_RESPONSE_MS);
      const client = fixture.api.getLspClient();
      assert.ok(client);
      const document = await vscode.workspace.openTextDocument(fixture.entryUri);
      const line = scenario.language === 'F#' ? 1 : 2;
      try {
        await assertBrokenEntryShowsBothErrors(fixture, document, line);
        for (const [enabled, count] of [
          [false, 0],
          [true, 1],
        ] as const) {
          await assertSolutionAnalysisStep(fixture, client, enabled, count, line);
        }
        await assertFixedEntryKeepsClosedRegression(fixture, document, line);
      } finally {
        await restoreSolutionAnalysisState(fixture, client, document);
      }
    });

    // Implements [DIAG-CONFIG-PROJECT-FILTER]: names and relative/native paths, F# first.
    test('project filters retire workspace errors, match names and paths, and leave direct pulls intact', async function () {
      this.timeout(6 * LSP_RESPONSE_MS);
      const client = fixture.api.getLspClient();
      assert.ok(client);
      await assertClosedProblem(fixture, 1);
      const previous = [
        {
          uri: fixture.closedUri.toString(),
          value: await assertDirectPullUnfiltered(fixture, client),
        },
      ];
      try {
        for (const [patterns, count] of PROJECT_FILTER_STEPS) {
          await assertProjectFilterStep(fixture, client, previous, [...patterns], count);
        }
      } finally {
        await client.sendNotification('workspace/didChangeConfiguration', {
          settings: { sharplsp: { diagnostics: { project_filter: [] } } },
        });
      }
    });
  });
}
