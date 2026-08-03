// Exhaustive real-LSP Roslyn refactor matrix for [SHARPLSP-FEATURES-REFACTORING].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  assertFragments,
  assertRawActionData,
  assertRawTitles,
  onlyAction,
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
  type WorkspaceEditSnapshot,
} from './refactor-test-helpers';

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
}

const EXPRESSION_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    private readonly int _seed;
    public RefactorTarget(int seed) => _seed = seed;

    public int Compute(int input)
    {
        return input * 2 + input * 2 + _seed; // expression-refactor-sentinel
    }
}
`;

const INLINE_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    private readonly int _seed;
    public RefactorTarget(int seed) => _seed = seed;

    public int Compute(int input)
    {
        var doubled = input * 2;
        return doubled + _seed; // inline-sentinel
    }
}
`;

const FIELD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int EncapsulateTarget;
    public int Read() => EncapsulateTarget; // field-refactor-sentinel
}
`;

const PROPERTY_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int AutoProperty { get; set; }
    public int Read() => AutoProperty; // property-refactor-sentinel
}
`;

const IF_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int Invertible(int input)
    {
        if (input > 0)
        {
            return input;
        }

        return -input; // condition-refactor-sentinel
    }
}
`;

const PARAMETER_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int Compute(int input)
    {
        return input * 2 + 1; // introduce-parameter-sentinel
    }

    public int Invoke() => Compute(3);
}
`;

const EXPRESSION_OPTIONS = [
  "Introduce local for 'input * 2'",
  "Introduce local for all occurrences of 'input * 2'",
  'Extract method',
  'Extract local function',
] as const;

const FIELD_OPTIONS = [
  "Encapsulate field: 'EncapsulateTarget' (and use property)",
  "Encapsulate field: 'EncapsulateTarget' (but still use field)",
  "Generate constructor 'RefactorTarget(int encapsulateTarget)'",
] as const;

const PROPERTY_OPTIONS = [
  "Replace 'AutoProperty' with methods",
  "Generate constructor 'RefactorTarget(int autoProperty)'",
  'Convert to full property',
  "Convert to 'field' property",
] as const;

const IF_OPTIONS = ['Invert if', "Convert to 'switch' statement", "Convert to 'switch' expression"];
const PARAMETER_OPTIONS = [
  'and update call sites directly',
  'into extracted method to invoke at call sites',
  'into new overload',
] as const;

function vscodeKind(value: string): vscode.CodeActionKind {
  switch (value) {
    case 'refactor.extract': return vscode.CodeActionKind.RefactorExtract;
    case 'refactor.inline': return vscode.CodeActionKind.RefactorInline;
    case 'refactor.rewrite': return vscode.CodeActionKind.RefactorRewrite;
    default: return vscode.CodeActionKind.Refactor;
  }
}

const SCENARIOS: readonly RefactorScenario[] = [
  {
    label: 'introduce one local', source: EXPRESSION_SOURCE, snippet: 'input * 2', focus: 'input * 2',
    title: "Introduce local for 'input * 2'", kind: 'refactor.extract', options: EXPRESSION_OPTIONS,
    presentAfter: ['expression-refactor-sentinel'], absentAfter: [],
    patternsAfter: [/var \w+ = input \* 2;/],
  },
  {
    label: 'introduce local for all occurrences', source: EXPRESSION_SOURCE,
    snippet: 'input * 2', focus: 'input * 2',
    title: "Introduce local for all occurrences of 'input * 2'", kind: 'refactor.extract', options: EXPRESSION_OPTIONS,
    presentAfter: ['expression-refactor-sentinel'], absentAfter: ['input * 2 + input * 2'],
    patternsAfter: [/var \w+ = input \* 2;/],
  },
  {
    label: 'extract method', source: EXPRESSION_SOURCE, snippet: 'input * 2', focus: 'input * 2',
    title: 'Extract method', kind: 'refactor.extract', options: EXPRESSION_OPTIONS,
    presentAfter: ['expression-refactor-sentinel'], absentAfter: [],
    patternsAfter: [/private static int \w+\(int input\)/],
  },
  {
    label: 'extract local function', source: EXPRESSION_SOURCE,
    snippet: 'input * 2', focus: 'input * 2', title: 'Extract local function', kind: 'refactor.extract',
    options: EXPRESSION_OPTIONS, presentAfter: ['expression-refactor-sentinel'], absentAfter: [],
    patternsAfter: [/static int \w+\(int input\)/],
  },
  {
    label: 'inline temporary', source: INLINE_SOURCE, snippet: 'doubled + _seed', focus: 'doubled',
    title: 'Inline temporary variable', kind: 'refactor.inline', options: ['Inline temporary variable'],
    presentAfter: ['return input * 2 + _seed;', 'inline-sentinel'], absentAfter: ['var doubled'],
    mustDisappear: true,
  },
  {
    label: 'encapsulate and redirect uses', source: FIELD_SOURCE,
    snippet: 'public int EncapsulateTarget;', focus: 'EncapsulateTarget',
    title: FIELD_OPTIONS[0], kind: 'refactor.rewrite', options: FIELD_OPTIONS,
    presentAfter: ['field-refactor-sentinel', 'Read() => EncapsulateTarget'], absentAfter: [],
    patternsAfter: [/private int \w*encapsulateTarget/i, /public int EncapsulateTarget\s*\{/],
    mustDisappear: true,
  },
  {
    label: 'encapsulate while retaining field uses', source: FIELD_SOURCE,
    snippet: 'public int EncapsulateTarget;', focus: 'EncapsulateTarget',
    title: FIELD_OPTIONS[1], kind: 'refactor.rewrite', options: FIELD_OPTIONS,
    presentAfter: ['public int EncapsulateTarget;', 'field-refactor-sentinel'], absentAfter: [],
    patternsAfter: [/public int \w+\s*\{\s*get => EncapsulateTarget;/],
    mustDisappear: true,
  },
  {
    label: 'generate constructor from field', source: FIELD_SOURCE,
    snippet: 'public int EncapsulateTarget;', focus: 'EncapsulateTarget',
    title: FIELD_OPTIONS[2], kind: 'refactor.rewrite', options: FIELD_OPTIONS,
    presentAfter: ['RefactorTarget(int encapsulateTarget)', 'EncapsulateTarget = encapsulateTarget'],
    absentAfter: [], mustDisappear: true,
  },
  {
    label: 'convert auto property to full property', source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }', focus: 'AutoProperty',
    title: 'Convert to full property', kind: 'refactor.rewrite', options: PROPERTY_OPTIONS,
    presentAfter: ['property-refactor-sentinel'], absentAfter: ['AutoProperty { get; set; }'],
    patternsAfter: [/private int _?autoProperty/i, /public int AutoProperty\s*\{\s*get/],
    mustDisappear: true,
  },
  {
    label: 'convert auto property to field-backed accessors', source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }', focus: 'AutoProperty',
    title: "Convert to 'field' property", kind: 'refactor.rewrite', options: PROPERTY_OPTIONS,
    presentAfter: ['property-refactor-sentinel', 'field'], absentAfter: ['AutoProperty { get; set; }'],
    mustDisappear: true,
  },
  {
    label: 'replace property with methods', source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }', focus: 'AutoProperty',
    title: "Replace 'AutoProperty' with methods", kind: 'refactor.rewrite', options: PROPERTY_OPTIONS,
    presentAfter: ['GetAutoProperty', 'SetAutoProperty', 'property-refactor-sentinel'],
    absentAfter: ['AutoProperty { get; set; }'], mustDisappear: true,
  },
  {
    label: 'generate constructor from property', source: PROPERTY_SOURCE,
    snippet: 'AutoProperty { get; set; }', focus: 'AutoProperty',
    title: "Generate constructor 'RefactorTarget(int autoProperty)'", kind: 'refactor.rewrite', options: PROPERTY_OPTIONS,
    presentAfter: ['RefactorTarget(int autoProperty)', 'AutoProperty = autoProperty'],
    absentAfter: [], mustDisappear: true,
  },
  {
    label: 'invert condition', source: IF_SOURCE, snippet: 'if (input > 0)', focus: 'if',
    title: 'Invert if', kind: 'refactor.rewrite', options: IF_OPTIONS, presentAfter: ['condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'], patternsAfter: [/if \(input <= 0\)|if \(!\(input > 0\)\)/],
    mustDisappear: true,
  },
  {
    label: 'convert condition to switch statement', source: IF_SOURCE,
    snippet: 'if (input > 0)', focus: 'if', title: "Convert to 'switch' statement", kind: 'refactor.rewrite',
    options: IF_OPTIONS, presentAfter: ['switch', 'condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'], mustDisappear: true,
  },
  {
    label: 'convert condition to switch expression', source: IF_SOURCE,
    snippet: 'if (input > 0)', focus: 'if', title: "Convert to 'switch' expression", kind: 'refactor.rewrite',
    options: IF_OPTIONS, presentAfter: ['switch', 'condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'], mustDisappear: true,
  },
  {
    label: 'introduce parameter and update call sites directly', source: PARAMETER_SOURCE,
    snippet: 'input * 2', focus: 'input * 2', title: PARAMETER_OPTIONS[0],
    kind: 'refactor.rewrite', options: PARAMETER_OPTIONS,
    presentAfter: ['introduce-parameter-sentinel'], absentAfter: [],
    patternsAfter: [/Compute\(int input, int \w+\)/, /Compute\(3, 3 \* 2\)/],
  },
  {
    label: 'introduce parameter through an extracted call-site method', source: PARAMETER_SOURCE,
    snippet: 'input * 2', focus: 'input * 2', title: PARAMETER_OPTIONS[1],
    kind: 'refactor.rewrite', options: PARAMETER_OPTIONS,
    presentAfter: ['introduce-parameter-sentinel'], absentAfter: [],
    patternsAfter: [/Compute\(int input, int \w+\)/, /Compute\(3, \w+\(3\)\)/],
  },
  {
    label: 'introduce parameter through a compatibility overload', source: PARAMETER_SOURCE,
    snippet: 'input * 2', focus: 'input * 2', title: PARAMETER_OPTIONS[2],
    kind: 'refactor.rewrite', options: PARAMETER_OPTIONS,
    presentAfter: ['introduce-parameter-sentinel'], absentAfter: [],
    patternsAfter: [/Compute\(int input, int \w+\)/, /Compute\(int input\)[\s\S]*Compute\(input, input \* 2\)/],
  },
];

async function assertOutsideRange(fixture: OpenFixture, scenario: RefactorScenario): Promise<void> {
  const range = rangeOf(fixture.document, 'namespace');
  const raw = await rawCodeActions(fixture.uri, range);
  assert.ok(!raw.some((action) => action.title === scenario.title));
  const actions = await waitForCodeActions({
    uri: fixture.uri, range, kind: vscodeKind(scenario.kind), predicate: () => true,
  });
  assert.ok(!actions.some((action) => action.title === scenario.title));
}

async function discover(
  fixture: OpenFixture,
  scenario: RefactorScenario,
): Promise<{ readonly range: vscode.Range; readonly raw: RawCodeAction[] }> {
  const range = rangeOf(fixture.document, scenario.snippet, scenario.focus);
  const actions = await waitForCodeActions({
    uri: fixture.uri, range, kind: vscodeKind(scenario.kind),
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
    uri: fixture.uri, range, kind: vscodeKind(scenario.kind),
    predicate: (items) => items.some((item) => item.title === scenario.title && item.edit),
  });
  for (const title of scenario.options) onlyAction(actions, title);
  const selected = onlyAction(actions, scenario.title);
  assert.strictEqual(selected.kind?.value, scenario.kind);
  assert.ok(selected.edit, `${scenario.title} must resolve to an edit`);
  return selected.edit;
}

function assertSafeShape(snapshots: readonly WorkspaceEditSnapshot[], fixture: OpenFixture): void {
  assert.strictEqual(snapshots.length, 1, 'a local refactor must change exactly one document');
  assert.strictEqual(snapshots[0]?.uri.toString(), fixture.uri.toString());
  assert.ok((snapshots[0]?.edits.length ?? 0) >= 1);
  assert.ok((snapshots[0]?.replacedText.length ?? 0) >= 1);
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
  const after = await rawCodeActions(fixture.uri, range);
  assertRawActionData(after, fixture.uri);
  const oldIds = new Set(before.map((action) => action.data?.id));
  assert.ok(after.every((action) => !oldIds.has(action.data?.id)), 'requery must mint fresh data ids');
  if (scenario.mustDisappear) assert.ok(!after.some((action) => action.title === scenario.title));
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
  assertSafeShape(await applyWorkspaceEdit(edit), fixture);
  assertMutation(fixture, scenario, version);
  await assertRequery(fixture, scenario, discovered.range, discovered.raw);
  await revertDocument(fixture.document);
  assert.strictEqual(fixture.document.getText(), committedText);
  assert.ok(!fixture.document.isDirty);
}

async function runOrganizeImports(fixture: OpenFixture, committedText: string): Promise<void> {
  const source = 'using System.Text;\nusing System;\nnamespace SharpLsp.TestFixtures.Refactors;\n';
  await replaceDocumentText(fixture.document, source);
  const range = rangeOf(fixture.document, 'using System.Text;');
  const raw = await rawCodeActions(fixture.uri, range);
  assertRawTitles(raw, ['Organize Imports'], 'source.organizeImports');
  assertRawActionData(raw, fixture.uri);
  const actions = await waitForResolvedCodeActions({
    uri: fixture.uri, range, kind: vscode.CodeActionKind.SourceOrganizeImports,
    predicate: (items) => items.some((item) => item.title === 'Organize Imports' && item.edit),
  });
  const action = onlyAction(actions, 'Organize Imports');
  assert.ok(action.edit);
  await applyWorkspaceEdit(action.edit);
  assert.ok(fixture.document.getText().startsWith('using System;\nusing System.Text;'));
  await revertDocument(fixture.document);
  assert.strictEqual(fixture.document.getText(), committedText);
}

function registerCoreTests(
  getFixture: () => OpenFixture,
  getCommittedText: () => string,
): void {
  for (const scenario of SCENARIOS) {
    test(`${scenario.label}: list, resolve, apply, requery, and revert`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await runScenario(getFixture(), getCommittedText(), scenario);
    });
  }
  test('advertised source.organizeImports is real, resolved, applied, and reverted', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await runOrganizeImports(getFixture(), getCommittedText());
  });
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
  registerCoreTests(() => fixture, () => committedText);
});
