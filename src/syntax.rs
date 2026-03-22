//! Syntax-level LSP features powered by tree-sitter.
//!
//! These are handled entirely in Rust with sub-millisecond latency:
//! - documentSymbol
//! - foldingRange
//! - selectionRange
//! - linkedEditingRange

use lsp_types::{
    DocumentSymbol, FoldingRange, FoldingRangeKind, LinkedEditingRanges, Position, Range,
    SelectionRange, SymbolKind,
};
use tree_sitter::{Node, Point, Tree};

use crate::utils::usize_to_u32;

// ── Document Symbols ──────────────────────────────────────────────

/// Extract document symbols from a tree-sitter parse tree.
pub fn document_symbols(tree: &Tree, source: &str) -> Vec<DocumentSymbol> {
    let root = tree.root_node();
    let symbols = collect_symbols(root, source.as_bytes());
    reparent_file_scoped_members(symbols)
}

fn collect_symbols(node: Node, source: &[u8]) -> Vec<DocumentSymbol> {
    let mut symbols = Vec::new();

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(sym) = node_to_symbol(child, source) {
            symbols.push(sym);
        } else {
            // Recurse into nodes that aren't themselves symbols
            symbols.extend(collect_symbols(child, source));
        }
    }

    symbols
}

fn node_to_symbol(node: Node, source: &[u8]) -> Option<DocumentSymbol> {
    let (kind, name_field) = match node.kind() {
        "class_declaration" | "record_declaration" => (SymbolKind::CLASS, "name"),
        "struct_declaration" => (SymbolKind::STRUCT, "name"),
        "interface_declaration" => (SymbolKind::INTERFACE, "name"),
        "enum_declaration" => (SymbolKind::ENUM, "name"),
        "method_declaration" => (SymbolKind::METHOD, "name"),
        "constructor_declaration" => (SymbolKind::CONSTRUCTOR, "name"),
        "property_declaration" => (SymbolKind::PROPERTY, "name"),
        "field_declaration" => (SymbolKind::FIELD, "name"),
        "namespace_declaration" | "file_scoped_namespace_declaration" => {
            (SymbolKind::NAMESPACE, "name")
        }
        "delegate_declaration" => (SymbolKind::FUNCTION, "name"),
        "event_declaration" => (SymbolKind::EVENT, "name"),
        "enum_member_declaration" => (SymbolKind::ENUM_MEMBER, "name"),
        _ => return None,
    };

    let name_node = node.child_by_field_name(name_field)?;
    let name = name_node.utf8_text(source).ok()?.to_string();

    let range = ts_range_to_lsp(node);
    let selection_range = ts_range_to_lsp(name_node);

    let children = collect_symbols(node, source);

    let children_opt = if children.is_empty() {
        None
    } else {
        Some(children)
    };

    // The `deprecated` field on `DocumentSymbol` is deprecated by lsp-types
    // in favor of `tags`. We must still set it for protocol completeness.
    #[expect(
        deprecated,
        reason = "lsp-types marks the `deprecated` field as deprecated; required for LSP protocol struct completeness"
    )]
    Some(DocumentSymbol {
        name,
        detail: None,
        kind,
        tags: None,
        deprecated: None,
        range,
        selection_range,
        children: children_opt,
    })
}

/// Fix file-scoped namespace hierarchy.
///
/// `tree-sitter-c-sharp` 0.23 emits `file_scoped_namespace_declaration`
/// without nesting subsequent type declarations as children — they appear
/// as siblings at the root level. Detect this and move them inside.
fn reparent_file_scoped_members(symbols: Vec<DocumentSymbol>) -> Vec<DocumentSymbol> {
    let ns_count = symbols
        .iter()
        .filter(|s| s.kind == SymbolKind::NAMESPACE)
        .count();
    let has_root_types = symbols.iter().any(|s| s.kind != SymbolKind::NAMESPACE);

    if ns_count != 1 || !has_root_types {
        return symbols;
    }

    let ns_has_types = symbols
        .iter()
        .find(|s| s.kind == SymbolKind::NAMESPACE)
        .is_some_and(|ns| {
            ns.children
                .as_ref()
                .is_some_and(|c| c.iter().any(|child| child.kind != SymbolKind::NAMESPACE))
        });

    if ns_has_types {
        return symbols;
    }

    let (mut namespaces, types): (Vec<_>, Vec<_>) = symbols
        .into_iter()
        .partition(|s| s.kind == SymbolKind::NAMESPACE);

    if let Some(ns) = namespaces.first_mut() {
        let children = ns.children.get_or_insert_with(Vec::new);
        children.extend(types);
    }

    namespaces
}

// ── Folding Ranges ────────────────────────────────────────────────

/// Compute folding ranges from a tree-sitter parse tree.
pub fn folding_ranges(tree: &Tree, _source: &str) -> Vec<FoldingRange> {
    let root = tree.root_node();
    let mut ranges = Vec::new();
    collect_folding(root, &mut ranges);
    ranges
}

fn collect_folding(node: Node, ranges: &mut Vec<FoldingRange>) {
    let kind = match node.kind() {
        // Blocks / braces
        "class_declaration"
        | "struct_declaration"
        | "interface_declaration"
        | "enum_declaration"
        | "namespace_declaration"
        | "method_declaration"
        | "constructor_declaration"
        | "block"
        | "switch_body"
        | "record_declaration" => Some(FoldingRangeKind::Region),
        // Comments
        "comment" if node.start_position().row != node.end_position().row => {
            Some(FoldingRangeKind::Comment)
        }
        // Using directives group
        "using_directive" => Some(FoldingRangeKind::Imports),
        _ => None,
    };

    if let Some(fold_kind) = kind {
        let start = node.start_position();
        let end = node.end_position();
        if start.row < end.row {
            ranges.push(FoldingRange {
                start_line: usize_to_u32(start.row),
                start_character: Some(usize_to_u32(start.column)),
                end_line: usize_to_u32(end.row),
                end_character: Some(usize_to_u32(end.column)),
                kind: Some(fold_kind),
                collapsed_text: None,
            });
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_folding(child, ranges);
    }
}

// ── Selection Ranges ──────────────────────────────────────────────

/// Compute selection ranges for a set of positions.
pub fn selection_ranges(tree: &Tree, _source: &str, positions: &[Position]) -> Vec<SelectionRange> {
    positions
        .iter()
        .map(|pos| build_selection_range(tree, *pos))
        .collect()
}

fn build_selection_range(tree: &Tree, position: Position) -> SelectionRange {
    let point = lsp_pos_to_ts_point(position);

    let mut node = tree
        .root_node()
        .descendant_for_point_range(point, point)
        .unwrap_or_else(|| tree.root_node());

    // Collect nodes from innermost to root.
    let mut nodes = vec![node];
    while let Some(parent) = node.parent() {
        nodes.push(parent);
        node = parent;
    }

    // Build chain from root inward: each inner range has `parent` pointing
    // to its enclosing (larger) range, as required by LSP spec.
    let mut result = SelectionRange {
        range: ts_range_to_lsp(tree.root_node()),
        parent: None,
    };
    for &inner in nodes.iter().rev().skip(1) {
        result = SelectionRange {
            range: ts_range_to_lsp(inner),
            parent: Some(Box::new(result)),
        };
    }

    result
}

// ── Linked Editing Ranges ─────────────────────────────────────────

/// Compute linked editing ranges for a position.
///
/// Currently returns `None` for all inputs because tree-sitter-c-sharp v0.23.1
/// does not produce structured XML nodes for `///` doc comments. When the
/// grammar adds `xml_element` support, this function will extract matching
/// open/close tag name pairs for simultaneous editing.
pub fn linked_editing_ranges(
    _tree: &Tree,
    _source: &str,
    _position: Position,
) -> Option<LinkedEditingRanges> {
    // tree-sitter-c-sharp v0.23.1 parses `///` as a flat `comment` node
    // without internal XML structure. Nothing to link.
    None
}

// ── Hover Pre-validation ──────────────────────────────────────

/// Check if a position is on a comment node (tree-sitter pre-validation).
///
/// Returns `true` when the position falls inside a comment, allowing the
/// caller to short-circuit hover requests with `null` before dispatching
/// to the sidecar.
pub fn is_comment_at_position(tree: &Tree, position: Position) -> bool {
    let point = lsp_pos_to_ts_point(position);
    tree.root_node()
        .descendant_for_point_range(point, point)
        .is_some_and(|node| node.kind() == "comment")
}

/// Check if a position is on a string literal node (tree-sitter pre-validation).
///
/// Returns `true` when the position falls inside a string literal, allowing
/// the caller to short-circuit definition requests with `null`.
pub fn is_string_at_position(tree: &Tree, position: Position) -> bool {
    let point = lsp_pos_to_ts_point(position);
    tree.root_node()
        .descendant_for_point_range(point, point)
        .is_some_and(|node| {
            matches!(
                node.kind(),
                "string_literal"
                    | "verbatim_string_literal"
                    | "raw_string_literal"
                    | "interpolated_string_expression"
                    | "interpolated_string_text"
                    | "string_content"
                    | "character_literal"
            )
        })
}

// ── Helpers ───────────────────────────────────────────────────────

/// Convert a tree-sitter `Point` to an LSP `Position`.
fn ts_point_to_lsp_pos(point: Point) -> Position {
    Position {
        line: usize_to_u32(point.row),
        character: usize_to_u32(point.column),
    }
}

/// Convert an LSP `Position` to a tree-sitter `Point`.
fn lsp_pos_to_ts_point(position: Position) -> Point {
    Point {
        row: usize::try_from(position.line).unwrap_or(usize::MAX),
        column: usize::try_from(position.character).unwrap_or(usize::MAX),
    }
}

fn ts_range_to_lsp(node: Node) -> Range {
    Range {
        start: ts_point_to_lsp_pos(node.start_position()),
        end: ts_point_to_lsp_pos(node.end_position()),
    }
}
