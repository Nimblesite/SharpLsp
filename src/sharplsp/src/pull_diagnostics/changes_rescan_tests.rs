//! What a rescan reloads: native watcher loss says events may be missing, so a
//! compiler reloads exactly when something it opened or loaded changed after its
//! last open. [DIAG-LSP-REFRESH] [SIDECAR-PROCESS-MEMORY] (#566)
#![expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use super::contract::{apply_over, graph, pull_session_over, rescan, select_and_open};
use crate::sidecar::fake_compiler::{answering, Fake};
use crate::tree_sitter_parse::LangId;
use crate::vfs::Vfs;

/// A fixture workspace of `files` under a fresh directory.
fn workspace(files: &[(&str, &str)]) -> Result<tempfile::TempDir> {
    let dir = tempfile::tempdir()?;
    for (relative, text) in files {
        let path = dir.path().join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, text)?;
    }
    Ok(dir)
}

/// A real edit lands well after the open it follows; Linux stamps files from
/// a coarse clock, so writing within its tick would predate the open.
fn write_later(path: &std::path::Path, text: &str) -> Result<()> {
    std::thread::sleep(Duration::from_millis(50));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(std::fs::write(path, text)?)
}

/// Native watcher loss (a rescan) says events may be missing, not that inputs
/// changed: a compiler reloads only when a source or project it loaded, the
/// directory holding one, or inherited configuration above it changed after its
/// last open. Build churn elsewhere (`target/`) never reloads and re-restores
/// the workspace. [DIAG-LSP-REFRESH] [SIDECAR-PROCESS-MEMORY] (#566)
#[test]
fn a_rescan_reloads_only_a_compiler_whose_inputs_changed_since_its_open() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let dir = tempfile::tempdir()?;
    let path = |relative: &str| dir.path().join(relative).to_string_lossy().into_owned();
    for directory in ["App/obj", "target"] {
        std::fs::create_dir_all(dir.path().join(directory))?;
    }
    for (relative, text) in [
        ("App/App.fsproj", "<Project/>"),
        ("App/Program.fs", "module Program"),
        ("App/obj/project.assets.json", "{}"),
    ] {
        std::fs::write(path(relative), text)?;
    }
    let loaded = graph(&[(&path("App/Program.fs"), &path("App/App.fsproj"))]);
    let fsharp = Fake::connect_as(&runtime, LangId::FSharp, answering(loaded));
    let compilers = [None, Some(&fsharp.manager)];
    pull_session_over(&runtime, compilers)?;
    select_and_open(&runtime, &fsharp, &path("App/App.fsproj"))?;
    let mark = fsharp.mark()?;
    let vfs = Arc::new(Vfs::new());
    let reopens_after_rescan = || -> Result<usize> {
        apply_over(&runtime, compilers, &vfs, &rescan())?;
        Ok(fsharp.opened(mark)?.len())
    };
    // A real edit lands well after the open it follows; Linux stamps files from
    // a coarse clock, so writing within its tick would predate the open.
    let write_later = |relative: &str, text: &str| -> Result<()> {
        std::thread::sleep(std::time::Duration::from_millis(50));
        Ok(std::fs::write(path(relative), text)?)
    };

    write_later("target/build-output.bin", "churn")?;
    assert_eq!(
        reopens_after_rescan()?,
        0,
        "build churn outside its inputs reloads nothing"
    );
    assert_eq!(
        reopens_after_rescan()?,
        0,
        "nor does a rescan with nothing changed"
    );

    write_later("App/Program.fs", "module Program\nlet edited = 1")?;
    assert_eq!(
        reopens_after_rescan()?,
        1,
        "a source edited after the open reloads"
    );
    assert_eq!(
        reopens_after_rescan()?,
        1,
        "that reload's open consumed the edit"
    );

    write_later("App/Added.fs", "module Added")?;
    assert_eq!(
        reopens_after_rescan()?,
        2,
        "a file added beside its sources reloads"
    );

    write_later("Directory.Build.props", "<Project/>")?;
    assert_eq!(
        reopens_after_rescan()?,
        3,
        "new inherited configuration reloads"
    );
    assert_eq!(
        reopens_after_rescan()?,
        3,
        "and each change reloads exactly once"
    );
    Ok(())
}

/// A rescan replaces events that may have carried an edit to the opened
/// solution, or a project new to the opened folder. Neither is a file the
/// compiler loaded, so only the workspace it opened can tell: v0.33.0 reloaded
/// on every rescan, and a check of loaded files alone never reloaded these.
#[test]
fn a_rescan_reloads_when_the_opened_solution_or_folder_changed() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let dir = workspace(&[
        ("All.sln", "sln v1"),
        ("src/App/App.fsproj", "<Project/>"),
        ("src/App/Program.fs", "module Program"),
        ("src/App/obj/project.assets.json", "{}"),
    ])?;
    let path = |relative: &str| dir.path().join(relative).to_string_lossy().into_owned();
    let loaded = graph(&[(&path("src/App/Program.fs"), &path("src/App/App.fsproj"))]);
    let fsharp = Fake::connect_as(&runtime, LangId::FSharp, answering(loaded));
    let compilers = [None, Some(&fsharp.manager)];
    pull_session_over(&runtime, compilers)?;
    let vfs = Arc::new(Vfs::new());
    let reopens_after_rescan = |mark| -> Result<usize> {
        apply_over(&runtime, compilers, &vfs, &rescan())?;
        Ok(fsharp.opened(mark)?.len())
    };

    select_and_open(&runtime, &fsharp, &path("All.sln"))?;
    let solution = fsharp.mark()?;
    assert_eq!(
        reopens_after_rescan(solution)?,
        0,
        "an untouched solution reloads nothing"
    );
    write_later(&dir.path().join("All.sln"), "sln v2 lists another project")?;
    assert_eq!(
        reopens_after_rescan(solution)?,
        1,
        "the opened solution edited after its open reloads"
    );
    assert_eq!(
        reopens_after_rescan(solution)?,
        1,
        "that reload's open consumed the edit"
    );

    select_and_open(&runtime, &fsharp, &path(""))?;
    let folder = fsharp.mark()?;
    assert_eq!(
        reopens_after_rescan(folder)?,
        0,
        "an untouched folder reloads nothing"
    );
    write_later(&dir.path().join("src/Lib/Lib.fsproj"), "<Project/>")?;
    assert_eq!(
        reopens_after_rescan(folder)?,
        1,
        "a project in a new directory of the opened folder reloads"
    );
    assert_eq!(reopens_after_rescan(folder)?, 1, "and reloads once");
    Ok(())
}
