// Real F# lint discovery, refresh, suppression and opt-out. [DIAG-CATEGORIES-ANALYZER] [DIAG-TRUTH-GUARANTEES]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  assertCompilerProblem,
  assertFileStillClosed,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import {
  assertLintDocument,
  assertLintWorkspace,
  assertUnsavedLintStep,
  assertLintToggleStep,
  restoreLintSettings,
  assertLintOracle,
  assertLintProblems,
  CLEAN_LINT_SOURCE,
  LINT_SOURCE,
  useLintFixture,
  SUPPRESSED_LINT_SOURCE,
  writeLintSource,
} from './diagnostic-lint-kit';
import { replaceDocumentContent } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

suite('F# lint accuracy through real compiler and editor changes', () => {
  let oracle: string;
  let fixture: AccuracyFixture;
  useLintFixture((current, independent) => {
    fixture = current;
    oracle = independent;
  });

  for (const [label, source] of [
    [
      'closed lint findings appear by default, clear on disk repair and return on regression',
      CLEAN_LINT_SOURCE,
    ],
    [
      'upstream inline suppression clears the actual finding and removing it restores the warning',
      SUPPRESSED_LINT_SOURCE,
    ],
  ] as const) {
    test(label, async function () {
      this.timeout(3 * FIXTURE_BUILD_MS);
      await assertLintProblems(fixture, 1);
      await writeLintSource(fixture, oracle, source, 0);
      await assertLintProblems(fixture, 0);
      await writeLintSource(fixture, oracle, LINT_SOURCE, 1);
      await assertLintProblems(fixture, 1);
    });
  }

  test('the first successful document and workspace pulls match the independent lint oracle', async function () {
    this.timeout(3 * LSP_RESPONSE_MS);
    await assertLintDocument(fixture, 1);
    await assertLintWorkspace(fixture, 1);
  });

  test('unsaved lint repair and regression refresh Problems and discarding edits restores saved truth', async function () {
    this.timeout(6 * LSP_RESPONSE_MS);
    await assertLintProblems(fixture, 1);
    const document = await vscode.workspace.openTextDocument(fixture.closedUri);
    await vscode.window.showTextDocument(document);
    for (const [source, count] of [
      [CLEAN_LINT_SOURCE, 0],
      [LINT_SOURCE, 1],
      [CLEAN_LINT_SOURCE, 0],
    ] as const) {
      await assertUnsavedLintStep(fixture, oracle, document, source, count);
    }
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await assertLintProblems(fixture, 1);
    assert.equal(fs.readFileSync(fixture.closedUri.fsPath, 'utf8'), LINT_SOURCE);
  });

  test('live analyzer opt-out retires lint while current compiler errors remain visible', async function () {
    this.timeout(8 * LSP_RESPONSE_MS);
    await assertLintProblems(fixture, 1);
    const client = fixture.api.getLspClient();
    assert.ok(client);
    const document = await vscode.workspace.openTextDocument(fixture.entryUri);
    assert.equal(await replaceDocumentContent(document, ACCURACY_CASES[0].brokenEntry), true);
    await assertCompilerProblem(fixture, fixture.entryUri, 1, 1);
    try {
      for (const [enabled, count] of [
        [false, 0],
        [true, 1],
        [false, 0],
      ] as const) {
        await assertLintToggleStep(fixture, client, enabled, count);
      }
    } finally {
      await restoreLintSettings(client, document);
    }
  });

  test('nearest fsharplint configuration changes refresh closed findings without a semantic rescue', async function () {
    this.timeout(6 * LSP_RESPONSE_MS);
    await assertLintProblems(fixture, 1);
    const config = joinPath(fixture.root, 'fsharplint.json');
    for (const [enabled, count] of [
      [false, 0],
      [true, 1],
      [false, 0],
    ] as const) {
      fs.writeFileSync(
        config,
        JSON.stringify({ hints: { add: enabled ? ['not (a = b) ===> a <> b'] : [] } }),
      );
      await assertLintOracle(oracle, LINT_SOURCE, count, config);
      await assertLintProblems(fixture, count);
      assertFileStillClosed(fixture);
    }
  });
});
