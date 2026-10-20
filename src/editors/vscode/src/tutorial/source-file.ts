// Implements [TUTORIAL-OPEN-FILE]: the file the tutorial opens is one the server has loaded,
// so hover, completion and navigation answer in it.
import * as vscode from 'vscode';
import { fileUri, hasExtension } from '../paths.js';
import { symbolsState } from '../state.js';
import { type LanguageKind, projectExtension, sourceExtension } from './steps.js';

const OPEN_FILE_EXCLUDE = '**/{bin,obj,node_modules,.git}/**';

/** Where the tutorial finds a file: in the loaded solution, or a workspace project when none is loaded. */
export type SourceFile =
  | { readonly kind: 'found'; readonly uri: vscode.Uri }
  | { readonly kind: 'none'; readonly where: 'solution' | 'workspace' };

/** The loaded solution's first `language` file that declares something. */
function solutionFile(language: LanguageKind): SourceFile | undefined {
  const symbols = symbolsState.value;
  if (symbols.kind !== 'loaded') return undefined;
  const extension = sourceExtension(language);
  const file = symbols.response.projects
    .flatMap((project) => project.symbols)
    .find((entry) => entry.symbols.length > 0 && hasExtension(entry.file, extension));
  return file === undefined
    ? { kind: 'none', where: 'solution' }
    : { kind: 'found', uri: fileUri(file.file) };
}

/** The first `language` file under a `language` project's directory: one the server can load. */
async function workspaceFile(language: LanguageKind): Promise<SourceFile> {
  const glob = `**/*${projectExtension(language)}`;
  const projects = await vscode.workspace.findFiles(glob, OPEN_FILE_EXCLUDE);
  for (const project of projects.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
    const directory = vscode.Uri.joinPath(project, '..');
    const sources = new vscode.RelativePattern(directory, `**/*${sourceExtension(language)}`);
    const [uri] = await vscode.workspace.findFiles(sources, OPEN_FILE_EXCLUDE, 1);
    if (uri !== undefined) return { kind: 'found', uri };
  }
  return { kind: 'none', where: 'workspace' };
}

/** The `language` file `sharplsp.tutorial.openFile` opens. */
export async function tutorialSourceFile(language: LanguageKind): Promise<SourceFile> {
  return solutionFile(language) ?? (await workspaceFile(language));
}
