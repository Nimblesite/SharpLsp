// Inherited config is a live compiler input outside the selected solution. [DIAG-LSP-REFRESH]
import * as fs from 'node:fs';
import { joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  assertCompilerProblem,
  assertFileStillClosed,
  loadAccuracyFixture,
  teardownAccuracyFixture,
  writeAccuracyFixture,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import {
  assertLintOracle,
  assertLintProblems,
  buildLintOracle,
  LINT_SOURCE,
  writeLintSource,
} from './diagnostic-lint-kit';
import { useScratchSuite } from './test-explorer-harness';
import { removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

suite('F# lint configuration above the selected solution', () => {
  let fixture: AccuracyFixture;
  let oracle: string;
  let config: string;

  // Restore the default compiler selection before the scratch lifetime removes its parent.
  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    if (fixture) await teardownAccuracyFixture(fixture);
    if (oracle) removeDirRecursive(oracle);
  });

  useScratchSuite('slsp-lint-ancestors-', async ({ api, root }) => {
    oracle = await buildLintOracle();
    config = joinPath(root, 'fsharplint.json');
    fixture = await writeAccuracyFixture(api, joinPath(root, 'solution'), ACCURACY_CASES[0]);
    await loadAccuracyFixture(fixture);
    await assertCompilerProblem(fixture, fixture.closedUri, 1, 1);
    await writeLintSource(fixture, oracle, LINT_SOURCE, 1);
    await assertCompilerProblem(fixture, fixture.closedUri, 0, 1);
  });

  test('creating, changing and deleting inherited config refreshes closed findings without rescue', async function () {
    this.timeout(6 * LSP_RESPONSE_MS);
    await assertLintProblems(fixture, 1);
    for (const count of [0, 1, 0] as const) {
      fs.writeFileSync(
        config,
        JSON.stringify({ hints: { add: count ? ['not (a = b) ===> a <> b'] : [] } }),
      );
      await assertLintOracle(oracle, LINT_SOURCE, count, config);
      await assertLintProblems(fixture, count);
      assertFileStillClosed(fixture);
    }
    fs.unlinkSync(config);
    await assertLintProblems(fixture, 1);
    assertFileStillClosed(fixture);
  });
});
