import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForDocumentSymbols, assertContainsAll, requireWorkspaceRoot } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { assertShotMembers, MEMBER_CARET } from './completion-shot-kit';
import { useLspTestSuite } from './lsp-suite-kit';

suite('Visible Completions', () => {
  useLspTestSuite('visible-completions-');

  test('screenshot completion site offers real instance members', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const filePath = path.join(requireWorkspaceRoot(), 'CompletionShot.cs');
    assert.ok(fs.existsSync(filePath), 'CompletionShot.cs fixture must exist');
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await waitForDocumentSymbols(uri);

    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      MEMBER_CARET,
    );

    assert.ok(completions, 'Member-access completion request must return a completion list');
    assert.ok(
      completions.items.length >= 3,
      `Member-access completion list must contain several items, got ${completions.items.length.toString()}`,
    );

    const labels = new Set(assertShotMembers(completions).keys());
    assertContainsAll(labels, ['Name', 'Add', '_count'], 'Visible completion site must offer');
    assert.ok(
      !labels.has('No suggestions.'),
      'Completion labels must contain real symbols, not the empty-widget text',
    );

    const declarationPosition = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      new vscode.Position(6, 22),
    );
    assert.notDeepStrictEqual(
      (declarationPosition?.items ?? []).map((item) => item.label.toString()).sort(),
      [...labels].sort(),
      'Screenshot completion site must not be the old method-declaration position',
    );
  });
});
