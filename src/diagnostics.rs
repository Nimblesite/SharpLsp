//! Diagnostics pipeline: sidecar → LSP `textDocument/publishDiagnostics`.
//!
//! Supports both single-file diagnostics (on edit) and solution-wide
//! analysis (on solution load). Solution-wide results are streamed
//! incrementally — one `publishDiagnostics` notification per file.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::{Message, Notification};
use lsp_types::{
    Diagnostic, DiagnosticSeverity, NumberOrString, Position, PublishDiagnosticsParams, Range, Uri,
};
use tracing::{info, warn};

use crate::sidecar::manager::SidecarManager;

/// Wire type matching C# `DiagnosticResult` `[Key(N)]` ordering.
///
/// Field order is significant — `MessagePack` uses positional keys.
#[derive(serde::Deserialize)]
struct SidecarDiagnostic {
    _file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    message: String,
    severity: String,
    code: String,
}

/// Wire type matching C# `SolutionDiagnosticsRequest` `[Key(N)]` ordering.
#[derive(serde::Serialize)]
struct SolutionDiagnosticsRequest {
    project_filter: Vec<String>,
}

/// Spawn a background task to fetch diagnostics and publish them.
///
/// Non-blocking: the main loop continues processing messages while
/// the sidecar computes diagnostics.
pub fn request_in_background(
    runtime: &tokio::runtime::Runtime,
    sidecar: Arc<SidecarManager>,
    sender: crossbeam_channel::Sender<Message>,
    uri: Uri,
    file_path: String,
) {
    runtime.spawn(async move {
        match fetch(&sidecar, &file_path).await {
            Ok(diagnostics) => {
                if let Err(err) = publish(&sender, uri, diagnostics) {
                    warn!("Failed to publish diagnostics: {err:#}");
                }
            }
            Err(err) => {
                warn!("Sidecar diagnostics unavailable: {err:#}");
            }
        }
    });
}

/// Spawn a background task to fetch solution-wide diagnostics.
///
/// Results are published incrementally — one notification per file —
/// so the editor receives diagnostics as soon as each file is analyzed.
/// Safe to call from both sync (runtime) and async (`tokio::spawn`) contexts.
pub fn request_solution_in_background(
    sidecar: Arc<SidecarManager>,
    sender: crossbeam_channel::Sender<Message>,
    project_filter: Vec<String>,
) {
    tokio::spawn(async move {
        match fetch_all(&sidecar, &project_filter).await {
            Ok(file_diagnostics) => {
                let file_count = file_diagnostics.len();
                for (file_path, diagnostics) in file_diagnostics {
                    let uri = match path_to_uri(&file_path) {
                        Ok(uri) => uri,
                        Err(err) => {
                            warn!("Skip diagnostics for {file_path}: {err:#}");
                            continue;
                        }
                    };
                    if let Err(err) = publish(&sender, uri, diagnostics) {
                        warn!("Failed to publish diagnostics for {file_path}: {err:#}");
                    }
                }
                info!("Solution-wide diagnostics published for {file_count} file(s)");
            }
            Err(err) => {
                warn!("Solution-wide diagnostics unavailable: {err:#}");
            }
        }
    });
}

/// Clear diagnostics for a closed document.
pub fn clear(sender: &crossbeam_channel::Sender<Message>, uri: Uri) -> Result<()> {
    publish(sender, uri, vec![])
}

/// Fetch diagnostics from the sidecar for a single file (public for pull diagnostics).
pub async fn fetch_from_sidecar(
    sidecar: &SidecarManager,
    file_path: &str,
) -> Result<Vec<Diagnostic>> {
    fetch(sidecar, file_path).await
}

/// Fetch diagnostics from the sidecar for a single file.
async fn fetch(sidecar: &SidecarManager, file_path: &str) -> Result<Vec<Diagnostic>> {
    let payload = rmp_serde::to_vec(file_path).context("serialize file path")?;
    let response_bytes = sidecar
        .request("workspace/diagnostics", payload)
        .await
        .context("sidecar diagnostics request")?;
    let results: Vec<SidecarDiagnostic> =
        rmp_serde::from_slice(&response_bytes).context("deserialize diagnostics")?;
    Ok(results.into_iter().map(to_lsp_diagnostic).collect())
}

/// Fetch diagnostics for all files in the solution, batched by file.
async fn fetch_all(
    sidecar: &SidecarManager,
    project_filter: &[String],
) -> Result<HashMap<String, Vec<Diagnostic>>> {
    let request = SolutionDiagnosticsRequest {
        project_filter: project_filter.to_vec(),
    };
    let payload = rmp_serde::to_vec(&request).context("serialize solution diagnostics request")?;
    let response_bytes = sidecar
        .request("workspace/diagnostics/all", payload)
        .await
        .context("sidecar solution diagnostics request")?;
    let results: HashMap<String, Vec<SidecarDiagnostic>> =
        rmp_serde::from_slice(&response_bytes).context("deserialize solution diagnostics")?;
    let mapped = results
        .into_iter()
        .map(|(path, diags)| (path, diags.into_iter().map(to_lsp_diagnostic).collect()))
        .collect();
    Ok(mapped)
}

/// Convert a filesystem path to a `file://` URI.
fn path_to_uri(path: &str) -> Result<Uri> {
    let uri_string = format!("file://{path}");
    uri_string.parse().context("parse file URI")
}

/// Send `textDocument/publishDiagnostics` notification to the editor.
fn publish(
    sender: &crossbeam_channel::Sender<Message>,
    uri: Uri,
    diagnostics: Vec<Diagnostic>,
) -> Result<()> {
    let params = PublishDiagnosticsParams {
        uri,
        diagnostics,
        version: None,
    };
    let notification = Notification {
        method: "textDocument/publishDiagnostics".to_string(),
        params: serde_json::to_value(params).context("serialize diagnostics params")?,
    };
    sender
        .send(Message::Notification(notification))
        .context("send diagnostics notification")?;
    Ok(())
}

/// Map a sidecar diagnostic to an LSP `Diagnostic`.
fn to_lsp_diagnostic(result: SidecarDiagnostic) -> Diagnostic {
    Diagnostic {
        range: Range::new(
            Position::new(result.start_line, result.start_character),
            Position::new(result.end_line, result.end_character),
        ),
        severity: Some(map_severity(&result.severity)),
        code: Some(NumberOrString::String(result.code)),
        source: Some("forge-csharp".to_string()),
        message: result.message,
        ..Diagnostic::default()
    }
}

/// Map Roslyn severity string to LSP `DiagnosticSeverity`.
fn map_severity(severity: &str) -> DiagnosticSeverity {
    match severity {
        "Error" => DiagnosticSeverity::ERROR,
        "Warning" => DiagnosticSeverity::WARNING,
        "Info" => DiagnosticSeverity::INFORMATION,
        _ => DiagnosticSeverity::HINT,
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn map_severity_error() {
        assert_eq!(map_severity("Error"), DiagnosticSeverity::ERROR);
    }

    #[test]
    fn map_severity_warning() {
        assert_eq!(map_severity("Warning"), DiagnosticSeverity::WARNING);
    }

    #[test]
    fn map_severity_info() {
        assert_eq!(map_severity("Info"), DiagnosticSeverity::INFORMATION);
    }

    #[test]
    fn map_severity_unknown_falls_back_to_hint() {
        assert_eq!(map_severity("Nonsense"), DiagnosticSeverity::HINT);
        assert_eq!(map_severity(""), DiagnosticSeverity::HINT);
    }

    #[test]
    fn to_lsp_diagnostic_maps_all_fields() {
        let input = SidecarDiagnostic {
            _file_path: "/src/main.cs".to_string(),
            start_line: 10,
            start_character: 4,
            end_line: 10,
            end_character: 20,
            message: "Unused variable".to_string(),
            severity: "Warning".to_string(),
            code: "CS0219".to_string(),
        };

        let diag = to_lsp_diagnostic(input);

        assert_eq!(diag.range.start, Position::new(10, 4));
        assert_eq!(diag.range.end, Position::new(10, 20));
        assert_eq!(diag.severity, Some(DiagnosticSeverity::WARNING));
        assert_eq!(
            diag.code,
            Some(NumberOrString::String("CS0219".to_string()))
        );
        assert_eq!(diag.source, Some("forge-csharp".to_string()));
        assert_eq!(diag.message, "Unused variable");
    }

    #[test]
    fn path_to_uri_valid_path() {
        let uri = path_to_uri("/home/user/project/Program.cs").unwrap();
        assert_eq!(uri.as_str(), "file:///home/user/project/Program.cs");
    }

    #[test]
    fn publish_sends_notification() {
        let (sender, receiver) = crossbeam_channel::unbounded();
        let uri: Uri = "file:///tmp/test.cs".parse().unwrap();
        let diag = Diagnostic {
            message: "test diagnostic".to_string(),
            ..Diagnostic::default()
        };

        publish(&sender, uri.clone(), vec![diag]).unwrap();

        let msg = receiver.recv().unwrap();
        match msg {
            Message::Notification(n) => {
                assert_eq!(n.method, "textDocument/publishDiagnostics");
                let params: PublishDiagnosticsParams = serde_json::from_value(n.params).unwrap();
                assert_eq!(params.uri, uri);
                assert_eq!(params.diagnostics.len(), 1);
                assert_eq!(params.diagnostics[0].message, "test diagnostic");
                assert!(params.version.is_none());
            }
            _ => panic!("expected Notification, got {msg:?}"),
        }
    }

    #[test]
    fn clear_sends_empty_diagnostics() {
        let (sender, receiver) = crossbeam_channel::unbounded();
        let uri: Uri = "file:///tmp/test.cs".parse().unwrap();

        clear(&sender, uri.clone()).unwrap();

        let msg = receiver.recv().unwrap();
        match msg {
            Message::Notification(n) => {
                assert_eq!(n.method, "textDocument/publishDiagnostics");
                let params: PublishDiagnosticsParams = serde_json::from_value(n.params).unwrap();
                assert_eq!(params.uri, uri);
                assert!(params.diagnostics.is_empty());
            }
            _ => panic!("expected Notification, got {msg:?}"),
        }
    }
}
