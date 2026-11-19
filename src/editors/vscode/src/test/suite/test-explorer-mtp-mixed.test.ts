// One solution, two runners: a VSTest xUnit project BESIDE an `xunit.v3` MTP
// project. The early MTP route of [TEST-MTP-DETECT] (#581) answers for the
// whole target as soon as the package graph names ONE MTP project, so the
// VSTest project beside it must still be listed — it was in v0.33.0.
//
// Covers [TEST-MTP-DETECT], [TEST-MTP-ROUTING] and [TEST-DISCOVERY-FQN].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { listTests } from '../../test-discovery.js';
import {
  createSolution,
  dotnet,
  projectXml,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  nativeIdsOf,
  NATIVE_FIXTURES,
  writeNativeProject,
} from './test-explorer-mtp-native-fixtures';
import {
  activateWithScratch,
  collectLeafIds,
  discoverSolution,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { cachedFor, runIds } from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';

const NATIVE = NATIVE_FIXTURES.find((fixture) => fixture.language === 'fsharp');
const VSTEST_PROJECT = 'Fs.Mixed.Vstest';
const VSTEST_IDS = ['Fs.Mixed.Vstest.Facts.holds', 'Fs.Mixed.Vstest.Facts.also holds'];
const VSTEST_SOURCE = [
  'module Fs.Mixed.Vstest.Facts',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let holds () = Assert.True true',
  '',
  '[<Fact>]',
  'let ``also holds`` () = Assert.Equal(2, 1 + 1)',
  '',
].join('\n');

suite('Test Explorer e2e — a VSTest project beside an MTP project in one solution', () => {
  test('discovery lists BOTH projects: the MTP module and the VSTest project beside it', async function () {
    this.timeout(FIXTURE_BUILD_MS * 3);
    assert.ok(NATIVE, 'the F# native fixture exists');
    const { api, root } = await activateWithScratch('slsp-mtp-mixed-');
    try {
      const vstestDir = writeProject(
        path.join(root, VSTEST_PROJECT),
        `${VSTEST_PROJECT}.fsproj`,
        projectXml(XUNIT_PACKAGES, 'Facts.fs'),
        'Facts.fs',
        VSTEST_SOURCE,
      );
      const nativeDir = writeNativeProject(root, NATIVE);
      const solution = await createSolution(root, 'Mixed', [nativeDir, vstestDir]);
      // Restored, as any opened solution is: the package graph now names the
      // MTP project before a single VSTest pass has run.
      await dotnet(['restore', solution], root);
      const expected = [...nativeIdsOf(NATIVE), ...VSTEST_IDS];

      // 1. The listing itself carries both runners' tests.
      const listing = await listTests(solution, FIXTURE_BUILD_MS);
      for (const id of expected)
        assert.ok(
          listing.names.includes(id),
          `listing carries ${id}; it carries ${listing.names.join(', ')}`,
        );
      assert.ok(listing.ok, 'a listing that found both projects is trustworthy');
      assert.equal(listing.mtp?.modules.length, 1, 'exactly one MTP module is planned');

      // 2. The Testing view shows them all, nothing lost.
      await discoverSolution(api, solution, expected);
      const leaves = collectLeafIds(api.testController.items);
      for (const id of expected) assert.ok(leaves.includes(id), `the tree carries ${id}`);
      assert.deepEqual(
        [...leaves].sort(),
        [...expected].sort(),
        'exactly both projects, nothing invented',
      );

      // 3. One Run across both runners: each id reaches the runner that owns
      //    it, so neither half reports "No result reported" [TEST-MTP-ROUTING].
      const [holds, alsoHolds] = VSTEST_IDS;
      assert.ok(NATIVE.passing && holds && alsoHolds);
      await runIds(api, vscode.TestRunProfileKind.Run, [NATIVE.passing, NATIVE.failing, holds]);
      await api.testController.whenIdle();
      assert.equal(cachedFor(api, NATIVE.passing).outcome, 'passed', 'the MTP pass ran');
      assert.equal(cachedFor(api, NATIVE.failing).outcome, 'failed', 'the MTP failure ran');
      assert.equal(cachedFor(api, holds).outcome, 'passed', 'the VSTest fact ran beside them');

      // 4. A VSTest-only selection never touches the MTP module.
      await runIds(api, vscode.TestRunProfileKind.Run, [alsoHolds]);
      await api.testController.whenIdle();
      assert.equal(cachedFor(api, alsoHolds).outcome, 'passed', 'the VSTest-only run passed');
      assert.equal(cachedFor(api, NATIVE.passing).outcome, 'passed', 'the MTP result stays');
    } finally {
      await teardownFixtureSolution(api, root, removeDirRecursive);
    }
  });
});
