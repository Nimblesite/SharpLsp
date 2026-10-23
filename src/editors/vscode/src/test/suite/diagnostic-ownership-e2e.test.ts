// [DIAG-TRUTH-GUARANTEES] [DIAG-IPC-REFRESH]
// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING] [SHARPLSP-ARCHITECTURE-PROJECTS-CSHARP-OWNING]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { isWithin, joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  assertClosedProblem,
  assertFileStillClosed,
  assertNoCompilerErrors,
  teardownAccuracyFixture,
  writeAccuracyFixture,
  type AccuracyCase,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { dotnet, type ProjectOptions } from './dotnet-project-kit';
import { loadSolutionInServer } from './real-repo-helpers';
import { activateWithScratch } from './test-explorer-kit';
import { pollUntilResult, removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

const OWNERSHIP_CASES = [
  { primary: ACCURACY_CASES[1], external: ACCURACY_CASES[0] },
  { primary: ACCURACY_CASES[0], external: ACCURACY_CASES[0] },
  { primary: ACCURACY_CASES[0], external: ACCURACY_CASES[1] },
] as const;

interface OwnershipFixture {
  readonly root: string;
  readonly primary: AccuracyFixture;
  readonly external: AccuracyFixture;
}

/** Both independent SDK solutions contain a genuine closed-file compiler error. */
async function prepareOwnership(
  scenario: { readonly primary: AccuracyCase; readonly external: AccuracyCase },
  options: ProjectOptions = {},
): Promise<OwnershipFixture> {
  const { api, root } = await activateWithScratch('slsp-diagnostic-owner-');
  const primary = await writeAccuracyFixture(api, joinPath(root, 'Selected'), scenario.primary);
  const external = await writeAccuracyFixture(
    api,
    joinPath(root, 'External'),
    scenario.external,
    options,
  );
  await loadSolutionInServer(primary.solution);
  await api.explorerProvider.loadSolution(primary.solution);
  return { root, primary, external };
}

/** Restore the default compiler workspace before removing these fixture-owned directories. */
async function teardownOwnership(fixture: OwnershipFixture): Promise<void> {
  await teardownAccuracyFixture(fixture.primary);
  await vscode.workspace.fs.delete(vscode.Uri.file(fixture.root), {
    recursive: true,
    useTrash: false,
  });
  await pollUntilResult(
    async () =>
      vscode.workspace.textDocuments.filter(
        (document) => !document.isClosed && isWithin(document.uri.fsPath, fixture.root),
      ).length,
    (count) => count === 0,
    LSP_RESPONSE_MS,
    100,
    'every fixture-owned editor model must actually close before the next suite',
  );
  assert.ok(!fs.existsSync(fixture.root), 'the complete owning-project fixture was removed');
}

/** An unselected project contributes no errors until opening its source adopts it. */
async function assertInitiallyUnselected(fixture: OwnershipFixture): Promise<void> {
  await assertClosedProblem(fixture.primary, 1);
  assertNoCompilerErrors(fixture.external.closedUri);
  assertFileStillClosed(fixture.primary);
  assertFileStillClosed(fixture.external);
}

/** Opening one clean source must expose its owner's unopened erroneous source. */
async function openExternalEntry(fixture: OwnershipFixture): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', fixture.external.entryUri);
  const document = vscode.window.activeTextEditor?.document;
  assert.ok(document, 'the actual editor opened the owning-project source');
  assert.equal(document.uri.toString(), fixture.external.entryUri.toString());
  assert.equal(document.isDirty, false);
  assert.equal(document.getText(), fixture.external.scenario.source);
  await assertOwnershipTruth(fixture, 1);
}

/** Compiler identity, severity and locations remain correct in both project graphs. */
async function assertOwnershipTruth(fixture: OwnershipFixture, count: number): Promise<void> {
  await assertClosedProblem(fixture.external, count);
  await assertClosedProblem(fixture.primary, 1);
  assertFileStillClosed(fixture.external);
  assertFileStillClosed(fixture.primary);
  assertNoCompilerErrors(fixture.external.entryUri);
}

/** The actual SDK independently validates every on-disk repair and regression. */
async function assertSdkOutcome(fixture: AccuracyFixture, broken: boolean): Promise<void> {
  const build = dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root);
  if (broken) {
    await assert.rejects(
      build,
      (error: unknown) => error instanceof Error && error.message.includes(fixture.scenario.code),
    );
  } else await build;
}

/** Disk-only changes refresh the adopted project without reopening or a semantic rescue. */
async function assertExternalEdit(fixture: OwnershipFixture, broken: boolean): Promise<void> {
  fs.writeFileSync(
    fixture.external.closedUri.fsPath,
    broken ? fixture.external.scenario.broken : fixture.external.scenario.clean,
  );
  await assertSdkOutcome(fixture.external, broken);
  await assertOwnershipTruth(fixture, broken ? 1 : 0);
}

/** Reuse actual SDK fixture lifecycle for every owning-project interaction. */
function useOwnershipFixture(
  scenario: Parameters<typeof prepareOwnership>[0],
  options: ProjectOptions = {},
): () => OwnershipFixture {
  let fixture: OwnershipFixture;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    fixture = await prepareOwnership(scenario, options);
  });
  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await teardownOwnership(fixture);
  });
  return () => fixture;
}

/** Remove only this fixture's package and independently prove its SDK references are broken. */
async function removeOwnerPackage(fixture: AccuracyFixture): Promise<string> {
  fs.writeFileSync(fixture.closedUri.fsPath, fixture.scenario.clean);
  await assertSdkOutcome(fixture, false);
  const folder = joinPath(fixture.root, 'packages', 'newtonsoft.json', '13.0.3');
  assert.ok(fs.existsSync(folder));
  removeDirRecursive(folder);
  await assert.rejects(
    dotnet(
      ['build', fixture.solution, '--no-restore', '--no-incremental', '--nologo'],
      fixture.root,
    ),
    (error: unknown) => error instanceof Error && error.message.includes('Newtonsoft.Json'),
  );
  assert.ok(!fs.existsSync(folder));
  fs.writeFileSync(fixture.closedUri.fsPath, fixture.scenario.broken);
  return folder;
}

for (const scenario of OWNERSHIP_CASES) {
  suite(
    `Diagnostic owning projects — ${scenario.external.language} beside ${scenario.primary.language}`,
    () => {
      const current = useOwnershipFixture(scenario);
      test('opening an external source adopts its closed-file errors and refreshes repairs', async function () {
        this.timeout(FIXTURE_BUILD_MS + 4 * LSP_RESPONSE_MS);
        const fixture = current();
        await assertInitiallyUnselected(fixture);
        await openExternalEntry(fixture);
        await assertExternalEdit(fixture, false);
        await assertExternalEdit(fixture, true);
      });
    },
  );
}

suite('F# owning projects — restore completion', () => {
  const scenario = {
    ...OWNERSHIP_CASES[0],
    external: {
      ...ACCURACY_CASES[0],
      source:
        'module DiagnosticAccuracy.Entry\nlet value = Newtonsoft.Json.JsonConvert.SerializeObject(42).Length\n',
    },
  };
  const current = useOwnershipFixture(scenario, {
    properties: { RestorePackagesPath: '$(MSBuildProjectDirectory)/../packages' },
    packages: [{ id: 'Newtonsoft.Json', version: '13.0.3' }],
  });
  test('restoring an external owner refreshes closed errors without a semantic or file-event rescue', async function () {
    this.timeout(FIXTURE_BUILD_MS + 4 * LSP_RESPONSE_MS);
    const fixture = current();
    const folder = await removeOwnerPackage(fixture.external);
    await assertInitiallyUnselected(fixture);
    await openExternalEntry(fixture);
    assert.ok(fs.existsSync(folder), 'owning-project loading must restore its missing package');
    await assertExternalEdit(fixture, false);
    await assertExternalEdit(fixture, true);
  });
});
