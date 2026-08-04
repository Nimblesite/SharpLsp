//! Code lens handlers (`textDocument/codeLens`).
//!
//! Returns reference counts and implementation counts above types and members.

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{CodeLens, CodeLensParams, Command, Position, Range};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

/// Handle `textDocument/codeLens` — returns reference/implementation count lenses.
pub fn handle_code_lens(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: CodeLensParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let request = SidecarFileReq { file_path };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("textDocument/codeLens", payload)) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar codeLens unavailable: {err:#}");
            return Ok(serde_json::to_value(Vec::<CodeLens>::new())?);
        }
    };

    let items: Vec<SidecarCodeLens> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} code lenses from sidecar", items.len());

    let lenses: Vec<CodeLens> = items.iter().map(map_code_lens).collect();
    Ok(serde_json::to_value(lenses)?)
}

/// Convert a sidecar code lens into an LSP `CodeLens`.
fn map_code_lens(item: &SidecarCodeLens) -> CodeLens {
    CodeLens {
        range: Range::new(
            Position::new(item.line, item.character),
            Position::new(item.line, item.character),
        ),
        command: Some(Command {
            title: item.title.clone(),
            command: "editor.action.showReferences".to_string(),
            arguments: None,
        }),
        data: None,
    }
}

// ── Wire types ────────────────────────────────────────────────────

/// Request sent to the sidecar identifying a single file.
#[derive(serde::Serialize)]
struct SidecarFileReq {
    /// Absolute path to the source file.
    file_path: String,
}

/// A single code lens returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarCodeLens {
    /// Line number where the lens is displayed.
    line: u32,
    /// Character offset within the line.
    character: u32,
    /// Human-readable label shown above the symbol.
    title: String,
}
