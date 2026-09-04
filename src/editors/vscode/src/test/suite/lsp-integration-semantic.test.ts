// The SEMANTIC tier: completion, definition, references, highlights, inlay
// hints and code actions — everything answered by the Roslyn sidecar.
//
// Spec: [SHARPLSP-ARCHITECTURE-ROUTING] (sidecar, <200ms),
// [SHARPLSP-FEATURES-INTELLIGENCE], [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT],
// [SHARPLSP-FEATURES-NAVIGATION], [SHARPLSP-FEATURES-REFACTORING].
//
// Split out of lsp-integration.test.ts along the routing boundary: the syntax
// tier is answered by tree-sitter in the Rust host and never touches a sidecar,
// so the two halves fail for entirely different reasons and belong in separate
// files.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  loadFixtureSolution,
  openExistingFile,
  openSharpLspPanel,
  pollUntilResult,
  setupLspTestSuite,
  settleForScreenshot,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDocumentSymbols,
} from './test-helpers';
import { assertCompletionEditSpans } from './lsp-invariants-kit';
import { ACTIVATION_MS, LSP_RESPONSE_MS } from './test-timeouts';

/** The caret inside `CompletionShot.cs` that sits after a member-access dot. */
const MEMBER_CARET = new vscode.Position(11, 24);
/** The `Add(...)` call site in the same fixture. */
const ADD_CALL = new vscode.Position(10, 26);
/** The line `Add` is declared on. */
const ADD_DECLARATION_LINE = 6;

suite('LSP Integration — Real Semantic LSP', () => {
  let tmpDir: string;
  let fixtureDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('semantic-');
    tmpDir = result.tmpDir;
    fixtureDir = path.resolve(__dirname, '../../../test-fixtures/workspace');
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('returns Roslyn-backed completion items with concrete symbol kinds', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — the sidecar answers with real Roslyn symbols, each
    // carrying the KIND its completion icon is drawn from. A list of
    // undifferentiated Text items is a tree-sitter word list, not IntelliSense.
    const { uri } = await openExistingFile(fixtureDir, 'CompletionShot.cs');
    await waitForDocumentSymbols(uri);
    const completions = await completionsAt(uri, MEMBER_CARET);
    const items = new Map(completions.items.map((item) => [item.label.toString(), item]));
    assert.strictEqual(items.get('Name')?.kind, vscode.CompletionItemKind.Property);
    assert.strictEqual(items.get('Add')?.kind, vscode.CompletionItemKind.Method);
    assert.strictEqual(items.get('_count')?.kind, vscode.CompletionItemKind.Field);

    // Interaction 2 — [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT]: every
    // item carries an explicit edit span covering the identifier AT the caret.
    // Without one the editor appends after the dot and produces
    // `Console.WriteLineWriteLine` (GitHub #178).
    assertCompletionEditSpans(completions.items, MEMBER_CARET);

    // Interaction 3 — the list is usable: no duplicate labels, no blank ones,
    // and no item that is `Text` when Roslyn knows what it is.
    const labels = completions.items.map((item) => item.label.toString());
    assert.deepStrictEqual([...new Set(labels)], labels, 'a member list must not repeat a member');
    assert.ok(
      labels.every((label) => label.trim().length > 0),
      'every completion item must be labelled',
    );
    assert.strictEqual(
      completions.items.filter((item) => item.kind === vscode.CompletionItemKind.Text).length,
      0,
      'a member-access list carries symbol kinds, never a bare Text fallback',
    );
  });

  test('auto-triggers member completion when `.` is typed', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Passing a trigger character makes VS Code route the request ONLY to
    // providers registered for that character. This stays empty unless the
    // server advertises `.` in completionProvider.triggerCharacters — i.e. it
    // reproduces "press dot, get nothing" end-to-end through the language client.
    const { uri } = await openExistingFile(fixtureDir, 'CompletionShot.cs');
    await waitForDocumentSymbols(uri);
    const triggered = await completionsAt(uri, MEMBER_CARET, '.');
    const labels = new Set(triggered.items.map((item) => item.label.toString()));
    for (const member of ['Add', 'Name', '_count']) {
      assert.ok(
        labels.has(member),
        `Typing \`.\` must auto-trigger member completion incl. ${member}`,
      );
    }

    // Interaction 2 — the dot-triggered list is the SAME list as the invoked
    // one. A trigger character that returns a narrower set means the user gets
    // one answer when typing and a different one on Ctrl-Space.
    const invoked = await completionsAt(uri, MEMBER_CARET);
    const invokedLabels = new Set(invoked.items.map((item) => item.label.toString()));
    for (const member of ['Add', 'Name', '_count']) {
      assert.strictEqual(
        labels.has(member) && invokedLabels.has(member),
        true,
        `${member} must appear whether completion was typed or invoked`,
      );
    }
    assert.ok(labels.size > 0, 'the dot-triggered list must not be empty');

    // Interaction 3 — the triggered items carry the same kinds and the same
    // explicit edit spans, so accepting one after typing `.` does not duplicate
    // the identifier.
    const byLabel = new Map(triggered.items.map((item) => [item.label.toString(), item]));
    assert.strictEqual(byLabel.get('Add')?.kind, vscode.CompletionItemKind.Method);
    assert.strictEqual(byLabel.get('Name')?.kind, vscode.CompletionItemKind.Property);
    assertCompletionEditSpans(triggered.items, MEMBER_CARET);
  });

  test('resolves definition and references for a method call site', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — F12 on the call lands on the declaration, in this file.
    const { uri, doc } = await openExistingFile(fixtureDir, 'CompletionShot.cs');
    await waitForDocumentSymbols(uri);
    const definitions = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          uri,
          ADD_CALL,
        )) ?? [],
      (locations) => locations.length > 0,
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.ok(
      definitions.some(
        (location) =>
          location.uri.toString() === uri.toString() &&
          location.range.start.line === ADD_DECLARATION_LINE,
      ),
      'Add call must resolve to the Add method declaration',
    );
    assert.strictEqual(definitions.length, 1, 'a non-overloaded method has ONE definition');
    assert.ok(
      doc.lineAt(definitions[0]!.range.start.line).text.includes('Add'),
      'and the line it lands on really declares Add',
    );

    // Interaction 2 — Shift-F12 finds the call site AND the declaration.
    // References that omit the declaration make Rename miss the very symbol
    // being renamed.
    const references = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          uri,
          ADD_CALL,
        )) ?? [],
      (locations) => locations.length > 0,
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.ok(
      references.some(
        (location) =>
          location.uri.toString() === uri.toString() && location.range.start.line === ADD_CALL.line,
      ),
      'References must include the Add call site',
    );
    assert.ok(
      references.some((location) => location.range.start.line === ADD_DECLARATION_LINE),
      'and the declaration itself',
    );
    assert.ok(
      references.length >= 2,
      `declaration plus call site at least, got ${references.length}`,
    );

    // Interaction 3 — every location is usable: inside the document, covering
    // the identifier, and never reported twice.
    const seen = new Set<string>();
    for (const location of references) {
      const key = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}`;
      assert.strictEqual(seen.has(key), false, `reference ${key} is reported twice`);
      seen.add(key);
      assert.ok(location.range.start.line < doc.lineCount, `${key} must lie inside the document`);
      assert.strictEqual(
        doc.getText(location.range),
        'Add',
        `${key} must cover the identifier, not the surrounding expression`,
      );
    }
  });

  test('returns document highlights for a semantic symbol occurrence', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — resting on `Add` highlights it.
    const { uri, doc } = await openExistingFile(fixtureDir, 'CompletionShot.cs');
    await waitForDocumentSymbols(uri);
    const highlights = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
          'vscode.executeDocumentHighlights',
          uri,
          ADD_CALL,
        )) ?? [],
      (items) => items.length > 0,
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.ok(
      highlights.every((highlight) => highlight.range.start.line >= 0),
      'Every document highlight must have a valid range',
    );
    assert.ok(
      highlights.length >= 2,
      `declaration and call site at least, got ${highlights.length}`,
    );

    // Interaction 2 — every highlight covers the IDENTIFIER. A highlight
    // spanning the whole invocation paints the arguments as if they were the
    // symbol, which is the visible defect [SHARPLSP-FEATURES-NAVIGATION]
    // scopes to `SymbolFinder` occurrences.
    for (const highlight of highlights) {
      assert.strictEqual(
        doc.getText(highlight.range),
        'Add',
        `highlight at line ${highlight.range.start.line} must cover 'Add' alone`,
      );
      assert.strictEqual(
        highlight.range.start.line,
        highlight.range.end.line,
        'an identifier highlight never straddles a line break',
      );
    }

    // Interaction 3 — the occurrence under the caret is among them, they are
    // all distinct, and both the declaration and the call are covered.
    const lines = highlights.map((highlight) => highlight.range.start.line);
    assert.ok(lines.includes(ADD_CALL.line), 'the occurrence under the caret must be highlighted');
    assert.ok(lines.includes(ADD_DECLARATION_LINE), 'and so must the declaration');
    assert.strictEqual(new Set(lines).size, lines.length, 'no occurrence is highlighted twice');

    // Interaction 4 - highlighting is SYMMETRIC. Resting on the declaration
    // must light up exactly the same occurrences as resting on the call, or
    // the set the user sees depends on where they happened to put the mouse.
    const declarationCaret = new vscode.Position(
      ADD_DECLARATION_LINE,
      doc.lineAt(ADD_DECLARATION_LINE).text.indexOf('Add') + 1,
    );
    const fromDeclaration = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
          'vscode.executeDocumentHighlights',
          uri,
          declarationCaret,
        )) ?? [],
      (items) => items.length > 0,
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.strictEqual(
      fromDeclaration.length,
      highlights.length,
      'the declaration and the call must highlight the same number of occurrences',
    );
    assert.deepStrictEqual(
      fromDeclaration.map((highlight) => highlight.range.start.line).sort((l, r) => l - r),
      [...lines].sort((l, r) => l - r),
      'and the very same lines',
    );
    assert.ok(
      fromDeclaration.every((highlight) => doc.getText(highlight.range) === 'Add'),
      'each of which still covers the identifier alone',
    );
  });

  test('returns parameter-name inlay hints for a real method call', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — the call site gets a hint per argument.
    const { doc, uri } = await openExistingFile(fixtureDir, 'CompletionShot.cs');
    await waitForDocumentSymbols(uri);
    const hints = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.InlayHint[]>(
          'vscode.executeInlayHintProvider',
          uri,
          new vscode.Range(new vscode.Position(0, 0), new vscode.Position(doc.lineCount, 0)),
        )) ?? [],
      (items) => items.length >= 2,
      LSP_RESPONSE_MS,
      2_000,
    );
    const labels = hints.map(inlayHintLabelText).join(' ');
    assert.match(labels, /\ba\b/, 'Inlay hints must include the first parameter name');
    assert.match(labels, /\bb\b/, 'Inlay hints must include the second parameter name');

    // Interaction 2 — each hint is anchored INSIDE the document and reads as a
    // parameter name. A hint placed past the end of a line renders on top of
    // the code it is meant to annotate.
    for (const hint of hints) {
      assert.ok(hint.position.line < doc.lineCount, 'a hint must sit inside the document');
      assert.ok(
        hint.position.character <= doc.lineAt(hint.position.line).text.length,
        `hint on line ${hint.position.line} must sit inside that line`,
      );
      assert.ok(inlayHintLabelText(hint).length > 0, 'a hint must carry visible text');
    }

    // Interaction 3 — the parameter hints for the call sit on the call's line,
    // in argument order, and are tagged as Parameter hints so the editor can
    // style and toggle them independently of type hints.
    const onCall = hints.filter((hint) => hint.position.line === ADD_CALL.line);
    assert.ok(onCall.length >= 2, `the two-argument call takes two hints, got ${onCall.length}`);
    const columns = onCall.map((hint) => hint.position.character);
    assert.deepStrictEqual(
      [...columns].sort((l, r) => l - r),
      columns,
      'hints arrive in argument order',
    );
    assert.ok(
      onCall.every((hint) => hint.kind === vscode.InlayHintKind.Parameter),
      'a parameter-name hint must be tagged Parameter, not Type',
    );
  });
});

// ── Code Actions / Refactoring ────────────────────────────────────

suite('LSP Integration — Code Actions & Refactoring', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('refactor-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('code actions returned for unused variable', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Use a file inside the real workspace fixture project so Roslyn can analyze it.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const content = `namespace RefactorDemo
{
    public class Refactor
    {
        public void Run()
        {
            string unused = "hello";
        }
    }
}`;
    // Interaction 1 — the file is part of TestFixtures.csproj, so Roslyn sees
    // it and reports the unused local.
    const refactorPath = path.join(workspaceRoot, 'Refactor.cs');
    fs.writeFileSync(refactorPath, content, 'utf8');
    const uri = vscode.Uri.file(refactorPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await waitForDocumentSymbols(uri);
    assert.strictEqual(doc.languageId, 'csharp', 'the fixture opens as C#');
    assert.ok(doc.getText().includes('string unused'), 'and really declares the unused local');

    // Interaction 2 — Ctrl-. over the identifier offers actions. An empty list
    // is the "lightbulb never appears" defect [SHARPLSP-FEATURES-REFACTORING]
    // makes a P0.
    const range = new vscode.Range(new vscode.Position(6, 12), new vscode.Position(6, 18));
    const actions = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          uri,
          range,
        )) ?? [],
      (offered) => offered.length > 0,
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.ok(actions.length > 0, 'Must have at least one code action for unused variable');
    assert.strictEqual(doc.getText(range), 'unused', 'the range really covers the identifier');

    // Interaction 3 — every offered action is USABLE: titled, kinded, and
    // carrying either an edit or a command. An action with neither is a
    // lightbulb entry that does nothing when clicked.
    const titles = actions.map((action) => action.title);
    assert.ok(
      titles.every((title) => title.trim().length > 0),
      'every offered action must be titled',
    );
    assert.deepStrictEqual([...new Set(titles)], titles, 'and no title may be offered twice');
    for (const action of actions) {
      assert.ok(action.kind, `'${action.title}' must declare a CodeActionKind`);
      assert.ok(
        action.edit !== undefined || action.command !== undefined,
        `'${action.title}' must carry an edit or a command, or clicking it does nothing`,
      );
    }

    // Interaction 4 — one of them removes the unused local. That is the fix
    // the diagnostic asks for, and the reason the lightbulb appeared at all.
    assert.ok(
      actions.some((action) => /unused|remove/i.test(action.title)),
      `an unused local must offer its removal; offered: ${titles.join(' | ')}`,
    );

    // Load fixture solution so SharpLsp panel shows Solution Explorer.
    if (process.env['SHARPLSP_SCREENSHOTS']) {
      await loadFixtureSolution(workspaceRoot);
    }
    await openSharpLspPanel();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });

    // Trigger the lightbulb in the editor so it's visible in the screenshot.
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'Must have active editor');
    editor.selection = new vscode.Selection(new vscode.Position(6, 18), new vscode.Position(6, 18));
    editor.revealRange(new vscode.Range(new vscode.Position(6, 18), new vscode.Position(6, 18)));
    await vscode.commands.executeCommand('editor.action.quickFix');
    await settleForScreenshot(2000);
    await takeScreenshot('vscode-refactoring.png');
  });
});

// ── Helpers ──────────────────────────────────────────────────────

/** Completions at a caret, polled until the sidecar has really answered. */
async function completionsAt(
  uri: vscode.Uri,
  caret: vscode.Position,
  trigger?: string,
): Promise<vscode.CompletionList> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        caret,
        trigger,
      );
      return result ?? new vscode.CompletionList();
    },
    (list) => list.items.some((item) => item.label.toString() === 'Add'),
    LSP_RESPONSE_MS,
    2_000,
  );
}

function inlayHintLabelText(hint: vscode.InlayHint): string {
  if (typeof hint.label === 'string') {
    return hint.label;
  }
  return hint.label.map((part) => part.value).join('');
}
