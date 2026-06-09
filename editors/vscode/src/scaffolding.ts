import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { info } from './log';
import { findSolutions } from './solution.js';
import * as state from './state.js';
import {
  CMD_NEW_SOLUTION,
  CMD_NEW_PROJECT,
  CMD_NEW_FILE,
  CMD_ADD_PROJECT_TO_SOLUTION,
  CMD_OPEN_SOLUTION,
  CMD_REFRESH_EXPLORER,
} from './constants.js';

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

// ── .NET CLI core (no UI — pure + testable) ─────────────────────

/** Build the `dotnet new sln` argument vector. */
export function newSolutionArgs(name: string, folder: string): string[] {
  return ['new', 'sln', '--name', name, '--output', folder];
}

/** Build the `dotnet new <template>` argument vector. */
export function newProjectArgs(
  template: string,
  name: string,
  folder: string,
  lang?: string,
): string[] {
  const args = ['new', template, '--name', name, '--output', path.join(folder, name)];
  if (lang !== undefined) {
    args.push('--language', lang);
  }
  return args;
}

/**
 * Create a solution file via the .NET CLI. Returns the absolute solution path.
 *
 * The SDK chooses the format: .NET 9+ emits a modern `.slnx` (XML) solution,
 * while older SDKs emit a classic `.sln`. We detect whichever was produced
 * instead of assuming an extension.
 */
export async function createSolution(folder: string, name: string): Promise<string> {
  await runDotnet(newSolutionArgs(name, folder), folder);
  for (const ext of ['slnx', 'sln']) {
    const candidate = path.join(folder, `${name}.${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Solution file for "${name}" was not created`);
}

/** Create a project via the .NET CLI. Returns the absolute project directory. */
export async function createProject(
  folder: string,
  name: string,
  template: string,
  lang?: string,
): Promise<string> {
  await runDotnet(newProjectArgs(template, name, folder, lang), folder);
  return path.join(folder, name);
}

/** Add a project to a solution via the .NET CLI. */
export async function addProjectToSolutionFile(
  solutionPath: string,
  projectPath: string,
): Promise<void> {
  await runDotnet(['sln', solutionPath, 'add', projectPath], path.dirname(solutionPath));
}

/** Locate the `.csproj`/`.fsproj` for a freshly created project. */
export function findProjectFile(projectDir: string, name: string): string | undefined {
  for (const ext of ['csproj', 'fsproj']) {
    const candidate = path.join(projectDir, `${name}.${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// ── UI helpers ──────────────────────────────────────────────────

function workspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function reportFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`Failed: ${message}`);
}

async function pickProjectTemplate(): Promise<
  { template: string; lang: string | undefined } | undefined
> {
  return vscode.window.showQuickPick(
    PROJECT_TEMPLATES.map((t) => ({
      label: t.label,
      description: t.lang ?? 'C#',
      template: t.template,
      lang: t.lang,
    })),
    { placeHolder: 'Select project template' },
  );
}

/** Resolve the solution a new project should join, if any. */
async function resolveTargetSolution(explicit?: string): Promise<string | undefined> {
  if (explicit !== undefined) {
    return explicit;
  }
  if (state.solutionPath.value !== undefined) {
    return state.solutionPath.value;
  }
  const solutions = await findSolutions();
  return solutions.length === 1 ? solutions[0]?.path : undefined;
}

/** Add a newly created project to the active/target solution when one exists. */
async function addToSolutionIfAny(
  projectDir: string,
  name: string,
  explicitSolution?: string,
): Promise<void> {
  const solutionPath = await resolveTargetSolution(explicitSolution);
  if (solutionPath === undefined) {
    return;
  }
  const projectFile = findProjectFile(projectDir, name);
  if (projectFile === undefined) {
    return;
  }
  await addProjectToSolutionFile(solutionPath, projectFile);
  info(`Added ${name} to ${path.basename(solutionPath)}`);
}

// ── Commands ────────────────────────────────────────────────────

/** Create a new solution via `dotnet new sln`, then offer to add a first project. */
async function newSolution(): Promise<void> {
  const folder = workspaceFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Solution name',
    placeHolder: 'MySolution',
  });
  if (name === undefined || name === '') {
    return;
  }
  try {
    const solutionPath = await createSolution(folder, name);
    info(`Created solution ${name}`);
    await vscode.commands.executeCommand(CMD_OPEN_SOLUTION, solutionPath);
    await offerFirstProject(solutionPath);
  } catch (err) {
    reportFailure(err);
  }
}

/** Prompt to scaffold a first project into a brand-new solution. */
async function offerFirstProject(solutionPath: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Created ${path.basename(solutionPath)}. Add a project now?`,
    'Add Project',
    'Later',
  );
  if (choice === 'Add Project') {
    await newProject(solutionPath);
  }
}

/** Create a new .NET project via `dotnet new`, joining the active solution if any. */
async function newProject(explicitSolution?: string): Promise<void> {
  const pick = await pickProjectTemplate();
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
  const folder = workspaceFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  try {
    const projectDir = await createProject(folder, name, pick.template, pick.lang);
    await addToSolutionIfAny(projectDir, name, explicitSolution);
    void vscode.window.showInformationMessage(`Created ${name}`);
    info(`Created project ${name} from template ${pick.template}`);
    await vscode.commands.executeCommand(CMD_REFRESH_EXPLORER);
  } catch (err) {
    reportFailure(err);
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

  const folder = workspaceFolder();
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
    await addProjectToSolutionFile(solutionPath, pick.uri.fsPath);
    void vscode.window.showInformationMessage(`Added ${pick.label} to solution`);
    await vscode.commands.executeCommand(CMD_REFRESH_EXPLORER);
  } catch (err) {
    reportFailure(err);
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
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_NEW_SOLUTION, async () => newSolution()),
    // Wrap so menu/keybinding invocation args are never mistaken for a target solution.
    vscode.commands.registerCommand(CMD_NEW_PROJECT, async () => newProject()),
    vscode.commands.registerCommand(CMD_NEW_FILE, newFile),
    vscode.commands.registerCommand(CMD_ADD_PROJECT_TO_SOLUTION, addProjectToSolution),
  );
  info('Scaffolding commands registered');
}
