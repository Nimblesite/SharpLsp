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
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  openCSharpFile,
  openExistingFile,
  pollUntilResult,
  waitForDocumentSymbols,
  pollProvider,
  assertContainsAll,
} from './test-helpers';
import { assertCompletionEditSpans } from './lsp-invariants-kit';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { inlayHintLabel, useLspTestSuite } from './lsp-suite-kit';
import { assertShotMembers, MEMBER_CARET } from './completion-shot-kit';

/** The `Add(...)` call site in the same fixture. */
const ADD_CALL = new vscode.Position(10, 26);
/** The line `Add` is declared on. */
const ADD_DECLARATION_LINE = 6;

suite('LSP Integration — Real Semantic LSP', () => {
  useLspTestSuite('semantic-');
  const fixtureDir = path.resolve(__dirname, '../../../test-fixtures/workspace');

  test('returns Roslyn-backed completion items with concrete symbol kinds', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — the sidecar answers with real Roslyn symbols, each
    // carrying the KIND its completion icon is drawn from. A list of
    // undifferentiated Text items is a tree-sitter word list, not IntelliSense.
    const { uri } = await openCompletionShot(fixtureDir);
    const completions = await completionsAt(uri, MEMBER_CARET);
    assertShotMembers(completions);

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
    const { uri } = await openCompletionShot(fixtureDir);
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
      assert.ok(
        labels.has(member) && invokedLabels.has(member),
        `${member} must appear whether completion was typed or invoked`,
      );
    }
    assert.ok(labels.size > 0, 'the dot-triggered list must not be empty');

    // Interaction 3 — the triggered items carry the same kinds and the same
    // explicit edit spans, so accepting one after typing `.` does not duplicate
    // the identifier.
    assertShotMembers(triggered);
    assertCompletionEditSpans(triggered.items, MEMBER_CARET);
  });

  test('resolves definition and references for a method call site', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — F12 on the call lands on the declaration, in this file.
    const { uri, doc } = await openCompletionShot(fixtureDir);
    const definitions = await pollAtCall<vscode.Location>('vscode.executeDefinitionProvider', uri);
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
    const references = await pollAtCall<vscode.Location>('vscode.executeReferenceProvider', uri);
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
      assert.ok(!seen.has(key), `reference ${key} is reported twice`);
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
    const { uri, doc } = await openCompletionShot(fixtureDir);
    const highlights = await pollAtCall<vscode.DocumentHighlight>(
      'vscode.executeDocumentHighlights',
      uri,
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
    assertContainsAll(lines, [ADD_CALL.line, ADD_DECLARATION_LINE], 'lines');
    assert.strictEqual(new Set(lines).size, lines.length, 'no occurrence is highlighted twice');

    // Interaction 4 - highlighting is SYMMETRIC. Resting on the declaration
    // must light up exactly the same occurrences as resting on the call, or
    // the set the user sees depends on where they happened to put the mouse.
    const declarationCaret = new vscode.Position(
      ADD_DECLARATION_LINE,
      doc.lineAt(ADD_DECLARATION_LINE).text.indexOf('Add') + 1,
    );
    const fromDeclaration = await pollProvider<vscode.DocumentHighlight>(
      'vscode.executeDocumentHighlights',
      [uri, declarationCaret],
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
    const { doc, uri } = await openCompletionShot(fixtureDir);
    const hints = await pollProvider<vscode.InlayHint>(
      'vscode.executeInlayHintProvider',
      [uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(doc.lineCount, 0))],
      (items) => items.length >= 2,
      LSP_RESPONSE_MS,
      2_000,
    );
    const labels = hints.map(inlayHintLabel).join(' ');
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
      assert.ok(inlayHintLabel(hint).length > 0, 'a hint must carry visible text');
    }

    // Interaction 3 — the parameter hints for the call sit on the call's line,
    // in argument order, and are tagged as Parameter hints so the editor can
    // style and toggle them independently of type hints.
    const onCall = hints.filter((hint) => hint.position.line === ADD_CALL.line);
    const parameters = onCall.filter((hint) => hint.kind === vscode.InlayHintKind.Parameter);
    assert.ok(
      parameters.length >= 2,
      `the two-argument call takes two parameter hints, got ${parameters.length}`,
    );
    const columns = parameters.map((hint) => hint.position.character);
    assert.deepStrictEqual(
      [...columns].sort((l, r) => l - r),
      columns,
      'hints arrive in argument order',
    );
    assert.ok(
      parameters.every((hint) => inlayHintLabel(hint).trimEnd().endsWith(':')),
      'a parameter-name hint renders as `name:`',
    );
    // `var total` earns an inferred-TYPE hint on the same line; that is the
    // only other kind allowed there, and it must be tagged so it can be toggled
    // independently of the parameter names.
    assert.ok(
      onCall.every(
        (hint) =>
          hint.kind === vscode.InlayHintKind.Parameter || hint.kind === vscode.InlayHintKind.Type,
      ),
      'every hint on the call line is a Parameter or the `var` Type hint, never untagged',
    );
  });
});

// ── Code Actions / Refactoring ────────────────────────────────────

suite('LSP Integration — Code Actions & Refactoring', () => {
  useLspTestSuite('refactor-');

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
    const { doc, uri } = await openCSharpFile(workspaceRoot, 'Refactor.cs', content);
    await waitForDocumentSymbols(uri);
    assert.strictEqual(doc.languageId, 'csharp', 'the fixture opens as C#');
    assert.ok(doc.getText().includes('string unused'), 'and really declares the unused local');

    // Interaction 2 — Ctrl-. over the identifier offers actions. An empty list
    // is the "lightbulb never appears" defect [SHARPLSP-FEATURES-REFACTORING]
    // makes a P0.
    const range = new vscode.Range(new vscode.Position(6, 19), new vscode.Position(6, 25));
    const actions = await pollCodeActions(uri, range);
    assert.ok(actions.length > 0, 'Must have at least one code action for unused variable');
    assert.strictEqual(doc.getText(range), 'unused', 'the range really covers the identifier');

    // Interaction 3 — every offered action is USABLE: titled, kinded, and
    // resolving to an edit or a command. An action that resolves to neither is
    // a lightbulb entry that does nothing when clicked.
    //
    // The edit is asked for SEPARATELY because the server advertises
    // `codeAction/resolve` ([SHARPLSP-FEATURES-REFACTORING]): LSP 3.17 lets it
    // list actions without edits and fill them in when the user picks one, so
    // an unresolved action having no `edit` is the contract working. VS Code
    // resolves only as many as `itemResolveCount` asks it to.
    const resolved =
      (await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        range,
        undefined,
        actions.length,
      )) ?? [];
    assert.strictEqual(
      resolved.length,
      actions.length,
      'resolving must not change WHICH actions are offered',
    );
    for (const action of resolved) {
      assert.ok(
        action.edit !== undefined || action.command !== undefined,
        `'${action.title}' must RESOLVE to an edit or a command, or clicking it does nothing`,
      );
    }
    const titles = actions.map((action) => action.title);
    assert.ok(
      titles.every((title) => title.trim().length > 0),
      'every offered action must be titled',
    );
    assert.deepStrictEqual([...new Set(titles)], titles, 'and no title may be offered twice');
    for (const action of actions) {
      assert.ok(action.kind, `'${action.title}' must declare a CodeActionKind`);
    }

    // Interaction 4 — one of them removes the unused local. That is the fix
    // the diagnostic asks for, and the reason the lightbulb appeared at all.
    assert.ok(
      actions.some((action) => /unused|remove/i.test(action.title)),
      `an unused local must offer its removal; offered: ${titles.join(' | ')}`,
    );
  });
});

// ── Helpers ──────────────────────────────────────────────────────

/** Open the `CompletionShot.cs` fixture and wait for the symbols Roslyn reports. */
async function openCompletionShot(
  fixtureDir: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  const opened = await openExistingFile(fixtureDir, 'CompletionShot.cs');
  await waitForDocumentSymbols(opened.uri);
  return opened;
}

/** Poll the code-action provider until it offers at least one action. */
async function pollCodeActions(uri: vscode.Uri, range: vscode.Range): Promise<vscode.CodeAction[]> {
  return pollProvider<vscode.CodeAction>(
    'vscode.executeCodeActionProvider',
    [uri, range],
    (offered) => offered.length > 0,
    LSP_RESPONSE_MS,
    2_000,
  );
}

/** Poll `providerId` at the `Add` call site until it reports at least one item. */
async function pollAtCall<T>(providerId: string, uri: vscode.Uri): Promise<T[]> {
  return pollProvider<T>(
    providerId,
    [uri, ADD_CALL],
    (items) => items.length > 0,
    LSP_RESPONSE_MS,
    2_000,
  );
}

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
