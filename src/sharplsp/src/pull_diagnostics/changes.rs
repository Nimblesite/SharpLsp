//! Sync closed-source disk edits before refreshing compiler truth. [DIAG-LSP-REFRESH]

use std::collections::HashSet;
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
    /// Non-restore inputs still require the normal stale-assets gate.
    restore: bool,
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
    for change in &params.changes {
        tracing::debug!(uri = change.uri.as_str(), typ = ?change.typ, "Watched diagnostic input");
    }
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
            restore: restore_required(rescan, &params.changes)?,
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
                current.restore |= next.restore;
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

/// One reload pass: reload the compilers whose graph the batch concerns and sync
/// closed-file disk text,
/// then retire the identities pulls minted while the compiler held the old
/// inputs. A pull can reach the compiler between the watched event and this
/// mutation and memoize pre-change text. [DIAG-LSP-REFRESH] [DIAG-TRUTH-GUARANTEES]
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
    let concerned = super::relevance::concerned(batch.rescan, &batch.changes, sidecars).await?;
    let reloaded = concerned.contains(&true);
    if reloaded {
        reload(sidecars, concerned, vfs, batch.restore).await?;
    }
    let synced = sync_closed_sources(&batch.changes, sidecars, vfs).await?;
    republish_solution(sidecars, vfs, sender)?;
    if reloaded || synced {
        super::state::invalidate()?;
    }
    Ok(())
}

/// Hand the compiler the disk text of every touched source no editor holds
/// open; whether any was handed over.
async fn sync_closed_sources(
    changes: &[FileEvent],
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Vfs,
) -> Result<bool> {
    let mut synced = false;
    for change in changes
        .iter()
        .filter(|change| change.typ != FileChangeType::DELETED)
    {
        let path = paths::uri_to_path(change.uri.as_str())?;
        if vfs.get_content_for_path_canonical(&path).is_none() && paths::is_diagnostic_source(&path)
        {
            update_source(&change.uri, &path, sidecars).await?;
            synced = true;
        }
    }
    Ok(synced)
}

/// Push clients receive the solution-wide republish a pull refresh stands in for.
fn republish_solution(
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Arc<Vfs>,
    sender: &crossbeam_channel::Sender<Message>,
) -> Result<()> {
    let config = super::state::configuration()?;
    if super::state::is_pull() || !config.solution_wide_analysis {
        return Ok(());
    }
    for sidecar in sidecars.into_iter().flatten() {
        crate::diagnostics::request_solution_in_background(
            Arc::clone(sidecar),
            sender.clone(),
            config.project_filter.clone(),
            Arc::clone(vfs),
        );
    }
    Ok(())
}

/// Restore outputs are consumed by this reload; only other inputs can request
/// another restore. A restore after outputs were rewritten or removed rewrites
/// them again and feeds the next batch. [DIAG-RESTORE] [DIAG-LSP-REFRESH]
fn restore_required(rescan: bool, changes: &[FileEvent]) -> Result<bool> {
    changes.iter().try_fold(rescan, |required, change| {
        let path = paths::uri_to_path(change.uri.as_str())?;
        Ok(required || !paths::diagnostic_restore_output(path))
    })
}

/// Native input loss has no complete URI list; this internal marker requests full reload.
pub fn needs_rescan(params: &serde_json::Value) -> bool {
    params
        .get("sharplspRescan")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

/// Reload the compilers a batch concerns: each reopens the workspace it last opened.
async fn reload(
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    concerned: [bool; 2],
    vfs: &Vfs,
    restore: bool,
) -> Result<()> {
    for (sidecar, concerned) in sidecars.into_iter().zip(concerned) {
        if let Some(sidecar) = sidecar.filter(|_| concerned) {
            reopen(sidecar, vfs, restore).await?;
        }
    }
    Ok(())
}

/// Reopen a compiler's workspace under the lock every open holds, so no
/// solution switch slips between the graph captured here and the reopen. The
/// open replays the new graph's buffers; the buffers the previous graph owned
/// replay after it, so an owner adopted for an open file survives the reload
/// and a document an explicit selection excluded is never handed back to owner
/// adoption. [DIAG-TRUTH-RECOVERY] [DIAG-LSP-REFRESH]
async fn reopen(sidecar: &SidecarManager, vfs: &Vfs, restore: bool) -> Result<()> {
    let mut opened = sidecar.lock_workspace().await;
    let Some(target) = opened.target.clone() else {
        return Ok(());
    };
    let owned = graph(sidecar).await?;
    crate::workspace_open::open_workspace_locked(sidecar, &mut opened, &target, restore).await?;
    for overlay in sidecar.overlay_snapshot(vfs, Some(&owned)) {
        let payload = rmp_serde::to_vec(&overlay)?;
        let _response = sidecar.request("textDocument/didChange", payload).await?;
    }
    Ok(())
}

/// The comparison keys of every input the compiler's loaded graph holds.
async fn graph(sidecar: &SidecarManager) -> Result<HashSet<String>> {
    Ok(super::engine_documents(sidecar)
        .await?
        .iter()
        .map(|document| paths::comparison_key(&document.file_path))
        .collect())
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

#[cfg(test)]
#[path = "changes_tests.rs"]
mod tests;
