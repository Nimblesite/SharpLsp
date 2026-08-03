// Real release-LSP coverage for [SHARPLSP-FEATURES-REFACTORING].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  assertFragments,
  assertRawActionData,
  assertRawTitles,
  codeOf,
  onlyAction,
  rangeOf,
  rawCodeActions,
} from './csharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  applyWorkspaceEdit,
  openFixtureDocument,
  replaceDocumentText,
  revertDocument,
  waitForCodeActions,
  waitForMatchingDiagnostics,
  waitForResolvedCodeActions,
  type OpenFixture,
  type WorkspaceEditSnapshot,
} from './refactor-test-helpers';

const FILE = 'RefactorQuickFixes.cs';
const TEST_TIMEOUT_MS = 180_000;

interface QuickFixScenario {
  readonly label: string;
  readonly source: string;
  readonly snippet: string;
  readonly focus: string;
  readonly diagnosticCode: string;
  readonly title: string;
  readonly options: readonly string[];
  readonly presentAfter: readonly string[];
  readonly absentAfter: readonly string[];
}

const UNUSED_LOCAL = `namespace SharpLsp.TestFixtures.Refactors;

public sealed class QuickFixTarget
{
    public int Compute(int input)
    {
        var unusedValue = 42;
        return input + 1; // unused-local-sentinel
    }
}
`;

const ADD_USING = `namespace SharpLsp.TestFixtures.Refactors;

public sealed class QuickFixTarget
{
    public string Build()
    {
        var builder = new StringBuilder();
        builder.Append("add-using-sentinel");
        return builder.ToString();
    }
}
`;

const GENERATE_METHOD = `namespace SharpLsp.TestFixtures.Refactors;

public sealed class QuickFixTarget
{
    public int Existing(int value) => value + 1;

    public int Compute(int input)
    {
        return MissingOperation(input) + Existing(input); // generate-method-sentinel
    }
}
`;

const IMPLEMENT_INTERFACE = `namespace SharpLsp.TestFixtures.Refactors;

public interface IQuickContract
{
    int Compute(int input);
    string Name { get; }
}

public sealed class QuickFixTarget : IQuickContract
{
    public int Existing(int value) => value + 1; // implement-interface-sentinel
}
`;

const SCENARIOS: readonly QuickFixScenario[] = [
  {
    label: 'unused local removal',
    source: UNUSED_LOCAL,
    snippet: 'var unusedValue = 42;',
    focus: 'unusedValue',
    diagnosticCode: 'CS0219',
    title: 'Remove unused variable',
    options: ['Remove unused variable'],
    presentAfter: ['return input + 1;', 'unused-local-sentinel'],
    absentAfter: ['unusedValue'],
  },
  {
    label: 'missing namespace import',
    source: ADD_USING,
    snippet: 'new StringBuilder()',
    focus: 'StringBuilder',
    diagnosticCode: 'CS0246',
    title: 'using System.Text;',
    options: ['System.Text.StringBuilder', 'using System.Text;'],
    presentAfter: ['using System.Text;', 'new StringBuilder()', 'add-using-sentinel'],
    absentAfter: [],
  },
  {
    label: 'missing method generation',
    source: GENERATE_METHOD,
    snippet: 'MissingOperation(input)',
    focus: 'MissingOperation',
    diagnosticCode: 'CS0103',
    title: "Generate method 'MissingOperation'",
    options: ["Generate method 'MissingOperation'"],
    presentAfter: ['MissingOperation(int input)', 'throw new', 'generate-method-sentinel'],
    absentAfter: [],
  },
  {
    label: 'interface implementation',
    source: IMPLEMENT_INTERFACE,
    snippet: 'QuickFixTarget : IQuickContract',
    focus: 'IQuickContract',
    diagnosticCode: 'CS0535',
    title: 'Implement interface',
    options: ['Implement interface', 'Implement all members explicitly'],
    presentAfter: [
      'public int Compute(int input)',
      'public string Name',
      'implement-interface-sentinel',
    ],
    absentAfter: [],
  },
];

async function assertNegativeRange(
  fixture: OpenFixture,
  scenario: QuickFixScenario,
): Promise<void> {
  const outside = rangeOf(fixture.document, 'namespace', 'namespace');
  const raw = await rawCodeActions(fixture.uri, outside);
  assert.ok(!raw.some((action) => action.title === scenario.title));
  const actions = await waitForCodeActions({
    uri: fixture.uri,
    range: outside,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: () => true,
  });
  assert.ok(!actions.some((action) => action.title === scenario.title));
}

async function assertDiagnostic(fixture: OpenFixture, scenario: QuickFixScenario): Promise<void> {
  const diagnostics = await waitForMatchingDiagnostics(fixture.uri, (items) =>
    items.some((item) => codeOf(item) === scenario.diagnosticCode),
  );
  const matches = diagnostics.filter((item) => codeOf(item) === scenario.diagnosticCode);
  assert.ok(matches.length >= 1, `missing ${scenario.diagnosticCode}`);
  assert.ok(matches.every((item) => item.message.length > 0));
  assert.ok(matches.every((item) => !item.range.isEmpty));
}

async function discoverInside(
  fixture: OpenFixture,
  scenario: QuickFixScenario,
): Promise<vscode.Range> {
  const range = rangeOf(fixture.document, scenario.snippet, scenario.focus);
  const actions = await waitForCodeActions({
    uri: fixture.uri,
    range,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: (items) => items.some((item) => item.title === scenario.title),
  });
  onlyAction(actions, scenario.title);
  const raw = await rawCodeActions(fixture.uri, range);
  assertRawTitles(raw, scenario.options, 'quickfix');
  assertRawActionData(raw, fixture.uri);
  return range;
}

async function resolveEdit(
  fixture: OpenFixture,
  scenario: QuickFixScenario,
  range: vscode.Range,
): Promise<vscode.WorkspaceEdit> {
  const actions = await waitForResolvedCodeActions({
    uri: fixture.uri,
    range,
    kind: vscode.CodeActionKind.QuickFix,
    predicate: (items) => items.some((item) => item.title === scenario.title && item.edit),
  });
  for (const title of scenario.options) onlyAction(actions, title);
  const selected = onlyAction(actions, scenario.title);
  assert.strictEqual(selected.kind?.value, vscode.CodeActionKind.QuickFix.value);
  assert.ok(selected.edit, `${scenario.title} must resolve to a WorkspaceEdit`);
  return selected.edit;
}

function assertSnapshots(snapshots: readonly WorkspaceEditSnapshot[], fixture: OpenFixture): void {
  assert.strictEqual(snapshots.length, 1, 'selected quick fix must edit one document');
  assert.strictEqual(snapshots[0]?.uri.toString(), fixture.uri.toString());
  assert.ok((snapshots[0]?.edits.length ?? 0) >= 1);
  assert.ok((snapshots[0]?.textBefore.length ?? 0) > 0);
}

function assertMutation(
  fixture: OpenFixture,
  scenario: QuickFixScenario,
  previousVersion: number,
): void {
  const after = fixture.document.getText();
  assertFragments(after, scenario.presentAfter, scenario.absentAfter);
  assert.ok(fixture.document.version > previousVersion, 'apply must advance the document version');
  assert.ok(fixture.document.isDirty, 'the applied user edit must remain dirty until reverted');
}

async function assertNoLongerOffered(
  fixture: OpenFixture,
  scenario: QuickFixScenario,
  range: vscode.Range,
): Promise<void> {
  await waitForMatchingDiagnostics(fixture.uri, (items) =>
    items.every((item) => codeOf(item) !== scenario.diagnosticCode),
  );
  const raw = await rawCodeActions(fixture.uri, range);
  assert.ok(!raw.some((action) => action.title === scenario.title));
}

async function runScenario(
  fixture: OpenFixture,
  committedText: string,
  scenario: QuickFixScenario,
): Promise<void> {
  await replaceDocumentText(fixture.document, scenario.source);
  assert.ok(fixture.document.isDirty);
  await assertDiagnostic(fixture, scenario);
  await assertNegativeRange(fixture, scenario);
  const range = await discoverInside(fixture, scenario);
  const edit = await resolveEdit(fixture, scenario, range);
  const version = fixture.document.version;
  assertSnapshots(await applyWorkspaceEdit(edit), fixture);
  assertMutation(fixture, scenario, version);
  await assertNoLongerOffered(fixture, scenario, range);
  await revertDocument(fixture.document);
  assert.strictEqual(fixture.document.getText(), committedText);
  assert.ok(!fixture.document.isDirty);
}

suite('C# real LSP - compiler quick fixes', () => {
  let fixture: OpenFixture;
  let committedText = '';

  suiteSetup(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await activateRealSharpLsp();
    fixture = await openFixtureDocument(FILE);
    committedText = fixture.document.getText();
  });

  teardown(async () => revertDocument(fixture.document));

  for (const scenario of SCENARIOS) {
    test(`${scenario.label}: list, resolve, apply, requery, and revert`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await runScenario(fixture, committedText, scenario);
    });
  }
});
