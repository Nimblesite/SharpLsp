// End-to-end tests for Razor in VS Code ([RAZOR-EDITORS], [RAZOR-FEATURES-HTML]), over
// the real Razor fixture solution ([RAZOR-TESTING]). The extension activates on and
// syncs Razor documents; the C# sidecar answers the C# inside them; and markup gets
// the built-in HTML service's completion and hover over the server's HTML projection
// (`sharplsp/razor/htmlProjection`, [RAZOR-ARCHITECTURE-HTML]).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DOCUMENT_SELECTOR } from '../../client.js';
import { projectionUri, serverProjection } from '../../razor-html.js';
import { completionList, hoverText } from './filebased-package-kit';
import { lspClient } from './profiler-kit';
import { openRepoFile, positionOf } from './real-repo-helpers';
import { completionLabels } from './real-repo-kit';
import {
  htmlProjection,
  RAZOR_FILES,
  STRAY_RAZOR,
  useRazorFixture,
  writeStrayRazor,
} from './razor-kit';
import { loggedLine } from './log-kit';
import { packageJson } from './run-debug-kit';
import {
  closeAllEditors,
  comparablePath,
  pollProvider,
  removeDirRecursive,
  waitForHoverResult,
} from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/** The C# expression the Counter page shows, and the field it reads. */
const COUNT: readonly [string, string] = ['Current count: @currentCount', 'currentCount'];

/**
 * Elements the HTML service offers at any tag name that no fixture file holds as a
 * word, so VS Code's word-based suggestions can never supply them.
 */
const HTML_ONLY: readonly string[] = ['blockquote', 'figcaption', 'fieldset'];

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

    const projectionWord = 'HtmlProjectionOnlyWord';
    const provider = vscode.languages.registerCompletionItemProvider(
      { scheme: projectionUri(doc).scheme, language: 'html' },
      {
        provideCompletionItems: () => [
          new vscode.CompletionItem(projectionWord, vscode.CompletionItemKind.Text),
        ],
      },
    );
    try {
      // Interaction 1 — in a tag name, the HTML service's element names arrive through
      // the projection, and no C# member does.
      const tag = completionLabels(
        await completionList(uri, positionOf(doc, '<h1>Counter', 'h1'), 'div'),
      );
      for (const element of ['div', 'span', 'h1'])
        assert.ok(tag.has(element), `offers <${element}>`);
      assert.ok(!tag.has('currentCount'), 'markup offers no C# member');
      assert.ok(
        tag.has(projectionWord),
        'markup really forwards to providers on the HTML projection',
      );

      // Interaction 2 — in @code, the server's C# members answer, and the HTML
      // service adds no element name: the projection blanks the C#.
      const codeItems = await completionList(
        uri,
        positionOf(doc, 'currentCount++;', 'currentCount'),
        'currentCount',
      );
      const code = completionLabels(codeItems);
      assert.ok(code.has('currentCount'), 'the field');
      assert.ok(code.has('IncrementCount'), 'the method');
      assert.ok(!code.has('div'), 'C# offers no HTML element');
      assert.ok(!code.has(projectionWord), 'C# never forwards to the HTML projection (#405)');
    } finally {
      provider.dispose();
    }
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

  test('markup without a projection keeps the server’s answers alone', async function () {
    this.timeout(LSP_RESPONSE_MS * 4);
    const root = writeStrayRazor('<h2>Stray</h2>\n<p>No project lists this file.</p>\n');
    try {
      const listed = await openRepoFile(fixture().root, RAZOR_FILES.counter);
      const stray = await openRepoFile(root, STRAY_RAZOR);
      const heading = positionOf(stray.doc, '<h2>Stray', 'h2');

      // Interaction 1 — at a tag name, a listed file gets the HTML service's elements;
      // a file no project lists has no projection, so the server's items stand alone.
      const offered = completionLabels(
        await completionList(listed.uri, positionOf(listed.doc, '<h1>Counter', 'h1'), 'fieldset'),
      );
      for (const element of HTML_ONLY) assert.ok(offered.has(element), `listed: <${element}>`);
      assert.equal(
        await htmlProjection(stray.uri),
        undefined,
        'an unlisted file has no projection',
      );
      const own = completionLabels(
        await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          stray.uri,
          heading,
        ),
      );
      for (const element of HTML_ONLY) assert.ok(!own.has(element), `unlisted: no <${element}>`);

      // Interaction 2 — hover: the server has none there, and the HTML service is never
      // asked; the address the file's projection would have reads as empty HTML.
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        stray.uri,
        heading,
      );
      assert.equal(hoverText(hovers), '', 'no hover from the server or the HTML service');
      const address = await vscode.workspace.openTextDocument(projectionUri(stray.doc));
      assert.equal(address.languageId, 'html', 'a projection address reads as HTML');
      assert.equal(address.getText(), '', 'and holds nothing for a file never projected');

      // Interaction 3 — the server refuses a URI that names no file: the refusal is
      // logged and answers no projection, as a stopped client does, while the running
      // server still projects the listed file.
      const unreadable = `untitled:Stray-${Date.now()}.razor`;
      assert.equal(await serverProjection(lspClient)(unreadable), undefined, 'a refusal');
      assert.match(
        await loggedLine((line) => line.includes(unreadable), `a log line naming ${unreadable}`),
        /\[WARN\] \{"event":"razor_html_projection_failed","uri":"untitled:/,
        'is logged as a warning, by event and URI',
      );
      assert.equal(await serverProjection(() => undefined)(listed.uri.toString()), undefined);
      const projection = await serverProjection(lspClient)(listed.uri.toString());
      assert.ok(projection?.includes('<h1>Counter</h1>'), 'the running server projects');
    } finally {
      await closeAllEditors();
      removeDirRecursive(root);
    }
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

  test('F# symbols in Razor navigate to, find and rename in their F# source', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    const { doc, uri } = await openRepoFile(fixture().root, RAZOR_FILES.leaders);
    const inScores = (target: vscode.Uri): boolean => target.path.endsWith('/Domain/Scores.fs');

    // Interaction 1 — definition on an F# record lands on its F# declaration, not
    // decompiled source. [RAZOR-FSHARP-DEFINITION]
    const definitions = await pollProvider<vscode.Location | vscode.LocationLink>(
      'vscode.executeDefinitionProvider',
      [uri, positionOf(doc, 'private readonly Player[]', 'Player')],
      (found) => found.some((target) => inScores(targetUri(target))),
      LSP_RESPONSE_MS * 2,
    );
    const declared = definitions.find((target) => inScores(targetUri(target)));
    assert.ok(declared, 'a definition in Scores.fs');
    const scores = await vscode.workspace.openTextDocument(targetUri(declared));
    assert.equal(scores.getText(targetRange(declared)), 'Player', 'ranged on the name');
    assert.ok(
      scores.lineAt(targetRange(declared).start.line).text.startsWith('type Player'),
      'on the type declaration',
    );

    // Interaction 2 — references on an F# field span F# and Razor, each on its name.
    // [RAZOR-FSHARP-REFERENCES]
    const score = positionOf(doc, '@player.Score', 'Score');
    const references = await pollProvider<vscode.Location>(
      'vscode.executeReferenceProvider',
      [uri, score],
      (found) =>
        found.some((location) => inScores(location.uri)) &&
        found.some((location) => location.uri.toString() === uri.toString()),
    );
    assert.equal(references.filter((location) => inScores(location.uri)).length, 5);
    for (const location of references) {
      const holder = inScores(location.uri) ? scores : doc;
      assert.equal(holder.getText(location.range), 'Score', 'every reference spans the name');
      assert.ok(!location.uri.path.endsWith('.g.cs'), 'never generated code');
    }

    // Interaction 3 — renaming it from Razor renames its F# declaration and uses.
    // [RAZOR-FSHARP-RENAME]
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider',
      uri,
      score,
      'Points',
    );
    // Keyed as the file system compares paths: on Windows a drive letter may be
    // spelled in either case, and one file must never count as two.
    const byFile = new Map<string, vscode.TextEdit[]>();
    for (const [target, edits] of edit.entries()) {
      const key = comparablePath(target.fsPath);
      byFile.set(key, [...(byFile.get(key) ?? []), ...edits]);
    }
    assert.equal(byFile.get(comparablePath(uri.fsPath))?.length, 1, 'the Razor use');
    assert.equal(
      byFile.get(comparablePath(scores.uri.fsPath))?.length,
      5,
      'the F# declaration and four uses',
    );
    assert.equal(byFile.size, 2, 'the Razor file and the F# file, and nothing else');
    assert.ok(
      [...byFile.values()].flat().every((change) => change.newText === 'Points'),
      'every edit renames to Points',
    );
    assert.ok(![...byFile.keys()].some((file) => file.endsWith('.g.cs')), 'no generated file');
  });

  test('a Razor Page completes tag helper elements once, before the HTML service', async function () {
    this.timeout(LSP_RESPONSE_MS * 2);
    const { doc, uri, editor } = await openRepoFile(fixture().root, RAZOR_FILES.edit);
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    await editor.edit((builder) => {
      builder.insert(end, '\n<');
    });
    const caret = doc.lineAt(doc.lineCount - 1).range.end;

    // The tag helper's element comes from the server, HTML's own from the HTML
    // service, and `a`, which both offer, appears once. [RAZOR-MVC-TAGHELPERS]
    const list = await completionList(uri, caret, 'partial');
    const labels = list.items.map((item) =>
      typeof item.label === 'string' ? item.label : item.label.label,
    );
    assert.ok(labels.includes('environment'), 'every tag helper element');
    assert.ok(
      HTML_ONLY.every((element) => labels.includes(element)),
      "and the HTML service's",
    );
    assert.equal(labels.filter((label) => label === 'a').length, 1, '`a` once');
    const anchor = list.items.find((item) => item.label === 'a');
    assert.match(
      String(anchor?.detail),
      /AnchorTagHelper/,
      "the server's item, naming its tag helper",
    );
    assert.ok(!labels.includes('ErrorBoundary'), 'no component completes in a Razor Page');
  });

  test('a component completes and defines its stylesheet classes, and nests its collocated files', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    const { doc, uri, editor } = await openRepoFile(fixture().root, RAZOR_FILES.card);
    const inStylesheet = (target: vscode.Uri): boolean =>
      target.path.endsWith('/Shared/Card.razor.css');

    // Interaction 1 — a class name defines to every selector that declares it, each on
    // the name after its `.`. [RAZOR-COLLOCATION-CSS]
    const definitions = await pollProvider<vscode.Location | vscode.LocationLink>(
      'vscode.executeDefinitionProvider',
      [uri, positionOf(doc, 'class="card title"', 'title')],
      (found) => found.length > 0 && found.every((target) => inStylesheet(targetUri(target))),
      LSP_RESPONSE_MS * 2,
    );
    assert.equal(definitions.length, 5, 'the five rules whose selectors hold .title');
    const [first] = definitions;
    assert.ok(first, 'a definition');
    const stylesheet = await vscode.workspace.openTextDocument(targetUri(first));
    for (const definition of definitions) {
      assert.equal(
        stylesheet.getText(targetRange(definition)),
        'title',
        'ranged on the class name',
      );
    }

    // Interaction 2 — inside a class value, the stylesheet's classes complete as values
    // that replace the class name at the caret. [RAZOR-COLLOCATION-CSS]
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    await editor.edit((builder) => {
      builder.insert(end, '\n<div class="card ti');
    });
    const caret = doc.lineAt(doc.lineCount - 1).range.end;
    const list = await completionList(uri, caret, 'card__title');
    const titles = list.items.filter((item) => item.label.toString() === 'title');
    assert.equal(titles.length, 1, 'each class once');
    const [title] = titles;
    assert.ok(title, 'the stylesheet class completes');
    assert.equal(title.kind, vscode.CompletionItemKind.Value, 'a value');
    assert.equal(title.detail, 'Card.razor.css', 'naming its stylesheet');
    const replaced = title.range instanceof vscode.Range ? title.range : title.range?.replacing;
    assert.deepEqual(replaced, new vscode.Range(caret.translate(0, -2), caret), 'replacing `ti`');

    // Interaction 3 — the explorer nests a component's and a page's collocated files under
    // them, VS Code's own patterns kept. [RAZOR-COLLOCATION-NESTING]
    const nesting = vscode.workspace
      .getConfiguration('explorer.fileNesting')
      .inspect<Record<string, string>>('patterns')?.defaultValue;
    const defaults = packageJson().contributes.configurationDefaults as Record<
      string,
      Record<string, string> | undefined
    >;
    const contributed = defaults['explorer.fileNesting.patterns'] ?? {};
    for (const kind of ['razor', 'cshtml']) {
      const nested = ['cs', 'css', 'js']
        .map((extension) => `$\{capture}.${kind}.${extension}`)
        .join(', ');
      assert.equal(contributed[`*.${kind}`], nested, `the manifest nests ${kind} files`);
      assert.equal(nesting?.[`*.${kind}`], nested, `VS Code applies the ${kind} default`);
    }
    assert.ok(Object.keys(nesting ?? {}).length > 2, "VS Code's own patterns stay");
  });
});

/** The file a definition result points into. */
function targetUri(target: vscode.Location | vscode.LocationLink): vscode.Uri {
  return 'targetUri' in target ? target.targetUri : target.uri;
}

/** The range a definition result selects. */
function targetRange(target: vscode.Location | vscode.LocationLink): vscode.Range {
  return 'targetUri' in target ? (target.targetSelectionRange ?? target.targetRange) : target.range;
}
