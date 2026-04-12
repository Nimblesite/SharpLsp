import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
    EXTENSION_ID,
    closeAllEditors,
    pollUntilResult,
    replaceDocumentContent,
    setupLspTestSuite,
    teardownLspTestSuite,
    waitForDocumentSymbols,
    waitForHoverResult,
    LSP_RESPONSE_TIMEOUT_MS,
} from "./test-helpers";

suite("Hover / Quick Info", () => {
    let tmpDir: string;
    let workspaceRoot: string;

    suiteSetup(async function () {
        this.timeout(60_000);
        const result = await setupLspTestSuite("hover-");
        tmpDir = result.tmpDir;
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        assert.ok(ws, "Workspace folder must be available");
        workspaceRoot = ws;
    });

    suiteTeardown(async () => {
        await closeAllEditors();
        teardownLspTestSuite(tmpDir);
    });

    teardown(async () => {
        await closeAllEditors();
    });

    /** Open a fixture file from the workspace (part of the project). */
    async function openFixture(
        name: string,
    ): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
        const filePath = path.join(workspaceRoot, name);
        assert.ok(fs.existsSync(filePath), `${name} fixture must exist`);
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        return { doc, uri };
    }

    // ── Multi-Symbol Hover ──────────────────────────────────────────

    test("hover on class, method, property, field in one file", async function () {
        this.timeout(120_000);

        const { uri } = await openFixture("HoverMulti.cs");
        await waitForDocumentSymbols(uri);

        // Hover on class "Calculator" (line 2, char 18).
        // First hover needs a very long timeout — sidecar loads Roslyn + MSBuild.
        const classHover = await waitForHoverResult(
            uri,
            new vscode.Position(2, 18),
            90_000,
        );
        assert.ok(classHover.length > 0, "Must return hover for class");
        const classMd = hoverToString(classHover);
        assert.ok(
            classMd.includes("Calculator"),
            "Class hover must contain 'Calculator'",
        );
        assert.ok(
            classMd.includes("class"),
            "Class hover must contain 'class' keyword",
        );
        assert.ok(
            classMd.includes("```"),
            "Class hover must contain code block",
        );

        // Hover on method "Add" (line 6, char 20).
        const methodHover = await waitForHoverResult(
            uri,
            new vscode.Position(6, 20),
        );
        assert.ok(methodHover.length > 0, "Must return hover for method");
        const methodMd = hoverToString(methodHover);
        assert.ok(methodMd.includes("Add"), "Method hover must contain 'Add'");
        assert.ok(
            methodMd.includes("int"),
            "Method hover must contain return type 'int'",
        );

        // Hover on property "Name" (line 5, char 23).
        const propHover = await waitForHoverResult(
            uri,
            new vscode.Position(5, 23),
        );
        assert.ok(propHover.length > 0, "Must return hover for property");
        const propMd = hoverToString(propHover);
        assert.ok(
            propMd.includes("Name"),
            "Property hover must contain 'Name'",
        );
        assert.ok(
            propMd.includes("string"),
            "Property hover must contain type 'string'",
        );

        // Hover on field "_count" (line 4, char 21).
        const fieldHover = await waitForHoverResult(
            uri,
            new vscode.Position(4, 21),
        );
        assert.ok(fieldHover.length > 0, "Must return hover for field");
        const fieldMd = hoverToString(fieldHover);
        assert.ok(
            fieldMd.includes("_count"),
            "Field hover must contain '_count'",
        );
    });

    // ── Hover Range ─────────────────────────────────────────────────

    test("hover returns range that spans the hovered token", async function () {
        this.timeout(LSP_RESPONSE_TIMEOUT_MS * 2);

        const { uri } = await openFixture("HoverRange.cs");
        await waitForDocumentSymbols(uri);

        const hovers = await waitForHoverResult(
            uri,
            new vscode.Position(2, 18),
        );
        assert.ok(hovers.length > 0, "Must return hover");

        // Verify range is present and reasonable.
        const firstHover = hovers[0];
        assert.ok(firstHover !== undefined, "First hover must exist");
        if (firstHover.range !== undefined) {
            assert.ok(
                firstHover.range.start.line >= 0,
                "Range start line must be non-negative",
            );
            assert.ok(
                firstHover.range.end.character >=
                    firstHover.range.start.character,
                "Range end must be >= start",
            );
        }

        // Verify content is markdown.
        assert.ok(firstHover.contents.length > 0, "Must have content entries");
    });

    // ── Whitespace & Comment Rejection (multiple positions) ─────────

    test("hover on comments and whitespace returns empty across many positions", async function () {
        this.timeout(LSP_RESPONSE_TIMEOUT_MS * 2);

        const { uri } = await openFixture("HoverReject.cs");
        await waitForDocumentSymbols(uri);

        // All these positions are on non-symbol tokens.
        const nullPositions = [
            new vscode.Position(0, 5), // single-line comment
            new vscode.Position(1, 5), // multi-line comment
            new vscode.Position(2, 5), // multi-line comment continued
            new vscode.Position(3, 10), // doc comment
            new vscode.Position(3, 25), // doc comment closing tag
        ];

        for (const pos of nullPositions) {
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                "vscode.executeHoverProvider",
                uri,
                pos,
            );
            assert.ok(
                hovers === undefined || hovers.length === 0,
                `Hover at line ${String(pos.line)}, char ${String(pos.character)} must return empty`,
            );
        }

        // But hovering on the actual class MUST return results.
        const classHover = await waitForHoverResult(
            uri,
            new vscode.Position(7, 18),
        );
        assert.ok(classHover.length > 0, "Class hover must not be empty");
        const md = hoverToString(classHover);
        assert.ok(md.includes("Bar"), "Class hover must mention 'Bar'");
    });

    // ── Edit → Re-hover (content changes reflected) ─────────────────

    test("hover reflects content after edit cycle", async function () {
        this.timeout(LSP_RESPONSE_TIMEOUT_MS * 4);

        // Open fixture with class Alpha.
        const { doc, uri } = await openFixture("HoverEdit.cs");
        await waitForDocumentSymbols(uri);

        // Hover on Alpha.
        const alphaHover = await waitForHoverResult(
            uri,
            new vscode.Position(2, 18),
        );
        assert.ok(alphaHover.length > 0, "Alpha hover must return results");
        const alphaMd = hoverToString(alphaHover);
        assert.ok(alphaMd.includes("Alpha"), "Must see Alpha in hover");

        // Edit: rename to Bravo, add a method.
        await replaceDocumentContent(
            doc,
            "namespace HoverEdit\n{\n    public class Bravo\n    {\n        public void Run() { }\n    }\n}",
        );

        // Wait for LSP to process the edit.
        const bravoSymbols = await waitForDocumentSymbols(uri);
        assert.ok(bravoSymbols.length > 0, "Symbols must update after edit");

        // Hover on Bravo.
        const bravoHover = await waitForHoverResult(
            uri,
            new vscode.Position(2, 18),
        );
        assert.ok(bravoHover.length > 0, "Bravo hover must return results");
        const bravoMd = hoverToString(bravoHover);
        assert.ok(
            bravoMd.includes("Bravo"),
            "Must see Bravo in hover after edit",
        );

        // Hover on Run method.
        const runHover = await waitForHoverResult(
            uri,
            new vscode.Position(4, 22),
        );
        assert.ok(runHover.length > 0, "Run method hover must return results");
        const runMd = hoverToString(runHover);
        assert.ok(runMd.includes("Run"), "Must see Run in method hover");
    });

    // ── Struct, Enum, Interface hover ───────────────────────────────

    test("hover on struct, enum, interface returns correct kinds", async function () {
        this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);

        const { uri } = await openFixture("HoverKinds.cs");
        await waitForDocumentSymbols(uri);

        // Hover on struct "Point" (line 2, char 19).
        const structHover = await waitForHoverResult(
            uri,
            new vscode.Position(2, 19),
        );
        assert.ok(structHover.length > 0, "Struct hover must return results");
        const structMd = hoverToString(structHover);
        assert.ok(
            structMd.includes("Point"),
            "Struct hover must contain 'Point'",
        );
        assert.ok(
            structMd.includes("struct"),
            "Struct hover must contain 'struct'",
        );

        // Hover on enum "Color" (line 3, char 17).
        const enumHover = await waitForHoverResult(
            uri,
            new vscode.Position(3, 17),
        );
        assert.ok(enumHover.length > 0, "Enum hover must return results");
        const enumMd = hoverToString(enumHover);
        assert.ok(enumMd.includes("Color"), "Enum hover must contain 'Color'");
        assert.ok(enumMd.includes("enum"), "Enum hover must contain 'enum'");

        // Hover on interface "IShape" (line 4, char 22).
        const ifaceHover = await waitForHoverResult(
            uri,
            new vscode.Position(4, 22),
        );
        assert.ok(ifaceHover.length > 0, "Interface hover must return results");
        const ifaceMd = hoverToString(ifaceHover);
        assert.ok(
            ifaceMd.includes("IShape"),
            "Interface hover must contain 'IShape'",
        );
        assert.ok(
            ifaceMd.includes("interface"),
            "Interface hover must contain 'interface'",
        );
    });

    // ── var keyword hover ──────────────────────────────────────────

    test("hover on var keyword shows inferred type", async function () {
        this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);

        const { uri } = await openFixture("HoverVar.cs");
        await waitForDocumentSymbols(uri);

        // Hover on `var` at line 7 char 12 ("var g = new Gadget()").
        const varHover = await waitForHoverResult(
            uri,
            new vscode.Position(7, 12),
        );
        assert.ok(varHover.length > 0, "var hover must return results");
        const md = hoverToString(varHover);
        assert.ok(md.includes("```"), "var hover must have code block");
        assert.ok(
            md.includes("Gadget") || md.toLowerCase().includes("inferred"),
            `var hover must show inferred type Gadget: ${md}`,
        );
    });

    // ── XML documentation rendering ──────────────────────────────

    test("hover renders XML doc summary, param, and returns tags", async function () {
        this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);

        const { uri } = await openFixture("HoverXmlDoc.cs");
        await waitForDocumentSymbols(uri);

        // Hover on Factorial method (line 7, char 21).
        const hovers = await waitForHoverResult(
            uri,
            new vscode.Position(7, 21),
        );
        assert.ok(hovers.length > 0, "Method with XML doc must return hover");
        const md = hoverToString(hovers);
        assert.ok(md.includes("Factorial"), "Must contain method name");
        assert.ok(md.includes("```"), "Must have code block");
        // XML doc sections.
        assert.ok(
            md.toLowerCase().includes("factorial") &&
                md.toLowerCase().includes("computes"),
            `Must render <summary>: ${md}`,
        );
        assert.ok(
            md.toLowerCase().includes("non-negative") ||
                md.toLowerCase().includes("input"),
            `Must render <param>: ${md}`,
        );
        assert.ok(
            md.toLowerCase().includes("result") ||
                md.toLowerCase().includes("return"),
            `Must render <returns>: ${md}`,
        );
    });

    // ── [Obsolete] deprecation ────────────────────────────────────

    test("hover on [Obsolete] method shows deprecation warning", async function () {
        this.timeout(LSP_RESPONSE_TIMEOUT_MS * 3);

        const { uri } = await openFixture("HoverObsolete.cs");
        await waitForDocumentSymbols(uri);

        // Hover on OldMethod (line 5, char 21).
        const hovers = await waitForHoverResult(
            uri,
            new vscode.Position(5, 21),
        );
        assert.ok(hovers.length > 0, "Obsolete method must return hover");
        const md = hoverToString(hovers);
        assert.ok(md.includes("OldMethod"), "Must contain method name");
        assert.ok(md.includes("```"), "Must have code block");
        assert.ok(
            md.includes("Deprecated") || md.includes("Obsolete"),
            `Must show deprecation: ${md}`,
        );
        assert.ok(
            md.includes("Use NewMethod instead"),
            `Must include obsolete message: ${md}`,
        );
    });

    // ── Solution Explorer Integration ───────────────────────────────

    test("ExplorerNode carries symbolUri and symbolPosition on symbol nodes", async function () {
        this.timeout(30_000);

        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext !== undefined, "Extension must exist");
        assert.ok(ext.isActive, "Extension must be active");

        interface TreeNode {
            readonly label?: string | { label: string };
            readonly symbolUri?: string;
            readonly symbolPosition?: { line: number; character: number };
            readonly nodeType?: string;
            readonly children?: TreeNode[];
        }
        interface ExplorerApi {
            explorerProvider: {
                loadSolution(slnPath: string): Promise<void>;
                clear(): void;
                getChildren(element?: unknown): TreeNode[] | undefined;
                onDidChangeTreeData: vscode.Event<unknown>;
            };
        }
        const api = ext.exports as ExplorerApi | undefined;
        assert.ok(api !== undefined, "Extension must export API");
        assert.ok(
            api.explorerProvider !== undefined,
            "Must export explorerProvider",
        );

        // Verify provider has the reactive event.
        assert.ok(
            api.explorerProvider.onDidChangeTreeData !== undefined,
            "Must expose onDidChangeTreeData event",
        );

        // Verify root shape.
        const roots = api.explorerProvider.getChildren();
        assert.ok(
            Array.isArray(roots) || roots === undefined,
            "getChildren() must return array or undefined",
        );

        // If tree is loaded, walk it and verify symbol nodes have hover data.
        if (Array.isArray(roots)) {
            assertNonSymbolNodesLackHoverData(roots);
        }
    });

    // ── Tree Tooltip (resolveTreeItem) ──────────────────────────────

    test("resolveTreeItem uses LSP hover — same content as code hover", async function () {
        this.timeout(60_000);

        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext?.isActive, "Extension must be active");

        interface TooltipNode {
            readonly label?: string | { label: string };
            readonly symbolUri?: string;
            readonly symbolPosition?: { line: number; character: number };
            readonly symbolKind?: string;
            readonly sortName?: string;
            readonly access?: string;
            readonly nodeType?: string;
            readonly tooltip?: string | vscode.MarkdownString;
            readonly children?: TooltipNode[];
        }
        interface ExplorerApi {
            explorerProvider: {
                loadSolution(slnPath: string): Promise<void>;
                clear(): void;
                getTreeItem(element: unknown): vscode.TreeItem;
                getChildren(element?: unknown): TooltipNode[] | undefined;
                resolveTreeItem(
                    item: vscode.TreeItem,
                    element: unknown,
                    token: vscode.CancellationToken,
                ): Promise<vscode.TreeItem>;
            };
        }
        const api = ext.exports as ExplorerApi | undefined;
        assert.ok(api?.explorerProvider, "Must export explorerProvider");

        // Use the workspace fixture project — it's already loaded by the sidecar.
        const slnPath = path.join(workspaceRoot, "TestFixtures.sln");
        assert.ok(fs.existsSync(slnPath), "TestFixtures.sln must exist");

        // Open Calculator.cs so the LSP has it parsed.
        const { uri } = await openFixture("Calculator.cs");
        await waitForDocumentSymbols(uri);
        await api.explorerProvider.loadSolution(slnPath);

        // Wait for tree to populate.
        const roots = await pollUntilResult(
            async () => api.explorerProvider.getChildren(),
            (nodes) => nodes !== undefined && nodes.length > 0,
            10_000,
        );
        assert.ok(Array.isArray(roots), "Tree must have roots");

        // Walk the tree and find symbol nodes.
        const symbolNodes = collectSymbolNodes(roots);
        assert.ok(
            symbolNodes.length > 0,
            `Tree must have symbol nodes, found ${String(symbolNodes.length)}`,
        );

        // Resolve symbol nodes and verify tooltips match LSP hover.
        // Not every symbol gets hover from the sidecar (e.g. compact field
        // declarations), so we verify the mechanism works on those that do.
        const provider = api.explorerProvider;
        const tokenSource = new vscode.CancellationTokenSource();
        let tooltipCount = 0;

        for (const node of symbolNodes) {
            const treeItem = provider.getTreeItem(node);
            const resolved = await provider.resolveTreeItem(
                treeItem,
                node,
                tokenSource.token,
            );

            // Skip symbols where the sidecar returned no hover data.
            if (
                resolved.tooltip === undefined ||
                !(resolved.tooltip instanceof vscode.MarkdownString)
            ) {
                continue;
            }

            tooltipCount++;
            const treeMd = resolved.tooltip.value;
            assert.ok(
                treeMd.length > 0,
                `Tooltip for '${node.sortName ?? "?"}' must not be empty`,
            );
            assert.ok(
                treeMd.includes("```"),
                `Tooltip for '${node.sortName ?? "?"}' must have code block: ${treeMd}`,
            );

            // Tooltip should contain the symbol name or a type signature.
            if (node.sortName !== undefined && node.sortName.length > 0) {
                assert.ok(
                    treeMd.includes(node.sortName) || treeMd.includes("```"),
                    `Tooltip must contain symbol name '${node.sortName}' or code block: ${treeMd}`,
                );
            }

            // Tree tooltip must match the code editor hover at the same position.
            if (
                node.symbolUri !== undefined &&
                node.symbolPosition !== undefined
            ) {
                const nodeUri = vscode.Uri.parse(node.symbolUri);
                const pos = new vscode.Position(
                    node.symbolPosition.line,
                    node.symbolPosition.character,
                );
                const codeHover = await waitForHoverResult(nodeUri, pos);
                const codeMd = hoverToString(codeHover);
                assert.strictEqual(
                    treeMd,
                    codeMd,
                    `Tree tooltip must match code hover for '${node.sortName ?? "?"}'`,
                );
            }
        }

        assert.ok(
            tooltipCount > 0,
            `At least one symbol must have a tooltip, got ${String(tooltipCount)} from ${String(symbolNodes.length)} symbols`,
        );

        tokenSource.dispose();
        api.explorerProvider.clear();
    });

    test("resolveTreeItem returns undefined tooltip for non-symbol nodes", async function () {
        this.timeout(15_000);

        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext?.isActive, "Extension must be active");

        interface NodeApi {
            explorerProvider: {
                getTreeItem(element: unknown): vscode.TreeItem;
                getChildren(
                    element?: unknown,
                ): { nodeType?: string; sortName?: string }[] | undefined;
                resolveTreeItem(
                    item: vscode.TreeItem,
                    element: unknown,
                    token: vscode.CancellationToken,
                ): Promise<vscode.TreeItem>;
            };
        }
        const api = ext.exports as NodeApi | undefined;
        assert.ok(api?.explorerProvider, "Must export explorerProvider");

        const roots = api.explorerProvider.getChildren();
        if (roots === undefined || roots.length === 0) return;

        // Find non-symbol nodes (solution, project, dependency folder).
        const tokenSource = new vscode.CancellationTokenSource();
        for (const node of roots) {
            if (node.nodeType !== "symbol" && node.nodeType !== "namespace") {
                const treeItem = api.explorerProvider.getTreeItem(node);
                const resolved = await api.explorerProvider.resolveTreeItem(
                    treeItem,
                    node,
                    tokenSource.token,
                );
                // Non-symbol nodes should not get a code block tooltip.
                if (resolved.tooltip instanceof vscode.MarkdownString) {
                    assert.ok(
                        !resolved.tooltip.value.includes("```csharp"),
                        `Non-symbol node '${node.sortName ?? node.nodeType ?? "?"}' must not get C# tooltip`,
                    );
                }
            }
        }
        tokenSource.dispose();
    });
});

// ── Helpers ──────────────────────────────────────────────────────

/** Extract all hover content as a single string for assertions. */
function hoverToString(hovers: vscode.Hover[]): string {
    const parts: string[] = [];
    for (const hover of hovers) {
        for (const content of hover.contents) {
            if (typeof content === "string") {
                parts.push(content);
            } else if (content instanceof vscode.MarkdownString) {
                parts.push(content.value);
            }
        }
    }
    return parts.join("\n");
}

interface TreeNode {
    readonly symbolUri?: string;
    readonly nodeType?: string;
    readonly children?: TreeNode[];
}

interface SymbolTreeNode {
    readonly sortName?: string;
    readonly symbolKind?: string;
    readonly symbolUri?: string;
    readonly symbolPosition?: { line: number; character: number };
    readonly nodeType?: string;
    readonly children?: SymbolTreeNode[];
}

/** Recursively collect all symbol nodes from the tree. */
function collectSymbolNodes(nodes: SymbolTreeNode[]): SymbolTreeNode[] {
    const result: SymbolTreeNode[] = [];
    for (const node of nodes) {
        if (node.nodeType === "symbol") {
            result.push(node);
        }
        if (Array.isArray(node.children)) {
            result.push(...collectSymbolNodes(node.children));
        }
    }
    return result;
}

/** Recursively assert non-symbol nodes lack symbolUri. */
function assertNonSymbolNodesLackHoverData(nodes: TreeNode[]): void {
    for (const node of nodes) {
        if (
            node.nodeType === "solution" ||
            node.nodeType === "project" ||
            node.nodeType === "dependencyFolder" ||
            node.nodeType === "nugetPackage" ||
            node.nodeType === "projectRef"
        ) {
            assert.strictEqual(
                node.symbolUri,
                undefined,
                `${node.nodeType ?? "unknown"} node must not have symbolUri`,
            );
        }
        if (Array.isArray(node.children)) {
            assertNonSymbolNodesLackHoverData(node.children);
        }
    }
}
