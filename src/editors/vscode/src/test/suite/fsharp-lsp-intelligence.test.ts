import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type {
  CompletionItem as LspCompletionItem,
  CompletionList as LspCompletionList,
  Range as LspRange,
} from 'vscode-languageclient/node';
import { closeAllEditors, pollUntilResult, pollProvider, assertContainsAll } from './test-helpers';
import { openFSharpFixture, positionOf } from './fsharp-helpers';
import { assertFixtureCompletion, openFSharpAt, pollCompletion } from './fsharp-lsp-kit';
import { IGNORE_SOURCE } from './fsharp-refactor-fixtures';
import {
  assertInsertion,
  assertQuickFix,
  diagnosticWithCode,
  openOverlay,
  quickFixes,
  resolvedQuickFixes,
  singleEdit,
  tokenRange,
  undoAction,
  uniqueAction,
  assertFixApplied,
} from './fsharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  replaceDocumentText,
  revertDocument,
  sendRealLspRequest,
} from './refactor-test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/**
 * Blanket end-to-end coverage for F# code-intelligence features:
 * completion, signature help, rename, inlay hints, and code actions.
 *
 * These run against the REAL release-built LSP + FCS sidecar and the static F#
 * fixture project. Several of these features are not yet implemented in the F#
 * sidecar — those tests are EXPECTED to fail until the corresponding feature is
 * built (drive each via /fix-bug). F# is a first-class citizen; it must reach
 * and exceed C# parity.
 */

suite('F# LSP — Completion', defineCompletionSuite);

function defineCompletionSuite(): void {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);
  test('member completion after `.` on a class instance', verifyClassCompletion);
  test('member completion after `.` on a record value', verifyRecordCompletion);
  test('module-qualified completion after `.`', verifyModuleCompletion);
  test('completion items carry concrete F# symbol kinds', verifyCompletionKind);
  test(
    'an unopened type completes with its namespace and resolves to its open',
    verifyUnopenedCompletion,
  );
}

suite('F# LSP — Signature Help', defineSignatureSuite);

function defineSignatureSuite(): void {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);
  test('signature help inside a constructor call', verifySignatureHelp);
}

suite('F# LSP — Rename', defineRenameSuite);

function defineRenameSuite(): void {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);
  test('rename a function updates the declaration and every use site', verifySimpleRename);
}

suite('F# LSP — Inlay Hints', defineInlaySuite);

function defineInlaySuite(): void {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);
  test('type inlay hints appear on unannotated let bindings', verifyInlayHints);
}

suite('F# LSP — Code Actions', defineCodeActionSuite);

function defineCodeActionSuite(): void {
  suiteSetup(activateRealSharpLsp);
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);
  test('offers a fix to ignore an implicitly-discarded result', verifyIgnoreCodeActionTest);
}

// ── Local helpers ─────────────────────────────────────────────────

async function verifyClassCompletion(this: Mocha.Context): Promise<void> {
  await assertFixtureCompletion(
    this,
    'Usage.fs',
    'greeter.Greet',
    'greeter.'.length,
    ['Greet'],
    'completion after greeter. must include the Greet member',
  );
}

async function verifyRecordCompletion(this: Mocha.Context): Promise<void> {
  await assertFixtureCompletion(
    this,
    'Usage.fs',
    'alice.Name',
    'alice.'.length,
    ['Name', 'Age'],
    'record completion must include',
  );
}

async function verifyModuleCompletion(this: Mocha.Context): Promise<void> {
  await assertFixtureCompletion(
    this,
    'Usage.fs',
    'Geometry.totalArea shapes',
    'Geometry.'.length,
    ['area', 'totalArea', 'describeParity'],
    'module completion must include',
  );
}

async function verifyCompletionKind(this: Mocha.Context): Promise<void> {
  const usage = await openFSharpAt(this, 'Usage.fs', 'alice.Name', 'alice.'.length);
  const list = await pollCompletion(usage.uri, usage.position, completionHasName);
  const name = list.items.find((item) => item.label.toString() === 'Name');
  assert.ok(name, 'Name completion item must be present');
  assert.strictEqual(
    name.kind,
    vscode.CompletionItemKind.Field,
    'record field completion must be reported as a Field',
  );
}

// [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-OPEN]: through the real server, a typed
// prefix completes a type of a namespace Usage.fs never opens, and resolving it adds
// that namespace's `open`, which the accepted item then compiles against.
async function verifyUnopenedCompletion(this: Mocha.Context): Promise<void> {
  this.timeout(LSP_RESPONSE_MS + 5_000);
  const usage = await openFSharpFixture('Usage.fs');
  try {
    await replaceDocumentText(
      usage.doc,
      `${usage.doc.getText()}    let probeBuilder = StringBu()\n`,
    );
    const position = positionOf(usage.doc, 'StringBu()', 'StringBu'.length);
    const builder = await pollCompletionItem(usage.uri, position, 'StringBuilder');
    assert.strictEqual(builder.detail, '(open System.Text)');
    const resolved = await sendRealLspRequest<LspCompletionItem>('completionItem/resolve', builder);
    const opens = resolved.additionalTextEdits ?? [];
    assert.strictEqual(opens.length, 1, 'resolving adds exactly one open');
    assert.strictEqual(opens[0]?.newText.trim(), 'open System.Text');
    await acceptCompletion(usage.doc, resolved);
    assertContainsAll(
      usage.doc.getText(),
      ['open System.Text\n', 'StringBuilder()'],
      'accepted file',
    );
  } finally {
    await revertDocument(usage.doc);
  }
}

/** The raw LSP item labelled `label` the real server completes at `position`. */
async function pollCompletionItem(
  uri: vscode.Uri,
  position: vscode.Position,
  label: string,
): Promise<LspCompletionItem> {
  const params = { textDocument: { uri: uri.toString() }, position };
  type Answer = LspCompletionList | LspCompletionItem[] | null;
  const items = await pollUntilResult(
    async () =>
      completionItemsOf(await sendRealLspRequest<Answer>('textDocument/completion', params)),
    (found) => found.some((item) => item.label === label),
    LSP_RESPONSE_MS,
    2_000,
  );
  const item = items.find((candidate) => candidate.label === label);
  assert.ok(item, `${label} must be offered`);
  return item;
}

function completionItemsOf(
  answer: LspCompletionList | LspCompletionItem[] | null,
): LspCompletionItem[] {
  if (answer === null) return [];
  return Array.isArray(answer) ? answer : answer.items;
}

/** Apply a resolved item's own edit and its additional edits, as accepting it does. */
async function acceptCompletion(doc: vscode.TextDocument, item: LspCompletionItem): Promise<void> {
  const own = item.textEdit;
  assert.ok(own && 'range' in own, 'the item replaces the typed prefix');
  const edit = new vscode.WorkspaceEdit();
  const rangeOf = (range: LspRange) =>
    new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
  edit.replace(doc.uri, rangeOf(own.range), own.newText);
  for (const extra of item.additionalTextEdits ?? [])
    edit.replace(doc.uri, rangeOf(extra.range), extra.newText);
  assert.ok(await vscode.workspace.applyEdit(edit), 'accepting the item applies');
}

function completionHasName(list: vscode.CompletionList): boolean {
  return list.items.some((item) => item.label.toString() === 'Name');
}

async function verifySignatureHelp(this: Mocha.Context): Promise<void> {
  const usage = await openFSharpAt(this, 'Usage.fs', 'Greeter("Hello")', 'Greeter('.length);
  const help = await requestSignatureHelp(usage.uri, usage.position);
  assert.ok(
    help.signatures.length > 0,
    'signature help must surface at least one signature for the Greeter constructor',
  );
}

async function requestSignatureHelp(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.SignatureHelp> {
  return pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        uri,
        position,
        '(',
      )) ?? new vscode.SignatureHelp(),
    (help) => help.signatures.length > 0,
    LSP_RESPONSE_MS,
    2_000,
  );
}

async function verifySimpleRename(this: Mocha.Context): Promise<void> {
  const library = await openFSharpAt(this, 'Library.fs', 'let area', 'let '.length);
  const edit = await requestRenameEdit(library.uri, library.position);
  assert.ok(edit.size > 0, 'rename must produce a workspace edit');
  const libEdits = edit.get(library.uri);
  assert.ok(
    libEdits.length >= 2,
    `rename must touch the declaration and the use site (got ${libEdits.length} edits)`,
  );
  assert.ok(libEdits.every(isComputeAreaEdit), 'every rename edit must insert the new name');
}

function isComputeAreaEdit(edit: vscode.TextEdit): boolean {
  return edit.newText === 'computeArea';
}

async function requestRenameEdit(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.WorkspaceEdit> {
  return pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        uri,
        position,
        'computeArea',
      )) ?? new vscode.WorkspaceEdit(),
    (edit) => edit.size > 0,
    LSP_RESPONSE_MS,
    2_000,
  );
}

async function verifyInlayHints(this: Mocha.Context): Promise<void> {
  this.timeout(LSP_RESPONSE_MS + 5_000);
  const usage = await openFSharpFixture('Usage.fs');
  const range = new vscode.Range(0, 0, usage.doc.lineCount, 0);
  const hints = await requestInlayHints(usage.uri, range);
  assert.ok(hints.length >= 1, `Usage.fs must surface ≥1 inlay hint, got ${hints.length}`);
  const labels = hints.map(inlayLabel).join(' ');
  assert.match(labels, /Greeter|float|string|int/, 'inlay hints must reveal inferred types');
}

async function requestInlayHints(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<vscode.InlayHint[]> {
  return pollProvider<vscode.InlayHint>(
    'vscode.executeInlayHintProvider',
    [uri, range],
    (items) => items.length >= 1,
    LSP_RESPONSE_MS,
    2_000,
  );
}

async function verifyIgnoreCodeActionTest(this: Mocha.Context): Promise<void> {
  this.timeout(LSP_RESPONSE_MS + 5_000);
  await verifyIgnoreCodeAction();
}

function inlayLabel(hint: vscode.InlayHint): string {
  if (typeof hint.label === 'string') {
    return hint.label;
  }
  return hint.label.map((part) => part.value).join('');
}

async function verifyIgnoreCodeAction(): Promise<void> {
  const fixture = await openOverlay('fsharp/DiagnosticsTarget.fs', IGNORE_SOURCE);
  try {
    const range = tokenRange(fixture.document, '1 + 1');
    const action = await inspectIgnoreAction(fixture.uri, range);
    assertInsertion(singleEdit(action, fixture.uri), ' |> ignore');
    await applyIgnoreAction(fixture, action);
    await undoAction(fixture.document, IGNORE_SOURCE);
    const replay = await resolvedQuickFixes(fixture.uri, range, "Add '|> ignore'");
    assertQuickFix(uniqueAction(replay, "Add '|> ignore'"), "Add '|> ignore'", true);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function inspectIgnoreAction(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<vscode.CodeAction> {
  const diagnostics = await diagnosticWithCode(uri, 'FS0020');
  assert.ok(diagnostics.some((item) => item.range.intersection(range) !== undefined));
  const raw = uniqueAction(await quickFixes(uri, range), "Add '|> ignore'");
  assert.strictEqual(raw.edit, undefined);
  assert.strictEqual(raw.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.strictEqual(raw.isPreferred, true);
  const resolved = await resolvedQuickFixes(uri, range, "Add '|> ignore'");
  const action = uniqueAction(resolved, "Add '|> ignore'");
  assertQuickFix(action, "Add '|> ignore'", true);
  return action;
}

async function applyIgnoreAction(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  action: vscode.CodeAction,
): Promise<void> {
  const expected = IGNORE_SOURCE.replace('1 + 1', '1 + 1 |> ignore');
  await assertFixApplied(fixture, action, expected, 'FS0020', '1 + 1');
}
