// The build task's problem matcher ([PKG-VULN-SEVERITY]): `$msCompile` without
// the vulnerability codes NU1901–NU1904. SharpLsp reports those itself, on the
// element that declares the package, so the build output must not put the same
// advisory in the Problems panel a second time, pinned to line 1.
//
// The test runs a REAL task through VS Code's own problem-matcher engine and
// reads the Problems panel back, so the regular expression in package.json is
// proven by the editor, not by a second copy of it here.
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BUILD_PROBLEM_MATCHER, SharpLspBuildTaskProvider } from '../../build';
import { pollUntilResult } from './test-helpers';
import { COMMAND_MS } from './test-timeouts';

/** The code of a diagnostic, whichever shape VS Code gives it. */
function codeOf(diagnostic: vscode.Diagnostic): string {
  const { code } = diagnostic;
  return typeof code === 'object' ? String(code.value) : String(code ?? '');
}

/**
 * Every diagnostic in the Problems panel under `dir`, as `[file, code]` pairs. VS Code
 * lowercases a Windows drive letter in `fsPath`, so the two are compared as it spells them.
 */
function problemsUnder(dir: string): [string, vscode.Diagnostic][] {
  const root = vscode.Uri.file(dir).fsPath.toLowerCase();
  return vscode.languages
    .getDiagnostics()
    .filter(([uri]) => uri.fsPath.toLowerCase().startsWith(root))
    .flatMap(([uri, diagnostics]) =>
      diagnostics.map((diagnostic): [string, vscode.Diagnostic] => [
        path.basename(uri.fsPath),
        diagnostic,
      ]),
    );
}

/** Run a task that prints `lines`, as a `dotnet build` would, to the matcher. */
async function printThroughMatcher(lines: readonly string[]): Promise<void> {
  const script = lines.map((line) => `console.log(${JSON.stringify(line)})`).join(';');
  const task = new vscode.Task(
    { type: SharpLspBuildTaskProvider.Type, command: 'build' },
    vscode.TaskScope.Workspace,
    'matcher-probe',
    SharpLspBuildTaskProvider.Source,
    new vscode.ProcessExecution('node', ['-e', script]),
    BUILD_PROBLEM_MATCHER,
  );
  const ended = new Promise<void>((resolve) => {
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.name !== 'matcher-probe') return;
      subscription.dispose();
      resolve();
    });
  });
  await vscode.tasks.executeTask(task);
  await ended;
}

suite('Build problem matcher — SharpLsp-owned vulnerability codes', () => {
  test('compiler and NuGet problems reach the panel; NU1901–NU1904 never do', async function () {
    this.timeout(COMMAND_MS * 4);
    const dir = path.join(os.tmpdir(), `sharplsp-matcher-${String(Date.now())}`);
    const project = path.join(dir, 'App.fsproj');
    const source = path.join(dir, 'Program.fs');
    const advisory = (code: string, level: string): string =>
      `${project} : warning ${code}: Package 'Old' 1.0.0 has a known ${level} severity vulnerability, https://github.com/advisories/GHSA-0000 [${project}]`;

    await printThroughMatcher([
      `${source}(3,9): warning FS1182: The value 'unused' is unused [${project}]`,
      advisory('NU1901', 'low'),
      advisory('NU1902', 'moderate'),
      advisory('NU1903', 'high'),
      advisory('NU1904', 'critical'),
      `${project} : error NU1101: Unable to find package Nope. [${project}]`,
      `  2>${source}(7,1,7,5): error FS0039: The value 'nope' is not defined [${project}]`,
    ]);

    // Interaction 1 — the three problems SharpLsp does not own are in the panel.
    const problems = await pollUntilResult(
      async () => problemsUnder(dir),
      (found) => found.length >= 3,
      COMMAND_MS * 2,
      100,
    );
    const seen = problems.map(([file, diagnostic]) => [file, codeOf(diagnostic)]).sort();
    assert.deepStrictEqual(seen, [
      ['App.fsproj', 'NU1101'],
      ['Program.fs', 'FS0039'],
      ['Program.fs', 'FS1182'],
    ]);

    // Interaction 2 — each keeps what `$msCompile` reads: severity, place, text.
    const byCode = new Map(problems.map(([, diagnostic]) => [codeOf(diagnostic), diagnostic]));
    const unused = byCode.get('FS1182');
    assert.strictEqual(unused?.severity, vscode.DiagnosticSeverity.Warning);
    assert.deepStrictEqual(
      [unused.range.start.line, unused.range.start.character],
      [2, 8],
      'line 3, column 9, zero-based',
    );
    assert.ok(unused.message.startsWith("The value 'unused' is unused"), unused.message);
    const undefinedName = byCode.get('FS0039');
    assert.strictEqual(undefinedName?.severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(undefinedName.range.start.line, 6, 'the `2>` build-node prefix is skipped');
    const missing = byCode.get('NU1101');
    assert.strictEqual(missing?.severity, vscode.DiagnosticSeverity.Error);
    assert.ok(missing.message.startsWith('Unable to find package Nope.'), missing.message);

    // Interaction 3 — no advisory code leaked through under any severity.
    const owned = problems.filter(([, diagnostic]) => /^NU190[1-4]$/.test(codeOf(diagnostic)));
    assert.deepStrictEqual(owned, [], 'SharpLsp reports these on the declaring element');
    assert.ok(
      problems.every(([, diagnostic]) => !diagnostic.message.includes('vulnerability')),
      'and no advisory text reached the panel under another code',
    );
  });
});
