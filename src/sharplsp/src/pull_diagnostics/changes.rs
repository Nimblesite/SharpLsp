//! Sync closed-source disk edits before refreshing compiler truth. [DIAG-LSP-REFRESH]

use std::sync::{Arc, OnceLock};

use anyhow::Result;
use lsp_server::Message;
use lsp_types::{DidChangeWatchedFilesParams, FileChangeType, FileEvent, Uri};
use tokio::sync::mpsc;

use crate::paths;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// One native watched-file batch owed a serialized reload pass. A storm of
/// editor/test fixture writes becomes a burst of these; the worker collapses
/// them so the foreground loop never waits behind a full project-graph reload.
struct ReloadBatch {
    /// Native observation loss (`sharplspRescan`) forces an unconditional reload.
    rescan: bool,
    /// Touched paths owed a reload check and closed-file disk sync.
    changes: Vec<FileEvent>,
}

/// Background owner of watched-file reloads. The foreground loop only enqueues;
/// the worker applies each coalesced batch one at a time on the runtime, so a
/// reload can never stall `sharplsp/configuration`, `sharplsp/hotReload`, test
/// discovery or navigation ([DIAG-LSP-REFRESH], [DIAG-ANALYSIS-CANCELLATION]).
struct ReloadWorker {
    /// Non-blocking queue from the foreground loop to the serialized worker.
    enqueue: mpsc::UnboundedSender<ReloadBatch>,
}

/// One worker per connection; sidecars, VFS and sender are process-stable.
static RELOAD_WORKER: OnceLock<ReloadWorker> = OnceLock::new();

/// Apply watched source changes without clobbering unsaved editor overlays.
pub fn watched(
    params: serde_json::Value,
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Arc<Vfs>,
    sender: &crossbeam_channel::Sender<Message>,
) -> Result<()> {
    let rescan = needs_rescan(&params);
    let params: DidChangeWatchedFilesParams = serde_json::from_value(params)?;
    // Supersede pending diagnostic work before the reload is forwarded
    // ([DIAG-LSP-REFRESH]), then hand the reload itself to the background
    // worker so request handling is never blocked by a compiler-workspace load.
    super::state::invalidate()?;
    if !rescan && params.changes.is_empty() {
        return Ok(());
    }
    reload_worker(runtime, sidecars, vfs, sender)
        .enqueue
        .send(ReloadBatch {
            rescan,
            changes: params.changes,
        })
        .map_err(|_stopped| anyhow::anyhow!("watched-file reload worker stopped"))?;
    Ok(())
}

/// Lazily start the serialized reload worker, capturing the connection's
/// sidecars, VFS and sender once — they are stable for the process lifetime.
fn reload_worker(
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Arc<Vfs>,
    sender: &crossbeam_channel::Sender<Message>,
) -> &'static ReloadWorker {
    RELOAD_WORKER.get_or_init(|| {
        let (enqueue, batches) = mpsc::unbounded_channel();
        let sidecars = sidecars.map(|sidecar| sidecar.map(Arc::clone));
        let vfs = Arc::clone(vfs);
        let sender = sender.clone();
        drop(runtime.spawn(reload_loop(batches, sidecars, vfs, sender)));
        ReloadWorker { enqueue }
    })
}

/// Serialize reload passes and coalesce batches that arrive while one runs.
async fn reload_loop(
    mut batches: mpsc::UnboundedReceiver<ReloadBatch>,
    sidecars: [Option<Arc<SidecarManager>>; 2],
    vfs: Arc<Vfs>,
    sender: crossbeam_channel::Sender<Message>,
) {
    while let Some(first) = batches.recv().await {
        let mut current = first;
        loop {
            // Collapse every batch queued so far into one reload pass.
            while let Ok(next) = batches.try_recv() {
                current.rescan |= next.rescan;
                current.changes.extend(next.changes);
            }
            let sidecar_refs = sidecars.each_ref().map(|sidecar| sidecar.as_ref());
            if let Err(error) = apply_batch(&current, sidecar_refs, &vfs, &sender).await {
                tracing::warn!(%error, "Watched-file reload failed");
            }
            // A batch that landed while the reload ran owes one further pass.
            match batches.try_recv() {
                Ok(next) => current = next,
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => return,
            }
        }
    }
}

/// One reload pass: reload the graph when owed, then sync closed-file disk text.
async fn apply_batch(
    batch: &ReloadBatch,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Arc<Vfs>,
    sender: &crossbeam_channel::Sender<Message>,
) -> Result<()> {
    tracing::info!(
        count = batch.changes.len(),
        rescan = batch.rescan,
        "Diagnostic inputs changed"
    );
    if batch.rescan || requires_reload(&batch.changes, sidecars).await? {
        reload(sidecars, vfs).await?;
    }
    for change in &batch.changes {
        if change.typ == FileChangeType::DELETED {
            continue;
        }
        let path = paths::uri_to_path(change.uri.as_str())?;
        if vfs.get_content_for_path_canonical(&path).is_some() {
            continue;
        }
        if paths::is_diagnostic_source(&path) {
            update_source(&change.uri, &path, sidecars).await?;
        }
    }
    if !super::state::is_pull() {
        let config = super::state::configuration()?;
        if config.solution_wide_analysis {
            for sidecar in sidecars.into_iter().flatten() {
                crate::diagnostics::request_solution_in_background(
                    Arc::clone(sidecar),
                    sender.clone(),
                    config.project_filter.clone(),
                    Arc::clone(vfs),
                );
            }
        }
    }
    super::state::refresh()
}

/// Native input loss has no complete URI list; this internal marker requests full reload.
pub fn needs_rescan(params: &serde_json::Value) -> bool {
    params
        .get("sharplspRescan")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

/// Source additions/deletions and metadata edits alter the loaded compiler snapshot.
async fn requires_reload(
    changes: &[FileEvent],
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> Result<bool> {
    let mut sources = Vec::new();
    for change in changes {
        let path = paths::uri_to_path(change.uri.as_str())?;
        let source = paths::is_user_diagnostic_source(&path);
        if paths::diagnostic_requires_reload(&path)
            || (change.typ != FileChangeType::CHANGED && source)
        {
            return Ok(true);
        }
        if source {
            sources.push(path);
        }
    }
    unknown_sources(&sources, sidecars).await
}

/// Coarse native events also include creations; compare current compiler inputs once per batch.
async fn unknown_sources(
    sources: &[String],
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> Result<bool> {
    if sources.is_empty() {
        return Ok(false);
    }
    let documents = super::documents(sidecars).await?;
    Ok(sources.iter().any(|source| {
        !documents
            .iter()
            .any(|document| paths::native_paths_equal(&document.file_path, source))
    }))
}

/// Reload compiler inputs, then replay live overlays before any diagnostic pull runs.
async fn reload(sidecars: [Option<&Arc<SidecarManager>>; 2], vfs: &Vfs) -> Result<()> {
    for sidecar in sidecars.into_iter().flatten() {
        crate::workspace_open::open_selected_workspace(sidecar).await?;
    }
    let [csharp, fsharp] = sidecars;
    for document in vfs.iter() {
        let path = paths::uri_to_path(document.key().as_str())?;
        let sidecar = match crate::tree_sitter_parse::LangId::from_uri(document.key()) {
            Some(crate::tree_sitter_parse::LangId::FSharp) => fsharp,
            _ => csharp,
        };
        crate::semantic::notify_did_change_async(&path, &document.content, sidecar).await;
    }
    Ok(())
}

/// Complete the actual compiler mutation before dependent pulls are invalidated.
pub fn closed(
    uri: &Uri,
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> Result<()> {
    let path = paths::uri_to_path(uri.as_str())?;
    runtime.block_on(update_source(uri, &path, sidecars))
}

/// Complete the actual compiler mutation before dependent pulls are invalidated.
async fn update_source(
    uri: &Uri,
    path: &str,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> Result<()> {
    let [csharp, fsharp] = sidecars;
    let sidecar = match crate::tree_sitter_parse::LangId::from_uri(uri) {
        Some(crate::tree_sitter_parse::LangId::FSharp) => fsharp,
        _ => csharp,
    };
    let Some(sidecar) = sidecar else {
        return Ok(());
    };
    let request = crate::semantic::SidecarDidChangeReq {
        file_path: path.to_owned(),
        new_text: std::fs::read_to_string(path)?,
    };
    let _response = sidecar
        .request("textDocument/didClose", rmp_serde::to_vec(&request)?)
        .await?;
    Ok(())
}
