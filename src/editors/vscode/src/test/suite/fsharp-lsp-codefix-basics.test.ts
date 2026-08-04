import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  IGNORE_SOURCE,
  MATCH_FIX_SOURCE,
  OPEN_SCENARIOS,
  UNUSED_VALUE_SOURCE,
  falseOpenSource,
  type CodeFixScenario,
} from './fsharp-refactor-fixtures';
import {
  FSHARP_REFACTOR_TIMEOUT_MS,
  applyAction,
  assertInsertion,
  assertNoAction,
  assertQuickFix,
  assertReplacement,
  diagnosticCode,
  diagnosticGone,
  diagnosticWithCode,
  openOverlay,
  quickFixes,
  resolvedQuickFixes,
  singleEdit,
  tokenRange,
  undoAction,
  uniqueAction,
} from './fsharp-refactor-test-kit';
import { activateRealSharpLsp, revertDocument } from './refactor-test-helpers';
import { closeAllEditors } from './test-helpers';

// Full real-LSP lifecycle coverage for [ANALYZERS-FSAC-PARITY]. No mocked providers.
const TARGET_FILE = 'fsharp/DiagnosticsTarget.fs';
const FALSE_OPEN_CASES: readonly (readonly [string, string])[] = [
  ['MyPath', "Add 'open System.IO'"],
  ['MyFile', "Add 'open System.IO'"],
  ['MyDirectory', "Add 'open System.IO'"],
  ['MyTask', "Add 'open System.Threading.Tasks'"],
  ['MyAsync', "Add 'open System.Threading.Tasks'"],
  ['MyRegex', "Add 'open System.Text.RegularExpressions'"],
  ['MyList', "Add 'open System.Collections.Generic'"],
  ['map', "Add 'open System.Collections.Generic'"],
  ['filter', "Add 'open System.Collections.Generic'"],
  ['fold', "Add 'open System.Collections.Generic'"],
];

interface BasicFixSpec extends CodeFixScenario {
  readonly occurrence?: number;
  readonly beforeText?: string;
  readonly postTarget?: string;
  readonly preferred: boolean;
  readonly expected: string;
  readonly editText: string;
  readonly insertion: boolean;
}

suite('F# real LSP — diagnostic quick fixes', defineBasicFixSuite);

function defineBasicFixSuite(): void {
  suiteSetup(activateRealSharpLsp);
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);
  registerOpenTests();
  registerFalseOpenTests();
  registerBasicDiagnosticTests();
}

function registerOpenTests(): void {
  for (const scenario of OPEN_SCENARIOS) {
    test(`adds the ${scenario.name} namespace in valid F# module position`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
      await runBasicFix(openSpec(scenario));
    });
  }
}

function registerFalseOpenTests(): void {
  for (const [name, title] of FALSE_OPEN_CASES) {
    test(`rejects non-fixing namespace heuristic for ${name}`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS);
      await assertFalseOpen(name, title);
    });
  }
}

function registerBasicDiagnosticTests(): void {
  for (const spec of basicSpecs()) {
    test(`${spec.title} survives list, resolve, apply, recheck, and undo`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
      await runBasicFix(spec);
    });
  }
}

async function assertFalseOpen(name: string, title: string): Promise<void> {
  const source = falseOpenSource(name);
  const fixture = await openOverlay(TARGET_FILE, source);
  try {
    const range = tokenRange(fixture.document, name);
    const diagnostics = await diagnosticWithCode(fixture.uri, 'FS0039');
    assertDiagnostic(diagnostics, range, 'FS0039');
    assertNoAction(await quickFixes(fixture.uri, range), title);
    assert.strictEqual(fixture.document.getText(), source);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
  }
}

function openSpec(scenario: CodeFixScenario): BasicFixSpec {
  return {
    ...scenario,
    preferred: false,
    expected: scenario.source.replace('\n\nlet', `\n\n${scenario.replacement}let`),
    editText: scenario.replacement,
    insertion: true,
  };
}

function basicSpecs(): readonly BasicFixSpec[] {
  return [unusedSpec(), ignoreSpec(), wildcardSpec(), redundantSpec()];
}

function unusedSpec(): BasicFixSpec {
  return {
    name: 'unused value',
    source: UNUSED_VALUE_SOURCE,
    target: 'unusedValue',
    title: "Prefix 'unusedValue' with _",
    diagnostic: 'FS1182',
    replacement: '_unusedValue',
    preferred: true,
    expected: UNUSED_VALUE_SOURCE.replace('unusedValue', '_unusedValue'),
    editText: '_unusedValue',
    insertion: false,
  };
}

function ignoreSpec(): BasicFixSpec {
  return {
    name: 'ignored result',
    source: IGNORE_SOURCE,
    target: '1 + 1',
    title: "Add '|> ignore'",
    diagnostic: 'FS0020',
    replacement: ' |> ignore',
    preferred: true,
    expected: IGNORE_SOURCE.replace('1 + 1', '1 + 1 |> ignore'),
    editText: ' |> ignore',
    insertion: true,
  };
}

function wildcardSpec(): BasicFixSpec {
  const added = '    | A -> 1\n    | _ -> failwith "Unhandled case"\n';
  return {
    name: 'incomplete match',
    source: MATCH_FIX_SOURCE,
    target: 'match shape with',
    title: "Add wildcard case '| _ ->'",
    diagnostic: 'FS0025',
    replacement: added,
    preferred: false,
    expected: MATCH_FIX_SOURCE.replace('    | A -> 1\n', added),
    editText: '    | _ -> failwith "Unhandled case"\n',
    insertion: true,
  };
}

function redundantSpec(): BasicFixSpec {
  return {
    name: 'redundant case',
    source: MATCH_FIX_SOURCE,
    target: '| A -> 300',
    occurrence: 0,
    title: 'Remove redundant pattern case',
    diagnostic: 'FS0026',
    replacement: '',
    preferred: false,
    expected: MATCH_FIX_SOURCE.replace('    | A -> 300\n', ''),
    editText: '',
    insertion: false,
    beforeText: '    | A -> 300\n',
    postTarget: 'redundant shape',
  };
}

async function runBasicFix(spec: BasicFixSpec): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, spec.source);
  try {
    const range = tokenRange(fixture.document, spec.target, spec.occurrence);
    const action = await inspectAction(fixture, range, spec);
    inspectEdit(fixture.document, fixture.uri, action, spec);
    await applyAndRecheck(fixture, action, spec);
    await undoAndRequery(fixture, spec);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function inspectAction(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  range: vscode.Range,
  spec: BasicFixSpec,
): Promise<vscode.CodeAction> {
  const diagnostics = await diagnosticWithCode(fixture.uri, spec.diagnostic);
  assertDiagnostic(diagnostics, range, spec.diagnostic);
  const listed = await quickFixes(fixture.uri, range);
  const raw = uniqueAction(listed, spec.title);
  assertListedAction(raw, spec);
  await assertOutsideRange(fixture, spec.title);
  const resolved = await resolvedQuickFixes(fixture.uri, range, spec.title);
  const action = uniqueAction(resolved, spec.title);
  assertQuickFix(action, spec.title, spec.preferred);
  return action;
}

function assertDiagnostic(
  diagnostics: readonly vscode.Diagnostic[],
  range: vscode.Range,
  code: string,
): void {
  const matches = diagnostics.filter((item) => diagnosticCode(item) === code);
  assert.ok(matches.length >= 1, `${code} must be published`);
  assert.ok(matches.some((item) => item.range.intersection(range) !== undefined));
  assert.ok(matches.every((item) => item.message.trim().length > 0));
  assert.ok(matches.every((item) => item.source === 'sharplsp-fsharp'));
}

function assertListedAction(action: vscode.CodeAction, spec: BasicFixSpec): void {
  assert.strictEqual(action.title, spec.title);
  assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.strictEqual(action.isPreferred, spec.preferred);
  assert.strictEqual(action.edit, undefined, 'listed action must remain unresolved');
  assert.strictEqual(action.command, undefined, 'quick fix must use an edit, not a command');
}

async function assertOutsideRange(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  title: string,
): Promise<void> {
  const outside = tokenRange(fixture.document, 'sentinel');
  const actions = await quickFixes(fixture.uri, outside);
  assertNoAction(actions, title);
  assert.ok(
    actions.every((action) => action.kind?.contains(vscode.CodeActionKind.QuickFix) ?? true),
  );
}

function inspectEdit(
  document: vscode.TextDocument,
  uri: vscode.Uri,
  action: vscode.CodeAction,
  spec: BasicFixSpec,
): void {
  const edit = singleEdit(action, uri);
  if (spec.insertion) assertInsertion(edit, spec.editText);
  else assertReplacement(document, edit, spec.beforeText ?? spec.target, spec.editText);
  if (spec.title.startsWith("Add 'open")) assert.strictEqual(edit.range.start.line, 2);
}

async function applyAndRecheck(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  action: vscode.CodeAction,
  spec: BasicFixSpec,
): Promise<void> {
  const version = fixture.document.version;
  const snapshots = await applyAction(action);
  assert.strictEqual(snapshots.length, 1);
  assert.ok(fixture.document.version > version);
  assert.strictEqual(fixture.document.getText(), spec.expected);
  assert.ok(fixture.document.getText().includes('sentinel'));
  assert.ok(fixture.document.isDirty);
  await diagnosticGone(fixture.uri, spec.diagnostic);
  const actions = await quickFixes(
    fixture.uri,
    tokenRange(fixture.document, spec.postTarget ?? spec.target),
  );
  assertNoAction(actions, spec.title);
}

async function undoAndRequery(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  spec: BasicFixSpec,
): Promise<void> {
  await undoAction(fixture.document, spec.source);
  await diagnosticWithCode(fixture.uri, spec.diagnostic);
  const range = tokenRange(fixture.document, spec.target, spec.occurrence);
  const actions = await resolvedQuickFixes(fixture.uri, range, spec.title);
  assertQuickFix(uniqueAction(actions, spec.title), spec.title, spec.preferred);
}
