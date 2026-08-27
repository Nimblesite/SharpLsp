//! Package-reference editing via the C# sidecar's `MSBuild` document model.
//!
//! GitHub #4 / [NUGET-XML-DOM]: `PackageReference` / `PackageVersion` edits are
//! delegated to the C# sidecar, which mutates the file through
//! `Microsoft.Build.Construction.ProjectRootElement` (formatting-preserving) and
//! saves it. The host no longer manipulates project XML as text. `MSBuild`
//! editing is language-agnostic, so this handles `.csproj`, `.fsproj`, `.props`.

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::runtime::Runtime;

use crate::sidecar::manager::SidecarManager;

/// Result of a single-file edit operation.
#[derive(Debug, Clone)]
pub struct EditOutcome {
    /// Whether the file was actually changed on disk.
    pub modified: bool,
    /// Human-readable description of what happened.
    pub message: String,
}

/// Which element flavour the edit targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageElement {
    /// `<PackageReference Include="..." Version="..."/>`
    Reference,
    /// `<PackageReference Include="..."/>` (CPM csproj — version in props).
    ReferenceNoVersion,
    /// `<PackageVersion Include="..." Version="..."/>` (Directory.Packages.props).
    Version,
}

impl PackageElement {
    /// Wire tag understood by the sidecar's `PackageEditRequest.ElementKind`.
    fn kind(self) -> &'static str {
        match self {
            Self::Reference => "reference",
            Self::ReferenceNoVersion => "referenceNoVersion",
            Self::Version => "version",
        }
    }
}

/// Sidecar request payload (positional — must match C# `PackageEditRequest`
/// `[Key(0..3)]`).
#[derive(serde::Serialize)]
struct EditRequest {
    /// Absolute path to the project / props file to edit.
    file_path: String,
    /// Package id (the item's `Include`).
    package_id: String,
    /// Version to write (empty for removal / `referenceNoVersion`).
    version: String,
    /// `reference` | `referenceNoVersion` | `version`.
    element_kind: String,
}

/// Sidecar response payload (positional — must match C# `PackageEditResult`).
#[derive(serde::Deserialize)]
struct EditResponse {
    /// Whether the file changed on disk.
    modified: bool,
    /// Human-readable description of what happened.
    message: String,
}

/// Add (or version-update) a package entry via the sidecar.
pub fn add_package(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    file_path: &str,
    package_id: &str,
    version: &str,
    element: PackageElement,
) -> Result<EditOutcome> {
    dispatch(
        sidecar,
        runtime,
        "project/addPackage",
        file_path,
        package_id,
        version,
        element,
    )
}

/// Remove a package entry via the sidecar.
pub fn remove_package(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    file_path: &str,
    package_id: &str,
    element: PackageElement,
) -> Result<EditOutcome> {
    dispatch(
        sidecar,
        runtime,
        "project/removePackage",
        file_path,
        package_id,
        "",
        element,
    )
}

/// Serialize the request, round-trip it through the sidecar, and decode the outcome.
fn dispatch(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    method: &str,
    file_path: &str,
    package_id: &str,
    version: &str,
    element: PackageElement,
) -> Result<EditOutcome> {
    let request = EditRequest {
        file_path: file_path.to_string(),
        package_id: package_id.to_string(),
        version: version.to_string(),
        element_kind: element.kind().to_string(),
    };
    let payload = rmp_serde::to_vec(&request)?;
    let bytes = runtime
        .block_on(sidecar.request(method, payload))
        .with_context(|| format!("sidecar {method} for {file_path}"))?;
    let response: EditResponse = rmp_serde::from_slice(&bytes)?;
    Ok(EditOutcome {
        modified: response.modified,
        message: response.message,
    })
}
