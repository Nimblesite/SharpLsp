import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { info } from './log';
import { findSolutions } from './solution.js';
import * as state from './state.js';

const PROJECT_TEMPLATES = [
  { label: 'Console App', template: 'console' },
  { label: 'Class Library', template: 'classlib' },
  { label: 'Web API', template: 'webapi' },
  { label: 'Blazor Server', template: 'blazorserver' },
  { label: 'Worker Service', template: 'worker' },
  { label: 'xUnit Test', template: 'xunit' },
  { label: 'NUnit Test', template: 'nunit' },
  { label: 'MSTest', template: 'mstest' },
  { label: 'F# Console', template: 'console', lang: 'F#' },
  { label: 'F# Class Library', template: 'classlib', lang: 'F#' },
];

const FILE_TEMPLATES = [
  { label: 'Class', snippet: 'class' },
  { label: 'Interface', snippet: 'interface' },
  { label: 'Enum', snippet: 'enum' },
  { label: 'Struct', snippet: 'struct' },
  { label: 'Record', snippet: 'record' },
];

/** Create a new .NET project via `dotnet new`. */
async function newProject(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    PROJECT_TEMPLATES.map((t) => ({
      label: t.label,
      description: t.lang ?? 'C#',
      template: t.template,
      lang: t.lang,
    })),
    { placeHolder: 'Select project template' },
  );
  if (pick === undefined) {
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Project name',
    placeHolder: 'MyProject',
  });
  if (name === undefined || name === '') {
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  const args = ['new', pick.template, '--name', name, '--output', path.join(folder, name)];
  if (pick.lang !== undefined) {
    args.push('--language', pick.lang);
  }

  try {
    await runDotnet(args, folder);
    void vscode.window.showInformationMessage(`Created ${name}`);
    info(`Created project ${name} from template ${pick.template}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed: ${message}`);
  }
}

/** Create a new C# file from a template. */
async function newFile(): Promise<void> {
  const pick = await vscode.window.showQuickPick(FILE_TEMPLATES, {
    placeHolder: 'Select file type',
  });
  if (pick === undefined) {
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: `${pick.label} name`,
    placeHolder: `My${pick.label}`,
  });
  if (name === undefined || name === '') {
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined) {
    return;
  }

  const content = generateFileContent(pick.snippet, name);
  const filePath = path.join(folder, `${name}.cs`);
  const uri = vscode.Uri.file(filePath);

  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri, { ignoreIfExists: true });
  edit.insert(uri, new vscode.Position(0, 0), content);
  await vscode.workspace.applyEdit(edit);

  // Auto-add file to the nearest .csproj if it uses explicit <Compile> includes.
  await autoAddFileToProject(filePath);

  await vscode.window.showTextDocument(uri);
}

/** Try to add a file to the nearest project if it uses explicit Compile includes. */
async function autoAddFileToProject(filePath: string): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(dir, '*.csproj'));
    if (files.length === 0) {
      return;
    }

    const projPath = files[0]?.fsPath;
    if (projPath === undefined) {
      return;
    }

    const projContent = fs.readFileSync(projPath, 'utf-8');
    // Only add if project uses explicit Compile includes (not glob patterns).
    if (!projContent.includes('<Compile Include=')) {
      return;
    }

    const fileName = path.basename(filePath);
    if (projContent.includes(`Include="${fileName}"`)) {
      return;
    }

    // Insert before </ItemGroup> that contains Compile elements.
    const compileGroupEnd = projContent.lastIndexOf('</ItemGroup>');
    if (compileGroupEnd < 0) {
      return;
    }

    const newContent =
      projContent.slice(0, compileGroupEnd) +
      `    <Compile Include="${fileName}" />\n  ` +
      projContent.slice(compileGroupEnd);
    fs.writeFileSync(projPath, newContent, 'utf-8');
    info(`Auto-added ${fileName} to ${path.basename(projPath)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    info(`Auto-add to project skipped: ${message}`);
  }
}

/** Add an existing project to the solution. */
async function addProjectToSolution(): Promise<void> {
  const projectFiles = await vscode.workspace.findFiles(
    '**/*.{csproj,fsproj}',
    '**/node_modules/**',
  );
  if (projectFiles.length === 0) {
    void vscode.window.showWarningMessage('No project files found.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    projectFiles.map((f) => ({
      label: vscode.workspace.asRelativePath(f),
      uri: f,
    })),
    { placeHolder: 'Select project to add' },
  );
  if (pick === undefined) {
    return;
  }

  const solutionPath = await pickSolutionFile();
  if (solutionPath === undefined) {
    return;
  }

  try {
    await runDotnet(['sln', solutionPath, 'add', pick.uri.fsPath], path.dirname(solutionPath));
    void vscode.window.showInformationMessage(`Added ${pick.label} to solution`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed: ${message}`);
  }
}

async function pickSolutionFile(): Promise<string | undefined> {
  const selected = state.solutionPath.value;
  if (selected !== undefined) {
    return selected;
  }

  const solutions = await findSolutions();
  if (solutions.length === 0) {
    void vscode.window.showWarningMessage('No .sln or .slnx file found.');
    return undefined;
  }
  if (solutions.length === 1) {
    return solutions[0]?.path;
  }

  const picked = await vscode.window.showQuickPick(
    solutions.map((solution) => ({
      label: solution.name,
      description: solution.path,
      path: solution.path,
    })),
    { placeHolder: 'Select solution file' },
  );
  return picked?.path;
}

function generateFileContent(type: string, name: string): string {
  switch (type) {
    case 'interface':
      return `namespace MyNamespace;\n\npublic interface ${name}\n{\n}\n`;
    case 'enum':
      return `namespace MyNamespace;\n\npublic enum ${name}\n{\n}\n`;
    case 'struct':
      return `namespace MyNamespace;\n\npublic struct ${name}\n{\n}\n`;
    case 'record':
      return `namespace MyNamespace;\n\npublic record ${name};\n`;
    default:
      return `namespace MyNamespace;\n\npublic class ${name}\n{\n}\n`;
  }
}

async function runDotnet(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('dotnet', args, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr !== '' ? stderr : error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Register scaffolding commands. */
export function registerScaffoldingCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('forge.newProject', newProject));
  context.subscriptions.push(vscode.commands.registerCommand('forge.newFile', newFile));
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.addProjectToSolution', addProjectToSolution),
  );
  info('Scaffolding commands registered');
}
