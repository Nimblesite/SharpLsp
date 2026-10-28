//! A running server applies changed analyzer settings to the next pull, whether
//! the editor sends them or `sharplsp.toml` is edited on disk, and warns when a
//! changed setting is read only at startup. Implements [CONFIG-RESOLUTION-LIVE].
use super::*;
use workspace_diagnostic_support::{completed_pull, observed_request};

/// One private and one public function that nothing calls.
const DEAD_FS: &str = "module Dead\n\nlet private unusedHelper () = 1\n\nlet unusedPublic () = 2\n";

/// How long the server is given to notice an edited configuration file.
const NOTICED: Duration = Duration::from_secs(30);

#[test]
fn analyzer_settings_from_the_editor_or_the_file_apply_to_the_next_pull() {
    require_dotnet();
    let (workspace, source) = dead_code_workspace();
    let mut session = LiveSession::start(workspace.path(), &source);

    // 1. The file turns the dead-code analyzer off: nothing is reported dead.
    session.assert_dead(&[]);

    // 2. The editor turns it on: the private function is dead, a warning; the public one is API.
    session.client.notify(
        "workspace/didChangeConfiguration",
        json!({"settings":{"sharplsp":{"analyzers":{"dead_code":true}}}}),
    );
    session.assert_dead(&[("unusedHelper", 2)]);

    // 3. The file adds monorepo mode: once the server sees the edit, both are dead, as errors.
    write_configuration(
        workspace.path(),
        "[analyzers]\ndead_code = false\nmonorepo = true\n",
    );
    session.await_dead(&[("unusedHelper", 1), ("unusedPublic", 1)]);
    assert!(
        session.restart_warning().is_none(),
        "analyzer settings never take a restart"
    );

    // 4. A setting read only at startup changes: the user is told to restart for it.
    write_configuration(
        workspace.path(),
        "[analyzers]\ndead_code = false\nmonorepo = true\n[server]\nlog_level = \"debug\"\n",
    );
    let warning = session.await_restart_warning();
    assert!(warning.contains("[server]"), "{warning}");
    session.client.shutdown_and_exit();
}

/// An F# project with dead code, and a `sharplsp.toml` turning the dead-code analyzer off.
fn dead_code_workspace() -> (tempfile::TempDir, PathBuf) {
    let workspace = tempfile::tempdir().expect("real F# workspace");
    let project = workspace.path().join("Dead");
    std::fs::create_dir_all(&project).expect("project directory");
    std::fs::write(
        project.join("Dead.fsproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup><Compile Include="Dead.fs" /></ItemGroup>
</Project>"#,
    )
    .expect("write the project");
    std::fs::write(project.join("Dead.fs"), DEAD_FS).expect("write the source");
    write_configuration(workspace.path(), "[analyzers]\ndead_code = false\n");
    (workspace, project.join("Dead.fs"))
}

/// Replace the workspace's `sharplsp.toml`.
fn write_configuration(root: &Path, text: &str) {
    std::fs::write(root.join("sharplsp.toml"), text).expect("write the workspace configuration");
}

/// A real server over the dead-code workspace, with every message it sent.
struct LiveSession {
    client: LspClient,
    uri: String,
    traffic: Vec<Value>,
}

impl LiveSession {
    /// Start the server with pull diagnostics and wait until the F# project loads.
    fn start(root: &Path, source: &Path) -> Self {
        let mut client = LspClient::spawn_in(Stdio::null(), Some(root));
        let initialized = client.initialize_with_capabilities(
            json!(path_to_file_uri(root)),
            json!({"textDocument":{"diagnostic":{}},"workspace":{"diagnostics":{"refreshSupport":true}}}),
        );
        assert_rpc_ok(&initialized, "initialize the dead-code workspace");
        let mut session = Self {
            client,
            uri: path_to_file_uri(source),
            traffic: Vec::new(),
        };
        session.wait_for(NOTICED, "the F# project to load", |session| {
            session
                .received("workspace/projectInitializationComplete")
                .is_some()
        });
        session
    }

    /// The dead functions the next pull reports, by name and severity, sorted.
    fn dead(&mut self) -> Vec<(String, u64)> {
        let report = completed_pull(
            &mut self.client,
            "textDocument/diagnostic",
            json!({"textDocument":{"uri":self.uri}}),
            &mut self.traffic,
        );
        let mut dead: Vec<(String, u64)> = report["result"]["items"]
            .as_array()
            .expect("a full report")
            .iter()
            .filter(|item| item["code"] == "SLSPF0101")
            .filter_map(|item| {
                Some((
                    named(item["message"].as_str()?)?,
                    item["severity"].as_u64()?,
                ))
            })
            .collect();
        dead.sort();
        dead
    }

    /// The next pull reports exactly `expected` dead.
    fn assert_dead(&mut self, expected: &[(&str, u64)]) {
        assert_eq!(self.dead(), owned(expected));
    }

    /// Pull until exactly `expected` is reported dead, within [`NOTICED`].
    fn await_dead(&mut self, expected: &[(&str, u64)]) {
        let expected = owned(expected);
        self.wait_for(NOTICED, "the new analyzer settings", |session| {
            session.dead() == expected
        });
    }

    /// The restart warning received so far, if any.
    fn restart_warning(&self) -> Option<String> {
        self.received("window/showMessage")
            .filter(|notice| notice["params"]["type"] == 2)
            .and_then(|notice| notice["params"]["message"].as_str().map(str::to_owned))
    }

    /// Wait for the restart warning, within [`NOTICED`].
    fn await_restart_warning(&mut self) -> String {
        self.wait_for(NOTICED, "the restart warning", |session| {
            session.restart_warning().is_some()
        });
        self.restart_warning().expect("the restart warning arrived")
    }

    /// The last notification of `method` the server sent.
    fn received(&self, method: &str) -> Option<&Value> {
        self.traffic
            .iter()
            .rev()
            .find(|message| message["method"] == method)
    }

    /// Keep the server answering until `done`, failing after `limit`.
    fn wait_for(&mut self, limit: Duration, what: &str, mut done: impl FnMut(&mut Self) -> bool) {
        let deadline = Instant::now() + limit;
        while !done(self) {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            let _ = observed_request(
                &mut self.client,
                "sharplsp/configuration",
                json!({}),
                &mut self.traffic,
            );
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

/// The function a dead-code message names: `'name'`.
fn named(message: &str) -> Option<String> {
    message.split('\'').nth(1).map(str::to_owned)
}

/// Expected names and severities, owned and sorted like [`LiveSession::dead`].
fn owned(expected: &[(&str, u64)]) -> Vec<(String, u64)> {
    let mut owned: Vec<(String, u64)> = expected
        .iter()
        .map(|(name, severity)| ((*name).to_owned(), *severity))
        .collect();
    owned.sort();
    owned
}
