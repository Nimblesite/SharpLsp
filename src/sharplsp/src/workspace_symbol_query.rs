//! Standard `workspace/symbol`: C# files are matched by tree-sitter over the
//! VFS; F# files via the FCS sidecar's document symbols, since the host has no
//! F# tree-sitter grammar. `[SHARPLSP-FEATURES-NAVIGATION]`, `[FS-WORKSPACE-SYMBOL]`

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{SymbolInformation, SymbolKind, Uri};
use tree_sitter::Node;

use crate::document_symbols;
use crate::sidecar::manager::SidecarManager;
use crate::syntax::{extract_symbol_name, ts_range_to_lsp};
use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::vfs::Vfs;

/// Answer `workspace/symbol` over every open document.
pub(crate) fn handle(
    req: Request,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: lsp_types::WorkspaceSymbolParams = serde_json::from_value(req.params)?;
    let query = params.query.to_lowercase();
    let mut symbols = Vec::new();
    for entry in vfs.iter() {
        let uri = entry.key().clone();
        let Some(lang) = LangId::from_uri(&uri).filter(|lang| lang.has_grammar()) else {
            continue;
        };
        if matches!(lang, LangId::FSharp) {
            collect_fsharp(&uri, runtime, fsharp_sidecar, &query, &mut symbols);
            continue;
        }
        let content = entry.value().content.clone();
        if let Ok(tree) = parsers.parse(lang, &content, None) {
            collect_matching(
                &uri,
                tree.root_node(),
                content.as_bytes(),
                &query,
                &mut symbols,
            );
        }
    }
    Ok(serde_json::to_value(symbols)?)
}

/// Append the FCS-sourced workspace symbols matching `query` for one open F#
/// document. No sidecar / unresolvable path / sidecar error → contributes
/// nothing, never fails the whole search.
fn collect_fsharp(
    uri: &Uri,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    query: &str,
    symbols: &mut Vec<SymbolInformation>,
) {
    let Some(sidecar) = fsharp_sidecar else {
        return;
    };
    let Ok(file_path) = crate::paths::uri_to_path(uri.as_str()) else {
        return;
    };
    let Ok(found) = document_symbols::fsharp_workspace_symbols(runtime, sidecar, uri, file_path)
    else {
        return;
    };
    symbols.extend(
        found
            .into_iter()
            .filter(|sym| name_matches(&sym.name, query)),
    );
}

/// Recursively walk tree-sitter nodes and collect matching workspace symbols.
fn collect_matching(
    uri: &Uri,
    node: Node<'_>,
    source: &[u8],
    query: &str,
    symbols: &mut Vec<SymbolInformation>,
) {
    if let Some(symbol) = matching_symbol(uri, node, source, query) {
        symbols.push(symbol);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_matching(uri, child, source, query, symbols);
    }
}

/// The workspace symbol `node` declares, when it is a named declaration matching `query`.
fn matching_symbol(
    uri: &Uri,
    node: Node<'_>,
    source: &[u8],
    query: &str,
) -> Option<SymbolInformation> {
    let kind = symbol_kind(node.kind())?;
    let (name, _) = extract_symbol_name(node, source)?;
    name_matches(&name, query).then(|| {
        #[expect(
            deprecated,
            reason = "SymbolInformation is the LSP 3.17 workspace/symbol response type"
        )]
        SymbolInformation {
            name,
            kind,
            tags: None,
            deprecated: None,
            location: lsp_types::Location {
                uri: uri.clone(),
                range: ts_range_to_lsp(node),
            },
            container_name: None,
        }
    })
}

/// The LSP symbol kind of a C# or F# declaration node, if it declares one.
fn symbol_kind(node_kind: &str) -> Option<SymbolKind> {
    Some(match node_kind {
        "class_declaration" | "record_declaration" | "type_definition" => SymbolKind::CLASS,
        "struct_declaration" => SymbolKind::STRUCT,
        "interface_declaration" => SymbolKind::INTERFACE,
        "enum_declaration" => SymbolKind::ENUM,
        "method_declaration" | "local_function_statement" => SymbolKind::METHOD,
        "property_declaration" => SymbolKind::PROPERTY,
        "field_declaration" => SymbolKind::FIELD,
        "constructor_declaration" => SymbolKind::CONSTRUCTOR,
        "event_declaration" => SymbolKind::EVENT,
        "delegate_declaration" | "value_declaration" | "function_or_value_defn" => {
            SymbolKind::FUNCTION
        }
        "enum_member_declaration" => SymbolKind::ENUM_MEMBER,
        "namespace_declaration" | "file_scoped_namespace_declaration" => SymbolKind::NAMESPACE,
        "module_defn" => SymbolKind::MODULE,
        _ => return None,
    })
}

/// An empty query matches everything; otherwise a case-insensitive subsequence match.
fn name_matches(name: &str, query: &str) -> bool {
    query.is_empty() || fuzzy_match_subsequence(&name.to_lowercase(), query)
}

/// Fuzzy subsequence match: every character in `query` appears in `name` in order.
fn fuzzy_match_subsequence(name: &str, query: &str) -> bool {
    let mut name_chars = name.chars();
    query
        .chars()
        .all(|qc| name_chars.by_ref().any(|nc| nc == qc))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test assertions on deterministic inputs"
)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_subsequence_matches_in_order_only() {
        assert!(fuzzy_match_subsequence("orderservice", "osv"));
        assert!(fuzzy_match_subsequence("orderservice", "orderservice"));
        assert!(fuzzy_match_subsequence("orderservice", ""));
        assert!(!fuzzy_match_subsequence("orderservice", "vso"));
        assert!(!fuzzy_match_subsequence("order", "orders"));
        assert!(!fuzzy_match_subsequence("", "a"));
    }

    #[test]
    fn name_matches_is_case_insensitive_on_the_name() {
        assert!(name_matches("OrderService", "osv"));
        assert!(name_matches("OrderService", ""));
        assert!(!name_matches("OrderService", "xyz"));
    }

    #[test]
    fn csharp_declarations_are_collected_with_ranges_and_kinds() {
        let source = "namespace App;\nclass Order { int Total; void Ship() {} }\nenum Kind { A }";
        let parsers = TsParsers::new();
        let tree = parsers.parse(LangId::CSharp, source, None).unwrap();
        let uri: Uri = "file:///app/Order.cs".parse().unwrap();
        let mut all = Vec::new();
        collect_matching(&uri, tree.root_node(), source.as_bytes(), "", &mut all);
        let names: Vec<_> = all.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["App", "Order", "Total", "Ship", "Kind", "A"]);
        assert_eq!(all[1].kind, SymbolKind::CLASS);
        assert_eq!(all[1].location.range.start.line, 1);
        assert_eq!(all[3].kind, SymbolKind::METHOD);
        assert_eq!(all[5].kind, SymbolKind::ENUM_MEMBER);
        assert!(all.iter().all(|s| s.location.uri == uri));

        let mut filtered = Vec::new();
        collect_matching(
            &uri,
            tree.root_node(),
            source.as_bytes(),
            "shp",
            &mut filtered,
        );
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "Ship");
    }
}
