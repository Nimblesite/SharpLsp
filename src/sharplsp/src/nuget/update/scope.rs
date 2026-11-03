//! Version ownership and shared consumers. [NUGET-REQUESTS-UPDATE-CONFIRM]
use crate::nuget::{
    parse, targets,
    types::{NuGetTarget, TargetKind},
};
use std::{collections::BTreeSet, path::Path};

/// Every project the proposed shared version moves, without naming props as a project.
pub(super) fn affected_projects(target: &NuGetTarget, package_id: &str) -> Vec<String> {
    let owner = version_owner(target);
    if owner == target.path && target.kind == TargetKind::Project {
        return vec![target.path.clone()];
    }
    let sharing = crate::paths::directory_of(&owner)
        .and_then(|root| targets::enumerate_targets(&root.to_string_lossy()).ok())
        .map_or_else(Vec::new, |found| found.targets);
    let projects = sharing
        .into_iter()
        .filter(|found| found.kind == TargetKind::Project)
        .filter(|found| consumes_version(&found.path, &owner, package_id))
        .map(|found| found.path);
    let selected = (target.kind == TargetKind::Project).then(|| target.path.clone());
    let all: BTreeSet<String> = projects.chain(selected).collect();
    all.into_iter().collect()
}

/// Only projects importing this exact props file consume its version declaration.
fn consumes_version(project: &str, owner: &str, package_id: &str) -> bool {
    let central = crate::paths::has_file_name(owner, "Directory.Packages.props");
    let file_name = if central {
        "Directory.Packages.props"
    } else {
        "Directory.Build.props"
    };
    let imported = targets::find_nearest(Path::new(project), file_name);
    imported.is_some_and(|path| {
        crate::paths::comparison_key(&path.to_string_lossy()) == crate::paths::comparison_key(owner)
    }) && (!central || references_package(project, package_id))
}

/// Whether the project declares the package; `NuGet` ids ignore case.
fn references_package(path: &str, package_id: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|text| {
        parse::read_package_items(&text, "PackageReference")
            .iter()
            .any(|item| item.id.eq_ignore_ascii_case(package_id))
    })
}

/// An explicitly selected props file owns itself; CPM otherwise owns project versions.
pub(super) fn version_owner(target: &NuGetTarget) -> String {
    if target.kind == TargetKind::BuildProps {
        return target.path.clone();
    }
    targets::find_packages_props(Path::new(&target.path)).map_or_else(
        || target.path.clone(),
        |path| path.to_string_lossy().into_owned(),
    )
}
