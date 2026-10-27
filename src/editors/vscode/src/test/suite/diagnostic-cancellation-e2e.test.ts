// Implements [DIAG-ANALYSIS-CANCELLATION], [DIAG-TRUTH-GUARANTEES], [DIAG-LSP-REFRESH].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  CLEAN_CANCELLATION_SOURCE,
  SAVED_CANCELLATION_SOURCE,
  analyzerPid,
  assertEditorRepaired,
  cancellationFixture,
  compilerReport,
  disposeCancellationFixture,
  holdEditorAnalysis,
  releaseAnalyzer,
  waitAnalyzerSignal,
  type CancellationFixture,
} from './diagnostic-cancellation-kit';
import { assertCompilerProblem } from './diagnostic-accuracy-fixtures';
import { replaceDocumentContent } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

/** A second actual editor edit cancels old work and clears both possible compiler errors. */
async function assertCancellationAndRepair(
  fixture: CancellationFixture,
  document: vscode.TextDocument,
  original: string,
): Promise<{ pid: number; clean: string }> {
  const pid = await holdEditorAnalysis(fixture, document);
  assert.equal(await replaceDocumentContent(document, CLEAN_CANCELLATION_SOURCE), true);
  assert.equal(document.isDirty, true);
  assert.equal(await waitAnalyzerSignal(fixture, 'cancelled'), pid);
  await assertEditorRepaired(fixture);
  const clean = await compilerReport(fixture);
  assert.notEqual(clean, original);
  assert.equal(analyzerPid(fixture, 'observed'), pid, 'a compiler restart cannot rescue clearing');
  return { pid, clean };
}

/** Discarding the unsaved repair restores the real saved-file error in the same compiler. */
async function assertSavedRestored(
  fixture: CancellationFixture,
  clean: string,
  pid: number,
): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await assertCompilerProblem(fixture.accuracy, fixture.accuracy.closedUri, 1, 1);
  assert.notEqual(await compilerReport(fixture, 'CS0103'), clean);
  assert.equal(
    fs.readFileSync(fixture.accuracy.closedUri.fsPath, 'utf8'),
    SAVED_CANCELLATION_SOURCE,
  );
  assert.equal(analyzerPid(fixture, 'observed'), pid);
}

/** Keep test registration distinct from the three actual editor interactions. */
function registerEditorCase(current: () => CancellationFixture): void {
  test('editing during real analyzer work cancels it, clears Problems and restores saved truth on close', async function () {
    this.timeout(6 * LSP_RESPONSE_MS);
    await assertEditorRoundTrip(current());
  });
}

/** Saved error, live cancellation/repair, and discarded-edit recovery are one causal session. */
async function assertEditorRoundTrip(fixture: CancellationFixture): Promise<void> {
  const document = await vscode.workspace.openTextDocument(fixture.accuracy.closedUri);
  await vscode.window.showTextDocument(document);
  await assertCompilerProblem(fixture.accuracy, document.uri, 1, 1);
  const original = await compilerReport(fixture, 'CS0103');
  try {
    const { pid, clean } = await assertCancellationAndRepair(fixture, document, original);
    await assertSavedRestored(fixture, clean, pid);
  } finally {
    releaseAnalyzer(fixture);
  }
}

suite('Diagnostic cancellation through actual editor changes', () => {
  let fixture: CancellationFixture;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    fixture = await cancellationFixture();
  });
  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await disposeCancellationFixture(fixture);
  });
  registerEditorCase(() => fixture);
});
