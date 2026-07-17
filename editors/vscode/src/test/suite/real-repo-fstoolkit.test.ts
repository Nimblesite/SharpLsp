// Real-world F# stress suite: demystifyfp/FsToolkit.ErrorHandling @ 5.2.0 (pinned).
//
// F# is first-class in SharpLsp — this suite drives the F# sidecar (FCS)
// against a real, popular F# codebase with the same interaction breadth as
// the C# suites: symbols, hover, navigation, completion, live edits,
// diagnostics, plus server memory/CPU bounds.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hoverText } from './fsharp-helpers';
import {
  FSTOOLKIT,
  assertCpuSettles,
  assertSaneRange,
  assertServerResourceBounds,
  ensureRepoReady,
  completionLabel,
  firstLocation,
  fixtureSolutionPath,
  loadSolutionInServer,
  openRepoFile,
  positionOf,
  sampleServerProcesses,
  selectionDepth,
  waitForError,
  waitForErrorsCleared,
  waitForSemanticReady,
} from './real-repo-helpers';
import {
  closeAllEditors,
  flattenSymbolNames,
  pollUntilResult,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  waitForHoverResult,
  waitForSelectionRanges,
} from './test-helpers';

const RESULT_FS = 'src/FsToolkit.ErrorHandling/Result.fs';
const ASYNC_RESULT_FS = 'src/FsToolkit.ErrorHandling/AsyncResult.fs';

suite('Real repo stress — FsToolkit.ErrorHandling (F#)', () => {
  let repoDir: string;

  suiteSetup(async function () {
    this.timeout(900_000);
    repoDir = ensureRepoReady(FSTOOLKIT);
    await loadSolutionInServer(path.join(repoDir, FSTOOLKIT.sln));
    const { doc, uri } = await openRepoFile(repoDir, RESULT_FS);
    await waitForDocumentSymbols(uri, 180_000);
    await waitForSemanticReady(uri, positionOf(doc, 'let inline map', 'map'), 600_000);
  });

  suiteTeardown(async function () {
    this.timeout(120_000);
    await closeAllEditors();
    await loadSolutionInServer(fixtureSolutionPath());
  });

  test('document symbols: the Result module maps its combinators', async function () {
    this.timeout(180_000);
    const { doc, uri } = await openRepoFile(repoDir, RESULT_FS);
    const symbols = await waitForDocumentSymbols(uri, 180_000);
    const names = flattenSymbolNames(symbols);

    assert.ok(names.includes('Result'), 'Result module must be present');
    for (const combinator of ['map', 'mapError', 'bind']) {
      assert.ok(names.includes(combinator), `Result module must expose ${combinator}`);
    }
    assert.ok(names.length >= 15, `expected a rich F# symbol tree, got ${names.length.toString()}`);

    const resultModule = symbols
      .flatMap((symbol) => [symbol, ...symbol.children])
      .find((symbol) => symbol.name === 'Result');
    assert.ok(resultModule, 'Result module symbol resolvable');
    assertSaneRange(doc, resultModule.range, 'Result module range');
    assert.ok(resultModule.children.length >= 10, 'Result module must have many members');
    for (const child of resultModule.children.slice(0, 10)) {
      assert.ok(
        resultModule.range.contains(child.range),
        `member ${child.name} must nest inside the Result module`,
      );
    }
  });

  test('hover storm: F# combinators produce signature-bearing markdown', async function () {
    this.timeout(240_000);
    const { doc, uri } = await openRepoFile(repoDir, RESULT_FS);
    const anchors: [string, string][] = [
      ['let inline map', 'map'],
      ['let inline mapError', 'mapError'],
      ['module Result =', 'Result'],
    ];
    for (const [snippet, focus] of anchors) {
      const hover = await waitForHoverResult(uri, positionOf(doc, snippet, focus), 120_000);
      const text = hoverText(hover);
      assert.ok(text.length > 0, `hover on '${focus}' must not be empty`);
      assert.ok(
        text.toLowerCase().includes(focus.toLowerCase()),
        `hover on '${focus}' must mention it, got: ${text.slice(0, 200)}`,
      );
    }
  });

  test('navigation: AsyncResult.fs threads back into Result.fs across files', async function () {
    this.timeout(240_000);
    const { doc, uri } = await openRepoFile(repoDir, ASYNC_RESULT_FS);
    await waitForDocumentSymbols(uri, 180_000);
    const usage = positionOf(doc, 'Async.map (Result.map mapper) input', 'Result.map');
    const mapFocus = usage.with({ character: usage.character + 'Result.'.length });

    const definitions = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          uri,
          mapFocus,
        )) ?? [],
      (locations) => locations.length > 0,
      180_000,
      2_000,
    );
    const definition = firstLocation(definitions, 'Result.map definition');
    const defPath = definition.uri.fsPath.replace(/\\/g, '/');
    assert.ok(defPath.endsWith(RESULT_FS), `definition must land in Result.fs, got ${defPath}`);
    const defDoc = await vscode.workspace.openTextDocument(definition.uri);
    assertSaneRange(defDoc, definition.range, 'Result.map definition');

    const references = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          uri,
          mapFocus,
        )) ?? [],
      (locations) => locations.length >= 2,
      180_000,
      2_000,
    );
    assert.ok(
      references.length >= 2,
      `Result.map must be referenced widely, got ${references.length.toString()}`,
    );
    const files = new Set(references.map((ref) => ref.uri.fsPath.replace(/\\/g, '/')));
    assert.ok(files.size >= 2, 'references must span multiple F# files');
  });

  test('live edit + completion: Result module members appear after typing', async function () {
    this.timeout(240_000);
    const { doc, uri, editor } = await openRepoFile(repoDir, RESULT_FS);
    const probe = '\n    let __sharpLspProbe input = Result.';
    const insertAt = doc.positionAt(doc.getText().length);
    const applied = await editor.edit((edit) => {
      edit.insert(insertAt, probe);
    });
    assert.ok(applied, 'probe edit must apply');

    try {
      const cursor = doc.positionAt(doc.getText().indexOf(probe) + probe.length);
      const completions = await pollUntilResult(
        async () =>
          (await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            uri,
            cursor,
            '.',
          )) ?? new vscode.CompletionList(),
        (list) => list.items.some((item) => completionLabel(item) === 'mapError'),
        180_000,
        2_000,
      );
      const labels = new Set(completions.items.map(completionLabel));
      for (const expected of ['map', 'mapError', 'bind']) {
        assert.ok(labels.has(expected), `completion after 'Result.' must offer ${expected}`);
      }
      assert.ok(completions.items.length >= 5, 'the module must offer a real member list');
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    assert.ok(!doc.getText().includes('__sharpLspProbe'), 'undo must restore the pristine file');
  });

  // Tracks #160: an F# error must clear after the edit is reverted. Root
  // cause (probe-verified against this very repo): NuGet `_._` placeholder
  // files — path-qualified in project.assets.json (`lib/netstandard1.0/_._`,
  // netstandard.library) — were handed to FCS as `-r:` references, attaching
  // standing FS0229/FS3160 Errors to every checked file; no edit could ever
  // clear them. Fixed in FSharpAssets ([PKG-ASSETS-FS]) by filtering the
  // filename component. The investigation also hardened the push pipeline
  // ([DIAG-PUSH-GATE]) and funneled every F# per-file analysis through one
  // canonical overlay-aware check ([FS-DIDCHANGE-OVERLAY]).
  test('diagnostics round-trip: an F# type error surfaces and clears', async function () {
    this.timeout(420_000);
    const { doc, uri, editor } = await openRepoFile(repoDir, RESULT_FS);
    const pristineLength = doc.getText().length;
    const probe = '\n    let __sharpLspBad: int = "not an int"\n';
    const applied = await editor.edit((edit) => {
      edit.insert(doc.positionAt(pristineLength), probe);
    });
    assert.ok(applied, 'error-inducing edit must apply');

    try {
      // Severity-aware wait: real-world files carry standing hints (unused
      // opens, lint), so waiting for *any* diagnostic returns before the
      // semantic check of the injected error completes.
      const error = await waitForError(uri, 180_000);
      assert.ok(error.message.length > 0, 'diagnostic must carry a message');
      assertSaneRange(doc, error.range, 'F# error diagnostic');
    } finally {
      // Deterministic revert: delete the exact inserted tail (undo can race
      // with the checker's in-flight didChange handling).
      const reverted = await editor.edit((edit) => {
        edit.delete(
          new vscode.Range(doc.positionAt(pristineLength), doc.positionAt(doc.getText().length)),
        );
      });
      assert.ok(reverted, 'revert edit must apply');
    }
    assert.strictEqual(doc.getText().length, pristineLength, 'file restored to pristine length');
    // FCS re-checks the whole dependent project graph for Result.fs — give it
    // a realistic window on a cold cache.
    await waitForErrorsCleared(uri, 300_000);
  });

  test('structure storm: folding, selection ranges, workspace symbols for F#', async function () {
    this.timeout(240_000);
    const { doc, uri } = await openRepoFile(repoDir, RESULT_FS);
    const folding = await waitForFoldingRanges(uri, 120_000);
    assert.ok(folding.length >= 5, `Result.fs must fold, got ${folding.length.toString()}`);
    for (const range of folding.slice(0, 10)) {
      assert.ok(range.start <= range.end, 'folding range must be ordered');
      assert.ok(range.end < doc.lineCount, 'folding range must stay in the file');
    }

    const selections = await waitForSelectionRanges(
      uri,
      [positionOf(doc, 'let inline map', 'map')],
      120_000,
    );
    const depth = selectionDepth(selections[0], 'F# map selection');
    assert.ok(depth >= 1, `selection range must expand at least once, depth ${depth.toString()}`);

    const workspaceSymbols = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          'Result',
        )) ?? [],
      (symbols) => symbols.length > 0,
      180_000,
      2_000,
    );
    assert.ok(
      workspaceSymbols.some((symbol) => symbol.name.includes('Result')),
      'workspace symbol search must find Result symbols in F#',
    );
  });

  test('stress: rapid-fire mixed requests stay within memory/CPU bounds', async function () {
    this.timeout(300_000);
    const { doc, uri } = await openRepoFile(repoDir, RESULT_FS);
    const hoverAt = positionOf(doc, 'let inline map', 'map');

    for (let round = 0; round < 10; round += 1) {
      const [symbols, hover, folding] = await Promise.all([
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          uri,
        ),
        vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, hoverAt),
        vscode.commands.executeCommand<vscode.FoldingRange[]>(
          'vscode.executeFoldingRangeProvider',
          uri,
        ),
      ]);
      assert.ok(
        (symbols ?? []).length > 0,
        `round ${round.toString()}: F# symbols must keep answering`,
      );
      assert.ok(
        (hover ?? []).length > 0,
        `round ${round.toString()}: F# hover must keep answering`,
      );
      assert.ok(
        (folding ?? []).length > 0,
        `round ${round.toString()}: F# folding must keep answering`,
      );
    }

    assertServerResourceBounds(sampleServerProcesses());
    await assertCpuSettles(5_000, 20);
    const after = await waitForDocumentSymbols(uri, 15_000);
    assert.ok(after.length > 0, 'F# server must stay responsive after the storm');
  });
});
