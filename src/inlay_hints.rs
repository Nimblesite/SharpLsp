//! Inlay hints handler (`textDocument/inlayHint`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{InlayHint, InlayHintKind, InlayHintLabel, InlayHintParams, Position};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

/// Handle `textDocument/inlayHint`.
pub fn handle_inlay_hint(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: InlayHintParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let request = SidecarInlayHintReq {
        file_path,
        start_line: params.range.start.line,
        end_line: params.range.end.line,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("textDocument/inlayHint", payload))
    {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar inlayHint unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let items: Vec<SidecarInlayHint> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} inlay hints from sidecar", items.len());

    let hints: Vec<InlayHint> = items.iter().map(map_inlay_hint).collect();
    Ok(serde_json::to_value(hints)?)
}

/// Convert a sidecar inlay hint to an LSP `InlayHint`.
fn map_inlay_hint(item: &SidecarInlayHint) -> InlayHint {
    InlayHint {
        position: Position::new(item.line, item.character),
        label: InlayHintLabel::String(item.label.clone()),
        kind: Some(match item.kind {
            2 => InlayHintKind::PARAMETER,
            _ => InlayHintKind::TYPE,
        }),
        padding_left: Some(item.kind == 1),
        padding_right: Some(item.kind == 2),
        text_edits: None,
        tooltip: None,
        data: None,
    }
}

// ── Wire types ────────────────────────────────────────────────────

/// Request payload sent to the sidecar for inlay hints.
#[derive(serde::Serialize)]
struct SidecarInlayHintReq {
    /// Absolute path to the source file.
    file_path: String,
    /// Zero-based first visible line.
    start_line: u32,
    /// Zero-based last visible line.
    end_line: u32,
}

/// Wire type for an inlay hint returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarInlayHint {
    /// Zero-based line of the hint position.
    line: u32,
    /// Zero-based column of the hint position.
    character: u32,
    /// Display text for the hint.
    label: String,
    /// Hint kind: 1 = type, 2 = parameter.
    kind: u32,
}
