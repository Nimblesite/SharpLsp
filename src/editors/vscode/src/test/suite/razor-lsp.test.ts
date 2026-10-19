// End-to-end tests for Razor in VS Code ([RAZOR-EDITORS], [RAZOR-FEATURES-HTML]), over
// the real Razor fixture solution ([RAZOR-TESTING]). The extension activates on and
// syncs Razor documents; the C# sidecar answers the C# inside them; and markup gets
// the built-in HTML service's completion and hover over the server's HTML projection
// (`sharplsp/razor/htmlProjection`, [RAZOR-ARCHITECTURE-HTML]).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DOCUMENT_SELECTOR } from '../../client.js';
import { completionList, hoverText } from './filebased-package-kit';
import { openRepoFile, positionOf } from './real-repo-helpers';
import { completionLabels } from './real-repo-kit';
import { htmlProjection, RAZOR_FILES, useRazorFixture } from './razor-kit';
import { packageJson } from './run-debug-kit';
import { closeAllEditors, pollProvider, waitForHoverResult } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/** The C# expression the Counter page shows, and the field it reads. */
const COUNT: readonly [string, string] = ['Current count: @currentCount', 'currentCount'];

/** Hover text at `position`, once it satisfies `until`. */
async function hoverWhen(
  uri: vscode.Uri,
  position: vscode.Position,
  until: (text: string) => boolean,
): Promise<string> {
  const hovers = await pollProvider<vscode.Hover>(
    'vscode.executeHoverProvider',
    [uri, position],
    (reply) => until(hoverText(reply)),
  );
  return hoverText(hovers);
}

suite('Razor in VS Code', () => {
  const fixture = useRazorFixture();

  teardown(async () => {
    await closeAllEditors();
  });

  test('a Razor file opens as Razor, and its unsaved edits reach the server', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    // Interaction 1 — the manifest activates on Razor, and the client syncs both of
    // Razor's language ids: VS Code's own and the C# extension's.
    const events: string[] = packageJson().activationEvents ?? [];
    assert.ok(events.includes('onLanguage:razor'), 'activates on Razor');
    const synced = DOCUMENT_SELECTOR.filter((entry) => entry.scheme === 'file').map(
      (entry) => entry.language,
    );
    assert.ok(synced.includes('razor'), 'syncs VS Code’s razor documents');
    assert.ok(synced.includes('aspnetcorerazor'), 'syncs the C# extension’s Razor documents');

    // Interaction 2 — a component opens as Razor, and the C# sidecar answers the
    // C# inside it at the Razor position.
    const { doc, uri } = await openRepoFile(fixture().root, RAZOR_FILES.counter);
    assert.equal(doc.languageId, 'razor', 'a .razor file is VS Code’s razor language');
    const hover = hoverText(await waitForHoverResult(uri, positionOf(doc, ...COUNT)));
    assert.match(hover, /\bint\b/, 'the field’s C# type');
    assert.match(hover, /currentCount/, 'the field’s name');

    // Interaction 3 — an unsaved line above moves the field down one line: the
    // server's hover and projection both follow the editor's text.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(6, 0), '<p>Edited</p>\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit applies');
    const moved = positionOf(doc, ...COUNT);
    assert.equal(moved.line, 8, 'the field moved down a line');
    assert.match(await hoverWhen(uri, moved, (text) => text.includes('currentCount')), /\bint\b/);
    const projection = (await htmlProjection(uri)) ?? '';
    assert.ok(projection.includes('<p>Edited</p>'), 'the projection holds the unsaved line');
    assert.equal(projection.length, doc.getText().length, 'and the unsaved length');
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('the server projects Razor as HTML of the same shape', async function () {
    this.timeout(LSP_RESPONSE_MS * 2);
    const { doc, uri } = await openRepoFile(fixture().root, RAZOR_FILES.counter);
    const text = doc.getText();
    const projection = await htmlProjection(uri);
    assert.ok(projection !== undefined, 'a listed Razor file has an HTML projection');

    // Interaction 1 — every offset and line break is where the Razor file has it,
    // so a Razor position is the same position in the projection.
    assert.equal(projection.length, text.length, 'the same UTF-16 length');
    assert.deepEqual(
      projection.split('\n').map((line) => line.length),
      text.split('\n').map((line) => line.length),
    );

    // Interaction 2 — markup stays, at its own offset.
    const heading = text.indexOf('<h1>Counter</h1>');
    assert.ok(heading > 0, 'the fixture has its heading');
    assert.equal(projection.indexOf('<h1>Counter</h1>'), heading, 'markup keeps its offset');
    assert.ok(projection.includes('<p role="status">Current count: '), 'markup around C# stays');

    // Interaction 3 — C# is blanked: the implicit expression and the @code block.
    const count = text.indexOf(COUNT[0]) + 'Current count: '.length;
    assert.equal(
      projection.slice(count, count + '@currentCount'.length).trim(),
      '',
      'an expression',
    );
    assert.ok(!projection.includes('currentCount++'), 'a @code statement');
    assert.ok(!projection.includes('private int'), 'a @code field');
  });

  test('markup completes from the HTML service, and C# from the server', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    const { doc, uri } = await openRepoFile(fixture().root, RAZOR_FILES.counter);

    // Interaction 1 — in a tag name, the HTML service's element names arrive through
    // the projection, and no C# member does.
    const tag = completionLabels(
      await completionList(uri, positionOf(doc, '<h1>Counter', 'h1'), 'div'),
    );
    for (const element of ['div', 'span', 'h1']) assert.ok(tag.has(element), `offers <${element}>`);
    assert.ok(!tag.has('currentCount'), 'markup offers no C# member');

    // Interaction 2 — in @code, the server's C# members answer, and the HTML
    // service adds no element name: the projection blanks the C#.
    const code = completionLabels(
      await completionList(uri, positionOf(doc, 'currentCount++;', 'currentCount'), 'currentCount'),
    );
    assert.ok(code.has('currentCount'), 'the field');
    assert.ok(code.has('IncrementCount'), 'the method');
    assert.ok(!code.has('div'), 'C# offers no HTML element');
  });

  test('markup hovers come from the HTML service when the server has none', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    const { doc, uri } = await openRepoFile(fixture().root, RAZOR_FILES.counter);
    const fromMdn = (text: string): boolean => text.includes('developer.mozilla.org');

    // Interaction 1 — an HTML element: the HTML service describes the heading.
    const heading = await hoverWhen(uri, positionOf(doc, '<h1>Counter', 'h1'), fromMdn);
    assert.match(heading, /heading/i, 'the element’s description');
    assert.ok(fromMdn(heading), 'with its MDN reference');

    // Interaction 2 — an HTML attribute: the HTML service describes `class`.
    const attribute = await hoverWhen(uri, positionOf(doc, '<button class=', 'class'), fromMdn);
    assert.match(attribute, /class/i, 'the attribute’s description');
    assert.ok(!attribute.includes('IncrementCount'), 'not the C# beside it');

    // Interaction 3 — C# keeps the server's hover: the field, never HTML.
    const csharp = hoverText(await waitForHoverResult(uri, positionOf(doc, ...COUNT)));
    assert.match(csharp, /\bint\b/, 'the field’s type');
    assert.ok(!fromMdn(csharp), 'no HTML documentation on C#');
  });

  test('references to a field in Razor land in its Razor file, never generated code', async function () {
    this.timeout(LSP_RESPONSE_MS * 2);
    const { doc, uri } = await openRepoFile(fixture().root, RAZOR_FILES.board);
    const usages = ['@bind-Label="caption"', 'Text="@caption"', '@bind="caption"'];
    const lines = usages.map((usage) => positionOf(doc, usage, 'caption').line);
    const declaration = positionOf(doc, 'private string caption', 'caption');

    // Interaction 1 — from the @code declaration: the declaration, a component
    // parameter, a bound attribute and a two-way binding.
    const references = await pollProvider<vscode.Location>(
      'vscode.executeReferenceProvider',
      [uri, declaration],
      (found) =>
        lines.every((line) => found.some((location) => location.range.start.line === line)),
    );
    for (const location of references) {
      assert.equal(location.uri.toString(), uri.toString(), 'every usage is in Board.razor');
      assert.equal(doc.getText(location.range), 'caption', 'and spans the name');
    }
    assert.ok(
      references.some((location) => location.range.start.line === declaration.line),
      'the declaration',
    );

    // Interaction 2 — from a usage in markup, the same set.
    const fromUsage = await pollProvider<vscode.Location>(
      'vscode.executeReferenceProvider',
      [uri, positionOf(doc, 'Text="@caption"', 'caption')],
      (found) => found.length === references.length,
    );
    assert.deepEqual(
      fromUsage.map((location) => location.range.start.line).sort((a, b) => a - b),
      references.map((location) => location.range.start.line).sort((a, b) => a - b),
      'every usage finds the same references',
    );
  });
});
