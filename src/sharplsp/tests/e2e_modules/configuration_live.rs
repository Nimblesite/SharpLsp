//! A running server applies changed analyzer settings to the next pull, whether
//! the editor sends them or `sharplsp.toml` is edited on disk, and warns when a
//! changed setting is read only at startup. Implements [CONFIG-RESOLUTION-LIVE].
use super::*;
use workspace_diagnostic_support::{completed_pull, observed_request};

/// One private and one public function that nothing calls.
const DEAD_FS: &str = "module Dead\n\nlet private unusedHelper () = 1\n\nlet unusedPublic () = 2\n";

/// One internal and one public C# type that nothing references.
const DEAD_CS: &str =
    "namespace Dead;\n\ninternal sealed class Hidden { }\n\npublic sealed class Orphan { }\n";

/// How long the server is given to notice an edited configuration file.
const NOTICED: Duration = Duration::from_secs(30);

#[test]
fn analyzer_settings_from_the_editor_or_the_file_apply_to_the_next_pull() {
    require_dotnet();
    let (workspace, source) = dead_code_workspace();
    let mut session = LiveSession::start(workspace.path(), &source, "SLSPF0101");

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

/// [ANALYZERS-MONOREPO-GATE] through the real host and C# sidecar: an unused
/// internal type is dead code everywhere, but an unused PUBLIC type is reported
/// only once the workspace declares itself a monorepo — and then as an error.
#[test]
fn csharp_unused_public_types_are_dead_only_in_a_monorepo() {
    require_dotnet();
    let (workspace, source) = dead_csharp_workspace();
    let mut session = LiveSession::start(workspace.path(), &source, "SLSPC0101");

    // 1. No configuration at all: the default is a standard repository, so the
    //    internal type is dead, a warning, and the public one is possible API.
    session.await_dead(&[("Hidden", 2)]);

    // 2. The file declares a monorepo: the public type is dead too, and both are
    //    errors — and the editor is told to pull again rather than left stale.
    let refreshes = session.count("workspace/diagnostic/refresh");
    write_configuration(
        workspace.path(),
        "[analyzers]\ndead_code = true\nmonorepo = true\n",
    );
    session.await_dead(&[("Hidden", 1), ("Orphan", 1)]);
    session.await_refresh_after(refreshes, "a monorepo switch");

    // 3. Back to a standard repository: the public type is API again, refreshed again.
    let refreshes = session.count("workspace/diagnostic/refresh");
    write_configuration(workspace.path(), "[analyzers]\ndead_code = true\n");
    session.await_dead(&[("Hidden", 2)]);
    session.await_refresh_after(refreshes, "leaving monorepo mode");
    session.client.shutdown_and_exit();
}

/// [ANALYZERS-REFERENCE-MODEL] solution-wide: in a monorepo, a public C# type
/// another project of the solution uses is live, and only the one nobody uses
/// is dead.
#[test]
fn a_public_csharp_type_another_project_uses_is_not_dead_in_a_monorepo() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real C# solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "cs",
        ["<OutputType>Library</OutputType>", ""],
        "namespace Lib;\n\npublic sealed class Used { }\n\npublic sealed class Orphan { }\n",
    );
    let _app = write_project(root, "App", "cs", ["<OutputType>Exe</OutputType>", r#"<ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup>"#],
        "internal static class Program\n{\n    private static void Main() => _ = new Lib.Used();\n}\n",
    );
    std::fs::write(
        root.join("Mono.slnx"),
        "<Solution>\n  <Project Path=\"Lib/Lib.csproj\" />\n  <Project Path=\"App/App.csproj\" />\n</Solution>\n",
    )
    .expect("write the solution");
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPC0101");

    // `Used` is referenced from App, so only `Orphan` is dead — an error in a monorepo.
    session.await_dead(&[("Orphan", 1)]);
    session.client.shutdown_and_exit();
}

/// The F# twin: a public F# value another project of the solution uses is
/// live in a monorepo, and only the one nobody uses is dead.
#[test]
fn a_public_fsharp_value_another_project_uses_is_not_dead_in_a_monorepo() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real F# solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "fs",
        ["<OutputType>Library</OutputType>", ""],
        "module Lib.Values\n\nlet used () = 1\n\nlet orphan () = 2\n",
    );
    let _app = write_project(
        root,
        "App",
        "fs",
        [
            "<OutputType>Exe</OutputType>",
            r#"<ItemGroup><ProjectReference Include="../Lib/Lib.fsproj" /></ItemGroup>"#,
        ],
        "module App.Program\n\n[<EntryPoint>]\nlet main _ = Lib.Values.used ()\n",
    );
    std::fs::write(
        root.join("Mono.slnx"),
        "<Solution>\n  <Project Path=\"Lib/Lib.fsproj\" />\n  <Project Path=\"App/App.fsproj\" />\n</Solution>\n",
    )
    .expect("write the solution");
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPF0101");

    // `used` is called from App, so only `orphan` is dead — an error in a monorepo.
    session.await_dead(&[("orphan", 1)]);
    session.client.shutdown_and_exit();
}

/// [ANALYZERS-CROSS-LANGUAGE]: a public F# function that only C# calls is live.
/// FCS sees no C# caller, so the F# analyzer alone would call it dead — in a
/// monorepo, as an ERROR on code the solution uses.
#[test]
fn a_public_fsharp_function_only_csharp_calls_is_not_dead_in_a_monorepo() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real mixed solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "fs",
        ["<OutputType>Library</OutputType>", ""],
        "module Lib.Values\n\nlet used () = 1\n\nlet orphan () = 2\n",
    );
    let _app = write_project(
        root,
        "App",
        "cs",
        [
            "<OutputType>Exe</OutputType>",
            r#"<ItemGroup><ProjectReference Include="../Lib/Lib.fsproj" /></ItemGroup>"#,
        ],
        "internal static class Program\n{\n    private static int Main() => Lib.Values.used();\n}\n",
    );
    std::fs::write(
        root.join("Mixed.slnx"),
        "<Solution>\n  <Project Path=\"Lib/Lib.fsproj\" />\n  <Project Path=\"App/App.csproj\" />\n</Solution>\n",
    )
    .expect("write the solution");
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPF0101");

    // C#'s call keeps `used` alive. FCS cannot see C# callers, so neither can it
    // prove `orphan` unused: [ANALYZERS-TRUTH] prefers silence to a false error.
    session.await_dead(&[]);
    session.client.shutdown_and_exit();
}

/// The other direction: Roslyn sees no F# caller, so a public C# type only F#
/// uses must not be reported dead either.
#[test]
fn a_public_csharp_type_only_fsharp_uses_is_not_dead_in_a_monorepo() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real mixed solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "cs",
        ["<OutputType>Library</OutputType>", ""],
        "namespace Lib;\n\npublic sealed class Used { }\n\npublic sealed class Orphan { }\n",
    );
    let _app = write_project(
        root,
        "App",
        "fs",
        [
            "<OutputType>Exe</OutputType>",
            r#"<ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup>"#,
        ],
        "module App.Program\n\n[<EntryPoint>]\nlet main _ =\n    Lib.Used() |> ignore\n    0\n",
    );
    std::fs::write(
        root.join("Mixed.slnx"),
        "<Solution>\n  <Project Path=\"Lib/Lib.csproj\" />\n  <Project Path=\"App/App.fsproj\" />\n</Solution>\n",
    )
    .expect("write the solution");
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPC0101");

    // F#'s use keeps `Used` alive; `Orphan` is reported only if the analyzer can
    // prove no F# code uses it, which it cannot — so neither is reported.
    session.await_dead(&[]);
    session.client.shutdown_and_exit();
}

/// Write `<name>/<name>.<ext>proj` with `properties` and `items`, and its one
/// source `<name>.<ext>` (`cs` or `fs`; F# lists it in compile order); returns the source.
fn write_project(root: &Path, name: &str, ext: &str, settings: [&str; 2], source: &str) -> PathBuf {
    let [properties, items] = settings;
    let project = root.join(name);
    std::fs::create_dir_all(&project).expect("project directory");
    let compile = if ext == "fs" {
        format!("<ItemGroup><Compile Include=\"{name}.fs\" /></ItemGroup>")
    } else {
        String::new()
    };
    std::fs::write(
        project.join(format!("{name}.{ext}proj")),
        format!(
            "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup><TargetFramework>net10.0</TargetFramework>{properties}</PropertyGroup>\n  {compile}\n  {items}\n</Project>"
        ),
    )
    .expect("write the project");
    let file = project.join(format!("{name}.{ext}"));
    std::fs::write(&file, source).expect("write the source");
    file
}

/// A C# project with dead types and no `sharplsp.toml`: the defaults apply.
fn dead_csharp_workspace() -> (tempfile::TempDir, PathBuf) {
    let workspace = tempfile::tempdir().expect("real C# workspace");
    let source = write_project(
        workspace.path(),
        "Dead",
        "cs",
        ["<OutputType>Library</OutputType>", ""],
        DEAD_CS,
    );
    (workspace, source)
}

/// An F# project with dead code, and a `sharplsp.toml` turning the dead-code analyzer off.
fn dead_code_workspace() -> (tempfile::TempDir, PathBuf) {
    let workspace = tempfile::tempdir().expect("real F# workspace");
    let source = write_project(workspace.path(), "Dead", "fs", ["", ""], DEAD_FS);
    write_configuration(workspace.path(), "[analyzers]\ndead_code = false\n");
    (workspace, source)
}

/// Replace the workspace's `sharplsp.toml`.
fn write_configuration(root: &Path, text: &str) {
    std::fs::write(root.join("sharplsp.toml"), text).expect("write the workspace configuration");
}

/// A real server over the dead-code workspace, with every message it sent.
struct LiveSession {
    client: LspClient,
    uri: String,
    /// The dead-code rule of the source's language: `SLSPF0101` or `SLSPC0101`.
    code: &'static str,
    traffic: Vec<Value>,
}

impl LiveSession {
    /// Start the server with pull diagnostics and wait until the project loads.
    fn start(root: &Path, source: &Path, code: &'static str) -> Self {
        let mut client = LspClient::spawn_in(Stdio::null(), Some(root));
        let initialized = client.initialize_with_capabilities(
            json!(path_to_file_uri(root)),
            json!({"textDocument":{"diagnostic":{}},"workspace":{"diagnostics":{"refreshSupport":true}}}),
        );
        assert_rpc_ok(&initialized, "initialize the dead-code workspace");
        let mut session = Self {
            client,
            uri: path_to_file_uri(source),
            code,
            traffic: Vec::new(),
        };
        session.wait_for(NOTICED, "the project to load", |session| {
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
            .filter(|item| item["code"] == self.code)
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
        let mut last = Vec::new();
        let deadline = Instant::now() + NOTICED;
        while Instant::now() < deadline {
            last = self.dead();
            if last == expected {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("expected {expected:?} dead; the last pull reported {last:?}");
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

    /// How many messages of `method` the server has sent so far.
    fn count(&self, method: &str) -> usize {
        self.traffic
            .iter()
            .filter(|message| message["method"] == method)
            .count()
    }

    /// Wait, within [`NOTICED`], for a `workspace/diagnostic/refresh` beyond the
    /// `seen` already counted: the server debounces it after a settings change.
    fn await_refresh_after(&mut self, seen: usize, change: &str) {
        self.wait_for(
            NOTICED,
            &format!("a diagnostic refresh after {change}"),
            |session| session.count("workspace/diagnostic/refresh") > seen,
        );
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
