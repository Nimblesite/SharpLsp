// Real-world F# stress suite: demystifyfp/FsToolkit.ErrorHandling @ 5.2.0 (pinned).
//
// F# is first-class in SharpLsp — this suite drives the F# sidecar (FCS)
// against a real, popular F# codebase with the same interaction breadth as
// the C# suites: symbols, hover, navigation, completion, live edits,
// diagnostics, plus server memory/CPU bounds.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  FSTOOLKIT,
  assertSaneRange,
  openRepoFile,
  positionOf,
  waitForError,
  waitForErrorsCleared,
} from './real-repo-helpers';
import {
  type Anchor,
  assertHoverStorm,
  assertStructure,
  assertSurvivesStorm,
  completeAfterProbe,
  completionLabels,
  useRealRepo,
  assertSymbolSurface,
  assertDefinitionIn,
  assertReferencesSpan,
} from './real-repo-kit';
import { waitForDocumentSymbols } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

const RESULT_FS = 'src/FsToolkit.ErrorHandling/Result.fs';
const ASYNC_RESULT_FS = 'src/FsToolkit.ErrorHandling/AsyncResult.fs';
const MAP: Anchor = ['let inline map', 'map'];

suite('Real repo stress — FsToolkit.ErrorHandling (F#)', () => {
  const repoDir = useRealRepo(FSTOOLKIT, RESULT_FS, MAP);

  test('document symbols: the Result module maps its combinators', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), RESULT_FS);
    await assertSymbolSurface(doc, {
      container: 'Result',
      members: ['map', 'mapError', 'bind'],
      minNames: 15,
      minChildren: 10,
    });
  });

  test('hover storm: F# combinators produce signature-bearing markdown', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), RESULT_FS);
    await assertHoverStorm(doc, [
      MAP,
      ['let inline mapError', 'mapError'],
      ['module Result =', 'Result'],
    ]);
  });

  test('navigation: AsyncResult.fs threads back into Result.fs across files', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri } = await openRepoFile(repoDir(), ASYNC_RESULT_FS);
    await waitForDocumentSymbols(uri, LSP_RESPONSE_MS);
    const usage = positionOf(doc, 'Async.map (Result.map mapper) input', 'Result.map');
    const mapFocus = usage.with({ character: usage.character + 'Result.'.length });
    await assertDefinitionIn(uri, mapFocus, RESULT_FS, 'map');
    // Result.map is referenced widely, across multiple F# files.
    await assertReferencesSpan(uri, mapFocus, 2, 2);
  });

  test('live edit + completion: Result module members appear after typing', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, editor } = await openRepoFile(repoDir(), RESULT_FS);
    const probe = '\n    let __sharpLspProbe input = Result.';
    const end = doc.positionAt(doc.getText().length);
    const completions = await completeAfterProbe(editor, end, probe, 'mapError');
    const labels = completionLabels(completions);
    for (const expected of ['map', 'mapError', 'bind']) {
      assert.ok(labels.has(expected), `completion after 'Result.' must offer ${expected}`);
    }
    assert.ok(completions.items.length >= 5, 'the module must offer a real member list');
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
  // canonical overlay-aware check ([HOVER-FSHARP-OVERLAY]).
  test('diagnostics round-trip: an F# type error surfaces and clears', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri, editor } = await openRepoFile(repoDir(), RESULT_FS);
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
      const error = await waitForError(uri, LSP_RESPONSE_MS);
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
    await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
  });

  test('structure storm: folding, selection ranges, workspace symbols for F#', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), RESULT_FS);
    await assertStructure(doc, { minFolds: 5, anchor: MAP, minDepth: 1, query: 'Result' });
  });

  test('stress: rapid-fire mixed requests stay within memory/CPU bounds', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), RESULT_FS);
    await assertSurvivesStorm(doc, MAP, 15_000);
  });
});
