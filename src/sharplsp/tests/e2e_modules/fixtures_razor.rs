//! The Razor fixture solution (`tests/fixtures/razor`): a Blazor app, a Razor
//! class library, a Razor Pages and MVC app and an F# library, copied to a
//! temp directory and restored so the SDK's Razor generator runs in the
//! sidecar's design-time build. [RAZOR-TESTING]

use super::*;
use std::path::{Path, PathBuf};

/// A restored copy of the Razor fixture solution.
pub struct RazorWorkspace {
    /// Owns the temp directory; dropping it deletes the copy.
    pub dir: tempfile::TempDir,
}

impl RazorWorkspace {
    /// The copy's root directory, which holds `RazorFixtures.slnx`.
    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    /// A file in the copy, by its path segments under the root.
    pub fn file(&self, segments: &[&str]) -> PathBuf {
        segments
            .iter()
            .fold(self.root().to_path_buf(), |path, segment| {
                path.join(segment)
            })
    }

    /// The `vscode`-shaped URI of a file in the copy.
    pub fn uri(&self, segments: &[&str]) -> String {
        path_to_vscode_uri(&self.file(segments))
    }

    /// The text of a file in the copy.
    pub fn text(&self, segments: &[&str]) -> String {
        std::fs::read_to_string(self.file(segments)).expect("read Razor fixture file")
    }
}

/// Copy the Razor fixture solution to a temp directory and restore it.
pub fn create_razor_workspace() -> RazorWorkspace {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/razor");
    let dir = tempfile::tempdir().expect("create Razor temp dir");
    copy_fixture_tree(&source, dir.path());
    restore_project(dir.path());
    RazorWorkspace { dir }
}

/// Copy a fixture tree, leaving out build output (`bin`, `obj`).
fn copy_fixture_tree(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).expect("create fixture directory");
    for entry in std::fs::read_dir(source).expect("read fixture directory") {
        let entry = entry.expect("read fixture entry");
        let name = entry.file_name();
        let target = destination.join(&name);
        if entry.file_type().expect("fixture entry type").is_dir() {
            if name != "bin" && name != "obj" {
                copy_fixture_tree(&entry.path(), &target);
            }
        } else {
            let _ = std::fs::copy(entry.path(), &target).expect("copy fixture file");
        }
    }
}
