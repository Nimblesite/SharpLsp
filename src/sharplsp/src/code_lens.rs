//! Code lens handlers (`textDocument/codeLens`).
//!
//! Returns reference counts and implementation counts above types and members.

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{CodeLens, CodeLensParams, Command, Position, Range};
use tracing::debug;

use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, with_sidecar, SidecarFileReq};

/// Handle `textDocument/codeLens` — returns reference/implementation count lenses.
pub fn handle_code_lens(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: CodeLensParams| {
        let request = SidecarFileReq {
            file_path: crate::paths::uri_to_path(params.text_document.uri.as_str())?,
        };
        let items: Vec<SidecarCodeLens> =
            request_sidecar(runtime, sidecar, "textDocument/codeLens", &request)?
                .unwrap_or_default();
        debug!(count = items.len(), "code lenses from sidecar");
        let lenses: Vec<CodeLens> = items.iter().map(map_code_lens).collect();
        Ok(serde_json::to_value(lenses)?)
    })
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
