//! Call hierarchy handlers (`textDocument/prepareCallHierarchy`,
//! `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem,
    CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams,
    Position, Range, SymbolKind, Uri,
};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

/// Handle `textDocument/prepareCallHierarchy`.
pub fn handle_prepare(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: CallHierarchyPrepareParams = serde_json::from_value(req.params)?;
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
        match runtime.block_on(sidecar.request("textDocument/prepareCallHierarchy", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar prepareCallHierarchy unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let items: Vec<SidecarHierarchyItem> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} call hierarchy items from sidecar", items.len());

    let result: Vec<CallHierarchyItem> = items.iter().filter_map(map_hierarchy_item).collect();
    Ok(serde_json::to_value(result)?)
}

/// Handle `callHierarchy/incomingCalls`.
pub fn handle_incoming(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: CallHierarchyIncomingCallsParams = serde_json::from_value(req.params)?;
    let item = &params.item;
    let file_path = crate::semantic::uri_to_path(&item.uri)?;

    let request = SidecarPositionReq {
        file_path,
        line: item.selection_range.start.line,
        character: item.selection_range.start.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("callHierarchy/incomingCalls", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar incomingCalls unavailable: {err:#}");
                return Ok(serde_json::to_value(
                    Vec::<CallHierarchyIncomingCall>::new(),
                )?);
            }
        };

    let items: Vec<SidecarHierarchyItem> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} incoming calls from sidecar", items.len());

    let result: Vec<CallHierarchyIncomingCall> = items
        .iter()
        .filter_map(|i| {
            let item = map_hierarchy_item(i)?;
            Some(CallHierarchyIncomingCall {
                from: item,
                from_ranges: vec![Range::new(
                    Position::new(i.line, i.character),
                    Position::new(i.end_line, i.end_character),
                )],
            })
        })
        .collect();
    Ok(serde_json::to_value(result)?)
}

/// Handle `callHierarchy/outgoingCalls`.
pub fn handle_outgoing(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: CallHierarchyOutgoingCallsParams = serde_json::from_value(req.params)?;
    let item = &params.item;
    let file_path = crate::semantic::uri_to_path(&item.uri)?;

    let request = SidecarPositionReq {
        file_path,
        line: item.selection_range.start.line,
        character: item.selection_range.start.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("callHierarchy/outgoingCalls", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar outgoingCalls unavailable: {err:#}");
                return Ok(serde_json::to_value(
                    Vec::<CallHierarchyOutgoingCall>::new(),
                )?);
            }
        };

    let items: Vec<SidecarHierarchyItem> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} outgoing calls from sidecar", items.len());

    let result: Vec<CallHierarchyOutgoingCall> = items
        .iter()
        .filter_map(|i| {
            let mapped = map_hierarchy_item(i)?;
            Some(CallHierarchyOutgoingCall {
                to: mapped,
                from_ranges: vec![Range::new(
                    Position::new(i.line, i.character),
                    Position::new(i.end_line, i.end_character),
                )],
            })
        })
        .collect();
    Ok(serde_json::to_value(result)?)
}

// ── Helpers ────────────────────────────────────────────────────────

/// Convert a sidecar hierarchy item into an LSP `CallHierarchyItem`.
fn map_hierarchy_item(item: &SidecarHierarchyItem) -> Option<CallHierarchyItem> {
    let uri = format!("file://{}", item.file_path);
    let parsed_uri = uri.parse::<Uri>().ok()?;
    Some(CallHierarchyItem {
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
        "Function" => SymbolKind::FUNCTION,
        "Constructor" => SymbolKind::CONSTRUCTOR,
        "Property" => SymbolKind::PROPERTY,
        "Field" => SymbolKind::FIELD,
        "Class" => SymbolKind::CLASS,
        "Interface" => SymbolKind::INTERFACE,
        "Struct" => SymbolKind::STRUCT,
        "Enum" => SymbolKind::ENUM,
        "Module" | "Namespace" => SymbolKind::MODULE,
        _ => SymbolKind::METHOD,
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

/// A hierarchy item returned by the sidecar for call hierarchy requests.
#[derive(serde::Deserialize)]
struct SidecarHierarchyItem {
    /// Display name of the symbol.
    name: String,
    /// Symbol kind string (e.g. "Function", "Class").
    kind: String,
    /// Absolute path to the file containing this symbol.
    file_path: String,
    /// Start line of the symbol range.
    line: u32,
    /// Start character offset within the start line.
    character: u32,
    /// End line of the symbol range.
    end_line: u32,
    /// End character offset within the end line.
    end_character: u32,
}
