import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  assertLandedOnOriginalSource,
  assertNoAnswerIsDecompiled,
  assertRoundTrip,
  openUse,
  pressOnce,
  pressUntilItLands,
} from './cross-language-definition-kit';
import {
  CROSS_LANGUAGE_SPECS,
  CSHARP_CLASS_FROM_FSHARP,
  FSHARP_CLASS_FROM_CSHARP,
  type CrossLanguageSpec,
} from './cross-language-definition-specs';
import { rebuildAndRestartRealLsp, restartRealLsp } from './cross-language-kit';
import { revertDocument, workspaceFixturePath } from './refactor-test-helpers';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import { COMMAND_MS, FIXTURE_BUILD_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

// F12 on a symbol from the other language opens its ORIGINAL source: never
// decompiled output, while the source is right there. Asserted at the editor
// window, through the real command. [DEFINITION-CROSSLANG] [DEFINITION-CROSSLANG-IDENTITY]

const DIRECTIONS = [FSHARP_CLASS_FROM_CSHARP, CSHARP_CLASS_FROM_FSHARP];

/** Wait until the direction answers, so a warm sweep measures navigation, not loading. */
async function warm(spec: CrossLanguageSpec): Promise<void> {
  const use = await openUse(spec);
  await pollUntilResult(
    async () => pressOnce(use, spec, 1_000),
    (moved) => moved,
    SIDECAR_COLD_MS,
    1_000,
    `${spec.name}: the sidecars to load`,
  );
  await closeAllEditors();
}

suite('Cross-language Go To Definition — the first F12 after opening the folder', () => {
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await rebuildAndRestartRealLsp();
  });
  teardown(closeAllEditors);

  for (const spec of DIRECTIONS) {
    test(`${spec.name}: never shows decompiled source while the server loads`, async function () {
      this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
      await closeAllEditors();
      await restartRealLsp();
      const use = await openUse(spec);
      await assertNoAnswerIsDecompiled(use, spec);
      await pressUntilItLands(use, spec);
      await assertRoundTrip(use, spec);
    });
  }
});

suite('Cross-language Go To Definition — every kind of declaration', () => {
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await warm(FSHARP_CLASS_FROM_CSHARP);
    await warm(CSHARP_CLASS_FROM_FSHARP);
  });
  teardown(closeAllEditors);

  for (const spec of CROSS_LANGUAGE_SPECS) {
    test(`${spec.name} lands on the original source`, async function () {
      this.timeout(LSP_RESPONSE_MS * 2);
      const use = await openUse(spec);
      assert.equal(await pressOnce(use, spec, LSP_RESPONSE_MS), true, `${spec.name}: went nowhere`);
      await assertRoundTrip(use, spec);
    });
  }
});

suite('Cross-language Go To Definition — the source being edited', () => {
  teardown(closeAllEditors);

  for (const spec of DIRECTIONS) {
    test(`${spec.name} follows the unsaved declaration`, async function () {
      this.timeout(LSP_RESPONSE_MS * 3);
      const use = await openUse(spec);
      assert.equal(await pressOnce(use, spec, LSP_RESPONSE_MS), true, 'lands before the edit');
      await assertLandedOnOriginalSource(use, spec);
      await moveDeclarationThenPress(use, spec);
    });
  }
});

/** Press until the caret reaches `line`, as the buffer reaches the server asynchronously. */
async function pressUntilOnLine(
  use: Awaited<ReturnType<typeof openUse>>,
  spec: CrossLanguageSpec,
  line: number,
): Promise<number> {
  return pollUntilResult(
    async () => {
      await pressOnce(use, spec, COMMAND_MS);
      return vscode.window.activeTextEditor?.selection.active.line ?? -1;
    },
    (now) => now === line,
    LSP_RESPONSE_MS,
    500,
    `${spec.name}: F12 to follow the unsaved declaration`,
  );
}

/** Push the declaration down three lines, unsaved: F12 must follow it there. */
async function moveDeclarationThenPress(
  use: Awaited<ReturnType<typeof openUse>>,
  spec: CrossLanguageSpec,
): Promise<void> {
  const origin = await vscode.workspace.openTextDocument(workspaceFixturePath(spec.originFile));
  const line = vscode.window.activeTextEditor?.selection.active.line ?? -1;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(origin.uri, new vscode.Position(0, 0), '// moved\n// moved\n// moved\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true, 'the edit applies');
  try {
    assert.equal(origin.isDirty, true, 'the origin holds an unsaved edit');
    const landed = await pressUntilOnLine(use, spec, line + 3);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, origin.uri.fsPath);
    assert.ok(origin.lineAt(landed).text.includes(spec.landsOn), 'on the declared name');
  } finally {
    await revertDocument(origin);
  }
}
