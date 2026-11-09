//! `sharplsp/loadSolution` — reload both sidecars with an explicit solution file.
//!
//! The extension sends this when the user selects a solution. Without it, the
//! sidecar receives only the workspace root and picks an arbitrary solution
//! from recursive search, which breaks hover/definition/etc.

use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::{Connection, Message, Request};
use tracing::{error, info, warn};

use crate::config::DiagnosticsConfig;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;
use crate::{diagnostics, pull_diagnostics, workspace_open};

/// Handle `sharplsp/loadSolution`, opening the solution in every running sidecar.
pub(crate) fn handle(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    connection: &Connection,
    vfs: &Arc<Vfs>,
) -> Result<serde_json::Value> {
    let params: serde_json::Value = serde_json::from_value(req.params)?;
    let sln_path = params
        .get("solutionPath")
        .and_then(|v| v.as_str())
        .context("sharplsp/loadSolution requires { solutionPath: string }")?;

    info!("Loading solution: {sln_path}");
    let running: Vec<_> = sidecars.into_iter().flatten().collect();
    // Counted before selection supersedes anything, so no pull sees a gap.
    for _ in &running {
        pull_diagnostics::state::load_started();
    }
    pull_diagnostics::state::select_workspace(sln_path)?;
    let config = pull_diagnostics::state::configuration()?;

    for sidecar in running {
        let sidecar = Arc::clone(sidecar);
        let target = sln_path.to_owned();
        let sender = connection.sender.clone();
        let vfs = Arc::clone(vfs);
        let config = config.clone();
        drop(runtime.spawn(async move {
            open_solution(sidecar, &target, &config, sender, vfs).await;
        }));
    }
    Ok(serde_json::json!({ "success": true }))
}

/// Open `target` in one sidecar, then configure its diagnostics and either
/// hand the pull store the loaded engine or start the push-model solution scan.
async fn open_solution(
    sidecar: Arc<SidecarManager>,
    target: &str,
    config: &DiagnosticsConfig,
    sender: crossbeam_channel::Sender<Message>,
    vfs: Arc<Vfs>,
) {
    let opened = workspace_open::open_workspace(&sidecar, target).await;
    pull_diagnostics::state::load_finished();
    if let Err(err) = opened {
        error!("{} sidecar workspace/open failed: {err:#}", sidecar.name());
        return;
    }
    info!("Solution loaded in {} sidecar", sidecar.name());
    if let Err(error) = workspace_open::configure_diagnostics(
        &sidecar,
        config.analyzers_enabled,
        config.auto_restore_on_open,
    )
    .await
    {
        warn!(%error, sidecar = sidecar.name(), "Diagnostic configuration failed");
    }
    if pull_diagnostics::state::is_pull() {
        pull_diagnostics::state::engine_loaded();
        return;
    }
    diagnostics::request_solution_in_background(sidecar, sender, vec![], vfs);
}
