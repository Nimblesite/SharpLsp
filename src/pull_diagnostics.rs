//! Pull diagnostics handlers (LSP 3.17).
//!
//! Implements `textDocument/diagnostic` and `workspace/diagnostic` — the
//! request-based (pull) model that VS Code's web client (`code serve-web`)
//! requires in addition to the push model (`publishDiagnostics`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    DocumentDiagnosticParams, DocumentDiagnosticReport, DocumentDiagnosticReportResult,
    FullDocumentDiagnosticReport, RelatedFullDocumentDiagnosticReport,
    WorkspaceDiagnosticReport, WorkspaceDiagnosticReportResult,
};
use tracing::{debug, warn};

use crate::diagnostics;
use crate::semantic::uri_to_path;
use crate::sidecar::manager::SidecarManager;

/// Handle `textDocument/diagnostic` — return diagnostics for a single file.
pub fn handle_document_diagnostic(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: DocumentDiagnosticParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document.uri;

    let items = match sidecar {
        Some(sc) => {
            let file_path = uri_to_path(uri)?;
            debug!(file = %file_path, "Pull diagnostics for document");
            match runtime.block_on(diagnostics::fetch_from_sidecar(sc, &file_path)) {
                Ok(diags) => diags,
                Err(err) => {
                    warn!("Pull diagnostics unavailable: {err:#}");
                    vec![]
                }
            }
        }
        None => vec![],
    };

    let report = DocumentDiagnosticReportResult::Report(DocumentDiagnosticReport::Full(
        RelatedFullDocumentDiagnosticReport {
            related_documents: None,
            full_document_diagnostic_report: FullDocumentDiagnosticReport {
                result_id: None,
                items,
            },
        },
    ));

    Ok(serde_json::to_value(report)?)
}

/// Handle `workspace/diagnostic` — return diagnostics for the workspace.
pub fn handle_workspace_diagnostic(
    req: Request,
) -> Result<serde_json::Value> {
    // Parse params to validate the request shape, but we don't use them yet.
    let _params: lsp_types::WorkspaceDiagnosticParams = serde_json::from_value(req.params)?;

    debug!("Pull diagnostics for workspace (returning empty for now)");

    let report = WorkspaceDiagnosticReportResult::Report(WorkspaceDiagnosticReport {
        items: vec![],
    });

    Ok(serde_json::to_value(report)?)
}
