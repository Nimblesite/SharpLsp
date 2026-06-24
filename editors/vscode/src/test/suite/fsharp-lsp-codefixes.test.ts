import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import {
  FSHARP_COLD_TIMEOUT_MS,
  fsharpFixturePath,
  openFSharpFixture,
  positionOf,
} from './fsharp-helpers';

/**
 * End-to-end coverage for the F# analyzer-backed code fixes (FSAC parity) against
 * the REAL release LSP + FCS sidecar:
 *   - "Remove unused open"  (SLSPF0102 → deletes the `open` line)
 *   - "Simplify name"       (SLSPF0103 → strips the redundant qualifier prefix)
 *
 * `CodeFixes.fs` is a dedicated fixture (an unused `open System.Text` plus a
 * redundantly-qualified `System.DateTime`). Each test drives several real user
 * interactions (open → request code actions → inspect the resolved edit → apply →
 * re-inspect) with many assertions per interaction. The fixture is snapshotted and
 * restored on disk in teardown; edits are applied in-memory only.
 */

const CODEFIX_FILE = 'CodeFixes.fs';
const ORIGINAL = fs.readFileSync(fsharpFixturePath(CODEFIX_FILE), 'utf8');

function restoreFixture(): void {
  fs.writeFileSync(fsharpFixturePath(CODEFIX_FILE), ORIGINAL, 'utf8');
}

/** Revert any in-memory edits so disk and the editor model agree for the next test. */
async function revertDirtyEditors(): Promise<void> {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.isDirty) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }
}

/** Extract a diagnostic's code as a plain string (handles string | number | object). */
function codeOf(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (code === undefined || code === null) {
    return '';
  }
  if (typeof code === 'object') {
    return String((code as { value: string | number }).value);
  }
  return String(code);
}

/**
 * Poll the code-action provider with `itemResolveCount` set so the returned
 * actions carry their resolved `edit` (the LSP server defers edits to
 * `codeAction/resolve`).
 *
 * A slow first request (cold FCS start; the interface-stub analysis is async)
 * can exceed the poll interval, so the next poll cancels the in-flight request
 * and `executeCodeActionProvider` rejects with "Canceled". That is a harness
 * race, not a failure — swallow it and let the next (warm) poll succeed.
 */
async function resolvedQuickFixes(
  uri: vscode.Uri,
  range: vscode.Range,
  predicate: (actions: vscode.CodeAction[]) => boolean,
): Promise<vscode.CodeAction[]> {
  return pollUntilResult(
    async () => {
      try {
        return (
          (await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            uri,
            range,
            vscode.CodeActionKind.QuickFix.value,
            40,
          )) ?? []
        );
      } catch {
        return [];
      }
    },
    predicate,
    FSHARP_COLD_TIMEOUT_MS,
    3_000,
  );
}

suite('F# LSP — Code Fixes (FSAC parity)', () => {
  suiteTeardown(async () => {
    restoreFixture();
    await revertDirtyEditors();
    await closeAllEditors();
  });

  teardown(async () => {
    restoreFixture();
    await revertDirtyEditors();
    await closeAllEditors();
  });

  test('"Remove unused open" is offered, resolves to an edit, and deletes the open line', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);

    // Interaction 1 — open the fixture and request quick fixes on the unused open.
    const { doc, uri } = await openFSharpFixture(CODEFIX_FILE);
    const openLine = positionOf(doc, 'open System.Text').line;
    const lineRange = doc.lineAt(openLine).range;

    const actions = await resolvedQuickFixes(uri, lineRange, (acts) =>
      acts.some((a) => a.title === 'Remove unused open'),
    );

    // Assertions on the offered action.
    const remove = actions.find((a) => a.title === 'Remove unused open');
    assert.ok(remove, 'a "Remove unused open" quick fix must be offered on the unused open');
    assert.strictEqual(
      remove?.kind?.value,
      vscode.CodeActionKind.QuickFix.value,
      'the action must be a QuickFix',
    );
    assert.ok(remove?.edit, 'the action must resolve to a WorkspaceEdit (codeAction/resolve)');

    // Assertions on the resolved edit shape — one deletion spanning the whole line.
    const edits = remove.edit.get(uri);
    assert.strictEqual(edits.length, 1, 'remove-unused-open must be a single text edit');
    assert.strictEqual(edits[0]?.newText, '', 'the edit must be a deletion (empty new text)');
    assert.strictEqual(edits[0]?.range.start.line, openLine, 'deletion starts on the open line');
    assert.strictEqual(edits[0]?.range.start.character, 0, 'deletion starts at column 0');
    assert.strictEqual(
      edits[0]?.range.end.line,
      openLine + 1,
      'deletion ends at the start of the next line (removes the whole line)',
    );

    // Interaction 2 — apply the fix and assert the document transformation.
    assert.ok(doc.getText().includes('open System.Text'), 'precondition: the unused open exists');
    const applied = await vscode.workspace.applyEdit(remove.edit);
    assert.ok(applied, 'applyEdit must succeed');

    const after = doc.getText();
    assert.ok(!after.includes('open System.Text'), 'the unused open must be removed');
    assert.ok(after.includes('open System\n'), 'the still-used `open System` must remain');
    assert.ok(after.includes('DateTime.Now'), 'unrelated code must be untouched');
  });

  test('"Simplify name" is offered, resolves to an edit, and strips the redundant qualifier', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);

    // Interaction 1 — open and request quick fixes on the redundantly-qualified name.
    const { doc, uri } = await openFSharpFixture(CODEFIX_FILE);
    const namePos = positionOf(doc, 'System.DateTime.MinValue');
    const nameRange = new vscode.Range(namePos, namePos.translate(0, 'System.DateTime'.length));

    const actions = await resolvedQuickFixes(uri, nameRange, (acts) =>
      acts.some((a) => a.title === 'Simplify name'),
    );

    const simplify = actions.find((a) => a.title === 'Simplify name');
    assert.ok(simplify, 'a "Simplify name" quick fix must be offered on the redundant qualifier');
    assert.strictEqual(simplify?.kind?.value, vscode.CodeActionKind.QuickFix.value);
    assert.ok(simplify?.edit, 'the action must resolve to a WorkspaceEdit');

    // The resolved edit deletes exactly the redundant `System.` prefix.
    const edits = simplify.edit.get(uri);
    assert.strictEqual(edits.length, 1, 'simplify-name must be a single text edit');
    assert.strictEqual(edits[0]?.newText, '', 'the edit must delete the redundant prefix');
    assert.strictEqual(
      doc.getText(edits[0].range),
      'System.',
      'the deleted span must be exactly the redundant `System.` qualifier',
    );

    // Interaction 2 — apply the fix and assert the simplification.
    assert.ok(doc.getText().includes('System.DateTime.MinValue'), 'precondition holds');
    await vscode.workspace.applyEdit(simplify.edit);
    const after = doc.getText();
    assert.ok(
      after.includes('let minimum = DateTime.MinValue'),
      'name must simplify to DateTime.MinValue',
    );
    assert.ok(
      !after.includes('System.DateTime.MinValue'),
      'the redundant System. qualifier must be gone',
    );
  });

  test('the analyzer hints (SLSPF0102 unused open, SLSPF0103 simplify) surface as diagnostics', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);

    // Interaction — open the fixture and wait for both analyzer hints to publish.
    const { doc, uri } = await openFSharpFixture(CODEFIX_FILE);
    const diagnostics = await pollUntilResult(
      async () => vscode.languages.getDiagnostics(uri),
      (diags) =>
        diags.some((d) => codeOf(d) === 'SLSPF0102') &&
        diags.some((d) => codeOf(d) === 'SLSPF0103'),
      FSHARP_COLD_TIMEOUT_MS,
      2_000,
    );

    const unusedOpen = diagnostics.filter((d) => codeOf(d) === 'SLSPF0102');
    const simplify = diagnostics.filter((d) => codeOf(d) === 'SLSPF0103');

    assert.ok(unusedOpen.length >= 1, 'the unused-open hint (SLSPF0102) must be reported');
    assert.ok(simplify.length >= 1, 'the simplify-name hint (SLSPF0103) must be reported');
    assert.ok(
      unusedOpen.every((d) => d.severity === vscode.DiagnosticSeverity.Hint),
      'unused-open findings must be Hint severity',
    );
    assert.ok(
      simplify.every((d) => d.severity === vscode.DiagnosticSeverity.Hint),
      'simplify-name findings must be Hint severity',
    );

    // The unused-open hint must point at the `open System.Text` line.
    const openLine = positionOf(doc, 'open System.Text').line;
    assert.ok(
      unusedOpen.some((d) => d.range.start.line === openLine),
      'the unused-open hint must mark the `open System.Text` line',
    );
  });
});

/**
 * "Implement interface" — completes the F# stub-generation trio (union / record /
 * interface) via FCS `InterfaceStubGenerator` ([FS-CODEFIX-INTERFACESTUB]).
 * `Implement.fs` declares `interface IShape` on `Square` without implementing any
 * member; the quick fix generates stubs for `Area` and `Name`.
 */
const IMPL_FILE = 'Implement.fs';
const IMPL_ORIGINAL = fs.readFileSync(fsharpFixturePath(IMPL_FILE), 'utf8');

function restoreImplFixture(): void {
  fs.writeFileSync(fsharpFixturePath(IMPL_FILE), IMPL_ORIGINAL, 'utf8');
}

suite('F# LSP — Implement Interface (FSAC parity)', () => {
  suiteTeardown(async () => {
    restoreImplFixture();
    await revertDirtyEditors();
    await closeAllEditors();
  });

  teardown(async () => {
    restoreImplFixture();
    await revertDirtyEditors();
    await closeAllEditors();
  });

  test('"Implement interface" generates stubs for the unimplemented members', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);

    // Interaction 1 — open the fixture and request quick fixes on the interface.
    const { doc, uri } = await openFSharpFixture(IMPL_FILE);
    const ifacePos = positionOf(doc, 'interface IShape', 'interface '.length);
    const range = new vscode.Range(ifacePos, ifacePos.translate(0, 'IShape'.length));

    const actions = await resolvedQuickFixes(uri, range, (acts) =>
      acts.some((a) => a.title === 'Implement interface'),
    );

    const impl = actions.find((a) => a.title === 'Implement interface');
    assert.ok(impl, 'must offer an "Implement interface" quick fix on the unimplemented interface');
    assert.strictEqual(impl?.kind?.value, vscode.CodeActionKind.QuickFix.value);
    assert.ok(impl?.edit, 'the action must resolve to a WorkspaceEdit');

    // The resolved edit must generate stubs covering both interface members.
    const edits = impl.edit.get(uri);
    assert.strictEqual(edits.length, 1, 'implement-interface must be a single insertion');
    assert.match(edits[0]?.newText ?? '', /member/, 'the stub must contain member declarations');
    assert.match(edits[0]?.newText ?? '', /Area/, 'the stub must implement Area');
    assert.match(edits[0]?.newText ?? '', /Name/, 'the stub must implement Name');

    // Interaction 2 — apply the fix and assert the document gains both members.
    const before = doc.getText();
    await vscode.workspace.applyEdit(impl.edit);
    const after = doc.getText();
    assert.ok(after.length > before.length, 'applying the stub must add text');
    assert.ok(
      after.includes('Area') && after.includes('Name') && after.includes('member'),
      'the document must now contain stub implementations for both members',
    );
  });
});
