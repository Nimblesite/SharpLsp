// The interactions every real-repo stress suite drives the same way: suite
// lifecycle, hover storms, navigation and completion polls, the structure
// checks and the rapid-fire resource storm. Each suite supplies only its
// repo's anchors and thresholds.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hoverText } from './fsharp-helpers';
import { symbolNamed } from './lsp-invariants-kit';
import {
  type RealRepoSpec,
  assertCpuSettles,
  assertSaneRange,
  firstLocation,
  assertServerResourceBounds,
  completionLabel,
  ensureRepoReady,
  fixtureSolutionPath,
  loadSolutionInServer,
  openRepoFile,
  positionOf,
  sampleServerProcesses,
  selectionDepth,
  waitForSemanticReady,
} from './real-repo-helpers';
import {
  closeAllEditors,
  pollUntilResult,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  waitForHoverResult,
  waitForSelectionRanges,
  pollProvider,
  flattenSymbolNames,
  assertContainsAll,
} from './test-helpers';
import { ACTIVATION_MS, LSP_RESPONSE_MS, REAL_REPO_MS, REAL_REPO_WARMUP_MS } from './test-timeouts';

/** A `[snippet, focus]` pair: `focus` is the identifier inside `snippet`. */
export type Anchor = readonly [snippet: string, focus: string];

/**
 * Clone, restore and load `spec`, then wait until `file` answers SEMANTIC
 * hover at `ready`. Teardown puts the fixture solution back, because
 * downstream suites rely on its semantics. Returns the clone directory.
 */
export function useRealRepo(
  spec: RealRepoSpec,
  file: string,
  [snippet, focus]: Anchor,
): () => string {
  let repoDir = '';
  suiteSetup(async function () {
    this.timeout(REAL_REPO_MS);
    repoDir = ensureRepoReady(spec);
    await loadSolutionInServer(path.join(repoDir, spec.sln));
    const { doc, uri } = await openRepoFile(repoDir, file);
    await waitForDocumentSymbols(uri, REAL_REPO_WARMUP_MS);
    await waitForSemanticReady(uri, positionOf(doc, snippet, focus), REAL_REPO_WARMUP_MS);
  });
  suiteTeardown(async function () {
    this.timeout(ACTIVATION_MS);
    await closeAllEditors();
    await loadSolutionInServer(fixtureSolutionPath());
  });
  return () => repoDir;
}

/** Every anchor's hover must be non-empty and mention its focus. */
export async function assertHoverStorm(
  doc: vscode.TextDocument,
  anchors: readonly Anchor[],
  matchCase = false,
): Promise<void> {
  const fold = (text: string): string => (matchCase ? text : text.toLowerCase());
  for (const [snippet, focus] of anchors) {
    const hover = await waitForHoverResult(
      doc.uri,
      positionOf(doc, snippet, focus),
      LSP_RESPONSE_MS,
    );
    const text = hoverText(hover);
    assert.ok(text.length > 0, `hover on '${focus}' must not be empty`);
    assert.ok(
      fold(text).includes(fold(focus)),
      `hover on '${focus}' must mention it, got: ${text.slice(0, 200)}`,
    );
  }
}

/** Poll a location provider at `position` until it returns at least `min` locations. */
export function pollLocations(
  provider: 'vscode.executeDefinitionProvider' | 'vscode.executeReferenceProvider',
  uri: vscode.Uri,
  position: vscode.Position,
  min: number,
): Promise<vscode.Location[]> {
  return pollProvider<vscode.Location>(
    provider,
    [uri, position],
    (locations) => locations.length >= min,
    LSP_RESPONSE_MS,
    2_000,
  );
}

/**
 * Insert `probe` at `at`, poll completion at its end until `awaited` is
 * offered, then undo. The list is returned for the caller's assertions.
 */
export async function completeAfterProbe(
  editor: vscode.TextEditor,
  at: vscode.Position,
  probe: string,
  awaited: string,
): Promise<vscode.CompletionList> {
  const doc = editor.document;
  const applied = await editor.edit((edit) => {
    edit.insert(at, probe);
  });
  assert.ok(applied, 'probe edit must apply');
  try {
    const cursor = doc.positionAt(doc.getText().indexOf(probe) + probe.length);
    return await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          doc.uri,
          cursor,
          '.',
        )) ?? new vscode.CompletionList(),
      (list) => list.items.some((item) => completionLabel(item) === awaited),
      LSP_RESPONSE_MS,
      2_000,
    );
  } finally {
    await vscode.commands.executeCommand('undo');
  }
}

/** The labels a completion list offers. */
export function completionLabels(list: vscode.CompletionList): Set<string> {
  return new Set(list.items.map(completionLabel));
}

/**
 * The structure storm: `doc` folds at least `minFolds` ordered, in-file
 * ranges; the selection at `anchor` expands at least `minDepth` times; and a
 * workspace-symbol search for `query`, when given, finds it.
 */
export async function assertStructure(
  doc: vscode.TextDocument,
  { minFolds, anchor, minDepth, query }: StructureExpectation,
): Promise<void> {
  const folding = await waitForFoldingRanges(doc.uri, LSP_RESPONSE_MS);
  const file = path.basename(doc.fileName);
  assert.ok(folding.length >= minFolds, `${file} must fold, got ${folding.length.toString()}`);
  for (const range of folding.slice(0, 10)) {
    assert.ok(range.start <= range.end, 'folding range must be ordered');
    assert.ok(range.end < doc.lineCount, 'folding range must stay in the file');
  }
  const [snippet, focus] = anchor;
  const selections = await waitForSelectionRanges(
    doc.uri,
    [positionOf(doc, snippet, focus)],
    LSP_RESPONSE_MS,
  );
  const depth = selectionDepth(selections[0], `${focus} selection`);
  assert.ok(depth >= minDepth, `selection range must expand, depth ${depth.toString()}`);
  if (query === undefined) return;
  const symbols = await pollProvider<vscode.SymbolInformation>(
    'vscode.executeWorkspaceSymbolProvider',
    [query],
    (found) => found.length > 0,
    LSP_RESPONSE_MS,
    2_000,
  );
  assert.ok(
    symbols.some((symbol) => symbol.name.includes(query)),
    `workspace symbol search must find ${query}`,
  );
}

export interface StructureExpectation {
  readonly minFolds: number;
  readonly anchor: Anchor;
  readonly minDepth: number;
  /** When set, a workspace-symbol search for it must find it. */
  readonly query?: string;
}

/**
 * Ten rounds of concurrent symbols + hover + folding must all answer; then
 * the server fleet must sit inside its resource bounds, its CPU must settle,
 * and symbols must still answer within `recoveryMs`.
 */
export async function assertSurvivesStorm(
  doc: vscode.TextDocument,
  [snippet, focus]: Anchor,
  recoveryMs: number,
): Promise<void> {
  const hoverAt = positionOf(doc, snippet, focus);
  for (let round = 0; round < 10; round += 1) {
    const answers = await Promise.all([
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
      ),
      vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        doc.uri,
        hoverAt,
      ),
      vscode.commands.executeCommand<vscode.FoldingRange[]>(
        'vscode.executeFoldingRangeProvider',
        doc.uri,
      ),
    ]);
    ['symbols', 'hover', 'folding'].forEach((feature, index) => {
      assert.ok(
        (answers[index] ?? []).length > 0,
        `round ${round.toString()}: ${feature} must keep answering`,
      );
    });
  }
  assertServerResourceBounds(sampleServerProcesses());
  await assertCpuSettles(5_000, 20);
  const after = await waitForDocumentSymbols(doc.uri, recoveryMs);
  assert.ok(after.length > 0, 'server must stay responsive after the storm');
}

/** What a file's outline must expose: `container` holding `members`, richly. */
export interface SymbolSurface {
  readonly container: string;
  readonly members: readonly string[];
  readonly minNames: number;
  readonly minChildren: number;
}

/**
 * `doc`'s outline names `container` and every one of `members`, is rich, and
 * nests `container`'s first members inside it on sane ranges.
 */
export async function assertSymbolSurface(
  doc: vscode.TextDocument,
  { container, members, minNames, minChildren }: SymbolSurface,
): Promise<void> {
  const symbols = await waitForDocumentSymbols(doc.uri, LSP_RESPONSE_MS);
  const names = flattenSymbolNames(symbols);
  assertContainsAll(names, [container, ...members], `${path.basename(doc.fileName)} must expose`);
  assert.ok(
    names.length >= minNames,
    `expected a rich symbol tree, got ${names.length.toString()}`,
  );
  const owner = symbolNamed(symbols, container);
  assertSaneRange(doc, owner.range, `${container} range`);
  assert.ok(owner.children.length >= minChildren, `${container} must have many members`);
  for (const child of owner.children.slice(0, 10)) {
    assertSaneRange(doc, child.range, `member ${child.name}`);
    assert.ok(
      owner.range.contains(child.range),
      `member ${child.name} must nest inside ${container}`,
    );
  }
}

/**
 * Go to definition at `at` lands in `file` (a repo-relative path), on a sane
 * range that covers `identifier`.
 */
export async function assertDefinitionIn(
  uri: vscode.Uri,
  at: vscode.Position,
  file: string,
  identifier: string,
): Promise<void> {
  const definitions = await pollLocations('vscode.executeDefinitionProvider', uri, at, 1);
  const definition = firstLocation(definitions, `${identifier} definition`);
  const defPath = definition.uri.fsPath.replace(/\\/g, '/');
  assert.ok(defPath.endsWith(file), `definition must land in ${file}, got ${defPath}`);
  const defDoc = await vscode.workspace.openTextDocument(definition.uri);
  assertSaneRange(defDoc, definition.range, `${identifier} definition`);
  assert.ok(
    defDoc.getText(definition.range).includes(identifier),
    `the definition range must cover the ${identifier} identifier`,
  );
}

/** Find references at `at` returns at least `min`, spanning at least `minFiles` files. */
export async function assertReferencesSpan(
  uri: vscode.Uri,
  at: vscode.Position,
  min: number,
  minFiles: number,
): Promise<vscode.Location[]> {
  const references = await pollLocations('vscode.executeReferenceProvider', uri, at, min);
  assert.ok(
    references.length >= min,
    `expected ${min.toString()}+ references, got ${references.length.toString()}`,
  );
  const files = new Set(references.map((ref) => ref.uri.fsPath.replace(/\\/g, '/')));
  assert.ok(files.size >= minFiles, `references must span ${minFiles.toString()}+ files`);
  return references;
}
