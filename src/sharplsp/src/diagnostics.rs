//! Diagnostics pipeline: sidecar → LSP `textDocument/publishDiagnostics`.
//!
//! Supports both single-file diagnostics (on edit) and solution-wide
//! analysis (on solution load). Solution-wide results are streamed
//! incrementally — one `publishDiagnostics` notification per file.

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

/// A document to push diagnostics for: its owning sidecar, URI and native path.
pub type PushTarget = (Arc<SidecarManager>, Uri, String);

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

/// Publish every target's diagnostics NOW, concurrently, and return once each
/// first answer is out, so whatever the caller sends next follows them. A fetch
/// that failed, or answered a provisional set, goes on as a background push.
/// Implements [NETFX-CONTEXT] and [DIAG-PUSH-GATE].
pub fn publish_now(
    runtime: &tokio::runtime::Runtime,
    targets: Vec<PushTarget>,
    sender: &crossbeam_channel::Sender<Message>,
) {
    let unfinished = runtime.block_on(async {
        let mut pushes = tokio::task::JoinSet::new();
        for target in targets {
            let generation = next_generation(&target.1);
            let _push = pushes.spawn(first_push(target, generation, sender.clone()));
        }
        still_pushing(pushes).await
    });
    for (sidecar, uri, file_path) in unfinished {
        request_in_background(runtime, sidecar, sender.clone(), uri, file_path);
    }
}

/// A target's first fetch and publish; the target back when its push must go on.
async fn first_push(
    target: PushTarget,
    generation: u64,
    sender: crossbeam_channel::Sender<Message>,
) -> Option<PushTarget> {
    let (sidecar, uri, file_path) = &target;
    let source_tag = source_tag_for_uri(uri);
    let again = publish_once(sidecar, &sender, uri, file_path, &source_tag, generation)
        .await
        .unwrap_or_else(|err| {
            warn!(uri = %uri.as_str(), "Sidecar diagnostics unavailable: {err:#}");
            true
        });
    again.then_some(target)
}

/// Every first push finished: the targets whose push must go on.
async fn still_pushing(mut pushes: tokio::task::JoinSet<Option<PushTarget>>) -> Vec<PushTarget> {
    let mut unfinished = Vec::new();
    while let Some(joined) = pushes.join_next().await {
        match joined {
            Ok(again) => unfinished.extend(again),
            Err(err) => warn!("Diagnostics push task failed: {err}"),
        }
    }
    unfinished
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
pub(crate) fn has_restore_pending(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(pending_notice)
}

/// The explicit loading notice, independently of message wording. [DIAG-RESTORE]
fn pending_notice(diagnostic: &Diagnostic) -> bool {
    matches!(&diagnostic.code,
        Some(NumberOrString::String(code)) if code == RESTORE_PENDING_CODE)
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
        match publish_once(sidecar, sender, uri, file_path, source_tag, generation).await {
            Ok(false) => return,
            Ok(true) => {}
            Err(err) => warn!("Sidecar diagnostics unavailable (attempt {attempt}): {err:#}"),
        }
        tokio::time::sleep(PUSH_RETRY_DELAY).await;
    }
    warn!(
        uri = %uri.as_str(),
        "Diagnostics push gave up after {MAX_PUSH_ATTEMPTS} attempts; last published state may be stale"
    );
}

/// One gated fetch and publish. `Ok(true)` when the published set is
/// provisional and the push must go on, `Ok(false)` when it is done or
/// superseded, and the fetch's error when it must retry. [DIAG-PUSH-GATE]
async fn publish_once(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    uri: &Uri,
    file_path: &str,
    source_tag: &str,
    generation: u64,
) -> Result<bool> {
    if sidecar.is_shutting_down() || !is_current(uri, generation) {
        return Ok(false);
    }
    let diagnostics = fetch(sidecar, file_path, source_tag).await?;
    Ok(publish_provisional(sender, uri, generation, diagnostics))
}

/// Determine the diagnostic source tag based on the document language.
fn source_tag_for_uri(uri: &Uri) -> String {
    match crate::tree_sitter_parse::LangId::from_uri(uri) {
        Some(crate::tree_sitter_parse::LangId::FSharp) => "sharplsp-fsharp".to_string(),
        Some(crate::tree_sitter_parse::LangId::Razor) => RAZOR_SOURCE.to_string(),
        _ => "sharplsp-csharp".to_string(),
    }
}

/// The diagnostic source of every Razor diagnostic, C# and `RZ` alike.
/// [RAZOR-ARCHITECTURE-ROUTING]
const RAZOR_SOURCE: &str = "sharplsp-razor";

/// Determine the diagnostic source tag from a native document path.
fn source_tag_for_path(file_path: &str) -> &'static str {
    if crate::paths::has_extension(file_path, &["fs", "fsx", "fsi", "fsscript"]) {
        "sharplsp-fsharp"
    } else if crate::paths::has_extension(file_path, &["razor", "cshtml"]) {
        RAZOR_SOURCE
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
    _vfs: Arc<Vfs>,
) {
    drop(tokio::spawn(async move {
        if let Err(error) = publish_solution(&sidecar, &sender, &project_filter).await {
            warn!(%error, "Solution-wide diagnostics unavailable");
        }
    }));
}

/// Legacy editors use the same per-document truth with generation-gated pushes.
async fn publish_solution(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    filter: &[String],
) -> Result<()> {
    for path in crate::pull_diagnostics::paths_for_sidecar(sidecar, filter).await? {
        let uri = crate::paths::path_to_lsp_uri(&path)?;
        let generation = next_generation(&uri);
        fetch_and_publish_gated(
            sidecar,
            sender,
            &uri,
            &path,
            source_tag_for_path(&path),
            generation,
        )
        .await;
    }
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
    info!(
        uri = params.uri.as_str(),
        count = params.diagnostics.len(),
        codes = ?params
            .diagnostics
            .iter()
            .filter_map(|diagnostic| diagnostic.code.as_ref())
            .collect::<Vec<_>>(),
        "Publishing diagnostics"
    );
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

    /// Razor diagnostics publish under their own source, whether the file is
    /// named by URI (push) or by path (pull and solution-wide).
    /// [RAZOR-ARCHITECTURE-ROUTING]
    #[test]
    fn razor_files_publish_under_the_razor_source() {
        let component: Uri = "file:///c:/app/Board.razor".parse().unwrap();
        let view: Uri = "file:///c:/app/Index.cshtml".parse().unwrap();
        let code: Uri = "file:///c:/app/Program.cs".parse().unwrap();
        assert_eq!(source_tag_for_uri(&component), "sharplsp-razor");
        assert_eq!(source_tag_for_uri(&view), "sharplsp-razor");
        assert_eq!(source_tag_for_uri(&code), "sharplsp-csharp");
        assert_eq!(
            source_tag_for_path("/app/Pages/Board.razor"),
            "sharplsp-razor"
        );
        assert_eq!(
            source_tag_for_path("/app/Views/Index.CSHTML"),
            "sharplsp-razor"
        );
        assert_eq!(source_tag_for_path("/app/Library.fs"), "sharplsp-fsharp");
    }

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
    fn publish_sends_notification() {
        let (sender, receiver) = crossbeam_channel::unbounded();
        let uri: Uri = "file:///tmp/test.cs".parse().unwrap();
        let diag = Diagnostic {
            message: "test diagnostic".to_string(),
            ..Diagnostic::default()
        };

        publish(&sender, uri.clone(), vec![diag]).unwrap();

        let params = next_publish(&receiver);
        assert_eq!(params.uri, uri);
        assert_eq!(params.diagnostics.len(), 1);
        assert_eq!(params.diagnostics[0].message, "test diagnostic");
        assert!(params.version.is_none());
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
        let ScriptedHost {
            runtime,
            manager,
            sender,
            receiver,
        } = scripted_host(Some(error_payload));
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
        let ScriptedHost {
            runtime,
            manager,
            sender,
            receiver,
        } = scripted_host(Some(pending_payload));
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
        let ScriptedHost {
            runtime,
            manager,
            sender,
            receiver,
        } = scripted_host(None);
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

    /// A host connected to a scripted fake sidecar, and the channel the push
    /// pipeline publishes on.
    struct ScriptedHost {
        runtime: tokio::runtime::Runtime,
        manager: Arc<crate::sidecar::manager::SidecarManager>,
        sender: crossbeam_channel::Sender<Message>,
        receiver: crossbeam_channel::Receiver<Message>,
    }

    /// Connect a host to [`fake_scripted_sidecar`], whose first answer is
    /// `first` (a clean set when `None`) and whose later answers are clean.
    fn scripted_host(first: Option<Vec<u8>>) -> ScriptedHost {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (host_side, sidecar_side) = tokio::io::duplex(64 * 1024);
        let manager = runtime.block_on(async {
            Arc::new(
                crate::sidecar::manager::SidecarManager::connected_to_stream_for_tests(host_side)
                    .await,
            )
        });
        let clean = rmp_serde::to_vec::<Vec<i32>>(&vec![]).unwrap();
        let first = first.unwrap_or_else(|| clean.clone());
        drop(runtime.spawn(fake_scripted_sidecar(sidecar_side, first, clean)));
        let (sender, receiver) = crossbeam_channel::unbounded();
        ScriptedHost {
            runtime,
            manager,
            sender,
            receiver,
        }
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

        let params = next_publish(&receiver);
        assert_eq!(params.uri, uri);
        assert!(
            matches!(params.diagnostics.as_slice(), []),
            "{:?}",
            params.diagnostics
        );
    }

    /// The next message on the wire, proven to be a `publishDiagnostics` push.
    fn next_publish(receiver: &crossbeam_channel::Receiver<Message>) -> PublishDiagnosticsParams {
        match receiver.recv().unwrap() {
            Message::Notification(n) => {
                assert_eq!(n.method, "textDocument/publishDiagnostics");
                serde_json::from_value(n.params).unwrap()
            }
            msg => panic!("expected Notification, got {msg:?}"),
        }
    }
}
