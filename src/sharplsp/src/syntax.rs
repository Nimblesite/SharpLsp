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
fn extract_symbol_name<'a>(node: Node<'a>, source: &[u8]) -> Option<(String, Node<'a>)> {
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

// ── Folding Ranges ────────────────────────────────────────────────

/// Compute folding ranges from a tree-sitter parse tree.
///
/// Two of the three kinds are properties of a single node and come from the
/// recursive walk. The other two span SIBLINGS - a `#region` closed by a later
/// `#endregion`, and a run of adjacent `using` directives - so they are paired
/// from a flat, document-ordered collection instead.
pub fn folding_ranges(tree: &Tree, _source: &str) -> Vec<FoldingRange> {
    let root = tree.root_node();
    let mut ranges = Vec::new();
    collect_folding(root, &mut ranges);
    let mut spans = Spans::default();
    collect_spans(root, &mut spans);
    ranges.extend(region_ranges(&spans.regions));
    ranges.extend(import_ranges(&spans.imports));
    ranges
}

/// One directive's position, as `(start row, end row, end column)`.
type Marker = (usize, usize, usize);

/// The sibling-spanning directives, in document order.
#[derive(Default)]
struct Spans {
    /// `#region` (true) and `#endregion` (false) markers, interleaved.
    regions: Vec<(bool, Marker)>,
    /// `using` / `open` directives.
    imports: Vec<Marker>,
}

/// Collect every directive a sibling-spanning fold is built from.
fn collect_spans(node: Node<'_>, spans: &mut Spans) {
    let marker = (
        node.start_position().row,
        node.end_position().row,
        node.end_position().column,
    );
    match node.kind() {
        "preproc_region" => spans.regions.push((true, marker)),
        "preproc_endregion" => spans.regions.push((false, marker)),
        "using_directive" | "import_decl" => spans.imports.push(marker),
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_spans(child, spans);
    }
}

/// Pair each `#region` with the `#endregion` that closes it.
///
/// A stack, so nested regions pair innermost-first the way the compiler reads
/// them. An unclosed `#region` folds nothing - the user is mid-edit, and a fold
/// running to the end of the file would collapse the rest of their work.
fn region_ranges(markers: &[(bool, Marker)]) -> Vec<FoldingRange> {
    let mut open: Vec<Marker> = Vec::new();
    let mut ranges = Vec::new();
    for (is_open, marker) in markers {
        if *is_open {
            open.push(*marker);
        } else if let Some(start) = open.pop() {
            // The fold ends ON the `#endregion` line. The directive node runs
            // to the start of the next row, so its END row is one line past the
            // text the user sees, and folding to it would swallow the line
            // below the region.
            ranges.push(span(start.0, marker.0, None, FoldingRangeKind::Region));
        }
    }
    ranges
}

/// One `imports` fold per RUN of adjacent import directives.
///
/// Adjacent means consecutive rows: a blank line or any other statement ends
/// the run, so a second `using` block below a namespace folds as its own header
/// rather than being swallowed into the first.
fn import_ranges(markers: &[Marker]) -> Vec<FoldingRange> {
    let mut ranges = Vec::new();
    let mut run: Option<(Marker, Marker)> = None;
    for marker in markers {
        run = match run {
            Some((first, last)) if marker.0 == last.1 + 1 => Some((first, *marker)),
            Some((first, last)) => {
                ranges.extend(span_over_run(first, last));
                Some((*marker, *marker))
            }
            None => Some((*marker, *marker)),
        };
    }
    if let Some((first, last)) = run {
        ranges.extend(span_over_run(first, last));
    }
    ranges
}

/// The `imports` fold for one run, when the run actually spans more than a line.
fn span_over_run(first: Marker, last: Marker) -> Option<FoldingRange> {
    (first.0 < last.1).then(|| {
        span(
            first.0,
            last.1,
            Some(usize_to_u32(last.2)),
            FoldingRangeKind::Imports,
        )
    })
}

/// A fold over whole lines, optionally stopping at a column on the last one.
fn span(
    start_row: usize,
    end_row: usize,
    end_character: Option<u32>,
    kind: FoldingRangeKind,
) -> FoldingRange {
    FoldingRange {
        start_line: usize_to_u32(start_row),
        start_character: Some(0),
        end_line: usize_to_u32(end_row),
        end_character,
        kind: Some(kind),
        collapsed_text: None,
    }
}

/// Recursively collect folding ranges from tree-sitter nodes.
fn collect_folding(node: Node<'_>, ranges: &mut Vec<FoldingRange>) {
    let kind = fold_kind(node);
    if kind.is_some() || is_structural(node.kind()) {
        let start = node.start_position();
        let end = node.end_position();
        if start.row < end.row {
            ranges.push(FoldingRange {
                start_line: usize_to_u32(start.row),
                start_character: Some(usize_to_u32(start.column)),
                end_line: usize_to_u32(end.row),
                end_character: Some(usize_to_u32(end.column)),
                kind,
                collapsed_text: None,
            });
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_folding(child, ranges);
    }
}

/// The LSP kind a node's own fold carries, when it carries one at all.
///
/// LSP 3.17 defines exactly three kinds, and `region` names a range the USER
/// marked out with `#region` — not every brace pair. Tagging declarations
/// `region` made "collapse the region" collapse the enclosing class and left an
/// editor unable to tell the two apart, so a structural fold carries NO kind,
/// which is what every other server does.
fn fold_kind(node: Node<'_>) -> Option<FoldingRangeKind> {
    // Comments: C# `comment`, F# `block_comment` ((* *)) and `xml_doc` (///) —
    // multi-line only.
    match node.kind() {
        "comment" | "block_comment" | "xml_doc"
            if node.start_position().row != node.end_position().row =>
        {
            Some(FoldingRangeKind::Comment)
        }
        _ => None,
    }
}

/// Whether a node folds on its own shape: a body, a block, a declaration.
fn is_structural(kind: &str) -> bool {
    matches!(
        kind,
        // C# blocks / braces
        "class_declaration"
        | "struct_declaration"
        | "interface_declaration"
        | "enum_declaration"
        | "namespace_declaration"
        | "method_declaration"
        | "constructor_declaration"
        | "block"
        | "switch_body"
        | "record_declaration"
        // F# declarations (tree-sitter-fsharp). F# is a first-class citizen:
        // the same tree-sitter foldingRange contract covers both languages
        // ([SHARPLSP-SPEC] syntax-only table; CLAUDE.md aim #2). Only the
        // outer `type_definition` folds, not its inner record/union/etc.
        // defn, and a let-binding folds as its `function_or_value_defn` —
        // module-level lets are not wrapped in a `value_declaration`, so
        // that node only exists in some contexts and folding it here would
        // double-fold the same span there.
        | "named_module"
        | "module_defn"
        | "namespace"
        | "type_definition"
        | "type_extension"
        | "function_or_value_defn"
    )
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
