import * as vscode from 'vscode';
import * as fs from 'fs';
import { directoryOf, fileNameOf, joinPath } from './paths';
import { runDotnet } from './dotnet-process.js';
import { info } from './log';
import { findSolutions } from './solution.js';
import * as state from './state.js';
import { type ExplorerNode, NodeType } from './tree-nodes.js';
import { getErrorMessage } from './utils.js';
import { addFileToNearestProject } from './add-source-file.js';
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
  const args = ['new', template, '--name', name, '--output', joinPath(folder, name)];
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
  await dotnet(newSolutionArgs(name, folder), folder);
  for (const ext of ['slnx', 'sln']) {
    const candidate = joinPath(folder, `${name}.${ext}`);
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
  await dotnet(newProjectArgs(template, name, folder, lang), folder);
  return joinPath(folder, name);
}

/** Add a project to a solution via the .NET CLI. */
export async function addProjectToSolutionFile(
  solutionPath: string,
  projectPath: string,
): Promise<void> {
  await dotnet(['sln', solutionPath, 'add', projectPath], directoryOf(solutionPath));
}

/** Locate the `.csproj`/`.fsproj` for a freshly created project. */
export function findProjectFile(projectDir: string, name: string): string | undefined {
  for (const ext of ['csproj', 'fsproj']) {
    const candidate = joinPath(projectDir, `${name}.${ext}`);
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
  void vscode.window.showErrorMessage(`Failed: ${getErrorMessage(err)}`);
}

async function pickProjectTemplate(): Promise<
  { template: string; lang: string | undefined } | undefined
> {
  return await vscode.window.showQuickPick(
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
  info(`Added ${name} to ${fileNameOf(solutionPath)}`);
}

// ── Commands ────────────────────────────────────────────────────

/** Create a new solution via `dotnet new sln`, then offer to add a first project. */
async function newSolution(): Promise<void> {
  try {
    const created = await createSolutionByName();
    if (created === undefined) return;
    info(`Created solution ${fileNameOf(created.path)}`);
    await vscode.commands.executeCommand(CMD_OPEN_SOLUTION, created.path);
    await offerFirstProject(created.path);
  } catch (err) {
    reportFailure(err);
  }
}

/** Ask for a solution name and scaffold it in the workspace root. */
async function createSolutionByName(): Promise<SolutionTarget | undefined> {
  const folder = workspaceFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return undefined;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Solution name',
    placeHolder: 'MySolution',
  });
  if (name === undefined || name === '') return undefined;
  return { path: await createSolution(folder, name), created: true };
}

/** Offer to scaffold the workspace's first solution instead of dead-ending. */
async function offerNewSolution(message: string): Promise<SolutionTarget | undefined> {
  const choice = await vscode.window.showWarningMessage(message, 'Create Solution');
  return choice === 'Create Solution' ? await createSolutionByName() : undefined;
}

/** Prompt to scaffold a first project into a brand-new solution. */
async function offerFirstProject(solutionPath: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Created ${fileNameOf(solutionPath)}. Add a project now?`,
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
  const filePath = joinPath(folder, `${name}.cs`);
  const uri = vscode.Uri.file(filePath);

  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri);
  edit.insert(uri, new vscode.Position(0, 0), content);
  if (!(await vscode.workspace.applyEdit(edit))) {
    await vscode.window.showWarningMessage(
      `Could not create ${name}.cs. The file may already exist.`,
    );
    return;
  }

  await vscode.window.showTextDocument(uri);

  // Add the file to the nearest .csproj if it uses explicit <Compile> includes.
  // The MSBuild-DOM edit decides that — no text probing of the project file
  // ([SE-ADD-FILE-CSHARP]). It runs after the file opens and is not awaited: an
  // SDK project compiles every .cs by glob, and the new file must never wait
  // behind a workspace reload in the compiler. Failures are logged by the helper.
  void addFileToNearestProject(filePath, '*.csproj');
}

/** Select an existing workspace project for the palette command. */
async function pickWorkspaceProject(): Promise<vscode.Uri | undefined> {
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
  return pick?.uri;
}

/** Implements [SE-SOLUTION-ADD]: preserve the clicked row's identity. */
async function projectForSelection(node?: ExplorerNode): Promise<vscode.Uri | undefined> {
  if (node?.nodeType === NodeType.Project) {
    return node.projectFilePath === undefined ? undefined : vscode.Uri.file(node.projectFilePath);
  }
  if (node?.nodeType !== NodeType.Solution) return await pickWorkspaceProject();
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { '.NET projects': ['fsproj', 'csproj'] },
    openLabel: 'Add Existing Project',
  });
  return picked?.[0];
}

/** Add an existing project to the selected solution. Implements [SE-SOLUTION-ADD]. */
async function addProjectToSolution(node?: ExplorerNode): Promise<void> {
  const project = await projectForSelection(node);
  if (project === undefined) return;
  // A solution row fixes the target to that solution; every other entry point
  // chooses one ([SE-SOLUTION-ADD-CONTEXT]).
  const solutionRow = node?.nodeType === NodeType.Solution ? node.projectFilePath : undefined;
  try {
    const target =
      solutionRow !== undefined
        ? { path: solutionRow, created: false }
        : await pickTargetSolution(node === undefined);
    if (target === undefined) return;
    await addProjectToSolutionFile(target.path, project.fsPath);
    void vscode.window.showInformationMessage(
      `Added ${vscode.workspace.asRelativePath(project)} to solution`,
    );
    // A freshly created solution becomes the loaded one so the explorer shows
    // the add; an existing target only refreshes the current tree.
    if (target.created) {
      await vscode.commands.executeCommand(CMD_OPEN_SOLUTION, target.path);
    } else {
      await vscode.commands.executeCommand(CMD_REFRESH_EXPLORER);
    }
  } catch (err) {
    reportFailure(err);
  }
}

/** The target of an add: a solution path plus whether SharpLsp just created it. */
interface SolutionTarget {
  readonly path: string;
  readonly created: boolean;
}

/** QuickPick row that scaffolds a brand-new solution instead of choosing one. */
const CREATE_SOLUTION_PICK = { label: '$(add) Create New Solution…' } as const;

/** One row of the target-solution QuickPick. */
interface SolutionPick {
  readonly label: string;
  readonly description?: string;
  readonly path?: string;
}

/** The QuickPick rows for `solutions`, plus the create-new escape hatch. */
function solutionPicks(solutions: readonly { name: string; path: string }[]): SolutionPick[] {
  return [
    ...solutions.map((solution): SolutionPick => ({
      label: solution.name,
      description: solution.path,
      path: solution.path,
    })),
    CREATE_SOLUTION_PICK,
  ];
}

/**
 * The solution an existing project joins: the active one (palette shortcut),
 * the user's workspace pick, or a brand-new solution when the workspace has
 * none — a workspace without a solution must never dead-end at a warning
 * (#576). Implements [SE-SOLUTION-ADD-CONTEXT].
 */
async function pickTargetSolution(preferActive: boolean): Promise<SolutionTarget | undefined> {
  if (preferActive) {
    const selected = state.solutionPath.value;
    if (selected !== undefined) return { path: selected, created: false };
  }
  const solutions = await findSolutions();
  if (solutions.length === 0) {
    return await offerNewSolution('No .sln or .slnx file found in the workspace.');
  }
  const [only] = solutions;
  if (only !== undefined && solutions.length === 1) {
    return { path: only.path, created: false };
  }
  const picked = await vscode.window.showQuickPick<SolutionPick>(solutionPicks(solutions), {
    placeHolder: 'Select solution file',
  });
  if (picked === undefined) return undefined;
  if (picked === CREATE_SOLUTION_PICK) return await createSolutionByName();
  return picked.path !== undefined ? { path: picked.path, created: false } : undefined;
}

/** Generate the source body for a new file of the given snippet type. Pure. */
export function generateFileContent(type: string, name: string): string {
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

/**
 * Run one scaffolding `dotnet` command through the shared runner: the resolved
 * SDK, a pinned UI language and the cold-machine budget. A fixed 30s cap killed
 * the first `dotnet new` on a cold machine (template scan plus restore) and
 * reported a project that was still being created as failed.
 */
async function dotnet(args: string[], cwd: string): Promise<void> {
  const run = await runDotnet(args, cwd);
  if (run.failed) {
    throw new Error(run.stderr !== '' ? run.stderr : (run.errorMessage ?? 'dotnet failed'));
  }
}

/** Register scaffolding commands. */
export function registerScaffoldingCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_NEW_SOLUTION, async () => {
      await newSolution();
    }),
    // Wrap so menu/keybinding invocation args are never mistaken for a target solution.
    vscode.commands.registerCommand(CMD_NEW_PROJECT, async () => {
      await newProject();
    }),
    vscode.commands.registerCommand(CMD_NEW_FILE, newFile),
    vscode.commands.registerCommand(CMD_ADD_PROJECT_TO_SOLUTION, addProjectToSolution),
  );
  info('Scaffolding commands registered');
}
