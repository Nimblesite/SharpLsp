// Missing package references cannot hide SDK-proven errors. [PKG-ASSETS-FS] [DIAG-TRUTH-GUARANTEES]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  assertClosedProblem,
  assertCompilerReport,
  assertFileStillClosed,
  assertNoCompilerErrors,
  assertProjectBuild,
  readClosedDiagnosticReport,
  useAccuracyTeardown,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import {
  assertFallbackAssets,
  prepareFallbackFixture,
  type FallbackFixture,
} from './diagnostic-fallback-kit';
import { useScratchSuite } from './test-explorer-harness';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

/** Problems and direct reports preserve the exact SDK-proven error, without cascades. */
async function assertFallbackTruth(fixture: AccuracyFixture, count: number): Promise<void> {
  await assertClosedProblem(fixture, count);
  const errors = vscode.languages
    .getDiagnostics(fixture.closedUri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error);
  assert.equal(errors.length, count, 'no phantom unresolved-package or startup errors');
  assertFileStillClosed(fixture);
  const report = await readClosedDiagnosticReport(fixture);
  if (count) assertCompilerReport(fixture, report);
  else assert.equal(report.items.filter((item) => item.severity === 1).length, 0);
}

/** Real SDK builds independently validate both on-disk transitions without restoring. */
async function assertFallbackEdit(fixture: FallbackFixture, broken: boolean): Promise<void> {
  const current = fixture.external;
  fs.writeFileSync(
    current.closedUri.fsPath,
    broken ? current.scenario.broken : current.scenario.clean,
  );
  await assertProjectBuild(current, { buildCode: current.scenario.code }, broken);
  assertFallbackAssets(fixture);
  await assertFallbackTruth(current, broken ? 1 : 0);
  await assertClosedProblem(fixture.primary, 1);
}

suite('F# diagnostics from an isolated NuGet fallback folder', () => {
  let fixture: FallbackFixture;
  useAccuracyTeardown(() => fixture?.primary);
  useScratchSuite('slsp-diagnostic-fallback-', async ({ api, root }) => {
    fixture = await prepareFallbackFixture(api, root);
  });

  test('a fallback-only assembly preserves closed compiler errors, repairs and regressions', async function () {
    this.timeout(FIXTURE_BUILD_MS + 6 * LSP_RESPONSE_MS);
    assertFallbackAssets(fixture);
    await assertClosedProblem(fixture.primary, 1);
    await assertNoCompilerErrors(fixture.external.closedUri);
    await vscode.commands.executeCommand('vscode.open', fixture.external.entryUri);
    await assertFallbackTruth(fixture.external, 1);
    await assertFallbackEdit(fixture, false);
    await assertFallbackEdit(fixture, true);
  });
});
