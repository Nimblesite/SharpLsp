//! Request and response types for `forge/nuget/*` LSP custom requests.
//!
//! All parameter types accept both a full `target: NuGetTarget` and a legacy
//! `projectPath: string` for backwards compatibility with older clients.

use serde::{Deserialize, Serialize};

// ── NuGetTarget (shared) ────────────────────────────────────────

/// A `NuGet` install target: either a single project or a props file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NuGetTarget {
    /// Stable identifier — always the absolute path.
    pub id: String,
    pub kind: TargetKind,
    /// Human-facing label: `Foo.csproj`, `Directory.Build.props (solution root)`, etc.
    pub display_name: String,
    /// Absolute path to the file.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<TargetLanguage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub framework: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Project,
    BuildProps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetLanguage {
    CSharp,
    FSharp,
}

impl NuGetTarget {
    /// Synthesize a project-kind target from a raw `.csproj` / `.fsproj` path
    /// (for backwards-compat with older clients that still send `projectPath`).
    pub fn from_project_path(path: &str) -> Self {
        let display_name = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .map_or_else(|| path.to_string(), String::from);
        let language = if path.ends_with(".fsproj") {
            Some(TargetLanguage::FSharp)
        } else {
            Some(TargetLanguage::CSharp)
        };
        Self {
            id: path.to_string(),
            kind: TargetKind::Project,
            display_name,
            path: path.to_string(),
            language,
            framework: Vec::new(),
        }
    }
}

// ── forge/nuget/targets ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetsParams {
    pub workspace_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetsResponse {
    pub targets: Vec<NuGetTarget>,
    pub default_target_id: Option<String>,
    pub cpm_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpm_file: Option<String>,
}

// ── forge/nuget/search ──────────────────────────────────────────

/// Legacy-compat target spec: accept either a full `target` or a bare `projectPath`.
///
/// The UI in flight still sends `projectPath`; the spec requires `target`. We
/// accept both and coerce to a `NuGetTarget` internally.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    #[serde(default)]
    pub project_path: Option<String>,
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
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    #[serde(default)]
    pub project_path: Option<String>,
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
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub package_id: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResponse {
    pub success: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modified_files: Vec<String>,
}

// ── forge/nuget/uninstall ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallParams {
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub package_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResponse {
    pub success: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modified_files: Vec<String>,
}

// ── forge/nuget/restoreProgress (server → client notification) ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProgressParams {
    pub target_id: String,
    pub phase: RestorePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RestorePhase {
    Started,
    Restoring,
    Succeeded,
    Failed,
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
