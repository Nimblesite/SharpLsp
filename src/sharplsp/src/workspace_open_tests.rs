//! Solution choice and open-failure reporting. Implements
//! [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
use super::*;
use serde_json::json;

#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
#[expect(
    clippy::indexing_slicing,
    reason = "serde_json Value indexing returns Null for absent fields, not a panic"
)]
mod contract {
    use super::*;

    /// A workspace root holding `app/App.sln`.
    fn workspace() -> Result<tempfile::TempDir> {
        let dir = tempfile::tempdir()?;
        std::fs::create_dir_all(dir.path().join("app"))?;
        std::fs::write(dir.path().join("app").join("App.sln"), "")?;
        Ok(dir)
    }

    /// The settings layer that sets `csharp.solution_path` to `path`.
    fn choose(path: &str) -> Value {
        json!({"sharplsp":{"csharp":{"solution_path": path}}})
    }

    #[test]
    fn only_a_declared_picker_opts_out_of_the_error() {
        assert!(client_picks_solution(Some(
            &json!({"solutionPicker": true})
        )));
        assert!(!client_picks_solution(Some(
            &json!({"solutionPicker": false})
        )));
        assert!(!client_picks_solution(Some(
            &json!({"solutionPicker": "yes"})
        )));
        assert!(!client_picks_solution(Some(&json!({}))));
        assert!(!client_picks_solution(None));
    }

    #[test]
    fn an_open_failure_is_shown_as_an_error_naming_the_cause() -> Result<()> {
        let (sender, receiver) = crossbeam_channel::unbounded();
        show_open_failure(
            &sender,
            &anyhow::anyhow!("Found 2 solutions (A.sln, B.sln)"),
        );
        let Message::Notification(shown) = receiver.recv()? else {
            anyhow::bail!("expected a notification");
        };
        assert_eq!(shown.method, "window/showMessage");
        assert_eq!(shown.params["type"], 1, "an open failure is an error");
        let message = shown.params["message"].as_str().unwrap_or_default();
        assert!(message.contains("C# workspace"), "{message}");
        assert!(message.contains("A.sln, B.sln"), "{message}");

        drop(receiver);
        show_open_failure(&sender, &anyhow::anyhow!("closed"));
        Ok(())
    }

    #[test]
    fn the_follow_up_scans_only_where_asked_and_enabled() -> Result<()> {
        let vfs = Arc::new(Vfs::new());
        let (sender, _receiver) = crossbeam_channel::unbounded();
        let mut config = SharpLspConfig::default();
        config.diagnostics.project_filter = vec!["App".into()];

        let csharp = OpenFollowUp::new(&config, &vfs, Some(&sender), Some(&sender));
        let (_, filter) = csharp.diagnostics.context("the C# scan runs")?;
        assert_eq!(filter, vec!["App".to_owned()]);
        assert!(csharp.report.is_some());

        let fsharp = OpenFollowUp::new(&config, &vfs, None, None);
        assert!(fsharp.diagnostics.is_none() && fsharp.report.is_none());

        config.diagnostics.solution_wide_analysis = false;
        let off = OpenFollowUp::new(&config, &vfs, Some(&sender), None);
        assert!(off.diagnostics.is_none(), "a disabled scan never runs");
        Ok(())
    }

    #[test]
    fn failures_are_reported_unless_the_client_picks() -> Result<()> {
        let dir = workspace()?;
        let (sender, _receiver) = crossbeam_channel::unbounded();
        let config = SharpLspConfig::default();

        let shown = SolutionChoice::new(Some(dir.path()), &config, &sender, true);
        assert_eq!(shown.target(), Some(&dir.path().to_path_buf()));
        assert!(shown.report().is_some());

        let picked = SolutionChoice::new(Some(dir.path()), &config, &sender, false);
        assert!(picked.report().is_none());

        let single_file = SolutionChoice::new(None, &config, &sender, true);
        assert!(single_file.target().is_none());
        Ok(())
    }

    #[test]
    fn a_settings_change_moves_the_target_once_per_change() -> Result<()> {
        let dir = workspace()?;
        let (sender, _receiver) = crossbeam_channel::unbounded();
        let mut configuration = Configuration::new(dir.path().to_path_buf());
        let mut choice =
            SolutionChoice::new(Some(dir.path()), &configuration.config()?, &sender, true);
        assert!(
            choice.moved(&configuration).is_none(),
            "nothing changed yet"
        );

        configuration.update(&choose("app/App.sln"))?;
        let (target, config) = choice.moved(&configuration).context("the solution moved")?;
        assert_eq!(target, dir.path().join("app").join("App.sln"));
        assert_eq!(config.csharp.solution_path, "app/App.sln");
        assert_eq!(choice.target(), Some(&target));
        assert!(
            choice.moved(&configuration).is_none(),
            "the same settings again"
        );

        // A path naming no file falls back to the root, so the root reopens.
        configuration.update(&choose("missing.sln"))?;
        let (target, _) = choice.moved(&configuration).context("back to the root")?;
        assert_eq!(target, dir.path());
        Ok(())
    }

    #[test]
    fn nothing_reopens_without_a_root_or_a_csharp_sidecar() -> Result<()> {
        let dir = workspace()?;
        let (sender, _receiver) = crossbeam_channel::unbounded();
        let mut configuration = Configuration::new(dir.path().to_path_buf());
        configuration.update(&choose("app/App.sln"))?;
        let config = SharpLspConfig::default();

        let mut single_file = SolutionChoice::new(None, &config, &sender, true);
        assert!(single_file.moved(&configuration).is_none());

        let runtime = tokio::runtime::Runtime::new()?;
        let vfs = Arc::new(Vfs::new());
        let mut no_csharp = SolutionChoice::new(Some(dir.path()), &config, &sender, true);
        no_csharp.settings_changed(&configuration, None, &vfs, &runtime);
        assert_eq!(
            no_csharp.target(),
            Some(&dir.path().to_path_buf()),
            "with C# disabled the target stays put"
        );
        Ok(())
    }
}
