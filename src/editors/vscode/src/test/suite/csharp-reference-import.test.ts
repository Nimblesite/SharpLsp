// A C# type that another project of the solution declares, which the file's
// project does not reference yet ([REFACTOR-IMPORT-REFERENCE]). Roslyn's own
// AddImport never looks outside a project's references in a headless
// workspace, so before this fix Ctrl-. offered only "Generate class".
//
// The quick fix states both edits in its title, resolves to the `using`, and
// carries the command that adds the `<ProjectReference>`: VS Code applies the
// edit, then runs the command, exactly as these tests do. Once the server
// reloads the changed project the error is gone. A reference that cannot be
// added is reported once, naming the cause, the import that was kept and the
// log ([REFACTOR-NEVER-SILENT]). Each test writes a real two-project solution
// inside the workspace and loads it through the Solution Explorer.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { diagnosticCode } from './document-anchors';
import { explorer } from './fsharp-project-tree-kit';
import { useLspTestSuite } from './lsp-suite-kit';
import { fixtureSolutionPath, loadSolutionInServer } from './real-repo-helpers';
import {
  closeAllEditors,
  pollUntilResult,
  removeDirRecursive,
  requireWorkspaceRoot,
} from './test-helpers';
import { LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

const COMMAND = 'sharplsp.addReferenceAndImport';
const TITLE =
  "Reference project Lib from App.csproj and add 'using Shapes.Geometry;' — Lib declares Shapes.Geometry.Polygon";
const PROBE =
  'namespace App;\n\npublic class Probe\n{\n    public object Shape() => new Polygon();\n}\n';
const PROJECT =
  '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';

/** One written solution: `App` references nothing, `Lib` declares the type. */
interface Layout {
  readonly root: string;
  readonly app: string;
  readonly lib: string;
  readonly probe: vscode.Uri;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeSolution(parent: string): Layout {
  const root = path.join(parent, `Refs${Math.random().toString(36).slice(2, 8)}`);
  const app = path.join(root, 'App', 'App.csproj');
  const lib = path.join(root, 'Lib', 'Lib.csproj');
  write(app, PROJECT);
  write(lib, PROJECT);
  write(
    path.join(root, 'Lib', 'Polygon.cs'),
    'namespace Shapes.Geometry;\n\npublic class Polygon { }\n',
  );
  write(path.join(root, 'App', 'Probe.cs'), PROBE);
  const projects = ['App/App.csproj', 'Lib/Lib.csproj'].map((p) => `  <Project Path="${p}" />`);
  write(path.join(root, 'refs.slnx'), ['<Solution>', ...projects, '</Solution>', ''].join('\n'));
  return { root, app, lib, probe: vscode.Uri.file(path.join(root, 'App', 'Probe.cs')) };
}

/** The CS0246 errors that name `Polygon` in the probe. */
function polygonErrors(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((item) => diagnosticCode(item) === 'CS0246' && item.message.includes('Polygon'));
}

/** The quick fixes at `Polygon`, resolved, once the reference row is among them. */
async function referenceFixes(document: vscode.TextDocument): Promise<vscode.CodeAction[]> {
  const start = document.getText().indexOf('Polygon()');
  const caret = document.positionAt(start);
  return await pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        document.uri,
        new vscode.Range(caret, caret),
        vscode.CodeActionKind.QuickFix.value,
        50,
      )) ?? [],
    (actions) => actions.some((action) => action.title === TITLE),
    SIDECAR_COLD_MS,
    1_000,
  );
}

suite(
  'C# real LSP — a quick fix references the project that declares the type [REFACTOR-IMPORT-REFERENCE]',
  () => {
    useLspTestSuite('reference-import-');
    let stubs: UiStubs;
    let created: string[];

    setup(() => {
      stubs = installUiStubs();
      created = [];
    });

    // The default fixture solution goes back FIRST, so the suites after this one
    // find the server where they left it.
    teardown(async function () {
      this.timeout(SIDECAR_COLD_MS);
      stubs.restore();
      await closeAllEditors();
      await loadSolutionInServer(fixtureSolutionPath());
      explorer().clear();
      for (const dir of created) removeDirRecursive(dir);
    });

    /** Write the solution and select it in the server and in the tree, as the picker does. */
    async function loadSolution(): Promise<Layout> {
      const layout = writeSolution(requireWorkspaceRoot());
      created.push(layout.root);
      const solution = path.join(layout.root, 'refs.slnx');
      await loadSolutionInServer(solution);
      await explorer().loadSolution(solution);
      return layout;
    }

    test('Ctrl-. offers the reference, applying it adds the using and the reference, and CS0246 clears', async function () {
      this.timeout(SIDECAR_COLD_MS * 2 + LSP_RESPONSE_MS);
      const layout = await loadSolution();
      const document = await vscode.workspace.openTextDocument(layout.probe);
      await vscode.window.showTextDocument(document);

      // Interaction 1 — the type is unresolved: App does not reference Lib.
      const errors = await pollUntilResult(
        async () => polygonErrors(layout.probe),
        (found) => found.length > 0,
        SIDECAR_COLD_MS,
      );
      assert.strictEqual(errors.length, 1, 'exactly one CS0246 names Polygon');
      assert.strictEqual(
        errors[0]?.severity,
        vscode.DiagnosticSeverity.Error,
        'and it is an error',
      );

      // Interaction 2 — the lightbulb names both edits, as an edit AND a command.
      const fixes = await referenceFixes(document);
      const fix = fixes.find((action) => action.title === TITLE);
      assert.ok(fix, `the reference row is offered: ${fixes.map((a) => a.title).join(' | ')}`);
      assert.strictEqual(fix.kind?.value, 'quickfix', 'as a quick fix');
      assert.strictEqual(fix.command?.command, COMMAND, 'carrying the reference command');
      const argument = fix.command.arguments?.[0] as { title: string; reference: unknown };
      assert.strictEqual(argument.title, TITLE, 'whose argument names the fix');
      assert.deepStrictEqual(
        argument.reference,
        { kind: 'project', projectPath: layout.app, reference: layout.lib, version: '' },
        'and the exact reference: App gains Lib',
      );
      assert.ok(fix.edit, 'it resolves to its import edit');

      // Interaction 3 — apply it as VS Code does: the edit, then the command.
      assert.ok(await vscode.workspace.applyEdit(fix.edit), 'the import edit applies');
      await vscode.commands.executeCommand(COMMAND, ...(fix.command.arguments ?? []));
      assert.strictEqual(
        document.getText(),
        `using Shapes.Geometry;\n\n${PROBE}`,
        'the using lands above the file-scoped namespace, a blank line after it',
      );
      const include = path.relative(path.dirname(layout.app), layout.lib);
      const project = fs.readFileSync(layout.app, 'utf-8');
      assert.ok(project.includes(`<ProjectReference Include="${include}" />`), project);
      assert.deepStrictEqual(stubs.log.errorMessages, [], 'nothing failed');
      assert.deepStrictEqual(
        stubs.log.infoMessages,
        [`SharpLsp: Added a reference to ${include}.`],
        'and the user is told exactly what changed',
      );

      // Interaction 4 — the server reloads the changed project; the error goes.
      const cleared = await pollUntilResult(
        async () => polygonErrors(layout.probe),
        (found) => found.length === 0,
        SIDECAR_COLD_MS,
        1_000,
      );
      assert.deepStrictEqual(cleared, [], 'Polygon resolves once App references Lib');
    });

    test('a reference that cannot be added is reported once, naming the cause, the kept import and the log', async function () {
      this.timeout(SIDECAR_COLD_MS + LSP_RESPONSE_MS);
      const layout = await loadSolution();
      const gone = path.join(path.dirname(layout.lib), 'Gone.csproj');
      const before = fs.readFileSync(layout.app, 'utf-8');

      await vscode.commands.executeCommand(COMMAND, {
        title: TITLE,
        reference: { kind: 'project', projectPath: layout.app, reference: gone, version: '' },
      });

      assert.strictEqual(stubs.log.errorMessages.length, 1, 'exactly one message');
      const message = stubs.log.errorMessages[0] ?? '';
      assert.ok(message.startsWith(`SharpLsp could not apply "${TITLE}": `), message);
      assert.ok(message.includes(gone), `it names the missing project: ${message}`);
      assert.ok(message.includes('does not exist'), `and why: ${message}`);
      assert.ok(
        message.includes('the import is already in place, and Undo removes it'),
        `and that the import was kept: ${message}`,
      );
      assert.ok(message.endsWith('The details are in Output › SharpLsp.'), message);
      assert.deepStrictEqual(stubs.log.errorActions[0], ['Show Log'], 'with the way to the log');
      assert.deepStrictEqual(stubs.log.infoMessages, [], 'and no false success');
      assert.strictEqual(fs.readFileSync(layout.app, 'utf-8'), before, 'the project is untouched');
    });
  },
);
