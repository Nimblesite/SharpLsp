// "Add F# Source File" (GitHub #493) — [SE-ADD-FILE-COMMAND].
//
// In F# compile ORDER matters: a new source file must land at a chosen position
// in the .fsproj's Compile list, or the project stops compiling. This module
// asks for a name, creates the .fs (and optionally the matching .fsi first),
// and asks the Rust host (`sharplsp/project/addCompileItem`,
// [SE-ADD-FILE-REQUEST]) to insert the Compile item through the C# sidecar's
// MSBuild DOM — never by text-splicing the project file. F# first: C# has no
// counterpart surface yet.
import * as vscode from 'vscode';
import { CMD_REFRESH_EXPLORER } from './constants.js';
import { info } from './log.js';
import { directoryOf, fileNameOf, hasExtension, isWithin, joinPath, relativePath } from './paths';
import * as state from './state.js';
import { getErrorMessage } from './utils.js';

/** Where the new Compile item lands relative to the anchor file. */
export type CompilePosition = 'default' | 'before' | 'after';

/** The slice of an explorer node this module needs (structural, like the kits). */
export interface NodeLike {
  readonly projectFilePath?: string;
  readonly symbolUri?: string;
  readonly parent?: NodeLike | undefined;
}

/** Parameters of the `sharplsp/project/addCompileItem` request. */
interface AddCompileItemParams {
  readonly projectPath: string;
  readonly include: string;
  readonly anchorInclude?: string | undefined;
  readonly position?: CompilePosition;
}

/** Response of the `sharplsp/project/addCompileItem` request. */
export interface AddCompileItemResponse {
  readonly success: boolean;
  readonly message: string;
  readonly modified: boolean;
}

/** Ask the host to insert a `<Compile>` item ([SE-ADD-FILE-REQUEST]). */
export async function insertCompileItem(
  params: AddCompileItemParams,
): Promise<AddCompileItemResponse | undefined> {
  const client = state.client.value;
  if (client === undefined) {
    info('addCompileItem skipped: no language client');
    return undefined;
  }
  return await client.sendRequest<AddCompileItemResponse>(
    'sharplsp/project/addCompileItem',
    params,
  );
}

// ── Pure helpers (exported for tests) ────────────────────────────

/** The project-relative Compile include for a source file. */
export function compileIncludeOf(projectPath: string, filePath: string): string {
  return relativePath(directoryOf(projectPath), filePath);
}

/**
 * The insert sequence for a signature+implementation pair: `.fsi` first,
 * EXCEPT when inserting `after` an anchor — there the `.fs` goes in first so
 * the signature still precedes its implementation ([SE-ADD-FILE-ORDER]).
 */
export function pairInsertOrder(stems: readonly string[], position: CompilePosition): string[] {
  return position === 'after' ? [...stems].reverse() : [...stems];
}

/** A valid F# module identifier derived from a file name (`my-file` → `MyFile`). */
export function moduleNameOf(name: string): string {
  const pascal = name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
  return pascal.length > 0 ? pascal : 'NewModule';
}

/** Initial body for a new `.fs` / `.fsi` file. */
export function fsharpFileContent(name: string): string {
  return `module ${moduleNameOf(name)}\n`;
}

/** The `.fsproj` a node belongs to, via the parent chain; C# projects miss. */
export function fsharpProjectOfNode(node: NodeLike | undefined): string | undefined {
  let current = node;
  while (current !== undefined) {
    const candidate = current.projectFilePath;
    if (candidate !== undefined && hasExtension(candidate, '.fsproj')) {
      return candidate;
    }
    current = current.parent;
  }
  return undefined;
}

// ── Command ──────────────────────────────────────────────────────

interface Target {
  readonly projectPath: string;
  /** Absolute anchor file path when the command ran on a file node. */
  readonly anchorFile?: string | undefined;
}

/** The `sharplsp.addFSharpSourceFile` command handler. */
export async function addFSharpSourceFile(node?: NodeLike): Promise<void> {
  try {
    const target = await resolveTarget(node);
    if (target === undefined) return;
    await addFileInteractive(target);
  } catch (err) {
    void vscode.window.showErrorMessage(`Add F# Source File failed: ${getErrorMessage(err)}`);
  }
}

/** Resolve the target project + anchor: from the node, or a palette pick. */
async function resolveTarget(node: NodeLike | undefined): Promise<Target | undefined> {
  if (node !== undefined) {
    return targetFromNode(node);
  }
  return await targetFromPalette();
}

function targetFromNode(node: NodeLike): Target | undefined {
  const projectPath = fsharpProjectOfNode(node);
  if (projectPath === undefined) {
    void vscode.window.showErrorMessage('Add F# Source File: the node is not in an F# project.');
    return undefined;
  }
  return { projectPath, anchorFile: anchorFileOf(node, projectPath) };
}

/** The anchor file when the node carries one inside the project, else none. */
function anchorFileOf(node: NodeLike, projectPath: string): string | undefined {
  if (node.symbolUri === undefined) return undefined;
  const file = vscode.Uri.parse(node.symbolUri).fsPath;
  return isWithin(file, directoryOf(projectPath)) ? file : undefined;
}

async function targetFromPalette(): Promise<Target | undefined> {
  const projects = await vscode.workspace.findFiles('**/*.fsproj', '**/node_modules/**');
  if (projects.length === 0) {
    void vscode.window.showWarningMessage('No F# project files found in the workspace.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    projects.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), path: uri.fsPath })),
    { placeHolder: 'Select the F# project to add the file to' },
  );
  return pick === undefined ? undefined : { projectPath: pick.path };
}

/** Prompt, create the files, insert them into compile order, open the .fs. */
async function addFileInteractive(target: Target): Promise<void> {
  const name = await promptName();
  if (name === undefined) return;

  const signature = await promptSignature();
  if (signature === undefined) return;

  const position = await promptPosition(target);
  if (position === undefined) return;

  const extensions = signature ? ['.fsi', '.fs'] : ['.fs'];
  const folder =
    target.anchorFile !== undefined
      ? directoryOf(target.anchorFile)
      : directoryOf(target.projectPath);
  const files = extensions.map((ext) => joinPath(folder, `${name}${ext}`));

  await createFiles(files, name);
  const inserted = await insertIntoProject(target, files, position);
  if (!inserted) return;

  await vscode.commands.executeCommand(CMD_REFRESH_EXPLORER);
  await vscode.window.showTextDocument(vscode.Uri.file(files[files.length - 1] ?? ''));
}

async function promptName(): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'F# source file name (without extension)',
    placeHolder: 'MyModule',
  });
  return name === undefined || name === '' ? undefined : name.replace(/\.(fsi|fs)$/u, '');
}

async function promptSignature(): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'No', value: false },
      { label: 'Yes', value: true },
    ],
    { placeHolder: 'Create a matching signature file (.fsi) first?' },
  );
  return pick?.value;
}

/** Above/Below the anchor on file nodes; the default position otherwise. */
async function promptPosition(target: Target): Promise<CompilePosition | undefined> {
  if (target.anchorFile === undefined) return 'default';
  const anchor = fileNameOf(target.anchorFile);
  const pick = await vscode.window.showQuickPick(
    [
      { label: `Above ${anchor}`, value: 'before' as const },
      { label: `Below ${anchor}`, value: 'after' as const },
    ],
    { placeHolder: 'Where in the compile order?' },
  );
  return pick?.value;
}

/** Write every file with its stub; the .fs (last) is the one opened later. */
async function createFiles(files: readonly string[], name: string): Promise<void> {
  const encoder = new TextEncoder();
  for (const file of files) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(file),
      encoder.encode(fsharpFileContent(name)),
    );
  }
}

/**
 * Insert a Compile item per file, in the pair order the position demands. The
 * host edit is idempotent, so a retry after partial failure is safe.
 */
async function insertIntoProject(
  target: Target,
  files: readonly string[],
  position: CompilePosition,
): Promise<boolean> {
  const includes = files.map((file) => compileIncludeOf(target.projectPath, file));
  const anchorInclude =
    target.anchorFile !== undefined && position !== 'default'
      ? compileIncludeOf(target.projectPath, target.anchorFile)
      : undefined;

  for (const include of pairInsertOrder(includes, position)) {
    const response = await insertCompileItem({
      projectPath: target.projectPath,
      include,
      anchorInclude,
      position,
    });
    if (response?.success !== true) {
      void vscode.window.showErrorMessage(
        `Failed to add ${include} to ${fileNameOf(target.projectPath)}: ${response?.message ?? 'no language client'}`,
      );
      return false;
    }
  }
  info(
    `Added ${String(files.length)} F# source file(s) to ${fileNameOf(target.projectPath)} (${position})`,
  );
  return true;
}

// ── C# newFile auto-add ([SE-ADD-FILE-CSHARP]) ───────────────────

/**
 * Add an existing file to the nearest project that manages explicit Compile
 * includes. The host edit no-ops on glob projects (no explicit items), so the
 * old "does the csproj contain <Compile Include=" string probe is gone — the
 * MSBuild DOM decides, never text matching.
 */
export async function addFileToNearestProject(filePath: string, pattern: string): Promise<void> {
  try {
    const dir = directoryOf(filePath);
    const projects = await vscode.workspace.findFiles(new vscode.RelativePattern(dir, pattern));
    for (const project of projects) {
      if (await addToProjectIfExplicit(project.fsPath, filePath)) return;
    }
  } catch (err) {
    info(`Auto-add to project skipped: ${getErrorMessage(err)}`);
  }
}

/** Offer the file to one project; report whether it took the item. */
async function addToProjectIfExplicit(projectPath: string, filePath: string): Promise<boolean> {
  const response = await insertCompileItem({
    projectPath,
    include: fileNameOf(filePath),
  });
  if (response?.modified !== true) return false;
  info(`Auto-added ${fileNameOf(filePath)} to ${fileNameOf(projectPath)}`);
  return true;
}
