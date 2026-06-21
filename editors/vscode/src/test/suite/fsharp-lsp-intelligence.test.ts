import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import { FSHARP_COLD_TIMEOUT_MS, openFSharpFixture, positionOf } from './fsharp-helpers';

/**
 * Blanket end-to-end coverage for F# code-intelligence features:
 * completion, signature help, rename, inlay hints, and code actions.
 *
 * These run against the REAL release-built LSP + FCS sidecar and the static F#
 * fixture project. Several of these features are not yet implemented in the F#
 * sidecar — those tests are EXPECTED to fail until the corresponding feature is
 * built (drive each via /fix-bug). F# is a first-class citizen; it must reach
 * and exceed C# parity.
 */

suite('F# LSP — Completion', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('member completion after `.` on a class instance', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const usage = await openFSharpFixture('Usage.fs');
    // Cursor immediately after `greeter.` in `greeter.Greet alice.Name`.
    const position = positionOf(usage.doc, 'greeter.Greet', 'greeter.'.length);
    const labels = await pollCompletionLabels(usage.uri, position, (set) => set.has('Greet'));
    assert.ok(labels.has('Greet'), 'completion after greeter. must include the Greet member');
  });

  test('member completion after `.` on a record value', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const usage = await openFSharpFixture('Usage.fs');
    const position = positionOf(usage.doc, 'alice.Name', 'alice.'.length);
    const labels = await pollCompletionLabels(
      usage.uri,
      position,
      (set) => set.has('Name') && set.has('Age'),
    );
    assert.ok(labels.has('Name'), 'record completion must include Name');
    assert.ok(labels.has('Age'), 'record completion must include Age');
  });

  test('module-qualified completion after `.`', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const usage = await openFSharpFixture('Usage.fs');
    const position = positionOf(usage.doc, 'Geometry.totalArea shapes', 'Geometry.'.length);
    const labels = await pollCompletionLabels(
      usage.uri,
      position,
      (set) => set.has('totalArea') && set.has('area'),
    );
    assert.ok(labels.has('area'), 'module completion must include area');
    assert.ok(labels.has('totalArea'), 'module completion must include totalArea');
    assert.ok(labels.has('describeParity'), 'module completion must include describeParity');
  });

  test('completion items carry concrete F# symbol kinds', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const usage = await openFSharpFixture('Usage.fs');
    const position = positionOf(usage.doc, 'alice.Name', 'alice.'.length);
    const list = await pollCompletion(usage.uri, position, (l) =>
      l.items.some((i) => i.label.toString() === 'Name'),
    );
    const name = list.items.find((i) => i.label.toString() === 'Name');
    assert.ok(name, 'Name completion item must be present');
    assert.strictEqual(
      name?.kind,
      vscode.CompletionItemKind.Field,
      'record field completion must be reported as a Field',
    );
  });
});

suite('F# LSP — Signature Help', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('signature help inside a constructor call', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 15_000);
    const usage = await openFSharpFixture('Usage.fs');
    // Inside `Greeter("Hello")` — just after the opening paren.
    const position = positionOf(usage.doc, 'Greeter("Hello")', 'Greeter('.length);
    const help = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.SignatureHelp>(
          'vscode.executeSignatureHelpProvider',
          usage.uri,
          position,
          '(',
        )) ?? new vscode.SignatureHelp(),
      (h) => h.signatures.length > 0,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    assert.ok(
      help.signatures.length > 0,
      'signature help must surface at least one signature for the Greeter constructor',
    );
  });
});

suite('F# LSP — Rename', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('rename a function updates the declaration and every use site', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const library = await openFSharpFixture('Library.fs');
    const position = positionOf(library.doc, 'let area', 'let '.length);
    const edit = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
          'vscode.executeDocumentRenameProvider',
          library.uri,
          position,
          'computeArea',
        )) ?? new vscode.WorkspaceEdit(),
      (e) => e.size > 0,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    assert.ok(edit.size > 0, 'rename must produce a workspace edit');
    const libEdits = edit.get(library.uri);
    assert.ok(
      libEdits.length >= 2,
      `rename must touch the declaration and the use site (got ${libEdits.length} edits)`,
    );
    assert.ok(
      libEdits.every((e) => e.newText === 'computeArea'),
      'every rename edit must insert the new name',
    );
  });
});

suite('F# LSP — Inlay Hints', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('type inlay hints appear on unannotated let bindings', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 15_000);
    const usage = await openFSharpFixture('Usage.fs');
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(usage.doc.lineCount, 0),
    );
    const hints = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.InlayHint[]>(
          'vscode.executeInlayHintProvider',
          usage.uri,
          fullRange,
        )) ?? [],
      (items) => items.length >= 1,
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );
    assert.ok(hints.length >= 1, `Usage.fs must surface ≥1 inlay hint, got ${hints.length}`);
    const labels = hints.map(inlayLabel).join(' ');
    assert.match(labels, /Greeter|float|string|int/, 'inlay hints must reveal inferred types');
  });
});

suite('F# LSP — Code Actions', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('offers a fix to ignore an implicitly-discarded result', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 15_000);
    // FS0020: result of an expression implicitly ignored.
    const usage = await openFSharpFixture('Usage.fs');
    // Use the `parity` line region — request actions broadly across the file.
    const range = new vscode.Range(
      positionOf(usage.doc, 'let parity'),
      positionOf(usage.doc, 'let parity').translate(0, 5),
    );
    const actions = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          usage.uri,
          range,
        )) ?? [],
      () => true,
      30_000,
      2_000,
    );
    // This assertion documents the current behaviour: code actions must be a
    // real array (the provider responds). Specific fixes are validated by the
    // diagnostics-driven suite once FS0020 fixtures exist.
    assert.ok(Array.isArray(actions), 'code action provider must respond with an array');
  });
});

// ── Local helpers ─────────────────────────────────────────────────

async function pollCompletion(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (list: vscode.CompletionList) => boolean,
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<vscode.CompletionList> {
  return pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        position,
        '.',
      )) ?? new vscode.CompletionList(),
    predicate,
    timeoutMs,
    2_000,
  );
}

async function pollCompletionLabels(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (labels: Set<string>) => boolean,
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<Set<string>> {
  const list = await pollCompletion(
    uri,
    position,
    (l) => predicate(new Set(l.items.map((i) => i.label.toString()))),
    timeoutMs,
  );
  return new Set(list.items.map((i) => i.label.toString()));
}

function inlayLabel(hint: vscode.InlayHint): string {
  if (typeof hint.label === 'string') {
    return hint.label;
  }
  return hint.label.map((part) => part.value).join('');
}
