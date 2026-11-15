//! `dotnet` CLI operations for `NuGet` package management.
//!
//! Install / uninstall bypass the `dotnet` CLI entirely — we edit XML through
//! the C# sidecar's `MSBuild` document model (`nuget::edit`) and fire restore in
//! the background for instant-feedback UX.

use anyhow::{Context, Result};
use tracing::info;

use super::types::{
    DotNetListOutput, DotNetListPackage, InstalledPackageInfo, NuGetTarget, OutdatedPackageInfo,
    TargetKind,
};

/// List installed `NuGet` packages, deduplicated across equivalent frameworks.
pub async fn list_installed(project_path: &str) -> Result<Vec<InstalledPackageInfo>> {
    let occurrences = list_installed_occurrences(project_path).await?;
    let mut packages: Vec<InstalledPackageInfo> = Vec::new();
    for package in occurrences {
        if !packages.iter().any(|existing| existing.id == package.id) {
            packages.push(package);
        }
    }
    info!("nuget/installed: found {} packages", packages.len());
    Ok(packages)
}

/// Preserve every framework occurrence so update can reject ambiguity.
pub async fn list_installed_occurrences(project_path: &str) -> Result<Vec<InstalledPackageInfo>> {
    let output = run_list(project_path, &[]).await?;
    Ok(installed_packages(output))
}

/// Ask the configured sources for the newest stable release in the current line./// The host still validates and selects the result with `NuGet` version semantics.
pub async fn list_outdated(
    target: &NuGetTarget,
    zero_major: bool,
) -> Result<Vec<OutdatedPackageInfo>> {
    let bound = if zero_major {
        "--highest-patch"
    } else {
        "--highest-minor"
    };
    let args = ["--outdated", bound];
    let output = run_list(&target.path, &args).await?;
    Ok(outdated_packages(output))
}

/// The vulnerable-package listing: `dotnet list package --vulnerable
/// --include-transitive --format json`, parsed as raw `JSON` for
/// [`super::vulnerability`]. `dotnet list` restores a project with no assets
/// by itself, so while restoring is not `allowed` it runs `--no-restore`: an
/// audit must never be the restore the user switched off. [PKG-VULN-DIAG] [DIAG-RESTORE]
pub(crate) async fn run_list_vulnerable(
    project_path: &str,
    allowed: bool,
) -> Result<serde_json::Value> {
    let audit = ["--vulnerable", "--include-transitive"];
    let offline = ["--vulnerable", "--include-transitive", "--no-restore"];
    run_list_json(
        project_path,
        if allowed { &audit[..] } else { &offline[..] },
    )
    .await
}

/// Run the machine-readable direct-package listing with optional bounds.
async fn run_list(project_path: &str, extra: &[&str]) -> Result<DotNetListOutput> {
    Ok(serde_json::from_value(
        run_list_json(project_path, extra).await?,
    )?)
}

/// Run `dotnet list <project> package` with `--format json` and options, and
/// return the parsed `JSON` document. Shared by the direct listing and the
/// vulnerable-package audit. [PKG-VULN-DIAG]
async fn run_list_json(project_path: &str, extra: &[&str]) -> Result<serde_json::Value> {
    info!("nuget/list: target={project_path} options={extra:?}");
    let mut command = tokio::process::Command::new("dotnet");
    let _ = command.args(["list", project_path, "package", "--format", "json"]);
    let _ = command.args(extra);
    crate::utils::hide_console_window_tokio(&mut command);
    let output = command.output().await.context("spawn dotnet list")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("dotnet list failed: {stderr}{stdout}");
    }
    Ok(serde_json::from_str(&stdout)?)
}

/// Map every framework's direct package to the installed response shape.
fn installed_packages(output: DotNetListOutput) -> Vec<InstalledPackageInfo> {
    direct_packages(output)
        .into_iter()
        .map(|package| InstalledPackageInfo {
            id: package.id.clone(),
            requested_version: package.requested_version.clone(),
            resolved_version: package.resolved_version.clone(),
        })
        .collect()
}

/// Retain only source-provided candidate versions.
fn outdated_packages(output: DotNetListOutput) -> Vec<OutdatedPackageInfo> {
    direct_packages(output)
        .into_iter()
        .filter_map(|package| {
            package
                .latest_version
                .clone()
                .map(|latest| OutdatedPackageInfo {
                    id: package.id.clone(),
                    latest_version: latest,
                })
        })
        .collect()
}

/// Flatten projects and frameworks without losing declaration occurrences.
fn direct_packages(output: DotNetListOutput) -> Vec<DotNetListPackage> {
    output
        .projects
        .into_iter()
        .flat_map(|project| project.frameworks)
        .flat_map(|framework| framework.top_level_packages)
        .collect()
}

/// Props files have no project argument for `dotnet list`; callers use a project
/// target for source-aware update previews. This guard makes accidental props
/// lookup failure explicit instead of silently selecting another project.
pub fn ensure_project_target(target: &NuGetTarget) -> Result<()> {
    match target.kind {
        TargetKind::Project => Ok(()),
        TargetKind::BuildProps => anyhow::bail!(
            "Update a shared props declaration through an affected project target so its feed and consumers are explicit"
        ),
    }
}
