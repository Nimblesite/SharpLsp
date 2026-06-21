import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import { FSHARP_COLD_TIMEOUT_MS, openFSharpFixture, positionOf } from './fsharp-helpers';

/**
 * Blanket end-to-end coverage for F# code lens and call hierarchy.
 *
 * Neither is implemented in the F# sidecar yet, so these tests are EXPECTED to
 * fail until the handlers are built (drive via /fix-bug). C# has both; F# must
 * match and exceed.
 */

suite('F# LSP — Code Lens', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('provides reference-count lenses on F# declarations', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const library = await openFSharpFixture('Library.fs');
    const lenses = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          library.uri,
        )) ?? [],
      (items) => items.length >= 1,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    assert.ok(lenses.length >= 1, `Library.fs must expose ≥1 code lens, got ${lenses.length}`);
  });
});

suite('F# LSP — Call Hierarchy', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('prepares a call hierarchy item and resolves incoming calls', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const usage = await openFSharpFixture('Usage.fs');
    const position = positionOf(usage.doc, 'let double (value', 'let '.length);
    const items = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy',
          usage.uri,
          position,
        )) ?? [],
      (list) => list.length > 0,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    assert.ok(items.length > 0, 'call hierarchy must prepare an item for the double function');

    const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      'vscode.provideIncomingCalls',
      items[0],
    );
    assert.ok((incoming ?? []).length >= 1, 'double must have ≥1 incoming call (from quadruple)');
  });
});
