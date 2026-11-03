// Red contract coverage for [NUGET-REQUESTS-UPDATE-BOUNDS] and
// [NUGET-REQUESTS-UPDATE-TESTS]. The local feed makes every resolution repeatable.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { parseProjectDependencies } from '../../dependencies';
import type { NuGetBrowserPanel } from '../../nuget-browser';
import { directoryOf, joinPath } from '../../paths';
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
  writeCpmUpdateProject,
  writeUnavailablePackageSource,
  writeUpdateProject,
  writeUpdateProjectAtVersion,
  type UpdateProjectShape,
} from './nuget-update-test-kit';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

suite('NuGet palette Update — bounded real C# and F# projects', () => {
  let root: string;
  let checkedInProjects: ReadonlyMap<string, Buffer>;
  let stubs: UiStubs;
  let panel: NuGetBrowserPanel | undefined;

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
    panel?.dispose();
    panel = undefined;
    stubs.restore();
  });

  function namedShape(extension: 'csproj' | 'fsproj', name: string): UpdateProjectShape {
    const shape = UPDATE_PROJECTS.find((candidate) => candidate.extension === extension);
    assert.ok(shape !== undefined, `the ${extension} fixture shape exists`);
    return { ...shape, name };
  }

  for (const shape of UPDATE_PROJECTS) {
    test(`${shape.extension} stays within its version line and preserves checked-in fixtures`, async function () {
      this.timeout(DOTNET_CLI_MS);
      const project = writeUpdateProject(root, shape);
      const before = parseProjectDependencies(project).nugetPackages;
      assert.deepEqual(before, [{ name: CONTROLLED_PACKAGE, version: CURRENT_VERSION }]);
      // [NUGET-REQUESTS-UPDATE-BOUNDS] Pick an installed direct package; never type an arbitrary id.
      stubs.queuePick(selectExpectedProject(project), CONTROLLED_PACKAGE).queueInfo('Update');

      try {
        await vscode.commands.executeCommand('sharplsp.nuget.update');
        assert.ok(fs.existsSync(project), 'the disposable project remains on disk');
        const after = parseProjectDependencies(project).nugetPackages;
        assert.deepEqual(after, [{ name: CONTROLLED_PACKAGE, version: BOUNDED_VERSION }]);
        assert.notEqual(after[0]?.version, '2.0.0', 'never cross the major boundary');
        assert.notEqual(after[0]?.version, '1.3.0-beta.1', 'never auto-select a prerelease');
        const confirmation = stubs.log.infoMessages.find((message) => message.includes('Update'));
        assert.ok(confirmation !== undefined, 'the exact proposal requires confirmation');
        for (const expected of [project, CONTROLLED_PACKAGE, CURRENT_VERSION, BOUNDED_VERSION]) {
          assert.ok(confirmation.includes(expected), `confirmation names ${expected}`);
        }
      } finally {
        assertCheckedInProjectsUnchanged(checkedInProjects);
      }
    });
  }

  test('0.x stays within its minor and excludes the next minor', async function () {
    this.timeout(DOTNET_CLI_MS);
    const shape = namedShape('fsproj', 'FSharpZeroUpdate');
    const project = writeUpdateProjectAtVersion(root, shape, '0.4.2');
    stubs.queuePick(selectExpectedProject(project), CONTROLLED_PACKAGE).queueInfo('Update');
    try {
      await vscode.commands.executeCommand('sharplsp.nuget.update');
      assert.deepEqual(parseProjectDependencies(project).nugetPackages, [
        { name: CONTROLLED_PACKAGE, version: '0.4.9' },
      ]);
      const confirmation = stubs.log.infoMessages.find((message) => message.includes('0.4.9'));
      assert.ok(confirmation !== undefined, 'the exact 0.x candidate is shown');
      assert.ok(!confirmation.includes('0.5.0'), 'the next minor is not proposed');
      assert.ok(!confirmation.includes('beta'), 'prereleases stay excluded');
    } finally {
      assertCheckedInProjectsUnchanged(checkedInProjects);
    }
  });

  test('no candidate reports the version line and makes no edit', async function () {
    this.timeout(DOTNET_CLI_MS);
    const shape = namedShape('fsproj', 'FSharpAlreadyCurrent');
    const project = writeUpdateProjectAtVersion(root, shape, BOUNDED_VERSION);
    stubs.queuePick(selectExpectedProject(project), CONTROLLED_PACKAGE);
    try {
      await vscode.commands.executeCommand('sharplsp.nuget.update');
      assert.deepEqual(parseProjectDependencies(project).nugetPackages, [
        { name: CONTROLLED_PACKAGE, version: BOUNDED_VERSION },
      ]);
      assert.ok(
        stubs.log.infoMessages.some((message) =>
          message.includes('Already up to date within this version line'),
        ),
        'the no-candidate result is visible',
      );
      assert.deepEqual(stubs.log.errorMessages, [], 'no candidate is not an error');
      assert.ok(!stubs.log.infoActions.some((actions) => actions.includes('Update')));
    } finally {
      assertCheckedInProjectsUnchanged(checkedInProjects);
    }
  });

  test('confirmation cancellation leaves the declaration unchanged', async function () {
    this.timeout(DOTNET_CLI_MS);
    const shape = namedShape('csproj', 'CSharpCancelledUpdate');
    const project = writeUpdateProject(root, shape);
    stubs.queuePick(selectExpectedProject(project), CONTROLLED_PACKAGE).queueInfo(undefined);
    try {
      await vscode.commands.executeCommand('sharplsp.nuget.update');
      assert.deepEqual(parseProjectDependencies(project).nugetPackages, [
        { name: CONTROLLED_PACKAGE, version: CURRENT_VERSION },
      ]);
      assert.ok(stubs.log.infoMessages.some((message) => message.includes(BOUNDED_VERSION)));
      assert.ok(!stubs.log.infoMessages.some((message) => message.includes('Updated')));
      assert.deepEqual(stubs.log.errorMessages, [], 'cancellation is not an error');
    } finally {
      assertCheckedInProjectsUnchanged(checkedInProjects);
    }
  });

  test('an unavailable feed is visible and leaves the declaration unchanged', async function () {
    this.timeout(DOTNET_CLI_MS);
    const shape = namedShape('fsproj', 'FSharpUnavailableFeed');
    const project = writeUpdateProject(root, shape);
    writeUnavailablePackageSource(project);
    stubs.queuePick(selectExpectedProject(project), CONTROLLED_PACKAGE);
    try {
      await vscode.commands.executeCommand('sharplsp.nuget.update');
      assert.deepEqual(parseProjectDependencies(project).nugetPackages, [
        { name: CONTROLLED_PACKAGE, version: CURRENT_VERSION },
      ]);
      assert.ok(stubs.log.errorMessages.length > 0, 'lookup failure is never silent');
      assert.ok(stubs.log.errorMessages.some((message) => message.includes(CONTROLLED_PACKAGE)));
      assert.ok(!stubs.log.infoMessages.some((message) => message.includes('Updated')));
    } finally {
      assertCheckedInProjectsUnchanged(checkedInProjects);
    }
  });

  test('a floating declaration requires explicit version selection and makes no edit', async function () {
    this.timeout(DOTNET_CLI_MS);
    const shape = namedShape('csproj', 'CSharpFloatingUpdate');
    const project = writeUpdateProjectAtVersion(root, shape, '1.*');
    stubs.queuePick(selectExpectedProject(project), CONTROLLED_PACKAGE);
    try {
      await vscode.commands.executeCommand('sharplsp.nuget.update');
      assert.deepEqual(parseProjectDependencies(project).nugetPackages, [
        { name: CONTROLLED_PACKAGE, version: '1.*' },
      ]);
      assert.ok(
        stubs.log.errorMessages.some((message) => message.includes('explicit version selection')),
        'the ambiguity is shown',
      );
      assert.ok(!stubs.log.infoActions.some((actions) => actions.includes('Update')));
      assert.ok(!stubs.log.infoMessages.some((message) => message.includes('Updated')));
    } finally {
      assertCheckedInProjectsUnchanged(checkedInProjects);
    }
  });

  test('CPM previews and updates the version-owning props file only', async function () {
    this.timeout(DOTNET_CLI_MS);
    const shape = namedShape('fsproj', 'FSharpCpmUpdate');
    const project = writeCpmUpdateProject(root, shape);
    const props = joinPath(directoryOf(project), 'Directory.Packages.props');
    try {
      execFileSync('dotnet', ['restore', project], { stdio: 'pipe' });
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer };
      assert.fail(
        `CPM fixture restore failed: ${failure.stdout?.toString() ?? ''} ${failure.stderr?.toString() ?? ''}`,
      );
    }
    stubs.queuePick(selectExpectedProject(project), CONTROLLED_PACKAGE).queueInfo('Update');
    try {
      panel = await vscode.commands.executeCommand('sharplsp.nuget.update');
      assert.deepEqual(parseProjectDependencies(project).nugetPackages, [
        { name: CONTROLLED_PACKAGE, version: '' },
      ]);
      const propsText = fs.readFileSync(props, 'utf8');
      assert.ok(
        propsText.includes(`Version="${BOUNDED_VERSION}"`),
        `CPM owns the exact update; props=${propsText}; errors=${stubs.log.errorMessages.join(' | ')}`,
      );
      assert.ok(!propsText.includes('Version="2.0.0"'), 'CPM respects the major bound');
      const confirmation = stubs.log.infoMessages.find((message) => message.includes('Update'));
      assert.ok(confirmation?.includes(props), 'the preview names the version-owning file');
      assert.ok(confirmation?.includes(project), 'the preview names the affected project');
    } finally {
      assertCheckedInProjectsUnchanged(checkedInProjects);
    }
  });
});
