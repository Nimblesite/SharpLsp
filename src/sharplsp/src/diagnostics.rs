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

/// Sidecar code for "the tier-1 file-based restore has not finished yet".
/// While it is present the published set is a provisional tier-2 answer that a
/// background `MSBuild` restore is about to replace, so the push loop keeps
/// re-fetching until it clears. The state is a distinct code — never a phrase
/// inside the message — so this check never parses prose.
/// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
const RESTORE_PENDING_CODE: &str = "SLSPC0002";

/// Latest push generation per document URI. Implements [DIAG-PUSH-GATE]
/// (GitHub #160): a completed fetch older than the newest known text must not
/// publish, and the newest generation must retry on failure until published
/// or superseded. Entries are monotonic and never removed — reusing a counter
/// after didClose would let an ancient in-flight fetch match a fresh
/// generation and publish stale results.
static PUSH_GENERATIONS: LazyLock<DashMap<String, u64>> = LazyLock::new(DashMap::new);

/// URIs whose LATEST publication still carries [`RESTORE_PENDING_CODE`] — a
/// tier-2 placeholder that a background restore is about to replace. While a
/// document is in this set, a semantic response must not be sent to the editor
/// before its diagnostics are re-fetched and republished
/// ([`converge_provisional`]); otherwise completion or hover can reveal the
/// restored tier-1 references while the placeholder's phantom `CS0246`s are
/// still the published truth, and nothing between the reveal and the push
/// loop's next 1s tick corrects them. Updated at the single client-publish
/// choke point ([`publish`]). Implements
/// [SCRIPT-FILEBASED-REFERENCES-FALLBACK] and [DIAG-PUSH-GATE].
static PROVISIONAL_PUBLISHED: LazyLock<DashMap<String, bool>> = LazyLock::new(DashMap::new);

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

/// Publish a fetched set and report whether the loop must keep going.
///
/// A set still carrying [`RESTORE_PENDING_CODE`] is a tier-2 placeholder: the
/// background `MSBuild` restore will replace the project's references, and
/// nothing else would ever re-publish the corrected set, so the editor would
/// keep the placeholder's phantom `CS0246`s forever. Implements
/// [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
fn publish_provisional(
    sender: &crossbeam_channel::Sender<Message>,
    uri: &Uri,
    generation: u64,
    diagnostics: Vec<Diagnostic>,
) -> bool {
    let pending = has_restore_pending(&diagnostics);
    match publish_if_current(sender, uri, generation, diagnostics) {
        Ok(published) => published && pending,
        Err(err) => {
            warn!("Failed to publish diagnostics: {err:#}");
            false
        }
    }
}

/// Whether a fetched set still reports an unfinished file-based restore.
fn has_restore_pending(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.code,
            Some(NumberOrString::String(ref code)) if code == RESTORE_PENDING_CODE
        )
    })
}

/// Fetch diagnostics and publish them under the generation gate, retrying
/// while this generation is still the newest text. Dropping a failed fetch
/// for the *last* edit would leave the previous publication — possibly an
/// error set for text that no longer exists — on screen forever; that is the
/// phantom-diagnostics bug of GitHub #160. [DIAG-PUSH-GATE]
///
/// The loop also continues while the published set is a provisional tier-2
/// answer, so a file-based app's diagnostics are republished once its
/// background restore lands. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
async fn fetch_and_publish_gated(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    uri: &Uri,
    file_path: &str,
    source_tag: &str,
    generation: u64,
) {
    for attempt in 1..=MAX_PUSH_ATTEMPTS {
        if sidecar.is_shutting_down() || !is_current(uri, generation) {
            return;
        }
        match fetch(sidecar, file_path, source_tag).await {
            Ok(diagnostics) => {
                if !publish_provisional(sender, uri, generation, diagnostics) {
                    return;
                }
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

/// Determine the diagnostic source tag from a native document path.
fn source_tag_for_path(file_path: &str) -> &'static str {
    let Some(extension) = std::path::Path::new(file_path)
        .extension()
        .and_then(|extension| extension.to_str())
    else {
        return "sharplsp-csharp";
    };

    if extension.eq_ignore_ascii_case("fs")
        || extension.eq_ignore_ascii_case("fsx")
        || extension.eq_ignore_ascii_case("fsi")
        || extension.eq_ignore_ascii_case("fsscript")
    {
        "sharplsp-fsharp"
    } else {
        "sharplsp-csharp"
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
        let source_tag = source_tag_for_path(file_path);

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
    fetch(sidecar, file_path, source_tag_for_path(file_path)).await
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

/// Whether the latest publication for `uri` is a tier-2 placeholder that a
/// background restore is about to replace. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
pub fn published_set_is_provisional(uri: &Uri) -> bool {
    PROVISIONAL_PUBLISHED
        .get(uri.as_str())
        .is_some_and(|provisional| *provisional)
}

/// Re-fetch and republish `uri`'s diagnostics because a semantic response is
/// about to be sent while the latest publication is still provisional.
///
/// Runs on the response path, BEFORE the response is handed to the editor: on
/// the serialized sidecar transport this fetch is processed strictly after the
/// request that produced the semantic answer, so an answer that reveals the
/// restored tier-1 references is always preceded on the client stream by the
/// corrected diagnostic set. Without this ordering the editor shows the
/// placeholder's phantom `CS0246`s next to a completion list that already
/// binds the package until the push loop's next tick.
/// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK] and [DIAG-PUSH-GATE].
pub async fn converge_provisional(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    uri: &Uri,
    file_path: &str,
) {
    if !published_set_is_provisional(uri) {
        return;
    }
    let Some(generation) = current_generation(uri) else {
        return;
    };
    match fetch(sidecar, file_path, &source_tag_for_uri(uri)).await {
        Ok(diagnostics) => {
            if let Err(err) = publish_if_current(sender, uri, generation, diagnostics) {
                warn!("Failed to republish provisional diagnostics: {err:#}");
            }
        }
        Err(err) => {
            // The gated push loop is still retrying; the response proceeds.
            warn!("Provisional diagnostics re-fetch failed: {err:#}");
        }
    }
}

/// The newest push generation registered for `uri`, if any.
fn current_generation(uri: &Uri) -> Option<u64> {
    PUSH_GENERATIONS
        .get(uri.as_str())
        .map(|generation| *generation)
}

/// Send `textDocument/publishDiagnostics` notification to the editor.
fn publish(
    sender: &crossbeam_channel::Sender<Message>,
    uri: Uri,
    diagnostics: Vec<Diagnostic>,
) -> Result<()> {
    let _ = PROVISIONAL_PUBLISHED.insert(uri.to_string(), has_restore_pending(&diagnostics));
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

    /// A file-based app opens on tier-2 BCL references while `dotnet restore`
    /// runs, so its first diagnostic set is a placeholder carrying phantom
    /// `CS0246`s next to the `SLSPC0002` restore-pending notice. The tier-1
    /// upgrade then swaps the project's references inside the sidecar — an
    /// event the editor cannot observe, and one no further `didChange` follows
    /// when the user is simply reading the file. The push pipeline itself must
    /// therefore keep fetching until the provisional set settles; otherwise the
    /// placeholder's errors stay on screen for the life of the document even
    /// though hover and completion already bind the restored package.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
    #[test]
    fn provisional_filebased_set_must_be_republished_once_restore_settles() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (host_side, sidecar_side) = tokio::io::duplex(64 * 1024);
        let manager = runtime.block_on(async {
            Arc::new(
                crate::sidecar::manager::SidecarManager::connected_to_stream_for_tests(host_side)
                    .await,
            )
        });

        let pending_payload = rmp_serde::to_vec(&vec![
            (
                "App.cs".to_string(),
                1u32,
                6u32,
                1u32,
                16u32,
                "The type or namespace name 'JObject' could not be found".to_string(),
                "Error".to_string(),
                "CS0246".to_string(),
            ),
            (
                "App.cs".to_string(),
                0u32,
                0u32,
                0u32,
                1u32,
                "File-based package restore degraded to BCL-only references: \
                 Restore pending for Newtonsoft.Json@13.0.3."
                    .to_string(),
                "Info".to_string(),
                RESTORE_PENDING_CODE.to_string(),
            ),
        ])
        .unwrap();
        let clean_payload = rmp_serde::to_vec::<Vec<i32>>(&vec![]).unwrap();
        let _sidecar_task = runtime.spawn(fake_scripted_sidecar(
            sidecar_side,
            pending_payload,
            clean_payload,
        ));

        let (sender, receiver) = crossbeam_channel::unbounded();
        let uri: Uri = "file:///app.cs".parse().unwrap();

        // One didOpen — the only client event this document ever gets.
        request_in_background(&runtime, manager, sender, uri, "App.cs".to_string());

        let provisional = recv_publication(&receiver, std::time::Duration::from_secs(10));
        assert!(
            has_restore_pending(&provisional.diagnostics),
            "tier 2 must publish its restore-pending notice immediately"
        );
        assert_eq!(
            provisional.diagnostics.len(),
            2,
            "the placeholder set carries the unresolved package error too"
        );

        let settled = recv_publication(&receiver, std::time::Duration::from_secs(10));
        assert!(
            settled.diagnostics.is_empty(),
            "the tier-1 upgrade must be republished without any further client \
             event — a provisional set is never the final published state; got: {:?}",
            settled
                .diagnostics
                .iter()
                .map(|d| &d.message)
                .collect::<Vec<_>>()
        );
    }

    /// A semantic response for a document whose latest publication is a
    /// provisional tier-2 placeholder must be preceded by a corrected
    /// publication: the response path calls [`converge_provisional`] before
    /// the answer is sent, and that call must re-fetch and republish. Without
    /// it, completion can reveal the restored package while the placeholder's
    /// phantom `CS0246`s stay published until the push loop's next 1s tick —
    /// the window the file-based add/remove/re-add e2e failed in.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK] and [DIAG-PUSH-GATE].
    #[test]
    fn provisional_publication_is_converged_before_a_semantic_response() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (host_side, sidecar_side) = tokio::io::duplex(64 * 1024);
        let manager = runtime.block_on(async {
            Arc::new(
                crate::sidecar::manager::SidecarManager::connected_to_stream_for_tests(host_side)
                    .await,
            )
        });
        let clean_payload = rmp_serde::to_vec::<Vec<i32>>(&vec![]).unwrap();
        let _sidecar_task = runtime.spawn(fake_scripted_sidecar(
            sidecar_side,
            clean_payload.clone(),
            clean_payload,
        ));

        let (sender, receiver) = crossbeam_channel::unbounded();
        let uri: Uri = "file:///converge.cs".parse().unwrap();
        let generation = next_generation(&uri);
        let provisional = vec![Diagnostic {
            code: Some(NumberOrString::String(RESTORE_PENDING_CODE.to_string())),
            message: "Restore pending for Newtonsoft.Json@13.0.3.".to_string(),
            ..Diagnostic::default()
        }];
        assert!(publish_if_current(&sender, &uri, generation, provisional).unwrap());
        let placeholder = recv_publication(&receiver, std::time::Duration::from_secs(5));
        assert!(has_restore_pending(&placeholder.diagnostics));
        assert!(published_set_is_provisional(&uri));

        runtime.block_on(converge_provisional(&manager, &sender, &uri, "Converge.cs"));

        let corrected = recv_publication(&receiver, std::time::Duration::from_secs(5));
        assert!(
            corrected.diagnostics.is_empty(),
            "the convergence fetch must republish the settled set before the \
             semantic response is sent"
        );
        assert!(
            !published_set_is_provisional(&uri),
            "a settled publication must clear the provisional flag"
        );

        // Steady state: a non-provisional publication needs no convergence.
        runtime.block_on(converge_provisional(&manager, &sender, &uri, "Converge.cs"));
        assert!(
            receiver
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "convergence after a settled publication must be a no-op"
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
