//! Workspace enumeration for `NuGet` install targets.
//!
//! Walks a workspace root collecting every `.csproj`, `.fsproj`,
//! `Directory.Build.props`, and `Directory.Packages.props` — the full set of
//! files into which a `PackageReference` could legitimately be added.
//!
//! Also detects Central Package Management (CPM): the presence of a
//! `Directory.Packages.props` file with
//! `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tracing::info;

use super::types::{NuGetTarget, TargetKind, TargetLanguage, TargetsResponse};

const MAX_DEPTH: usize = 12;

/// Directories that never contain a real project file.
const SKIP_DIRS: &[&str] = &[
    "bin",
    "obj",
    "node_modules",
    ".git",
    ".vs",
    ".idea",
    "target",
    "dist",
    "out",
    "artifacts",
    "packages",
];

/// Enumerate all `NuGet` install targets under a workspace root.
pub fn enumerate_targets(workspace_root: &str) -> Result<TargetsResponse> {
    let root = PathBuf::from(workspace_root);
    if !root.exists() {
        anyhow::bail!("workspace root does not exist: {workspace_root}");
    }

    let mut targets: Vec<NuGetTarget> = Vec::new();
    let mut cpm_file: Option<String> = None;
    walk(&root, &root, 0, &mut targets, &mut cpm_file)?;

    // Stable ordering: projects first (alpha), then props files (alpha).
    targets.sort_by(|a, b| {
        use std::cmp::Ordering;
        match (a.kind, b.kind) {
            (TargetKind::Project, TargetKind::BuildProps) => Ordering::Less,
            (TargetKind::BuildProps, TargetKind::Project) => Ordering::Greater,
            _ => a.display_name.cmp(&b.display_name),
        }
    });

    let cpm_enabled = cpm_file
        .as_deref()
        .is_some_and(|p| detect_cpm(Path::new(p)).unwrap_or(false));

    let default_target_id = targets.first().map(|t| t.id.clone());

    info!(
        "nuget/targets: {} targets in {workspace_root} (cpm={cpm_enabled})",
        targets.len()
    );

    Ok(TargetsResponse {
        targets,
        default_target_id,
        cpm_enabled,
        cpm_file,
    })
}

/// Recursive workspace walker (bounded depth + skip-list).
fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<NuGetTarget>,
    cpm_file: &mut Option<String>,
) -> Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }

    // Permission denied / transient — skip quietly.
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            if should_skip_dir(&path) {
                continue;
            }
            walk(root, &path, depth + 1, out, cpm_file)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        classify_file(root, &path, out, cpm_file);
    }
    Ok(())
}

fn should_skip_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| name.starts_with('.') || SKIP_DIRS.contains(&name))
}

/// Classify a single file and push a target if it matches.
fn classify_file(
    root: &Path,
    path: &Path,
    out: &mut Vec<NuGetTarget>,
    cpm_file: &mut Option<String>,
) {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };

    let abs = path.to_string_lossy().to_string();

    if file_name.eq_ignore_ascii_case("Directory.Packages.props") {
        if cpm_file.is_none() {
            *cpm_file = Some(abs.clone());
        }
        out.push(build_props_target(root, path, file_name));
        return;
    }

    if file_name.eq_ignore_ascii_case("Directory.Build.props") {
        out.push(build_props_target(root, path, file_name));
        return;
    }

    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if ext.eq_ignore_ascii_case("csproj") {
            out.push(project_target(path, file_name, TargetLanguage::CSharp));
        } else if ext.eq_ignore_ascii_case("fsproj") {
            out.push(project_target(path, file_name, TargetLanguage::FSharp));
        }
    }
}

fn project_target(path: &Path, file_name: &str, language: TargetLanguage) -> NuGetTarget {
    let abs = path.to_string_lossy().to_string();
    NuGetTarget {
        id: abs.clone(),
        kind: TargetKind::Project,
        display_name: file_name.to_string(),
        path: abs,
        language: Some(language),
        framework: Vec::new(),
    }
}

fn build_props_target(root: &Path, path: &Path, file_name: &str) -> NuGetTarget {
    let abs = path.to_string_lossy().to_string();
    let rel = path
        .parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let display = if rel.is_empty() {
        format!("{file_name} (solution root)")
    } else {
        format!("{file_name} ({rel})")
    };
    NuGetTarget {
        id: abs.clone(),
        kind: TargetKind::BuildProps,
        display_name: display,
        path: abs,
        language: None,
        framework: Vec::new(),
    }
}

/// Parse a `Directory.Packages.props` file for the CPM switch.
///
/// Text search is sufficient — the element is a single bool and any reasonable
/// props file has it as plain text (no expansions). We don't want a full XML
/// parser just for this.
fn detect_cpm(path: &Path) -> Result<bool> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    // Normalise whitespace to catch `<ManagePackageVersionsCentrally>true` with
    // any amount of internal whitespace.
    let normalized: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    Ok(
        normalized
            .contains("<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn enumerates_csproj_fsproj_and_props() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        write(root, "src/Foo/Foo.csproj", "<Project/>");
        write(root, "src/Bar/Bar.fsproj", "<Project/>");
        write(root, "Directory.Build.props", "<Project/>");
        write(root, "src/Directory.Packages.props", "<Project/>");
        write(root, "src/Foo/obj/project.assets.json", "{}"); // skipped
        write(root, "src/Foo/bin/Debug/Foo.dll", ""); // skipped

        let resp = enumerate_targets(root.to_str().unwrap()).unwrap();
        let kinds: Vec<_> = resp.targets.iter().map(|t| t.kind).collect();
        assert_eq!(
            kinds.iter().filter(|k| **k == TargetKind::Project).count(),
            2,
            "should find 2 projects"
        );
        assert_eq!(
            kinds
                .iter()
                .filter(|k| **k == TargetKind::BuildProps)
                .count(),
            2,
            "should find 2 props files"
        );
        // Default is first project (alpha order: Bar before Foo).
        assert!(resp.default_target_id.is_some());
    }

    #[test]
    fn detects_cpm_enabled() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        write(root, "Foo.csproj", "<Project/>");
        write(
            root,
            "Directory.Packages.props",
            "<Project>\n  <PropertyGroup>\n    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>\n  </PropertyGroup>\n</Project>",
        );

        let resp = enumerate_targets(root.to_str().unwrap()).unwrap();
        assert!(resp.cpm_enabled, "CPM should be detected");
        assert!(resp.cpm_file.is_some());
    }

    #[test]
    fn cpm_disabled_when_no_packages_props() {
        let td = TempDir::new().unwrap();
        let root = td.path();
        write(root, "Foo.csproj", "<Project/>");

        let resp = enumerate_targets(root.to_str().unwrap()).unwrap();
        assert!(!resp.cpm_enabled);
    }

    #[test]
    fn empty_workspace_returns_empty_targets() {
        let td = TempDir::new().unwrap();
        let resp = enumerate_targets(td.path().to_str().unwrap()).unwrap();
        assert!(resp.targets.is_empty());
        assert!(resp.default_target_id.is_none());
    }
}
