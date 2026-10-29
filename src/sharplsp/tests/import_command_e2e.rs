//! End-to-end tests for `sharplsp.addReferenceAndImport`, the command an
//! import quick fix runs after its edit has added the using or open
//! ([REFACTOR-IMPORT-REFERENCE]). A real `sharplsp` binary, a real C# sidecar
//! spawn and real project files: the server advertises the command, adds a
//! project reference through the `MSBuild` DOM (once, whatever the separator
//! spelling), installs a package at the version the quick fix carries, and
//! fails — naming the cause — for a missing project, an unknown kind and a
//! malformed argument, leaving the project untouched ([REFACTOR-NEVER-SILENT]).

#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::indexing_slicing,
    reason = "test code — JSON indexing panics are acceptable test failures"
)]
#![expect(
    unused_results,
    reason = "test code — initialize() return values are intentionally discarded"
)]

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tempfile::TempDir;

#[path = "support/lsp_client.rs"]
mod lsp_client;

use lsp_client::{require_dotnet, LspClient};

/// The command under test.
const COMMAND: &str = "sharplsp.addReferenceAndImport";

/// The project that gains references: CRLF and a comment that must survive.
const APP: &str = "<Project Sdk=\"Microsoft.NET.Sdk\">\r\n  <!-- the app -->\r\n  <PropertyGroup>\r\n    <TargetFramework>net10.0</TargetFramework>\r\n  </PropertyGroup>\r\n</Project>\r\n";

/// `App/App.csproj` and `Lib/Lib.csproj` under a fresh root.
fn solution() -> (TempDir, PathBuf, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let app = root.join("App").join("App.csproj");
    let lib = root.join("Lib").join("Lib.csproj");
    std::fs::create_dir_all(app.parent().unwrap()).unwrap();
    std::fs::create_dir_all(lib.parent().unwrap()).unwrap();
    std::fs::write(&app, APP).unwrap();
    std::fs::write(&lib, "<Project Sdk=\"Microsoft.NET.Sdk\" />\r\n").unwrap();
    (tmp, app, lib)
}

/// Run the command for `reference`, the way a quick fix's command does.
fn run(client: &mut LspClient, app: &Path, kind: &str, reference: &str, version: &str) -> Value {
    client.request(
        "workspace/executeCommand",
        json!({
            "command": COMMAND,
            "arguments": [{
                "title": "Reference project Lib from App.csproj and add 'using Shapes;' — Lib declares Shapes.Polygon",
                "action": { "id": 0, "uri": "file:///unused.cs" },
                "reference": {
                    "kind": kind,
                    "projectPath": app.to_string_lossy(),
                    "reference": reference,
                    "version": version,
                },
            }],
        }),
    )
}

/// The started, initialized server, rooted at `root`.
fn server(root: &Path) -> (LspClient, Value) {
    let mut client = LspClient::start();
    let init = client.initialize_with_root(root);
    (client, init)
}

/// The JSON-RPC error message of `response`, which must be an error.
fn error_message(response: &Value) -> String {
    assert!(
        response.get("result").is_none(),
        "must fail, not answer: {response}"
    );
    response["error"]["message"].as_str().unwrap().to_string()
}

#[test]
fn the_server_advertises_the_command_and_adds_a_project_reference_once() {
    if !require_dotnet() {
        return;
    }
    let (tmp, app, lib) = solution();
    let (mut client, init) = server(tmp.path());
    let commands = init["result"]["capabilities"]["executeCommandProvider"]["commands"]
        .as_array()
        .unwrap();
    assert!(
        commands.iter().any(|command| command == COMMAND),
        "advertised: {commands:?}"
    );

    let added = run(&mut client, &app, "project", &lib.to_string_lossy(), "");
    let include = Path::new("..").join("Lib").join("Lib.csproj");
    let include = include.to_string_lossy();
    assert_eq!(
        added["result"]["message"],
        json!(format!("Added a reference to {include}")),
        "{added}"
    );
    let text = std::fs::read_to_string(&app).unwrap();
    assert!(
        text.contains(&format!("<ProjectReference Include=\"{include}\" />")),
        "{text}"
    );
    assert!(
        text.contains("<!-- the app -->"),
        "the comment survives: {text}"
    );
    assert!(
        !text.replace("\r\n", "").contains('\n'),
        "CRLF everywhere: {text:?}"
    );

    let again = run(&mut client, &app, "project", &lib.to_string_lossy(), "");
    assert_eq!(
        again["result"]["message"],
        json!("App.csproj already references Lib.csproj"),
        "{again}"
    );
    assert_eq!(
        std::fs::read_to_string(&app).unwrap(),
        text,
        "the second run changes nothing"
    );
    client.shutdown_and_exit();
}

#[test]
fn a_package_is_added_at_the_version_the_quick_fix_carries() {
    if !require_dotnet() {
        return;
    }
    let (tmp, app, _lib) = solution();
    let (mut client, _init) = server(tmp.path());

    let added = run(&mut client, &app, "package", "Newtonsoft.Json", "13.0.3");
    assert_eq!(
        added["result"]["message"],
        json!("Added Newtonsoft.Json 13.0.3; restoring in the background"),
        "{added}"
    );
    let text = std::fs::read_to_string(&app).unwrap();
    assert!(
        text.contains("<PackageReference Include=\"Newtonsoft.Json\" Version=\"13.0.3\" />"),
        "{text}"
    );
    assert!(
        text.contains("<!-- the app -->"),
        "the comment survives: {text}"
    );
    client.shutdown_and_exit();
}

#[test]
fn a_reference_that_cannot_be_added_fails_naming_its_cause_and_changes_nothing() {
    if !require_dotnet() {
        return;
    }
    let (tmp, app, lib) = solution();
    let (mut client, _init) = server(tmp.path());
    let gone = lib.with_file_name("Gone.csproj");

    let missing = error_message(&run(
        &mut client,
        &app,
        "project",
        &gone.to_string_lossy(),
        "",
    ));
    assert!(
        missing.contains(&*gone.to_string_lossy()),
        "names the project: {missing}"
    );
    assert!(missing.contains("does not exist"), "says why: {missing}");

    let unknown = error_message(&run(&mut client, &app, "assembly", "Lib.dll", ""));
    assert!(
        unknown.contains("unknown reference kind \"assembly\": expected project or package"),
        "{unknown}"
    );

    let malformed = error_message(&client.request(
        "workspace/executeCommand",
        json!({ "command": COMMAND, "arguments": [] }),
    ));
    assert!(
        malformed.contains("needs one argument: { title, reference }"),
        "{malformed}"
    );
    assert_eq!(
        std::fs::read_to_string(&app).unwrap(),
        APP,
        "nothing was written"
    );
    client.shutdown_and_exit();
}

#[test]
fn the_command_edits_the_named_project_without_an_open_workspace() {
    if !require_dotnet() {
        return;
    }
    let (_tmp, app, lib) = solution();
    let mut client = LspClient::start();
    client.initialize();

    let added = run(&mut client, &app, "project", &lib.to_string_lossy(), "");
    let include = Path::new("..").join("Lib").join("Lib.csproj");
    assert_eq!(
        added["result"]["message"],
        json!(format!(
            "Added a reference to {}",
            include.to_string_lossy()
        )),
        "the project path alone is enough: {added}"
    );
    let text = std::fs::read_to_string(&app).unwrap();
    assert!(text.contains("<ProjectReference"), "{text}");
    client.shutdown_and_exit();
}
