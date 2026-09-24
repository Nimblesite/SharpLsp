// Real-world C# stress suite #2: FluentValidation/FluentValidation @ 12.1.1 (pinned).
//
// Heavy generics, expression trees, and fluent interfaces — a very different
// C# shape from serilog's static facade. Same regime: real clone, real
// restore, real extension host, loads of interactions, loads of assertions,
// plus server memory/CPU bounds.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { codeOf } from './csharp-refactor-test-kit';
import {
  FLUENT_VALIDATION,
  assertSaneRange,
  firstLocation,
  openRepoFile,
  positionOf,
  waitForError,
  waitForErrorBaseline,
  waitForStableErrorBaseline,
} from './real-repo-helpers';
import {
  type Anchor,
  assertHoverStorm,
  assertStructure,
  assertSurvivesStorm,
  completeAfterProbe,
  completionLabels,
  pollLocations,
  useRealRepo,
} from './real-repo-kit';
import {
  flattenSymbolNames,
  pollUntilResult,
  waitForDocumentSymbols,
  assertContainsAll,
} from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

const ABSTRACT_VALIDATOR_CS = 'src/FluentValidation/AbstractValidator.cs';
const IVALIDATOR_CS = 'src/FluentValidation/IValidator.cs';
const VALIDATOR: Anchor = [
  'public abstract partial class AbstractValidator<T>',
  'AbstractValidator',
];
const RULE_FOR: Anchor = ['public IRuleBuilderInitial<T, TProperty> RuleFor<TProperty>', 'RuleFor'];

suite('Real repo stress — FluentValidation (C#)', () => {
  const repoDir = useRealRepo(FLUENT_VALIDATION, ABSTRACT_VALIDATOR_CS, VALIDATOR);

  test('document symbols: the generic validator surface is fully mapped', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri } = await openRepoFile(repoDir(), ABSTRACT_VALIDATOR_CS);
    const symbols = await waitForDocumentSymbols(uri, LSP_RESPONSE_MS);
    const names = flattenSymbolNames(symbols);

    assert.ok(
      names.some((name) => name.startsWith('AbstractValidator')),
      'AbstractValidator<T> must be present',
    );
    for (const member of ['RuleFor', 'RuleForEach', 'Validate', 'ValidateAsync']) {
      assert.ok(
        names.some((name) => name.startsWith(member)),
        `AbstractValidator must expose ${member}`,
      );
    }
    assert.ok(names.length >= 20, `expected a rich symbol tree, got ${names.length.toString()}`);

    const validator = symbols
      .flatMap((symbol) => [symbol, ...symbol.children])
      .find((symbol) => symbol.name.startsWith('AbstractValidator'));
    assert.ok(validator, 'AbstractValidator symbol resolvable');
    assertSaneRange(doc, validator.range, 'AbstractValidator range');
    assert.ok(validator.children.length >= 10, 'the validator class must have many members');
  });

  test('hover storm: generic members produce signature-bearing markdown', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), ABSTRACT_VALIDATOR_CS);
    await assertHoverStorm(
      doc,
      [
        VALIDATOR,
        ['class AbstractValidator<T> : IValidator<T>', 'IValidator'],
        RULE_FOR,
        ['public IRuleBuilderInitialCollection<T, TElement> RuleForEach<TElement>', 'RuleForEach'],
      ],
      true,
    );
  });

  test('navigation: definition into IValidator.cs and references across the codebase', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri } = await openRepoFile(repoDir(), ABSTRACT_VALIDATOR_CS);
    const usage = positionOf(doc, 'class AbstractValidator<T> : IValidator<T>', 'IValidator');

    const definitions = await pollLocations('vscode.executeDefinitionProvider', uri, usage, 1);
    const definition = firstLocation(definitions, 'IValidator definition');
    const defPath = definition.uri.fsPath.replace(/\\/g, '/');
    assert.ok(
      defPath.endsWith(IVALIDATOR_CS),
      `definition must land in IValidator.cs, got ${defPath}`,
    );
    const defDoc = await vscode.workspace.openTextDocument(definition.uri);
    assert.ok(
      defDoc.getText(definition.range).includes('IValidator'),
      'definition range must cover the IValidator identifier',
    );

    const ruleFor = positionOf(doc, ...RULE_FOR);
    const references = await pollLocations('vscode.executeReferenceProvider', uri, ruleFor, 2);
    assert.ok(
      references.length >= 2,
      `RuleFor must have call sites, got ${references.length.toString()}`,
    );
    for (const ref of references.slice(0, 5)) {
      const refDoc = await vscode.workspace.openTextDocument(ref.uri);
      assertSaneRange(refDoc, ref.range, `reference in ${ref.uri.fsPath}`);
    }
  });

  test('live edit + completion: protected members surface inside the class body', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, editor } = await openRepoFile(repoDir(), ABSTRACT_VALIDATOR_CS);
    const insertAt = positionOf(doc, RULE_FOR[0]);
    const completions = await completeAfterProbe(
      editor,
      insertAt,
      'void SharpLspProbe() { this.',
      'RuleFor',
    );
    const labels = completionLabels(completions);
    for (const expected of ['RuleFor', 'RuleForEach', 'Validate']) {
      assert.ok(labels.has(expected), `completion after 'this.' must offer ${expected}`);
    }
    assert.ok(completions.items.length >= 10, 'member completion must be substantial');
    assert.ok(!doc.getText().includes('SharpLspProbe'), 'undo must restore the pristine file');
  });

  test('diagnostics round-trip: a broken generic constraint surfaces and clears', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri, editor } = await openRepoFile(repoDir(), IVALIDATOR_CS);
    await waitForDocumentSymbols(uri, LSP_RESPONSE_MS);
    // Whatever the server settles on for this file IS the baseline — the test is
    // the round trip, not the count. Pinning a number here encodes how much of
    // the solution the server currently resolves rather than a property of the
    // pinned source, and an unreachable pin makes the wait unsatisfiable rather
    // than merely wrong. FluentValidation 12.1.1 is a released library, so a
    // correctly resolved IValidator.cs legitimately reports no errors at all.
    const baseline = await waitForStableErrorBaseline(uri, LSP_RESPONSE_MS);
    const pristineText = doc.getText();
    const pristineVersion = doc.version;
    const insertAt = positionOf(doc, 'public interface IValidator {');
    const probe = 'file class __SharpLspBad { string S = 42; }\n';
    const applied = await editor.edit((edit) => {
      edit.insert(insertAt, probe);
    });
    assert.ok(applied, 'error-inducing edit must apply');
    assert.ok(doc.version > pristineVersion, 'error edit must advance the version');
    assert.ok(doc.getText().includes('__SharpLspBad'));
    const insertedVersion = doc.version;

    try {
      const error = await waitForError(
        uri,
        LSP_RESPONSE_MS,
        (item) => codeOf(item) === 'CS0029' && item.range.start.line === insertAt.line,
      );
      assert.strictEqual(codeOf(error), 'CS0029');
      assert.strictEqual(error.source, 'sharplsp-csharp');
      assertContainsAll(error.message, ["'int'", "'string'"], 'error.message');
      assertSaneRange(doc, error.range, 'injected CS0029');
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    assert.ok(doc.version > insertedVersion, 'undo must advance the document version');
    assert.strictEqual(doc.getText(), pristineText, 'undo must restore the exact source');
    assert.ok(!doc.getText().includes('__SharpLspBad'));
    await waitForErrorBaseline(uri, baseline, LSP_RESPONSE_MS);
  });

  test('structure + rename dry-run: folding, selections, and a safe local rename plan', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri } = await openRepoFile(repoDir(), ABSTRACT_VALIDATOR_CS);
    await assertStructure(doc, { minFolds: 10, anchor: RULE_FOR, minDepth: 2 });

    const renameEdit = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
          'vscode.executeDocumentRenameProvider',
          uri,
          positionOf(doc, 'Expression<Func<T, TProperty>> expression', 'expression'),
          'sharpLspRenamed',
        )) ?? undefined,
      (edit) => edit !== undefined && edit.size > 0,
      LSP_RESPONSE_MS,
      2_000,
    );
    assert.ok(renameEdit, 'rename must produce a WorkspaceEdit');
    assert.ok(renameEdit.size >= 1, 'rename plan must touch at least one file');
    const textEdits = renameEdit.entries().flatMap(([, edits]) => edits);
    assert.ok(textEdits.length >= 1, 'rename must contain text edits');
    // Granularity-agnostic: the sidecar may answer with granular edits or one
    // whole-document replacement. Either way the payload must rewrite the
    // declaration AND both body uses (ThrowIfNull + PropertyRule.Create) = 3+.
    const renamedCount = textEdits.reduce(
      (sum, edit) => sum + (edit.newText.match(/sharpLspRenamed/g) ?? []).length,
      0,
    );
    assert.ok(
      renamedCount >= 3,
      `rename payload must rewrite declaration and both uses — new name appears ${renamedCount.toString()}x`,
    );
  });

  test('stress: rapid-fire mixed requests stay within memory/CPU bounds', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), ABSTRACT_VALIDATOR_CS);
    await assertSurvivesStorm(doc, RULE_FOR, 10_000);
  });
});
