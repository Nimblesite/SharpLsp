//! LSP custom request handlers for `forge/nuget/*` operations.
//!
//! All handlers follow: deserialize params -> delegate -> serialize result.

use anyhow::Result;
use lsp_server::Request;
use tracing::info;

use super::{cli, search, types};

/// Handle `forge/nuget/search`.
pub fn handle_search(req: Request, runtime: &tokio::runtime::Runtime) -> Result<serde_json::Value> {
    info!("Handling forge/nuget/search");
    let params: types::SearchParams = serde_json::from_value(req.params)?;

    let (mut packages, total_hits) = runtime.block_on(search::search_packages(
        &params.query,
        params.prerelease,
        params.take,
        params.skip,
    ))?;

    // Cross-reference with installed packages.
    let installed = runtime.block_on(cli::list_installed(&params.project_path));
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

/// Handle `forge/nuget/versions`.
pub fn handle_versions(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/nuget/versions");
    let params: types::VersionsParams = serde_json::from_value(req.params)?;
    let versions = runtime.block_on(search::fetch_versions(&params.package_id))?;
    let response = types::VersionsResponse { versions };
    Ok(serde_json::to_value(response)?)
}

/// Handle `forge/nuget/installed`.
pub fn handle_installed(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/nuget/installed");
    let params: types::InstalledParams = serde_json::from_value(req.params)?;
    let packages = runtime.block_on(cli::list_installed(&params.project_path))?;
    let response = types::InstalledResponse { packages };
    Ok(serde_json::to_value(response)?)
}

/// Handle `forge/nuget/install`.
pub fn handle_install(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/nuget/install");
    let params: types::InstallParams = serde_json::from_value(req.params)?;
    let response = runtime.block_on(cli::install_package(
        &params.project_path,
        &params.package_id,
        &params.version,
    ))?;
    Ok(serde_json::to_value(response)?)
}

/// Handle `forge/nuget/uninstall`.
pub fn handle_uninstall(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/nuget/uninstall");
    let params: types::UninstallParams = serde_json::from_value(req.params)?;
    let response = runtime.block_on(cli::uninstall_package(
        &params.project_path,
        &params.package_id,
    ))?;
    Ok(serde_json::to_value(response)?)
}
