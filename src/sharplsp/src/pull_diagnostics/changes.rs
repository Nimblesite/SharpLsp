//! Sync closed-source disk edits before refreshing compiler truth. [DIAG-LSP-REFRESH]

use std::sync::Arc;

use anyhow::Result;
use lsp_types::{DidChangeWatchedFilesParams, Uri};

use crate::paths;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// Apply watched source changes without clobbering unsaved editor overlays.
pub fn watched(
    params: serde_json::Value,
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Arc<Vfs>,
    sender: &crossbeam_channel::Sender<lsp_server::Message>,
) -> Result<()> {
    let params: DidChangeWatchedFilesParams = serde_json::from_value(params)?;
    super::state::invalidate()?;
    tracing::info!(count = params.changes.len(), "Diagnostic inputs changed");
    if requires_reload(&params, runtime, sidecars)? {
        reload(runtime, sidecars, vfs)?;
    }
    for change in params.changes {
        if change.typ == lsp_types::FileChangeType::DELETED {
            continue;
        }
        let path = paths::uri_to_path(change.uri.as_str())?;
        if vfs.get_content_for_path_canonical(&path).is_some() {
            continue;
        }
        if paths::has_extension(&path, &["cs", "csx", "fs", "fsi", "fsx", "razor", "cshtml"]) {
            update_source(&change.uri, &path, runtime, sidecars)?;
        }
    }
    if !super::state::is_pull() {
        let config = super::state::configuration()?;
        if config.solution_wide_analysis {
            for sidecar in sidecars.into_iter().flatten() {
                let _entered = runtime.enter();
                crate::diagnostics::request_solution_in_background(
                    Arc::clone(sidecar),
                    sender.clone(),
                    config.project_filter.clone(),
                    Arc::clone(vfs),
                );
            }
        }
    }
    super::state::invalidate()
}

/// Source additions/deletions and metadata edits alter the loaded compiler snapshot.
fn requires_reload(
    params: &DidChangeWatchedFilesParams,
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> Result<bool> {
    let mut sources = Vec::new();
    for change in &params.changes {
        let path = paths::uri_to_path(change.uri.as_str())?;
        let source = paths::is_user_diagnostic_source(&path);
        if paths::diagnostic_requires_reload(&path)
            || (change.typ != lsp_types::FileChangeType::CHANGED && source)
        {
            return Ok(true);
        }
        if source {
            sources.push(path);
        }
    }
    unknown_sources(&sources, runtime, sidecars)
}

/// Coarse native events also include creations; compare current compiler inputs once per batch.
fn unknown_sources(
    sources: &[String],
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> Result<bool> {
    if sources.is_empty() {
        return Ok(false);
    }
    let documents = runtime.block_on(super::documents(sidecars))?;
    Ok(sources.iter().any(|source| {
        !documents
            .iter()
            .any(|document| paths::native_paths_equal(&document.file_path, source))
    }))
}

/// Reload compiler inputs, then replay live overlays before any diagnostic pull runs.
fn reload(
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Vfs,
) -> Result<()> {
    let Some(workspace) = super::state::workspace()? else {
        return Ok(());
    };
    runtime.block_on(async {
        for sidecar in sidecars.into_iter().flatten() {
            crate::workspace_open::open_workspace(sidecar, &workspace).await?;
        }
        Ok::<(), anyhow::Error>(())
    })?;
    let [csharp, fsharp] = sidecars;
    for document in vfs.iter() {
        let path = paths::uri_to_path(document.key().as_str())?;
        let sidecar = match crate::tree_sitter_parse::LangId::from_uri(document.key()) {
            Some(crate::tree_sitter_parse::LangId::FSharp) => fsharp,
            _ => csharp,
        };
        crate::semantic::notify_did_change(&path, &document.content, runtime, sidecar);
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
    update_source(uri, &path, runtime, sidecars)
}

/// Complete the actual compiler mutation before dependent pulls are invalidated.
fn update_source(
    uri: &Uri,
    path: &str,
    runtime: &tokio::runtime::Runtime,
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
    let _response =
        runtime.block_on(sidecar.request("textDocument/didClose", rmp_serde::to_vec(&request)?))?;
    Ok(())
}
