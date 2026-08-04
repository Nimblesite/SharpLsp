//! [PKG-UNUSED-MAP] Map a project's compilation reference paths to the direct
//! `PackageReference` entries that are provably unused.
//!
//! The sidecars (Roslyn / FCS) do the semantic work and return raw assembly
//! paths; the path → package-id mapping and the unused determination live here,
//! in one place, as pure functions — so the logic is unit-tested without a live
//! compilation and is never duplicated across the two sidecars.

use std::collections::HashSet;

use super::parse::PackageItem;
use super::types::UnusedPackage;

/// Reference-usage result returned by a sidecar `project/unusedPackages` query.
///
/// `MessagePack` positional contract — field order matches the sidecar's
/// `[Key(0..)]` response type.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ReferenceUsage {
    /// Absolute paths of assemblies actually used by the compilation.
    pub used_paths: Vec<String>,
    /// Absolute paths of every assembly referenced by the compilation.
    pub all_paths: Vec<String>,
    /// The `NuGet` global packages folder the sidecar resolved (may be empty).
    pub packages_root: String,
}

/// Marker for the default global packages layout when no root is supplied.
const NUGET_MARKER: &str = "/.nuget/packages/";

/// Determine which of `direct` references are unused, given the sidecar usage.
///
/// A reference is unused iff it contributes at least one compile assembly under
/// the packages folder (so analyzers / build-only / framework packages are
/// never flagged) and none of those assemblies is in the used set.
pub fn compute_unused(usage: &ReferenceUsage, direct: &[PackageItem]) -> Vec<UnusedPackage> {
    let used = id_set(&usage.used_paths, &usage.packages_root);
    let with_assembly = id_set(&usage.all_paths, &usage.packages_root);

    direct
        .iter()
        .filter(|item| {
            let key = item.id.to_lowercase();
            with_assembly.contains(&key) && !used.contains(&key)
        })
        .map(|item| UnusedPackage {
            id: item.id.clone(),
            version: item.version.clone().unwrap_or_default(),
        })
        .collect()
}

/// Collect the lowercased package ids resolvable from a set of assembly paths.
fn id_set(paths: &[String], root: &str) -> HashSet<String> {
    paths
        .iter()
        .filter_map(|path| package_id_from_path(path, root))
        .collect()
}

/// Extract the (lowercased) `NuGet` package id owning an assembly path.
///
/// Restored package assemblies live at
/// `<root>/<id-lowercased>/<version>/<asset-dir>/.../<assembly>.dll`. The id is
/// the first path segment under the global packages root, or under the
/// `/.nuget/packages/` marker when the root is unknown. Returns `None` for
/// assemblies that are not inside a packages folder (framework / project refs).
fn package_id_from_path(path: &str, root: &str) -> Option<String> {
    let normalized = path.replace('\\', "/").to_lowercase();

    let root_normalized = root.replace('\\', "/").to_lowercase();
    if !root_normalized.is_empty() {
        let trimmed = root_normalized.trim_end_matches('/');
        if let Some(rest) = normalized.strip_prefix(trimmed) {
            return first_segment(rest);
        }
    }

    let marker = normalized.find(NUGET_MARKER)?;
    let rest = normalized.get(marker + NUGET_MARKER.len()..)?;
    first_segment(rest)
}

/// First non-empty `/`-delimited segment of a path remainder.
fn first_segment(rest: &str) -> Option<String> {
    rest.trim_start_matches('/')
        .split('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
#[expect(
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    /// Build a `PackageItem` for a direct reference fixture.
    fn item(id: &str, version: &str) -> PackageItem {
        PackageItem {
            id: id.to_string(),
            version: Some(version.to_string()),
            simple: true,
        }
    }

    const ROOT: &str = "/home/u/.nuget/packages";

    #[test]
    fn maps_assembly_path_to_package_id_via_root() {
        let path = "/home/u/.nuget/packages/serilog/3.1.0/lib/net8.0/Serilog.dll";
        assert_eq!(
            package_id_from_path(path, ROOT),
            Some("serilog".to_string())
        );
    }

    #[test]
    fn maps_via_marker_when_root_unknown() {
        let path = "/home/u/.nuget/packages/newtonsoft.json/13.0.3/lib/net6.0/Newtonsoft.Json.dll";
        assert_eq!(
            package_id_from_path(path, ""),
            Some("newtonsoft.json".to_string())
        );
    }

    #[test]
    fn maps_windows_style_paths() {
        let path = r"C:\Users\u\.nuget\packages\Serilog\3.1.0\lib\net8.0\Serilog.dll";
        assert_eq!(
            package_id_from_path(path, r"C:\Users\u\.nuget\packages"),
            Some("serilog".to_string())
        );
    }

    #[test]
    fn framework_assembly_maps_to_no_package() {
        let path = "/usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.0/System.Runtime.dll";
        assert_eq!(package_id_from_path(path, ROOT), None);
    }

    #[test]
    fn flags_package_with_assembly_present_but_unused() {
        let usage = ReferenceUsage {
            used_paths: vec![format!("{ROOT}/serilog/3.1.0/lib/net8.0/Serilog.dll")],
            all_paths: vec![
                format!("{ROOT}/serilog/3.1.0/lib/net8.0/Serilog.dll"),
                format!("{ROOT}/newtonsoft.json/13.0.3/lib/net6.0/Newtonsoft.Json.dll"),
            ],
            packages_root: ROOT.to_string(),
        };
        let direct = vec![item("Serilog", "3.1.0"), item("Newtonsoft.Json", "13.0.3")];
        let unused = compute_unused(&usage, &direct);
        assert_eq!(unused.len(), 1);
        assert_eq!(unused[0].id, "Newtonsoft.Json");
        assert_eq!(unused[0].version, "13.0.3");
    }

    #[test]
    fn never_flags_package_with_no_compile_assembly() {
        // StyleCop.Analyzers contributes no compile assembly → not in all_paths.
        let usage = ReferenceUsage {
            used_paths: vec![format!("{ROOT}/serilog/3.1.0/lib/net8.0/Serilog.dll")],
            all_paths: vec![format!("{ROOT}/serilog/3.1.0/lib/net8.0/Serilog.dll")],
            packages_root: ROOT.to_string(),
        };
        let direct = vec![
            item("Serilog", "3.1.0"),
            item("StyleCop.Analyzers", "1.2.0"),
        ];
        let unused = compute_unused(&usage, &direct);
        assert!(
            unused.is_empty(),
            "analyzer without a compile assembly must not be flagged"
        );
    }

    #[test]
    fn case_insensitive_id_match() {
        let usage = ReferenceUsage {
            used_paths: vec![],
            all_paths: vec![format!(
                "{ROOT}/automapper/12.0.0/lib/net6.0/AutoMapper.dll"
            )],
            packages_root: ROOT.to_string(),
        };
        // Project declares mixed-case id; folder is lowercased.
        let direct = vec![item("AutoMapper", "12.0.0")];
        let unused = compute_unused(&usage, &direct);
        assert_eq!(unused.len(), 1);
        assert_eq!(unused[0].id, "AutoMapper", "original casing preserved");
    }

    #[test]
    fn transitive_package_not_in_direct_refs_is_ignored() {
        // A used-nowhere assembly that the project does not directly reference
        // must not be reported (it is not in `direct`).
        let usage = ReferenceUsage {
            used_paths: vec![],
            all_paths: vec![format!(
                "{ROOT}/transitive.dep/1.0.0/lib/net8.0/Transitive.Dep.dll"
            )],
            packages_root: ROOT.to_string(),
        };
        let direct = vec![item("Serilog", "3.1.0")];
        let unused = compute_unused(&usage, &direct);
        assert!(unused.is_empty());
    }
}
