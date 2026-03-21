import { MarkdownString } from "vscode";
import { type ExplorerNode, buildQualifiedName } from "./tree.js";

// ── Tooltip ──────────────────────────────────────────────────────

/** Map symbol kind to a C# keyword for the tooltip signature line. */
const KIND_KEYWORD: Record<string, string> = {
  Class: "class",
  Struct: "struct",
  Interface: "interface",
  Enum: "enum",
  Record: "record",
  Method: "method",
  Constructor: "constructor",
  Property: "property",
  Field: "field",
  Event: "event",
  Namespace: "namespace",
  Function: "delegate",
  Constant: "const",
  EnumMember: "enum member",
};

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

/** Node types that get symbol-style code block tooltips. */
const SYMBOL_NODE_TYPES = new Set(["symbol", "namespace"]);

/** Build a rich Markdown tooltip from cached node metadata — instant. */
export function buildTooltip(
  node: ExplorerNode,
): MarkdownString | undefined {
  const nodeType: string = node.nodeType;

  if (nodeType === "nugetPackage") {
    const version = typeof node.description === "string"
      ? node.description
      : "";
    return new MarkdownString(
      `**NuGet Package**\n\n\`${node.sortName}\` ${version}`,
    );
  }

  if (nodeType === "projectRef") {
    return new MarkdownString(
      `**Project Reference**\n\n\`${node.sortName}\``,
    );
  }

  if (!SYMBOL_NODE_TYPES.has(nodeType)) {
    return undefined;
  }

  const kind = KIND_KEYWORD[node.symbolKind ?? ""] ?? node.symbolKind ?? "";
  const access = node.access ?? "";
  const qualified = buildQualifiedName(node);
  const signature = access.length > 0
    ? `${access} ${kind} ${qualified}`
    : `${kind} ${qualified}`;

  const md = new MarkdownString();
  md.appendCodeblock(signature, "csharp");
  return md;
}
