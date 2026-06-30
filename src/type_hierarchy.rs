//! Type hierarchy handlers (`textDocument/prepareTypeHierarchy`,
//! `typeHierarchy/supertypes`, `typeHierarchy/subtypes`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    SymbolKind, TypeHierarchyItem, TypeHierarchyPrepareParams, TypeHierarchySubtypesParams,
    TypeHierarchySupertypesParams,
};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;
use crate::utils::{hierarchy_item_location, SidecarHierarchyItem, SidecarPositionReq};

/// Handle `textDocument/prepareTypeHierarchy`.
pub fn handle_prepare(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: TypeHierarchyPrepareParams = serde_json::from_value(req.params)?;
    let file_path =
        crate::semantic::uri_to_path(&params.text_document_position_params.text_document.uri)?;
    let pos = &params.text_document_position_params.position;

    let request = SidecarPositionReq {
        file_path,
        line: pos.line,
        character: pos.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/prepareTypeHierarchy", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar prepareTypeHierarchy unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let item: Option<SidecarHierarchyItem> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got type hierarchy item from sidecar: {}", item.is_some());

    let result: Vec<TypeHierarchyItem> = item
        .as_ref()
        .and_then(map_type_hierarchy_item)
        .into_iter()
        .collect();
    Ok(serde_json::to_value(result)?)
}

/// Handle `typeHierarchy/supertypes`.
pub fn handle_supertypes(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: TypeHierarchySupertypesParams = serde_json::from_value(req.params)?;
    let item = &params.item;
    let file_path = crate::semantic::uri_to_path(&item.uri)?;

    let request = SidecarPositionReq {
        file_path,
        line: item.selection_range.start.line,
        character: item.selection_range.start.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("typeHierarchy/supertypes", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar supertypes unavailable: {err:#}");
                return Ok(serde_json::to_value(Vec::<TypeHierarchyItem>::new())?);
            }
        };

    let items: Vec<SidecarHierarchyItem> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} supertypes from sidecar", items.len());

    let result: Vec<TypeHierarchyItem> = items.iter().filter_map(map_type_hierarchy_item).collect();
    Ok(serde_json::to_value(result)?)
}

/// Handle `typeHierarchy/subtypes`.
pub fn handle_subtypes(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: TypeHierarchySubtypesParams = serde_json::from_value(req.params)?;
    let item = &params.item;
    let file_path = crate::semantic::uri_to_path(&item.uri)?;

    let request = SidecarPositionReq {
        file_path,
        line: item.selection_range.start.line,
        character: item.selection_range.start.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("typeHierarchy/subtypes", payload))
    {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar subtypes unavailable: {err:#}");
            return Ok(serde_json::to_value(Vec::<TypeHierarchyItem>::new())?);
        }
    };

    let items: Vec<SidecarHierarchyItem> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} subtypes from sidecar", items.len());

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


