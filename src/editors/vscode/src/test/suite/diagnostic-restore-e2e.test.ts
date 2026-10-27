// Real SDK workspace restoration. Implements [DIAG-RESTORE], [DIAG-CONFIG].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { type LanguageClient, type WorkspaceDiagnosticReport } from 'vscode-languageclient/node';
import { filePathFromUri, fileUri, joinPath, samePath } from '../../paths';
import type { SharpLspExtensionApi } from '../../extension';
import { firstDiagnosticReport } from './diagnostic-accuracy-fixtures';
import { buildProjectXml, createSolution, dotnet, writeProject } from './dotnet-project-kit';
import { writeRestoreMarker } from './diagnostic-restore-kit';
import { hoverText, positionOf } from './fsharp-helpers';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';
import { activateWithScratch, teardownFixtureSolution } from './test-explorer-kit';
import {
  closeAllEditors,
  pollUntilResult,
  removeDirRecursive,
  waitForHoverResult,
} from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS, SIDECAR_COLD_MS } from './test-timeouts';

const RESTORE_CASES = [
  {
    language: 'F#',
    project: 'RestoreFs.fsproj',
    entry: 'Entry.fs',
    source:
      'module RestoreContract\nlet serialize () = Newtonsoft.Json.JsonConvert.SerializeObject(42)\n',
  },
  {
    language: 'C#',
    project: 'RestoreCs.csproj',
    entry: 'Entry.cs',
    source:
      'namespace RestoreContract;\npublic static class Entry {\n    public static string Serialize() => Newtonsoft.Json.JsonConvert.SerializeObject(42);\n}\n',
  },
] as const;

interface RestoreFixture {
  readonly api: SharpLspExtensionApi;
  readonly root: string;
  readonly solution: string;
  readonly source: vscode.Uri;
  readonly assets: string;
  readonly marker: string;
}

/** Both compilers consume a genuine project from the canonical XML writer. */
function writeRestoreProject(root: string, scenario: (typeof RESTORE_CASES)[number]): string {
  return writeProject(
    joinPath(root, 'Project'),
    scenario.project,
    buildProjectXml({
      properties: { RestorePackagesPath: joinPath(root, 'packages') },
      packages: [{ id: 'Newtonsoft.Json', version: '13.0.3' }],
      compileIncludes: scenario.language === 'F#' ? [scenario.entry] : [],
    }),
    scenario.entry,
    scenario.source,
  );
}

/** Prove the package project builds before removing only its own restore inputs. */
async function createRestoreFixture(
  scenario: (typeof RESTORE_CASES)[number],
): Promise<RestoreFixture> {
  const { api, root } = await activateWithScratch('slsp-workspace-restore-');
  isolateFromRepoMsbuild(root);
  const marker = writeRestoreMarker(root);
  const project = writeRestoreProject(root, scenario);
  const solution = await createSolution(root, 'Restore', [project]);
  await assertSdkFixture(root, project, solution, marker, scenario);
  return {
    api,
    root,
    solution,
    source: fileUri(joinPath(project, scenario.entry)),
    assets: joinPath(project, 'obj', 'project.assets.json'),
    marker,
  };
}

/** The SDK itself must invoke the observable target and produce the required assets. */
async function assertSdkFixture(
  root: string,
  project: string,
  solution: string,
  marker: string,
  scenario: (typeof RESTORE_CASES)[number],
): Promise<void> {
  await dotnet(['restore', joinPath(project, scenario.project), '--nologo'], root);
  await dotnet(['build', solution, '--no-restore', '--nologo'], root);
  assert.ok(fs.existsSync(joinPath(project, 'obj', 'project.assets.json')));
  assert.ok(fs.readFileSync(marker, 'utf8').includes(scenario.project));
}

/** A client setting must survive typed validation and be exposed as effective policy. */
async function configureRestore(client: LanguageClient, enabled: boolean): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', {
    settings: { sharplsp: { diagnostics: { auto_restore_on_open: enabled } } },
  });
  const config = await client.sendRequest<{ diagnostics: { auto_restore_on_open?: boolean } }>(
    'sharplsp/configuration',
    {},
  );
  assert.equal(config.diagnostics.auto_restore_on_open, enabled);
}

/** A missing-assets SDK error is independent evidence that restoration is required. */
async function removeRestoreInputs(fixture: RestoreFixture): Promise<void> {
  fs.unlinkSync(fixture.marker);
  fs.unlinkSync(fixture.assets);
  await assert.rejects(
    dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('NETSDK1004'));
      return true;
    },
  );
  assert.ok(!fs.existsSync(fixture.marker));
  assert.ok(!fs.existsSync(fixture.assets));
}

/** Follow only the standard retrigger response; all other request failures remain failures. */
async function settledWorkspaceReport(client: LanguageClient): Promise<WorkspaceDiagnosticReport> {
  const report = await firstDiagnosticReport<WorkspaceDiagnosticReport>(
    client,
    'workspace/diagnostic',
    { previousResultIds: [] },
    SIDECAR_COLD_MS,
  );
  assert.ok(report);
  return report;
}

/** Workspace pulls complete the load before testing absence of restore side effects. */
async function assertRestoreDisabled(
  fixture: RestoreFixture,
  client: LanguageClient,
): Promise<void> {
  await configureRestore(client, false);
  await loadSolutionInServer(fixture.solution);
  const report = await settledWorkspaceReport(client);
  assert.ok(
    report.items.some((item) => samePath(filePathFromUri(item.uri), fixture.source.fsPath)),
    'the selected source participates before checking restore effects',
  );
  assert.ok(
    !fs.existsSync(fixture.marker),
    'opening with restore disabled must not invoke Restore',
  );
  assert.ok(!fs.existsSync(fixture.assets), 'opening with restore disabled must not create assets');
  await assert.rejects(
    dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root),
    (error: unknown) => error instanceof Error && error.message.includes('NETSDK1004'),
  );
}

/** Reopening with opt-in must create actual restore outputs before semantic use. */
async function assertRestored(fixture: RestoreFixture, client: LanguageClient): Promise<void> {
  await configureRestore(client, true);
  await loadSolutionInServer(fixture.solution);
  assert.ok(
    await pollUntilResult(
      async () => fs.existsSync(fixture.marker) && fs.existsSync(fixture.assets),
      (ready) => ready,
      DOTNET_CLI_MS,
    ),
    'workspace open must run Restore and recreate project assets',
  );
  await assertPackageHover(fixture);
  await assertWorkspaceClean(fixture, client);
  await dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root);
}

/** Package quick info must contain the real method signature and return type. */
async function assertPackageHover(fixture: RestoreFixture): Promise<void> {
  const document = await vscode.workspace.openTextDocument(fixture.source);
  await vscode.window.showTextDocument(document);
  const signature = hoverText(
    await waitForHoverResult(
      fixture.source,
      positionOf(document, 'SerializeObject', 3),
      SIDECAR_COLD_MS,
    ),
  );
  assert.ok(signature.includes('SerializeObject'));
  assert.ok(signature.includes('string'));
}

/** Source participation prevents a missing compiler workspace from appearing clean. */
async function assertWorkspaceClean(
  fixture: RestoreFixture,
  client: LanguageClient,
): Promise<void> {
  const report = await settledWorkspaceReport(client);
  assert.ok(
    report.items.some((item) => samePath(filePathFromUri(item.uri), fixture.source.fsPath)),
  );
  assert.deepEqual(
    report.items.flatMap((item) =>
      item.kind === 'full' ? item.items.filter((d) => d.severity === 1) : [],
    ),
    [],
  );
}

/** Remove only this fixture's package; the SDK proves its references are now broken. */
async function removeFixturePackage(fixture: RestoreFixture): Promise<string> {
  const folder = joinPath(fixture.root, 'packages', 'newtonsoft.json', '13.0.3');
  assert.ok(fs.existsSync(folder));
  removeDirRecursive(folder);
  fs.unlinkSync(fixture.marker);
  await assert.rejects(
    dotnet(
      ['build', fixture.solution, '--no-restore', '--no-incremental', '--nologo'],
      fixture.root,
    ),
    (error: unknown) => error instanceof Error && error.message.includes('Newtonsoft.Json'),
  );
  assert.ok(!fs.existsSync(folder));
  assert.ok(fs.existsSync(fixture.assets));
  return folder;
}

/** Existing assets do not imply the restored references still exist on disk. */
async function assertCacheRestore(fixture: RestoreFixture, client: LanguageClient): Promise<void> {
  await closeAllEditors();
  await configureRestore(client, false);
  const folder = await removeFixturePackage(fixture);
  await loadSolutionInServer(fixture.solution);
  await settledWorkspaceReport(client);
  assert.ok(!fs.existsSync(fixture.marker), 'opt-out must not restore missing package files');
  assert.ok(!fs.existsSync(folder), 'opt-out must leave the fixture package absent');
  await configureRestore(client, true);
  await loadSolutionInServer(fixture.solution);
  assert.ok(
    await pollUntilResult(
      async () => fs.existsSync(fixture.marker) && fs.existsSync(folder),
      (ready) => ready,
      DOTNET_CLI_MS,
    ),
  );
  await assertPackageHover(fixture);
  await assertWorkspaceClean(fixture, client);
  await dotnet(
    ['build', fixture.solution, '--no-restore', '--no-incremental', '--nologo'],
    fixture.root,
  );
}

for (const scenario of RESTORE_CASES) {
  suite(`Workspace restore contract — ${scenario.language}`, () => {
    let fixture: RestoreFixture;
    let client: LanguageClient;
    suiteSetup(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      fixture = await createRestoreFixture(scenario);
      const active = fixture.api.getLspClient();
      assert.ok(active);
      client = active;
    });
    suiteTeardown(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      await closeAllEditors();
      if (client)
        await client.sendNotification('workspace/didChangeConfiguration', {
          settings: { sharplsp: { diagnostics: { auto_restore_on_open: true } } },
        });
      await loadSolutionInServer(fixtureSolutionPath());
      if (fixture) await teardownFixtureSolution(fixture.api, fixture.root, removeDirRecursive);
    });
    test('default restoration, opt-out and live opt-in agree with actual SDK restore effects', async function () {
      this.timeout(3 * DOTNET_CLI_MS);
      const config = await client.sendRequest<{ diagnostics: { auto_restore_on_open?: boolean } }>(
        'sharplsp/configuration',
        {},
      );
      assert.equal(
        config.diagnostics.auto_restore_on_open,
        true,
        'workspace restoration defaults on',
      );
      await removeRestoreInputs(fixture);
      await assertRestoreDisabled(fixture, client);
      await assertRestored(fixture, client);
    });
    test('a missing fixture-owned package cache respects opt-out and is restored on opt-in', async function () {
      this.timeout(3 * DOTNET_CLI_MS);
      await assertCacheRestore(fixture, client);
    });
  });
}
