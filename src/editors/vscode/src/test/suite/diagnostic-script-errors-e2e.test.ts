// Actual script references remain source diagnostics. [DIAG-TRUTH-GUARANTEES] [SCRIPT-FSX-DIAGNOSTICS]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { DocumentDiagnosticReport } from 'vscode-languageclient/node';
import { joinPath } from '../../paths';
import type { SharpLspExtensionApi } from '../../extension';
import {
  assertNoCompilerErrors as assertSourceHasNoErrors,
  firstDiagnosticReport,
} from './diagnostic-accuracy-fixtures';
import { diagnosticCode } from './document-anchors';
import { hoverText } from './fsharp-helpers';
import { dotnet } from './dotnet-project-kit';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import {
  buildProject,
  isolateFromRepoMsbuild,
  writeCSharpLibrary,
  writeFsxScript,
} from './run-debug-fixtures';
import { activateWithScratch, teardownFixtureSolution } from './test-explorer-kit';
import {
  EXTENSION_ID,
  closeAllEditors,
  pollUntilResult,
  pollProvider,
  removeDirRecursive,
} from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

const BROKEN = '#r "DefinitelyMissingScriptDiagnosticReference.dll"\nlet value = 42\n';
const FSI_SOURCE = 'let count = fsi.CommandLineArgs.Length\n';
const RELATIVE_SOURCE =
  '#r "ReferenceLibrary/bin/Debug/net10.0/ScriptReference.dll"\nlet count = ScriptReference.Calc.Add(20,22)\n';

suite('Diagnostic accuracy — F# script reference ownership', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let script: vscode.Uri;
  let clean: string;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    ({ api, root } = await activateWithScratch('slsp-script-reference-'));
    isolateFromRepoMsbuild(root);
    script = vscode.Uri.file(writeFsxScript(root, 'ReferenceGuard'));
    clean = fs.readFileSync(script.fsPath, 'utf8');
    await loadSolutionInServer(script.fsPath);
  });
  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await closeAllEditors();
    await loadSolutionInServer(fixtureSolutionPath());
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });
  test('missing script references appear, clear and return on their actual source', async function () {
    this.timeout(FIXTURE_BUILD_MS + 5 * LSP_RESPONSE_MS);
    for (const broken of [false, true, false, true]) {
      await assertStep(broken);
    }
  });

  test('selected scripts retain missing reference diagnostics after explicit workspace reloads', async function () {
    this.timeout(FIXTURE_BUILD_MS + 5 * LSP_RESPONSE_MS);
    for (const broken of [false, true, false, true]) {
      await assertStep(broken, true);
    }
  });

  test('published F# payload supports fsi settings and real relative assembly references', async function () {
    this.timeout(FIXTURE_BUILD_MS + 5 * LSP_RESPONSE_MS);
    assertPackagedSettings();
    const library = writeCSharpLibrary(joinPath(root, 'ReferenceLibrary'), 'ScriptReference');
    await buildProject(library);
    for (const [source, line] of [
      [FSI_SOURCE, 0],
      [RELATIVE_SOURCE, 1],
    ] as const) {
      await assertValidScript(source, line);
    }
  });

  function assertPackagedSettings(): void {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'the actual development extension is loaded');
    const settings = joinPath(
      extension.extensionPath,
      'bin',
      'all',
      'FSharp.Compiler.Interactive.Settings.dll',
    );
    assert.ok(
      fs.existsSync(settings),
      'the published F# payload must include the real compiler interactive settings assembly',
    );
    assert.ok(fs.statSync(settings).isFile());
    assert.ok(fs.statSync(settings).size > 0);
  }

  async function assertValidScript(source: string, line: number): Promise<void> {
    await closeAllEditors();
    fs.writeFileSync(script.fsPath, source);
    await dotnet(['fsi', '--exec', '--typecheck-only', script.fsPath], root);
    await loadSolutionInServer(script.fsPath);
    const document = await vscode.workspace.openTextDocument(script);
    await vscode.window.showTextDocument(document);
    await assertCurrentEditorText(document, source);
    const hover = await pollProvider<vscode.Hover>(
      'vscode.executeHoverProvider',
      [script, new vscode.Position(line, 6)],
      scriptHoverMatches,
      SIDECAR_COLD_MS,
    );
    assertIntegerBinding(hover);
    const report = await firstScriptReport(false);
    await assertNoCompilerErrors(report);
  }

  function scriptHoverMatches(items: vscode.Hover[]): boolean {
    const text = hoverText(items);
    return text.includes('count') && text.includes('int');
  }

  function assertIntegerBinding(hover: vscode.Hover[]): void {
    assert.ok(hover.length > 0, 'the real F# compiler resolves the current script binding');
    const text = hoverText(hover);
    assert.ok(text.includes('count'));
    assert.ok(
      text.includes('int'),
      'the compiler binds fsi or the SDK-built library to a real integer',
    );
  }

  async function assertNoCompilerErrors(report: DocumentDiagnosticReport): Promise<void> {
    assert.equal(report.kind, 'full');
    assert.ok(report.resultId);
    if (report.kind !== 'full') assert.fail('valid script returns full compiler truth');
    assert.deepEqual(
      report.items.filter((item) => item.severity === 1),
      [],
    );
    await assertSourceHasNoErrors(script);
  }

  async function assertStep(broken: boolean, reload = false): Promise<void> {
    await closeAllEditors();
    fs.writeFileSync(script.fsPath, broken ? BROKEN : clean);
    const compile = dotnet(['fsi', '--exec', script.fsPath], root);
    if (broken) await assert.rejects(compile, /FS0078/, 'the actual SDK rejects the missing #r');
    else await compile;
    if (reload) await loadSolutionInServer(script.fsPath);
    const document = await vscode.workspace.openTextDocument(script);
    await vscode.window.showTextDocument(document);
    await assertCurrentEditorText(document, broken ? BROKEN : clean);
    const report = await firstScriptReport(broken);
    assertMissingReference(report, broken);
    await assertScriptProblems(broken);
  }

  async function assertCurrentEditorText(
    document: vscode.TextDocument,
    source: string,
  ): Promise<void> {
    await pollUntilResult(
      async () => document.getText() === source,
      (current) => current,
      LSP_RESPONSE_MS,
      100,
      'the real editor has observed the completed disk edit',
    );
    assert.ok(document.getText() === source);
    assert.equal(document.isDirty, false);
  }

  async function firstScriptReport(broken: boolean): Promise<DocumentDiagnosticReport> {
    const client = api.getLspClient();
    assert.ok(client);
    const report = await firstDiagnosticReport<DocumentDiagnosticReport>(
      client,
      'textDocument/diagnostic',
      { textDocument: { uri: script.toString() } },
      LSP_RESPONSE_MS,
      `the first successful script report (missing reference: ${String(broken)})`,
    );
    assert.ok(report);
    return report;
  }

  function assertMissingReference(report: DocumentDiagnosticReport, broken: boolean): void {
    assert.equal(report.kind, 'full');
    assert.ok(report.resultId);
    if (report.kind !== 'full') assert.fail('script pulls return full compiler truth');
    const errors = report.items.filter((item) => item.severity === 1);
    assert.equal(
      errors.length,
      broken ? 1 : 0,
      'real script startup errors must never disappear behind project ownership',
    );
    for (const error of errors) {
      assertReferenceError(error);
    }
  }

  function assertReferenceError(error: import('vscode-languageclient/node').Diagnostic): void {
    assert.equal(error.code, 'FS0078');
    assert.equal(error.source, 'sharplsp-fsharp');
    assert.equal(error.range.start.line, 0);
    assert.equal(error.range.start.character, 0);
    assert.equal(error.range.end.line, 0);
    assert.equal(typeof error.message, 'string');
    assert.ok(typeof error.message === 'string' && error.message.length > 0);
  }

  async function assertScriptProblems(broken: boolean): Promise<void> {
    const problems = await pollUntilResult(
      async () =>
        vscode.languages.getDiagnostics(script).filter((item) => diagnosticCode(item) === 'FS0078'),
      (found) => found.length === (broken ? 1 : 0),
      LSP_RESPONSE_MS,
    );
    assert.equal(problems.length, broken ? 1 : 0);
    for (const problem of problems) {
      assertReferenceProblem(problem);
    }
  }

  function assertReferenceProblem(problem: vscode.Diagnostic): void {
    assert.equal(problem.source, 'sharplsp-fsharp');
    assert.equal(problem.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(problem.range.start.line, 0);
  }
});
