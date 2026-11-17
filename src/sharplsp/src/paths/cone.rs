//! The project cone: the nearest directory at or above a document that holds
//! a project or solution. One directory listing per level, never a tree walk.
//! Implements [SCRIPT-CONE].
use std::path::{Path, PathBuf};

use super::{directory_of, has_extension, has_file_name, same_native_path};

/// The files whose presence makes a directory own the documents beneath it.
const OWNERS: [&str; 4] = ["sln", "slnx", "csproj", "fsproj"];

/// What one directory says about the walk toward the filesystem root.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Level {
    /// It holds a project or solution: the walk ends, the document is owned.
    Owner,
    /// It is the workspace root or a repository root: the walk ends unowned.
    Boundary,
    /// Neither: the walk goes on to its parent.
    Open,
}

/// Classify `directory` from one listing of it. A project wins over a
/// boundary in the same directory; one that cannot be listed owns nothing.
fn level(directory: &Path, workspace_root: Option<&Path>) -> Level {
    let entries: Vec<PathBuf> = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    let at_root = workspace_root.is_some_and(|root| same_native_path(directory, root));
    if entries.iter().any(|entry| has_extension(entry, &OWNERS)) {
        Level::Owner
    } else if at_root || entries.iter().any(|entry| has_file_name(entry, ".git")) {
        Level::Boundary
    } else {
        Level::Open
    }
}

/// The directory whose project or solution owns `document`: the first at or
/// above it holding a `.sln`, `.slnx`, `.csproj` or `.fsproj`. The walk stops
/// unowned at `workspace_root`, at a directory holding `.git`, and at the
/// filesystem root.
pub fn cone_owner(document: &Path, workspace_root: Option<&Path>) -> Option<PathBuf> {
    std::iter::successors(directory_of(document), |directory| directory_of(directory))
        .map(|directory| (level(&directory, workspace_root), directory))
        .find(|(found, _)| *found != Level::Open)
        .and_then(|(found, directory)| (found == Level::Owner).then_some(directory))
}
