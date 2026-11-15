//! The background `dotnet restore` that follows a package edit, reported to
//! the editor as `sharplsp/nuget/restoreProgress` notifications. [NUGET-REQUESTS]
//!
//! A successful restore also refreshes vulnerable-package diagnostics: the
//! audit runs during restore, so the scan cache is stale the moment it ends.
//! [PKG-VULN-DIAG]

use std::sync::Arc;

use crossbeam_channel::Sender;
use lsp_server::{Message, Notification};
use tracing::{error, info};

use crate::sidecar::manager::SidecarManager;

use super::{lanes, types};

/// The C# and F# sidecars, in that order: a restored project's diagnostics
/// re-request through the one that owns its language. [PKG-VULN-DIAG]
pub(crate) type Engines<'a> = [Option<&'a Arc<SidecarManager>>; 2];

/// Spawn a background `dotnet restore` for `target` and stream its phases.
/// "Started" is sent synchronously so the UI reacts before the task is scheduled.
pub(super) fn spawn_restore(
    runtime: &tokio::runtime::Runtime,
    sender: Sender<Message>,
    target: &types::NuGetTarget,
    modified_files: Vec<String>,
    [csharp, fsharp]: Engines<'_>,
) {
    let target_id = target.id.clone();
    let target_dir = crate::paths::directory_of(&target.path);
    let lane = lanes::lane(&target.path);
    let owner = if crate::paths::has_extension(&target.path, &["fsproj"]) {
        fsharp
    } else {
        csharp
    }
    .cloned();
    let project = target.path.clone();
    let sender_for_refresh = sender.clone();
    let handle = runtime.handle().clone();
    send_restore_progress(&sender, &target_id, types::RestorePhase::Started, None);
    drop(runtime.spawn(async move {
        send_restore_progress(
            &sender,
            &target_id,
            types::RestorePhase::Restoring,
            Some(format!("Restoring {}", modified_files.join(", "))),
        );
        let (phase, message) = match (target_dir, lane) {
            (Some(dir), Ok(lane)) => {
                let _restoring = lane.lock().await;
                run_restore(&dir, &target_id).await
            }
            _ => (
                types::RestorePhase::Failed,
                "cannot determine restore directory".to_owned(),
            ),
        };
        if matches!(phase, types::RestorePhase::Succeeded) {
            refresh_after_restore(&project);
            crate::diagnostics::publish_after_restore(
                &handle,
                &sender_for_refresh,
                owner.as_ref(),
                &project,
            );
        }
        send_restore_progress(&sender, &target_id, phase, Some(message));
    }));
}

/// Drop the restored project's vulnerable-package scan so the next publication
/// re-runs the audit. [PKG-VULN-DIAG]
fn refresh_after_restore(project: &str) {
    super::vulnerability::invalidate(project);
    if let Some(props) = super::targets::find_packages_props(std::path::Path::new(project)) {
        super::vulnerability::invalidate(&props.to_string_lossy());
    }
}

/// Run `dotnet restore` in `dir` and classify its outcome as a final phase.
async fn run_restore(dir: &std::path::Path, target_id: &str) -> (types::RestorePhase, String) {
    let mut command = tokio::process::Command::new("dotnet");
    let _ = command.arg("restore").current_dir(dir);
    crate::utils::hide_console_window_tokio(&mut command);
    match command.output().await {
        Ok(output) if output.status.success() => {
            info!("nuget restore succeeded for {target_id}");
            (
                types::RestorePhase::Succeeded,
                "Restore succeeded".to_owned(),
            )
        }
        Ok(output) => {
            error!(target_id, exit_code = ?output.status.code(), "NuGet restore failed");
            (types::RestorePhase::Failed, failure_output(output))
        }
        Err(err) => {
            error!("nuget restore spawn failed for {target_id}: {err}");
            (types::RestorePhase::Failed, format!("spawn failed: {err}"))
        }
    }
}

/// `MSBuild` reports failures on stdout too, so both streams are the diagnostic.
fn failure_output(output: std::process::Output) -> String {
    [output.stdout, output.stderr]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .filter(|message| !message.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Send a `sharplsp/nuget/restoreProgress` notification to the client.
fn send_restore_progress(
    sender: &Sender<Message>,
    target_id: &str,
    phase: types::RestorePhase,
    message: Option<String>,
) {
    let params = types::RestoreProgressParams {
        target_id: target_id.to_string(),
        phase,
        message,
    };
    let params = match serde_json::to_value(&params) {
        Ok(value) => value,
        Err(err) => {
            error!("failed to serialize RestoreProgressParams: {err}");
            return;
        }
    };
    let notification = Notification {
        method: "sharplsp/nuget/restoreProgress".to_string(),
        params,
    };
    if let Err(err) = sender.send(Message::Notification(notification)) {
        error!("failed to send restoreProgress notification: {err}");
    }
}
