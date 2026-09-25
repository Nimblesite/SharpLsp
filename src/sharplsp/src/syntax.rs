//! Syntax-level LSP features powered by tree-sitter.
//!
//! These are handled entirely in Rust with sub-millisecond latency:
//! - documentSymbol
//! - selectionRange
//! - linkedEditingRange

use lsp_types::{DocumentSymbol, LinkedEditingRanges, Position, Range, SelectionRange, SymbolKind};
use tree_sitter::{Node, Point, Tree};

use crate::utils::usize_to_u32;

// ── Document Symbols ──────────────────────────────────────────────

/// Extract document symbols from a tree-sitter parse tree.
pub fn document_symbols(tree: &Tree, source: &str) -> Vec<DocumentSymbol> {
    let root = tree.root_node();
    let symbols = collect_symbols(root, source.as_bytes());
    reparent_file_scoped_members(symbols)
}

/// Recursively collect document symbols from tree-sitter child nodes.
fn collect_symbols(node: Node<'_>, source: &[u8]) -> Vec<DocumentSymbol> {
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

/// Extract the symbol name and its AST node for range calculation.
///
/// Most declarations have a direct `name` field. Field and event-field
/// declarations nest the name inside `variable_declaration > variable_declarator`.
pub(crate) fn extract_symbol_name<'a>(node: Node<'a>, source: &[u8]) -> Option<(String, Node<'a>)> {
    // Try direct name field first (class, method, property, etc.)
    if let Some(name_node) = node.child_by_field_name("name") {
        let name = name_node.utf8_text(source).ok()?.to_string();
        return Some((name, name_node));
    }
    // field_declaration / event_field_declaration: walk into variable_declarator
    find_variable_declarator_name(node, source)
}

/// Walk `variable_declaration > variable_declarator` to find the field name.
fn find_variable_declarator_name<'a>(node: Node<'a>, source: &[u8]) -> Option<(String, Node<'a>)> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_declaration" {
            let mut inner = child.walk();
            for declarator in child.children(&mut inner) {
                if declarator.kind() == "variable_declarator" {
                    let name_node = declarator.child_by_field_name("name")?;
                    let name = name_node.utf8_text(source).ok()?.to_string();
                    return Some((name, name_node));
                }
            }
        }
    }
    None
}

/// Convert a tree-sitter node to an LSP `DocumentSymbol` if it represents a declaration.
fn node_to_symbol(node: Node<'_>, source: &[u8]) -> Option<DocumentSymbol> {
    let kind = match node.kind() {
        "class_declaration" | "record_declaration" => SymbolKind::CLASS,
        "struct_declaration" => SymbolKind::STRUCT,
        "interface_declaration" => SymbolKind::INTERFACE,
        "enum_declaration" => SymbolKind::ENUM,
        "method_declaration" => SymbolKind::METHOD,
        "constructor_declaration" => SymbolKind::CONSTRUCTOR,
        "property_declaration" => SymbolKind::PROPERTY,
        "field_declaration" => SymbolKind::FIELD,
        "namespace_declaration" | "file_scoped_namespace_declaration" => SymbolKind::NAMESPACE,
        "delegate_declaration" => SymbolKind::FUNCTION,
        "event_declaration" | "event_field_declaration" => SymbolKind::EVENT,
        "enum_member_declaration" => SymbolKind::ENUM_MEMBER,
        _ => return None,
    };

    let (name, name_node) = extract_symbol_name(node, source)?;

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
    if !is_file_scoped_shape(&symbols) {
        return symbols;
    }

    let (mut namespaces, types): (Vec<_>, Vec<_>) = symbols
        .into_iter()
        .partition(|s| s.kind == SymbolKind::NAMESPACE);

    if let Some(ns) = namespaces.first_mut() {
        adopt_members(ns, types);
    }

    namespaces
}

/// Whether the outline has the file-scoped shape: exactly one namespace, which
/// holds no type of its own, with type declarations stranded beside it.
fn is_file_scoped_shape(symbols: &[DocumentSymbol]) -> bool {
    let ns_count = symbols
        .iter()
        .filter(|s| s.kind == SymbolKind::NAMESPACE)
        .count();
    let has_root_types = symbols.iter().any(|s| s.kind != SymbolKind::NAMESPACE);
    ns_count == 1 && has_root_types && !namespace_holds_a_type(symbols)
}

/// Whether the single namespace already nests a type, meaning the grammar
/// produced the block-scoped shape and nothing needs moving.
fn namespace_holds_a_type(symbols: &[DocumentSymbol]) -> bool {
    symbols
        .iter()
        .find(|s| s.kind == SymbolKind::NAMESPACE)
        .and_then(|ns| ns.children.as_ref())
        .is_some_and(|c| c.iter().any(|child| child.kind != SymbolKind::NAMESPACE))
}

/// Move the stranded types under the namespace, WIDENING it to enclose them.
///
/// The `file_scoped_namespace_declaration` node spans `namespace X;` and
/// nothing more, so every adopted type starts after its end. LSP 3.17 defines
/// `range` as "the range enclosing this symbol", and clients turn that into a
/// containment test - the breadcrumb and "reveal in outline" both ask which
/// symbol contains the cursor - so a parent that adopts children has to grow to
/// cover them. `selection_range` still names the identifier and remains inside.
fn adopt_members(namespace: &mut DocumentSymbol, types: Vec<DocumentSymbol>) {
    if let Some(end) = types.iter().map(|t| t.range.end).max() {
        namespace.range.end = namespace.range.end.max(end);
    }
    namespace
        .children
        .get_or_insert_with(Vec::new)
        .extend(types);
}

// ── Selection Ranges ──────────────────────────────────────────────

/// Compute selection ranges for a set of positions.
pub fn selection_ranges(tree: &Tree, _source: &str, positions: &[Position]) -> Vec<SelectionRange> {
    positions
        .iter()
        .map(|pos| build_selection_range(tree, *pos))
        .collect()
}

/// Build a nested selection range chain from innermost node to root.
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

/// Whether a position has no symbol under it at all: whitespace, or a comment.
///
/// [HOVER-ERRORS] names "position is whitespace or comment" as one refusal, and
/// [HOVER-ROUTING] makes it a tree-sitter pre-validation so it costs a syntax
/// lookup rather than a sidecar round trip on every mouse move. Only the
/// comment half was implemented, so hovering blank space paid the full trip and
/// could pop a tooltip over nothing.
///
/// Whitespace is read off the tree rather than the text: the smallest node
/// containing a point inside a TOKEN is that token, a leaf, while a point
/// between tokens resolves to the enclosing construct, which has children.
pub fn has_no_symbol_at_position(tree: &Tree, position: Position) -> bool {
    let point = lsp_pos_to_ts_point(position);
    tree.root_node()
        .descendant_for_point_range(point, point)
        .is_some_and(|node| node.kind() == "comment" || node.child_count() > 0)
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

/// Convert a tree-sitter node's range to an LSP `Range`.
fn ts_range_to_lsp(node: Node<'_>) -> Range {
    Range {
        start: ts_point_to_lsp_pos(node.start_position()),
        end: ts_point_to_lsp_pos(node.end_position()),
    }
}
