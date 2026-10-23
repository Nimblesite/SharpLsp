//! Opening a workspace in a sidecar, choosing the solution the C# sidecar
//! opens, and telling the user when it cannot open one. Implements
//! [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use crossbeam_channel::Sender;
use lsp_server::{Message, Notification};
use lsp_types::notification::{Notification as _, ShowMessage};
use lsp_types::{MessageType, ShowMessageParams};
use serde_json::Value;
use tracing::{error, info, warn};

use crate::config::{AnalyzersConfig, SharpLspConfig};
use crate::configuration::Configuration;
use crate::diagnostics;
use crate::paths::native_paths_equal;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// What follows a sidecar's `workspace/open`: its analyzers, the solution-wide
/// diagnostics scan, and where a failure is shown.
pub(crate) struct OpenFollowUp {
    /// Standard and static analyzer opt-out applies before the first pull.
    analyzers_enabled: bool,
    /// Pushed to the sidecar once the workspace opens.
    analyzers: AnalyzersConfig,
    /// Where solution-wide diagnostics publish, and the projects they cover;
    /// `None` when the scan is off.
    diagnostics: Option<(Sender<Message>, Vec<String>)>,
    /// Where an open failure is shown; `None` when no one should see it.
    report: Option<Sender<Message>>,
    /// Consulted by the diagnostics scan so it never clobbers live edits.
    vfs: Arc<Vfs>,
}

impl OpenFollowUp {
    /// The follow-up `config` asks for. `scan` is where solution-wide
    /// diagnostics publish, when `config` enables them.
    pub(crate) fn new(
        config: &SharpLspConfig,
        vfs: &Arc<Vfs>,
        scan: Option<&Sender<Message>>,
        report: Option<&Sender<Message>>,
    ) -> Self {
        let diagnostics = scan
            .filter(|_| config.diagnostics.solution_wide_analysis)
            .map(|sender| (sender.clone(), config.diagnostics.project_filter.clone()));
        Self {
            analyzers_enabled: config.diagnostics.analyzers_enabled,
            analyzers: config.analyzers.clone(),
            diagnostics,
            report: report.cloned(),
            vfs: Arc::clone(vfs),
        }
    }
}

/// Open `target` in a sidecar, then monitor its health. Monitoring waits for
/// `workspace/open`: a health check that races the load can time out on the
/// transport lock and kill a healthy sidecar. A reopen after a failed first
/// open starts it then; one already running is left as it is.
pub(crate) fn start_sidecar(
    sidecar: Option<&Arc<SidecarManager>>,
    target: Option<&PathBuf>,
    follow_up: OpenFollowUp,
    runtime: &tokio::runtime::Runtime,
) {
    if let (Some(sidecar), Some(target)) = (sidecar, target) {
        let sidecar = Arc::clone(sidecar);
        let target = target.to_string_lossy().to_string();
        drop(runtime.spawn(async move {
            if open_and_follow_up(&sidecar, &target, follow_up).await {
                sidecar.start_health_monitor().await;
            }
        }));
    }
}

/// Open `target`, then configure analyzers and start the diagnostics scan.
/// Returns whether the workspace opened; a failure is logged and shown.
async fn open_and_follow_up(
    sidecar: &Arc<SidecarManager>,
    target: &str,
    follow_up: OpenFollowUp,
) -> bool {
    if let Err(err) = open_workspace(sidecar, target).await {
        error!("Failed to open workspace in sidecar: {err:#}");
        if let Some(sender) = &follow_up.report {
            show_open_failure(sender, &err);
        }
        return false;
    }
    configure_analyzers(sidecar, &follow_up.analyzers).await;
    if let Err(error) = configure_diagnostics(sidecar, follow_up.analyzers_enabled).await {
        warn!(%error, "Diagnostic analyzer configuration failed");
    }
    if crate::pull_diagnostics::state::is_pull() {
        crate::pull_diagnostics::state::engine_changed();
        return true;
    }
    if let Some((sender, project_filter)) = follow_up.diagnostics {
        info!("Starting solution-wide diagnostics scan");
        diagnostics::request_solution_in_background(
            Arc::clone(sidecar),
            sender,
            project_filter,
            follow_up.vfs,
        );
    }
    true
}

/// Open the workspace in a sidecar.
pub(crate) async fn open_workspace(sidecar: &SidecarManager, root: &str) -> Result<()> {
    let payload = rmp_serde::to_vec(root).context("serialize workspace path")?;
    let _ = sidecar.request("workspace/open", payload).await?;
    info!("Workspace opened in {} sidecar", sidecar.name());
    Ok(())
}

/// Configure diagnostic analysis without changing compiler-error visibility.
pub(crate) async fn configure_diagnostics(sidecar: &SidecarManager, enabled: bool) -> Result<()> {
    let payload = rmp_serde::to_vec(&(enabled, true))?;
    let _response = sidecar.request("diagnostics/configure", payload).await?;
    Ok(())
}

/// Push analyzer flags from `[analyzers]` in `sharplsp.toml` to a sidecar via
/// `analyzers/configure`. Sidecars that do not register the method ignore it; any
/// failure is logged and never aborts startup. The flags drive the monorepo
/// dead-code analyzer ([ANALYZERS-DEADCODE-SEVERITY]) in both the F# and C# sidecars.
async fn configure_analyzers(sidecar: &SidecarManager, analyzers: &AnalyzersConfig) {
    #[derive(serde::Serialize)]
    struct ConfigureRequest {
        dead_code: bool,
        monorepo: bool,
    }
    let req = ConfigureRequest {
        dead_code: analyzers.dead_code,
        monorepo: analyzers.monorepo,
    };
    match rmp_serde::to_vec(&req) {
        Ok(payload) => match sidecar.request("analyzers/configure", payload).await {
            Ok(_) => info!(
                "Analyzers configured for {} sidecar (dead_code={}, monorepo={})",
                sidecar.name(),
                analyzers.dead_code,
                analyzers.monorepo
            ),
            Err(err) => warn!(
                "analyzers/configure failed for {} sidecar: {err:#}",
                sidecar.name()
            ),
        },
        Err(err) => warn!("serialize analyzers/configure failed: {err:#}"),
    }
}

/// Whether the client chooses the solution itself: VS Code's picker declares
/// `initializationOptions.solutionPicker`, so a root that discovery cannot
/// resolve is the picker's to settle, not an error to show.
pub(crate) fn client_picks_solution(options: Option<&Value>) -> bool {
    options
        .and_then(|options| options.get("solutionPicker"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Show the user why the C# workspace did not open. For a root holding several
/// solutions, the sidecar's error names each one and `csharp.solution_path`.
fn show_open_failure(sender: &Sender<Message>, err: &anyhow::Error) {
    let params = ShowMessageParams {
        typ: MessageType::ERROR,
        message: format!("SharpLsp couldn't open the C# workspace. {err:#}"),
    };
    let notification = Notification::new(ShowMessage::METHOD.to_owned(), params);
    if sender.send(Message::Notification(notification)).is_err() {
        warn!("C# workspace failure not shown: the client connection is closed");
    }
}

/// The solution the C# sidecar opens: `csharp.solution_path` from
/// `sharplsp.toml` or the editor's settings, else the workspace root.
pub(crate) struct SolutionChoice {
    /// The workspace root; `None` in single-file mode, which opens per file.
    root: Option<PathBuf>,
    /// The path the C# sidecar last opened from configuration.
    target: Option<PathBuf>,
    /// The client connection, where diagnostics publish.
    client: Sender<Message>,
    /// Whether open failures are shown: not when the client picks the solution.
    shows_failures: bool,
}

impl SolutionChoice {
    /// The choice `config` makes for `root`, reporting to `client`.
    pub(crate) fn new(
        root: Option<&Path>,
        config: &SharpLspConfig,
        client: &Sender<Message>,
        shows_failures: bool,
    ) -> Self {
        Self {
            root: root.map(Path::to_path_buf),
            target: root.map(|root| config.csharp.open_target(root)),
            client: client.clone(),
            shows_failures,
        }
    }

    /// The path the C# sidecar opens.
    pub(crate) fn target(&self) -> Option<&PathBuf> {
        self.target.as_ref()
    }

    /// Where open failures are shown, when they are.
    pub(crate) fn report(&self) -> Option<&Sender<Message>> {
        self.shows_failures.then_some(&self.client)
    }

    /// Reopen the C# sidecar when a settings change moved its target, so
    /// choosing a solution in the editor takes effect without a restart.
    pub(crate) fn settings_changed(
        &mut self,
        configuration: &Configuration,
        sidecar: Option<&Arc<SidecarManager>>,
        vfs: &Arc<Vfs>,
        runtime: &tokio::runtime::Runtime,
    ) {
        let Some(sidecar) = sidecar else { return };
        let Some((target, config)) = self.moved(configuration) else {
            return;
        };
        let follow_up = OpenFollowUp::new(&config, vfs, Some(&self.client), self.report());
        start_sidecar(Some(sidecar), Some(&target), follow_up, runtime);
    }

    /// The target `configuration` names now, with that configuration, when it
    /// differs from the one last opened. Records it as opened.
    fn moved(&mut self, configuration: &Configuration) -> Option<(PathBuf, SharpLspConfig)> {
        let root = self.root.as_deref()?;
        let config = configuration
            .config()
            .map_err(|err| warn!("Configuration not applied: {err:#}"))
            .ok()?;
        let target = config.csharp.open_target(root);
        let opened = self.target.as_deref().map(Path::to_string_lossy);
        if opened.is_some_and(|opened| native_paths_equal(&opened, &target.to_string_lossy())) {
            return None;
        }
        info!(target = %target.display(), "C# solution changed; reopening the workspace");
        self.target = Some(target.clone());
        Some((target, config))
    }
}

#[cfg(test)]
#[path = "workspace_open_tests.rs"]
mod tests;
