import { MarkdownString } from "vscode";
import { type ExplorerNode } from "./tree.js";

// ── Tooltip ──────────────────────────────────────────────────────

/** Context values for tree item menus, keyed by symbol kind. */
export const SYMBOL_CONTEXT_VALUES: Record<string, string> = {
    Class: "symbol.class",
    Struct: "symbol.struct",
    Interface: "symbol.interface",
    Enum: "symbol.enum",
    Record: "symbol.record",
    Method: "symbol.method",
    Constructor: "symbol.constructor",
    Property: "symbol.property",
    Field: "symbol.field",
    Event: "symbol.event",
    Constant: "symbol.constant",
    EnumMember: "symbol.enumMember",
    Namespace: "symbol.namespace",
    Function: "symbol.delegate",
};

/**
 * Build a tooltip for non-symbol nodes (NuGet packages, project refs).
 * Symbol nodes use the LSP hover provider (same as code editor hover).
 */
export function buildNonSymbolTooltip(
    node: ExplorerNode,
): MarkdownString | undefined {
    const nodeType: string = node.nodeType;

    if (nodeType === "nugetPackage") {
        const version =
            typeof node.description === "string" ? node.description : "";
        return new MarkdownString(
            `**NuGet Package**\n\n\`${node.sortName}\` ${version}`,
        );
    }

    if (nodeType === "projectRef") {
        return new MarkdownString(
            `**Project Reference**\n\n\`${node.sortName}\``,
        );
    }

    return undefined;
}
