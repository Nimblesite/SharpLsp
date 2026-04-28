import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  openCSharpFile,
  setupLspTestSuite,
  teardownLspTestSuite,
  waitForDocumentSymbols,
} from './test-helpers';

suite('Visible Completions', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('visible-completions-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test('screenshot completion site offers real instance members', async function () {
    this.timeout(90_000);

    const source = [
      'namespace CompletionShot',
      '{',
      '    public class Calculator',
      '    {',
      '        private int _count;',
      '        public string Name { get; set; }',
      '        public int Add(int a, int b) { return a + b; }',
      '        public int Use()',
      '        {',
      '            return this.',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');

    const { uri } = await openCSharpFile(tmpDir, 'CompletionShot.cs', source);
    await waitForDocumentSymbols(uri, 30_000);

    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      new vscode.Position(9, 24),
    );

    assert.ok(completions, 'Member-access completion request must return a completion list');
    assert.ok(
      completions.items.length >= 3,
      `Member-access completion list must contain several items, got ${completions.items.length.toString()}`,
    );

    const items = new Map(completions.items.map((item) => [item.label.toString(), item]));
    const labels = new Set(items.keys());
    assert.ok(labels.has('Name'), 'Visible completion site must offer property Name');
    assert.ok(labels.has('Add'), 'Visible completion site must offer method Add');
    assert.ok(labels.has('_count'), 'Visible completion site must offer field _count');
    assert.strictEqual(items.get('Name')?.kind, vscode.CompletionItemKind.Property);
    assert.strictEqual(items.get('Add')?.kind, vscode.CompletionItemKind.Method);
    assert.strictEqual(items.get('_count')?.kind, vscode.CompletionItemKind.Field);
    assert.ok(
      !labels.has('No suggestions.'),
      'Completion labels must contain real symbols, not the empty-widget text',
    );

    const declarationPosition = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      new vscode.Position(6, 22),
    );
    assert.notDeepStrictEqual(
      (declarationPosition?.items ?? []).map((item) => item.label.toString()).sort(),
      [...labels].sort(),
      'Screenshot completion site must not be the old method-declaration position',
    );
  });
});
