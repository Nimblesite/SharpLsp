import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeAllEditors,
  pollUntilResult,
  replaceDocumentContent,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import {
  PACKAGE,
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
import { ACTIVATION_MS, DOTNET_CLI_MS } from './test-timeouts';

function writeFixture(tmpDir: string, filename: string, content: string): string {
  const target = path.join(tmpDir, filename);
  fs.writeFileSync(target, content, 'utf8');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), content, `${filename} fixture is exact`);
  return target;
}

async function waitForMarkerWithoutError(
  uri: vscode.Uri,
  marker: string,
): Promise<vscode.Diagnostic[]> {
  const diagnostics = await pollUntilResult(
    async () => vscode.languages.getDiagnostics(uri),
    (items) =>
      items.some((diagnostic) => diagnostic.message.includes(marker)) &&
      !items.some((diagnostic) => diagnosticCode(diagnostic) === 'CS1029'),
    DOTNET_CLI_MS,
  );
  const warning = assertSingleMarker(diagnostics, marker);
  assert.strictEqual(warning.severity, vscode.DiagnosticSeverity.Warning);
  assert.strictEqual(warning.source, 'sharplsp-csharp');
  assert.ok(!errorsFor(uri).some((diagnostic) => diagnosticCode(diagnostic) === 'CS1029'));
  return diagnostics;
}

function assertSingleMarker(
  diagnostics: readonly vscode.Diagnostic[],
  marker: string,
): vscode.Diagnostic {
  const matches = diagnostics.filter((diagnostic) => diagnostic.message.includes(marker));
  assert.strictEqual(matches.length, 1, `expected one diagnostic marker ${marker}`);
  const match = matches[0];
  assert.ok(match, `diagnostic marker ${marker} must be present`);
  assert.strictEqual(diagnosticCode(match), 'CS1030');
  return match;
}

suite('VSIX E2E — file-based app MSBuild configuration', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    ({ tmpDir } = await setupLspTestSuite('filebased-package-config-'));
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    await loadSolutionInServer(fixtureSolutionPath());
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // Implements [SCRIPT-FILEBASED-DIRECTIVES] and
  // [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
  test('a bare package version is supplied by Directory.Packages.props', async function () {
    this.timeout(DOTNET_CLI_MS);
    const centralPackages = `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
`;
    const propsPath = writeFixture(tmpDir, 'Directory.Packages.props', centralPackages);
    const source = `#:package Newtonsoft.Json
using Newtonsoft.Json.Linq;
var payload = new JObject();
Console.WriteLine(payload.Count);
`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'CentralPackageApp.cs', source);

    assert.strictEqual(doc.lineAt(0).text, '#:package Newtonsoft.Json');
    assert.strictEqual(fs.existsSync(propsPath), true, 'central package file remains present');
    assert.strictEqual(fs.readFileSync(propsPath, 'utf8'), centralPackages);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'CentralPackageApp.csproj')), false);
    const hover = hoverText(
      await waitForHoverText(uri, positionInside(source, 'JObject'), 'Newtonsoft.Json.Linq'),
    );
    assert.ok(hover.includes('JObject'), 'CPM-backed package type binds');
    assert.ok(hover.includes('Newtonsoft.Json.Linq'), 'CPM preserves the package namespace');
    const members = await completionList(uri, positionAfter(source, 'payload.'), 'Properties');
    assert.strictEqual(itemNamed(members, 'Properties').kind, vscode.CompletionItemKind.Method);
    assertNoPackageBindingErrors(uri);
  });

  // Implements the app-directory configuration cone in
  // [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
  test('Directory.Build.props compiler properties affect live semantics', async function () {
    this.timeout(DOTNET_CLI_MS);
    const buildProps = `<Project>
  <PropertyGroup>
    <DefineConstants>$(DefineConstants);FROM_APP_CONE</DefineConstants>
  </PropertyGroup>
</Project>
`;
    const propsPath = writeFixture(tmpDir, 'Directory.Build.props', buildProps);
    const marker = 'sharplsp-app-cone-options-applied';
    const source = `${PACKAGE}
#warning ${marker}
#if !FROM_APP_CONE
#error Directory.Build.props was ignored
#endif
using Newtonsoft.Json.Linq;
var payload = new JObject();
Console.WriteLine(payload.Count);
`;
    const { uri } = await openFileBasedApp(tmpDir, 'BuildPropsApp.cs', source);
    const members = await completionList(uri, positionAfter(source, 'payload.'), 'Properties');
    const diagnostics = await waitForMarkerWithoutError(uri, marker);

    assert.strictEqual(fs.readFileSync(propsPath, 'utf8'), buildProps);
    assert.strictEqual(itemNamed(members, 'Properties').kind, vscode.CompletionItemKind.Method);
    assert.ok(
      !diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === 'CS1029'),
      'the app-cone constant must suppress the #error branch',
    );
    assertNoPackageBindingErrors(uri);
  });

  // Implements #:property evaluation in [SCRIPT-FILEBASED-DIRECTIVES] and
  // [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
  test('#:property compiler options flow into the Roslyn project', async function () {
    this.timeout(DOTNET_CLI_MS);
    const marker = 'sharplsp-file-directive-options-applied';
    const source = `#:property DefineConstants=FROM_FILE_DIRECTIVE
#warning ${marker}
#if !FROM_FILE_DIRECTIVE
#error file directive property was ignored
#endif
var text = string.Empty;
Console.WriteLine(text.Length);
`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'PropertyDirectiveApp.cs', source);
    const members = await completionList(uri, positionAfter(source, 'text.'), 'Length');
    const diagnostics = await waitForMarkerWithoutError(uri, marker);

    assert.strictEqual(doc.lineAt(0).text, '#:property DefineConstants=FROM_FILE_DIRECTIVE');
    assert.strictEqual(itemNamed(members, 'Length').kind, vscode.CompletionItemKind.Property);
    assert.ok(
      !diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === 'CS1029'),
      '#:property must suppress the #error branch',
    );
    assert.deepStrictEqual(errorsFor(uri), [], 'directive-derived compilation has zero errors');
  });

  // Implements live directive re-evaluation in [SCRIPT-RELOAD].
  test('unsaved #:property add, remove and re-add updates compiler options', async function () {
    this.timeout(DOTNET_CLI_MS);
    const body = `#if !LIVE_DIRECTIVE
#error live property is absent
#endif
var text = string.Empty;
Console.WriteLine(text.Length);
`;
    const withProperty = `#:property DefineConstants=LIVE_DIRECTIVE\n${body}`;
    const { doc, uri } = await openFileBasedApp(tmpDir, 'LivePropertyDirective.cs', body);
    const initialVersion = doc.version;
    const initiallyMissing = await waitForErrorCode(uri, 'CS1029');
    assert.strictEqual(
      initiallyMissing.filter((diagnostic) => diagnosticCode(diagnostic) === 'CS1029').length,
      1,
      'the baseline contains exactly one active #error',
    );

    assert.strictEqual(await replaceDocumentContent(doc, withProperty), true);
    assert.ok(doc.isDirty, 'the directive change is delivered through didChange, not disk reload');
    assert.ok(doc.version > initialVersion, 'adding the property advances document version');
    assert.strictEqual(doc.lineAt(0).text, '#:property DefineConstants=LIVE_DIRECTIVE');
    const afterAdd = await pollUntilResult(
      async () => errorsFor(uri),
      (errors) => !errors.some((diagnostic) => diagnosticCode(diagnostic) === 'CS1029'),
      DOTNET_CLI_MS,
    );
    assert.deepStrictEqual(afterAdd, [], 'adding the property disables the #error branch');

    const versionWithProperty = doc.version;
    assert.strictEqual(await replaceDocumentContent(doc, body), true);
    assert.ok(doc.version > versionWithProperty, 'removal is a separate didChange generation');
    assert.strictEqual(doc.getText().startsWith('#:property'), false);
    const removed = await waitForErrorCode(uri, 'CS1029');
    assert.strictEqual(
      removed.filter((diagnostic) => diagnosticCode(diagnostic) === 'CS1029').length,
      1,
      'removing the property reactivates exactly one #error',
    );

    assert.strictEqual(await replaceDocumentContent(doc, withProperty), true);
    const members = await completionList(uri, positionAfter(withProperty, 'text.'), 'Length');
    assert.strictEqual(itemNamed(members, 'Length').kind, vscode.CompletionItemKind.Property);
    const afterReAdd = await pollUntilResult(
      async () => errorsFor(uri),
      (errors) => !errors.some((diagnostic) => diagnosticCode(diagnostic) === 'CS1029'),
      DOTNET_CLI_MS,
    );
    assert.deepStrictEqual(afterReAdd, [], 're-adding the property restores clean semantics');
  });
});
