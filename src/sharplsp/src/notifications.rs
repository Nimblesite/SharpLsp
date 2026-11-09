//! Document lifecycle notifications (open, change, save, close) and the lazy
//! single-file workspace open that precedes the first one.

use std::collections::HashMap;
use std::sync::Arc;

use lsp_server::{Connection, Notification};
use lsp_types::notification::{
    DidChangeTextDocument, DidCloseTextDocument, DidOpenTextDocument, DidSaveTextDocument,
    Notification as _,
};
use lsp_types::Uri;
use tracing::{error, info, warn};
use tree_sitter::Tree;

use crate::diagnostic_publish::{sidecar_for_uri, trigger_diagnostics};
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::vfs::Vfs;
use crate::{diagnostics, nav_cache, paths, pull_diagnostics, semantic, workspace_open};

/// Everything a document notification touches: the host's own document state
/// and the channels that carry its consequences to the sidecars and the client.
pub(crate) struct DocumentContext<'a> {
    /// Open document text.
    pub(crate) vfs: &'a Vfs,
    /// Tree-sitter parsers for the host's syntax features.
    pub(crate) parsers: &'a TsParsers,
    /// Cached syntax trees per open document.
    pub(crate) trees: &'a mut HashMap<Uri, Tree>,
    /// Cached navigation answers, cleared whenever any text moves.
    pub(crate) nav_cache: &'a mut nav_cache::NavCache,
    /// The client connection diagnostics publish to.
    pub(crate) connection: &'a Connection,
    /// The async runtime sidecar traffic runs on.
    pub(crate) runtime: &'a tokio::runtime::Runtime,
    /// C# then F# sidecar, each absent when disabled.
    pub(crate) sidecars: [Option<&'a Arc<SidecarManager>>; 2],
}

/// Dispatch an incoming LSP notification (open, change, save, close).
pub(crate) fn handle(notif: Notification, ctx: &mut DocumentContext<'_>) {
    match notif.method.as_str() {
        DidOpenTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidOpenTextDocumentParams>(notif.params)
            {
                let doc = params.text_document;
                info!("Opened: {}", doc.uri.as_str());
                pull_diagnostics::state::begin_change();
                ctx.vfs.open(doc.uri.clone(), doc.version, doc.text.clone());
                sync_document(&doc.uri, &doc.text, ctx);
            }
        }
        DidChangeTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidChangeTextDocumentParams>(notif.params)
            {
                let uri = params.text_document.uri;
                let version = params.text_document.version;
                info!("Changed: {} (v{version})", uri.as_str());
                // Full sync — last content change is the full text.
                if let Some(change) = params.content_changes.into_iter().next_back() {
                    pull_diagnostics::state::begin_change();
                    ctx.vfs.change(&uri, version, change.text.clone());
                    // A cached answer can point into the edited file from any other.
                    ctx.nav_cache.clear();
                    sync_document(&uri, &change.text, ctx);
                }
            }
        }
        DidSaveTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidSaveTextDocumentParams>(notif.params)
            {
                info!("Saved: {}", params.text_document.uri.as_str());
                trigger(&params.text_document.uri, ctx);
            }
        }
        DidCloseTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidCloseTextDocumentParams>(notif.params)
            {
                closed(params.text_document.uri, ctx);
            }
        }
        _ => {
            // Ignore unknown notifications per LSP spec.
        }
    }
}

/// Re-parse the new text, hand it to the document's own sidecar and refresh
/// its diagnostics. Routing by language is essential: without it F# edits
/// never reach the F# sidecar, which then resolves hover/completion against
/// stale on-disk text.
fn sync_document(uri: &Uri, text: &str, ctx: &mut DocumentContext<'_>) {
    reparse(ctx.parsers, ctx.trees, uri, text);
    let [csharp, fsharp] = ctx.sidecars;
    if let Ok(file_path) = paths::uri_to_path(uri.as_str()) {
        let sidecar = sidecar_for_uri(uri, csharp, fsharp);
        semantic::notify_did_change(&file_path, text, ctx.runtime, sidecar);
    }
    trigger(uri, ctx);
}

/// Refresh one document's diagnostics.
fn trigger(uri: &Uri, ctx: &DocumentContext<'_>) {
    let [csharp, fsharp] = ctx.sidecars;
    trigger_diagnostics(uri, ctx.runtime, csharp, fsharp, ctx.connection);
}

/// Forget a closed document, then reload its disk text and refresh its
/// diagnostics under the pull model, or clear what the push model published.
fn closed(uri: Uri, ctx: &mut DocumentContext<'_>) {
    info!("Closed: {}", uri.as_str());
    pull_diagnostics::state::begin_change();
    ctx.vfs.close(&uri);
    let _ = ctx.trees.remove(&uri);
    ctx.nav_cache.clear();
    if pull_diagnostics::state::is_pull() {
        if let Err(error) = pull_diagnostics::changes::closed(&uri, ctx.runtime, ctx.sidecars) {
            warn!(%error, "Closed document could not reload disk text");
        }
        trigger(&uri, ctx);
    } else if let Err(err) = diagnostics::clear(&ctx.connection.sender, uri) {
        warn!("Failed to clear diagnostics: {err:#}");
    }
}

/// Re-parse a document with tree-sitter and cache the result.
///
/// We always do a fresh parse (no old tree) because `textDocument/didChange`
/// with full sync replaces the entire document text. Passing a stale old tree
/// without calling `tree.edit()` causes tree-sitter to reuse invalid byte
/// ranges — producing wrong results for longer content and panicking
/// (index out of bounds) for shorter content.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
fn reparse(parsers: &TsParsers, trees: &mut HashMap<Uri, Tree>, uri: &Uri, source: &str) {
    let Some(lang) = LangId::from_uri(uri).filter(|lang| lang.has_grammar()) else {
        return;
    };
    match parsers.parse(lang, source, None) {
        Ok(tree) => {
            let _ = trees.insert(uri.clone(), tree);
        }
        Err(e) => {
            // Remove stale tree so request handlers don't use a mismatched
            // old tree with the updated VFS content.
            let _ = trees.remove(uri);
            warn!("tree-sitter parse failed for {}: {e:#}", uri.as_str());
        }
    }
}

/// Lazily open the workspace for the first opened document when the client supplied no
/// workspace root.
///
/// Returns `true` only when a sidecar workspace was actually opened. Returning `true` for an
/// unsupported document would latch `workspace_initialized` on, so opening a `.md` or `.json`
/// before any source file would permanently prevent the real workspace from loading.
/// Implements [SCRIPT-ROUTE-LAZY].
pub(crate) fn init_workspace_for_file(
    notif: &Notification,
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> bool {
    let Some(file_path) = opened_document_path(notif) else {
        return false;
    };
    let Some(sidecar) = sidecar_for_path(&file_path, sidecars) else {
        return false;
    };

    // The sidecar is given the FILE PATH, not its parent directory. Sending a directory is what
    // forces the sidecar to glob the folder and compile unrelated programs together.
    // Implements [SCRIPT-ROUTE-TARGET].
    info!("No workspace root — opening single-document workspace for {file_path}");
    let sidecar = Arc::clone(sidecar);
    drop(runtime.spawn(async move {
        if let Err(err) = workspace_open::open_workspace(&sidecar, &file_path).await {
            error!("Failed to lazily open workspace: {err:#}");
        }
        drop(tokio::spawn(Arc::clone(&sidecar).start_warm_up()));
        // Health monitoring starts only after workspace/open completes, matching the eager
        // path — a health check that races the load can kill a healthy sidecar.
        // Implements [SCRIPT-ROUTE-HEALTH].
        sidecar.start_health_monitor().await;
    }));
    true
}

/// Extract the file path from a `textDocument/didOpen` notification.
fn opened_document_path(notif: &Notification) -> Option<String> {
    let params =
        serde_json::from_value::<lsp_types::DidOpenTextDocumentParams>(notif.params.clone())
            .ok()?;
    paths::uri_to_path(params.text_document.uri.as_str()).ok()
}

/// Map a document to the sidecar that owns its language. Implements [SCRIPT-DETECT].
///
/// `.fsi` is deliberately absent: a signature file with no owning project has no meaningful
/// semantic closure and is served syntax-only by the host. Implements [SCRIPT-FSX-FSI].
fn sidecar_for_path<'a>(
    file_path: &str,
    [csharp, fsharp]: [Option<&'a Arc<SidecarManager>>; 2],
) -> Option<&'a Arc<SidecarManager>> {
    match paths::extension_key(file_path).as_deref() {
        Some("CS" | "CSX") => csharp,
        Some("FS" | "FSX" | "FSSCRIPT") => fsharp,
        _ => None,
    }
}
