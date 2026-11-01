// Red contract coverage for [NUGET-REQUESTS-UPDATE-BOUNDS] and
// [NUGET-REQUESTS-UPDATE-TESTS]. The local feed makes every resolution repeatable.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { parseProjectDependencies } from '../../dependencies';
import { joinPath } from '../../paths';
import { closeAllEditors, removeDirRecursive } from './test-helpers';
import {
  assertCheckedInProjectsUnchanged,
  BOUNDED_VERSION,
  CONTROLLED_PACKAGE,
  CURRENT_VERSION,
  seedControlledPackageSource,
  selectExpectedProject,
  snapshotCheckedInProjects,
  UPDATE_PROJECTS,
  writeUpdateProject,
} from './nuget-update-test-kit';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

suite('NuGet palette Update — bounded real C# and F# projects', () => {
  let root: string;
  let checkedInProjects: ReadonlyMap<string, Buffer>;
  let stubs: UiStubs;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspace !== undefined, 'the real test workspace must be open');
    checkedInProjects = await snapshotCheckedInProjects();
    root = fs.mkdtempSync(joinPath(workspace, '.nuget-update-'));
    await seedControlledPackageSource(root);
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    removeDirRecursive(root);
  });

  setup(() => {
    stubs = installUiStubs();
  });

  teardown(() => {
    stubs.restore();
  });

  for (const shape of UPDATE_PROJECTS) {
    // Ignored until bounded candidate selection ships; the browser has no bounded apply yet (#270).
    test.skip(`${shape.extension} stays within its version line and preserves checked-in fixtures`, async function () {
      this.timeout(DOTNET_CLI_MS);
      const project = writeUpdateProject(root, shape);
      const before = parseProjectDependencies(project).nugetPackages;
      assert.deepEqual(before, [{ name: CONTROLLED_PACKAGE, version: CURRENT_VERSION }]);
      stubs
        .queuePick(selectExpectedProject(project))
        .queueInput(CONTROLLED_PACKAGE)
        .queueInfo('Update');

      try {
        await vscode.commands.executeCommand('sharplsp.nuget.update');
        assert.ok(fs.existsSync(project), 'the disposable project remains on disk');
        const after = parseProjectDependencies(project).nugetPackages;
        assert.deepEqual(after, [{ name: CONTROLLED_PACKAGE, version: BOUNDED_VERSION }]);
      } finally {
        assertCheckedInProjectsUnchanged(checkedInProjects);
      }
    });
  }
});
