// Timestamp-preserving project edits cannot hide changed restore inputs. [DIAG-RESTORE]
import * as assert from 'node:assert/strict';
import { readClosedDiagnosticReport, useAccuracyTeardown } from './diagnostic-accuracy-fixtures';
import { assertPackageProblems } from './diagnostic-package-kit';
import {
  SNAPSHOT_CASES,
  assertSnapshotAssets,
  preparePackageSnapshot,
  stagePackageSnapshot,
  type PackageSnapshotFixture,
} from './diagnostic-package-snapshot-kit';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import { useScratchSuite } from './test-explorer-harness';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

async function assertSnapshotReport(
  fixture: PackageSnapshotFixture,
  changed: boolean,
): Promise<void> {
  await assertPackageProblems(fixture, changed);
  const report = await readClosedDiagnosticReport(fixture.subject);
  assert.equal(report.items.filter((item) => item.severity === 1).length, changed ? 2 : 1);
  assertSnapshotAssets(fixture, changed);
}

for (const scenario of SNAPSHOT_CASES) {
  suite(`Diagnostic restore snapshots — ${scenario.base.language} ${scenario.kind}`, () => {
    let fixture: PackageSnapshotFixture;
    useAccuracyTeardown(() => fixture?.subject);
    useScratchSuite('slsp-package-snapshot-', async ({ api, root }) => {
      fixture = await preparePackageSnapshot(api, root, scenario);
    });
    suiteSetup(async function () {
      this.timeout(3 * FIXTURE_BUILD_MS);
      assertSnapshotAssets(fixture, false);
      await loadSolutionInServer(fixture.subject.solution);
      await assertPackageProblems(fixture, false);
    });
    test('preserved timestamps cannot hide changed restore inputs or their live repair', async function () {
      this.timeout(10 * LSP_RESPONSE_MS);
      await loadSolutionInServer(fixtureSolutionPath());
      stagePackageSnapshot(fixture, true);
      assertSnapshotAssets(fixture, false);
      await loadSolutionInServer(fixture.subject.solution);
      await assertSnapshotReport(fixture, true);
      stagePackageSnapshot(fixture, false);
      await assertSnapshotReport(fixture, false);
    });
  });
}
