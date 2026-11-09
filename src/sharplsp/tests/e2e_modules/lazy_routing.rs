//! Lazy workspace initialization without a workspace root, as an editor opening
//! loose files starts the host: a document no compiler reads leaves the latch
//! clear for the next one, and only the opened language's compiler starts.
//! Implements [SCRIPT-ROUTE-LAZY].

use super::workspace_diagnostic_protocol::recovery::{owned_apphosts, published_apphost_uri};
use super::*;

/// A C# file-based app: `Add` is called on its second line.
const APP: &str = "static int Add(int a, int b) => a + b;\nSystem.Console.WriteLine(Add(1, 2));\n";
/// An F# script: `add` is called on its second line.
const SCRIPT: &str = "let add a b = a + b\nprintfn \"%d\" (add 1 2)\n";

/// How long a cold compiler may take to answer its first hover.
const COLD: Duration = Duration::from_mins(2);

/// A host in `dir` with no workspace root.
fn rootless(dir: &Path) -> LspClient {
    let mut client = LspClient::spawn_in(Stdio::null(), Some(dir));
    assert_rpc_ok(&client.initialize(), "initialize without a workspace root");
    client
}

/// Write `text` to `name` in `dir` and open it, returning its URI.
fn open_loose(client: &mut LspClient, dir: &Path, name: &str, text: &str) -> String {
    let path = dir.join(name);
    std::fs::write(&path, text).expect("write a loose file");
    let uri = path_to_file_uri(&path);
    client.open_document(&uri, text);
    uri
}

/// The hover a compiler answers at `line`:`character` of `uri`, once it has loaded.
fn hover_answered(client: &mut LspClient, uri: &str, line: u32, character: u32) -> String {
    let deadline = Instant::now() + COLD;
    loop {
        let response = hover(client, uri, line, character);
        assert_rpc_ok(&response, "hover answers while the compiler loads");
        if let Some(text) = response["result"]["contents"]["value"].as_str() {
            return text.to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "no compiler answered: {response}"
        );
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// How many compilers the host started from the apphost the environment `key` names.
fn running(client: &LspClient, key: &str) -> usize {
    owned_apphosts(client, &published_apphost_uri(key, key)).len()
}

#[test]
fn a_document_no_compiler_reads_leaves_the_latch_clear_and_csharp_starts_only_roslyn() {
    require_dotnet();
    let dir = tempfile::tempdir().expect("a folder of loose files");
    let mut client = rootless(dir.path());
    let _ = open_loose(&mut client, dir.path(), "README.md", "# Notes\n");
    let app = open_loose(&mut client, dir.path(), "app.cs", APP);
    let text = hover_answered(&mut client, &app, 1, 25);
    assert!(
        text.contains("Add"),
        "the C# compiler loaded the app after the README: {text}"
    );
    assert_eq!(
        running(&client, "SHARPLSP_CSHARP_SIDECAR_PATH"),
        1,
        "Roslyn serves the .cs"
    );
    assert_eq!(
        running(&client, "SHARPLSP_FSHARP_SIDECAR_PATH"),
        0,
        "no F# compiler for C#"
    );
    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn an_fsharp_script_starts_only_fcs() {
    require_dotnet();
    let dir = tempfile::tempdir().expect("a folder of loose files");
    let mut client = rootless(dir.path());
    let script = open_loose(&mut client, dir.path(), "Script.fsx", SCRIPT);
    let text = hover_answered(&mut client, &script, 1, 14);
    assert!(text.contains("add"), "FCS answers the script: {text}");
    assert_eq!(
        running(&client, "SHARPLSP_FSHARP_SIDECAR_PATH"),
        1,
        "FCS serves the .fsx"
    );
    assert_eq!(
        running(&client, "SHARPLSP_CSHARP_SIDECAR_PATH"),
        0,
        "no Roslyn for F#"
    );
    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn a_script_in_a_folder_with_no_project_answers_after_a_space_and_after_a_token() {
    require_dotnet();
    let dir = tempfile::tempdir().expect("a folder with one script and no project");
    let root = std::fs::canonicalize(dir.path()).expect("canonical folder");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&root));
    let initialized = client.initialize_with_root(json!(path_to_file_uri(&root)));
    assert_rpc_ok(&initialized, "initialize on the folder (#497)");
    let script = open_loose(&mut client, &root, "build.fsx", SCRIPT);
    let declared = hover_answered(&mut client, &script, 0, 4);
    assert!(
        declared.contains("add"),
        "the definition after `let `: {declared}"
    );
    let called = hover_answered(&mut client, &script, 1, 14);
    assert!(
        called.contains("add"),
        "the call right after `(` (#553): {called}"
    );
    assert_eq!(
        running(&client, "SHARPLSP_FSHARP_SIDECAR_PATH"),
        1,
        "FCS serves the script"
    );
    client.shutdown_and_exit();
    client.wait_with_timeout();
}
