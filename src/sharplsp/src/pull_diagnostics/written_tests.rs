//! A file the host itself writes — a compile item added to an `.fsproj` —
//! reloads its compilers through the same watched-file notification the native
//! watcher sends, so the reload never depends on the platform watcher noticing
//! the host's own write (it misses some on Windows). [DIAG-LSP-REFRESH]
use super::*;

#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
mod contract {
    use serde_json::json;

    use super::*;
    use crate::config::DiagnosticsConfig;
    use crate::sidecar::fake_compiler::{answering, empty, Fake};

    /// The `didChangeWatchedFiles` notifications waiting on `receiver`.
    fn announced(receiver: &crossbeam_channel::Receiver<Message>) -> Vec<serde_json::Value> {
        receiver
            .try_iter()
            .filter_map(|message| match message {
                Message::Notification(note) if note.method == "workspace/didChangeWatchedFiles" => {
                    Some(note.params)
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_project_file_the_host_writes_is_announced_as_a_watched_change() -> Result<()> {
        let runtime = tokio::runtime::Runtime::new()?;
        let compiler = Fake::connect(&runtime, answering(empty()));
        shutdown()?;
        let capabilities: lsp_types::ClientCapabilities =
            serde_json::from_value(json!({"textDocument":{"diagnostic":{}}}))?;
        let (sender, _client) = crossbeam_channel::unbounded();
        initialize(
            &capabilities,
            &DiagnosticsConfig::default(),
            &runtime,
            [Some(&compiler.manager), None],
            sender,
        )?;
        let project = std::env::temp_dir()
            .join("sharplsp-written")
            .join("App.fsproj");
        let uri = crate::paths::native_path_to_uri(&project)?;
        let project = project.to_string_lossy().into_owned();

        // Interaction 1 — before the dispatch queue exists, there is nobody to tell.
        crate::pull_diagnostics::monitor::written(&[project.as_str()])?;

        // Interaction 2 — once it exists, the write is one Changed event for the project.
        let (inbound, queue) = crossbeam_channel::unbounded();
        with_session(|session| {
            session.inbound = Some(inbound);
            Ok(())
        })?;
        crate::pull_diagnostics::monitor::written(&[project.as_str()])?;
        let notes = announced(&queue);
        assert_eq!(notes.len(), 1, "one notification per write");
        assert_eq!(
            notes.first().map(|note| note["changes"].clone()),
            Some(json!([{ "uri": uri, "type": 2 }])),
            "the project is announced Changed, exactly as the native watcher would"
        );
        assert_eq!(
            notes.first().map(|note| note["sharplspRescan"].clone()),
            Some(json!(false))
        );

        // Interaction 3 — writing nothing announces nothing.
        crate::pull_diagnostics::monitor::written(&[])?;
        assert!(announced(&queue).is_empty(), "no paths, no notification");
        shutdown()
    }
}
