//! A file's family: the files beside it that share its name up to the first
//! dot. [SHARPLSP-FEATURES-NAVIGATION-RELATED]
use std::path::{Path, PathBuf};

use super::{comparison_key, directory_of, file_name_of, same_native_path};

/// The name of `path` up to its first dot, as two spellings of it compare:
/// `Form1.Designer.cs` and `form1.resx` are both of family `Form1`.
fn family_of(path: &Path) -> Option<String> {
    file_name_of(path)
        .and_then(|name| name.split('.').next())
        .filter(|family| !family.is_empty())
        .map(comparison_key)
}

/// The files in the directory of `path` that share its family, without `path`
/// itself, sorted by path. A file with no directory, or one that cannot be
/// listed, has none.
pub fn family_siblings(path: &Path) -> Vec<PathBuf> {
    let Some((directory, family)) = directory_of(path).zip(family_of(path)) else {
        return Vec::new();
    };
    let mut siblings: Vec<PathBuf> = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|candidate| candidate.is_file() && !same_native_path(candidate, path))
        .filter(|candidate| family_of(candidate).as_ref() == Some(&family))
        .collect();
    siblings.sort();
    siblings
}
