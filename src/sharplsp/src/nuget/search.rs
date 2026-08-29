//! HTTP client operations for the `NuGet` v3 API.
//!
//! - Search: `https://azuresearch-usnc.nuget.org/query`
//! - Versions: `https://api.nuget.org/v3-flatcontainer/{id}/index.json`

use anyhow::{Context, Result};
use tracing::info;

use super::cache;
use super::types::{NuGetApiSearchResponse, NuGetApiVersionIndex, PackageInfo};

/// Base URL for the `NuGet` v3 Search API.
const SEARCH_URL: &str = "https://azuresearch-usnc.nuget.org/query";
/// Base URL for the `NuGet` v3 flat-container (version index) API.
const VERSIONS_URL: &str = "https://api.nuget.org/v3-flatcontainer";

/// Search nuget.org for packages. Returns raw API response with `total_hits`.
pub async fn search_packages(
    query: &str,
    prerelease: bool,
    take: u32,
    skip: u32,
) -> Result<(Vec<PackageInfo>, u64)> {
    let cache_key = format!("{query}|{prerelease}|{take}|{skip}");

    if let Some(cached) = cache::search_cache().get(&cache_key) {
        info!("nuget/search: cache hit for {cache_key}");
        let resp: NuGetApiSearchResponse =
            serde_json::from_value(cached).context("deserialize cached search")?;
        return Ok((map_packages(&resp), resp.total_hits));
    }

    info!("nuget/search: fetching query={query} prerelease={prerelease} take={take} skip={skip}");
    let client = cache::http_client();
    let resp = client
        .get(SEARCH_URL)
        .query(&[
            ("q", query),
            ("prerelease", &prerelease.to_string()),
            ("take", &take.to_string()),
            ("skip", &skip.to_string()),
        ])
        .send()
        .await
        .context("NuGet search HTTP request")?
        .error_for_status()
        .context("NuGet search HTTP status")?;

    let body: serde_json::Value = resp.json().await.context("NuGet search JSON parse")?;

    cache::search_cache().insert(cache_key, body.clone());

    let parsed: NuGetApiSearchResponse =
        serde_json::from_value(body).context("deserialize NuGet search response")?;

    Ok((map_packages(&parsed), parsed.total_hits))
}

/// Fetch all versions for a package from the flat-container API.
pub async fn fetch_versions(package_id: &str) -> Result<Vec<String>> {
    let lower_id = package_id.to_lowercase();

    if let Some(cached) = cache::versions_cache().get(&lower_id) {
        info!("nuget/versions: cache hit for {lower_id}");
        return Ok(cached);
    }

    let url = format!("{VERSIONS_URL}/{lower_id}/index.json");
    info!("nuget/versions: fetching {url}");

    let client = cache::http_client();
    let resp = client
        .get(&url)
        .send()
        .await
        .context("NuGet versions HTTP request")?
        .error_for_status()
        .context("NuGet versions HTTP status")?;

    let index: NuGetApiVersionIndex = resp.json().await.context("NuGet versions JSON parse")?;

    // Reverse to newest-first.
    let mut versions = index.versions;
    versions.reverse();

    cache::versions_cache().insert(lower_id, versions.clone());
    Ok(versions)
}

/// Map `NuGet` v3 API packages to our LSP response type.
fn map_packages(resp: &NuGetApiSearchResponse) -> Vec<PackageInfo> {
    resp.data
        .iter()
        .map(|pkg| PackageInfo {
            id: pkg.id.clone(),
            version: pkg.version.clone(),
            description: pkg.description.clone(),
            authors: pkg.authors.join(", "),
            icon_url: pkg.icon_url.clone(),
            license_url: pkg.license_url.clone(),
            project_url: pkg.project_url.clone(),
            published: pkg.published.clone(),
            download_count: pkg.total_downloads,
            tags: pkg.tags.clone(),
            is_installed: false,
            installed_version: None,
        })
        .collect()
}
