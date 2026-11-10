/** Implements [SE-TREE], [SE-TREE-NAMESPACE-NEST], [SE-SORT], [SE-HOVER], and [SE-CONTEXT-MENUS]. */
import { fileNameOf } from './paths';
import {
  buildTree,
  buildSolutionChoiceNode,
  makeErrorNode,
  makeFeedbackNode,
} from './tree-build.js';
import { type ExplorerNode, NodeType } from './tree-nodes.js';
import {
  type CancellationToken,
  commands,
  type Event,
  EventEmitter,
  type Hover,
  MarkdownString,
  Position,
  type ProviderResult,
  type TreeItem,
  type TreeDataProvider,
  Uri,
} from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import * as log from './log.js';
import * as projectDeps from './project-deps-store.js';
import { buildNonSymbolTooltip } from './tree-tooltip.js';
import { type SolutionSelection } from './solution.js';
import * as state from './state.js';

// ── Tree data provider ───────────────────────────────────────────

export class SolutionExplorerProvider implements TreeDataProvider<ExplorerNode> {
  private readonly onDidChangeEmitter = new EventEmitter<ExplorerNode | undefined>();
  public readonly onDidChangeTreeData: Event<ExplorerNode | undefined> =
    this.onDidChangeEmitter.event;

  private roots: ExplorerNode[] = [];

  constructor() {
    state.symbolsState.subscribe(() => {
      this.rebuildTree();
    });
    state.sortOrder.subscribe(() => {
      this.rebuildTree();
    });
    state.nestNamespaces.subscribe(() => {
      this.rebuildTree();
    });
    state.loadPhase.subscribe(() => {
      this.rebuildTree();
    });
    projectDeps.projectDependencies.subscribe(() => {
      this.rebuildTree();
    });
    log.traceInfo('SolutionExplorerProvider: reactive subscriptions active');
  }

  /** Set initial context key for sort order toolbar icon. */
  public initSortContext(): void {
    void commands.executeCommand('setContext', 'sharplsp.sortOrder', state.sortOrder.value);
    state.sortOrder.subscribe((order) => {
      void commands.executeCommand('setContext', 'sharplsp.sortOrder', order);
    });
  }

  /** Cycle sort order: natural -> alphabetical -> accessibility -> natural. */
  public cycleSortOrder(): void {
    state.cycleSortOrder();
  }

  /** Load a solution and populate the tree. */
  public async loadSolution(solutionPath: string): Promise<void> {
    await state.loadSolution(solutionPath);
  }

  /** Set the LSP client for workspace symbol requests. */
  public setClient(client: LanguageClient): void {
    state.client.value = client;
    log.traceInfo('LSP client attached to state');
  }

  /** Clear the tree. */
  public clear(): void {
    state.clear();
  }

  /** Refresh tree data from the LSP. */
  public async refresh(): Promise<void> {
    await state.refresh();
  }

  /** Show discovered solutions as clickable items before one is loaded. */
  public showSolutionPicker(solutions: readonly SolutionSelection[]): void {
    this.roots = solutions.map((sol) => buildSolutionChoiceNode(sol));
    this.onDidChangeEmitter.fire(undefined);
  }

  public getTreeItem(element: ExplorerNode): TreeItem {
    return element;
  }

  public getChildren(element?: ExplorerNode): ProviderResult<ExplorerNode[]> {
    if (element === undefined) return this.roots;
    return element.children;
  }

  /**
   * Parent of a node, required by VS Code for `TreeView.reveal`. The whole
   * chain from any revealable node up to a solution root must resolve, or the
   * active-editor sync silently no-ops (issue #118).
   */
  public getParent(element: ExplorerNode): ProviderResult<ExplorerNode> {
    return element.parent;
  }

  /**
   * First tree node belonging to `uri` (a `file://` document URI), in document
   * order. Used to reveal/select the active editor's file in the tree. Returns
   * `undefined` when the file contributes no symbols. [SE-ACTIVE-EDITOR-SYNC]
   */
  public findNodeForUri(uri: string): ExplorerNode | undefined {
    return findFirstNodeForUri(this.roots, uri);
  }

  /** Resolve tooltip via LSP hover for symbols, instant for non-symbols. */
  public async resolveTreeItem(
    item: TreeItem,
    element: ExplorerNode,
    _token: CancellationToken,
  ): Promise<TreeItem> {
    const lspTooltip = await resolveSymbolTooltip(element);
    item.tooltip = lspTooltip ?? buildNonSymbolTooltip(element);
    return item;
  }

  private rebuildTree(): void {
    this.roots = currentRoots();
    this.onDidChangeEmitter.fire(undefined);
  }
}

/**
 * The tree the shared state currently calls for. [SE-LOADING-FEEDBACK]: while
 * solutions are being discovered or one is loading, a spinner node replaces
 * whatever the tree held — an empty tree reads as "broken", a stale tree reads
 * as "done".
 */
function currentRoots(): ExplorerNode[] {
  const phase = state.loadPhase.value;
  if (phase.kind !== 'idle') {
    const message =
      phase.kind === 'discovering'
        ? 'Searching for solutions…'
        : `Loading ${fileNameOf(phase.solutionPath)}…`;
    log.traceInfo(`Tree feedback: ${message}`);
    return [makeFeedbackNode(message)];
  }
  const symbols = state.symbolsState.value;
  const solution = state.solutionPath.value;
  if (symbols.kind === 'error') {
    log.traceInfo(`Tree error: ${symbols.message}`);
    return [makeErrorNode(symbols.message)];
  }
  if (symbols.kind === 'empty' || solution === undefined) return [];
  const order = state.sortOrder.value;
  const nest = state.nestNamespaces.value;
  log.traceInfo(
    `Rebuilding tree: ${String(symbols.response.projects.length)} projects, sort=${order}, nest=${String(nest)}`,
  );
  return buildTree(solution, symbols.response, order, nest);
}

/** Depth-first search for the first node whose `symbolUri` matches `uri`. */
function findFirstNodeForUri(
  nodes: readonly ExplorerNode[],
  uri: string,
): ExplorerNode | undefined {
  for (const node of nodes) {
    if (node.symbolUri === uri) return node;
    const found = findFirstNodeForUri(node.children, uri);
    if (found !== undefined) return found;
  }
  return undefined;
}

const SYMBOL_NODE_TYPES = new Set<string>([NodeType.Symbol, NodeType.Namespace]);

/** Resolve a tree node's tooltip via the same LSP hover used in the editor. */
async function resolveSymbolTooltip(node: ExplorerNode): Promise<MarkdownString | undefined> {
  if (!SYMBOL_NODE_TYPES.has(node.nodeType)) return undefined;
  if (node.symbolUri === undefined || node.symbolPosition === undefined) {
    return undefined;
  }

  try {
    const uri = Uri.parse(node.symbolUri);
    const pos = new Position(node.symbolPosition.line, node.symbolPosition.character);
    const hovers = await commands.executeCommand<Hover[]>('vscode.executeHoverProvider', uri, pos);
    if (hovers.length === 0) return undefined;

    return hoverToMarkdown(hovers);
  } catch (err) {
    log.traceInfo(`Tree hover failed: ${String(err)}`);
    return undefined;
  }
}

/** Merge all hover contents into a single MarkdownString. */
function hoverToMarkdown(hovers: Hover[]): MarkdownString | undefined {
  const parts: string[] = [];
  for (const hover of hovers) {
    for (const content of hover.contents) {
      if (typeof content === 'string') {
        parts.push(content);
      } else if (content instanceof MarkdownString) {
        parts.push(content.value);
      }
    }
  }
  if (parts.length === 0) return undefined;
  return new MarkdownString(parts.join('\n\n---\n\n'));
}
