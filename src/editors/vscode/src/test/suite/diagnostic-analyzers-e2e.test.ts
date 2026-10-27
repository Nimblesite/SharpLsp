// Real SDK analyzer truth, live suppression and opt-out. [DIAG-CATEGORIES-ANALYZER]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { directoryOf, joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  activateAccuracyFixture,
  assertCompilerProblem,
  teardownAccuracyFixture,
  type AccuracyCase,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { buildProjectXml, dotnet } from './dotnet-project-kit';
import { replaceDocumentContent, waitForHoverResult } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

const ANALYZER: AccuracyCase = {
  ...ACCURACY_CASES[1],
  project: 'AnalyzerAccuracy.csproj',
  code: 'CA1822',
  broken: 'namespace DiagnosticAccuracy;\npublic class Closed { public int Answer() => 42; }\n',
  clean:
    'namespace DiagnosticAccuracy;\npublic class Closed { public static int Answer() => 42; }\n',
};
const RULE = 'root = true\n[*.cs]\ndotnet_diagnostic.CA1822.severity = ';

/** Replace the closed file in the unsaved buffer; the analyzer error must follow exactly once. */
async function assertUnsavedAnalyzerStep(
  fixture: AccuracyFixture,
  document: vscode.TextDocument,
  source: string,
  count: number,
): Promise<void> {
  assert.equal(await replaceDocumentContent(document, source), true);
  assert.equal(document.isDirty, true);
  await assertCompilerProblem(fixture, fixture.closedUri, count, 1);
}

/** Break the entry in the unsaved buffer and pin BOTH truths: analyzer error and compiler error. */
async function assertBrokenEntryShowsCompilerError(
  fixture: AccuracyFixture,
  compiler: AccuracyFixture,
  document: vscode.TextDocument,
): Promise<void> {
  assert.equal(await replaceDocumentContent(document, compiler.scenario.brokenEntry), true);
  await assertCompilerProblem(compiler, fixture.entryUri, 1, 2);
}

/** Toggle the live analyzers_enabled setting; Closed's analyzer error follows, Entry's error stays. */
async function assertAnalyzerToggleStep(
  fixture: AccuracyFixture,
  compiler: AccuracyFixture,
  client: LanguageClient,
  enabled: boolean,
  count: number,
): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', {
    settings: { sharplsp: { diagnostics: { analyzers_enabled: enabled } } },
  });
  await assertCompilerProblem(fixture, fixture.closedUri, count, 1);
  await assertCompilerProblem(compiler, fixture.entryUri, 1, 2);
}

/** Reset the pushed config and put the saved entry source back before the next test. */
async function restoreAnalyzerSettings(
  compiler: AccuracyFixture,
  client: LanguageClient,
  document: vscode.TextDocument,
): Promise<void> {
  await client.sendNotification('workspace/didChangeConfiguration', {
    settings: { sharplsp: {} },
  });
  assert.equal(await replaceDocumentContent(document, compiler.scenario.source), true);
  await document.save();
}

/** Rewrite editorconfig + NoWarn on disk, rebuild with the real SDK, and assert the Problems truth. */
async function assertSuppressedAnalyzerStep(
  fixture: AccuracyFixture,
  config: string,
  project: string,
  severity: string,
  noWarn: string,
  count: number,
): Promise<void> {
  const xml = buildProjectXml({ properties: { EnableNETAnalyzers: 'true', NoWarn: noWarn } });
  fs.writeFileSync(config, `${RULE}${severity}\n`);
  fs.writeFileSync(project, xml);
  const build = dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root);
  if (count === 1) await assert.rejects(build, /CA1822/);
  else await build;
  await assertCompilerProblem(fixture, fixture.closedUri, count, 1);
  assert.equal(fs.existsSync(config), true);
  assert.equal(fs.existsSync(project), true);
}

suite('Diagnostic accuracy — SDK analyzers, configuration and suppression', () => {
  let fixture: AccuracyFixture;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    fixture = await activateAccuracyFixture(
      'slsp-analyzer-accuracy-',
      ANALYZER,
      { properties: { EnableNETAnalyzers: 'true' } },
      `${RULE}error\n`,
    );
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(fixture.closedUri),
    );
    assert.ok(
      (await waitForHoverResult(fixture.closedUri, new vscode.Position(1, 13), SIDECAR_COLD_MS))
        .length > 0,
    );
  });
  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await teardownAccuracyFixture(fixture);
  });

  test('the SDK analyzer error appears, clears on an unsaved fix, and returns on regression exactly once', async function () {
    this.timeout(5 * LSP_RESPONSE_MS);
    const document = await vscode.workspace.openTextDocument(fixture.closedUri);
    await assertCompilerProblem(fixture, fixture.closedUri, 1, 1);
    for (const [source, count] of [
      [ANALYZER.clean, 0],
      [ANALYZER.broken, 1],
    ] as const) {
      await assertUnsavedAnalyzerStep(fixture, document, source, count);
    }
    await document.save();
  });

  test('disabling analyzers removes their errors while preserving real compiler errors', async function () {
    this.timeout(6 * LSP_RESPONSE_MS);
    const client = fixture.api.getLspClient();
    assert.ok(client);
    const document = await vscode.workspace.openTextDocument(fixture.entryUri);
    const compiler = { ...fixture, scenario: ACCURACY_CASES[1] };
    try {
      await assertBrokenEntryShowsCompilerError(fixture, compiler, document);
      for (const [enabled, count] of [
        [false, 0],
        [true, 1],
      ] as const) {
        await assertAnalyzerToggleStep(fixture, compiler, client, enabled, count);
      }
    } finally {
      await restoreAnalyzerSettings(compiler, client, document);
    }
  });

  test('editorconfig and project NoWarn changes remove false positives and reversing them restores actual errors', async function () {
    this.timeout(4 * FIXTURE_BUILD_MS);
    const config = joinPath(fixture.root, '.editorconfig');
    const project = joinPath(directoryOf(fixture.closedUri.fsPath), ANALYZER.project);
    for (const [severity, noWarn, count] of [
      ['none', '', 0],
      ['error', '', 1],
      ['error', 'CA1822', 0],
      ['error', '', 1],
    ] as const) {
      await assertSuppressedAnalyzerStep(fixture, config, project, severity, noWarn, count);
    }
  });
});
