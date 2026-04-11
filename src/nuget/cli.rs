//! `dotnet` CLI operations for `NuGet` package management.
//!
//! - `dotnet list <project> package --format json`
//! - `dotnet add <project> package <id> --version <version>`
//! - `dotnet remove <project> package <id>`

use anyhow::{Context, Result};
use tracing::info;

use super::types::{DotNetListOutput, InstallResponse, InstalledPackageInfo, UninstallResponse};

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

/// Install (or update) a `NuGet` package.
pub async fn install_package(
    project_path: &str,
    package_id: &str,
    version: &str,
) -> Result<InstallResponse> {
    info!("nuget/install: dotnet add {project_path} package {package_id} --version {version}");

    let output = tokio::process::Command::new("dotnet")
        .args([
            "add",
            project_path,
            "package",
            package_id,
            "--version",
            version,
        ])
        .output()
        .await
        .context("spawn dotnet add")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        info!("nuget/install: {package_id} v{version} installed successfully");
        Ok(InstallResponse {
            success: true,
            message: format!("Installed {package_id} v{version}"),
        })
    } else {
        let msg = if stderr.is_empty() {
            stdout.to_string()
        } else {
            stderr.to_string()
        };
        info!("nuget/install: failed — {msg}");
        Ok(InstallResponse {
            success: false,
            message: msg,
        })
    }
}

/// Remove a `NuGet` package from a project.
pub async fn uninstall_package(project_path: &str, package_id: &str) -> Result<UninstallResponse> {
    info!("nuget/uninstall: dotnet remove {project_path} package {package_id}");

    let output = tokio::process::Command::new("dotnet")
        .args(["remove", project_path, "package", package_id])
        .output()
        .await
        .context("spawn dotnet remove")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        info!("nuget/uninstall: {package_id} removed successfully");
        Ok(UninstallResponse {
            success: true,
            message: format!("Removed {package_id}"),
        })
    } else {
        let msg = if stderr.is_empty() {
            stdout.to_string()
        } else {
            stderr.to_string()
        };
        info!("nuget/uninstall: failed — {msg}");
        Ok(UninstallResponse {
            success: false,
            message: msg,
        })
    }
}
