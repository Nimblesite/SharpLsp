// Imported SDK inputs must not leave an old, falsely clean assembly snapshot. [DIAG-RESTORE]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  loadAccuracyFixture,
  readClosedDiagnosticReport,
  useAccuracyTeardown,
} from './diagnostic-accuracy-fixtures';
import {
  IMPORT_CASES,
  assertImportedAssets,
  prepareImportedRestore,
  stageImportedVersion,
  type ImportedRestoreFixture,
} from './diagnostic-imported-restore-kit';
import { assertPackageProblems } from './diagnostic-package-kit';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import { useScratchSuite } from './test-explorer-harness';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

/** The first successful protocol report must agree with automatically refreshed Problems. */
async function assertImportReport(
  fixture: ImportedRestoreFixture,
  updated: boolean,
): Promise<void> {
  await assertPackageProblems(fixture, updated);
  const report = await readClosedDiagnosticReport(fixture.subject);
  assert.equal(report.items.filter((item) => item.severity === 1).length, updated ? 2 : 1);
  assertImportedAssets(fixture, updated ? '2.0.0' : '1.0.0');
  assert.ok(
    fs.existsSync(fixture.marker),
    'the real Restore target ran for the imported input change',
  );
}

for (const scenario of IMPORT_CASES) {
  suite(`Diagnostic restore of imported package inputs — ${scenario.base.language}`, () => {
    let fixture: ImportedRestoreFixture;
    useAccuracyTeardown(() => fixture?.subject);
    useScratchSuite('slsp-imported-restore-', async ({ api, root }) => {
      fixture = await prepareImportedRestore(api, root, scenario);
    });
    suiteSetup(async function () {
      this.timeout(3 * FIXTURE_BUILD_MS);
      assertImportedAssets(fixture, '1.0.0');
      await loadAccuracyFixture(fixture.subject);
      await assertPackageProblems(fixture, false);
    });
    test('an imported version change restores before diagnostics, then a live repair retires only its error', async function () {
      this.timeout(10 * LSP_RESPONSE_MS);
      await loadSolutionInServer(fixtureSolutionPath());
      stageImportedVersion(fixture, '2.0.0');
      assertImportedAssets(fixture, '1.0.0');
      await loadAccuracyFixture(fixture.subject);
      await assertImportReport(fixture, true);
      stageImportedVersion(fixture, '1.0.0');
      await assertImportReport(fixture, false);
    });
  });
}
