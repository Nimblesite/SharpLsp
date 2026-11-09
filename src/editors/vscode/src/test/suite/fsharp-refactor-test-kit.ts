import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateRealSharpLsp,
  applyWorkspaceEdit,
  revertDocument,
  waitForCodeActions,
  waitForMatchingDiagnostics,
  waitForResolvedCodeActions,
  type OpenFixture,
  type WorkspaceEditSnapshot,
} from './refactor-test-helpers';
import { requireAt } from './test-helpers';
import {
  assertOverlayUnchanged,
  openOverlay,
  tokenRange,
  undoAction,
  withOverlay,
  type OverlayText,
} from './fsharp-rename-test-kit';
import { LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';
import { diagnosticCode } from './document-anchors';

// Assertion helpers shared by the real-LSP F# suites. [ANALYZERS-FSAC-PARITY]

export * from './fsharp-rename-test-kit';
export type { PrepareRenameResult } from './refactor-test-helpers';

/** An Error-severity diagnostic. */
export function isErrorDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  return diagnostic.severity === vscode.DiagnosticSeverity.Error;
}

/** A Mocha test body that runs `operation` under the real-LSP response budget. */
export function underLspBudget(operation: () => Promise<void>): () => Promise<void> {
  return async function (this: Mocha.Context): Promise<void> {
    this.timeout(LSP_RESPONSE_MS + 5_000);
    await operation();
  };
}

/** `line:CODE message` for every Error diagnostic — empty means the document is clean. */
export function errorLabels(diagnostics: readonly vscode.Diagnostic[]): string[] {
  return diagnostics
    .filter(isErrorDiagnostic)
    .map((item) => `${item.range.start.line}:${diagnosticCode(item)} ${item.message}`);
}

/** `uri`'s diagnostics as `[severity/code@line:char] message`, for failure messages. */
export function diagnosticSummary(uri: vscode.Uri): string {
  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (diagnostics.length === 0) return '<none>';
  return diagnostics
    .map((item) => {
      const start = `${item.range.start.line}:${item.range.start.character}`;
      return `[${item.severity}/${String(item.code ?? 'none')}@${start}] ${item.message}`;
    })
    .join(' | ');
}

/** `uri`'s diagnostics once none of them is an Error. */
async function withoutErrors(uri: vscode.Uri): Promise<vscode.Diagnostic[]> {
  return waitForMatchingDiagnostics(
    uri,
    (diagnostics) => errorLabels(diagnostics).length === 0,
    LSP_RESPONSE_MS,
  );
}

/** Wait until `uri` carries no Error diagnostics, failing with the ones that remain. */
export async function assertNoErrorDiagnostics(uri: vscode.Uri): Promise<void> {
  try {
    assert.deepStrictEqual(errorLabels(await withoutErrors(uri)), []);
  } catch (error: unknown) {
    assert.fail(`diagnostics for ${uri.fsPath}: ${diagnosticSummary(uri)}; wait=${String(error)}`);
  }
}

export async function diagnosticWithCode(
  uri: vscode.Uri,
  code: string,
  range?: vscode.Range,
  timeoutMs: number = LSP_RESPONSE_MS,
): Promise<vscode.Diagnostic[]> {
  // `range` exists so the WAIT can be as strong as the caller's assertion.
  // Waiting only for the code and then asserting on the location is a race FCS
  // wins regularly: it publishes a diagnostic carrying that code somewhere else
  // in the file first, the wait succeeds on a set that has not yet reached the
  // range under test, and the assertion fails on timing rather than on
  // behaviour ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
  return waitForMatchingDiagnostics(
    uri,
    (diagnostics) =>
      diagnostics.some(
        (diagnostic) =>
          diagnosticCode(diagnostic) === code &&
          (range === undefined || diagnostic.range.intersection(range) !== undefined),
      ),
    timeoutMs,
  );
}

/**
 * Activate SharpLsp and pay FCS's cold start ONCE, on an overlay known to
 * produce `code`. The first F# check of the process cracks the project and can
 * outrun `LSP_RESPONSE_MS` on a CI agent; charged to a test body it fails the
 * first scenario on timing alone ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 */
export async function activateWarmFSharp(
  relativePath: string,
  source: string,
  code: string,
): Promise<void> {
  await activateRealSharpLsp();
  const fixture = await openOverlay(relativePath, source);
  try {
    await diagnosticWithCode(fixture.uri, code, undefined, SIDECAR_COLD_MS);
  } finally {
    await revertDocument(fixture.document);
  }
}

/**
 * Wait until `code` has cleared AND the document carries no error diagnostics.
 *
 * `diagnosticGone` is satisfied the instant ONE code disappears - which is not
 * the same as the server having finished republishing for the content it was
 * just handed. Every generation and conversion spec overlays the SAME file
 * (`fsharp/DiagnosticsTarget.fs`), so a caller that then asserts the document is
 * error-free can read a STALE error belonging to the PREVIOUS overlay.
 *
 * That is what failed on Windows: the exhaustive-DU spec, whose source is a
 * two-case union and a complete match, was charged with
 * `FS0366 No implementation was given for 'abstract IShape.Area'` - a
 * diagnostic for an interface its own source does not contain. Ubuntu
 * republished fast enough to hide it.
 *
 * The named code is still required to clear, because it is often a WARNING
 * (FS0025) that the error filter alone would not catch.
 */
export async function diagnosticsSettled(
  uri: vscode.Uri,
  code: string,
): Promise<vscode.Diagnostic[]> {
  return waitForMatchingDiagnostics(
    uri,
    (diagnostics) =>
      diagnostics.every((diagnostic) => diagnosticCode(diagnostic) !== code) &&
      errorLabels(diagnostics).length === 0,
    LSP_RESPONSE_MS,
  );
}

export async function diagnosticGone(uri: vscode.Uri, code: string): Promise<vscode.Diagnostic[]> {
  return waitForMatchingDiagnostics(
    uri,
    (diagnostics) => diagnostics.every((diagnostic) => diagnosticCode(diagnostic) !== code),
    LSP_RESPONSE_MS,
  );
}

export async function quickFixes(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<vscode.CodeAction[]> {
  return waitForCodeActions({
    uri,
    range,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: () => true,
    timeoutMs: LSP_RESPONSE_MS,
  });
}

/** `range`'s quick fixes, proven not to contain `title`; returns the rest. */
export async function quickFixesWithout(
  uri: vscode.Uri,
  range: vscode.Range,
  title: string,
): Promise<vscode.CodeAction[]> {
  const actions = await quickFixes(uri, range);
  assertNoAction(actions, title);
  return actions;
}

/** Neither `title` nor any `Generate …` stub is offered on `range`. */
export async function assertNoGeneratedFixes(
  uri: vscode.Uri,
  range: vscode.Range,
  title: string,
): Promise<void> {
  const actions = await quickFixesWithout(uri, range, title);
  assert.ok(!actions.some((action) => action.title.startsWith('Generate ')));
}

export async function resolvedQuickFixes(
  uri: vscode.Uri,
  range: vscode.Range,
  title: string,
): Promise<vscode.CodeAction[]> {
  return waitForResolvedCodeActions({
    uri,
    range,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: (actions) => actions.some((action) => action.title === title),
    timeoutMs: LSP_RESPONSE_MS,
  });
}

export async function applyAction(action: vscode.CodeAction): Promise<WorkspaceEditSnapshot[]> {
  assert.ok(action.edit, `${action.title} must have an edit before application`);
  return applyWorkspaceEdit(action.edit);
}

/** Apply `action` to `fixture` alone and prove the overlay advanced and stays unsaved. */
export async function applyToOverlay(
  fixture: OpenFixture,
  action: vscode.CodeAction,
): Promise<WorkspaceEditSnapshot[]> {
  const version = fixture.document.version;
  const snapshots = await applyAction(action);
  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0]?.uri.toString(), fixture.uri.toString());
  assert.ok(fixture.document.version > version, 'the edit must reach the overlay');
  assert.ok(fixture.document.isDirty, 'the overlay must stay unsaved');
  return snapshots;
}

/** Apply `edit`, then prove every `site` holds its text, stays unsaved, and is error-free. */
export async function applyAndVerify(
  edit: vscode.WorkspaceEdit,
  sites: readonly OverlayText[],
): Promise<void> {
  await applyWorkspaceEdit(edit);
  for (const site of sites) assertOverlayUnchanged(site.fixture.document, site.expected);
  await Promise.all(sites.map((site) => assertNoErrorDiagnostics(site.fixture.uri)));
}

/**
 * Apply `action` to the unsaved overlay and prove the fix took: one file
 * edited into exactly `expected`, still unsaved, `diagnostic` gone, and the
 * fix no longer offered at `target`. [ANALYZERS-FSAC-PARITY]
 */
export async function assertFixApplied(
  fixture: OpenFixture,
  action: vscode.CodeAction,
  expected: string,
  diagnostic: string,
  target: string,
): Promise<void> {
  await applyToOverlay(fixture, action);
  assert.strictEqual(fixture.document.getText(), expected);
  await diagnosticGone(fixture.uri, diagnostic);
  await quickFixesWithout(fixture.uri, tokenRange(fixture.document, target), action.title);
}

/** `action` is a quick fix titled `title`, offered (or not) as preferred. */
function assertQuickFixIdentity(
  action: vscode.CodeAction,
  title: string,
  preferred: boolean,
): void {
  assert.strictEqual(action.title, title);
  assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.strictEqual(action.isPreferred, preferred);
}

/** `actions` holds exactly one action titled `title`. */
export function uniqueAction(
  actions: readonly vscode.CodeAction[],
  title: string,
): vscode.CodeAction {
  const matches = actions.filter((action) => action.title === title);
  assert.strictEqual(matches.length, 1, `expected one ${title}; got ${matches.length}`);
  return requireAt(matches, 0, title);
}

/** A RESOLVED quick fix: `title`, `preferred`, and an edit that already carries its change. */
export function assertQuickFix(action: vscode.CodeAction, title: string, preferred: boolean): void {
  assertQuickFixIdentity(action, title, preferred);
  assert.ok(action.edit, `${title} must resolve to a WorkspaceEdit`);
}

export function singleEdit(action: vscode.CodeAction, uri: vscode.Uri): vscode.TextEdit {
  assert.ok(action.edit, `${action.title} must have a resolved edit`);
  const edits = action.edit.get(uri);
  assert.strictEqual(edits.length, 1, `${action.title} must produce one edit`);
  const edit = edits[0];
  assert.ok(edit, `${action.title} edit must exist`);
  return edit;
}

export function assertInsertion(edit: vscode.TextEdit, expected: string): void {
  assert.strictEqual(edit.newText, expected);
  assert.ok(edit.range.isEmpty, 'insertion must have a zero-width range');
  assert.strictEqual(edit.range.start.line, edit.range.end.line);
  assert.strictEqual(edit.range.start.character, edit.range.end.character);
}

export function assertReplacement(
  document: vscode.TextDocument,
  edit: vscode.TextEdit,
  before: string,
  after: string,
): void {
  assert.strictEqual(document.getText(edit.range), before);
  assert.strictEqual(edit.newText, after);
  assert.ok(!edit.range.isEmpty, 'replacement must cover source text');
}

export function assertNoAction(actions: readonly vscode.CodeAction[], title: string): void {
  assert.ok(!actions.some((action) => action.title === title), `${title} must not be offered`);
}

/** Where a quick fix is exercised: the overlay, the token it fixes, and what it answers. */
export interface QuickFixSite {
  readonly source: string;
  readonly target: string;
  readonly occurrence?: number;
  readonly title: string;
  readonly diagnostic: string;
}

/** The `code` diagnostics: published, one ON `range`, each worded, each from the F# sidecar. */
export function assertSidecarDiagnostics(
  diagnostics: readonly vscode.Diagnostic[],
  range: vscode.Range,
  code: string,
): vscode.Diagnostic[] {
  const matches = diagnostics.filter((item) => diagnosticCode(item) === code);
  assert.ok(matches.length >= 1, `${code} must be published`);
  assert.ok(matches.some((item) => item.range.intersection(range) !== undefined));
  assert.ok(matches.every((item) => item.message.trim().length > 0));
  assert.ok(matches.every((item) => item.source === 'sharplsp-fsharp'));
  return matches;
}

/** A LISTED quick fix: still unresolved, and an edit rather than a command. */
function assertListedQuickFix(action: vscode.CodeAction, title: string, preferred: boolean): void {
  assertQuickFixIdentity(action, title, preferred);
  assert.strictEqual(action.edit, undefined, 'listed action must remain unresolved');
  assert.strictEqual(action.command, undefined, 'quick fix must use an edit, not a command');
}

/**
 * List then resolve the quick fix `site` names on `range`: its diagnostic sits
 * there, the listing offers it once and unresolved, the `sentinel` binding
 * outside it never does, and it resolves to an edit. `refine` adds the
 * caller's own checks on the diagnostics that drove it. [ANALYZERS-FSAC-PARITY]
 */
export async function inspectQuickFix(
  fixture: OpenFixture,
  range: vscode.Range,
  site: QuickFixSite,
  preferred: boolean,
  refine: (matches: readonly vscode.Diagnostic[]) => void = () => undefined,
): Promise<vscode.CodeAction> {
  const diagnostics = await diagnosticWithCode(fixture.uri, site.diagnostic, range);
  refine(assertSidecarDiagnostics(diagnostics, range, site.diagnostic));
  assertListedQuickFix(
    uniqueAction(await quickFixes(fixture.uri, range), site.title),
    site.title,
    preferred,
  );
  const outside = await quickFixes(fixture.uri, tokenRange(fixture.document, 'sentinel'));
  assertNoAction(outside, site.title);
  assert.ok(
    outside.every((action) => action.kind?.contains(vscode.CodeActionKind.QuickFix) ?? true),
  );
  const action = uniqueAction(await resolvedQuickFixes(fixture.uri, range, site.title), site.title);
  assertQuickFix(action, site.title, preferred);
  return action;
}

/** Undo restores `site.source`, its diagnostic returns, and the fix is offered again. */
export async function undoAndRequery(
  fixture: OpenFixture,
  site: QuickFixSite,
  preferred: boolean,
): Promise<void> {
  await undoAction(fixture.document, site.source);
  await diagnosticWithCode(fixture.uri, site.diagnostic);
  const range = tokenRange(fixture.document, site.target, site.occurrence);
  const actions = await resolvedQuickFixes(fixture.uri, range, site.title);
  assertQuickFix(uniqueAction(actions, site.title), site.title, preferred);
}

/**
 * Open `file` as `site.source`, then list, resolve, inspect, apply and undo the
 * quick fix `site` names. [ANALYZERS-FSAC-PARITY]
 */
export async function withQuickFixLifecycle(
  file: string,
  site: QuickFixSite,
  apply: (fixture: OpenFixture, action: vscode.CodeAction) => Promise<void>,
  inspect: (uri: vscode.Uri, action: vscode.CodeAction) => void = () => undefined,
): Promise<void> {
  await withOverlay(file, site.source, async (fixture) => {
    const range = tokenRange(fixture.document, site.target, site.occurrence);
    const action = await inspectQuickFix(fixture, range, site, true);
    inspect(fixture.uri, action);
    await apply(fixture, action);
    await undoAndRequery(fixture, site, true);
  });
}
