import * as path from "node:path";
import {
    type CancellationToken,
    commands,
    type Event,
    EventEmitter,
    type Hover,
    MarkdownString,
    Position,
    type ProviderResult,
    Range,
    ThemeColor,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
    type TreeDataProvider,
    Uri,
} from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import * as log from "./log.js";
import * as deps from "./dependencies.js";
import {
    buildNonSymbolTooltip,
    SYMBOL_CONTEXT_VALUES,
} from "./tree-tooltip.js";
import * as state from "./state.js";
import {
    SortOrder,
    type FileSymbol,
    type LspPosition,
    type LspRange,
    type ProjectNode,
    type SymbolNode,
    type WorkspaceSymbolsResponse,
} from "./state.js";

// ── Tree item types ──────────────────────────────────────────────

const enum NodeType {
    Solution = "solution",
    Project = "project",
    Namespace = "namespace",
    Symbol = "symbol",
    DependencyFolder = "dependencyFolder",
    NuGetPackage = "nugetPackage",
    ProjectRef = "projectRef",
}

/** A node in the solution explorer tree. */
export class ExplorerNode extends TreeItem {
    public readonly nodeType: NodeType;
    public children: ExplorerNode[] = [];
    public sortName = "";
    public access?: string | undefined;
    public projectFilePath?: string;
    public referenceName?: string;
    public symbolUri?: string;
    public symbolPosition?: LspPosition;
    public symbolKind?: string;
    public symbolRange?: LspRange;
    public parent?: ExplorerNode;

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

type IconDef = readonly [icon: string, color: string];

const SYMBOL_ICONS: Record<string, IconDef> = {
    Class: ["symbol-class", "symbolIcon.classForeground"],
    Struct: ["symbol-struct", "symbolIcon.structForeground"],
    Interface: ["symbol-interface", "symbolIcon.interfaceForeground"],
    Enum: ["symbol-enum", "symbolIcon.enumeratorForeground"],
    EnumMember: ["symbol-enum-member", "symbolIcon.enumeratorMemberForeground"],
    Method: ["symbol-method", "symbolIcon.methodForeground"],
    Constructor: ["symbol-constructor", "symbolIcon.constructorForeground"],
    Property: ["symbol-property", "symbolIcon.propertyForeground"],
    Field: ["symbol-field", "symbolIcon.fieldForeground"],
    Event: ["symbol-event", "symbolIcon.eventForeground"],
    Namespace: ["symbol-namespace", "symbolIcon.namespaceForeground"],
    Function: ["symbol-method", "symbolIcon.functionForeground"],
    Constant: ["symbol-constant", "symbolIcon.constantForeground"],
};

function iconForKind(kind: string): ThemeIcon {
    const def = SYMBOL_ICONS[kind];
    if (def !== undefined) {
        return new ThemeIcon(def[0], new ThemeColor(def[1]));
    }
    return new ThemeIcon("symbol-misc");
}

// ── Tree data provider ───────────────────────────────────────────

export class SolutionExplorerProvider implements TreeDataProvider<ExplorerNode> {
    private readonly onDidChangeEmitter = new EventEmitter<
        ExplorerNode | undefined
    >();
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
        log.traceInfo(
            "SolutionExplorerProvider: reactive subscriptions active",
        );
    }

    /** Set initial context key for sort order toolbar icon. */
    public initSortContext(): void {
        void commands.executeCommand(
            "setContext",
            "forge.sortOrder",
            state.sortOrder.value,
        );
        state.sortOrder.subscribe((order) => {
            void commands.executeCommand(
                "setContext",
                "forge.sortOrder",
                order,
            );
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
        log.traceInfo("LSP client attached to state");
    }

    /** Clear the tree. */
    public clear(): void {
        state.clear();
    }

    /** Refresh tree data from the LSP. */
    public async refresh(): Promise<void> {
        await state.refresh();
    }

    public getTreeItem(element: ExplorerNode): TreeItem {
        return element;
    }

    public getChildren(element?: ExplorerNode): ProviderResult<ExplorerNode[]> {
        if (element === undefined) return this.roots;
        return element.children;
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
        const symbols = state.symbolsState.value;
        const solution = state.solutionPath.value;
        const order = state.sortOrder.value;

        if (symbols.kind === "error") {
            log.traceInfo(`Tree error: ${symbols.message}`);
            this.roots = [makeErrorNode(symbols.message)];
            this.onDidChangeEmitter.fire(undefined);
            return;
        }

        if (symbols.kind === "empty" || solution === undefined) {
            this.roots = [];
            this.onDidChangeEmitter.fire(undefined);
            return;
        }

        const projects = symbols.response.projects.length;
        log.traceInfo(
            `Rebuilding tree: ${String(projects)} projects, sort=${order}`,
        );
        this.roots = buildTree(solution, symbols.response, order);
        this.onDidChangeEmitter.fire(undefined);
    }
}

// ── Tree construction ────────────────────────────────────────────

function buildTree(
    solutionPath: string,
    response: WorkspaceSymbolsResponse,
    order: SortOrder,
): ExplorerNode[] {
    const name = path.basename(solutionPath);
    const node = new ExplorerNode(
        name,
        NodeType.Solution,
        TreeItemCollapsibleState.Expanded,
    );
    node.iconPath = new ThemeIcon(
        "package",
        new ThemeColor("terminal.ansiGreen"),
    );
    node.sortName = name;
    node.contextValue = "solution";
    node.children = response.projects.map(buildProjectNode);
    for (const project of node.children) {
        sortProjectChildren(project, order);
    }
    return [node];
}

function buildProjectNode(project: ProjectNode): ExplorerNode {
    const file = path.basename(project.path);
    const label = `${project.name} (${file})`;
    const node = new ExplorerNode(
        label,
        NodeType.Project,
        TreeItemCollapsibleState.Expanded,
    );
    node.iconPath = new ThemeIcon(
        "project",
        new ThemeColor("terminal.ansiCyan"),
    );
    node.sortName = project.name;
    node.contextValue = "project";
    const depFolder = buildDependencyFolder(project.path);
    const symbols = groupByNamespace(project.symbols);
    node.children = depFolder !== undefined ? [depFolder, ...symbols] : symbols;
    return node;
}

function buildDependencyFolder(projectPath: string): ExplorerNode | undefined {
    const parsed = deps.parseProjectDependencies(projectPath);
    const hasPackages = parsed.nugetPackages.length > 0;
    const hasProjects = parsed.projectReferences.length > 0;
    if (!hasPackages && !hasProjects) return undefined;

    const folder = new ExplorerNode(
        "Dependencies",
        NodeType.DependencyFolder,
        TreeItemCollapsibleState.Collapsed,
    );
    folder.iconPath = new ThemeIcon(
        "extensions",
        new ThemeColor("terminal.ansiYellow"),
    );
    folder.sortName = "";
    folder.contextValue = "dependencyFolder";
    if (hasPackages) {
        folder.children.push(
            buildPackageFolder(parsed.nugetPackages, projectPath),
        );
    }
    if (hasProjects) {
        folder.children.push(
            buildProjectRefFolder(parsed.projectReferences, projectPath),
        );
    }
    return folder;
}

function buildPackageFolder(
    packages: deps.NuGetPackage[],
    projectPath: string,
): ExplorerNode {
    const folder = new ExplorerNode(
        "Packages",
        NodeType.DependencyFolder,
        TreeItemCollapsibleState.Collapsed,
    );
    folder.iconPath = new ThemeIcon("package");
    folder.sortName = "0";
    folder.children = packages.map((pkg) => buildNuGetNode(pkg, projectPath));
    return folder;
}

function buildNuGetNode(
    pkg: deps.NuGetPackage,
    projectPath: string,
): ExplorerNode {
    const node = new ExplorerNode(
        pkg.name,
        NodeType.NuGetPackage,
        TreeItemCollapsibleState.None,
    );
    node.description = pkg.version;
    node.iconPath = new ThemeIcon(
        "package",
        new ThemeColor("terminal.ansiBlue"),
    );
    node.sortName = pkg.name;
    node.contextValue = "nugetPackage";
    node.projectFilePath = projectPath;
    node.referenceName = pkg.name;
    return node;
}

function buildProjectRefFolder(
    references: deps.ProjectReference[],
    projectPath: string,
): ExplorerNode {
    const folder = new ExplorerNode(
        "Projects",
        NodeType.DependencyFolder,
        TreeItemCollapsibleState.Collapsed,
    );
    folder.iconPath = new ThemeIcon(
        "project",
        new ThemeColor("terminal.ansiCyan"),
    );
    folder.sortName = "1";
    folder.children = references.map((ref) =>
        buildProjectRefNode(ref, projectPath),
    );
    return folder;
}

function buildProjectRefNode(
    ref: deps.ProjectReference,
    projectPath: string,
): ExplorerNode {
    const node = new ExplorerNode(
        ref.name,
        NodeType.ProjectRef,
        TreeItemCollapsibleState.None,
    );
    node.iconPath = new ThemeIcon(
        "project",
        new ThemeColor("terminal.ansiCyan"),
    );
    node.sortName = ref.name;
    node.contextValue = "projectReference";
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

function groupByNamespace(fileSymbols: FileSymbol[]): ExplorerNode[] {
    const namespaces = new Map<string, ExplorerNode[]>();
    const noNamespace: ExplorerNode[] = [];

    for (const file of fileSymbols) {
        for (const sym of file.symbols) {
            if (sym.kind === "Namespace") {
                mergeNamespace(namespaces, sym, file.file);
            } else {
                noNamespace.push(buildSymbolNode(sym, file.file));
            }
        }
    }

    return [...createNamespaceNodes(namespaces), ...noNamespace];
}

function mergeNamespace(
    namespaces: Map<string, ExplorerNode[]>,
    sym: SymbolNode,
    filePath: string,
): void {
    const children = buildSymbolChildren(sym.children, filePath);
    const existing = namespaces.get(sym.name);
    if (existing !== undefined) {
        existing.push(...children);
    } else {
        namespaces.set(sym.name, children);
    }
}

function createNamespaceNodes(
    namespaces: Map<string, ExplorerNode[]>,
): ExplorerNode[] {
    const nodes: ExplorerNode[] = [];
    for (const [name, children] of namespaces) {
        const node = new ExplorerNode(
            name,
            NodeType.Namespace,
            TreeItemCollapsibleState.Collapsed,
        );
        node.iconPath = new ThemeIcon(
            "symbol-namespace",
            new ThemeColor("symbolIcon.namespaceForeground"),
        );
        node.sortName = name;
        node.contextValue = "symbol.namespace";
        node.symbolKind = "Namespace";
        node.children = children;
        for (const child of children) {
            child.parent = node;
        }
        nodes.push(node);
    }
    return nodes;
}

function buildSymbolNode(sym: SymbolNode, filePath: string): ExplorerNode {
    const label =
        sym.detail !== null ? `${sym.name} : ${sym.detail}` : sym.name;
    const collapsible =
        sym.children.length > 0
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None;
    const node = new ExplorerNode(label, NodeType.Symbol, collapsible);
    node.iconPath = iconForKind(sym.kind);
    node.sortName = sym.name;
    node.symbolKind = sym.kind;
    node.symbolRange = sym.range;
    node.contextValue = SYMBOL_CONTEXT_VALUES[sym.kind] ?? "symbol.unknown";
    if (sym.access !== null) node.access = sym.access;
    if (filePath !== "") {
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

function attachGoToCommand(
    node: ExplorerNode,
    filePath: string,
    range: LspRange,
): void {
    const pos = new Position(range.start.line, range.start.character);
    node.command = {
        title: "Go to Symbol",
        command: "vscode.open",
        arguments: [Uri.file(filePath), { selection: new Range(pos, pos) }],
    };
}

function buildSymbolChildren(
    children: SymbolNode[],
    filePath: string,
): ExplorerNode[] {
    return children.map((child) => buildSymbolNode(child, filePath));
}

// ── LSP hover for tree items ─────────────────────────────────────

const SYMBOL_NODE_TYPES = new Set<string>([
    NodeType.Symbol,
    NodeType.Namespace,
]);

/** Resolve a tree node's tooltip via the same LSP hover used in the editor. */
async function resolveSymbolTooltip(
    node: ExplorerNode,
): Promise<MarkdownString | undefined> {
    if (!SYMBOL_NODE_TYPES.has(node.nodeType)) return undefined;
    if (node.symbolUri === undefined || node.symbolPosition === undefined) {
        return undefined;
    }

    try {
        const uri = Uri.parse(node.symbolUri);
        const pos = new Position(
            node.symbolPosition.line,
            node.symbolPosition.character,
        );
        const hovers = await commands.executeCommand<Hover[]>(
            "vscode.executeHoverProvider",
            uri,
            pos,
        );
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
            if (typeof content === "string") {
                parts.push(content);
            } else if (content instanceof MarkdownString) {
                parts.push(content.value);
            }
        }
    }
    if (parts.length === 0) return undefined;
    return new MarkdownString(parts.join("\n\n---\n\n"));
}

// ── Qualified name ───────────────────────────────────────────────

/** Walk the tree upward to build a fully-qualified name. */
export function buildQualifiedName(node: ExplorerNode): string {
    const parts: string[] = [node.sortName];
    let current = node.parent;
    while (current !== undefined) {
        if (
            current.nodeType === NodeType.Namespace ||
            current.nodeType === NodeType.Symbol
        ) {
            parts.unshift(current.sortName);
        }
        current = current.parent;
    }
    return parts.join(".");
}

// ── Sorting ──────────────────────────────────────────────────────

const ACCESS_PRIORITY: Record<string, number> = {
    public: 0,
    "internal protected": 1,
    "protected internal": 1,
    internal: 2,
    protected: 3,
    "private protected": 4,
    "protected private": 4,
    private: 5,
};

function accessPriority(access: string | undefined): number {
    if (access === undefined) return 6;
    return ACCESS_PRIORITY[access] ?? 6;
}

function applySortOrder(nodes: ExplorerNode[], order: SortOrder): void {
    if (order === SortOrder.Natural) return;

    if (order === SortOrder.Alphabetical) {
        nodes.sort((a, b) => a.sortName.localeCompare(b.sortName));
    } else {
        nodes.sort((a, b) => {
            const diff = accessPriority(a.access) - accessPriority(b.access);
            return diff !== 0 ? diff : a.sortName.localeCompare(b.sortName);
        });
    }

    for (const node of nodes) {
        if (node.children.length > 0) {
            applySortOrder(node.children, order);
        }
    }
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
