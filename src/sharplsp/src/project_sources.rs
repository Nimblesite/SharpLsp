//! The source files a project's Solution Explorer node lists. `[SE-FSHARP-SYMBOLS]`
//!
//! A C# project lists the source files under its folder. An F# project lists its
//! evaluated Compile items, in compile order and wherever they sit on disk: a
//! project kept in `.vscode/` that compiles `../Source/Main.fs` (#493) listed
//! nothing while only its own folder was walked.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::Request;
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::sidecar::manager::SidecarManager;
use crate::source_walk::collect_files;

/// The F# sidecar request answering a project's Compile items, full paths in order.
const COMPILE_ITEMS: &str = "project/compileItems";

/// The source files `project`'s node lists. An F# project the sidecar cannot
/// evaluate falls back to its folder, and the reason is logged.
pub(crate) fn project_source_files(
    project: &Path,
    project_dir: &Path,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Vec<String> {
    let compiled = fsharp_sidecar
        .filter(|_| crate::paths::has_extension(project, &["fsproj"]))
        .map(|sidecar| compile_items(project, runtime, sidecar));
    match compiled {
        Some(Ok(items)) => items
            .into_iter()
            .filter(|item| is_fsharp_source(item))
            .collect(),
        Some(Err(error)) => {
            warn!(project = %project.display(), error = %error, "F# Compile items unavailable; listing the project folder");
            find_source_files(project_dir)
        }
        None => find_source_files(project_dir),
    }
}

/// Parameters of `sharplsp/project/compileItems`.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompileItemsParams {
    /// Absolute path of the `.fsproj`.
    project_path: String,
}

/// Handle `sharplsp/project/compileItems`: an F# project's Compile items, full
/// paths in compile order, so "Add F# Source File" can put a new file where the
/// project's sources live. `[SE-ADD-FILE-COMMAND]`
pub(crate) fn handle_compile_items(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<Value> {
    let params: CompileItemsParams = serde_json::from_value(req.params)?;
    let sidecar = fsharp_sidecar.context("F# sidecar unavailable for project/compileItems")?;
    let items = compile_items(Path::new(&params.project_path), runtime, sidecar)?;
    info!(project = %params.project_path, count = items.len(), "sharplsp/project/compileItems");
    Ok(json!({ "items": items }))
}

/// Ask the F# sidecar for `project`'s evaluated Compile items.
fn compile_items(
    project: &Path,
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
) -> Result<Vec<String>> {
    let payload = rmp_serde::to_vec(&project.to_string_lossy())?;
    let response = runtime.block_on(sidecar.request(COMPILE_ITEMS, payload))?;
    Ok(rmp_serde::from_slice(&response)?)
}

/// An implementation file: a signature file's symbols are its `.fs` file's.
fn is_fsharp_source(item: &str) -> bool {
    crate::paths::has_extension(Path::new(item), &["fs"])
}

/// Recursively find `.cs` and `.fs` files under a directory.
pub(crate) fn find_source_files(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_files(dir, is_source_file, &mut files);
    files
}

/// Check whether the path has a `.cs` or `.fs` extension, in any casing —
/// Windows filesystems are case-insensitive, so `Program.CS` is a C# file.
fn is_source_file(path: &Path) -> bool {
    crate::paths::has_extension(path, &["cs", "fs"])
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    // ── is_source_file ──

    /// Windows filesystems are case-insensitive — `Program.CS` is the same
    /// file as `Program.cs` and must not vanish from workspace symbols.
    #[test]
    fn is_source_file_matches_extensions_case_insensitively() {
        assert!(is_source_file(Path::new("A.CS")));
        assert!(is_source_file(Path::new("B.Fs")));
        assert!(!is_source_file(Path::new("C.txt")));
    }

    #[test]
    fn is_source_file_cs() {
        assert!(is_source_file(Path::new("Program.cs")));
    }

    #[test]
    fn is_source_file_fs() {
        assert!(is_source_file(Path::new("Module.fs")));
    }

    #[test]
    fn is_source_file_txt_rejected() {
        assert!(!is_source_file(Path::new("readme.txt")));
    }

    #[test]
    fn is_source_file_rs_rejected() {
        assert!(!is_source_file(Path::new("main.rs")));
    }

    // ── collect_source_files / find_source_files ──

    #[test]
    fn find_source_files_returns_cs_and_fs_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        std::fs::write(dir.join("Foo.cs"), "").unwrap();
        std::fs::write(dir.join("Bar.fs"), "").unwrap();
        std::fs::write(dir.join("readme.txt"), "").unwrap();

        let mut files = Vec::new();
        collect_files(dir, is_source_file, &mut files);

        assert_eq!(files.len(), 2, "must find exactly 2 source files");
        assert!(files.iter().any(|f| f.ends_with("Foo.cs")));
        assert!(files.iter().any(|f| f.ends_with("Bar.fs")));
    }

    #[test]
    fn collect_source_files_skips_bin_obj_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        // Create a src file at root level.
        std::fs::write(dir.join("Main.cs"), "").unwrap();

        // Create bin/obj directories with files that must NOT be collected.
        std::fs::create_dir(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin").join("App.dll"), "").unwrap();
        // Trick: put a .cs file in bin to verify it's skipped.
        std::fs::write(dir.join("bin").join("Gen.cs"), "").unwrap();

        std::fs::create_dir(dir.join("obj")).unwrap();
        std::fs::write(dir.join("obj").join("Build.cs"), "").unwrap();

        let mut files = Vec::new();
        collect_files(dir, is_source_file, &mut files);

        assert_eq!(files.len(), 1, "must skip bin/obj, got: {files:?}");
        assert!(files[0].ends_with("Main.cs"));
    }

    #[test]
    fn collect_source_files_skips_nonexistent_directory() {
        let path = Path::new("/nonexistent/path/that/does/not/exist");
        let mut files = Vec::new();
        // Must not panic — simply returns nothing.
        collect_files(path, is_source_file, &mut files);
        assert!(matches!(files.as_slice(), []), "{files:?}");
    }

    #[test]
    fn collect_source_files_recurses_into_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        let sub = dir.join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("Nested.cs"), "").unwrap();
        std::fs::write(dir.join("Root.cs"), "").unwrap();

        let mut files = Vec::new();
        collect_files(dir, is_source_file, &mut files);

        assert_eq!(files.len(), 2, "must recurse into subdirs");
        assert!(files.iter().any(|f| f.ends_with("Nested.cs")));
        assert!(files.iter().any(|f| f.ends_with("Root.cs")));
    }

    #[test]
    fn only_fsharp_implementation_files_are_listed_from_compile_items() {
        assert!(is_fsharp_source("/w/Source/Main.fs"));
        assert!(is_fsharp_source("/w/Source/Main.FS"));
        assert!(!is_fsharp_source("/w/Source/Main.fsi"));
        assert!(!is_fsharp_source("/w/Source/Gen.cs"));
    }
}
