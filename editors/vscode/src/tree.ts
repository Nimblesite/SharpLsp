import * as path from "node:path";
import {
  type Event,
  EventEmitter,
  type ProviderResult,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  type TreeDataProvider,
  Uri,
} from "vscode";
import { type LanguageClient, State } from "vscode-languageclient/node";
import * as log from "./log.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

// ── LSP response types ───────────────────────────────────────────

interface WorkspaceSymbolsResponse {
  readonly projects: ProjectNode[];
}

interface ProjectNode {
  readonly name: string;
  readonly path: string;
  readonly symbols: FileSymbol[];
}

interface FileSymbol {
  readonly file: string;
  readonly symbols: SymbolNode[];
}

interface SymbolNode {
  readonly name: string;
  readonly kind: string;
  readonly detail: string | null;
  readonly range: LspRange;
  readonly children: SymbolNode[];
}

interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

interface LspPosition {
  readonly line: number;
  readonly character: number;
}

// ── Tree item types ──────────────────────────────────────────────

const enum NodeType {
  Solution = "solution",
  Project = "project",
  Namespace = "namespace",
  Symbol = "symbol",
}

/** A node in the solution explorer tree. */
export class ExplorerNode extends TreeItem {
  readonly nodeType: NodeType;
  readonly filePath?: string;
  readonly range?: LspRange;
  children: ExplorerNode[] = [];

  constructor(
    label: string,
    nodeType: NodeType,
    collapsible: TreeItemCollapsibleState,
  ) {
    super(label, collapsible);
    this.nodeType = nodeType;
  }
}

// ── Icon mapping ─────────────────────────────────────────────────

const SYMBOL_ICONS: Record<string, string> = {
  Class: "symbol-class",
  Struct: "symbol-struct",
  Interface: "symbol-interface",
  Enum: "symbol-enum",
  EnumMember: "symbol-enum-member",
  Method: "symbol-method",
  Constructor: "symbol-constructor",
  Property: "symbol-property",
  Field: "symbol-field",
  Event: "symbol-event",
  Namespace: "symbol-namespace",
  Function: "symbol-method",
  Constant: "symbol-constant",
};

function iconForKind(kind: string): ThemeIcon {
  const iconId = SYMBOL_ICONS[kind] ?? "symbol-misc";
  return new ThemeIcon(iconId);
}

// ── Tree data provider ───────────────────────────────────────────

export class SolutionExplorerProvider implements TreeDataProvider<ExplorerNode> {
  private readonly onDidChangeEmitter = new EventEmitter<
    ExplorerNode | undefined
  >();
  readonly onDidChangeTreeData: Event<ExplorerNode | undefined> =
    this.onDidChangeEmitter.event;

  private roots: ExplorerNode[] = [];
  private client: LanguageClient | undefined;
  private solutionPath: string | undefined;

  setClient(client: LanguageClient): void {
    this.client = client;
  }

  /** Load a solution and populate the tree. */
  async loadSolution(solutionPath: string): Promise<void> {
    this.solutionPath = solutionPath;
    await this.refresh();
  }

  /** Clear the tree. */
  clear(): void {
    this.solutionPath = undefined;
    this.roots = [];
    this.onDidChangeEmitter.fire(undefined);
  }

  /** Refresh tree data from the LSP, retrying on transient failures. */
  async refresh(): Promise<void> {
    if (this.client === undefined || this.solutionPath === undefined) {
      this.roots = [];
      this.onDidChangeEmitter.fire(undefined);
      return;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.client.state !== State.Running) {
        log.info(
          `LSP client not running (state=${String(this.client.state)}), ` +
          `waiting before retry ${String(attempt + 1)}/${String(MAX_RETRIES)}…`,
        );
        await delay(RETRY_DELAY_MS);
        continue;
      }

      try {
        const response = await this.client.sendRequest<WorkspaceSymbolsResponse>(
          "forge/workspaceSymbols",
          { solution: this.solutionPath },
        );
        this.roots = buildTree(this.solutionPath, response);
        this.onDidChangeEmitter.fire(undefined);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient = msg.includes("disposed") || msg.includes("connection");
        if (isTransient && attempt < MAX_RETRIES) {
          log.info(
            `Workspace symbols request failed (attempt ${String(attempt + 1)}/${String(MAX_RETRIES)}): ${msg}. Retrying…`,
          );
          await delay(RETRY_DELAY_MS);
          continue;
        }
        log.info(`Failed to load workspace symbols: ${msg}`);
        this.roots = [makeErrorNode(msg)];
      }
    }

    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(element: ExplorerNode): TreeItem {
    return element;
  }

  getChildren(element?: ExplorerNode): ProviderResult<ExplorerNode[]> {
    if (element === undefined) {
      return this.roots;
    }
    return element.children;
  }
}

// ── Tree construction ────────────────────────────────────────────

function buildTree(
  solutionPath: string,
  response: WorkspaceSymbolsResponse,
): ExplorerNode[] {
  const solutionName = path.basename(solutionPath);
  const solutionNode = new ExplorerNode(
    solutionName,
    NodeType.Solution,
    TreeItemCollapsibleState.Expanded,
  );
  solutionNode.iconPath = new ThemeIcon("package");

  solutionNode.children = response.projects.map((project) =>
    buildProjectNode(project),
  );

  return [solutionNode];
}

function buildProjectNode(project: ProjectNode): ExplorerNode {
  const projectFile = path.basename(project.path);
  const label = `${project.name} (${projectFile})`;
  const node = new ExplorerNode(
    label,
    NodeType.Project,
    TreeItemCollapsibleState.Expanded,
  );
  node.iconPath = new ThemeIcon("project");

  // Group symbols by namespace.
  const namespaces = new Map<string, ExplorerNode[]>();
  const noNamespace: ExplorerNode[] = [];

  for (const file of project.symbols) {
    for (const sym of file.symbols) {
      if (sym.kind === "Namespace") {
        const nsChildren = buildSymbolChildren(sym.children, file.file);
        const existing = namespaces.get(sym.name);
        if (existing !== undefined) {
          existing.push(...nsChildren);
        } else {
          namespaces.set(sym.name, nsChildren);
        }
      } else {
        noNamespace.push(buildSymbolNode(sym, file.file));
      }
    }
  }

  // Create namespace nodes.
  const children: ExplorerNode[] = [];
  for (const [nsName, nsChildren] of namespaces) {
    const nsNode = new ExplorerNode(
      nsName,
      NodeType.Namespace,
      TreeItemCollapsibleState.Collapsed,
    );
    nsNode.iconPath = new ThemeIcon("symbol-namespace");
    nsNode.children = nsChildren;
    children.push(nsNode);
  }

  children.push(...noNamespace);
  node.children = children;
  return node;
}

function buildSymbolNode(sym: SymbolNode, filePath: string): ExplorerNode {
  const label = sym.detail !== null ? `${sym.name} : ${sym.detail}` : sym.name;
  const hasChildren = sym.children.length > 0;
  const node = new ExplorerNode(
    label,
    NodeType.Symbol,
    hasChildren
      ? TreeItemCollapsibleState.Collapsed
      : TreeItemCollapsibleState.None,
  );
  node.iconPath = iconForKind(sym.kind);

  if (filePath !== "") {
    node.command = {
      title: "Go to Symbol",
      command: "vscode.open",
      arguments: [
        Uri.file(filePath),
        {
          selection: {
            startLineNumber: sym.range.start.line + 1,
            startColumn: sym.range.start.character + 1,
            endLineNumber: sym.range.start.line + 1,
            endColumn: sym.range.start.character + 1,
          },
        },
      ],
    };
  }

  node.children = buildSymbolChildren(sym.children, filePath);
  return node;
}

function buildSymbolChildren(
  children: SymbolNode[],
  filePath: string,
): ExplorerNode[] {
  return children.map((child) => buildSymbolNode(child, filePath));
}

function makeErrorNode(message: string): ExplorerNode {
  const node = new ExplorerNode(
    `Error: ${message}`,
    NodeType.Symbol,
    TreeItemCollapsibleState.None,
  );
  node.iconPath = new ThemeIcon("error");
  return node;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
