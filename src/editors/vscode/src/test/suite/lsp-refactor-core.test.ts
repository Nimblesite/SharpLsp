// Exhaustive real-LSP Roslyn refactor matrix for [SHARPLSP-FEATURES-REFACTORING].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  assertFragments,
  assertFreshActionDataIds,
  assertRawActionData,
  assertRawTitles,
  assertSingleDocumentEdit,
  onlyAction,
  rangeAfterAction,
  rangeOf,
  rawCodeActions,
  type RawCodeAction,
} from './csharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  applyWorkspaceEdit,
  openFixtureDocument,
  replaceDocumentText,
  revertDocument,
  waitForCodeActions,
  waitForResolvedCodeActions,
  type OpenFixture,
} from './refactor-test-helpers';
import {
  EXPRESSION_OPTIONS,
  EXPRESSION_SOURCE,
  FIELD_OPTIONS,
  FIELD_SOURCE,
  IF_OPTIONS,
  IF_SOURCE,
  INLINE_SOURCE,
  PARAMETER_OPTIONS,
  PARAMETER_SOURCE,
  PROPERTY_OPTIONS,
  PROPERTY_SOURCE,
} from './lsp-refactor-core-fixtures';

const FILE = 'RefactorCore.cs';
const TEST_TIMEOUT_MS = 180_000;

interface RefactorScenario {
  readonly label: string;
  readonly source: string;
  readonly snippet: string;
  readonly focus: string;
  readonly title: string;
  readonly kind: string;
  readonly options: readonly string[];
  readonly presentAfter: readonly string[];
  readonly absentAfter: readonly string[];
  readonly patternsAfter?: readonly RegExp[];
  readonly mustDisappear?: boolean;
  readonly postApplySnippet?: string;
  readonly postApplyFocus?: string;
  readonly requeryTitleCount?: number;
}

function vscodeKind(value: string): vscode.CodeActionKind {
  switch (value) {
    case 'refactor.extract':
      return vscode.CodeActionKind.RefactorExtract;
    case 'refactor.inline':
      return vscode.CodeActionKind.RefactorInline;
    case 'refactor.rewrite':
      return vscode.CodeActionKind.RefactorRewrite;
    default:
      return vscode.CodeActionKind.Refactor;
  }
}

const SCENARIOS: readonly RefactorScenario[] = [
  {
    label: 'introduce one local',
    source: EXPRESSION_SOURCE,
    snippet: 'input * 2',
    focus: 'input * 2',
    title: "Introduce local for 'input * 2'",
    kind: 'refactor.extract',
    options: EXPRESSION_OPTIONS,
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: [],
    patternsAfter: [/var \w+ = input \* 2;/],
  },
  {
    label: 'introduce local for all occurrences',
    source: EXPRESSION_SOURCE,
    snippet: 'input * 2',
    focus: 'input * 2',
    title: "Introduce local for all occurrences of 'input * 2'",
    kind: 'refactor.extract',
    options: EXPRESSION_OPTIONS,
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: ['input * 2 + input * 2'],
    patternsAfter: [/var \w+ = input \* 2;/],
  },
  {
    label: 'extract method',
    source: EXPRESSION_SOURCE,
    snippet: 'input * 2',
    focus: 'input * 2',
    title: 'Extract method',
    kind: 'refactor.extract',
    options: EXPRESSION_OPTIONS,
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: [],
    patternsAfter: [/private static int \w+\(int input\)/],
  },
  {
    label: 'extract local function',
    source: EXPRESSION_SOURCE,
    snippet: 'input * 2',
    focus: 'input * 2',
    title: 'Extract local function',
    kind: 'refactor.extract',
    options: EXPRESSION_OPTIONS,
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: [],
    patternsAfter: [/static int \w+\(int input\)/],
  },
  {
    label: 'inline temporary',
    source: INLINE_SOURCE,
    snippet: 'var doubled = input * 2',
    focus: 'doubled',
    title: 'Inline temporary variable',
    kind: 'refactor.inline',
    options: ['Inline temporary variable'],
    presentAfter: ['return input * 2 + _seed;', 'inline-sentinel'],
    absentAfter: ['var doubled'],
    mustDisappear: true,
    postApplySnippet: 'input * 2 + _seed',
    postApplyFocus: 'input * 2',
  },
  {
    label: 'encapsulate and redirect uses',
    source: FIELD_SOURCE,
    snippet: 'public int EncapsulateTarget;',
    focus: 'EncapsulateTarget',
    title: FIELD_OPTIONS[0],
    kind: 'refactor.rewrite',
    options: FIELD_OPTIONS,
    presentAfter: ['field-refactor-sentinel', 'Read() => EncapsulateTarget'],
    absentAfter: [],
    patternsAfter: [/private int \w*encapsulateTarget/i, /public int EncapsulateTarget\s*\{/],
    mustDisappear: true,
  },
  {
    label: 'encapsulate while retaining field uses',
    source: FIELD_SOURCE,
    snippet: 'public int EncapsulateTarget;',
    focus: 'EncapsulateTarget',
    title: FIELD_OPTIONS[1],
    kind: 'refactor.rewrite',
    options: FIELD_OPTIONS,
    presentAfter: ['field-refactor-sentinel'],
    absentAfter: ['public int EncapsulateTarget;'],
    patternsAfter: [
      /private int _?encapsulateTarget;/i,
      /public int EncapsulateTarget\s*\{\s*get => _?encapsulateTarget;/i,
      /Read\(\) => _?encapsulateTarget/i,
    ],
    mustDisappear: true,
  },
  {
    label: 'generate constructor from field',
    source: FIELD_SOURCE,
    snippet: 'public int EncapsulateTarget;',
    focus: 'EncapsulateTarget',
    title: FIELD_OPTIONS[2],
    kind: 'refactor.rewrite',
    options: FIELD_OPTIONS,
    presentAfter: [
      'RefactorTarget(int encapsulateTarget)',
      'EncapsulateTarget = encapsulateTarget',
    ],
    absentAfter: [],
    mustDisappear: true,
  },
  {
    label: 'convert auto property to full property',
    source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }',
    focus: 'AutoProperty',
    title: 'Convert to full property',
    kind: 'refactor.rewrite',
    options: PROPERTY_OPTIONS,
    presentAfter: ['property-refactor-sentinel'],
    absentAfter: ['AutoProperty { get; set; }'],
    patternsAfter: [/private int _?autoProperty/i, /public int AutoProperty\s*\{\s*get/],
    mustDisappear: true,
  },
  {
    label: 'convert auto property to field-backed accessors',
    source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }',
    focus: 'AutoProperty',
    title: "Convert to 'field' property",
    kind: 'refactor.rewrite',
    options: PROPERTY_OPTIONS,
    presentAfter: ['property-refactor-sentinel', 'field'],
    absentAfter: ['AutoProperty { get; set; }'],
    mustDisappear: true,
  },
  {
    label: 'replace property with methods',
    source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }',
    focus: 'AutoProperty',
    title: "Replace 'AutoProperty' with methods",
    kind: 'refactor.rewrite',
    options: PROPERTY_OPTIONS,
    presentAfter: ['GetAutoProperty', 'SetAutoProperty', 'property-refactor-sentinel'],
    absentAfter: ['AutoProperty { get; set; }'],
    mustDisappear: true,
  },
  {
    label: 'generate constructor from property',
    source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }',
    focus: 'AutoProperty',
    title: "Generate constructor 'RefactorTarget(int autoProperty)'",
    kind: 'refactor.rewrite',
    options: PROPERTY_OPTIONS,
    presentAfter: ['RefactorTarget(int autoProperty)', 'AutoProperty = autoProperty'],
    absentAfter: [],
    mustDisappear: true,
  },
  {
    label: 'invert condition',
    source: IF_SOURCE,
    snippet: 'if (input > 0)',
    focus: 'if',
    title: 'Invert if',
    kind: 'refactor.rewrite',
    options: IF_OPTIONS,
    presentAfter: ['condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'],
    patternsAfter: [/if \(input <= 0\)|if \(!\(input > 0\)\)/],
    postApplySnippet: 'if',
    requeryTitleCount: 1,
  },
  {
    label: 'convert condition to switch statement',
    source: IF_SOURCE,
    snippet: 'if (input > 0)',
    focus: 'if',
    title: "Convert to 'switch' statement",
    kind: 'refactor.rewrite',
    options: IF_OPTIONS,
    presentAfter: ['switch', 'condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'],
    mustDisappear: true,
  },
  {
    label: 'convert condition to switch expression',
    source: IF_SOURCE,
    snippet: 'if (input > 0)',
    focus: 'if',
    title: "Convert to 'switch' expression",
    kind: 'refactor.rewrite',
    options: IF_OPTIONS,
    presentAfter: ['switch', 'condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'],
    mustDisappear: true,
  },
  {
    label: 'introduce parameter and update call sites directly',
    source: PARAMETER_SOURCE,
    snippet: 'input * 2',
    focus: 'input * 2',
    title: PARAMETER_OPTIONS[0],
    kind: 'refactor.rewrite',
    options: PARAMETER_OPTIONS,
    presentAfter: ['introduce-parameter-sentinel'],
    absentAfter: [],
    patternsAfter: [/Compute\(int input, int \w+\)/, /Compute\(3, 3 \* 2\)/],
  },
  {
    label: 'introduce parameter through an extracted call-site method',
    source: PARAMETER_SOURCE,
    snippet: 'input * 2',
    focus: 'input * 2',
    title: PARAMETER_OPTIONS[1],
    kind: 'refactor.rewrite',
    options: PARAMETER_OPTIONS,
    presentAfter: ['introduce-parameter-sentinel'],
    absentAfter: [],
    patternsAfter: [/Compute\(int input, int \w+\)/, /Compute\(3, \w+\(3\)\)/],
  },
  {
    label: 'introduce parameter through a compatibility overload',
    source: PARAMETER_SOURCE,
    snippet: 'input * 2',
    focus: 'input * 2',
    title: PARAMETER_OPTIONS[2],
    kind: 'refactor.rewrite',
    options: PARAMETER_OPTIONS,
    presentAfter: ['introduce-parameter-sentinel'],
    absentAfter: [],
    patternsAfter: [
      /Compute\(int input, int \w+\)/,
      /Compute\(int input\)[\s\S]*Compute\(input, input \* 2\)/,
    ],
  },
];

async function assertOutsideRange(fixture: OpenFixture, scenario: RefactorScenario): Promise<void> {
  const range = rangeOf(fixture.document, 'namespace');
  const raw = await rawCodeActions(fixture.uri, range);
  assert.ok(!raw.some((action) => action.title === scenario.title));
  const actions = await waitForCodeActions({
    uri: fixture.uri,
    range,
    kind: vscodeKind(scenario.kind),
    predicate: () => true,
  });
  assert.ok(!actions.some((action) => action.title === scenario.title));
}

async function discover(
  fixture: OpenFixture,
  scenario: RefactorScenario,
): Promise<{ readonly range: vscode.Range; readonly raw: RawCodeAction[] }> {
  const range = rangeOf(fixture.document, scenario.snippet, scenario.focus);
  const actions = await waitForCodeActions({
    uri: fixture.uri,
    range,
    kind: vscodeKind(scenario.kind),
    predicate: (items) => items.some((item) => item.title === scenario.title),
  });
  onlyAction(actions, scenario.title);
  const raw = await rawCodeActions(fixture.uri, range);
  assertRawTitles(raw, scenario.options, scenario.kind);
  assertRawActionData(raw, fixture.uri);
  return { range, raw };
}

async function resolve(
  fixture: OpenFixture,
  scenario: RefactorScenario,
  range: vscode.Range,
): Promise<vscode.WorkspaceEdit> {
  const actions = await waitForResolvedCodeActions({
    uri: fixture.uri,
    range,
    kind: vscodeKind(scenario.kind),
    predicate: (items) => items.some((item) => item.title === scenario.title && item.edit),
  });
  for (const title of scenario.options) onlyAction(actions, title);
  const selected = onlyAction(actions, scenario.title);
  assert.strictEqual(selected.kind?.value, scenario.kind);
  assert.ok(selected.edit, `${scenario.title} must resolve to an edit`);
  return selected.edit;
}

function assertMutation(
  fixture: OpenFixture,
  scenario: RefactorScenario,
  previousVersion: number,
): void {
  const source = fixture.document.getText();
  assertFragments(source, scenario.presentAfter, scenario.absentAfter);
  for (const pattern of scenario.patternsAfter ?? []) assert.match(source, pattern);
  assert.ok(fixture.document.version > previousVersion);
  assert.ok(fixture.document.isDirty);
}

async function assertRequery(
  fixture: OpenFixture,
  scenario: RefactorScenario,
  range: vscode.Range,
  before: readonly RawCodeAction[],
): Promise<void> {
  const requeryRange = rangeAfterAction(
    fixture,
    range,
    scenario.postApplySnippet,
    scenario.postApplyFocus,
  );
  const after = await rawCodeActions(fixture.uri, requeryRange);
  assertRawActionData(after, fixture.uri);
  assertFreshActionDataIds(after, before);
  if (scenario.mustDisappear) assert.ok(!after.some((action) => action.title === scenario.title));
  if (scenario.requeryTitleCount !== undefined) {
    assert.strictEqual(
      after.filter((action) => action.title === scenario.title).length,
      scenario.requeryTitleCount,
    );
  }
}

async function runScenario(
  fixture: OpenFixture,
  committedText: string,
  scenario: RefactorScenario,
): Promise<void> {
  await replaceDocumentText(fixture.document, scenario.source);
  await assertOutsideRange(fixture, scenario);
  const discovered = await discover(fixture, scenario);
  const edit = await resolve(fixture, scenario, discovered.range);
  const version = fixture.document.version;
  assertSingleDocumentEdit(await applyWorkspaceEdit(edit), fixture);
  assertMutation(fixture, scenario, version);
  await assertRequery(fixture, scenario, discovered.range, discovered.raw);
  await revertDocument(fixture.document);
  assert.strictEqual(fixture.document.getText(), committedText);
  assert.ok(!fixture.document.isDirty);
}

function registerCoreTests(getFixture: () => OpenFixture, getCommittedText: () => string): void {
  for (const scenario of SCENARIOS) {
    test(`${scenario.label}: list, resolve, apply, requery, and revert`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await runScenario(getFixture(), getCommittedText(), scenario);
    });
  }
}

suite('C# real LSP - Roslyn refactor families', () => {
  let fixture: OpenFixture;
  let committedText = '';

  suiteSetup(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await activateRealSharpLsp();
    fixture = await openFixtureDocument(FILE);
    committedText = fixture.document.getText();
  });

  teardown(async () => revertDocument(fixture.document));
  registerCoreTests(
    () => fixture,
    () => committedText,
  );
});
