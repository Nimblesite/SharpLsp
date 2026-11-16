//! Diagnostics pipeline: sidecar → LSP `textDocument/publishDiagnostics`.
//!
//! Supports both single-file diagnostics (on edit) and solution-wide
//! analysis (on solution load). Solution-wide results are streamed
//! incrementally — one `publishDiagnostics` notification per file.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use lsp_server::{Message, Notification};
use lsp_types::{Diagnostic, NumberOrString, PublishDiagnosticsParams, Uri};
use tracing::{debug, info, warn};

use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

mod convert;
mod gate;
mod membership;
mod msbuild;
mod policy;
mod restored;

#[cfg(test)]
use convert::map_severity;
use convert::{to_lsp_diagnostic, SidecarDiagnostic};
pub use gate::published_set_is_provisional;
#[cfg(test)]
use gate::PROVISIONAL_PUBLISHED;
use gate::{current_generation, is_current, next_generation, PUSH_GENERATIONS};
pub use membership::reconcile;
pub(crate) use restored::publish_after_restore;

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

/// The same state for an F# script: its `#r "nuget: …"` packages are still
/// being restored and it was checked without them. [SCRIPT-FSX-NUGET]
const SCRIPT_PACKAGES_PENDING_CODE: &str = "SLSPF0002";

/// A document to push diagnostics for: its owning sidecar, URI and native path.
pub type PushTarget = (Arc<SidecarManager>, Uri, String);

/// Spawn a background task to fetch diagnostics and publish them.
///
/// Non-blocking: the main loop continues processing messages while
/// the sidecar computes diagnostics.
pub fn request_in_background(
    runtime: &tokio::runtime::Handle,
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
        request_in_background(runtime.handle(), sidecar, sender.clone(), uri, file_path);
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
        Some(NumberOrString::String(code))
            if code == RESTORE_PENDING_CODE || code == SCRIPT_PACKAGES_PENDING_CODE)
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

/// Publish one document a compiler has just started listing.
async fn publish_entered(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    uri: &Uri,
    path: &str,
) {
    let (tag, generation) = (source_tag_for_path(path), next_generation(uri));
    fetch_and_publish_gated(sidecar, sender, uri, path, tag, generation).await;
}

/// Legacy editors use the same per-document truth with generation-gated pushes.
async fn publish_solution(
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
    filter: &[String],
) -> Result<()> {
    for path in crate::pull_diagnostics::paths_for_sidecar(sidecar, filter).await? {
        let uri = crate::paths::path_to_lsp_uri(&path)?;
        publish_entered(sidecar, sender, &uri, &path).await;
    }
    Ok(())
}

/// Clear diagnostics for a closed document and forget it: retiring its push
/// generation means no in-flight fetch for the just-closed text can republish
/// afterwards. [DIAG-PUSH-GATE]
pub fn clear(sender: &crossbeam_channel::Sender<Message>, uri: Uri) -> Result<()> {
    gate::retire(&uri);
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
    if let Some(owned) = msbuild::host_owned(file_path).await {
        return Ok(owned);
    }
    let compiler = async {
        let payload = rmp_serde::to_vec(file_path).context("serialize file path")?;
        let response_bytes = sidecar
            .request_cancellable(msbuild::sidecar_method(file_path), payload, cancel)
            .await
            .context(DIAGNOSTICS_REQUEST)?;
        let results: Vec<SidecarDiagnostic> =
            rmp_serde::from_slice(&response_bytes).context("deserialize diagnostics")?;
        Ok(results
            .into_iter()
            .map(|r| to_lsp_diagnostic(r, source_tag))
            .collect::<Vec<_>>())
    };
    msbuild::with_host_findings(file_path, compiler.await).await
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

/// Send `textDocument/publishDiagnostics` notification to the editor.
fn publish(
    sender: &crossbeam_channel::Sender<Message>,
    uri: Uri,
    diagnostics: Vec<Diagnostic>,
) -> Result<()> {
    gate::mark_published(&uri, has_restore_pending(&diagnostics));
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

#[cfg(test)]
#[path = "diagnostics/diagnostics_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "diagnostics/retention_tests.rs"]
mod retention_tests;
