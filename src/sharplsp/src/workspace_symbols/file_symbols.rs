//! One source file's symbols for the Solution Explorer: tree-sitter for C#
//! ([SE-LIVE-BUFFER]), the FCS sidecar's document symbols for F#
//! ([SE-FSHARP-SYMBOLS]).

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use tree_sitter::Node;

use super::{FileSymbol, SymbolNode, SymbolRange};
use crate::sidecar::manager::SidecarManager;
use crate::syntax::collect_declarations;
use crate::tree_sitter_parse::{parse_file, LangId, TsParsers};
use crate::utils::usize_to_u32;
use crate::vfs::Vfs;

/// Extract a file's symbols, dispatching by language: tree-sitter for C#, the
/// FCS sidecar for F#.
pub(super) fn file_symbols(
    file_path: &str,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<FileSymbol> {
    match LangId::from_path(Path::new(file_path)) {
        Some(LangId::FSharp) => parse_fsharp_file_symbols(file_path, runtime, fsharp_sidecar),
        _ => parse_file_symbols(file_path, parsers, vfs),
    }
}

/// Extract an F# file's symbols via the FCS sidecar's documentSymbol, mapping
/// the result into the Solution Explorer's symbol model. `[SE-FSHARP-SYMBOLS]`
fn parse_fsharp_file_symbols(
    file_path: &str,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<FileSymbol> {
    let sidecar = fsharp_sidecar.context("F# sidecar unavailable for F# symbol extraction")?;
    let items = crate::document_symbols::fetch_fsharp_document_symbols(
        runtime,
        sidecar,
        file_path.to_string(),
    )?;
    Ok(FileSymbol {
        file: file_path.to_string(),
        symbols: items.iter().map(map_sidecar_symbol).collect(),
    })
}

/// Map a sidecar document symbol (and its children) into a `SymbolNode`. Uses
/// the full symbol range to match the C# tree-sitter path's `node_to_symbol`.
fn map_sidecar_symbol(item: &crate::document_symbols::SidecarDocumentSymbol) -> SymbolNode {
    SymbolNode {
        name: item.name.clone(),
        kind: item.kind.clone(),
        detail: None,
        access: None,
        range: SymbolRange::new(
            (item.start_line, item.start_character),
            (item.end_line, item.end_character),
        ),
        selection_range: SymbolRange::new(
            (item.selection_start_line, item.selection_start_character),
            (item.selection_end_line, item.selection_end_character),
        ),
        children: item.children.iter().map(map_sidecar_symbol).collect(),
    }
}

/// Parse a single source file and extract symbols.
/// Prefers VFS content (unsaved buffer) over disk for open documents.
/// Implements [SE-LIVE-BUFFER].
fn parse_file_symbols(file_path: &str, parsers: &TsParsers, vfs: &Vfs) -> Result<FileSymbol> {
    let (source, tree) = parse_file(file_path, parsers, vfs)?;

    let symbols = collect_declarations(tree.root_node(), source.as_bytes(), &node_to_symbol);
    let symbols = top_level_program(tree.root_node())
        .into_iter()
        .chain(reparent_file_scoped_members(symbols))
        .collect();

    Ok(FileSymbol {
        file: file_path.to_string(),
        symbols,
    })
}

/// Top-level statements compile into the global-namespace `Program` class, so a
/// file of them lists as `Program`, spanning its first to last statement ([SE-TREE]).
fn top_level_program(root: Node<'_>) -> Option<SymbolNode> {
    let mut cursor = root.walk();
    let statements: Vec<Node<'_>> = root
        .children(&mut cursor)
        .filter(|child| child.kind() == "global_statement")
        .collect();
    let (first, last) = (*statements.first()?, *statements.last()?);
    Some(SymbolNode {
        name: "Program".to_string(),
        kind: "Class".to_string(),
        detail: None,
        access: None,
        range: SymbolRange {
            start: node_range(first).start,
            end: node_range(last).end,
        },
        selection_range: node_range(first),
        children: Vec::new(),
    })
}

/// Fix file-scoped namespace hierarchy.
///
/// `tree-sitter-c-sharp` 0.23 emits `file_scoped_namespace_declaration`
/// without nesting subsequent type declarations as children — they appear
/// as siblings at the root level. Detect this and move them inside.
pub(super) fn reparent_file_scoped_members(symbols: Vec<SymbolNode>) -> Vec<SymbolNode> {
    let ns_count = symbols.iter().filter(|s| s.kind == "Namespace").count();
    let has_root_types = symbols.iter().any(|s| s.kind != "Namespace");

    if ns_count != 1 || !has_root_types {
        return symbols;
    }

    // Only reparent if the namespace has no type children already.
    let ns_has_types = symbols
        .iter()
        .find(|s| s.kind == "Namespace")
        .is_some_and(|ns| ns.children.iter().any(|c| c.kind != "Namespace"));

    if ns_has_types {
        return symbols;
    }

    let (mut namespaces, types): (Vec<_>, Vec<_>) =
        symbols.into_iter().partition(|s| s.kind == "Namespace");

    if let Some(ns) = namespaces.first_mut() {
        ns.children.extend(types);
    }

    namespaces
}

/// Map a tree-sitter node to a `SymbolNode` if it is a recognized declaration.
fn node_to_symbol(node: Node<'_>, source: &[u8]) -> Option<SymbolNode> {
    let kind = match node.kind() {
        "namespace_declaration" | "file_scoped_namespace_declaration" => "Namespace",
        "class_declaration" | "record_declaration" => "Class",
        "struct_declaration" => "Struct",
        "interface_declaration" => "Interface",
        "enum_declaration" => "Enum",
        "method_declaration" => "Method",
        "constructor_declaration" => "Constructor",
        "property_declaration" => "Property",
        "field_declaration" => "Field",
        "delegate_declaration" => "Function",
        "event_declaration" | "event_field_declaration" => "Event",
        "enum_member_declaration" => "EnumMember",
        _ => return None,
    };

    let (name, name_node) = crate::syntax::extract_symbol_name(node, source)?;

    let detail = extract_type_detail(node, source);
    let access = crate::sort_members::extract_access_modifiers(&node, source);
    let children = collect_declarations(node, source, &node_to_symbol);

    Some(SymbolNode {
        name,
        kind: kind.to_string(),
        detail,
        access,
        range: node_range(node),
        selection_range: node_range(name_node),
        children,
    })
}

/// The span a tree-sitter node covers, in 0-based lines and characters.
fn node_range(node: Node<'_>) -> SymbolRange {
    let position =
        |point: tree_sitter::Point| (usize_to_u32(point.row), usize_to_u32(point.column));
    SymbolRange::new(
        position(node.start_position()),
        position(node.end_position()),
    )
}

/// Extract type info (base class, return type) for display.
fn extract_type_detail(node: Node<'_>, source: &[u8]) -> Option<String> {
    match node.kind() {
        "class_declaration" | "struct_declaration" | "record_declaration" => node
            .child_by_field_name("bases")
            .and_then(|b| b.utf8_text(source).ok())
            .map(|s| s.trim_start_matches(": ").to_string()),
        "property_declaration" | "field_declaration" => node
            .child_by_field_name("type")
            .and_then(|t| t.utf8_text(source).ok())
            .map(String::from),
        "method_declaration" => node
            .child_by_field_name("type")
            .and_then(|t| t.utf8_text(source).ok())
            .map(|ret| format!("() : {ret}")),
        _ => None,
    }
}
