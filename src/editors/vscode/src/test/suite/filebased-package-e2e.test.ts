import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LSP_RESPONSE_TIMEOUT_MS,
  closeAllEditors,
  pollUntilResult,
  replaceDocumentContent,
  setupLspTestSuite,
  teardownLspTestSuite,
  waitForDiagnostics,
  waitForHoverResult,
} from './test-helpers';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import {
  PACKAGE,
  RESTORE_TIMEOUT_MS,
  assertNoPackageBindingErrors,
  completionList,
  diagnosticCode,
  errorsFor,
  hoverText,
  itemNamed,
  openFileBasedApp,
  positionAfter,
  positionInside,
  waitForErrorCode,
  waitForHoverText,
} from './filebased-package-kit';

function insertionRange(item: vscode.CompletionItem): vscode.Range {
  const range = item.range;
  assert.ok(range, `${item.label.toString()} must carry an explicit insertion range`);
  if (range instanceof vscode.Range) return range;
  assert.ok(
    range.inserting.isEqual(range.replacing),
    'empty-span insert/replace ranges must match',
  );
  return range.inserting;
}

function insertionText(item: vscode.CompletionItem): string {
  const inserted = item.insertText;
  if (typeof inserted !== 'string') {
    assert.fail('resolved completion must insert plain text');
  }
  return inserted;
}

suite('VSIX E2E — C# file-based #:package directives', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    ({ tmpDir } = await setupLspTestSuite('filebased-package-'));
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    await loadSolutionInServer(fixtureSolutionPath());
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // Implements [SCRIPT-FILEBASED-REFERENCES-MSBUILD] and [SCRIPT-TESTS].
  test('a package directive binds real package symbols through the extension host', async function () {
    this.timeout(RESTORE_TIMEOUT_MS + 30_000);
    const source = `${PACKAGE}
using Newtonsoft.Json.Linq;

var payload = JObject.Parse("{\\"answer\\":42}");
var clone = payload.DeepClone();
Console.WriteLine(clone.ToString());
`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'PackageApp.cs', source);

    assert.strictEqual(doc.languageId, 'csharp', 'the target is handled as C#');
    assert.strictEqual(doc.uri.toString(), uri.toString(), 'the opened URI is the requested file');
    assert.strictEqual(doc.lineAt(0).text, PACKAGE, 'the package directive remains verbatim');
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'PackageApp.csproj')), false);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'Directory.Build.props')), false);

    const typePosition = positionInside(source, 'JObject');
    const hovers = await waitForHoverText(uri, typePosition, 'Newtonsoft.Json.Linq');
    const markdown = hoverText(hovers);
    assert.ok(hovers.length > 0, 'restored JObject must return hover information');
    assert.ok(markdown.includes('JObject'), 'hover must name the package type');
    assert.ok(markdown.includes('Newtonsoft.Json.Linq'), 'hover must name the package namespace');

    const completions = await completionList(uri, positionAfter(source, 'payload.'), 'DeepClone');
    assert.ok(completions.items.length > 3, 'package member completion must be non-trivial');
    assert.strictEqual(
      itemNamed(completions, 'DeepClone').kind,
      vscode.CompletionItemKind.Method,
      'DeepClone is a real package method, not a text fallback',
    );
    assert.strictEqual(
      itemNamed(completions, 'Properties').kind,
      vscode.CompletionItemKind.Method,
      'JObject.Properties must retain its Roslyn symbol kind',
    );
    assertNoPackageBindingErrors(uri);
  });

  // Implements [SCRIPT-RELOAD] and [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
  test('unsaved add, remove and re-add transitions rebuild the package reference set', async function () {
    this.timeout(RESTORE_TIMEOUT_MS * 3);
    const withoutDirective = `using Newtonsoft.Json.Linq;

var payload = new JObject();
Console.WriteLine(payload.Count);
`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'LivePackage.cs', withoutDirective);
    const initialVersion = doc.version;
    const missing = await waitForErrorCode(uri, 'CS0246');
    assert.ok(missing.length > 0, 'the no-package baseline must be genuinely unresolved');
    assert.ok(missing.every((diagnostic) => diagnostic.source === 'sharplsp-csharp'));
    assert.ok(missing.some((diagnostic) => diagnostic.range.start.line <= 2));

    const withDirective = `${PACKAGE}\n${withoutDirective}`;
    assert.strictEqual(await replaceDocumentContent(doc, withDirective), true);
    assert.ok(doc.isDirty, 'the package edit remains unsaved while didChange is exercised');
    assert.ok(doc.version > initialVersion, 'VS Code increments the document version');
    assert.strictEqual(doc.lineAt(0).text, PACKAGE, 'the in-memory directive is visible');

    const added = await completionList(uri, positionAfter(withDirective, 'payload.'), 'Properties');
    assert.strictEqual(itemNamed(added, 'Properties').kind, vscode.CompletionItemKind.Method);
    const packageHover = hoverText(
      await waitForHoverText(uri, positionInside(withDirective, 'JObject'), 'Newtonsoft.Json.Linq'),
    );
    assert.ok(packageHover.includes('JObject'), 'adding the directive binds the package type');
    assertNoPackageBindingErrors(uri);

    const versionWithPackage = doc.version;
    assert.strictEqual(await replaceDocumentContent(doc, withoutDirective), true);
    assert.ok(doc.version > versionWithPackage, 'removal is a new didChange generation');
    assert.strictEqual(doc.getText().startsWith('#:package'), false, 'directive was removed');
    const removed = await waitForErrorCode(uri, 'CS0246');
    assert.ok(removed.some((diagnostic) => diagnosticCode(diagnostic) === 'CS0246'));
    assert.ok(removed.some((diagnostic) => diagnostic.message.includes('JObject')));

    assert.strictEqual(await replaceDocumentContent(doc, withDirective), true);
    const restored = await completionList(
      uri,
      positionAfter(withDirective, 'payload.'),
      'DeepClone',
    );
    assert.strictEqual(itemNamed(restored, 'DeepClone').kind, vscode.CompletionItemKind.Method);
    assertNoPackageBindingErrors(uri);
  });

  // Implements [SCRIPT-FILEBASED], [SCRIPT-FILEBASED-DIRECTIVES], and [SCRIPT-TESTS].
  test('a package directive in the include closure binds symbols in the root', async function () {
    this.timeout(RESTORE_TIMEOUT_MS + 30_000);
    const includePath = path.join(tmpDir, 'PackageTypes.cs');
    const included = `${PACKAGE}
using Newtonsoft.Json.Linq;

public static class PackageFactory
{
    public static JObject Create() => new JObject();
}
`;
    fs.writeFileSync(includePath, included, 'utf8');
    const root = `#:include PackageTypes.cs
var payload = PackageFactory.Create();
Console.WriteLine(payload.Count);
`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'IncludedPackageApp.cs', root);

    assert.strictEqual(doc.lineAt(0).text, '#:include PackageTypes.cs');
    assert.strictEqual(
      fs.readFileSync(includePath, 'utf8'),
      included,
      'closure input is unchanged',
    );
    assert.strictEqual(doc.getText().includes(PACKAGE), false, 'the root itself has no package');

    const factoryHover = hoverText(
      await waitForHoverText(uri, positionInside(root, 'PackageFactory'), 'PackageFactory'),
    );
    assert.ok(factoryHover.includes('PackageFactory'), 'the included declaration binds in root');
    const members = await completionList(uri, positionAfter(root, 'payload.'), 'DeepClone');
    assert.strictEqual(itemNamed(members, 'DeepClone').kind, vscode.CompletionItemKind.Method);
    assert.strictEqual(itemNamed(members, 'Properties').kind, vscode.CompletionItemKind.Method);
    assertNoPackageBindingErrors(uri);
  });

  // Implements [SCRIPT-MULTIROOT] and guards package-reference leakage.
  test('a package reference never leaks into a neighboring file-based root', async function () {
    this.timeout(RESTORE_TIMEOUT_MS * 2);
    const packageRoot = `${PACKAGE}
using Newtonsoft.Json.Linq;
var owned = new JObject();
Console.WriteLine(owned.Count);
`;
    const plainRoot = `using Newtonsoft.Json.Linq;
var isolated = new JObject();
Console.WriteLine(isolated.Count);
`;
    const packageFile = await openFileBasedApp(tmpDir, 'RootWithPackage.cs', packageRoot);
    const bound = await completionList(
      packageFile.uri,
      positionAfter(packageRoot, 'owned.'),
      'Properties',
    );
    assert.strictEqual(itemNamed(bound, 'Properties').kind, vscode.CompletionItemKind.Method);
    assertNoPackageBindingErrors(packageFile.uri);

    const plainFile = await openFileBasedApp(tmpDir, 'RootWithoutPackage.cs', plainRoot);
    assert.notStrictEqual(plainFile.uri.toString(), packageFile.uri.toString());
    const isolatedErrors = await waitForErrorCode(plainFile.uri, 'CS0246');
    assert.ok(isolatedErrors.some((diagnostic) => diagnostic.message.includes('JObject')));
    assert.ok(isolatedErrors.every((diagnostic) => diagnostic.source === 'sharplsp-csharp'));

    const stillBound = await completionList(
      packageFile.uri,
      positionAfter(packageRoot, 'owned.'),
      'DeepClone',
    );
    assert.strictEqual(itemNamed(stillBound, 'DeepClone').kind, vscode.CompletionItemKind.Method);
    assertNoPackageBindingErrors(packageFile.uri);
  });

  // Implements the required tier-2 behavior in [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
  test('restore failure degrades visibly while BCL IntelliSense stays alive', async function () {
    this.timeout(RESTORE_TIMEOUT_MS + 30_000);
    const missingPackage = '#:package SharpLsp.Package.That.Does.Not.Exist@0.0.0';
    const source = `${missingPackage}
var text = string.Empty;
Console.WriteLine(text.Length);
`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'DegradedPackageApp.cs', source);

    assert.strictEqual(doc.lineAt(0).text, missingPackage, 'the failing directive is preserved');
    const consoleHover = hoverText(
      await waitForHoverResult(uri, positionInside(source, 'Console'), RESTORE_TIMEOUT_MS),
    );
    assert.ok(consoleHover.includes('Console'), 'tier 2 must retain BCL hover');
    assert.ok(consoleHover.includes('System'), 'tier-2 hover must retain the BCL namespace');
    const bclMembers = await completionList(uri, positionAfter(source, 'text.'), 'Length');
    assert.strictEqual(
      itemNamed(bclMembers, 'Length').kind,
      vscode.CompletionItemKind.Property,
      'tier 2 must retain typed BCL completion',
    );

    const diagnostics = await pollUntilResult(
      async () => vscode.languages.getDiagnostics(uri),
      (items) =>
        items.some(
          (diagnostic) =>
            diagnosticCode(diagnostic) === 'SLSPC0001' &&
            diagnostic.severity === vscode.DiagnosticSeverity.Information &&
            diagnostic.message.includes('Restore failed') &&
            diagnostic.message.includes('SharpLsp.Package.That.Does.Not.Exist@0.0.0'),
        ),
      RESTORE_TIMEOUT_MS,
      1_000,
    );
    const degraded = diagnostics.filter((diagnostic) => diagnosticCode(diagnostic) === 'SLSPC0001');
    assert.strictEqual(degraded.length, 1, 'tier 2 emits one explicit fallback diagnostic');
    assert.strictEqual(degraded[0]?.severity, vscode.DiagnosticSeverity.Information);
    assert.strictEqual(degraded[0]?.source, 'sharplsp-csharp');
    assert.strictEqual(degraded[0]?.range.start.line, 0);
    assert.strictEqual(degraded[0]?.range.start.character, 0);
    assert.strictEqual(degraded[0]?.range.end.line, 0);
    assert.strictEqual(degraded[0]?.range.end.character, 1);
    assert.ok(degraded[0]?.message.includes('BCL-only references'));
    assert.ok(degraded[0]?.message.includes('Restore failed'));
    assert.ok(!degraded[0]?.message.includes('pending'));
    assert.ok(degraded[0]?.message.includes('SharpLsp.Package.That.Does.Not.Exist'));
    assert.ok(degraded[0]?.message.includes('0.0.0'));
    assert.deepStrictEqual(errorsFor(uri), [], 'restore failure must not kill BCL analysis');
  });

  // Implements directive placement in [SCRIPT-FILEBASED-DIRECTIVES].
  test('a misplaced package directive is rejected at its own source range', async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS * 5);
    const source = `Console.WriteLine("before");
${PACKAGE}
using Newtonsoft.Json.Linq;
var payload = new JObject();
`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'MisplacedPackage.cs', source);
    const diagnostics = await waitForDiagnostics(uri, LSP_RESPONSE_TIMEOUT_MS * 4);
    const directiveDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.range.start.line === 1,
    );

    assert.strictEqual(doc.lineAt(1).text, PACKAGE, 'the misplaced text is not rewritten');
    assert.ok(directiveDiagnostics.length > 0, 'the directive line must carry a diagnostic');
    assert.ok(
      directiveDiagnostics.some(
        (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error,
      ),
      'misplacement is an error, not silent package activation',
    );
    assert.ok(
      directiveDiagnostics.some((diagnostic) =>
        /directive|before|precede/i.test(diagnostic.message),
      ),
      'the diagnostic must explain directive placement',
    );
    assert.ok(
      diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === 'CS0246'),
      'a misplaced directive must not leak a package reference into the compilation',
    );
    assert.ok(directiveDiagnostics.every((diagnostic) => diagnostic.source === 'sharplsp-csharp'));
  });

  // Implements reference replacement on didChange in [SCRIPT-RELOAD].
  test('changing package identity removes stale references before adding the new package', async function () {
    this.timeout(RESTORE_TIMEOUT_MS * 3);
    const humanizer = '#:package Humanizer.Core@2.14.1';
    const body = `using Newtonsoft.Json.Linq;
using Humanizer;
var json = new JObject();
var plural = "person".Pluralize();
Console.WriteLine(json.Count + plural.Length);
`;
    const first = `${PACKAGE}\n${body}`;
    const second = `${humanizer}\n${body}`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'PackageSwap.cs', first);

    const jsonMembers = await completionList(uri, positionAfter(first, 'json.'), 'Properties');
    assert.strictEqual(itemNamed(jsonMembers, 'Properties').kind, vscode.CompletionItemKind.Method);
    const missingHumanizer = await waitForErrorCode(uri, 'CS1061');
    assert.ok(missingHumanizer.some((diagnostic) => diagnostic.message.includes('Pluralize')));

    const beforeSwapVersion = doc.version;
    assert.strictEqual(await replaceDocumentContent(doc, second), true);
    assert.ok(doc.version > beforeSwapVersion, 'package replacement is a new didChange generation');
    assert.strictEqual(doc.lineAt(0).text, humanizer, 'the new package identity is in memory');
    assert.strictEqual(doc.getText().includes(PACKAGE), false, 'the old directive is gone');

    const humanizerHover = hoverText(
      await waitForHoverText(uri, positionInside(second, 'Pluralize'), 'Humanizer'),
    );
    assert.ok(humanizerHover.includes('Pluralize'), 'the replacement package binds');
    assert.ok(humanizerHover.includes('Humanizer'), 'hover identifies the replacement package');
    const staleReferenceErrors = await waitForErrorCode(uri, 'CS0246');
    assert.ok(staleReferenceErrors.some((diagnostic) => diagnostic.message.includes('JObject')));
    assert.ok(
      !staleReferenceErrors.some((diagnostic) => diagnostic.message.includes('Pluralize')),
      'the new package API must not remain unresolved',
    );
  });

  // Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
  test('resolved empty-span completion applies its primary edit exactly once', async function () {
    this.timeout(RESTORE_TIMEOUT_MS);
    const source = 'var result = 42;\nresult.';
    const { doc, uri } = await openFileBasedApp(tmpDir, 'EmptyCompletionSpan.cs', source);
    const caret = positionAfter(source, 'result.');
    const completions = await completionList(uri, caret, 'ToString', 10_000);
    const toString = itemNamed(completions, 'ToString');
    const primaryRange = insertionRange(toString);
    const primaryText = insertionText(toString);

    assert.strictEqual(toString.kind, vscode.CompletionItemKind.Method);
    assert.ok(primaryRange.isEmpty, 'the member-access completion span is empty');
    assert.ok(primaryRange.start.isEqual(caret), 'the primary edit starts at the caret');
    assert.ok(primaryRange.end.isEqual(caret), 'the primary edit also ends at the caret');
    assert.strictEqual(primaryText, 'ToString', 'the primary edit inserts once');
    const additional = toString.additionalTextEdits ?? [];
    assert.deepStrictEqual(
      additional.filter((edit) => edit.newText.includes('ToString')),
      [],
      'the primary ToString edit must never be duplicated into additionalTextEdits',
    );
    assert.ok(
      additional.every((edit) => !edit.range.intersection(primaryRange)),
      'every additional edit must be disjoint from the primary completion span',
    );

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(uri, primaryRange, primaryText);
    for (const edit of additional) workspaceEdit.replace(uri, edit.range, edit.newText);
    assert.strictEqual(await vscode.workspace.applyEdit(workspaceEdit), true);
    assert.strictEqual(doc.getText(), 'var result = 42;\nresult.ToString');
    assert.strictEqual(doc.getText().split('ToString').length - 1, 1, 'text appears exactly once');
  });
});
