//! Type hierarchy mapping (`textDocument/prepareTypeHierarchy`,
//! `typeHierarchy/supertypes`, `typeHierarchy/subtypes`): the requests
//! themselves are answered by [`crate::hierarchy`].

use lsp_types::{SymbolKind, TypeHierarchyItem};

use crate::hierarchy::{hierarchy_item_location, SidecarHierarchyItem};

// ── Helpers ────────────────────────────────────────────────────────

/// Convert a sidecar hierarchy item into an LSP `TypeHierarchyItem`.
pub fn map_type_hierarchy_item(item: &SidecarHierarchyItem) -> Option<TypeHierarchyItem> {
    let (uri, range, selection_range) = hierarchy_item_location(item)?;
    Some(TypeHierarchyItem {
        name: item.name.clone(),
        kind: parse_symbol_kind(&item.kind),
        tags: None,
        detail: None,
        uri,
        range,
        selection_range,
        data: None,
    })
}

/// Parse a sidecar symbol kind string into an LSP `SymbolKind`.
fn parse_symbol_kind(kind: &str) -> SymbolKind {
    match kind {
        "Interface" => SymbolKind::INTERFACE,
        "Struct" => SymbolKind::STRUCT,
        "Enum" => SymbolKind::ENUM,
        "Module" | "Namespace" => SymbolKind::MODULE,
        _ => SymbolKind::CLASS,
    }
}
