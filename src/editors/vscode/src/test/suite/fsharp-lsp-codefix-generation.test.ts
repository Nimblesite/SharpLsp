import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  COMPLETE_INTERFACE_SOURCE,
  COMPLETE_RECORD_SOURCE,
  EMPTY_INTERFACE_SOURCE,
  EMPTY_INTERFACE_WITH_SOURCE,
  EXHAUSTIVE_UNION_SOURCE,
  GENERIC_INTERFACE_SOURCE,
  MATCH_BANG_SOURCE,
  NESTED_GENERIC_INTERFACE_SOURCE,
  OBJECT_EXPRESSION_INTERFACE_SOURCE,
  PARTIAL_INTERFACE_SOURCE,
  RECORD_COPY_UPDATE_SOURCE,
  RECORD_SOURCE,
  UNION_SOURCE,
  WILDCARD_UNION_SOURCE,
} from './fsharp-refactor-fixtures';
import {
  FSHARP_REFACTOR_TIMEOUT_MS,
  applyAction,
  assertInsertion,
  assertNoAction,
  assertQuickFix,
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
import { closeAllEditors, comparableText } from './test-helpers';

// Union, record, and interface generators through shipped FCS. [ANALYZERS-FSAC-PARITY]
const TARGET_FILE = 'fsharp/DiagnosticsTarget.fs';

interface GenerationSpec {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly postTarget?: string;
  readonly occurrence?: number;
  readonly title: string;
  readonly diagnostic: string;
  readonly editText?: string;
  readonly editPosition?: readonly [line: number, character: number];
  readonly editPrefix?: string;
  readonly expectedFragments: readonly string[];
  readonly preservedFragments?: readonly string[];
  readonly absentFragments: readonly string[];
}

suite('F# real LSP — generated refactors', () => {
  suiteSetup(activateRealSharpLsp);
  teardown(closeAllEditors);
  suiteTeardown(closeAllEditors);

  for (const spec of generationSpecs()) {
    test(`${spec.name} survives list, resolve, apply, recheck, and undo`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS * 2);
      await runGeneration(spec);
    });
  }

  for (const spec of completeSpecs()) {
    test(`${spec.name} offers no generation refactor when already complete`, async function () {
      this.timeout(FSHARP_REFACTOR_TIMEOUT_MS);
      await assertComplete(spec);
    });
  }
});

function generationSpecs(): readonly GenerationSpec[] {
  return [
    unionSpec(),
    matchBangSpec(),
    recordSpec(),
    interfaceSpec(),
    genericInterfaceSpec(),
    nestedGenericInterfaceSpec(),
    objectExpressionInterfaceSpec(),
    emptyInterfaceWithSpec(),
    emptyInterfaceSpec(),
  ];
}

function unionSpec(): GenerationSpec {
  return {
    name: 'three missing DU cases',
    source: UNION_SOURCE,
    target: 'match payload with',
    title: 'Generate 3 missing union case(s)',
    diagnostic: 'FS0025',
    editText: unionStub(),
    expectedFragments: ['| Empty ->', '| One _ ->', '| Many(_, _) ->'],
    absentFragments: ['| Anchor _ ->'],
  };
}

function matchBangSpec(): GenerationSpec {
  return {
    name: 'missing match! case',
    source: MATCH_BANG_SOURCE,
    target: 'match! pending with',
    title: 'Generate 1 missing union case(s)',
    diagnostic: 'FS0025',
    // `match!` arms sit in a value-producing CE, so the stub must `return`.
    editText: '    | Second -> return failwith "todo"\n',
    expectedFragments: ['| Second ->'],
    preservedFragments: ['| First ->'],
    absentFragments: ['| Second _ ->'],
  };
}

function recordSpec(): GenerationSpec {
  return {
    name: 'twelve typed record defaults',
    source: RECORD_SOURCE,
    target: '{ Keep = 1 }',
    postTarget: 'let value',
    title: 'Generate 12 missing record field(s)',
    diagnostic: 'FS0764',
    editText: recordStub(),
    expectedFragments: recordFragments(),
    absentFragments: ['Keep = 0'],
  };
}

function interfaceSpec(): GenerationSpec {
  return interfaceGenerationSpec(
    'only unimplemented interface member',
    PARTIAL_INTERFACE_SOURCE,
    [8, 32],
    '\n        member _.Area',
    ['member _.Name = "square"'],
  );
}

function genericInterfaceSpec(): GenerationSpec {
  return {
    name: 'closed generic interface preserves substituted type parameters',
    source: GENERIC_INTERFACE_SOURCE,
    target: 'IBox<string>',
    title: 'Implement interface',
    diagnostic: 'FS0366',
    editPosition: [8, 32],
    editPrefix: '\n        member _.Map',
    expectedFragments: ['member _.Map', 'string', 'Not implemented yet'],
    preservedFragments: ['member _.Value = "ready"'],
    absentFragments: ['member _.Value = failwith', "member _.Map(arg1: 'T)"],
  };
}

function nestedGenericInterfaceSpec(): GenerationSpec {
  return {
    name: 'nested generic interface resolves the outer interface symbol',
    source: NESTED_GENERIC_INTERFACE_SOURCE,
    target: 'IWrapper<IOther>',
    title: 'Implement interface',
    diagnostic: 'FS0366',
    editPosition: [9, 35],
    editPrefix: '\n        member _.Wrap',
    expectedFragments: ['member _.Wrap', 'IOther', 'Not implemented yet'],
    absentFragments: ['member _.Code'],
  };
}

function objectExpressionInterfaceSpec(): GenerationSpec {
  return interfaceGenerationSpec(
    'partial object expression keeps its existing member and closing brace',
    OBJECT_EXPRESSION_INTERFACE_SOURCE,
    [8, 31],
    '\n        member _.Area',
    ['member _.Name = "shape"', '}'],
  );
}

function emptyInterfaceWithSpec(): GenerationSpec {
  return interfaceGenerationSpec(
    'empty interface declaration with existing with keyword',
    EMPTY_INTERFACE_WITH_SOURCE,
    [6, 25],
    '\n        member _.Area',
  );
}

function emptyInterfaceSpec(): GenerationSpec {
  return interfaceGenerationSpec(
    'empty interface declaration without with keyword',
    EMPTY_INTERFACE_SOURCE,
    [6, 20],
    ' with\n        member _.Area',
  );
}

function interfaceGenerationSpec(
  name: string,
  source: string,
  editPosition: readonly [number, number],
  editPrefix: string,
  preservedFragments: readonly string[] = [],
): GenerationSpec {
  return {
    name,
    source,
    target: 'IShape',
    occurrence: 1,
    title: 'Implement interface',
    diagnostic: 'FS0366',
    editPosition,
    editPrefix,
    expectedFragments: ['member _.Area', 'Not implemented yet'],
    preservedFragments,
    absentFragments: ['member _.Name = failwith'],
  };
}

function completeSpecs(): readonly GenerationSpec[] {
  return [
    completeUnionSpec(),
    wildcardUnionSpec(),
    completeRecordSpec(),
    recordCopyUpdateSpec(),
    completeInterfaceSpec(),
  ];
}

function completeUnionSpec(): GenerationSpec {
  return {
    name: 'exhaustive DU',
    source: EXHAUSTIVE_UNION_SOURCE,
    target: 'match value with',
    title: 'Generate 1 missing union case(s)',
    diagnostic: 'FS0025',
    expectedFragments: [],
    absentFragments: [],
  };
}

function completeRecordSpec(): GenerationSpec {
  return {
    name: 'complete record',
    source: COMPLETE_RECORD_SOURCE,
    target: '{ X = 1; Y = 2 }',
    title: 'Generate 1 missing record field(s)',
    diagnostic: 'FS0764',
    expectedFragments: [],
    absentFragments: [],
  };
}

function wildcardUnionSpec(): GenerationSpec {
  return {
    name: 'wildcard-covered DU match',
    source: WILDCARD_UNION_SOURCE,
    target: 'match value with',
    title: 'Generate 3 missing union case(s)',
    diagnostic: 'FS0025',
    expectedFragments: [],
    absentFragments: [],
  };
}

function recordCopyUpdateSpec(): GenerationSpec {
  return {
    name: 'record copy-and-update expression',
    source: RECORD_COPY_UPDATE_SOURCE,
    target: '{ point with X = 3 }',
    title: 'Generate 1 missing record field(s)',
    diagnostic: 'FS0764',
    expectedFragments: [],
    absentFragments: [],
  };
}

function completeInterfaceSpec(): GenerationSpec {
  return {
    name: 'complete interface',
    source: COMPLETE_INTERFACE_SOURCE,
    target: 'IShape',
    occurrence: 1,
    title: 'Implement interface',
    diagnostic: 'FS0366',
    expectedFragments: [],
    absentFragments: [],
  };
}

function unionStub(): string {
  return [
    '    | Empty -> failwith "todo"',
    '    | One _ -> failwith "todo"',
    '    | Many(_, _) -> failwith "todo"',
    '',
  ].join('\n');
}

function recordStub(): string {
  return (
    '; Text = ""; Number = 0; Number32 = 0; Number64 = 0; Float = 0; ' +
    'Double = 0; Money = 0; Flag = false; Maybe = None; Items = []; ' +
    'Values = [||]; Other = Unchecked.defaultof<System.Guid>'
  );
}

function recordFragments(): readonly string[] {
  return [
    'Text = ""',
    'Number = 0',
    'Number32 = 0',
    'Number64 = 0',
    'Float = 0',
    'Double = 0',
    'Money = 0',
    'Flag = false',
    'Maybe = None',
    'Items = []',
    'Values = [||]',
    'Other = Unchecked.defaultof<System.Guid>',
  ];
}

async function runGeneration(spec: GenerationSpec): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, spec.source);
  try {
    const range = tokenRange(fixture.document, spec.target, spec.occurrence);
    const action = await inspectGeneration(fixture, range, spec);
    inspectGenerationEdit(fixture.uri, action, spec);
    await applyGeneration(fixture, action, spec);
    await undoGeneration(fixture, spec);
  } finally {
    await revertDocument(fixture.document);
  }
}

async function inspectGeneration(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  range: vscode.Range,
  spec: GenerationSpec,
): Promise<vscode.CodeAction> {
  const diagnostics = await diagnosticWithCode(fixture.uri, spec.diagnostic);
  assertGenerationDiagnostic(diagnostics, range, spec.diagnostic);
  const raw = uniqueAction(await quickFixes(fixture.uri, range), spec.title);
  assertRawGeneration(raw, spec.title);
  const outside = await quickFixes(fixture.uri, tokenRange(fixture.document, 'sentinel'));
  assertNoAction(outside, spec.title);
  const resolved = await resolvedQuickFixes(fixture.uri, range, spec.title);
  const action = uniqueAction(resolved, spec.title);
  assertQuickFix(action, spec.title, true);
  return action;
}

function assertGenerationDiagnostic(
  diagnostics: readonly vscode.Diagnostic[],
  range: vscode.Range,
  code: string,
): void {
  const matches = diagnostics.filter((item) => diagnosticCode(item) === code);
  assert.ok(matches.length >= 1, `${code} must drive the generator`);
  assert.ok(matches.some((item) => item.range.intersection(range) !== undefined));
  assert.ok(matches.every((item) => item.message.trim().length > 0));
  assert.ok(matches.every((item) => item.source === 'sharplsp-fsharp'));
}

function assertRawGeneration(action: vscode.CodeAction, title: string): void {
  assert.strictEqual(action.title, title);
  assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.strictEqual(action.isPreferred, true);
  assert.strictEqual(action.edit, undefined);
  assert.strictEqual(action.command, undefined);
}

function inspectGenerationEdit(
  uri: vscode.Uri,
  action: vscode.CodeAction,
  spec: GenerationSpec,
): void {
  assert.strictEqual(action.edit?.size, 1);
  const edit = singleEdit(action, uri);
  assert.ok(edit.range.isEmpty);
  if (spec.editText !== undefined) assertInsertion(edit, spec.editText);
  if (spec.editPosition !== undefined) assertEditPosition(edit.range, spec.editPosition);
  if (spec.editPrefix !== undefined)
    // The stub adopts the document's own line endings, so compare EOL-insensitively.
    assert.ok(
      comparableText(edit.newText).startsWith(comparableText(spec.editPrefix)),
      `generated text must start with ${JSON.stringify(spec.editPrefix)}; got ${JSON.stringify(edit.newText)}`,
    );
  for (const fragment of spec.expectedFragments)
    assert.ok(
      edit.newText.includes(fragment),
      `generated text must contain ${JSON.stringify(fragment)}; got ${JSON.stringify(edit.newText)}`,
    );
  for (const fragment of spec.preservedFragments ?? []) assert.ok(!edit.newText.includes(fragment));
  for (const fragment of spec.absentFragments) assert.ok(!edit.newText.includes(fragment));
}

function assertEditPosition(
  range: vscode.Range,
  expected: readonly [line: number, character: number],
): void {
  assert.strictEqual(range.start.line, expected[0]);
  assert.strictEqual(range.start.character, expected[1]);
  assert.strictEqual(range.end.line, expected[0]);
  assert.strictEqual(range.end.character, expected[1]);
}

async function applyGeneration(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  action: vscode.CodeAction,
  spec: GenerationSpec,
): Promise<void> {
  const beforeVersion = fixture.document.version;
  const snapshots = await applyAction(action);
  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0]?.uri.toString(), fixture.uri.toString());
  assert.ok(fixture.document.version > beforeVersion);
  assert.ok(fixture.document.isDirty);
  assertGeneratedDocument(fixture.document, spec);
  await assertAllErrorsGone(fixture.uri, spec.diagnostic);
  const actions = await quickFixes(
    fixture.uri,
    tokenRange(fixture.document, spec.postTarget ?? spec.target, spec.occurrence),
  );
  assertNoAction(actions, spec.title);
}

async function assertAllErrorsGone(uri: vscode.Uri, diagnostic: string): Promise<void> {
  const diagnostics = await diagnosticGone(uri, diagnostic);
  const errors = diagnostics.filter((item) => item.severity === vscode.DiagnosticSeverity.Error);
  assert.deepStrictEqual(
    errors.map((item) => `${item.range.start.line}:${diagnosticCode(item)} ${item.message}`),
    [],
    'generation must leave the real F# document free of compiler errors',
  );
}

function assertGeneratedDocument(document: vscode.TextDocument, spec: GenerationSpec): void {
  const text = document.getText();
  for (const fragment of spec.expectedFragments) assert.ok(text.includes(fragment));
  for (const fragment of spec.preservedFragments ?? []) assert.ok(text.includes(fragment));
  for (const fragment of spec.absentFragments) assert.ok(!text.includes(fragment));
  assert.ok(text.includes('sentinel'));
}

async function undoGeneration(
  fixture: Awaited<ReturnType<typeof openOverlay>>,
  spec: GenerationSpec,
): Promise<void> {
  await undoAction(fixture.document, spec.source);
  await diagnosticWithCode(fixture.uri, spec.diagnostic);
  const range = tokenRange(fixture.document, spec.target, spec.occurrence);
  const actions = await resolvedQuickFixes(fixture.uri, range, spec.title);
  assertQuickFix(uniqueAction(actions, spec.title), spec.title, true);
}

async function assertComplete(spec: GenerationSpec): Promise<void> {
  const fixture = await openOverlay(TARGET_FILE, spec.source);
  try {
    const range = tokenRange(fixture.document, spec.target, spec.occurrence);
    await assertAllErrorsGone(fixture.uri, spec.diagnostic);
    const actions = await quickFixes(fixture.uri, range);
    assertNoAction(actions, spec.title);
    assert.ok(!actions.some((action) => action.title.startsWith('Generate ')));
    assert.ok(
      !vscode.languages
        .getDiagnostics(fixture.uri)
        .some((item) => diagnosticCode(item) === spec.diagnostic),
    );
    assert.strictEqual(fixture.document.getText(), spec.source);
    assert.ok(fixture.document.isDirty);
  } finally {
    await revertDocument(fixture.document);
  }
}
