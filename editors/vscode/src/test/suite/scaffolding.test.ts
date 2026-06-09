import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from './test-helpers';
import {
  newSolutionArgs,
  newProjectArgs,
  createSolution,
  createProject,
  addProjectToSolutionFile,
  findProjectFile,
} from '../../scaffolding';

interface PackageJson {
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
}

function extensionRoot(): string {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'Extension should be resolvable');
  return ext.extensionPath;
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(extensionRoot(), 'package.json'), 'utf-8'));
}

function readNls(file: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(extensionRoot(), file), 'utf-8'));
}

suite('Scaffolding (Create Solution / Project)', () => {
  // ── Command Registration ─────────────────────────────────────

  for (const cmd of [
    'sharplsp.newSolution',
    'sharplsp.newProject',
    'sharplsp.newFile',
    'sharplsp.addProjectToSolution',
  ]) {
    test(`${cmd} command is registered`, async () => {
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(cmds.includes(cmd), `${cmd} must be a registered VS Code command`);
    });
  }

  // ── Package Contributions ────────────────────────────────────

  test('package.json contributes the newSolution command with a title and icon', () => {
    const pkg = readPackageJson();
    const entry = pkg.contributes.commands.find((c) => c.command === 'sharplsp.newSolution');
    assert.ok(entry, 'sharplsp.newSolution must be a contributed command');
    assert.strictEqual(entry.title, '%cmd.newSolution%');
    assert.ok(entry.icon, 'newSolution should have a toolbar icon');
  });

  test('newSolution and newProject are pinned to the Solution Explorer toolbar', () => {
    const pkg = readPackageJson();
    const viewTitle = pkg.contributes.menus['view/title'] ?? [];
    for (const command of ['sharplsp.newSolution', 'sharplsp.newProject']) {
      const entry = viewTitle.find(
        (m) => m.command === command && m.when === 'view == sharplsp.solutionExplorer',
      );
      assert.ok(entry, `${command} must appear in the solution explorer view/title menu`);
      assert.ok(
        entry.group?.startsWith('navigation'),
        `${command} toolbar button must live in the navigation group`,
      );
    }
  });

  // ── Welcome View Buttons (the empty-workspace dead-end fix) ───

  for (const nlsFile of ['package.nls.json', 'package.nls.ja.json', 'package.nls.zh-cn.json']) {
    test(`${nlsFile} welcome view links New Solution and New Project commands`, () => {
      const nls = readNls(nlsFile);
      const welcome = nls['viewWelcome.solutionExplorer.contents'];
      assert.ok(welcome, `${nlsFile} must define the welcome view contents`);
      assert.ok(
        welcome.includes('command:sharplsp.newSolution'),
        `${nlsFile} welcome view must offer a New Solution button`,
      );
      assert.ok(
        welcome.includes('command:sharplsp.newProject'),
        `${nlsFile} welcome view must offer a New Project button`,
      );
    });
  }

  // ── dotnet CLI argument builders ─────────────────────────────

  test('newSolutionArgs builds a `dotnet new sln` invocation', () => {
    assert.deepStrictEqual(newSolutionArgs('MySln', '/tmp/work'), [
      'new',
      'sln',
      '--name',
      'MySln',
      '--output',
      '/tmp/work',
    ]);
  });

  test('newProjectArgs omits --language for C# and includes it for F#', () => {
    const csharp = newProjectArgs('console', 'App', '/tmp/work');
    assert.ok(!csharp.includes('--language'), 'C# project must not pass --language');
    assert.deepStrictEqual(csharp, [
      'new',
      'console',
      '--name',
      'App',
      '--output',
      path.join('/tmp/work', 'App'),
    ]);

    const fsharp = newProjectArgs('console', 'App', '/tmp/work', 'F#');
    assert.deepStrictEqual(fsharp.slice(-2), ['--language', 'F#']);
  });

  // ── Real .NET CLI end-to-end ─────────────────────────────────

  test('creates a real solution, C# + F# projects, and wires them into the .sln', async function () {
    this.timeout(180_000); // first `dotnet new` may restore templates.

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-scaffold-'));
    try {
      // 1. Create the solution via the .NET CLI. The SDK picks the format
      //    (.NET 9+ → .slnx, older → .sln); createSolution returns whichever.
      const slnPath = await createSolution(work, 'Demo');
      assert.ok(fs.existsSync(slnPath), 'solution file should exist on disk');
      assert.match(
        path.basename(slnPath),
        /^Demo\.slnx?$/,
        'solution should be Demo.sln or Demo.slnx',
      );

      // 2. Create a C# console project. F# is first-class, so create one too.
      const csDir = await createProject(work, 'Api', 'console');
      const csProj = findProjectFile(csDir, 'Api');
      assert.ok(csProj?.endsWith('Api.csproj'), 'C# project file should be found');

      const fsDir = await createProject(work, 'Core', 'classlib', 'F#');
      const fsProj = findProjectFile(fsDir, 'Core');
      assert.ok(fsProj?.endsWith('Core.fsproj'), 'F# project file should be found');

      // 3. Add both to the solution via the .NET CLI.
      assert.ok(csProj && fsProj);
      await addProjectToSolutionFile(slnPath, csProj);
      await addProjectToSolutionFile(slnPath, fsProj);

      // 4. The solution must now reference both projects.
      const slnText = fs.readFileSync(slnPath, 'utf-8');
      assert.ok(slnText.includes('Api.csproj'), 'solution must reference the C# project');
      assert.ok(slnText.includes('Core.fsproj'), 'solution must reference the F# project');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test('findProjectFile returns undefined when no project exists', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-empty-'));
    try {
      assert.strictEqual(findProjectFile(empty, 'Nope'), undefined);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
