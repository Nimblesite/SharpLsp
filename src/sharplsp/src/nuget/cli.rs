//! `dotnet` CLI operations for `NuGet` package management.
//!
//! - `dotnet list <project> package --format json`
//!
//! Install / uninstall bypass the `dotnet` CLI entirely — we edit XML through
//! the C# sidecar's `MSBuild` document model (`nuget::edit`) and fire restore in
//! the background for instant-feedback UX.

use anyhow::{Context, Result};
use tracing::info;

use super::types::{DotNetListOutput, InstalledPackageInfo};

/// List installed `NuGet` packages for a project.
pub async fn list_installed(project_path: &str) -> Result<Vec<InstalledPackageInfo>> {
    info!("nuget/installed: dotnet list {project_path} package --format json");

    let mut command = tokio::process::Command::new("dotnet");
    let _ = command.args(["list", project_path, "package", "--format", "json"]);
    crate::utils::hide_console_window_tokio(&mut command);
    let output = command.output().await.context("spawn dotnet list")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("dotnet list failed: {stderr}");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: DotNetListOutput =
        serde_json::from_str(&stdout).context("parse dotnet list JSON output")?;

    let mut packages = Vec::new();
    for project in &parsed.projects {
        for framework in &project.frameworks {
            for pkg in &framework.top_level_packages {
                // Deduplicate across frameworks — keep first occurrence.
                if !packages
                    .iter()
                    .any(|p: &InstalledPackageInfo| p.id == pkg.id)
                {
                    packages.push(InstalledPackageInfo {
                        id: pkg.id.clone(),
                        requested_version: pkg.requested_version.clone(),
                        resolved_version: pkg.resolved_version.clone(),
                    });
                }
            }
        }
    }

    info!("nuget/installed: found {} packages", packages.len());
    Ok(packages)
}
