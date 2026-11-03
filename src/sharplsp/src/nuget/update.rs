//! Bounded update proposals. Implements [NUGET-REQUESTS-UPDATE-BOUNDS].

use anyhow::{Context, Result};
use lsp_server::Request;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::path::Path;
use tokio::runtime::Runtime;
use tracing::info;

use super::{cli, lanes, parse, targets, types};
use types::{InstalledPackageInfo, NuGetTarget};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Parameters for the source-aware bounded update preview.
pub struct UpdatePreviewParams {
    /// Explicitly selected install target.
    #[serde(default)]
    pub target: Option<NuGetTarget>,
    /// Backwards-compatible project target.
    #[serde(default)]
    pub project_path: Option<String>,
    /// An installed direct package id.
    pub package_id: String,
    /// Exact explicit-picker selection; absent for the bounded default.
    #[serde(default)]
    pub selected_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
/// A fixed proposal; `proposedVersion: null` means no in-line update exists.
pub struct UpdatePreviewResponse {
    /// Target displayed in confirmation.
    pub target: NuGetTarget,
    /// Installed package displayed in confirmation.
    pub package_id: String,
    /// Exact declaration at preview time.
    pub requested_version: String,
    /// Currently resolved version.
    pub current_version: String,
    /// Exact stable in-line proposal or explicit selection, if one exists.
    pub proposed_version: Option<String>,
    /// Boundary crossed by an explicit selection.
    pub boundary: UpdateBoundary,
    /// Fixed explicit selection retained during revalidation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit_version: Option<String>,
    /// File that owns the version, including CPM props.
    pub version_owner: String,
    /// Projects known to be affected by this explicit target.
    pub affected_projects: Vec<String>,
    /// Human-readable no-candidate result or proposal summary.
    pub message: String,
}

/// One unambiguous direct declaration shared by all target frameworks.
#[derive(Debug)]
struct Declaration {
    /// Exact version text requested by the project.
    requested: String,
    /// Version resolved by `NuGet`.
    resolved: String,
}

/// Handle `sharplsp/nuget/updatePreview`. [NUGET-REQUESTS-UPDATE-CONFIRM]
pub fn handle_preview(req: Request, runtime: &Runtime) -> Result<serde_json::Value> {
    info!("Handling sharplsp/nuget/updatePreview");
    let params: UpdatePreviewParams = serde_json::from_value(req.params)?;
    let target = super::handlers::resolve_target(params.target, params.project_path)?;
    cli::ensure_project_target(&target)?;
    let lane = lanes::lane(&target.path)?;
    let response = runtime.block_on(async {
        let _listing = lane.lock().await;
        preview(
            &target,
            &params.package_id,
            params.selected_version.as_deref(),
        )
        .await
    })?;
    Ok(serde_json::to_value(response)?)
}

/// Version-line boundary identified by the host for explicit confirmation.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateBoundary {
    /// Default-compatible selection within the current line.
    SameLine,
    /// A different major version.
    Major,
    /// A different minor while the current major is zero.
    ZeroMinor,
    /// A prerelease selected explicitly.
    Prerelease,
}

/// Concrete explicit-picker proposal.
pub struct ExplicitProposal {
    /// Exact selected version.
    pub version: String,
    /// Boundary the user must confirm.
    pub boundary: UpdateBoundary,
}

/// Keep an explicit selection concrete and identify its opt-in boundary.
pub fn select_explicit(current: &str, selected: &str) -> Result<ExplicitProposal> {
    let current = parse(current)?;
    let selected_version =
        parse(selected).context("Explicit selection must be a concrete version")?;
    let boundary = explicit_boundary(&current, &selected_version);
    Ok(ExplicitProposal {
        version: selected.to_string(),
        boundary,
    })
}

/// Reject application when the preview's declaration is no longer current.
pub fn ensure_current(
    runtime: &Runtime,
    target: &NuGetTarget,
    package_id: &str,
    expected: Option<&str>,
    expected_requested: Option<&str>,
) -> Result<()> {
    if expected.is_none() && expected_requested.is_none() {
        return Ok(());
    }
    let lane = lanes::lane(&target.path)?;
    let current = runtime.block_on(async {
        let _listing = lane.lock().await;
        installed_declaration(target, package_id).await
    })?;
    ensure_snapshot(&current, expected, expected_requested)
}

/// Compare both parts of the declaration captured by the preview.
fn ensure_snapshot(
    current: &Declaration,
    resolved: Option<&str>,
    requested: Option<&str>,
) -> Result<()> {
    anyhow::ensure!(
        resolved.is_none_or(|expected| current.resolved == expected)
            && requested.is_none_or(|expected| current.requested == expected),
        "The package declaration changed; refresh the update preview instead of applying a stale choice"
    );
    Ok(())
}

/// Resolve the declaration and source inventory without modifying files.
async fn preview(
    target: &NuGetTarget,
    package_id: &str,
    selected: Option<&str>,
) -> Result<UpdatePreviewResponse> {
    let declaration = installed_declaration(target, package_id).await?;
    let (proposed, boundary) = match selected {
        Some(version) => explicit_proposal(&declaration.resolved, version)?,
        None => bounded_proposal(target, package_id, &declaration.resolved).await?,
    };
    Ok(preview_response(
        target,
        package_id,
        declaration,
        proposed,
        boundary,
        selected.map(str::to_string),
    ))
}

/// Select the default bounded candidate from the configured source.
async fn bounded_proposal(
    target: &NuGetTarget,
    package_id: &str,
    current: &str,
) -> Result<(Option<String>, UpdateBoundary)> {
    let parsed = parse(current)?;
    let outdated = cli::list_outdated(target, parsed.release[0] == 0).await?;
    let candidates = candidate_versions(outdated, package_id)?;
    let refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
    Ok((select_bounded(current, &refs)?, UpdateBoundary::SameLine))
}

/// Fix an explicit version and classify its boundary.
fn explicit_proposal(current: &str, selected: &str) -> Result<(Option<String>, UpdateBoundary)> {
    let proposal = select_explicit(current, selected)?;
    Ok((Some(proposal.version), proposal.boundary))
}

/// List every occurrence and require one exact direct declaration.
async fn installed_declaration(target: &NuGetTarget, package_id: &str) -> Result<Declaration> {
    let packages = cli::list_installed_occurrences(&target.path).await?;
    single_declaration(packages, package_id)
}

/// Reject absent, floating, ranged, or differently resolved declarations.
fn single_declaration(
    packages: Vec<InstalledPackageInfo>,
    package_id: &str,
) -> Result<Declaration> {
    let matches: Vec<_> = packages
        .into_iter()
        .filter(|package| package.id.eq_ignore_ascii_case(package_id))
        .collect();
    anyhow::ensure!(
        !matches.is_empty(),
        "{package_id} is not an installed direct package"
    );
    let declaration = unambiguous_declaration(&matches)?;
    validate_exact(&declaration.requested)?;
    validate_exact(&declaration.resolved)?;
    Ok(declaration)
}

/// Require all framework occurrences to share one requested and resolved version.
fn unambiguous_declaration(matches: &[InstalledPackageInfo]) -> Result<Declaration> {
    let requested = unique(matches.iter().map(|package| &package.requested_version));
    let resolved = unique(matches.iter().map(|package| &package.resolved_version));
    anyhow::ensure!(
        requested.len() == 1 && resolved.len() == 1,
        "Ambiguous installed versions; use explicit version selection instead"
    );
    Ok(Declaration {
        requested: one_version(requested),
        resolved: one_version(resolved),
    })
}

/// Extract the sole version after the ambiguity guard.
fn one_version(mut versions: BTreeSet<&String>) -> String {
    versions
        .pop_first()
        .map(String::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Collect distinct version strings across target frameworks.
fn unique<'a>(versions: impl Iterator<Item = &'a String>) -> BTreeSet<&'a String> {
    versions.collect()
}

/// Reject declaration syntax that is not a concrete `NuGet` version.
fn validate_exact(version: &str) -> Result<()> {
    let _parsed = parse(version).context(
        "The installed declaration is ambiguous; use explicit version selection instead",
    )?;
    Ok(())
}

/// Require all frameworks' source lookup to agree on one candidate.
fn candidate_versions(
    packages: Vec<types::OutdatedPackageInfo>,
    package_id: &str,
) -> Result<Vec<String>> {
    let candidates: BTreeSet<String> = packages
        .into_iter()
        .filter(|package| package.id.eq_ignore_ascii_case(package_id))
        .map(|package| package.latest_version)
        .collect();
    anyhow::ensure!(
        candidates.len() <= 1,
        "Ambiguous update candidates; use explicit version selection instead"
    );
    validate_candidates(&candidates, package_id)?;
    Ok(candidates.into_iter().collect())
}

/// Reject source sentinel text instead of mistaking it for no candidate.
fn validate_candidates(candidates: &BTreeSet<String>, package_id: &str) -> Result<()> {
    for candidate in candidates {
        let _parsed = parse(candidate)
            .with_context(|| format!("NuGet source lookup for {package_id} failed: {candidate}"))?;
    }
    Ok(())
}

/// Build the immutable confirmation snapshot and CPM ownership detail.
fn preview_response(
    target: &NuGetTarget,
    package_id: &str,
    declaration: Declaration,
    proposed: Option<String>,
    boundary: UpdateBoundary,
    explicit_version: Option<String>,
) -> UpdatePreviewResponse {
    let message = proposal_message(package_id, &declaration.resolved, proposed.as_deref());
    let owner = version_owner(target);
    UpdatePreviewResponse {
        target: target.clone(),
        package_id: package_id.to_string(),
        requested_version: declaration.requested,
        current_version: declaration.resolved,
        proposed_version: proposed,
        boundary,
        explicit_version,
        version_owner: owner,
        affected_projects: affected_projects(target, package_id),
        message,
    }
}

/// Human-readable fixed proposal or the exact no-candidate result.
fn proposal_message(package_id: &str, current: &str, proposed: Option<&str>) -> String {
    proposed.map_or_else(
        || "Already up to date within this version line".to_string(),
        |version| format!("Update {package_id} from {current} to {version}"),
    )
}

/// Every project the proposed version moves: the target, and under CPM each project
/// beside or below the owning props that references the package and reads its version
/// from those props. [NUGET-REQUESTS-UPDATE-CONFIRM]
fn affected_projects(target: &NuGetTarget, package_id: &str) -> Vec<String> {
    let Some(props) = targets::find_packages_props(Path::new(&target.path)) else {
        return vec![target.path.clone()];
    };
    let sharing = props
        .parent()
        .and_then(|root| targets::enumerate_targets(&root.to_string_lossy()).ok())
        .map_or_else(Vec::new, |found| found.targets);
    let projects = sharing
        .into_iter()
        .filter(|found| found.kind == types::TargetKind::Project)
        .filter(|found| {
            targets::find_packages_props(Path::new(&found.path)).as_ref() == Some(&props)
        })
        .filter(|found| references_package(&found.path, package_id))
        .map(|found| found.path);
    let all: BTreeSet<String> = projects.chain([target.path.clone()]).collect();
    all.into_iter().collect()
}

/// Whether the project at `path` declares `package_id`; `NuGet` ids ignore case.
fn references_package(path: &str, package_id: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|text| {
        parse::read_package_items(&text, "PackageReference")
            .iter()
            .any(|item| item.id.eq_ignore_ascii_case(package_id))
    })
}

/// CPM props own the version when present; otherwise the target does.
fn version_owner(target: &NuGetTarget) -> String {
    targets::find_packages_props(Path::new(&target.path)).map_or_else(
        || target.path.clone(),
        |path| path.to_string_lossy().into_owned(),
    )
}

/// `NuGet`'s four numeric release components plus ordered prerelease identifiers.
#[derive(Debug, Eq, PartialEq)]
struct NuGetVersion {
    /// Major, minor, patch, and revision; omitted components are zero.
    release: [u64; 4],
    /// Dot-separated `SemVer` prerelease identifiers.
    prerelease: Vec<Identifier>,
}

/// A prerelease identifier, numeric when `NuGet` gives it numeric precedence.
#[derive(Debug, Eq, PartialEq)]
enum Identifier {
    /// Numeric identifiers precede text and compare numerically.
    Numeric(u64),
    /// Text identifiers compare case-insensitively.
    Text(String),
}

/// Select the newest stable version above `current` in the same version line.
pub fn select_bounded(current: &str, candidates: &[&str]) -> Result<Option<String>> {
    let current = parse(current).context(
        "The installed declaration is ambiguous; use explicit version selection instead",
    )?;
    let selected = candidates
        .iter()
        .filter_map(|text| parse(text).ok().map(|version| (*text, version)))
        .filter(|(_, version)| version.prerelease.is_empty() && in_line(&current, version))
        .filter(|(_, version)| compare(version, &current) == Ordering::Greater)
        .max_by(|(_, left), (_, right)| compare(left, right));
    Ok(selected.map(|(text, _)| text.to_string()))
}

/// Identify which explicit opt-in boundary a selected version crosses.
fn explicit_boundary(current: &NuGetVersion, selected: &NuGetVersion) -> UpdateBoundary {
    if !selected.prerelease.is_empty() {
        UpdateBoundary::Prerelease
    } else if current.release[0] != selected.release[0] {
        UpdateBoundary::Major
    } else if current.release[0] == 0 && current.release[1] != selected.release[1] {
        UpdateBoundary::ZeroMinor
    } else {
        UpdateBoundary::SameLine
    }
}

/// Same major normally, and same minor too for major zero.
fn in_line(current: &NuGetVersion, candidate: &NuGetVersion) -> bool {
    current.release[0] == candidate.release[0]
        && (current.release[0] != 0 || current.release[1] == candidate.release[1])
}

/// Parse a concrete `NuGet` version, ignoring build metadata for precedence.
fn parse(text: &str) -> Result<NuGetVersion> {
    let without_metadata = text.split_once('+').map_or(text, |(version, _)| version);
    let (release, prerelease) = without_metadata
        .split_once('-')
        .map_or((without_metadata, ""), |(release, prerelease)| {
            (release, prerelease)
        });
    Ok(NuGetVersion {
        release: parse_release(release)?,
        prerelease: parse_prerelease(prerelease)?,
    })
}

/// Parse one through four unsigned numeric release components.
fn parse_release(text: &str) -> Result<[u64; 4]> {
    let parts: Vec<&str> = text.split('.').collect();
    anyhow::ensure!(
        (1..=4).contains(&parts.len()),
        "invalid NuGet release version"
    );
    let numbers = parts
        .into_iter()
        .map(|part| part.parse::<u64>().context("invalid NuGet release number"))
        .collect::<Result<Vec<_>>>()?;
    Ok(std::array::from_fn(|index| {
        numbers.get(index).copied().unwrap_or(0)
    }))
}

/// Parse dot-separated prerelease identifiers.
fn parse_prerelease(text: &str) -> Result<Vec<Identifier>> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    text.split('.')
        .map(|part| {
            anyhow::ensure!(!part.is_empty(), "invalid NuGet prerelease identifier");
            Ok(part.parse::<u64>().map_or_else(
                |_| Identifier::Text(part.to_ascii_lowercase()),
                Identifier::Numeric,
            ))
        })
        .collect()
}

/// Compare release components first and prerelease precedence second.
fn compare(left: &NuGetVersion, right: &NuGetVersion) -> Ordering {
    left.release
        .cmp(&right.release)
        .then_with(|| compare_prerelease(&left.prerelease, &right.prerelease))
}

/// A stable release outranks prereleases; otherwise use `SemVer` identifier order.
fn compare_prerelease(left: &[Identifier], right: &[Identifier]) -> Ordering {
    match (left.is_empty(), right.is_empty()) {
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (true, true) => return Ordering::Equal,
        (false, false) => {}
    }
    left.iter()
        .zip(right.iter())
        .map(|(left, right)| compare_identifier(left, right))
        .find(|ordering| *ordering != Ordering::Equal)
        .unwrap_or_else(|| left.len().cmp(&right.len()))
}

/// Compare two prerelease identifiers using NuGet/SemVer precedence.
fn compare_identifier(left: &Identifier, right: &Identifier) -> Ordering {
    match (left, right) {
        (Identifier::Numeric(left), Identifier::Numeric(right)) => left.cmp(right),
        (Identifier::Numeric(_), Identifier::Text(_)) => Ordering::Less,
        (Identifier::Text(_), Identifier::Numeric(_)) => Ordering::Greater,
        (Identifier::Text(left), Identifier::Text(right)) => left.cmp(right),
    }
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
