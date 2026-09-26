//! Walking a folder for the files a feature needs, build output skipped: the
//! workspace-symbol scan's sources and a folder target's projects.
//! Implements [SE-WORKSPACE-SYMBOLS-REQUEST] ("build output skipped").

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Directories a walk never enters: build output, VCS metadata, JS packages.
const SKIPPED: [&str; 4] = ["bin", "obj", ".git", "node_modules"];

/// Deepest nesting a walk descends. Far past any real source tree, it still
/// ends a link cycle the visited set cannot see.
const MAX_DEPTH: usize = 64;

/// Recursively collect the files `keep` accepts, skipping build output.
///
/// Each directory is walked once, by its canonical path. A junction or symlink
/// looping back to an ancestor — not exotic on Windows, where `node_modules`
/// mirrors and cloud-sync shims create them — made the walk descend the same tree
/// again and again, listing its files at every level and, with two such links,
/// never finishing (GitHub #169).
pub(crate) fn collect_files(dir: &Path, keep: fn(&Path) -> bool, files: &mut Vec<String>) {
    walk(dir, keep, files, &mut HashSet::new(), 0);
}

/// One directory of the walk, unless it was walked already or is too deep.
fn walk(
    dir: &Path,
    keep: fn(&Path) -> bool,
    files: &mut Vec<String>,
    walked: &mut HashSet<PathBuf>,
    depth: usize,
) {
    if depth > MAX_DEPTH || !first_visit(dir, walked) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        if path.is_dir() {
            if !is_skipped(&path) {
                walk(&path, keep, files, walked, depth + 1);
            }
        } else if keep(&path) {
            files.push(path.to_string_lossy().to_string());
        }
    }
}

/// Record `dir` by its canonical path; false when that path was walked before,
/// or `dir` does not resolve at all.
fn first_visit(dir: &Path, walked: &mut HashSet<PathBuf>) -> bool {
    crate::paths::canonical_buf(dir).is_some_and(|canonical| walked.insert(canonical))
}

/// Whether `dir` is build output or metadata the walk skips.
fn is_skipped(dir: &Path) -> bool {
    crate::paths::file_name_of(dir).is_some_and(|name| SKIPPED.contains(&name))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    /// Any file with an extension: the walk, not the filter, is under test.
    fn any_file(path: &Path) -> bool {
        path.extension().is_some()
    }

    /// `link` → `target` as a directory link: a symlink on Unix, a junction —
    /// which needs no privilege — on Windows.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "mklink /J must create the junction");
        }
    }

    /// A link back to an ancestor, and a second link to one tree, are walked
    /// once each: every file is listed exactly once, from its real place
    /// (GitHub #169).
    #[test]
    fn a_link_cycle_or_a_second_link_to_a_tree_lists_each_file_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let shared = root.join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::write(root.join("Root.cs"), "").unwrap();
        std::fs::write(shared.join("Shared.fs"), "").unwrap();
        link_dir(root, &shared.join("loop"));
        link_dir(&shared, &root.join("alias"));

        let mut files = Vec::new();
        collect_files(root, any_file, &mut files);
        files.sort();

        assert_eq!(files.len(), 2, "each file once: {files:?}");
        assert!(files.iter().any(|file| file.ends_with("Root.cs")));
        assert_eq!(
            files
                .iter()
                .filter(|file| file.ends_with("Shared.fs"))
                .count(),
            1,
            "the shared tree is walked once, however many links reach it: {files:?}"
        );
    }
}
