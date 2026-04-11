//! `dotnet` CLI operations for `NuGet` package management.
//!
//! - `dotnet list <project> package --format json`
//!
//! Install / uninstall bypass the `dotnet` CLI entirely — we edit XML
//! directly via `nuget::xml_edit` and fire restore in the background for
//! instant-feedback UX.

use anyhow::{Context, Result};
use tracing::info;

use super::types::{DotNetListOutput, InstalledPackageInfo};

/// List installed `NuGet` packages for a project.
pub async fn list_installed(project_path: &str) -> Result<Vec<InstalledPackageInfo>> {
    info!("nuget/installed: dotnet list {project_path} package --format json");

    let output = tokio::process::Command::new("dotnet")
        .args(["list", project_path, "package", "--format", "json"])
        .output()
        .await
        .context("spawn dotnet list")?;

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
