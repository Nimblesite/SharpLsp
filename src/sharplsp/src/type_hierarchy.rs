//! Type hierarchy handlers (`textDocument/prepareTypeHierarchy`,
//! `typeHierarchy/supertypes`, `typeHierarchy/subtypes`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    SymbolKind, TypeHierarchyItem, TypeHierarchyPrepareParams, TypeHierarchySubtypesParams,
    TypeHierarchySupertypesParams,
};
use tracing::debug;

use crate::hierarchy::{hierarchy_item_location, prepare_hierarchy, SidecarHierarchyItem};
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, with_sidecar, SidecarPositionReq};

/// Handle `textDocument/prepareTypeHierarchy`.
pub fn handle_prepare(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: TypeHierarchyPrepareParams| {
            prepare_hierarchy(
                runtime,
                sidecar,
                "textDocument/prepareTypeHierarchy",
                &params.text_document_position_params,
                map_type_hierarchy_item,
            )
        },
    )
}

/// Handle `typeHierarchy/supertypes`.
pub fn handle_supertypes(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: TypeHierarchySupertypesParams| {
            related_types(runtime, sidecar, "typeHierarchy/supertypes", &params.item)
        },
    )
}

/// Handle `typeHierarchy/subtypes`.
pub fn handle_subtypes(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: TypeHierarchySubtypesParams| {
            related_types(runtime, sidecar, "typeHierarchy/subtypes", &params.item)
        },
    )
}

/// The types the sidecar relates to `item` via `method` (super- or subtypes).
///
/// An unreachable sidecar answers an empty list, the same as a type with no
/// relatives: the tree shows nothing rather than an error.
fn related_types(
    runtime: &tokio::runtime::Runtime,
    sidecar: &SidecarManager,
    method: &str,
    item: &TypeHierarchyItem,
) -> Result<serde_json::Value> {
    let request = SidecarPositionReq::at(&item.uri, item.selection_range.start)?;
    let items: Vec<SidecarHierarchyItem> =
        request_sidecar(runtime, sidecar, method, &request)?.unwrap_or_default();
    debug!(method, count = items.len(), "related types from sidecar");
    let result: Vec<TypeHierarchyItem> = items.iter().filter_map(map_type_hierarchy_item).collect();
    Ok(serde_json::to_value(result)?)
}

// ── Helpers ────────────────────────────────────────────────────────

/// Convert a sidecar hierarchy item into an LSP `TypeHierarchyItem`.
fn map_type_hierarchy_item(item: &SidecarHierarchyItem) -> Option<TypeHierarchyItem> {
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
