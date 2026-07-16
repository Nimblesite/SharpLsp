// Real-world C# stress suite #2: FluentValidation/FluentValidation @ 12.1.1 (pinned).
//
// Heavy generics, expression trees, and fluent interfaces — a very different
// C# shape from serilog's static facade. Same regime: real clone, real
// restore, real extension host, loads of interactions, loads of assertions,
// plus server memory/CPU bounds.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hoverText } from './fsharp-helpers';
import {
  FLUENT_VALIDATION,
  assertCpuSettles,
  assertSaneRange,
  assertServerResourceBounds,
  ensureRepoReady,
  completionLabel,
  firstError,
  firstLocation,
  fixtureSolutionPath,
  loadSolutionInServer,
  openRepoFile,
  positionOf,
  sampleServerProcesses,
  selectionDepth,
  waitForErrorsCleared,
  waitForSemanticReady,
} from './real-repo-helpers';
import {
  closeAllEditors,
  flattenSymbolNames,
  pollUntilResult,
  waitForDiagnostics,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  waitForHoverResult,
  waitForSelectionRanges,
} from './test-helpers';

const ABSTRACT_VALIDATOR_CS = 'src/FluentValidation/AbstractValidator.cs';
const IVALIDATOR_CS = 'src/FluentValidation/IValidator.cs';

suite('Real repo stress — FluentValidation (C#)', () => {
  let repoDir: string;

  suiteSetup(async function () {
    this.timeout(900_000);
    repoDir = ensureRepoReady(FLUENT_VALIDATION);
    await loadSolutionInServer(path.join(repoDir, FLUENT_VALIDATION.sln));
    const { doc, uri } = await openRepoFile(repoDir, ABSTRACT_VALIDATOR_CS);
    await waitForDocumentSymbols(uri, 120_000);
    await waitForSemanticReady(
      uri,
      positionOf(doc, 'public abstract partial class AbstractValidator<T>', 'AbstractValidator'),
      600_000,
    );
  });

  suiteTeardown(async function () {
    this.timeout(120_000);
    await closeAllEditors();
    await loadSolutionInServer(fixtureSolutionPath());
  });

  test('document symbols: the generic validator surface is fully mapped', async function () {
    this.timeout(120_000);
    const { doc, uri } = await openRepoFile(repoDir, ABSTRACT_VALIDATOR_CS);
    const symbols = await waitForDocumentSymbols(uri, 120_000);
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
    this.timeout(180_000);
    const { doc, uri } = await openRepoFile(repoDir, ABSTRACT_VALIDATOR_CS);
    const anchors: [string, string][] = [
      ['public abstract partial class AbstractValidator<T>', 'AbstractValidator'],
      ['class AbstractValidator<T> : IValidator<T>', 'IValidator'],
      ['public IRuleBuilderInitial<T, TProperty> RuleFor<TProperty>', 'RuleFor'],
      ['public IRuleBuilderInitialCollection<T, TElement> RuleForEach<TElement>', 'RuleForEach'],
    ];
    for (const [snippet, focus] of anchors) {
      const hover = await waitForHoverResult(uri, positionOf(doc, snippet, focus), 60_000);
      const text = hoverText(hover);
      assert.ok(text.length > 0, `hover on '${focus}' must not be empty`);
      assert.ok(
        text.includes(focus),
        `hover on '${focus}' must mention it, got: ${text.slice(0, 200)}`,
      );
    }
  });

  test('navigation: definition into IValidator.cs and references across the codebase', async function () {
    this.timeout(180_000);
    const { doc, uri } = await openRepoFile(repoDir, ABSTRACT_VALIDATOR_CS);
    const usage = positionOf(doc, 'class AbstractValidator<T> : IValidator<T>', 'IValidator');

    const definitions = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          uri,
          usage,
        )) ?? [],
      (locations) => locations.length > 0,
      120_000,
      2_000,
    );
    const definition = firstLocation(definitions, 'IValidator definition');
    const defPath = definition.uri.fsPath.replace(/\\/g, '/');
    assert.ok(defPath.endsWith(IVALIDATOR_CS), `definition must land in IValidator.cs, got ${defPath}`);
    const defDoc = await vscode.workspace.openTextDocument(definition.uri);
    assert.ok(
      defDoc.getText(definition.range).includes('IValidator'),
      'definition range must cover the IValidator identifier',
    );

    const references = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          uri,
          positionOf(doc, 'public IRuleBuilderInitial<T, TProperty> RuleFor<TProperty>', 'RuleFor'),
        )) ?? [],
      (locations) => locations.length >= 2,
      120_000,
      2_000,
    );
    assert.ok(references.length >= 2, `RuleFor must have call sites, got ${references.length.toString()}`);
    for (const ref of references.slice(0, 5)) {
      const refDoc = await vscode.workspace.openTextDocument(ref.uri);
      assertSaneRange(refDoc, ref.range, `reference in ${ref.uri.fsPath}`);
    }
  });

  test('live edit + completion: protected members surface inside the class body', async function () {
    this.timeout(180_000);
    const { doc, uri, editor } = await openRepoFile(repoDir, ABSTRACT_VALIDATOR_CS);
    const marker = 'public IRuleBuilderInitial<T, TProperty> RuleFor<TProperty>';
    const insertAt = positionOf(doc, marker);
    const probe = 'void SharpLspProbe() { this.';
    const applied = await editor.edit((edit) => {
      edit.insert(insertAt, probe);
    });
    assert.ok(applied, 'probe edit must apply');

    try {
      const cursor = doc.positionAt(doc.getText().indexOf(probe) + probe.length);
      const completions = await pollUntilResult(
        async () =>
          (await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            uri,
            cursor,
            '.',
          )) ?? new vscode.CompletionList(),
        (list) => list.items.some((item) => completionLabel(item) === 'RuleFor'),
        120_000,
        2_000,
      );
      const labels = new Set(completions.items.map(completionLabel));
      for (const expected of ['RuleFor', 'RuleForEach', 'Validate']) {
        assert.ok(labels.has(expected), `completion after 'this.' must offer ${expected}`);
      }
      assert.ok(completions.items.length >= 10, 'member completion must be substantial');
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    assert.ok(!doc.getText().includes('SharpLspProbe'), 'undo must restore the pristine file');
  });

  test('diagnostics round-trip: a broken generic constraint surfaces and clears', async function () {
    this.timeout(180_000);
    const { doc, uri, editor } = await openRepoFile(repoDir, IVALIDATOR_CS);
    await waitForDocumentSymbols(uri, 120_000);
    const insertAt = positionOf(doc, 'public interface IValidator {');
    const applied = await editor.edit((edit) => {
      edit.insert(insertAt, 'file class __SharpLspBad { string S = 42; }\n');
    });
    assert.ok(applied, 'error-inducing edit must apply');

    try {
      const diagnostics = await waitForDiagnostics(uri, 120_000);
      const error = firstError(diagnostics, 'bad field initializer');
      assert.ok(error.message.length > 0, 'diagnostic must carry a message');
      assertSaneRange(doc, error.range, 'error diagnostic');
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    await waitForErrorsCleared(uri, 120_000);
  });

  test('structure + rename dry-run: folding, selections, and a safe local rename plan', async function () {
    this.timeout(180_000);
    const { doc, uri } = await openRepoFile(repoDir, ABSTRACT_VALIDATOR_CS);
    const folding = await waitForFoldingRanges(uri, 60_000);
    assert.ok(folding.length >= 10, `AbstractValidator.cs must fold richly, got ${folding.length.toString()}`);

    const selections = await waitForSelectionRanges(
      uri,
      [positionOf(doc, 'public IRuleBuilderInitial<T, TProperty> RuleFor<TProperty>', 'RuleFor')],
      60_000,
    );
    const depth = selectionDepth(selections[0], 'RuleFor selection');
    assert.ok(depth >= 2, `selection range must expand through nesting, depth ${depth.toString()}`);

    const renameEdit = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
          'vscode.executeDocumentRenameProvider',
          uri,
          positionOf(doc, 'Expression<Func<T, TProperty>> expression', 'expression'),
          'sharpLspRenamed',
        )) ?? undefined,
      (edit) => edit !== undefined && edit.size > 0,
      120_000,
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
    this.timeout(300_000);
    const { doc, uri } = await openRepoFile(repoDir, ABSTRACT_VALIDATOR_CS);
    const hoverAt = positionOf(doc, 'public IRuleBuilderInitial<T, TProperty> RuleFor<TProperty>', 'RuleFor');

    for (let round = 0; round < 10; round += 1) {
      const [symbols, hover, folding] = await Promise.all([
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri),
        vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, hoverAt),
        vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', uri),
      ]);
      assert.ok((symbols ?? []).length > 0, `round ${round.toString()}: symbols must keep answering`);
      assert.ok((hover ?? []).length > 0, `round ${round.toString()}: hover must keep answering`);
      assert.ok((folding ?? []).length > 0, `round ${round.toString()}: folding must keep answering`);
    }

    assertServerResourceBounds(sampleServerProcesses());
    await assertCpuSettles(5_000, 20);
    const after = await waitForDocumentSymbols(uri, 10_000);
    assert.ok(after.length > 0, 'server must stay responsive after the storm');
  });
});
