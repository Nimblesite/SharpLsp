//! Diagnostics pipeline: sidecar → LSP `textDocument/publishDiagnostics`.
//!
//! Supports both single-file diagnostics (on edit) and solution-wide
//! analysis (on solution load). Solution-wide results are streamed
//! incrementally — one `publishDiagnostics` notification per file.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{Context, Result};
use dashmap::DashMap;
use lsp_server::{Message, Notification};
use lsp_types::{
    Diagnostic, DiagnosticSeverity, NumberOrString, Position, PublishDiagnosticsParams, Range, Uri,
};
use tracing::{info, warn};

use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// Delay between retries of a failed push fetch. [DIAG-PUSH-GATE]
const PUSH_RETRY_DELAY: Duration = Duration::from_secs(1);

/// Retry budget for one push generation. Generous enough to ride out a
/// sidecar kill + respawn (backoff caps at 30s); a superseding edit ends the
/// loop early. [DIAG-PUSH-GATE]
const MAX_PUSH_ATTEMPTS: u32 = 120;

/// Latest push generation per document URI. Implements [DIAG-PUSH-GATE]
/// (GitHub #160): a completed fetch older than the newest known text must not
/// publish, and the newest generation must retry on failure until published
/// or superseded. Entries are monotonic and never removed — reusing a counter
/// after didClose would let an ancient in-flight fetch match a fresh
/// generation and publish stale results.
static PUSH_GENERATIONS: LazyLock<DashMap<String, u64>> = LazyLock::new(DashMap::new);

/// Wire type matching C# `DiagnosticResult` `[Key(N)]` ordering.
///
/// Field order is significant — `MessagePack` uses positional keys.
#[derive(serde::Deserialize)]
struct SidecarDiagnostic {
    /// Original file path (unused; kept for positional `MessagePack` alignment).
    _file_path: String,
    /// Zero-based start line of the diagnostic span.
    start_line: u32,
    /// Zero-based start column of the diagnostic span.
    start_character: u32,
    /// Zero-based end line of the diagnostic span.
    end_line: u32,
    /// Zero-based end column of the diagnostic span.
    end_character: u32,
    /// Human-readable diagnostic message.
    message: String,
    /// Roslyn severity string (`Error`, `Warning`, `Info`, or `Hidden`).
    severity: String,
    /// Compiler or analyzer diagnostic code (e.g. `CS0219`).
    code: String,
}

/// Wire type matching C# `SolutionDiagnosticsRequest` `[Key(N)]` ordering.
#[derive(serde::Serialize)]
struct SolutionDiagnosticsRequest {
    /// Optional list of project paths to restrict analysis to.
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
    let source_tag = source_tag_for_uri(&uri);
    let generation = next_generation(&uri);
    let _handle = runtime.spawn(async move {
        fetch_and_publish_gated(&sidecar, &sender, &uri, &file_path, &source_tag, generation).await;
    });
}

/// Register a new push generation for `uri`, superseding in-flight fetches.
/// [DIAG-PUSH-GATE]
fn next_generation(uri: &Uri) -> u64 {
    let mut entry = PUSH_GENERATIONS.entry(uri.to_string()).or_insert(0);
    *entry += 1;
    *entry
}

/// Whether `generation` is still the newest push generation for `uri`.
fn is_current(uri: &Uri, generation: u64) -> bool {
    PUSH_GENERATIONS
        .get(uri.as_str())
        .is_some_and(|current| *current == generation)
}

/// Publish only when `generation` is still the newest for the document. The
/// map entry guard is held across the (non-blocking) send so publications for
/// one document cannot interleave out of generation order. [DIAG-PUSH-GATE]
fn publish_if_current(
    sender: &crossbeam_channel::Sender<Message>,
    uri: &Uri,
    generation: u64,
    diagnostics: Vec<Diagnostic>,
) -> Result<bool> {
    let Some(current) = PUSH_GENERATIONS.get(uri.as_str()) else {
        return Ok(false);
    };
    if *current != generation {
        return Ok(false);
    }
    publish(sender, uri.clone(), diagnostics)?;
    Ok(true)
}

/// Fetch diagnostics and publish them under the generation gate, retrying
/// while this generation is still the newest text. Dropping a failed fetch
/// for the *last* edit would leave the previous publication — possibly an
/// error set for text that no longer exists — on screen forever; that is the
/// phantom-diagnostics bug of GitHub #160. [DIAG-PUSH-GATE]
async fn fetch_and_publish_gated(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    uri: &Uri,
    file_path: &str,
    source_tag: &str,
    generation: u64,
) {
    for attempt in 1..=MAX_PUSH_ATTEMPTS {
        if !is_current(uri, generation) {
            return;
        }
        match fetch(sidecar, file_path, source_tag).await {
            Ok(diagnostics) => {
                if let Err(err) = publish_if_current(sender, uri, generation, diagnostics) {
                    warn!("Failed to publish diagnostics: {err:#}");
                }
                return;
            }
            Err(err) => {
                warn!("Sidecar diagnostics unavailable (attempt {attempt}): {err:#}");
            }
        }
        tokio::time::sleep(PUSH_RETRY_DELAY).await;
    }
    warn!(
        uri = %uri.as_str(),
        "Diagnostics push gave up after {MAX_PUSH_ATTEMPTS} attempts; last published state may be stale"
    );
}

/// Determine the diagnostic source tag based on the document language.
fn source_tag_for_uri(uri: &Uri) -> String {
    match crate::tree_sitter_parse::LangId::from_uri(uri) {
        Some(crate::tree_sitter_parse::LangId::FSharp) => "sharplsp-fsharp".to_string(),
        _ => "sharplsp-csharp".to_string(),
    }
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
    vfs: Arc<Vfs>,
) {
    let _handle = tokio::spawn(async move {
        match fetch_all(&sidecar, &project_filter).await {
            Ok(file_diagnostics) => {
                let file_count = file_diagnostics.len();
                // Collect files with errors/warnings for verification pass.
                let mut error_files: Vec<String> = Vec::new();
                for (file_path, diagnostics) in &file_diagnostics {
                    let has_issues = diagnostics.iter().any(|d| {
                        d.severity == Some(DiagnosticSeverity::ERROR)
                            || d.severity == Some(DiagnosticSeverity::WARNING)
                    });
                    if has_issues {
                        error_files.push(file_path.clone());
                    }
                }
                for (file_path, diagnostics) in file_diagnostics {
                    let uri = match crate::utils::path_to_lsp_uri(&file_path) {
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

                // Verification pass: re-check files with errors/warnings.
                if !error_files.is_empty() {
                    info!(
                        "Starting verification pass for {} file(s) with errors/warnings",
                        error_files.len()
                    );
                    verify_error_files(&sidecar, &sender, &error_files, &vfs).await;
                }
            }
            Err(err) => {
                warn!("Solution-wide diagnostics unavailable: {err:#}");
            }
        }
    });
}

/// Low-priority verification pass: re-check files that had errors or
/// warnings during the initial solution-wide scan.
///
/// The initial `GetCompilationAsync` may return incomplete results
/// (unresolved references, pending source generators). This pass
/// re-reads each file from disk, sends `textDocument/didChange` to
/// update the sidecar's in-memory compilation, then re-fetches
/// diagnostics. Files that still have errors are real — files where
/// errors disappeared were false positives that get cleared.
async fn verify_error_files(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    error_files: &[String],
    vfs: &Vfs,
) {
    // Small delay to let the workspace settle after initial load.
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    for file_path in error_files {
        let source_tag = match std::path::Path::new(file_path.as_str()).extension() {
            Some(ext) if ext.eq_ignore_ascii_case("fs") || ext.eq_ignore_ascii_case("fsx") => {
                "sharplsp-fsharp"
            }
            _ => "sharplsp-csharp",
        };

        // Skip the disk-resync step for documents the editor has open. The
        // VFS holds the live, possibly-unsaved text — overwriting the sidecar
        // with on-disk bytes would silently destroy the editor's edits and
        // leave Roslyn analyzing yesterday's source. Matching must be by
        // native path, not a rebuilt URI: editors percent-encode URIs (VS Code
        // sends `file:///c%3A/…` on Windows), so a rebuilt canonical URI never
        // string-matches the stored key and the guard silently fails open.
        // The canonical retry also unifies 8.3 short names and mapped drives
        // with the editor's long-form spelling. [GitHub #110]
        let in_vfs = vfs.get_content_for_path_canonical(file_path).is_some();

        if !in_vfs {
            // Re-read from disk so the sidecar gets fresh text.
            let disk_text = match tokio::fs::read_to_string(file_path).await {
                Ok(text) => text,
                Err(err) => {
                    info!("Cannot read {file_path} from disk: {err:#}");
                    continue;
                }
            };

            // Update the sidecar's in-memory compilation with disk content.
            if let Err(err) = sync_text_to_sidecar(sidecar, file_path, &disk_text).await {
                warn!("Failed to sync {file_path} to sidecar: {err:#}");
            }
        }

        match fetch(sidecar, file_path, source_tag).await {
            Ok(diagnostics) => {
                let uri = match crate::utils::path_to_lsp_uri(file_path) {
                    Ok(uri) => uri,
                    Err(err) => {
                        warn!("Skip verification for {file_path}: {err:#}");
                        continue;
                    }
                };
                if let Err(err) = publish(sender, uri, diagnostics) {
                    warn!("Failed to publish verified diagnostics for {file_path}: {err:#}");
                }
            }
            Err(err) => {
                info!("Verification fetch failed for {file_path}: {err:#}");
            }
        }

        // Yield between files to avoid starving other sidecar requests.
        tokio::task::yield_now().await;
    }

    info!(
        "Verification pass complete for {} file(s)",
        error_files.len()
    );
}

/// Send `textDocument/didChange` to the sidecar with fresh text.
async fn sync_text_to_sidecar(
    sidecar: &SidecarManager,
    file_path: &str,
    new_text: &str,
) -> Result<()> {
    let request = crate::semantic::SidecarDidChangeReq {
        file_path: file_path.to_string(),
        new_text: new_text.to_string(),
    };
    let payload = rmp_serde::to_vec(&request).context("serialize didChange")?;
    let _response = sidecar
        .request("textDocument/didChange", payload)
        .await
        .context("sidecar didChange for verification")?;
    Ok(())
}

/// Clear diagnostics for a closed document. Bumps the push generation so any
/// in-flight fetch for the just-closed text cannot republish afterwards.
/// [DIAG-PUSH-GATE]
pub fn clear(sender: &crossbeam_channel::Sender<Message>, uri: Uri) -> Result<()> {
    let _superseding = next_generation(&uri);
    publish(sender, uri, vec![])
}

/// Fetch diagnostics from the sidecar for a single file (public for pull diagnostics).
pub async fn fetch_from_sidecar(
    sidecar: &SidecarManager,
    file_path: &str,
) -> Result<Vec<Diagnostic>> {
    fetch(sidecar, file_path, "sharplsp-csharp").await
}

/// Fetch diagnostics from the sidecar for a single file.
async fn fetch(
    sidecar: &SidecarManager,
    file_path: &str,
    source_tag: &str,
) -> Result<Vec<Diagnostic>> {
    let payload = rmp_serde::to_vec(file_path).context("serialize file path")?;
    let response_bytes = sidecar
        .request("workspace/diagnostics", payload)
        .await
        .context("sidecar diagnostics request")?;
    let results: Vec<SidecarDiagnostic> =
        rmp_serde::from_slice(&response_bytes).context("deserialize diagnostics")?;
    Ok(results
        .into_iter()
        .map(|r| to_lsp_diagnostic(r, source_tag))
        .collect())
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
        .map(|(path, diags)| {
            (
                path,
                diags
                    .into_iter()
                    .map(|d| to_lsp_diagnostic(d, "sharplsp-csharp"))
                    .collect(),
            )
        })
        .collect();
    Ok(mapped)
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
fn to_lsp_diagnostic(result: SidecarDiagnostic, source_tag: &str) -> Diagnostic {
    Diagnostic {
        range: Range::new(
            Position::new(result.start_line, result.start_character),
            Position::new(result.end_line, result.end_character),
        ),
        severity: Some(map_severity(&result.severity)),
        code: Some(NumberOrString::String(result.code)),
        source: Some(source_tag.to_string()),
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

        let diag = to_lsp_diagnostic(input, "sharplsp-csharp");

        assert_eq!(diag.range.start, Position::new(10, 4));
        assert_eq!(diag.range.end, Position::new(10, 20));
        assert_eq!(diag.severity, Some(DiagnosticSeverity::WARNING));
        assert_eq!(
            diag.code,
            Some(NumberOrString::String("CS0219".to_string()))
        );
        assert_eq!(diag.source, Some("sharplsp-csharp".to_string()));
        assert_eq!(diag.message, "Unused variable");
    }

    #[test]
    fn path_to_uri_valid_path() {
        use crate::utils::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
        let uri = crate::utils::path_to_lsp_uri(NATIVE_FILE).unwrap();
        assert_eq!(uri.as_str(), NATIVE_FILE_URI);
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

    /// [GitHub #160] Phantom-diagnostics repro at the push-pipeline level.
    ///
    /// Timeline mirroring the `FsToolkit` e2e: an edit introduces a type error
    /// (fetch #1 → Error diagnostic published), the user reverts the edit, and
    /// the revert-triggered fetch #2 FAILS transiently (timeout / respawn /
    /// transport hiccup). The revert is the last edit, so nothing else will
    /// ever re-trigger a push — the pipeline itself must converge: a failed
    /// fetch for the newest text must be retried until the latest generation
    /// is published, never dropped. Dropping it strands the stale Error in the
    /// editor's push collection forever, exactly the "error never clears"
    /// symptom of #160.
    #[test]
    fn failed_fetch_after_revert_must_not_strand_stale_published_diagnostics() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (host_side, sidecar_side) = tokio::io::duplex(64 * 1024);
        let manager = runtime.block_on(async {
            Arc::new(
                crate::sidecar::manager::SidecarManager::connected_to_stream_for_tests(host_side)
                    .await,
            )
        });

        // Scripted sidecar: #1 → error diagnostic (broken text), #2 → transient
        // failure (the post-revert fetch), #3.. → clean (the reverted text).
        let error_payload = rmp_serde::to_vec(&vec![(
            "X.fs".to_string(),
            0u32,
            0u32,
            0u32,
            5u32,
            "type mismatch".to_string(),
            "Error".to_string(),
            "FS0001".to_string(),
        )])
        .unwrap();
        let clean_payload = rmp_serde::to_vec::<Vec<i32>>(&vec![]).unwrap();
        let _sidecar_task = runtime.spawn(fake_scripted_sidecar(
            sidecar_side,
            error_payload,
            clean_payload,
        ));

        let (sender, receiver) = crossbeam_channel::unbounded();
        let uri: Uri = "file:///x.fs".parse().unwrap();

        // Edit 1: broken text — the error surfaces (repro precondition).
        request_in_background(
            &runtime,
            Arc::clone(&manager),
            sender.clone(),
            uri.clone(),
            "X.fs".to_string(),
        );
        let first = recv_publication(&receiver, std::time::Duration::from_secs(10));
        assert_eq!(
            first.diagnostics.len(),
            1,
            "the broken text must publish its error"
        );

        // Edit 2: the revert — this fetch fails transiently. The pipeline must
        // keep retrying for the newest text and publish the clean result.
        request_in_background(&runtime, manager, sender, uri, "X.fs".to_string());
        let converged = recv_publication(&receiver, std::time::Duration::from_secs(10));
        assert!(
            converged.diagnostics.is_empty(),
            "after the revert the pipeline must converge to a clean publication \
             even when a fetch fails transiently — stale errors published for \
             older text must never remain the final state (GitHub #160); got: {:?}",
            converged
                .diagnostics
                .iter()
                .map(|d| &d.message)
                .collect::<Vec<_>>()
        );
    }

    /// Scripted in-memory sidecar: response #1 carries `error_payload`,
    /// response #2 is a transient envelope error, responses #3+ carry
    /// `clean_payload`.
    async fn fake_scripted_sidecar(
        stream: tokio::io::DuplexStream,
        error_payload: Vec<u8>,
        clean_payload: Vec<u8>,
    ) {
        let mut transport = crate::sidecar::transport::FramedTransport::from_stream(stream);
        let mut request_count = 0u32;
        while let Ok(Some(request)) = transport.read_envelope().await {
            request_count += 1;
            let response = match request_count {
                1 => crate::sidecar::protocol::Envelope {
                    id: request.id,
                    method: None,
                    payload: error_payload.clone(),
                    error: None,
                },
                2 => crate::sidecar::protocol::Envelope {
                    id: request.id,
                    method: None,
                    payload: Vec::new(),
                    error: Some("transient transport failure".to_string()),
                },
                _ => crate::sidecar::protocol::Envelope {
                    id: request.id,
                    method: None,
                    payload: clean_payload.clone(),
                    error: None,
                },
            };
            if transport.write_envelope(&response).await.is_err() {
                break;
            }
        }
    }

    /// Receive the next `publishDiagnostics` notification within `timeout`.
    fn recv_publication(
        receiver: &crossbeam_channel::Receiver<Message>,
        timeout: std::time::Duration,
    ) -> PublishDiagnosticsParams {
        match receiver.recv_timeout(timeout) {
            Ok(Message::Notification(n)) => {
                assert_eq!(n.method, "textDocument/publishDiagnostics");
                serde_json::from_value(n.params).unwrap()
            }
            Ok(other) => panic!("expected publishDiagnostics notification, got {other:?}"),
            Err(err) => panic!(
                "no publishDiagnostics arrived within {timeout:?} ({err}) — the pipeline \
                 dropped the publication and stale diagnostics remain (GitHub #160)"
            ),
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
