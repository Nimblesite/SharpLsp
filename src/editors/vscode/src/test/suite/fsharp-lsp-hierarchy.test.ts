import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import { codeLensesFor } from './code-lens-kit';
import { openFSharpFixture, positionOf } from './fsharp-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/**
 * Blanket end-to-end coverage for F# code lens and call hierarchy.
 *
 * Neither is implemented in the F# sidecar yet, so these tests are EXPECTED to
 * fail until the handlers are built (drive via /fix-bug). C# has both; F# must
 * match and exceed.
 *
 * Spec: [SHARPLSP-FEATURES-CODE-LENS] (reference count, P1),
 * [SHARPLSP-FEATURES-NAVIGATION] (prepareCallHierarchy / incomingCalls /
 * outgoingCalls, P1), [SHARPLSP-FEATURES-FSHARP].
 *
 * "At least one lens came back" is the weakest possible claim: a provider that
 * returns one unresolved lens with no command, anchored nowhere in particular,
 * satisfies it and shows the user nothing. Every test here asserts WHERE the
 * lens sits, WHAT it says, and that the count it reports matches the call sites
 * in the committed fixture.
 */

/** The declarations in Library.fs that must each carry a reference lens. */
const LENSED_DECLARATIONS = ['area', 'totalArea', 'describeParity'];

suite('F# LSP — Code Lens', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('provides reference-count lenses on F# declarations', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — the provider answers for a real F# library file.
    const library = await openFSharpFixture('Library.fs');
    const lenses = await pollUntilResult(
      async () => codeLensesFor(library.uri),
      (items) => items.length >= 1,
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.ok(lenses.length >= 1, `Library.fs must expose ≥1 code lens, got ${lenses.length}`);
    assert.strictEqual(library.doc.languageId, 'fsharp', 'the fixture opens as F#');
    assert.ok(library.doc.lineCount > 30, 'and it is the committed multi-declaration fixture');

    // Interaction 2 — every lens is ANCHORED inside the document, on its own
    // line, and no two lenses claim the same anchor. A lens outside the buffer
    // renders nowhere; two on one line render on top of each other.
    for (const lens of lenses) {
      assert.ok(
        lens.range.end.line < library.doc.lineCount,
        `a lens at line ${lens.range.start.line} must sit inside the ${library.doc.lineCount}-line file`,
      );
      assert.ok(lens.range.start.isBeforeOrEqual(lens.range.end), 'and must not be inverted');
    }
    const anchors = lenses.map((lens) => `${lens.range.start.line}:${lens.range.start.character}`);
    assert.deepEqual([...new Set(anchors)], anchors, 'no two lenses may share an anchor');

    // Interaction 3 — [SHARPLSP-FEATURES-CODE-LENS] makes the reference count a
    // P1 feature. A lens with no resolved command is a blank line above the
    // declaration: it occupies the space and tells the user nothing.
    const resolved = lenses.filter((lens) => lens.isResolved || lens.command !== undefined);
    assert.ok(
      resolved.length >= 1,
      `at least one lens must resolve to a command; ${lenses.length} lenses, none resolved`,
    );
    const titles = resolved.map((lens) => lens.command?.title ?? '');
    assert.ok(
      titles.some((title) => /reference/i.test(title)),
      `a reference-count lens must say so; titles: ${titles.join(' | ')}`,
    );
    assert.ok(
      titles.every((title) => title.trim().length > 0),
      'and no resolved lens may carry an empty title',
    );

    // Interaction 4 — the lenses sit on the DECLARATIONS a user would expect,
    // not on arbitrary lines. F# is a first-class citizen: `area`, `totalArea`
    // and `describeParity` are exactly the shapes C# gets lenses for.
    const lensedText = lenses.map((lens) => library.doc.lineAt(lens.range.start.line).text);
    for (const declaration of LENSED_DECLARATIONS) {
      assert.ok(
        lensedText.some((line) => line.includes(`let ${declaration}`)),
        `'${declaration}' must carry a lens; lensed lines: ${lensedText.join(' | ')}`,
      );
    }
    assert.ok(
      lenses.length >= LENSED_DECLARATIONS.length,
      `at least one lens per lensed declaration, got ${lenses.length}`,
    );
  });
});

suite('F# LSP — Call Hierarchy', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('prepares a call hierarchy item and resolves incoming calls', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    // Interaction 1 — preparing on `double` yields the item the hierarchy view
    // is rooted at.
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
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.ok(items.length > 0, 'call hierarchy must prepare an item for the double function');
    assert.strictEqual(items.length, 1, 'one binding under the caret, one root item');

    // Interaction 2 — the root item DESCRIBES `double`: its own name, its own
    // file, and a selection range covering the identifier the user clicked. An
    // item whose range points elsewhere navigates away from the symbol.
    const root = items[0];
    assert.ok(root, 'the prepared item must be readable');
    assert.strictEqual(root.name, 'double', `the item names the binding, got '${root.name}'`);
    assert.strictEqual(
      root.uri.toString(),
      usage.uri.toString(),
      'and points at the file the caret was in',
    );
    assert.strictEqual(
      usage.doc.getText(root.selectionRange),
      'double',
      'with a selection range over the identifier alone',
    );
    assert.ok(root.range.contains(root.selectionRange), 'and a range containing it');

    // Interaction 3 — incoming calls. `double` is called twice inside
    // `quadruple` and once by `answer`, so a hierarchy reporting nothing is the
    // feature being absent, and one reporting a single call has lost a site.
    const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      'vscode.provideIncomingCalls',
      root,
    );
    const calls = incoming ?? [];
    assert.ok(calls.length >= 1, 'double must have ≥1 incoming call (from quadruple)');
    const callers = calls.map((call) => call.from.name);
    assert.ok(
      callers.includes('quadruple'),
      `quadruple calls double; callers: ${callers.join(', ')}`,
    );
    assert.deepEqual([...new Set(callers)], callers, 'no caller may be reported twice');

    // Interaction 4 — every reported call site is a real one: inside the file,
    // covering the `double` identifier, and there are two of them inside
    // `quadruple` (`double (double value)`).
    const fromQuadruple = calls.find((call) => call.from.name === 'quadruple');
    assert.ok(fromQuadruple, 'the quadruple caller must be readable');
    assert.ok(
      fromQuadruple.fromRanges.length >= 2,
      `quadruple calls double twice; got ${fromQuadruple.fromRanges.length} site(s)`,
    );
    for (const range of fromQuadruple.fromRanges) {
      assert.strictEqual(
        usage.doc.getText(range),
        'double',
        'each call site covers the identifier alone',
      );
      assert.ok(range.end.line < usage.doc.lineCount, 'and lands inside the document');
    }

    // Interaction 5 — the hierarchy walks the OTHER way too. Outgoing calls
    // from `quadruple` must reach `double`, or the view expands in one
    // direction only ([SHARPLSP-FEATURES-NAVIGATION] lists both as P1).
    const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      'vscode.provideOutgoingCalls',
      fromQuadruple.from,
    );
    const targets = (outgoing ?? []).map((call) => call.to.name);
    assert.ok(
      targets.includes('double'),
      `quadruple's outgoing calls must include double; got: ${targets.join(', ')}`,
    );
    assert.ok((outgoing ?? []).length >= 1, 'and there must be at least one outgoing call');
  });
});
