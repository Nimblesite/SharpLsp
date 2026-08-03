//! Formatting handlers (`textDocument/formatting`, `rangeFormatting`, `onTypeFormatting`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    DocumentFormattingParams, DocumentOnTypeFormattingParams, DocumentRangeFormattingParams,
};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;
use crate::utils::{map_text_edits, SidecarTextEdit};

/// Handle `textDocument/formatting`.
pub fn handle_formatting(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: DocumentFormattingParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let request = SidecarFileReq { file_path };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("textDocument/formatting", payload))
    {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar formatting unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let edits: Vec<SidecarTextEdit> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} formatting edits from sidecar", edits.len());
    Ok(serde_json::to_value(map_text_edits(&edits))?)
}

/// Handle `textDocument/rangeFormatting`.
pub fn handle_range_formatting(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: DocumentRangeFormattingParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let request = SidecarRangeReq {
        file_path,
        start_line: params.range.start.line,
        start_character: params.range.start.character,
        end_line: params.range.end.line,
        end_character: params.range.end.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/rangeFormatting", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar rangeFormatting unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let edits: Vec<SidecarTextEdit> = rmp_serde::from_slice(&response_bytes)?;
    Ok(serde_json::to_value(map_text_edits(&edits))?)
}

/// Handle `textDocument/onTypeFormatting`.
pub fn handle_on_type_formatting(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: DocumentOnTypeFormattingParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document_position.text_document.uri)?;

    let request = SidecarPositionReq {
        file_path,
        line: params.text_document_position.position.line,
        character: params.text_document_position.position.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/onTypeFormatting", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar onTypeFormatting unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let edits: Vec<SidecarTextEdit> = rmp_serde::from_slice(&response_bytes)?;
    Ok(serde_json::to_value(map_text_edits(&edits))?)
}

// ── Wire types ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct SidecarFileReq {
    file_path: String,
}

#[derive(serde::Serialize)]
struct SidecarRangeReq {
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
}

#[derive(serde::Serialize)]
struct SidecarPositionReq {
    file_path: String,
    line: u32,
    character: u32,
}
