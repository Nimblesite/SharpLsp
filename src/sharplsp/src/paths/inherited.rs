//! Canonical native scope for inherited analyzer/build inputs. [DIAG-LSP-REFRESH]
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::{has_file_name, is_diagnostic_input, minimal_watch_roots, normalized_rename_path};

/// Ancestor subscriptions are shallow and cannot replace recursive compiler roots.
pub fn diagnostic_watch_scopes(
    roots: impl IntoIterator<Item = PathBuf>,
) -> BTreeMap<(String, bool), PathBuf> {
    let recursive = minimal_watch_roots(roots);
    let inherited = inherited_roots(&recursive);
    recursive
        .into_iter()
        .map(|(key, root)| ((key, true), root))
        .chain(
            inherited
                .into_iter()
                .map(|(key, root)| ((key, false), root)),
        )
        .collect()
}

/// Watch shared ancestors once, excluding directories already covered recursively.
fn inherited_roots(roots: &BTreeMap<String, PathBuf>) -> BTreeMap<String, PathBuf> {
    roots
        .values()
        .flat_map(|root| root.ancestors().skip(1))
        .map(|root| {
            (
                normalized_rename_path(&root.to_string_lossy()),
                root.to_path_buf(),
            )
        })
        .filter(|(key, _)| {
            !roots
                .keys()
                .any(|root| super::watch_key_contains(root, key))
        })
        .collect()
}

/// Unrelated sources or sibling projects above the compiler cone never invalidate it.
pub fn diagnostic_input_in_scope(path: &Path, recursive: bool) -> bool {
    if recursive {
        return is_diagnostic_input(path);
    }
    [
        ".editorconfig",
        "fsharplint.json",
        "global.json",
        "Directory.Build.props",
        "Directory.Build.targets",
        "Directory.Packages.props",
        "nuget.config",
    ]
    .into_iter()
    .any(|name| has_file_name(path, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_ancestor_scopes(parent: &Path, project: &Path, nested: &Path) {
        let scopes = diagnostic_watch_scopes([project.to_path_buf(), nested.to_path_buf()]);
        let key = |path: &Path| normalized_rename_path(&path.to_string_lossy());
        assert!(scopes.contains_key(&(key(project), true)));
        assert!(scopes.contains_key(&(key(parent), false)));
        assert!(!scopes.contains_key(&(key(project), false)));
        assert!(!scopes.contains_key(&(key(nested), true)));
    }

    #[test]
    fn ancestor_scopes_are_shallow_and_recursive_roots_are_minimal() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let project = parent.path().join("solution");
        let nested = project.join("project");
        std::fs::create_dir_all(&nested)?;
        assert_ancestor_scopes(parent.path(), &project, &nested);
        Ok(())
    }

    fn assert_scope_replacement(parent: &Path, nested: &Path) {
        let key = normalized_rename_path(&parent.to_string_lossy());
        let previous = diagnostic_watch_scopes([nested.to_path_buf()]);
        let current = diagnostic_watch_scopes([parent.to_path_buf()]);
        assert!(previous.contains_key(&(key.clone(), false)));
        assert!(!previous.contains_key(&(key.clone(), true)));
        assert!(current.contains_key(&(key.clone(), true)));
        assert!(!current.contains_key(&(key, false)));
    }

    #[test]
    fn selecting_an_ancestor_replaces_its_shallow_subscription() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let nested = parent.path().join("solution");
        std::fs::create_dir(&nested)?;
        assert_scope_replacement(parent.path(), &nested);
        Ok(())
    }

    #[test]
    fn shallow_inputs_accept_inherited_config_and_ignore_unrelated_sources() {
        for name in [
            "fsharplint.json",
            ".editorconfig",
            "Directory.Build.props",
            "global.json",
        ] {
            assert!(diagnostic_input_in_scope(Path::new(name), false));
            assert!(diagnostic_input_in_scope(Path::new(name), true));
        }
        for name in ["Unrelated.fs", "Sibling.csproj", "Other.json"] {
            assert!(!diagnostic_input_in_scope(Path::new(name), false));
        }
        assert!(diagnostic_input_in_scope(Path::new("Unrelated.fs"), true));
        assert!(diagnostic_input_in_scope(Path::new("Sibling.csproj"), true));
    }
}
