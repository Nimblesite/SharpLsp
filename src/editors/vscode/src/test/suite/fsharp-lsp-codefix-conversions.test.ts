import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  CONVERSION_SCENARIOS,
  IMPLICIT_CONVERSION_SCENARIOS,
  UNSUPPORTED_CONVERSION_SOURCE,
  type CodeFixScenario,
} from './fsharp-refactor-fixtures';
import {
  FSHARP_REFACTOR_TIMEOUT_MS,
  applyAction,
  assertNoAction,
  assertQuickFix,
  assertReplacement,
  diagnosticCode,
  diagnosticGone,
  diagnosticWithCode,
  openOverlay,
  quickFixes,
  requestPrepareRename,
  resolvedQuickFixes,
  singleEdit,
  tokenRange,
  undoAction,
  uniqueAction,
} from './fsharp-refactor-test-kit';
import { activateRealSharpLsp, revertDocument } from './refactor-test-helpers';
import { closeAllEditors } from './test-helpers';

// Every supported FS0001 conversion direction through the real LSP. [ANALYZERS-FSAC-PARITY]
const TARGET_FILE = 'fsharp/DiagnosticsTarget.fs';

suite('F# real LSP — type-conversion quick fixes', defineConversionSuite);

function defineConversionSuite(): void {
  suiteSetup(activateRealSharpLsp);
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);
  registerConversionTests();
  registerImplicitConversionTests();
  registerUnsupportedConversionTest();
}

function registerConversionTests(): void {
  for (const scenario of CONVERSION_SCENARIOS) {
    test(`${scenario.name}: exact conversion survives full edit lifecycle`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
      await runConversion(scenario);
    });
  }
}

function registerImplicitConversionTests(): void {
  for (const scenario of IMPLICIT_CONVERSION_SCENARIOS) {
    test(`${scenario.name}: implicit widening stays action-free across every token position`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
      await runImplicitConversion(scenario);
    });
  }
}

async function runImplicitConversion(scenario: CodeFixScenario): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, scenario.source);
  try {
    const version = fixture.document.version;
    const range = tokenRange(fixture.document, scenario.target, scenario.occurrence);
    const diagnostics = await diagnosticGone(fixture.uri, scenario.diagnostic);
    assert.ok(diagnostics.every((item) => diagnosticCode(item) !== scenario.diagnostic));
    assert.ok(diagnostics.every((item) => item.severity !== vscode.DiagnosticSeverity.Error));
    await assertPrepareAcrossRange(fixture.uri, range, scenario.target);
    await assertNoImplicitConversionActions(fixture, range, scenario);
    assert.strictEqual(fixture.document.version, version);
    assert.strictEqual(fixture.document.getText(), scenario.source);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
    assert.ok(!fixture.document.isDirty);
  }
}

async function assertPrepareAcrossRange(
  uri: vscode.Uri,
  range: vscode.Range,
  placeholder: string,
): Promise<void> {
  assert.ok(range.isSingleLine && !range.isEmpty);
  for (let offset = 0; offset < range.end.character - range.start.character; offset += 1) {
    const prepare = await requestPrepareRename(uri, range.start.translate(0, offset));
    assert.ok(prepare);
    assert.strictEqual(prepare.placeholder, placeholder);
    assert.strictEqual(prepare.range.start.line, range.start.line);
    assert.strictEqual(prepare.range.start.character, range.start.character);
    assert.strictEqual(prepare.range.end.line, range.end.line);
    assert.strictEqual(prepare.range.end.character, range.end.character);
  }
}

async function assertNoImplicitConversionActions(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  range: vscode.Range,
  scenario: CodeFixScenario,
): Promise<void> {
  const atDeclaration = await quickFixes(
    fixture.uri,
    tokenRange(fixture.document, scenario.target),
  );
  const atUse = await quickFixes(fixture.uri, range);
  const outside = await quickFixes(fixture.uri, tokenRange(fixture.document, 'sentinel'));
  for (const actions of [atDeclaration, atUse, outside]) {
    assertNoAction(actions, scenario.title);
    assert.ok(!actions.some((action) => action.title.startsWith('Convert to')));
  }
  assert.ok(atUse.every((action) => action.edit === undefined || action.edit.size > 0));
}

function registerUnsupportedConversionTest(): void {
  test('unsupported bool-from-int mismatch offers no conversion action', async function () {
    this.timeout(FSHARP_REFACTOR_TIMEOUT_MS);
    const fixture = await openOverlay(TARGET_FILE, UNSUPPORTED_CONVERSION_SOURCE);
    try {
      const diagnostics = await diagnosticWithCode(fixture.uri, 'FS0001');
      assert.ok(diagnostics.some((item) => diagnosticCode(item) === 'FS0001'));
      const range = tokenRange(fixture.document, '1');
      const actions = await quickFixes(fixture.uri, range);
      assert.ok(!actions.some((action) => action.title.startsWith('Convert to')));
      assert.strictEqual(fixture.document.getText(), UNSUPPORTED_CONVERSION_SOURCE);
      assert.ok(fixture.document.isDirty);
    } finally {
      await revertDocument(fixture.document);
    }
  });
}

async function runConversion(scenario: CodeFixScenario): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, scenario.source);
  try {
    const range = tokenRange(fixture.document, scenario.target, scenario.occurrence);
    const action = await inspectConversion(fixture, range, scenario);
    assertConversionEdit(fixture.document, fixture.uri, action, scenario);
    await applyConversion(fixture, action, scenario);
    await undoConversion(fixture, scenario);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function inspectConversion(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  range: vscode.Range,
  scenario: CodeFixScenario,
): Promise<vscode.CodeAction> {
  const diagnostics = await diagnosticWithCode(fixture.uri, scenario.diagnostic);
  assertConversionDiagnostic(diagnostics, range);
  const raw = uniqueAction(await quickFixes(fixture.uri, range), scenario.title);
  assertRawConversion(raw, scenario.title);
  const outside = await quickFixes(fixture.uri, tokenRange(fixture.document, 'sentinel'));
  assertNoAction(outside, scenario.title);
  const resolved = await resolvedQuickFixes(fixture.uri, range, scenario.title);
  const action = uniqueAction(resolved, scenario.title);
  assertQuickFix(action, scenario.title, false);
  return action;
}

function assertConversionDiagnostic(
  diagnostics: readonly vscode.Diagnostic[],
  range: vscode.Range,
): void {
  const mismatches = diagnostics.filter((item) => diagnosticCode(item) === 'FS0001');
  assert.ok(mismatches.length >= 1);
  assert.ok(mismatches.some((item) => item.range.intersection(range) !== undefined));
  assert.ok(mismatches.every((item) => item.severity === vscode.DiagnosticSeverity.Error));
  assert.ok(mismatches.every((item) => item.source === 'sharplsp-fsharp'));
  assert.ok(mismatches.every((item) => /type/i.test(item.message)));
}

function assertRawConversion(action: vscode.CodeAction, title: string): void {
  assert.strictEqual(action.title, title);
  assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.strictEqual(action.isPreferred, false);
  assert.strictEqual(action.edit, undefined);
  assert.strictEqual(action.command, undefined);
}

function assertConversionEdit(
  document: vscode.TextDocument,
  uri: vscode.Uri,
  action: vscode.CodeAction,
  scenario: CodeFixScenario,
): void {
  assert.strictEqual(action.edit?.size, 1);
  const edit = singleEdit(action, uri);
  assertReplacement(document, edit, scenario.target, scenario.replacement);
  assert.strictEqual(edit.range.start.line, 4);
  assert.ok(edit.range.end.character > edit.range.start.character);
}

async function applyConversion(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  action: vscode.CodeAction,
  scenario: CodeFixScenario,
): Promise<void> {
  const version = fixture.document.version;
  const snapshots = await applyAction(action);
  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0]?.uri.toString(), fixture.uri.toString());
  assert.strictEqual(snapshots[0]?.replacedText[0], scenario.target);
  assert.ok(fixture.document.version > version);
  assert.strictEqual(fixture.document.getText(), expectedSource(scenario));
  assert.ok(fixture.document.getText().includes('let sentinel = 48'));
  assert.ok(fixture.document.isDirty);
  await assertConversionClean(fixture.uri, scenario.diagnostic);
  const actions = await quickFixes(fixture.uri, tokenRange(fixture.document, scenario.replacement));
  assertNoAction(actions, scenario.title);
}

async function assertConversionClean(uri: vscode.Uri, diagnostic: string): Promise<void> {
  const diagnostics = await diagnosticGone(uri, diagnostic);
  assert.ok(
    diagnostics.every((item) => item.severity !== vscode.DiagnosticSeverity.Error),
    'conversion must leave the real F# document free of compiler errors',
  );
}

async function undoConversion(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  scenario: CodeFixScenario,
): Promise<void> {
  await undoAction(fixture.document, scenario.source);
  await diagnosticWithCode(fixture.uri, scenario.diagnostic);
  const range = tokenRange(fixture.document, scenario.target, scenario.occurrence);
  const actions = await resolvedQuickFixes(fixture.uri, range, scenario.title);
  assertQuickFix(uniqueAction(actions, scenario.title), scenario.title, false);
}

function expectedSource(scenario: CodeFixScenario): string {
  return scenario.source.replace(`accept ${scenario.target}\n`, `accept ${scenario.replacement}\n`);
}
