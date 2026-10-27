//! Code lens handlers (`textDocument/codeLens`).
//!
//! Returns reference counts and implementation counts above types and members.
//! Implements [SHARPLSP-FEATURES-CODE-LENS] and [DIAG-ANALYSIS-CANCELLATION].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{CodeLens, CodeLensParams, Command, Position, Range};
use tracing::debug;

use crate::sidecar::manager::SidecarManager;
use crate::utils::{with_sidecar, SidecarFileReq};

/// Handle `textDocument/codeLens` — returns reference/implementation count lenses.
pub fn handle_code_lens(
    req: Request,
    runtime: &tokio::runtime::Handle,
    sidecar: Option<&Arc<SidecarManager>>,
    cancel: &lspkit_server::CancellationToken,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: CodeLensParams| {
        let file_path = crate::paths::uri_to_path(params.text_document.uri.as_str())?;
        let items = request_lenses(runtime, sidecar, file_path, cancel)?;
        debug!(count = items.len(), "code lenses from sidecar");
        let lenses: Vec<CodeLens> = items.iter().map(map_code_lens).collect();
        Ok(serde_json::to_value(lenses)?)
    })
}

/// Decode current compiler lenses without converting cancellation into empty success.
fn request_lenses(
    runtime: &tokio::runtime::Handle,
    sidecar: &SidecarManager,
    file_path: String,
    cancel: &lspkit_server::CancellationToken,
) -> Result<Vec<SidecarCodeLens>> {
    let payload = rmp_serde::to_vec(&SidecarFileReq { file_path })?;
    let bytes = runtime.block_on(sidecar.request_cancellable(
        "textDocument/codeLens",
        payload,
        Some(cancel),
    ))?;
    Ok(rmp_serde::from_slice(&bytes)?)
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
