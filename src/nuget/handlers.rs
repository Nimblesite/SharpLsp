//! LSP custom request handlers for `sharplsp/nuget/*` operations.
//!
//! All handlers follow: deserialize params -> delegate -> serialize result.

use anyhow::{Context, Result};
use crossbeam_channel::Sender;
use lsp_server::{Message, Notification, Request};
use std::path::Path;
use tracing::{error, info};

use super::{cli, search, targets, types, xml_edit};

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

/// Handle `sharplsp/nuget/install` — fast-path XML edit + background restore.
pub fn handle_install(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sender: Sender<Message>,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/install");
    let params: types::InstallParams = serde_json::from_value(req.params)?;
    let target = resolve_target(params.target, params.project_path.clone())?;

    // Perform the synchronous XML fast path.
    let response = apply_install(&target, &params.package_id, &params.version)?;

    finish_with_restore(response, runtime, sender, &target)
}

/// Handle `sharplsp/nuget/uninstall` — fast-path XML edit + background restore.
pub fn handle_uninstall(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sender: Sender<Message>,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/uninstall");
    let params: types::UninstallParams = serde_json::from_value(req.params)?;
    let target = resolve_target(params.target, params.project_path.clone())?;

    let response = apply_uninstall(&target, &params.package_id)?;

    finish_with_restore(response, runtime, sender, &target)
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
    let mut packages = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !(trimmed.starts_with("<PackageReference") || trimmed.starts_with("<PackageVersion")) {
            continue;
        }
        let Some(id) = extract_attr(line, "Include") else {
            continue;
        };
        let version = extract_attr(line, "Version").unwrap_or_default();
        packages.push(types::InstalledPackageInfo {
            id,
            requested_version: version.clone(),
            resolved_version: version,
        });
    }
    Ok(packages)
}

/// Extract the value of an XML attribute (e.g. `Include="..."`) from a line.
fn extract_attr(line: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = line.find(&needle)? + needle.len();
    let rest = line.get(start..)?;
    let end = rest.find('"')?;
    Some(rest.get(..end)?.to_string())
}

/// Apply install via XML fast path.
fn apply_install(
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
    let outcome = xml_edit::add_package(path, package_id, version, element)?;

    // For CPM projects, also update Directory.Packages.props.
    let mut modified: Vec<String> = Vec::new();
    if outcome.modified {
        modified.push(target.path.clone());
    }
    if matches!(element, xml_edit::PackageElement::ReferenceNoVersion) {
        if let Some(props_path) = find_packages_props(path) {
            let props_outcome = xml_edit::add_package(
                &props_path,
                package_id,
                version,
                xml_edit::PackageElement::Version,
            )?;
            if props_outcome.modified {
                modified.push(props_path.to_string_lossy().to_string());
            }
        }
    }

    Ok(types::InstallResponse {
        success: true,
        message: outcome.message,
        modified_files: modified,
    })
}

/// Apply uninstall via XML fast path.
fn apply_uninstall(
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
    let outcome = xml_edit::remove_package(path, package_id, element)?;

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
fn pick_install_element(target: &types::NuGetTarget) -> xml_edit::PackageElement {
    let lower = target.path.to_lowercase();
    if lower.ends_with("directory.packages.props") {
        xml_edit::PackageElement::Version
    } else if matches!(target.kind, types::TargetKind::BuildProps) {
        xml_edit::PackageElement::Reference
    } else if find_packages_props(Path::new(&target.path)).is_some() {
        xml_edit::PackageElement::ReferenceNoVersion
    } else {
        xml_edit::PackageElement::Reference
    }
}

/// Walk up from a csproj looking for a sibling / ancestor
/// `Directory.Packages.props`. Returns the first one found.
fn find_packages_props(start: &Path) -> Option<std::path::PathBuf> {
    let mut dir = start.parent()?.to_path_buf();
    loop {
        let candidate = dir.join("Directory.Packages.props");
        if candidate.exists() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
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

        let output = tokio::process::Command::new("dotnet")
            .arg("restore")
            .current_dir(&dir)
            .output()
            .await;

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
