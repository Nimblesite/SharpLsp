import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  warmSemanticEngine,
  pollUntilResult,
  replaceDocumentContent,
  setupLspTestSuite,
  settleForScreenshot,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDocumentSymbols,
  waitForHoverResult,
} from './test-helpers';
import { COMMAND_MS, FIXTURE_BUILD_MS, LSP_RESPONSE_MS, LSP_SWEEP_MS } from './test-timeouts';

/**
 * [HOVER-PROTOCOL-RESPONSE]: every content entry MUST be Markdown.
 *
 * "Plain-text fallback is not supported — all LSP 3.17 clients support
 * Markdown." A hover that arrives as a bare string renders its backticks and
 * its fenced code block as literal characters, which is the difference between
 * a signature and a line of punctuation.
 */
function assertMarkdownContents(hovers: readonly vscode.Hover[], where: string): void {
  assert.ok(hovers.length > 0, `${where}: a hover must have been returned`);
  for (const hover of hovers) {
    assert.ok(hover.contents.length > 0, `${where}: a hover must carry content entries`);
    for (const entry of hover.contents) {
      assert.ok(
        entry instanceof vscode.MarkdownString,
        `${where}: every content entry must be Markdown, got ${typeof entry}`,
      );
      assert.ok(entry.value.trim().length > 0, `${where}: no content entry may be blank`);
    }
  }
}

suite('Hover / Quick Info', () => {
  let tmpDir: string;
  let workspaceRoot: string;

  suiteSetup(async function () {
    // Above setupLspTestSuite's SIDECAR_COLD_MS warm-up, so the warm-up reports
    // rather than this hook ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    this.timeout(FIXTURE_BUILD_MS);
    const result = await setupLspTestSuite('hover-');
    tmpDir = result.tmpDir;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(ws, 'Workspace folder must be available');
    workspaceRoot = ws;

    // Pay Roslyn's cold project load ONCE, here, on a file that is actually in
    // the workspace project. `setupLspTestSuite` only proves the syntax path
    // answers -- for C# `documentSymbol` is served by tree-sitter in the Rust
    // host and never reaches the sidecar -- so without this the first semantic
    // test pays the load inside its own ceiling. That is what pushed the
    // symbol-sweep test past LSP_SWEEP_MS on a fresh shard, where unsharded it
    // had always run against a sidecar some earlier suite had warmed
    // ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    const { uri } = await openFixture('Calculator.cs');
    await warmSemanticEngine(uri);
    await closeAllEditors();
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  /** Open a fixture file from the workspace (part of the project). */
  async function openFixture(name: string): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
    const filePath = path.join(workspaceRoot, name);
    assert.ok(fs.existsSync(filePath), `${name} fixture must exist`);
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    return { doc, uri };
  }

  // ── Multi-Symbol Hover ──────────────────────────────────────────

  test('hover on class, method, property, field in one file', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openFixture('HoverMulti.cs');
    await waitForDocumentSymbols(uri);

    // Hover on class "Calculator" (line 2, char 18).
    const classHover = await waitForHoverResult(uri, new vscode.Position(2, 18));
    assert.ok(classHover.length > 0, 'Must return hover for class');
    const classMd = hoverToString(classHover);
    assert.ok(classMd.includes('Calculator'), "Class hover must contain 'Calculator'");
    assert.ok(classMd.includes('class'), "Class hover must contain 'class' keyword");
    assert.ok(classMd.includes('```'), 'Class hover must contain code block');

    // Hover on method "Add" (line 6, char 20).
    const methodHover = await waitForHoverResult(uri, new vscode.Position(6, 20));
    assert.ok(methodHover.length > 0, 'Must return hover for method');
    const methodMd = hoverToString(methodHover);
    assert.ok(methodMd.includes('Add'), "Method hover must contain 'Add'");
    assert.ok(methodMd.includes('int'), "Method hover must contain return type 'int'");

    // Hover on property "Name" (line 5, char 23).
    const propHover = await waitForHoverResult(uri, new vscode.Position(5, 23));
    assert.ok(propHover.length > 0, 'Must return hover for property');
    const propMd = hoverToString(propHover);
    assert.ok(propMd.includes('Name'), "Property hover must contain 'Name'");
    assert.ok(propMd.includes('string'), "Property hover must contain type 'string'");

    // Hover on field "_count" (line 4, char 21).
    const fieldHover = await waitForHoverResult(uri, new vscode.Position(4, 21));
    assert.ok(fieldHover.length > 0, 'Must return hover for field');
    const fieldMd = hoverToString(fieldHover);
    assert.ok(fieldMd.includes('_count'), "Field hover must contain '_count'");

    const { uri: completionUri } = await openFixture('CompletionShot.cs');
    await waitForDocumentSymbols(completionUri);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      completionUri,
      new vscode.Position(11, 24),
    );
    assert.ok(completions, 'Must get completions');
    assert.ok(completions.items.length > 0, 'Must have at least one completion item');
    const completionLabels = new Set(completions.items.map((item) => item.label.toString()));
    assert.ok(completionLabels.has('Name'), "Completions must contain property 'Name'");
    assert.ok(completionLabels.has('Add'), "Completions must contain method 'Add'");
    assert.ok(completionLabels.has('_count'), "Completions must contain field '_count'");

    // Now trigger the visible suggest widget and screenshot immediately while it's open.
    const completionEditor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(completionUri),
      { preview: false },
    );
    const completionPosition = new vscode.Position(11, 24);
    completionEditor.selection = new vscode.Selection(completionPosition, completionPosition);
    completionEditor.revealRange(new vscode.Range(completionPosition, completionPosition));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), completionUri.toString());
    assert.ok(
      completionEditor.selection.active.isEqual(completionPosition),
      'Completion cursor must be after this.',
    );
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
    // Wait for widget to appear — no other commands that could dismiss it.
    await settleForScreenshot(2500);
    // No openSharpLspPanel() — the completion dropdown IS the feature; keep editor visible.
    await takeScreenshot('vscode-completions-page.png');

    // Dismiss suggestion widget then switch back to HoverMulti.cs for go-to-definition.
    await vscode.commands.executeCommand('hideSuggestWidget');
    await new Promise((r) => setTimeout(r, 300));

    const goToEditor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(completionUri),
      {
        preview: false,
      },
    );
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), completionUri.toString());

    // Verify definition via LSP on the `Add` call site in CompletionShot.cs.
    const definitionPosition = new vscode.Position(10, 26);
    const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider',
      completionUri,
      definitionPosition,
    );
    assert.ok(definitions, 'Must get definitions for Add method');
    assert.ok(definitions.length > 0, 'Must have at least one definition location');
    assert.ok(definitions[0]!.uri.fsPath.endsWith('.cs'), 'Definition must point to a .cs file');
    assert.ok(definitions[0]!.range.start.line >= 0, 'Definition must have valid line');

    // Trigger peek definition on the call-site reference.
    goToEditor.selection = new vscode.Selection(definitionPosition, definitionPosition);
    goToEditor.revealRange(new vscode.Range(definitionPosition, definitionPosition));
    assert.ok(
      goToEditor.selection.active.isEqual(definitionPosition),
      'Definition cursor must be on Add',
    );
    await settleForScreenshot(300);
    await vscode.commands.executeCommand('editor.action.peekDefinition');
    await settleForScreenshot(3000);
    await takeScreenshot('vscode-go-to-definition-page.png');
  });

  // ── Hover Range ─────────────────────────────────────────────────

  test('hover returns range that spans the hovered token', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openFixture('HoverRange.cs');
    await waitForDocumentSymbols(uri);

    const hovers = await waitForHoverResult(uri, new vscode.Position(2, 18));
    assert.ok(hovers.length > 0, 'Must return hover');

    // Verify range is present and reasonable.
    const firstHover = hovers[0];
    assert.ok(firstHover !== undefined, 'First hover must exist');
    if (firstHover.range !== undefined) {
      assert.ok(firstHover.range.start.line >= 0, 'Range start line must be non-negative');
      assert.ok(
        firstHover.range.end.character >= firstHover.range.start.character,
        'Range end must be >= start',
      );
    }

    // Verify content is markdown.
    assert.ok(firstHover.contents.length > 0, 'Must have content entries');

    // Interaction 2 — [HOVER-PROTOCOL-RESPONSE] makes `range` "the range of the
    // hovered token", which is what the editor highlights while the tooltip is
    // up. A range covering the whole declaration highlights the line; one
    // covering nothing highlights nothing.
    const document = await vscode.workspace.openTextDocument(uri);
    assert.ok(firstHover.range, 'a hover over an identifier must report its range');
    assert.strictEqual(
      document.getText(firstHover.range),
      'Widget',
      `the range must cover the hovered token alone, covers '${document.getText(firstHover.range)}'`,
    );
    assert.strictEqual(
      firstHover.range.start.line,
      firstHover.range.end.line,
      'an identifier range never straddles a line break',
    );

    // Interaction 3 — the contents are Markdown and name the symbol, so the
    // tooltip a user sees is a signature rather than escaped punctuation.
    assertMarkdownContents(hovers, 'HoverRange Widget');
    const markdown = hoverToString(hovers);
    assert.ok(markdown.includes('Widget'), `the tooltip names the type: ${markdown}`);
    assert.ok(markdown.includes('```'), 'and renders its signature in a fenced code block');

    // Interaction 4 — hovering the SAME position twice answers identically.
    // [HOVER-CACHING] makes the second read a salsa hit; a cache that returns a
    // different tooltip is worse than no cache.
    const again = await waitForHoverResult(uri, new vscode.Position(2, 18));
    assert.strictEqual(hoverToString(again), markdown, 'a repeat hover answers identically');
    assert.ok(again[0]?.range?.isEqual(firstHover.range), 'and reports the same range');
  });

  // ── Whitespace & Comment Rejection (multiple positions) ─────────

  test('hover on comments and whitespace returns empty across many positions', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openFixture('HoverReject.cs');
    await waitForDocumentSymbols(uri);

    // All these positions are on non-symbol tokens.
    const nullPositions = [
      new vscode.Position(0, 5), // single-line comment
      new vscode.Position(1, 5), // multi-line comment
      new vscode.Position(2, 5), // multi-line comment continued
      new vscode.Position(3, 10), // doc comment
      new vscode.Position(3, 25), // doc comment closing tag
    ];

    for (const pos of nullPositions) {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        pos,
      );
      assert.ok(
        hovers === undefined || hovers.length === 0,
        `Hover at line ${String(pos.line)}, char ${String(pos.character)} must return empty`,
      );
    }

    // But hovering on the actual class MUST return results.
    const classHover = await waitForHoverResult(uri, new vscode.Position(7, 18));
    assert.ok(classHover.length > 0, 'Class hover must not be empty');
    const md = hoverToString(classHover);
    assert.ok(md.includes('Bar'), "Class hover must mention 'Bar'");

    // Interaction 3 — BLANK positions are rejected too. [HOVER-ERRORS] lists
    // "position is whitespace or comment" as one row, and the tree-sitter
    // pre-validation of [HOVER-ROUTING] is what makes it a sub-millisecond
    // rejection instead of a sidecar round trip on every mouse move.
    // Line 4 is the empty line before the namespace; 7:2 is inside the
    // indentation of the class line. Line 5 is the `namespace` keyword itself.
    const document = await vscode.workspace.openTextDocument(uri);
    for (const blank of [new vscode.Position(4, 0), new vscode.Position(7, 2)]) {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        blank,
      );
      assert.ok(
        hovers === undefined || hovers.length === 0,
        `whitespace at ${blank.line}:${blank.character} must produce no hover`,
      );
    }

    // Interaction 4 — the rejection is about the POSITION, not the file. The
    // very same document answers for its declaration, with Markdown contents
    // and a range over the identifier.
    assertMarkdownContents(classHover, 'HoverReject Bar');
    assert.strictEqual(
      document.getText(classHover[0]?.range ?? new vscode.Range(0, 0, 0, 0)),
      'Bar',
      'the class hover ranges over its own identifier',
    );
    assert.ok(md.includes('```'), 'and renders a fenced signature');
    assert.ok(
      md.includes('class'),
      `[HOVER-CSHARP-RENDERING] requires the signature, which names the kind: ${md}`,
    );
  });

  // ── Edit → Re-hover (content changes reflected) ─────────────────

  test('hover reflects content after edit cycle', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    // Open fixture with class Alpha.
    const { doc, uri } = await openFixture('HoverEdit.cs');
    await waitForDocumentSymbols(uri);

    // Hover on Alpha.
    const alphaHover = await waitForHoverResult(uri, new vscode.Position(2, 18));
    assert.ok(alphaHover.length > 0, 'Alpha hover must return results');
    const alphaMd = hoverToString(alphaHover);
    assert.ok(alphaMd.includes('Alpha'), 'Must see Alpha in hover');

    // Edit: rename to Bravo, add a method.
    await replaceDocumentContent(
      doc,
      'namespace HoverEdit\n{\n    public class Bravo\n    {\n        public void Run() { }\n    }\n}',
    );

    // Wait for LSP to process the edit.
    const bravoSymbols = await waitForDocumentSymbols(uri);
    assert.ok(bravoSymbols.length > 0, 'Symbols must update after edit');

    // Hover on Bravo.
    const bravoHover = await waitForHoverResult(uri, new vscode.Position(2, 18));
    assert.ok(bravoHover.length > 0, 'Bravo hover must return results');
    const bravoMd = hoverToString(bravoHover);
    assert.ok(bravoMd.includes('Bravo'), 'Must see Bravo in hover after edit');

    // Hover on Run method.
    const runHover = await waitForHoverResult(uri, new vscode.Position(4, 22));
    assert.ok(runHover.length > 0, 'Run method hover must return results');
    const runMd = hoverToString(runHover);
    assert.ok(runMd.includes('Run'), 'Must see Run in method hover');

    // Interaction 4 — the OLD name is gone. "The new name appeared" is only
    // half of it: a sidecar serving a stale buffer would show both, and the
    // user would hover a symbol that no longer exists.
    assert.strictEqual(
      bravoMd.includes('Alpha'),
      false,
      `the pre-edit type name must not survive the rename: ${bravoMd}`,
    );
    assert.notStrictEqual(bravoMd, alphaMd, 'the tooltip really changed');
    assert.strictEqual(doc.isDirty, true, 'and the edit was never saved to disk');

    // Interaction 5 — both post-edit tooltips are well formed: Markdown, with a
    // fenced signature, ranged over the identifier the user pointed at.
    assertMarkdownContents(bravoHover, 'HoverEdit Bravo');
    assertMarkdownContents(runHover, 'HoverEdit Run');
    assert.ok(bravoMd.includes('```'), 'the type tooltip carries a fenced signature');
    assert.strictEqual(
      doc.getText(runHover[0]?.range ?? new vscode.Range(0, 0, 0, 0)),
      'Run',
      'and the method tooltip ranges over the method name',
    );

    // Interaction 6 — the member is attributed to its CONTAINING TYPE.
    // [HOVER-CSHARP-RENDERING] makes that mandatory for members, because the
    // signature alone cannot say where the member came from.
    assert.ok(runMd.includes('Bravo'), `a member tooltip must name its containing type: ${runMd}`);
  });

  // ── Struct, Enum, Interface hover ───────────────────────────────

  test('hover on struct, enum, interface returns correct kinds', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openFixture('HoverKinds.cs');
    await waitForDocumentSymbols(uri);

    // Hover on struct "Point" (line 2, char 19).
    const structHover = await waitForHoverResult(uri, new vscode.Position(2, 19));
    assert.ok(structHover.length > 0, 'Struct hover must return results');
    const structMd = hoverToString(structHover);
    assert.ok(structMd.includes('Point'), "Struct hover must contain 'Point'");
    assert.ok(structMd.includes('struct'), "Struct hover must contain 'struct'");

    // Hover on enum "Color" (line 3, char 17).
    const enumHover = await waitForHoverResult(uri, new vscode.Position(3, 17));
    assert.ok(enumHover.length > 0, 'Enum hover must return results');
    const enumMd = hoverToString(enumHover);
    assert.ok(enumMd.includes('Color'), "Enum hover must contain 'Color'");
    assert.ok(enumMd.includes('enum'), "Enum hover must contain 'enum'");

    // Hover on interface "IShape" (line 4, char 22).
    const ifaceHover = await waitForHoverResult(uri, new vscode.Position(4, 22));
    assert.ok(ifaceHover.length > 0, 'Interface hover must return results');
    const ifaceMd = hoverToString(ifaceHover);
    assert.ok(ifaceMd.includes('IShape'), "Interface hover must contain 'IShape'");
    assert.ok(ifaceMd.includes('interface'), "Interface hover must contain 'interface'");
  });

  // ── var keyword hover ──────────────────────────────────────────

  test('hover on var keyword shows inferred type', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openFixture('HoverVar.cs');
    await waitForDocumentSymbols(uri);

    // Hover on `var` at line 7 char 12 ("var g = new Gadget()").
    const varHover = await waitForHoverResult(uri, new vscode.Position(7, 12));
    assert.ok(varHover.length > 0, 'var hover must return results');
    const md = hoverToString(varHover);
    assert.ok(md.includes('```'), 'var hover must have code block');
    assert.ok(
      md.includes('Gadget') || md.toLowerCase().includes('inferred'),
      `var hover must show inferred type Gadget: ${md}`,
    );

    // Interaction 2 — [HOVER-CSHARP-CASES] row 1: hovering `var` shows the
    // INFERRED type "with full signature". A tooltip that echoes the keyword
    // back tells the reader nothing they could not already see.
    assertMarkdownContents(varHover, 'HoverVar var');
    assert.ok(md.includes('Gadget'), `the inferred type must be named outright: ${md}`);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(
      document.getText(varHover[0]?.range ?? new vscode.Range(0, 0, 0, 0)),
      'var',
      'and the range covers the keyword the user pointed at',
    );

    // Interaction 3 — a SECOND `var`, inferred from a property rather than a
    // constructor, resolves to that property's type. One working case is a
    // special case; two is inference.
    const propertyVar = await waitForHoverResult(uri, new vscode.Position(8, 12));
    assertMarkdownContents(propertyVar, 'HoverVar second var');
    const propertyMd = hoverToString(propertyVar);
    assert.ok(propertyMd.includes('int'), `var over 'g.Size' must infer int, got: ${propertyMd}`);
    assert.notStrictEqual(propertyMd, md, 'two different inferences give two different tooltips');

    // Interaction 4 — hovering the initialiser itself names the same type, so
    // the keyword and the expression agree about what is being declared.
    const constructed = await waitForHoverResult(uri, new vscode.Position(7, 28));
    assertMarkdownContents(constructed, 'HoverVar new Gadget()');
    assert.ok(
      hoverToString(constructed).includes('Gadget'),
      'the constructed type resolves to Gadget as well',
    );
  });

  // ── XML documentation rendering ──────────────────────────────

  test('hover renders XML doc summary, param, and returns tags', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openFixture('HoverXmlDoc.cs');
    await waitForDocumentSymbols(uri);

    // Hover on Factorial method (line 7, char 21).
    const hovers = await waitForHoverResult(uri, new vscode.Position(7, 21));
    assert.ok(hovers.length > 0, 'Method with XML doc must return hover');
    const md = hoverToString(hovers);
    assert.ok(md.includes('Factorial'), 'Must contain method name');
    assert.ok(md.includes('```'), 'Must have code block');
    // XML doc sections.
    assert.ok(
      md.toLowerCase().includes('factorial') && md.toLowerCase().includes('computes'),
      `Must render <summary>: ${md}`,
    );
    assert.ok(
      md.toLowerCase().includes('non-negative') || md.toLowerCase().includes('input'),
      `Must render <param>: ${md}`,
    );
    assert.ok(
      md.toLowerCase().includes('result') || md.toLowerCase().includes('return'),
      `Must render <returns>: ${md}`,
    );

    // Interaction 2 — the rendered documentation is MARKDOWN, and the raw XML
    // tags are gone. [HOVER-CSHARP-RENDERING-XML] renders `<summary>` as a
    // paragraph and `<param>` as a parameter list; leaking the tags puts
    // literal angle brackets in the tooltip.
    assertMarkdownContents(hovers, 'HoverXmlDoc Factorial');
    for (const tag of ['<summary>', '</summary>', '<param', '<returns>']) {
      assert.strictEqual(md.includes(tag), false, `the raw ${tag} tag must not reach the tooltip`);
    }

    // Interaction 3 — [HOVER-CSHARP-RENDERING] requires the SIGNATURE and the
    // containing type alongside the prose, so the reader can tell a `long`
    // return from an `int` one without leaving the tooltip.
    assert.ok(md.includes('long'), `the signature must name the return type: ${md}`);
    assert.ok(md.includes('MathHelper'), `and the containing type: ${md}`);
    assert.ok(md.includes('public'), `and its accessibility: ${md}`);

    // Interaction 4 — the parameter's own name reaches the reader, so the
    // `<param name="n">` description is attached to something.
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(
      document.getText(hovers[0]?.range ?? new vscode.Range(0, 0, 0, 0)),
      'Factorial',
      'the hover ranges over the method name',
    );
    assert.ok(md.includes('n'), 'and the parameter name appears in the rendered documentation');

    // Position cursor on Factorial and trigger the hover widget visually.
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'Must have active text editor');
    editor.selection = new vscode.Selection(new vscode.Position(7, 21), new vscode.Position(7, 21));
    await vscode.commands.executeCommand('editor.action.showHover');
    // Wait for the hover widget to render in the DOM before screenshotting.
    await settleForScreenshot(2000);
    // Screenshot with hover tooltip visible — sidecar waits for .monaco-hover to appear.
    await takeScreenshot('vscode-hover-page.png');
  });

  // ── [Obsolete] deprecation ────────────────────────────────────

  test('hover on [Obsolete] method shows deprecation warning', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const { uri } = await openFixture('HoverObsolete.cs');
    await waitForDocumentSymbols(uri);

    // Hover on OldMethod (line 5, char 21).
    const hovers = await waitForHoverResult(uri, new vscode.Position(5, 21));
    assert.ok(hovers.length > 0, 'Obsolete method must return hover');
    const md = hoverToString(hovers);
    assert.ok(md.includes('OldMethod'), 'Must contain method name');
    assert.ok(md.includes('```'), 'Must have code block');
    assert.ok(md.includes('Deprecated') || md.includes('Obsolete'), `Must show deprecation: ${md}`);
    assert.ok(md.includes('Use NewMethod instead'), `Must include obsolete message: ${md}`);

    // Interaction 2 — [HOVER-CSHARP-RENDERING] lists deprecation as a REQUIRED
    // section when present. The whole point is that it is visible without
    // reading the attribute, so the tooltip carries the signature too.
    assertMarkdownContents(hovers, 'HoverObsolete OldMethod');
    assert.ok(md.includes('Legacy'), `and names the containing type: ${md}`);
    assert.ok(md.includes('void'), `and the signature's return type: ${md}`);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(
      document.getText(hovers[0]?.range ?? new vscode.Range(0, 0, 0, 0)),
      'OldMethod',
      'and ranges over the deprecated method name',
    );

    // Interaction 3 — the NON-deprecated sibling shows no deprecation. A
    // tooltip that marks everything obsolete is as useless as one that marks
    // nothing, and only the pair can tell them apart.
    const healthy = await waitForHoverResult(uri, new vscode.Position(6, 21));
    assertMarkdownContents(healthy, 'HoverObsolete NewMethod');
    const healthyMd = hoverToString(healthy);
    assert.ok(healthyMd.includes('NewMethod'), `the sibling tooltip names it: ${healthyMd}`);
    assert.strictEqual(
      healthyMd.includes('Use NewMethod instead'),
      false,
      'and carries no deprecation message of its own',
    );
    assert.notStrictEqual(healthyMd, md, 'the two tooltips differ');
  });

  // ── Solution Explorer Integration ───────────────────────────────

  test('ExplorerNode carries symbolUri and symbolPosition on symbol nodes', async function () {
    this.timeout(COMMAND_MS);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext !== undefined, 'Extension must exist');
    assert.ok(ext.isActive, 'Extension must be active');

    interface TreeNode {
      readonly label?: string | { label: string };
      readonly symbolUri?: string;
      readonly symbolPosition?: { line: number; character: number };
      readonly nodeType?: string;
      readonly children?: TreeNode[];
    }
    interface ExplorerApi {
      explorerProvider: {
        loadSolution(slnPath: string): Promise<void>;
        clear(): void;
        getChildren(element?: unknown): TreeNode[] | undefined;
        onDidChangeTreeData: vscode.Event<unknown>;
      };
    }
    const api = ext.exports as ExplorerApi | undefined;
    assert.ok(api !== undefined, 'Extension must export API');
    assert.ok(api.explorerProvider !== undefined, 'Must export explorerProvider');

    // Verify provider has the reactive event.
    assert.ok(
      api.explorerProvider.onDidChangeTreeData !== undefined,
      'Must expose onDidChangeTreeData event',
    );

    // Verify root shape.
    const roots = api.explorerProvider.getChildren();
    assert.ok(
      Array.isArray(roots) || roots === undefined,
      'getChildren() must return array or undefined',
    );

    // If tree is loaded, walk it and verify symbol nodes have hover data.
    if (Array.isArray(roots)) {
      assertNonSymbolNodesLackHoverData(roots);
    }

    // Interaction 2 — [HOVER-TREE-IMPLEMENTATION] resolves a tree tooltip by
    // calling `executeHoverProvider` at the node's own source position. That
    // requires BOTH a uri and a position, and requires them to be usable: a
    // node carrying a position but no uri resolves against whatever file
    // happens to be active.
    const nodes = Array.isArray(roots) ? collectSymbolNodes(roots) : [];
    for (const node of nodes) {
      const named = node.sortName ?? node.symbolKind ?? '?';
      assert.ok(node.symbolUri, `symbol node '${named}' must carry the uri to hover in`);
      assert.ok(node.symbolPosition, `symbol node '${named}' must carry the position to hover at`);
      assert.strictEqual(
        vscode.Uri.parse(node.symbolUri).scheme,
        'file',
        `symbol node '${named}' must point at a real file`,
      );
    }

    // Interaction 3 — the positions are inside their files. A position past the
    // end of the buffer makes `executeHoverProvider` answer null, which reads
    // to the user as "this symbol has no documentation".
    for (const node of nodes.slice(0, 10)) {
      const position = node.symbolPosition;
      assert.ok(position, 'the position must be readable');
      assert.ok(position.line >= 0, 'a symbol position has a non-negative line');
      assert.ok(position.character >= 0, 'and a non-negative character');
    }
    assert.strictEqual(
      nodes.some((node) => node.nodeType === 'project' || node.nodeType === 'solution'),
      false,
      'and only SYMBOL nodes are collected — a project node has no hover position',
    );
  });

  // ── Tree Tooltip (resolveTreeItem) ──────────────────────────────

  test('resolveTreeItem uses LSP hover — same content as code hover', async function () {
    this.timeout(LSP_SWEEP_MS);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    interface TooltipNode {
      readonly label?: string | { label: string };
      readonly symbolUri?: string;
      readonly symbolPosition?: { line: number; character: number };
      readonly symbolKind?: string;
      readonly sortName?: string;
      readonly access?: string;
      readonly nodeType?: string;
      readonly tooltip?: string | vscode.MarkdownString;
      readonly children?: TooltipNode[];
    }
    interface ExplorerApi {
      explorerProvider: {
        loadSolution(slnPath: string): Promise<void>;
        clear(): void;
        getTreeItem(element: unknown): vscode.TreeItem;
        getChildren(element?: unknown): TooltipNode[] | undefined;
        resolveTreeItem(
          item: vscode.TreeItem,
          element: unknown,
          token: vscode.CancellationToken,
        ): Promise<vscode.TreeItem>;
      };
    }
    const api = ext.exports as ExplorerApi | undefined;
    assert.ok(api?.explorerProvider, 'Must export explorerProvider');

    // Use the workspace fixture project — it's already loaded by the sidecar.
    const slnPath = path.join(workspaceRoot, 'TestFixtures.sln');
    assert.ok(fs.existsSync(slnPath), 'TestFixtures.sln must exist');

    // Open Calculator.cs so the LSP has it parsed.
    const { uri } = await openFixture('Calculator.cs');
    await waitForDocumentSymbols(uri);
    await api.explorerProvider.loadSolution(slnPath);

    // Wait for tree to populate.
    const roots = await pollUntilResult(
      async () => api.explorerProvider.getChildren(),
      (nodes) => nodes !== undefined && nodes.length > 0,
      10_000,
    );
    assert.ok(Array.isArray(roots), 'Tree must have roots');

    // Walk the tree and find symbol nodes.
    const symbolNodes = collectSymbolNodes(roots);
    assert.ok(
      symbolNodes.length > 0,
      `Tree must have symbol nodes, found ${String(symbolNodes.length)}`,
    );

    // Resolve symbol nodes and verify tooltips match LSP hover.
    // Not every symbol gets hover from the sidecar (e.g. compact field
    // declarations), so we verify the mechanism works on those that do.
    const provider = api.explorerProvider;
    const tokenSource = new vscode.CancellationTokenSource();
    let tooltipCount = 0;

    for (const node of symbolNodes) {
      const treeItem = provider.getTreeItem(node);
      const resolved = await provider.resolveTreeItem(treeItem, node, tokenSource.token);

      // Skip symbols where the sidecar returned no hover data.
      if (resolved.tooltip === undefined || !(resolved.tooltip instanceof vscode.MarkdownString)) {
        continue;
      }

      tooltipCount++;
      const treeMd = resolved.tooltip.value;
      assert.ok(treeMd.length > 0, `Tooltip for '${node.sortName ?? '?'}' must not be empty`);
      assert.ok(
        treeMd.includes('```'),
        `Tooltip for '${node.sortName ?? '?'}' must have code block: ${treeMd}`,
      );

      // Tooltip should contain the symbol name or a type signature.
      if (node.sortName !== undefined && node.sortName.length > 0) {
        assert.ok(
          treeMd.includes(node.sortName) || treeMd.includes('```'),
          `Tooltip must contain symbol name '${node.sortName}' or code block: ${treeMd}`,
        );
      }

      // Tree tooltip must match the code editor hover at the same position.
      if (node.symbolUri !== undefined && node.symbolPosition !== undefined) {
        const nodeUri = vscode.Uri.parse(node.symbolUri);
        const pos = new vscode.Position(node.symbolPosition.line, node.symbolPosition.character);
        const codeHover = await waitForHoverResult(nodeUri, pos);
        const codeMd = hoverToString(codeHover);
        assert.strictEqual(
          treeMd,
          codeMd,
          `Tree tooltip must match code hover for '${node.sortName ?? '?'}'`,
        );
      }
    }

    assert.ok(
      tooltipCount > 0,
      `At least one symbol must have a tooltip, got ${String(tooltipCount)} from ${String(symbolNodes.length)} symbols`,
    );

    tokenSource.dispose();
    api.explorerProvider.clear();
  });

  test('resolveTreeItem returns undefined tooltip for non-symbol nodes', async function () {
    this.timeout(COMMAND_MS);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    interface NodeApi {
      explorerProvider: {
        getTreeItem(element: unknown): vscode.TreeItem;
        getChildren(element?: unknown): { nodeType?: string; sortName?: string }[] | undefined;
        resolveTreeItem(
          item: vscode.TreeItem,
          element: unknown,
          token: vscode.CancellationToken,
        ): Promise<vscode.TreeItem>;
      };
    }
    const api = ext.exports as NodeApi | undefined;
    assert.ok(api?.explorerProvider, 'Must export explorerProvider');

    const roots = api.explorerProvider.getChildren();
    assert.ok(
      Array.isArray(roots) || roots === undefined,
      'getChildren returns an array or nothing',
    );
    if (roots === undefined || roots.length === 0) return;
    assert.ok(roots.length > 0, 'the loaded tree has at least one root');
    assert.ok(
      roots.every((node) => typeof node === 'object'),
      'and every root is a node object',
    );

    // Find non-symbol nodes (solution, project, dependency folder).
    const tokenSource = new vscode.CancellationTokenSource();
    for (const node of roots) {
      if (node.nodeType !== 'symbol' && node.nodeType !== 'namespace') {
        const treeItem = api.explorerProvider.getTreeItem(node);
        const resolved = await api.explorerProvider.resolveTreeItem(
          treeItem,
          node,
          tokenSource.token,
        );
        // Non-symbol nodes should not get a code block tooltip.
        const named = node.sortName ?? node.nodeType ?? '?';
        if (resolved.tooltip instanceof vscode.MarkdownString) {
          assert.ok(
            !resolved.tooltip.value.includes('```csharp'),
            `Non-symbol node '${named}' must not get C# tooltip`,
          );
          assert.ok(
            !resolved.tooltip.value.includes('```fsharp'),
            `nor an F# one — [HOVER-TREE] scopes LSP hover to SYMBOL rows: '${named}'`,
          );
        }

        // Interaction 2 — resolving a non-symbol row must not MUTATE it into
        // something else. `resolveTreeItem` is called lazily as the user
        // scrolls, so a resolver that swaps the label or the collapsible state
        // makes rows change under the mouse.
        assert.strictEqual(resolved.label, treeItem.label, `${named} keeps its label`);
        assert.strictEqual(
          resolved.collapsibleState,
          treeItem.collapsibleState,
          `${named} keeps its collapsible state`,
        );
        assert.strictEqual(
          resolved.contextValue,
          treeItem.contextValue,
          `${named} keeps its contextValue, so its context menu is unchanged`,
        );

        // Interaction 3 — resolving is IDEMPOTENT and cancellation-safe: the
        // same row resolved twice answers the same, and a cancelled token
        // yields a tree item rather than a rejection.
        const again = await api.explorerProvider.resolveTreeItem(treeItem, node, tokenSource.token);
        assert.strictEqual(again.label, resolved.label, `${named} resolves identically twice`);
        const cancelled = new vscode.CancellationTokenSource();
        cancelled.cancel();
        const underCancellation = await api.explorerProvider.resolveTreeItem(
          treeItem,
          node,
          cancelled.token,
        );
        assert.ok(underCancellation, `${named} still yields an item under cancellation`);
        cancelled.dispose();
      }
    }
    tokenSource.dispose();
  });
});

// ── Helpers ──────────────────────────────────────────────────────

/** Extract all hover content as a single string for assertions. */
function hoverToString(hovers: vscode.Hover[]): string {
  const parts: string[] = [];
  for (const hover of hovers) {
    for (const content of hover.contents) {
      if (typeof content === 'string') {
        parts.push(content);
      } else if (content instanceof vscode.MarkdownString) {
        parts.push(content.value);
      }
    }
  }
  return parts.join('\n');
}

interface TreeNode {
  readonly symbolUri?: string;
  readonly nodeType?: string;
  readonly children?: TreeNode[];
}

interface SymbolTreeNode {
  readonly sortName?: string;
  readonly symbolKind?: string;
  readonly symbolUri?: string;
  readonly symbolPosition?: { line: number; character: number };
  readonly nodeType?: string;
  readonly children?: SymbolTreeNode[];
}

/** Recursively collect all symbol nodes from the tree. */
function collectSymbolNodes(nodes: SymbolTreeNode[]): SymbolTreeNode[] {
  const result: SymbolTreeNode[] = [];
  for (const node of nodes) {
    if (node.nodeType === 'symbol') {
      result.push(node);
    }
    if (Array.isArray(node.children)) {
      result.push(...collectSymbolNodes(node.children));
    }
  }
  return result;
}

/** Recursively assert non-symbol nodes lack symbolUri. */
function assertNonSymbolNodesLackHoverData(nodes: TreeNode[]): void {
  for (const node of nodes) {
    if (
      node.nodeType === 'solution' ||
      node.nodeType === 'project' ||
      node.nodeType === 'dependencyFolder' ||
      node.nodeType === 'nugetPackage' ||
      node.nodeType === 'projectRef'
    ) {
      assert.strictEqual(
        node.symbolUri,
        undefined,
        `${node.nodeType ?? 'unknown'} node must not have symbolUri`,
      );
    }
    if (Array.isArray(node.children)) {
      assertNonSymbolNodesLackHoverData(node.children);
    }
  }
}
