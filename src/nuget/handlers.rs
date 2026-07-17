//! LSP custom request handlers for `sharplsp/nuget/*` operations.
//!
//! All handlers follow: deserialize params -> delegate -> serialize result.

use anyhow::{Context, Result};
use crossbeam_channel::Sender;
use lsp_server::{Message, Notification, Request};
use std::path::Path;
use std::sync::Arc;
use tokio::runtime::Runtime;
use tracing::{error, info};

use crate::sidecar::manager::SidecarManager;

use super::{cli, consolidate, edit, parse, search, targets, types, unused};

/// Handle `sharplsp/nuget/targets` — enumerate projects and props files.
pub fn handle_targets(req: Request) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/targets");
    let params: types::TargetsParams = serde_json::from_value(req.params)?;
    let response = targets::enumerate_targets(&params.workspace_root)?;
    Ok(serde_json::to_value(response)?)
}

/// Handle `sharplsp/nuget/search`.
pub fn handle_search(req: Request, runtime: &tokio::runtime::Runtime) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/search");
    let params: types::SearchParams = serde_json::from_value(req.params)?;
    let target = resolve_target(params.target, params.project_path.clone())?;

    let (mut packages, total_hits) = runtime.block_on(search::search_packages(
        &params.query,
        params.prerelease,
        params.take,
        params.skip,
    ))?;

    // Cross-reference with installed packages for this target.
    let installed = runtime.block_on(list_installed_for_target(&target));
    if let Ok(installed_list) = installed {
        for pkg in &mut packages {
            if let Some(inst) = installed_list.iter().find(|i| i.id == pkg.id) {
                pkg.is_installed = true;
                pkg.installed_version = Some(inst.resolved_version.clone());
            }
        }
    }

    let response = types::SearchResponse {
        packages,
        total_hits,
    };
    Ok(serde_json::to_value(response)?)
}

/// Handle `sharplsp/nuget/versions`.
pub fn handle_versions(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/versions");
    let params: types::VersionsParams = serde_json::from_value(req.params)?;
    let versions = runtime.block_on(search::fetch_versions(&params.package_id))?;
    let response = types::VersionsResponse { versions };
    Ok(serde_json::to_value(response)?)
}

/// Handle `sharplsp/nuget/installed`.
pub fn handle_installed(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/installed");
    let params: types::InstalledParams = serde_json::from_value(req.params)?;
    let target = resolve_target(params.target, params.project_path)?;
    let packages = runtime.block_on(list_installed_for_target(&target))?;
    let response = types::InstalledResponse { packages };
    Ok(serde_json::to_value(response)?)
}

/// Handle `sharplsp/nuget/install` — MSBuild-DOM edit (C# sidecar) + background
/// restore. [NUGET-XML-DOM]
pub fn handle_install(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sender: Sender<Message>,
    csharp: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/install");
    let params: types::InstallParams = serde_json::from_value(req.params)?;
    let target = resolve_target(params.target, params.project_path.clone())?;

    let Some(sidecar) = csharp else {
        return no_editor_response(types::InstallResponse {
            success: false,
            message: EDITOR_UNAVAILABLE.to_string(),
            modified_files: Vec::new(),
        });
    };
    let response = apply_install(
        sidecar,
        runtime,
        &target,
        &params.package_id,
        &params.version,
    )?;

    finish_with_restore(response, runtime, sender, &target)
}

/// Handle `sharplsp/nuget/uninstall` — MSBuild-DOM edit (C# sidecar) + background
/// restore. [NUGET-XML-DOM]
pub fn handle_uninstall(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sender: Sender<Message>,
    csharp: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/uninstall");
    let params: types::UninstallParams = serde_json::from_value(req.params)?;
    let target = resolve_target(params.target, params.project_path.clone())?;

    let Some(sidecar) = csharp else {
        return no_editor_response(types::UninstallResponse {
            success: false,
            message: EDITOR_UNAVAILABLE.to_string(),
            modified_files: Vec::new(),
        });
    };
    let response = apply_uninstall(sidecar, runtime, &target, &params.package_id)?;

    finish_with_restore(response, runtime, sender, &target)
}

/// Message returned when no C# sidecar is available to perform an `MSBuild` edit.
const EDITOR_UNAVAILABLE: &str =
    "C# sidecar is not available to edit project files (open a workspace first)";

/// Serialize a pre-built failure response for the no-editor case.
fn no_editor_response<R: serde::Serialize>(response: R) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(response)?)
}

/// Handle `sharplsp/nuget/unused` — detect unused direct package references.
///
/// Implements [PKG-UNUSED-REQUEST]: the language-appropriate sidecar computes
/// reference usage; the path → package mapping and intersection with the
/// project's *direct* references happen here.
pub fn handle_unused(
    req: Request,
    runtime: &Runtime,
    csharp: Option<&Arc<SidecarManager>>,
    fsharp: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/unused");
    let params: types::UnusedParams = serde_json::from_value(req.params)?;
    let direct = read_direct_refs(&params.project_path)?;
    let usage = query_reference_usage(&params.project_path, runtime, csharp, fsharp)?;
    let response = types::UnusedResponse {
        unused: unused::compute_unused(&usage, &direct),
        project_path: params.project_path,
    };
    Ok(serde_json::to_value(response)?)
}

/// Read the direct `PackageReference` items declared in a project file.
fn read_direct_refs(project_path: &str) -> Result<Vec<parse::PackageItem>> {
    let text =
        std::fs::read_to_string(project_path).with_context(|| format!("read {project_path}"))?;
    Ok(parse::read_package_items(&text, "PackageReference"))
}

/// Query the language-appropriate sidecar for a project's reference usage.
fn query_reference_usage(
    project_path: &str,
    runtime: &Runtime,
    csharp: Option<&Arc<SidecarManager>>,
    fsharp: Option<&Arc<SidecarManager>>,
) -> Result<unused::ReferenceUsage> {
    let sidecar =
        pick_package_sidecar(project_path, csharp, fsharp).context("no sidecar for project")?;
    let payload = rmp_serde::to_vec(project_path)?;
    let bytes = runtime.block_on(sidecar.request("project/unusedPackages", payload))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Pick the sidecar that owns a project's language (`.fsproj` → F#, else C#).
fn pick_package_sidecar<'a>(
    project_path: &str,
    csharp: Option<&'a Arc<SidecarManager>>,
    fsharp: Option<&'a Arc<SidecarManager>>,
) -> Option<&'a Arc<SidecarManager>> {
    if project_path.to_lowercase().ends_with(".fsproj") {
        fsharp
    } else {
        csharp
    }
}

/// Handle `sharplsp/nuget/consolidate` — hoist shared packages to props.
///
/// Implements [PKG-CONSOLIDATE-REQUEST]: pure Tier-1 work plus a single
/// background restore for the files it touched.
pub fn handle_consolidate(
    req: Request,
    runtime: &Runtime,
    sender: Sender<Message>,
    csharp: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/consolidate");
    let params: types::ConsolidateParams = serde_json::from_value(req.params)?;
    let response =
        consolidate::consolidate(&params.solution_path, params.dry_run, csharp, runtime)?;
    if !params.dry_run && !response.modified_files.is_empty() {
        let target = types::NuGetTarget::from_project_path(&params.solution_path);
        spawn_restore(runtime, sender, &target, response.modified_files.clone());
    }
    Ok(serde_json::to_value(response)?)
}

/// Install/uninstall responses that may trigger a background restore.
trait RestoreOutcome {
    /// Whether the operation succeeded.
    fn succeeded(&self) -> bool;
    /// Paths of files the operation modified.
    fn modified_files(&self) -> &[String];
}

impl RestoreOutcome for types::InstallResponse {
    fn succeeded(&self) -> bool {
        self.success
    }

    fn modified_files(&self) -> &[String] {
        &self.modified_files
    }
}

impl RestoreOutcome for types::UninstallResponse {
    fn succeeded(&self) -> bool {
        self.success
    }

    fn modified_files(&self) -> &[String] {
        &self.modified_files
    }
}

/// Fire a background restore when the operation modified files, then serialize the
/// response. Shared tail of `handle_install` and `handle_uninstall`.
fn finish_with_restore<R>(
    response: R,
    runtime: &tokio::runtime::Runtime,
    sender: Sender<Message>,
    target: &types::NuGetTarget,
) -> Result<serde_json::Value>
where
    R: RestoreOutcome + serde::Serialize,
{
    if response.succeeded() && !response.modified_files().is_empty() {
        spawn_restore(runtime, sender, target, response.modified_files().to_vec());
    }

    Ok(serde_json::to_value(response)?)
}

// ── Helpers ─────────────────────────────────────────────────────

/// Accept either a full `target` or a bare `projectPath` string for
/// backwards compatibility.
fn resolve_target(
    target: Option<types::NuGetTarget>,
    project_path: Option<String>,
) -> Result<types::NuGetTarget> {
    if let Some(t) = target {
        return Ok(t);
    }
    if let Some(path) = project_path {
        return Ok(types::NuGetTarget::from_project_path(&path));
    }
    anyhow::bail!("missing target / projectPath")
}

/// Parse installed packages for a target.
///
/// For `project` targets, shells out to `dotnet list package --format json`
/// (the existing behaviour). For `buildProps` targets we scrape the XML
/// directly — `dotnet list` doesn't understand a props file.
async fn list_installed_for_target(
    target: &types::NuGetTarget,
) -> Result<Vec<types::InstalledPackageInfo>> {
    match target.kind {
        types::TargetKind::Project => cli::list_installed(&target.path).await,
        types::TargetKind::BuildProps => list_props_packages(&target.path),
    }
}

/// Read `<PackageReference>` / `<PackageVersion>` entries from a props file.
fn list_props_packages(path: &str) -> Result<Vec<types::InstalledPackageInfo>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    let items = parse::read_package_items(&text, "PackageReference")
        .into_iter()
        .chain(parse::read_package_items(&text, "PackageVersion"));
    Ok(items
        .map(|item| {
            let version = item.version.unwrap_or_default();
            types::InstalledPackageInfo {
                id: item.id,
                requested_version: version.clone(),
                resolved_version: version,
            }
        })
        .collect())
}

/// Apply install by delegating the XML mutation to the C# sidecar.
fn apply_install(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    target: &types::NuGetTarget,
    package_id: &str,
    version: &str,
) -> Result<types::InstallResponse> {
    let path = Path::new(&target.path);
    if !path.exists() {
        return Ok(types::InstallResponse {
            success: false,
            message: format!("target not found: {}", target.path),
            modified_files: Vec::new(),
        });
    }

    let element = pick_install_element(target);
    let outcome = edit::add_package(sidecar, runtime, &target.path, package_id, version, element)?;

    // For CPM projects, also update Directory.Packages.props.
    let mut modified: Vec<String> = Vec::new();
    if outcome.modified {
        modified.push(target.path.clone());
    }
    if matches!(element, edit::PackageElement::ReferenceNoVersion) {
        if let Some(props_path) = targets::find_packages_props(path) {
            let props_str = props_path.to_string_lossy().to_string();
            let props_outcome = edit::add_package(
                sidecar,
                runtime,
                &props_str,
                package_id,
                version,
                edit::PackageElement::Version,
            )?;
            if props_outcome.modified {
                modified.push(props_str);
            }
        }
    }

    Ok(types::InstallResponse {
        success: true,
        message: outcome.message,
        modified_files: modified,
    })
}

/// Apply uninstall by delegating the XML mutation to the C# sidecar.
fn apply_uninstall(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    target: &types::NuGetTarget,
    package_id: &str,
) -> Result<types::UninstallResponse> {
    let path = Path::new(&target.path);
    if !path.exists() {
        return Ok(types::UninstallResponse {
            success: false,
            message: format!("target not found: {}", target.path),
            modified_files: Vec::new(),
        });
    }

    let element = pick_install_element(target);
    let outcome = edit::remove_package(sidecar, runtime, &target.path, package_id, element)?;

    let mut modified: Vec<String> = Vec::new();
    if outcome.modified {
        modified.push(target.path.clone());
    }

    Ok(types::UninstallResponse {
        success: outcome.modified,
        message: outcome.message,
        modified_files: modified,
    })
}

/// Decide which element flavour to write for the given target.
fn pick_install_element(target: &types::NuGetTarget) -> edit::PackageElement {
    let lower = target.path.to_lowercase();
    if lower.ends_with("directory.packages.props") {
        edit::PackageElement::Version
    } else if matches!(target.kind, types::TargetKind::BuildProps) {
        edit::PackageElement::Reference
    } else if targets::find_packages_props(Path::new(&target.path)).is_some() {
        edit::PackageElement::ReferenceNoVersion
    } else {
        edit::PackageElement::Reference
    }
}

// ── Background restore + notifications ─────────────────────────

/// Spawn a background `dotnet restore` and send progress notifications.
fn spawn_restore(
    runtime: &tokio::runtime::Runtime,
    sender: Sender<Message>,
    target: &types::NuGetTarget,
    modified_files: Vec<String>,
) {
    let target_id = target.id.clone();
    let target_dir = std::path::Path::new(&target.path)
        .parent()
        .map(std::path::Path::to_path_buf);

    // Notify "started" synchronously so the UI sees it immediately.
    send_restore_progress(&sender, &target_id, types::RestorePhase::Started, None);

    drop(runtime.spawn(async move {
        send_restore_progress(
            &sender,
            &target_id,
            types::RestorePhase::Restoring,
            Some(format!("Restoring {}", modified_files.join(", "))),
        );

        let Some(dir) = target_dir else {
            send_restore_progress(
                &sender,
                &target_id,
                types::RestorePhase::Failed,
                Some("cannot determine restore directory".into()),
            );
            return;
        };

        let mut command = tokio::process::Command::new("dotnet");
        let _ = command.arg("restore").current_dir(&dir);
        crate::utils::hide_console_window_tokio(&mut command);
        let output = command.output().await;

        match output {
            Ok(o) if o.status.success() => {
                info!("nuget restore succeeded for {target_id}");
                send_restore_progress(
                    &sender,
                    &target_id,
                    types::RestorePhase::Succeeded,
                    Some("Restore succeeded".into()),
                );
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                error!("nuget restore failed for {target_id}: {stderr}");
                send_restore_progress(
                    &sender,
                    &target_id,
                    types::RestorePhase::Failed,
                    Some(stderr),
                );
            }
            Err(err) => {
                error!("nuget restore spawn failed for {target_id}: {err}");
                send_restore_progress(
                    &sender,
                    &target_id,
                    types::RestorePhase::Failed,
                    Some(format!("spawn failed: {err}")),
                );
            }
        }
    }));
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
    let params_value = match serde_json::to_value(&params) {
        Ok(v) => v,
        Err(err) => {
            error!("failed to serialize RestoreProgressParams: {err}");
            return;
        }
    };
    let notif = Notification {
        method: "sharplsp/nuget/restoreProgress".to_string(),
        params: params_value,
    };
    if let Err(err) = sender.send(Message::Notification(notif)) {
        error!("failed to send restoreProgress notification: {err}");
    }
}
