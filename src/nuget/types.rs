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
    /// Whether this is a project file or a `Directory.Build.props` file.
    pub kind: TargetKind,
    /// Human-facing label: `Foo.csproj`, `Directory.Build.props (solution root)`, etc.
    pub display_name: String,
    /// Absolute path to the file.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Programming language of the project (C# or F#), if known.
    pub language: Option<TargetLanguage>,
    /// Target framework monikers (e.g. `net9.0`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub framework: Vec<String>,
}

/// The kind of `MSBuild` target file being operated on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    /// A `.csproj` or `.fsproj` project file.
    Project,
    /// A `Directory.Build.props` or `Directory.Packages.props` file.
    BuildProps,
}

/// Language of a .NET project file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetLanguage {
    /// C# (`.csproj`).
    CSharp,
    /// F# (`.fsproj`).
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
/// Parameters for the `forge/nuget/targets` request.
pub struct TargetsParams {
    /// Absolute path to the workspace root directory.
    pub workspace_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Response for the `forge/nuget/targets` request.
pub struct TargetsResponse {
    /// All discovered install targets (projects and props files).
    pub targets: Vec<NuGetTarget>,
    /// ID of the recommended default target, if any.
    pub default_target_id: Option<String>,
    /// Whether Central Package Management is enabled in the workspace.
    pub cpm_enabled: bool,
    /// Absolute path to the `Directory.Packages.props` file, if found.
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
    /// Free-text search query (package name, keywords, etc.).
    pub query: String,
    /// Full target specification (preferred over `project_path`).
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    /// Legacy bare project path, accepted for backwards compatibility.
    #[serde(default)]
    pub project_path: Option<String>,
    /// Whether to include pre-release versions in search results.
    pub prerelease: bool,
    /// Maximum number of results to return.
    #[serde(default = "default_take")]
    pub take: u32,
    /// Number of results to skip (for pagination).
    #[serde(default)]
    pub skip: u32,
}

/// Default page size for search results.
fn default_take() -> u32 {
    50
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Response for the `forge/nuget/search` request.
pub struct SearchResponse {
    /// Matching packages for the current page.
    pub packages: Vec<PackageInfo>,
    /// Total number of matches on the server (for pagination).
    pub total_hits: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
/// A `NuGet` package with metadata and install status.
pub struct PackageInfo {
    /// Package identifier (e.g. `Newtonsoft.Json`).
    pub id: String,
    /// Latest (or latest pre-release) version string.
    pub version: String,
    /// Package description from the `NuGet` feed.
    pub description: String,
    /// Comma-separated author names.
    pub authors: String,
    /// URL to the package icon, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// URL to the package license, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    /// URL to the project home page, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_url: Option<String>,
    /// ISO-8601 publication timestamp, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    /// Total download count from the `NuGet` feed.
    pub download_count: u64,
    /// Tags associated with the package.
    pub tags: Vec<String>,
    /// Whether the package is already installed in the target project.
    pub is_installed: bool,
    /// Version currently installed in the target, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
}

// ── forge/nuget/versions ────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Parameters for the `forge/nuget/versions` request.
pub struct VersionsParams {
    /// Package identifier to fetch versions for.
    pub package_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Response for the `forge/nuget/versions` request.
pub struct VersionsResponse {
    /// All available versions, newest first.
    pub versions: Vec<String>,
}

// ── forge/nuget/installed ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Parameters for the `forge/nuget/installed` request.
pub struct InstalledParams {
    /// Full target specification (preferred).
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    /// Legacy bare project path for backwards compatibility.
    #[serde(default)]
    pub project_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Response for the `forge/nuget/installed` request.
pub struct InstalledResponse {
    /// Packages currently referenced in the target file.
    pub packages: Vec<InstalledPackageInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
/// Metadata for a single installed `NuGet` package.
pub struct InstalledPackageInfo {
    /// Package identifier.
    pub id: String,
    /// Version string as written in the project file.
    pub requested_version: String,
    /// Actual resolved version after restore.
    pub resolved_version: String,
}

// ── forge/nuget/install ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Parameters for the `forge/nuget/install` request.
pub struct InstallParams {
    /// Full target specification (preferred).
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    /// Legacy bare project path for backwards compatibility.
    #[serde(default)]
    pub project_path: Option<String>,
    /// Package identifier to install.
    pub package_id: String,
    /// Version string to install.
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Response for the `forge/nuget/install` request.
pub struct InstallResponse {
    /// Whether the install operation succeeded.
    pub success: bool,
    /// Human-readable status message.
    pub message: String,
    /// Paths of files modified by the install.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modified_files: Vec<String>,
}

// ── forge/nuget/uninstall ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Parameters for the `forge/nuget/uninstall` request.
pub struct UninstallParams {
    /// Full target specification (preferred).
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    /// Legacy bare project path for backwards compatibility.
    #[serde(default)]
    pub project_path: Option<String>,
    /// Package identifier to remove.
    pub package_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Response for the `forge/nuget/uninstall` request.
pub struct UninstallResponse {
    /// Whether the uninstall operation succeeded.
    pub success: bool,
    /// Human-readable status message.
    pub message: String,
    /// Paths of files modified by the uninstall.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modified_files: Vec<String>,
}

// ── forge/nuget/restoreProgress (server → client notification) ──

/// Parameters for the `forge/nuget/restoreProgress` notification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProgressParams {
    /// ID of the target being restored.
    pub target_id: String,
    /// Current phase of the restore operation.
    pub phase: RestorePhase,
    /// Optional progress detail message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
/// Phases of a background `dotnet restore` operation.
pub enum RestorePhase {
    /// Restore has been kicked off.
    Started,
    /// Restore is in progress.
    Restoring,
    /// Restore completed successfully.
    Succeeded,
    /// Restore failed.
    Failed,
}

// ── NuGet v3 API wire types (internal) ──────────────────────────

/// `NuGet` v3 Search API response envelope.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NuGetApiSearchResponse {
    /// Server-reported total number of matching packages.
    pub total_hits: u64,
    /// Package entries in this page of results.
    #[serde(default)]
    pub data: Vec<NuGetApiPackage>,
}

/// Single package from the `NuGet` v3 Search API.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NuGetApiPackage {
    /// Package identifier.
    pub id: String,
    /// Latest version string.
    pub version: String,
    /// Package description.
    #[serde(default)]
    pub description: String,
    /// List of author names.
    #[serde(default)]
    pub authors: Vec<String>,
    /// URL to the package icon.
    pub icon_url: Option<String>,
    /// URL to the package license.
    pub license_url: Option<String>,
    /// URL to the project page.
    pub project_url: Option<String>,
    /// ISO-8601 publication timestamp.
    pub published: Option<String>,
    /// Cumulative download count.
    #[serde(default)]
    pub total_downloads: u64,
    /// Tags from the package metadata.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `NuGet` v3 flat-container version index.
#[derive(Debug, Deserialize)]
pub struct NuGetApiVersionIndex {
    /// All published version strings for the package.
    pub versions: Vec<String>,
}

/// `dotnet list package --format json` output envelope.
#[derive(Debug, Deserialize)]
pub struct DotNetListOutput {
    /// Projects listed in the output.
    #[serde(default)]
    pub projects: Vec<DotNetListProject>,
}

/// Single project in `dotnet list` JSON output.
#[derive(Debug, Deserialize)]
pub struct DotNetListProject {
    /// Target frameworks containing package references.
    #[serde(default)]
    pub frameworks: Vec<DotNetListFramework>,
}

/// Single target framework in `dotnet list` JSON output.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotNetListFramework {
    /// Top-level package references for this framework.
    #[serde(default)]
    pub top_level_packages: Vec<DotNetListPackage>,
}

/// Single package in `dotnet list` JSON output.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotNetListPackage {
    /// Package identifier.
    pub id: String,
    /// Version string as specified in the project file.
    #[serde(default)]
    pub requested_version: String,
    /// Actual resolved version after restore.
    #[serde(default)]
    pub resolved_version: String,
}
