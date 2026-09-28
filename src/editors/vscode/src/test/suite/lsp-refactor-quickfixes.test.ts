// Real release-LSP coverage for [SHARPLSP-FEATURES-REFACTORING].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  assertFragments,
  rawCodeActions,
  assertOutsideActionRange,
  assertRequiredDiagnostic,
  discoverAction,
  resolveAction,
  type ActionLifecycleCase,
} from './csharp-refactor-test-kit';
import { diagnosticCode } from './document-anchors';
import {
  applyWorkspaceEdit,
  replaceDocumentText,
  waitForMatchingDiagnostics,
  type OpenFixture,
  type WorkspaceEditSnapshot,
  useRefactorFixture,
  restoreCommitted,
} from './refactor-test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

const FILE = 'RefactorQuickFixes.cs';

/** A compiler quick fix: the lifecycle case plus the diagnostic it answers. */
type QuickFixScenario = ActionLifecycleCase & {
  readonly diagnosticCode: string;
  readonly options: readonly string[];
};

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
    kind: 'quickfix',
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
    kind: 'quickfix',
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
    kind: 'quickfix',
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
    kind: 'quickfix',
    options: ['Implement interface', 'Implement all members explicitly'],
    presentAfter: [
      'public int Compute(int input)',
      'public string Name',
      'implement-interface-sentinel',
    ],
    absentAfter: [],
  },
];

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
    items.every((item) => diagnosticCode(item) !== scenario.diagnosticCode),
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
  await assertRequiredDiagnostic(fixture, scenario);
  await assertOutsideActionRange(fixture, scenario);
  const { range } = await discoverAction(fixture, scenario);
  const edit = await resolveAction(fixture, scenario, range);
  const version = fixture.document.version;
  assertSnapshots(await applyWorkspaceEdit(edit), fixture);
  assertMutation(fixture, scenario, version);
  await assertNoLongerOffered(fixture, scenario, range);
  await restoreCommitted(fixture, committedText);
}

suite('C# real LSP - compiler quick fixes', () => {
  const refactor = useRefactorFixture(FILE);

  for (const scenario of SCENARIOS) {
    test(`${scenario.label}: list, resolve, apply, requery, and revert`, async function () {
      this.timeout(LSP_RESPONSE_MS + 5_000);
      await runScenario(refactor.fixture, refactor.committedText, scenario);
    });
  }
});
