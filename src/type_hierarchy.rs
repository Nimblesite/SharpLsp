//! Type hierarchy handlers (`textDocument/prepareTypeHierarchy`,
//! `typeHierarchy/supertypes`, `typeHierarchy/subtypes`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    Position, Range, SymbolKind, TypeHierarchyItem, TypeHierarchyPrepareParams,
    TypeHierarchySubtypesParams, TypeHierarchySupertypesParams, Uri,
};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

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
    let uri = format!("file://{}", item.file_path);
    let parsed_uri = uri.parse::<Uri>().ok()?;
    Some(TypeHierarchyItem {
        name: item.name.clone(),
        kind: parse_symbol_kind(&item.kind),
        tags: None,
        detail: None,
        uri: parsed_uri,
        range: Range::new(
            Position::new(item.line, item.character),
            Position::new(item.end_line, item.end_character),
        ),
        selection_range: Range::new(
            Position::new(item.line, item.character),
            Position::new(item.line, item.character),
        ),
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

// ── Wire types ────────────────────────────────────────────────────

/// Request sent to the sidecar identifying a position in a file.
#[derive(serde::Serialize)]
struct SidecarPositionReq {
    /// Absolute path to the source file.
    file_path: String,
    /// Zero-based line number.
    line: u32,
    /// Zero-based character offset within the line.
    character: u32,
}

/// A hierarchy item returned by the sidecar for type hierarchy requests.
#[derive(serde::Deserialize)]
struct SidecarHierarchyItem {
    /// Display name of the type.
    name: String,
    /// Symbol kind string (e.g. "Class", "Interface").
    kind: String,
    /// Absolute path to the file containing this type.
    file_path: String,
    /// Start line of the type range.
    line: u32,
    /// Start character offset within the start line.
    character: u32,
    /// End line of the type range.
    end_line: u32,
    /// End character offset within the end line.
    end_character: u32,
}
