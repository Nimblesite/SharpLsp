//! Watched-file reloads retire identities a racing pull minted, reopen what each
//! compiler opened, replay only the buffers its graph owned, and leave restore
//! outputs a compiler's own open consumed alone.
//! [DIAG-LSP-REFRESH] [DIAG-TRUTH-RECOVERY] [DIAG-RESTORE]
use super::*;
use serde_json::json;

#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
mod contract {
    use super::*;
    use std::time::{Duration, Instant, SystemTime};

    use anyhow::Context;

    use crate::config::DiagnosticsConfig;
    use crate::configuration::Configuration;
    use crate::pull_diagnostics::state;
    use crate::sidecar::fake_compiler::{answering, empty, Fake};
    use crate::tree_sitter_parse::LangId;
    use crate::workspace_open::{open_workspace, SolutionChoice};

    /// A compiler graph holding `paths`, as `workspace/diagnostics/documents` reports it.
    fn documents(paths: &[&str]) -> Vec<u8> {
        let entries: Vec<_> = paths.iter().map(|path| (*path, "Project.csproj")).collect();
        graph(&entries)
    }

    /// A compiler graph of `(source, project file)` pairs.
    fn graph(entries: &[(&str, &str)]) -> Vec<u8> {
        let documents: Vec<_> = entries
            .iter()
            .map(|(source, project)| (*source, "Project", *project))
            .collect();
        rmp_serde::to_vec(&documents).unwrap_or_default()
    }

    /// How many workspaces the compiler has been asked to open.
    fn opens(received: &[(String, Vec<u8>)]) -> usize {
        received
            .iter()
            .filter(|(method, _)| method == "workspace/open")
            .count()
    }

    /// A pull-mode connection's diagnostics session over `compiler`.
    fn pull_session(runtime: &tokio::runtime::Runtime, compiler: &Fake) -> Result<()> {
        pull_session_over(runtime, [Some(&compiler.manager), None])
    }

    /// A pull-mode connection's diagnostics session over both compilers.
    fn pull_session_over(
        runtime: &tokio::runtime::Runtime,
        compilers: [Option<&Arc<SidecarManager>>; 2],
    ) -> Result<()> {
        let capabilities: lsp_types::ClientCapabilities =
            serde_json::from_value(json!({"textDocument":{"diagnostic":{}}}))?;
        let (sender, _receiver) = crossbeam_channel::unbounded();
        state::initialize(
            &capabilities,
            &DiagnosticsConfig::default(),
            runtime,
            compilers,
            sender,
        )
    }

    /// Initialization's transition: record `workspace` as the selection, then
    /// open it in `compiler`.
    fn select_and_open(
        runtime: &tokio::runtime::Runtime,
        compiler: &Fake,
        workspace: &str,
    ) -> Result<()> {
        state::select_workspace(workspace)?;
        runtime.block_on(open_workspace(&compiler.manager, workspace))
    }

    /// One watched-file event for `path`.
    fn event(path: &str, typ: FileChangeType) -> Result<FileEvent> {
        Ok(FileEvent {
            uri: paths::path_to_lsp_uri(path)?,
            typ,
        })
    }

    /// Run one reload pass of the background worker.
    fn apply(
        runtime: &tokio::runtime::Runtime,
        compiler: &Fake,
        vfs: &Arc<Vfs>,
        batch: &ReloadBatch,
    ) -> Result<()> {
        apply_over(runtime, [Some(&compiler.manager), None], vfs, batch)
    }

    /// Run one reload pass of the background worker over both compilers.
    fn apply_over(
        runtime: &tokio::runtime::Runtime,
        compilers: [Option<&Arc<SidecarManager>>; 2],
        vfs: &Arc<Vfs>,
        batch: &ReloadBatch,
    ) -> Result<()> {
        let (sender, _receiver) = crossbeam_channel::unbounded();
        runtime.block_on(apply_batch(batch, compilers, vfs, &sender))
    }

    fn rescan() -> ReloadBatch {
        ReloadBatch {
            rescan: true,
            changes: Vec::new(),
            restore: true,
        }
    }

    /// A pull that reached the compiler between a watched edit and the
    /// closed-file synchronization memoized pre-edit text under the identity it
    /// saw; the completed synchronization retires that identity.
    #[test]
    fn a_completed_disk_sync_retires_identities_minted_before_it() -> Result<()> {
        let runtime = tokio::runtime::Runtime::new()?;
        let dir = tempfile::tempdir()?;
        let source = dir.path().join("Closed.cs");
        std::fs::write(&source, "class Closed { int Value => 42; }")?;
        let path = source.to_string_lossy().into_owned();
        let known = documents(&[&path]);
        let compiler = Fake::connect(&runtime, answering(known));
        pull_session(&runtime, &compiler)?;
        // The watched event supersedes pending work before its batch runs.
        state::invalidate()?;
        let racing = state::store()?.result_id(0);
        let batch = ReloadBatch {
            rescan: false,
            changes: vec![event(&path, FileChangeType::CHANGED)?],
            restore: false,
        };
        apply(&runtime, &compiler, &Arc::new(Vfs::new()), &batch)?;

        let synced = compiler.since(0, "textDocument/didClose")?;
        assert_eq!(
            synced.len(),
            1,
            "the closed file's disk text reached the compiler"
        );
        assert!(
            compiler.opened(0)?.is_empty(),
            "a known source edited in place needs no reload"
        );
        assert_ne!(
            state::store()?.result_id(0),
            racing,
            "a pull that ran before the synchronization can no longer be answered unchanged"
        );
        Ok(())
    }

    /// A reload reopens the workspace and replays the open buffers the
    /// compiler's previous graph owned, so an owner adopted for an open file
    /// survives it; a document the selection excluded is never handed back to
    /// owner adoption.
    #[test]
    fn a_reload_replays_only_the_buffers_its_previous_graph_owned() -> Result<()> {
        let runtime = tokio::runtime::Runtime::new()?;
        let dir = tempfile::tempdir()?;
        let [owned, adopted, excluded] = ["Owned.cs", "Adopted.cs", "Excluded.cs"]
            .map(|name| dir.path().join(name).to_string_lossy().into_owned());
        // The graph holds the adopted owner's source until a reload replaces it.
        let (before, after) = (documents(&[&owned, &adopted]), documents(&[&owned]));
        let compiler = Fake::connect(
            &runtime,
            Arc::new(move |method, received| match method {
                "workspace/diagnostics/documents" if opens(received) < 2 => before.clone(),
                "workspace/diagnostics/documents" => after.clone(),
                _ => empty(),
            }),
        );
        pull_session(&runtime, &compiler)?;
        let vfs = Arc::new(Vfs::new());
        for path in [&owned, &adopted, &excluded] {
            vfs.open(paths::path_to_lsp_uri(path)?, 1, "class C {}".to_owned());
        }
        compiler.manager.set_document_source(&vfs);
        let workspace = dir.path().join("W.sln").to_string_lossy().into_owned();
        select_and_open(&runtime, &compiler, &workspace)?;
        let mark = compiler.mark()?;
        apply(&runtime, &compiler, &vfs, &rescan())?;

        let replayed = compiler.replayed(mark)?;
        assert_eq!(
            compiler.opened(mark)?,
            [workspace],
            "the same workspace reopens"
        );
        assert!(
            replayed.contains(&owned),
            "the graph's own buffer is replayed"
        );
        assert!(
            replayed.contains(&adopted),
            "an owner adopted for an open file survives the reload"
        );
        assert!(
            !replayed.contains(&excluded),
            "a document outside the graph never re-adopts its owner"
        );
        Ok(())
    }

    /// The solution chosen in settings is the one the next reload reopens, and
    /// the diagnostics selection follows it.
    #[test]
    fn a_settings_switch_survives_the_next_reload() -> Result<()> {
        let runtime = tokio::runtime::Runtime::new()?;
        let dir = tempfile::tempdir()?;
        std::fs::create_dir_all(dir.path().join("app"))?;
        for name in ["A.sln", "B.sln"] {
            std::fs::write(dir.path().join("app").join(name), "")?;
        }
        let compiler = Fake::connect(&runtime, Arc::new(|_, _| empty()));
        pull_session(&runtime, &compiler)?;
        let mut configuration = Configuration::new(dir.path().to_path_buf());
        configuration.update(&json!({"sharplsp":{"csharp":{"solution_path":"app/A.sln"}}}))?;
        let (client, _receiver) = crossbeam_channel::unbounded();
        let mut choice =
            SolutionChoice::new(Some(dir.path()), &configuration.config()?, &client, true);
        let first = choice
            .target()
            .context("solution A")?
            .to_string_lossy()
            .into_owned();
        select_and_open(&runtime, &compiler, &first)?;

        configuration.update(&json!({"sharplsp":{"csharp":{"solution_path":"app/B.sln"}}}))?;
        let vfs = Arc::new(Vfs::new());
        choice.settings_changed(&configuration, Some(&compiler.manager), &vfs, &runtime);
        let second = choice
            .target()
            .context("solution B")?
            .to_string_lossy()
            .into_owned();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !compiler.opened(0)?.contains(&second) {
            assert!(Instant::now() < deadline, "the settings change opens B");
            std::thread::sleep(Duration::from_millis(20));
        }
        let mark = compiler.mark()?;
        apply(&runtime, &compiler, &vfs, &rescan())?;

        assert_eq!(
            compiler.opened(mark)?,
            std::slice::from_ref(&second),
            "the reload reopens B"
        );
        assert_eq!(
            state::workspace()?,
            Some(second),
            "the diagnostics selection follows the solution settings chose"
        );
        Ok(())
    }

    /// Restore outputs a compiler's own open wrote were consumed by that open;
    /// only a later restore, or their removal, reloads it, and that reload never
    /// restores again.
    #[test]
    fn restore_outputs_reload_only_when_written_after_the_last_open() -> Result<()> {
        let runtime = tokio::runtime::Runtime::new()?;
        let dir = tempfile::tempdir()?;
        std::fs::create_dir_all(dir.path().join("App").join("obj"))?;
        let assets = dir
            .path()
            .join("App")
            .join("obj")
            .join("project.assets.json");
        std::fs::write(&assets, "{}")?;
        let assets = assets.to_string_lossy().into_owned();
        let app = dir.path().join("App");
        let loaded = graph(&[(
            &app.join("Program.cs").to_string_lossy(),
            &app.join("App.csproj").to_string_lossy(),
        )]);
        let compiler = Fake::connect(&runtime, answering(loaded));
        pull_session(&runtime, &compiler)?;
        let workspace = dir.path().join("W.sln").to_string_lossy().into_owned();
        select_and_open(&runtime, &compiler, &workspace)?;
        let mark = compiler.mark()?;
        let touched = [event(&assets, FileChangeType::CHANGED)?];
        let vfs = Arc::new(Vfs::new());
        apply(&runtime, &compiler, &vfs, &batch_of(&touched)?)?;
        assert!(
            compiler.opened(mark)?.is_empty(),
            "the open's own restore outputs need no second load"
        );

        // An external restore rewrites the assets after the open.
        std::fs::File::options()
            .write(true)
            .open(&assets)?
            .set_modified(SystemTime::now() + Duration::from_secs(2))?;
        apply(&runtime, &compiler, &vfs, &batch_of(&touched)?)?;
        assert_eq!(
            compiler.opened(mark)?,
            [workspace],
            "an external restore reloads"
        );
        let configured = compiler.since(mark, "diagnostics/configure")?;
        let (_, _, restores) = rmp_serde::from_slice::<(bool, bool, bool)>(
            configured
                .last()
                .context("the reload configures diagnostics")?,
        )?;
        assert!(
            !restores,
            "the reload uses the restored outputs without restoring again"
        );
        // Removing the outputs (`dotnet clean`) reloads, still without restoring:
        // a restore here would rewrite them and feed the next batch.
        std::fs::remove_file(&assets)?;
        let removed = [event(&assets, FileChangeType::DELETED)?];
        apply(&runtime, &compiler, &vfs, &batch_of(&removed)?)?;
        assert_eq!(compiler.opened(mark)?.len(), 2, "removed outputs reload");
        assert!(
            !restore_required(false, &removed)?,
            "removed outputs never restore"
        );
        Ok(())
    }

    /// A project appearing beside the loaded solution (its inherited
    /// configuration, project file, source and restore) reloads no compiler
    /// whose graph does not include it. A compiler opened on a folder reloads
    /// for a new project file of its language beneath it, and an edit to a
    /// loaded project file reloads the compiler that loaded it.
    /// [DIAG-LSP-REFRESH] [DIAG-ARCHITECTURE-SCOPE]
    #[test]
    fn changes_reload_only_the_compilers_whose_graph_they_concern() -> Result<()> {
        let runtime = tokio::runtime::Runtime::new()?;
        let dir = tempfile::tempdir()?;
        let path = |relative: &str| dir.path().join(relative).to_string_lossy().into_owned();
        for directory in ["App", "Scratch/obj"] {
            std::fs::create_dir_all(dir.path().join(directory))?;
        }
        let project = path("App/App.csproj");
        let loaded = graph(&[(&path("App/Program.cs"), &project)]);
        let csharp = Fake::connect_as(&runtime, LangId::CSharp, answering(loaded));
        let fsharp = Fake::connect_as(&runtime, LangId::FSharp, Arc::new(|_, _| empty()));
        let compilers = [Some(&csharp.manager), Some(&fsharp.manager)];
        pull_session_over(&runtime, compilers)?;
        select_and_open(&runtime, &csharp, &path("W.sln"))?;
        runtime.block_on(open_workspace(
            &fsharp.manager,
            &dir.path().to_string_lossy(),
        ))?;
        let marks = [csharp.mark()?, fsharp.mark()?];
        let vfs = Arc::new(Vfs::new());
        let mut changes = Vec::new();
        for (relative, typ) in [
            ("Scratch/Directory.Build.props", FileChangeType::CREATED),
            ("Scratch/Scratch.csproj", FileChangeType::CREATED),
            ("Scratch/Program.cs", FileChangeType::CREATED),
            ("Scratch/obj/project.assets.json", FileChangeType::CHANGED),
        ] {
            std::fs::write(path(relative), "{}")?;
            changes.push(event(&path(relative), typ)?);
        }
        let scratch = ReloadBatch {
            rescan: false,
            restore: restore_required(false, &changes)?,
            changes,
        };
        apply_over(&runtime, compilers, &vfs, &scratch)?;
        assert!(
            csharp.opened(marks[0])?.is_empty(),
            "a project outside the loaded solution reloads no C# compiler"
        );
        assert!(
            fsharp.opened(marks[1])?.is_empty(),
            "nor the folder's F# compiler, for a C# project"
        );

        std::fs::write(path("Scratch/Scratch.fsproj"), "<Project/>")?;
        let fsproj = [event(
            &path("Scratch/Scratch.fsproj"),
            FileChangeType::CREATED,
        )?];
        apply_over(&runtime, compilers, &vfs, &batch_of(&fsproj)?)?;
        assert!(
            csharp.opened(marks[0])?.is_empty(),
            "an F# project is not C#'s"
        );
        assert_eq!(
            fsharp.opened(marks[1])?.len(),
            1,
            "the folder compiler finds it"
        );

        let edited = [event(&project, FileChangeType::CHANGED)?];
        apply_over(&runtime, compilers, &vfs, &batch_of(&edited)?)?;
        assert_eq!(
            csharp.opened(marks[0])?.len(),
            1,
            "its own project reloads C#"
        );
        assert_eq!(fsharp.opened(marks[1])?.len(), 1, "and not the F# compiler");
        Ok(())
    }

    /// A batch of `changes`, with the restore requirement the watcher computes.
    fn batch_of(changes: &[FileEvent]) -> Result<ReloadBatch> {
        Ok(ReloadBatch {
            rescan: false,
            changes: changes.to_vec(),
            restore: restore_required(false, changes)?,
        })
    }
}
