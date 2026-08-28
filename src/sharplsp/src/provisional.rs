//! Event-driven convergence between out-of-band sidecar state changes and the
//! diagnostics the editor has been shown.
//!
//! A file-based app is served from tier-2 BCL references while its `#:package`
//! restore runs, and the published diagnostic set for that window is a
//! *provisional* placeholder carrying `SLSPC0002` ([DIAG-PUSH-GATE]). The
//! restore settles inside the sidecar — an event no LSP request triggers — so
//! the sidecar announces it with a `SHARPLSP-EVENT diagnostics-settled <path>`
//! stdout line. This module routes that event:
//!
//! 1. The document's push loop is woken immediately (no polling cadence), so
//!    the corrected set is fetched and published right away.
//! 2. Until that single-flight publish lands, a semantic response that could
//!    reveal the upgraded references is held back (bounded), so the editor
//!    always receives the corrected diagnostics before any answer computed
//!    from them.
//! 3. If no push loop is alive to converge (its budget was exhausted), a
//!    safety republisher performs one gated fetch+publish itself.
//!
//! Ordering rather than timing: the event is emitted under the sidecar's
//! solution mutation lock before any post-upgrade answer can exist, and the
//! push machinery remains the only publisher, so a stale in-flight fetch can
//! never overwrite the settled set as the final publication.
//! Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK] and [DIAG-PUSH-GATE].

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use crossbeam_channel::Sender;
use dashmap::DashMap;
use lsp_server::Message;
use lsp_types::request::{
    CallHierarchyPrepare, CodeActionRequest, CodeLensRequest, Completion,
    DocumentHighlightRequest, DocumentSymbolRequest, GotoDeclaration, GotoDefinition,
    GotoImplementation, GotoTypeDefinition, HoverRequest, InlayHintRequest, PrepareRenameRequest,
    References, Rename, Request, SemanticTokensFullDeltaRequest, SemanticTokensFullRequest,
    SemanticTokensRangeRequest, SignatureHelpRequest, TypeHierarchyPrepare,
};
use lsp_types::Uri;
use tokio::sync::{watch, Notify};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

/// Bound on how long a semantic response may be held while the settle-driven
/// publish is in flight. The normal wait is the tail of one diagnostics
/// fetch; the bound only cuts pathological states (sidecar wedged mid-fetch),
/// where holding hover hostage would be worse than a briefly stale panel.
const SETTLE_PUBLISH_WAIT: Duration = Duration::from_secs(5);

/// Grace period for a live push loop to converge a settle before the safety
/// republisher performs the fetch+publish itself. A live loop converges within
/// one or two fetches; only an exhausted one leaves the settle orphaned.
const ORPHAN_SETTLE_DELAY: Duration = Duration::from_secs(5);

/// Safety-net cadence for a provisional push loop when no settle event
/// arrives (e.g. the sidecar predates the event protocol, or the event was
/// lost with a dying process). The event path makes the normal case instant.
const PROVISIONAL_RETRY_DELAY: Duration = Duration::from_secs(1);

/// Whether the LATEST publication for a URI is a provisional tier-2
/// placeholder. Updated at the single client-publish choke point.
static PROVISIONAL: LazyLock<DashMap<String, bool>> = LazyLock::new(DashMap::new);

/// Documents for which a settle event has arrived but the corrected
/// publication has not yet been sent — the only window in which a semantic
/// response is held. The watch flips to `true` when the publish lands.
static SETTLE_PENDING: LazyLock<DashMap<String, watch::Sender<bool>>> =
    LazyLock::new(DashMap::new);

/// Per-document wakers for provisional push loops, so a settle event replaces
/// the retry cadence with an immediate wake. Entries are tiny and, like push
/// generations, never removed.
static LOOP_WAKERS: LazyLock<DashMap<String, Arc<Notify>>> = LazyLock::new(DashMap::new);

/// Record the outcome of a client publication. A non-provisional publication
/// resolves any pending settle window: the corrected set is on the wire, so
/// held responses may proceed. MUST be called only after the publication was
/// handed to the client channel — resolving first would let a held response
/// overtake the very publication it waited for.
pub fn record_publication(uri: &Uri, provisional: bool) {
    let _ = PROVISIONAL.insert(uri.to_string(), provisional);
    if !provisional {
        resolve_settle(uri);
    }
}

/// Whether the latest publication for `uri` is a tier-2 placeholder that a
/// background restore is about to replace.
pub fn published_set_is_provisional(uri: &Uri) -> bool {
    PROVISIONAL
        .get(uri.as_str())
        .is_some_and(|provisional| *provisional)
}

/// A new push generation supersedes any pending settle window: the settle
/// belonged to text the editor has already replaced, and the new generation's
/// own loop (and its own settle event) governs from here. Called from the
/// push-generation registration. [DIAG-PUSH-GATE]
pub fn cancel_superseded_settle(uri: &Uri) {
    resolve_settle(uri);
}

/// Whether a settle event for `uri` is still awaiting its corrected
/// publication. A provisional push loop skips its retry wait while true.
pub fn settle_is_pending(uri: &Uri) -> bool {
    SETTLE_PENDING.contains_key(uri.as_str())
}

/// The provisional push loop's wait between fetches: an unresolved settle
/// refetches immediately, a settle event wakes instantly, and the safety-net
/// delay covers a lost event. Replaces the former blind 1s cadence.
pub async fn wait_for_retry(uri: &Uri) {
    if settle_is_pending(uri) {
        return;
    }
    let waker = loop_waker(uri);
    let _ = tokio::time::timeout(PROVISIONAL_RETRY_DELAY, waker.notified()).await;
}

/// Hold a semantic response while a settle-driven publish for its document is
/// in flight (bounded by [`SETTLE_PUBLISH_WAIT`]). Outside that window this is
/// a single map lookup. Runs on the dispatch thread but never touches the
/// sidecar transport — it only awaits the publish that the push machinery is
/// already performing.
pub fn wait_for_settle_publication(uri: Option<&Uri>, runtime: &tokio::runtime::Runtime) {
    let Some(uri) = uri else { return };
    let Some(mut receiver) = SETTLE_PENDING
        .get(uri.as_str())
        .map(|entry| entry.subscribe())
    else {
        return;
    };
    let waited = runtime.block_on(tokio::time::timeout(
        SETTLE_PUBLISH_WAIT,
        receiver.wait_for(|published| *published),
    ));
    if waited.is_err() {
        warn!(
            uri = %uri.as_str(),
            "Settled diagnostics were not republished within the wait budget; releasing the response"
        );
        resolve_settle(uri);
    }
}

/// Route a sidecar's out-of-band stdout events. Currently one event exists:
/// `diagnostics-settled <path>` — the sidecar's diagnostics for `<path>`
/// changed without any client request (a package restore settled or
/// terminally failed), so the published set must be reconverged.
pub async fn pump(
    mut events: tokio::sync::mpsc::UnboundedReceiver<String>,
    sidecar: Arc<SidecarManager>,
    sender: Sender<Message>,
) {
    while let Some(event) = events.recv().await {
        match event.strip_prefix("diagnostics-settled ") {
            Some(path) => handle_settled(path.trim(), &sidecar, &sender),
            None => debug!(event = %event, "Ignoring unknown sidecar event"),
        }
    }
}

/// React to one settled path: wake its push loop, and when its published set
/// is provisional, open the settle window that holds semantic responses until
/// the corrected publication lands.
fn handle_settled(path: &str, sidecar: &Arc<SidecarManager>, sender: &Sender<Message>) {
    let Ok(uri) = crate::utils::path_to_lsp_uri(path) else {
        warn!(path = %path, "Sidecar settle event carried an unusable path");
        return;
    };
    if let Some(waker) = LOOP_WAKERS.get(uri.as_str()) {
        waker.notify_one();
    }
    if !published_set_is_provisional(&uri) {
        return;
    }
    if open_settle_window(&uri) {
        drop(tokio::spawn(republish_orphaned_settle(
            uri,
            path.to_string(),
            Arc::clone(sidecar),
            sender.clone(),
        )));
    }
}

/// Open the settle window for `uri`. Returns whether this call opened it —
/// the opener owns the safety republisher, keeping it single-flight.
fn open_settle_window(uri: &Uri) -> bool {
    match SETTLE_PENDING.entry(uri.to_string()) {
        dashmap::mapref::entry::Entry::Occupied(_) => false,
        dashmap::mapref::entry::Entry::Vacant(slot) => {
            let (done, _) = watch::channel(false);
            let _ = slot.insert(done);
            true
        }
    }
}

/// Safety republisher: when no push loop is alive to converge a settle (its
/// retry budget was exhausted before the restore finished), perform one
/// generation-gated fetch+publish so the settle window always resolves and
/// the corrected set still reaches the editor. Any fetch started after the
/// settle observes post-settle state, so this can never regress the
/// publication. Single-flight per settle window.
async fn republish_orphaned_settle(
    uri: Uri,
    path: String,
    sidecar: Arc<SidecarManager>,
    sender: Sender<Message>,
) {
    tokio::time::sleep(ORPHAN_SETTLE_DELAY).await;
    if !settle_is_pending(&uri) {
        return;
    }
    debug!(uri = %uri.as_str(), "No push loop converged a settled restore; republishing directly");
    crate::diagnostics::republish_current(&sidecar, &sender, &uri, &path).await;
}

/// Resolve and close the settle window for `uri`, releasing held responses.
fn resolve_settle(uri: &Uri) {
    if let Some((_uri, done)) = SETTLE_PENDING.remove(uri.as_str()) {
        let _ = done.send(true);
    }
}

/// The per-document waker a provisional push loop parks on.
fn loop_waker(uri: &Uri) -> Arc<Notify> {
    LOOP_WAKERS
        .entry(uri.to_string())
        .or_default()
        .clone()
}

/// The `textDocument.uri` of a request's params, when the request carries one.
pub fn request_document_uri(params: &serde_json::Value) -> Option<Uri> {
    params
        .get("textDocument")
        .and_then(|document| document.get("uri"))
        .and_then(|uri| uri.as_str())
        .and_then(|raw| raw.parse().ok())
}

/// Whether a request's answer can reveal semantic (sidecar) state — the
/// tier-1 reference upgrade in particular — to the editor. An allow-list:
/// only methods whose answers are computed from the sidecar's compilation
/// qualify; everything else (syntax-only, pull-diagnostic, workspace-scoped,
/// custom) never waits. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
pub fn reveals_semantic_state(method: &str) -> bool {
    matches!(
        method,
        Completion::METHOD
            | HoverRequest::METHOD
            | SignatureHelpRequest::METHOD
            | GotoDefinition::METHOD
            | GotoTypeDefinition::METHOD
            | GotoDeclaration::METHOD
            | GotoImplementation::METHOD
            | References::METHOD
            | DocumentHighlightRequest::METHOD
            | DocumentSymbolRequest::METHOD
            | SemanticTokensFullRequest::METHOD
            | SemanticTokensRangeRequest::METHOD
            | SemanticTokensFullDeltaRequest::METHOD
            | InlayHintRequest::METHOD
            | CodeLensRequest::METHOD
            | CodeActionRequest::METHOD
            | PrepareRenameRequest::METHOD
            | Rename::METHOD
            | CallHierarchyPrepare::METHOD
            | TypeHierarchyPrepare::METHOD
    )
}
