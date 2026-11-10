/**
 * Building the Solution Explorer tree from the server's workspace symbols:
 * solution → projects → dependencies, namespaces and symbols.
 * Implements [SE-TREE], [SE-TREE-NAMESPACE-NEST], [SE-SORT], [SE-CONTEXT-MENUS].
 */
import { Position, Range, ThemeColor, ThemeIcon, TreeItemCollapsibleState, Uri } from 'vscode';
import { CMD_OPEN_SOLUTION } from './constants.js';
import type * as deps from './dependencies.js';
import { fileNameOf } from './paths';
import * as projectDeps from './project-deps-store.js';
import { type SolutionSelection } from './solution.js';
import {
  type FileSymbol,
  type LspRange,
  type ProjectNode,
  type SortOrder,
  type SymbolNode,
  type WorkspaceSymbolsResponse,
} from './state.js';
import { arrangeNamespaces } from './tree-namespaces.js';
import { ExplorerNode, iconForKind, NodeType } from './tree-nodes.js';
import { applySortOrder } from './tree-sort.js';
import { SYMBOL_CONTEXT_VALUES } from './tree-tooltip.js';

export function buildTree(
  solutionPath: string,
  response: WorkspaceSymbolsResponse,
  order: SortOrder,
  nest: boolean,
): ExplorerNode[] {
  const name = fileNameOf(solutionPath);
  const node = new ExplorerNode(name, NodeType.Solution, TreeItemCollapsibleState.Expanded);
  node.iconPath = new ThemeIcon('package', new ThemeColor('terminal.ansiGreen'));
  node.sortName = name;
  node.contextValue = 'solution';
  node.projectFilePath = solutionPath;
  node.children = response.projects.map((project) => buildProjectNode(project, nest));
  for (const project of node.children) {
    // Wire the project → solution link so TreeView.reveal can walk a complete
    // parent chain from any file node up to the root (issue #118).
    project.parent = node;
    sortProjectChildren(project, order);
  }
  return [node];
}

function buildProjectNode(project: ProjectNode, nest: boolean): ExplorerNode {
  const file = fileNameOf(project.path);
  const label = `${project.name} (${file})`;
  const node = new ExplorerNode(label, NodeType.Project, TreeItemCollapsibleState.Expanded);
  node.iconPath = new ThemeIcon('project', new ThemeColor('terminal.ansiCyan'));
  node.sortName = project.name;
  node.contextValue = 'project';
  node.projectFilePath = project.path;
  const depFolder = buildDependencyFolder(project.path);
  const symbols = groupByNamespace(project.symbols, nest);
  node.children = depFolder !== undefined ? [depFolder, ...symbols] : symbols;
  // Wire each direct child (namespace nodes, top-level symbols, Dependencies)
  // back to the project so the reveal parent chain is unbroken (issue #118).
  for (const child of node.children) {
    child.parent = node;
  }
  return node;
}

function buildDependencyFolder(projectPath: string): ExplorerNode | undefined {
  const parsed = projectDeps.ensureTracked(projectPath);
  const hasPackages = parsed.nugetPackages.length > 0;
  const hasProjects = parsed.projectReferences.length > 0;
  if (!hasPackages && !hasProjects) return undefined;

  const folder = new ExplorerNode(
    'Dependencies',
    NodeType.DependencyFolder,
    TreeItemCollapsibleState.Collapsed,
  );
  folder.iconPath = new ThemeIcon('extensions', new ThemeColor('terminal.ansiYellow'));
  folder.sortName = '';
  folder.contextValue = 'dependencyFolder';
  if (hasPackages) {
    folder.children.push(buildPackageFolder(parsed.nugetPackages, projectPath));
  }
  if (hasProjects) {
    folder.children.push(buildProjectRefFolder(parsed.projectReferences, projectPath));
  }
  return folder;
}

function buildPackageFolder(packages: deps.NuGetPackage[], projectPath: string): ExplorerNode {
  const folder = new ExplorerNode(
    'Packages',
    NodeType.DependencyFolder,
    TreeItemCollapsibleState.Collapsed,
  );
  folder.iconPath = new ThemeIcon('package');
  folder.sortName = '0';
  folder.children = packages.map((pkg) => buildNuGetNode(pkg, projectPath));
  return folder;
}

function buildNuGetNode(pkg: deps.NuGetPackage, projectPath: string): ExplorerNode {
  const node = new ExplorerNode(pkg.name, NodeType.NuGetPackage, TreeItemCollapsibleState.None);
  node.description = pkg.version;
  node.iconPath = new ThemeIcon('package', new ThemeColor('terminal.ansiBlue'));
  node.sortName = pkg.name;
  node.contextValue = 'nugetPackage';
  node.projectFilePath = projectPath;
  node.referenceName = pkg.name;
  return node;
}

function buildProjectRefFolder(
  references: deps.ProjectReference[],
  projectPath: string,
): ExplorerNode {
  const folder = new ExplorerNode(
    'Projects',
    NodeType.DependencyFolder,
    TreeItemCollapsibleState.Collapsed,
  );
  folder.iconPath = new ThemeIcon('project', new ThemeColor('terminal.ansiCyan'));
  folder.sortName = '1';
  folder.children = references.map((ref) => buildProjectRefNode(ref, projectPath));
  return folder;
}

function buildProjectRefNode(ref: deps.ProjectReference, projectPath: string): ExplorerNode {
  const node = new ExplorerNode(ref.name, NodeType.ProjectRef, TreeItemCollapsibleState.None);
  node.iconPath = new ThemeIcon('project', new ThemeColor('terminal.ansiCyan'));
  node.sortName = ref.name;
  node.contextValue = 'projectReference';
  node.projectFilePath = projectPath;
  node.referenceName = ref.includePath;
  return node;
}

/** Keep Dependencies folder pinned at top when sorting. */
function sortProjectChildren(project: ExplorerNode, order: SortOrder): void {
  const depIdx = project.children.findIndex(
    (child) => child.nodeType === NodeType.DependencyFolder,
  );
  if (depIdx < 0) {
    applySortOrder(project.children, order);
    return;
  }
  const depNode = project.children.splice(depIdx, 1)[0];
  if (depNode === undefined) return;
  applySortOrder(project.children, order);
  project.children.unshift(depNode);
}

function groupByNamespace(fileSymbols: FileSymbol[], nest: boolean): ExplorerNode[] {
  const namespaces = new Map<string, ExplorerNode[]>();
  const noNamespace: ExplorerNode[] = [];

  for (const file of fileSymbols) {
    for (const sym of file.symbols) {
      if (sym.kind === 'Namespace') {
        mergeNamespace(namespaces, sym, file.file);
      } else {
        noNamespace.push(buildSymbolNode(sym, file.file));
      }
    }
  }

  return [...arrangeNamespaces(namespaces, nest, createNamespaceNode), ...noNamespace];
}

/**
 * Merge `sym`'s members into the namespace keyed by its full name. A namespace
 * declared inside another (`namespace A { namespace B {} }`) merges as `A.B`,
 * the same row a `namespace A.B` declaration lands in ([SE-TREE-NAMESPACE-MERGE]).
 */
function mergeNamespace(
  namespaces: Map<string, ExplorerNode[]>,
  sym: SymbolNode,
  filePath: string,
  qualifier = '',
): void {
  const name = `${qualifier}${sym.name}`;
  const isNamespace = (child: SymbolNode): boolean => child.kind === 'Namespace';
  const members = buildSymbolChildren(
    sym.children.filter((child) => !isNamespace(child)),
    filePath,
  );
  namespaces.set(name, [...(namespaces.get(name) ?? []), ...members]);
  for (const inner of sym.children.filter(isNamespace)) {
    mergeNamespace(namespaces, inner, filePath, `${name}.`);
  }
}

function createNamespaceNode(name: string, children: ExplorerNode[]): ExplorerNode {
  const node = new ExplorerNode(name, NodeType.Namespace, TreeItemCollapsibleState.Collapsed);
  node.iconPath = new ThemeIcon(
    'symbol-namespace',
    new ThemeColor('symbolIcon.namespaceForeground'),
  );
  node.sortName = name;
  node.contextValue = 'symbol.namespace';
  node.symbolKind = 'Namespace';
  node.children = children;
  for (const child of children) {
    child.parent = node;
  }
  return node;
}

function buildSymbolNode(sym: SymbolNode, filePath: string): ExplorerNode {
  const label = sym.detail !== null ? `${sym.name} : ${sym.detail}` : sym.name;
  const collapsible =
    sym.children.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None;
  const node = new ExplorerNode(label, NodeType.Symbol, collapsible);
  node.iconPath = iconForKind(sym.kind);
  node.sortName = sym.name;
  node.symbolKind = sym.kind;
  node.symbolRange = sym.range;
  node.contextValue = SYMBOL_CONTEXT_VALUES[sym.kind] ?? 'symbol.unknown';
  if (sym.access !== null) node.access = sym.access;
  if (filePath !== '') {
    attachGoToCommand(node, filePath, sym.range);
    node.symbolUri = Uri.file(filePath).toString();
    node.symbolPosition = sym.range.start;
  }
  node.children = buildSymbolChildren(sym.children, filePath);
  for (const child of node.children) {
    child.parent = node;
  }
  return node;
}

function attachGoToCommand(node: ExplorerNode, filePath: string, range: LspRange): void {
  const pos = new Position(range.start.line, range.start.character);
  node.command = {
    title: 'Go to Symbol',
    command: 'vscode.open',
    arguments: [Uri.file(filePath), { selection: new Range(pos, pos) }],
  };
}

function buildSymbolChildren(children: SymbolNode[], filePath: string): ExplorerNode[] {
  return children.map((child) => buildSymbolNode(child, filePath));
}

// ── LSP hover for tree items ─────────────────────────────────────

/** Walk the tree upward to build a fully-qualified name. */
export function buildQualifiedName(node: ExplorerNode): string {
  const parts: string[] = [node.sortName];
  let current = node.parent;
  while (current !== undefined) {
    if (current.nodeType === NodeType.Namespace || current.nodeType === NodeType.Symbol) {
      parts.unshift(current.sortName);
    }
    current = current.parent;
  }
  return parts.join('.');
}

export function buildSolutionChoiceNode(sol: SolutionSelection): ExplorerNode {
  const node = new ExplorerNode(sol.name, NodeType.SolutionChoice, TreeItemCollapsibleState.None);
  node.description = sol.path;
  node.iconPath = new ThemeIcon('file-symlink-directory', new ThemeColor('terminal.ansiGreen'));
  node.contextValue = 'solutionChoice';
  node.command = {
    title: 'Open Solution',
    command: CMD_OPEN_SOLUTION,
    arguments: [sol.path],
  };
  return node;
}

export function makeErrorNode(message: string): ExplorerNode {
  // [HOVER-TREE-IMPLEMENTATION]: an error row has no source position to hover.
  const node = new ExplorerNode(
    `Error: ${message}`,
    NodeType.Feedback,
    TreeItemCollapsibleState.None,
  );
  node.iconPath = new ThemeIcon('error');
  return node;
}

/**
 * Transient node shown while the solution pipeline works — the tree must
 * never just sit blank ([SE-LOADING-FEEDBACK]). `loading~spin` is the same
 * codicon the status bar uses while the LSP is connecting.
 */
export function makeFeedbackNode(message: string): ExplorerNode {
  const node = new ExplorerNode(message, NodeType.Feedback, TreeItemCollapsibleState.None);
  node.iconPath = new ThemeIcon('loading~spin');
  node.contextValue = 'feedback';
  return node;
}
