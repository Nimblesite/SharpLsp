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
    CodeDescription, Diagnostic, DiagnosticSeverity, NumberOrString, Position,
    PublishDiagnosticsParams, Range, Uri,
};
use tracing::{debug, info, warn};

use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

mod policy;

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
    /// The rule's documentation link (`DiagnosticDescriptor.HelpLinkUri`);
    /// empty when the source sidecar sends none ([DIAG-CATEGORIES-ANALYZER]).
    #[serde(default)]
    help_link: String,
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
    mut generation: u64,
    sender: crossbeam_channel::Sender<Message>,
) -> Option<PushTarget> {
    loop {
        let (sidecar, uri, file_path) = &target;
        let source_tag = source_tag_for_uri(uri);
        match publish_once(sidecar, &sender, uri, file_path, &source_tag, generation).await {
            Ok(again) if is_current(uri, generation) => return again.then_some(target),
            Ok(_) => generation = next_generation(uri),
            Err(err) => {
                warn!(uri = %uri.as_str(), "Sidecar diagnostics unavailable: {err:#}");
                return Some(target);
            }
        }
    }
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
        debug!(
            uri = uri.as_str(),
            generation,
            current = *current,
            "Diagnostic publication superseded"
        );
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
    let path = crate::paths::uri_to_path(uri.as_str()).unwrap_or_else(|_| uri.as_str().to_owned());
    source_tag_for_path(&path).to_owned()
}

/// The diagnostic source of every Razor diagnostic, C# and `RZ` alike.
/// [RAZOR-ARCHITECTURE-ROUTING]
const RAZOR_SOURCE: &str = "sharplsp-razor";

/// Determine the diagnostic source tag from a native document path.
fn source_tag_for_path(file_path: &str) -> &'static str {
    if crate::paths::is_fsharp_diagnostic_input(file_path) {
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

/// Fetch actual compiler truth with the caller's cancellation lifetime.
pub async fn fetch_from_sidecar(
    sidecar: &SidecarManager,
    file_path: &str,
    cancel: Option<&lspkit_server::CancellationToken>,
) -> Result<Vec<Diagnostic>> {
    let diagnostics =
        fetch_cancellable(sidecar, file_path, source_tag_for_path(file_path), cancel).await?;
    policy::configured(diagnostics)
}

/// Fetch diagnostics from the sidecar for a single file.
async fn fetch(
    sidecar: &SidecarManager,
    file_path: &str,
    source_tag: &str,
) -> Result<Vec<Diagnostic>> {
    fetch_cancellable(sidecar, file_path, source_tag, None).await
}

/// The context every compiler diagnostics request's failure carries.
pub(crate) const DIAGNOSTICS_REQUEST: &str = "sidecar diagnostics request";

/// Request fresh compiler findings under the caller's execution lifetime.
async fn fetch_cancellable(
    sidecar: &SidecarManager,
    file_path: &str,
    source_tag: &str,
    cancel: Option<&lspkit_server::CancellationToken>,
) -> Result<Vec<Diagnostic>> {
    let payload = rmp_serde::to_vec(file_path).context("serialize file path")?;
    let method = if crate::paths::has_extension(file_path, &["csproj", "fsproj"]) {
        "workspace/diagnostics/project"
    } else {
        "workspace/diagnostics"
    };
    let response_bytes = sidecar
        .request_cancellable(method, payload, cancel)
        .await
        .context(DIAGNOSTICS_REQUEST)?;
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
    let diagnostics = policy::configured(diagnostics)?;
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
        code_description: code_description(&result.help_link),
        source: Some(source_tag.to_string()),
        message: result.message,
        ..Diagnostic::default()
    }
}

/// The rule's documentation page as LSP `codeDescription.href`, so the
/// editor links each finding to its rule exactly as the official C# extension
/// does ([DIAG-CATEGORIES-ANALYZER]). Absent when the sidecar sent no link; a
/// link that is not a valid URI is dropped with a trace, never a panic.
fn code_description(help_link: &str) -> Option<CodeDescription> {
    if help_link.is_empty() {
        return None;
    }
    match help_link.parse::<Uri>() {
        Ok(href) => Some(CodeDescription { href }),
        Err(error) => {
            debug!(help_link, %error, "Dropping malformed diagnostic help link");
            None
        }
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
#[path = "diagnostics/diagnostics_tests.rs"]
mod tests;
