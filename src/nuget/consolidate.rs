//! [PKG-CONSOLIDATE] Hoist `NuGet` packages shared by ≥2 projects into a
//! solution-root `Directory.Build.props`.
//!
//! Pure Tier-1 logic: enumerate projects (reuse [`super::targets`]), read their
//! `PackageReference` items (reuse [`super::parse`]), and move shared ones via
//! the trivia-preserving [`super::xml_edit`]. No sidecar, no second XML editor.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tracing::info;

use super::types::{ConsolidateResponse, MovedPackage};
use super::xml_edit::{self, PackageElement};
use super::{parse, targets};

/// Body written when the solution has no `Directory.Build.props` yet.
const EMPTY_PROPS: &str = "<Project>\n</Project>\n";

/// A package referenced by two or more projects, ready to hoist.
#[derive(Debug)]
struct SharedPackage {
    /// Package identifier.
    id: String,
    /// Highest declared version, or `None` when every reference is versionless.
    version: Option<String>,
    /// Absolute paths of the projects that declared the reference.
    projects: Vec<PathBuf>,
}

/// Consolidate shared packages for the solution at `solution_path`.
///
/// When `dry_run` is set the shared packages are reported without touching any
/// files, so the UI can confirm the (destructive) move before it happens.
pub fn consolidate(solution_path: &str, dry_run: bool) -> Result<ConsolidateResponse> {
    let solution_dir = Path::new(solution_path)
        .parent()
        .map(Path::to_path_buf)
        .with_context(|| format!("solution has no parent dir: {solution_path}"))?;

    let scan = targets::enumerate_targets(&solution_dir.to_string_lossy())?;
    let projects = collect_project_paths(&scan.targets);
    let shared = scan_shared(&projects)?;

    if shared.is_empty() {
        return Ok(empty_response("No packages are shared across 2+ projects."));
    }

    if dry_run {
        return Ok(describe(scan.cpm_enabled, &shared));
    }

    apply(&solution_dir, scan.cpm_enabled, &shared)
}

/// Build a no-write preview response describing what `apply` would move.
fn describe(cpm_enabled: bool, shared: &[SharedPackage]) -> ConsolidateResponse {
    let moved: Vec<MovedPackage> = shared
        .iter()
        .map(|pkg| MovedPackage {
            id: pkg.id.clone(),
            version: if cpm_enabled {
                String::new()
            } else {
                pkg.version.clone().unwrap_or_default()
            },
            from_projects: pkg.projects.iter().map(|p| file_label(p)).collect(),
        })
        .collect();
    ConsolidateResponse {
        message: format!("{} package(s) shared across 2+ projects.", moved.len()),
        moved,
        props_file: None,
        modified_files: Vec::new(),
    }
}

/// Project-kind absolute paths from an enumerated target list.
fn collect_project_paths(targets: &[super::types::NuGetTarget]) -> Vec<PathBuf> {
    targets
        .iter()
        .filter(|t| t.kind == super::types::TargetKind::Project)
        .map(|t| PathBuf::from(&t.path))
        .collect()
}

/// Group `PackageReference` ids across projects and keep those in ≥2 projects.
fn scan_shared(projects: &[PathBuf]) -> Result<Vec<SharedPackage>> {
    /// Per-id accumulator: declaring projects + the versions seen.
    type Acc = (Vec<PathBuf>, Vec<String>);
    let mut map: BTreeMap<String, Acc> = BTreeMap::new();

    for project in projects {
        let text = std::fs::read_to_string(project)
            .with_context(|| format!("read {}", project.display()))?;
        for item in parse::read_package_items(&text, "PackageReference") {
            if !item.simple {
                continue; // metadata-bearing refs are reported elsewhere, never moved
            }
            let entry = map.entry(item.id).or_default();
            if !entry.0.contains(project) {
                entry.0.push(project.clone());
            }
            if let Some(version) = item.version {
                entry.1.push(version);
            }
        }
    }

    Ok(map
        .into_iter()
        .filter(|(_, (projects, _))| projects.len() >= 2)
        .map(|(id, (projects, versions))| SharedPackage {
            id,
            version: highest_version(&versions),
            projects,
        })
        .collect())
}

/// Hoist every shared package into `Directory.Build.props` and strip it from
/// the projects that declared it.
fn apply(
    solution_dir: &Path,
    cpm_enabled: bool,
    shared: &[SharedPackage],
) -> Result<ConsolidateResponse> {
    let props_path = ensure_props(solution_dir)?;
    let element = if cpm_enabled {
        PackageElement::ReferenceNoVersion
    } else {
        PackageElement::Reference
    };

    let mut moved = Vec::new();
    let mut modified = vec![props_path.to_string_lossy().to_string()];

    for pkg in shared {
        let version = pkg.version.clone().unwrap_or_default();
        let _ = xml_edit::add_package(&props_path, &pkg.id, &version, element)?;
        let from_projects = strip_from_projects(&pkg.projects, &pkg.id, &mut modified)?;
        moved.push(MovedPackage {
            id: pkg.id.clone(),
            version: if cpm_enabled { String::new() } else { version },
            from_projects,
        });
    }

    info!(
        "consolidate: moved {} package(s) into {}",
        moved.len(),
        props_path.display()
    );
    Ok(ConsolidateResponse {
        message: summarize(&moved),
        moved,
        props_file: Some(props_path.to_string_lossy().to_string()),
        modified_files: modified,
    })
}

/// Remove `package_id` from each project, recording display names + edits.
fn strip_from_projects(
    projects: &[PathBuf],
    package_id: &str,
    modified: &mut Vec<String>,
) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for project in projects {
        let outcome = xml_edit::remove_package(project, package_id, PackageElement::Reference)?;
        if outcome.modified {
            modified.push(project.to_string_lossy().to_string());
        }
        names.push(file_label(project));
    }
    Ok(names)
}

/// Ensure a `Directory.Build.props` exists at the solution root; create a
/// minimal one if absent. Returns its path.
fn ensure_props(solution_dir: &Path) -> Result<PathBuf> {
    let path = solution_dir.join("Directory.Build.props");
    if !path.exists() {
        std::fs::write(&path, EMPTY_PROPS).with_context(|| format!("create {}", path.display()))?;
        info!("consolidate: created {}", path.display());
    }
    Ok(path)
}

/// Display label for a project path (its file name).
fn file_label(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map_or_else(|| path.to_string_lossy().to_string(), String::from)
}

/// Build the empty/no-op response with a message.
fn empty_response(message: &str) -> ConsolidateResponse {
    ConsolidateResponse {
        moved: Vec::new(),
        props_file: None,
        modified_files: Vec::new(),
        message: message.to_string(),
    }
}

/// One-line human summary of a consolidation result.
fn summarize(moved: &[MovedPackage]) -> String {
    let names: Vec<String> = moved.iter().map(|m| m.id.clone()).collect();
    format!(
        "Moved {} package(s) into Directory.Build.props: {}",
        moved.len(),
        names.join(", ")
    )
}

/// Pick the highest version from a list, or `None` if empty.
fn highest_version(versions: &[String]) -> Option<String> {
    versions.iter().max_by(|a, b| cmp_versions(a, b)).cloned()
}

/// Compare two `NuGet` versions: numeric core descending, prerelease < release.
fn cmp_versions(a: &str, b: &str) -> Ordering {
    let (core_a, pre_a) = split_prerelease(a);
    let (core_b, pre_b) = split_prerelease(b);
    match cmp_core(core_a, core_b) {
        Ordering::Equal => match (pre_a.is_empty(), pre_b.is_empty()) {
            (true, false) => Ordering::Greater, // release > prerelease
            (false, true) => Ordering::Less,
            _ => pre_a.cmp(pre_b),
        },
        other => other,
    }
}

/// Split a version into its numeric core and prerelease tail (at the first `-`).
fn split_prerelease(version: &str) -> (&str, &str) {
    version.split_once('-').unwrap_or((version, ""))
}

/// Compare dotted numeric cores segment by segment (missing segments are 0).
fn cmp_core(a: &str, b: &str) -> Ordering {
    let mut sa = a.split('.');
    let mut sb = b.split('.');
    loop {
        match (sa.next(), sb.next()) {
            (None, None) => return Ordering::Equal,
            (left, right) => {
                let na = left.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                let nb = right.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                if na != nb {
                    return na.cmp(&nb);
                }
            }
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;
    use std::fmt::Write as _;
    use tempfile::TempDir;

    /// Write a project file with the given `PackageReference` lines.
    fn write_project(dir: &Path, name: &str, refs: &[(&str, &str)]) -> PathBuf {
        let mut body = String::from("<Project Sdk=\"Microsoft.NET.Sdk\">\n  <ItemGroup>\n");
        for (id, version) in refs {
            let _ = writeln!(
                body,
                "    <PackageReference Include=\"{id}\" Version=\"{version}\" />"
            );
        }
        body.push_str("  </ItemGroup>\n</Project>\n");
        let path = dir.join(format!("{name}.csproj"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    /// Create a solution dir with a `.sln` and return its path.
    fn write_solution(dir: &Path) -> String {
        let sln = dir.join("App.sln");
        std::fs::write(&sln, "Microsoft Visual Studio Solution File\n").unwrap();
        sln.to_string_lossy().to_string()
    }

    #[test]
    fn cmp_versions_orders_numeric_and_prerelease() {
        assert_eq!(cmp_versions("13.0.3", "13.0.4"), Ordering::Less);
        assert_eq!(cmp_versions("3.1.0", "3.1.0"), Ordering::Equal);
        assert_eq!(cmp_versions("2.0.0", "1.9.9"), Ordering::Greater);
        // Release outranks an equal-core prerelease.
        assert_eq!(cmp_versions("1.0.0", "1.0.0-beta"), Ordering::Greater);
        assert_eq!(cmp_versions("1.0.0-alpha", "1.0.0-beta"), Ordering::Less);
    }

    #[test]
    fn highest_version_picks_max() {
        let versions = vec![
            "1.0.0".to_string(),
            "3.1.0".to_string(),
            "2.5.0".to_string(),
        ];
        assert_eq!(highest_version(&versions), Some("3.1.0".to_string()));
        assert_eq!(highest_version(&[]), None);
    }

    #[test]
    fn scan_finds_only_packages_in_two_or_more_projects() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        let a = write_project(root, "A/A", &[("Serilog", "3.1.0"), ("OnlyA", "1.0.0")]);
        let b = write_project(root, "B/B", &[("Serilog", "3.0.0"), ("OnlyB", "1.0.0")]);
        let shared = scan_shared(&[a, b]).unwrap();
        assert_eq!(shared.len(), 1, "only Serilog is shared");
        assert_eq!(shared[0].id, "Serilog");
        // Highest of 3.1.0 / 3.0.0.
        assert_eq!(shared[0].version, Some("3.1.0".to_string()));
        assert_eq!(shared[0].projects.len(), 2);
    }

    #[test]
    fn consolidate_hoists_shared_and_strips_projects() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        let sln = write_solution(root);
        let a = write_project(root, "A/A", &[("Serilog", "3.1.0")]);
        let b = write_project(root, "B/B", &[("Serilog", "3.0.0")]);

        let resp = consolidate(&sln, false).unwrap();
        assert_eq!(resp.moved.len(), 1);
        assert_eq!(resp.moved[0].id, "Serilog");
        assert_eq!(resp.moved[0].version, "3.1.0");

        // Directory.Build.props now declares Serilog once.
        let props = std::fs::read_to_string(root.join("Directory.Build.props")).unwrap();
        assert!(props.contains("Include=\"Serilog\" Version=\"3.1.0\""));

        // Projects no longer reference Serilog.
        assert!(!std::fs::read_to_string(&a).unwrap().contains("Serilog"));
        assert!(!std::fs::read_to_string(&b).unwrap().contains("Serilog"));
    }

    #[test]
    fn consolidate_reports_nothing_when_no_shared_packages() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        let sln = write_solution(root);
        let _a = write_project(root, "A/A", &[("OnlyA", "1.0.0")]);
        let _b = write_project(root, "B/B", &[("OnlyB", "1.0.0")]);

        let resp = consolidate(&sln, false).unwrap();
        assert!(resp.moved.is_empty());
        assert!(resp.props_file.is_none());
        // No props file should have been created.
        assert!(!root.join("Directory.Build.props").exists());
    }

    #[test]
    fn dry_run_reports_moves_without_touching_files() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        let sln = write_solution(root);
        let a = write_project(root, "A/A", &[("Serilog", "3.1.0")]);
        let b = write_project(root, "B/B", &[("Serilog", "3.1.0")]);

        let resp = consolidate(&sln, true).unwrap();
        assert_eq!(
            resp.moved.len(),
            1,
            "dry run still reports the shared package"
        );
        assert_eq!(resp.moved[0].id, "Serilog");
        assert!(resp.props_file.is_none());
        assert!(resp.modified_files.is_empty());
        // Nothing on disk changed.
        assert!(!root.join("Directory.Build.props").exists());
        assert!(std::fs::read_to_string(&a).unwrap().contains("Serilog"));
        assert!(std::fs::read_to_string(&b).unwrap().contains("Serilog"));
    }

    #[test]
    fn consolidate_preserves_existing_props_content() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        let sln = write_solution(root);
        std::fs::write(
            root.join("Directory.Build.props"),
            "<Project>\n  <!-- keep me -->\n</Project>\n",
        )
        .unwrap();
        let _a = write_project(root, "A/A", &[("Serilog", "3.1.0")]);
        let _b = write_project(root, "B/B", &[("Serilog", "3.1.0")]);

        let resp = consolidate(&sln, false).unwrap();
        assert_eq!(resp.moved.len(), 1);
        let props = std::fs::read_to_string(root.join("Directory.Build.props")).unwrap();
        assert!(props.contains("<!-- keep me -->"), "comment preserved");
        assert!(props.contains("Serilog"));
    }
}
