//! Request and response types for `forge/nuget/*` LSP custom requests.

use serde::{Deserialize, Serialize};

// ── forge/nuget/search ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    pub project_path: String,
    pub prerelease: bool,
    #[serde(default = "default_take")]
    pub take: u32,
    #[serde(default)]
    pub skip: u32,
}

fn default_take() -> u32 {
    50
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub packages: Vec<PackageInfo>,
    pub total_hits: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub id: String,
    pub version: String,
    pub description: String,
    pub authors: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    pub download_count: u64,
    pub tags: Vec<String>,
    pub is_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
}

// ── forge/nuget/versions ────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsParams {
    pub package_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsResponse {
    pub versions: Vec<String>,
}

// ── forge/nuget/installed ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledParams {
    pub project_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledResponse {
    pub packages: Vec<InstalledPackageInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPackageInfo {
    pub id: String,
    pub requested_version: String,
    pub resolved_version: String,
}

// ── forge/nuget/install ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallParams {
    pub project_path: String,
    pub package_id: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResponse {
    pub success: bool,
    pub message: String,
}

// ── forge/nuget/uninstall ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallParams {
    pub project_path: String,
    pub package_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResponse {
    pub success: bool,
    pub message: String,
}

// ── NuGet v3 API wire types (internal) ──────────────────────────

/// `NuGet` v3 Search API response envelope.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NuGetApiSearchResponse {
    pub total_hits: u64,
    #[serde(default)]
    pub data: Vec<NuGetApiPackage>,
}

/// Single package from the `NuGet` v3 Search API.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NuGetApiPackage {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub authors: Vec<String>,
    pub icon_url: Option<String>,
    pub license_url: Option<String>,
    pub project_url: Option<String>,
    pub published: Option<String>,
    #[serde(default)]
    pub total_downloads: u64,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `NuGet` v3 flat-container version index.
#[derive(Debug, Deserialize)]
pub struct NuGetApiVersionIndex {
    pub versions: Vec<String>,
}

/// `dotnet list package --format json` output envelope.
#[derive(Debug, Deserialize)]
pub struct DotNetListOutput {
    #[serde(default)]
    pub projects: Vec<DotNetListProject>,
}

/// Single project in `dotnet list` JSON output.
#[derive(Debug, Deserialize)]
pub struct DotNetListProject {
    #[serde(default)]
    pub frameworks: Vec<DotNetListFramework>,
}

/// Single target framework in `dotnet list` JSON output.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotNetListFramework {
    #[serde(default)]
    pub top_level_packages: Vec<DotNetListPackage>,
}

/// Single package in `dotnet list` JSON output.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotNetListPackage {
    pub id: String,
    #[serde(default)]
    pub requested_version: String,
    #[serde(default)]
    pub resolved_version: String,
}
