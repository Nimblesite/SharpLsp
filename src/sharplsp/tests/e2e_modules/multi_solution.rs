use super::*;

// ── Multi-solution workspace roots ────────────────────────────────
//
// A workspace root holding more than one `.sln`/`.slnx` is ambiguous: the C#
// sidecar's recursive discovery deliberately refuses to guess which one to
// load. `sharplsp.toml`'s `csharp.solution_path` is the documented way to
// resolve that ambiguity. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].

/// Two solutions in sibling subdirectories — the shape of every real monorepo,
/// and of the `SharpLsp` repo itself. With `with_toml`, `sharplsp.toml` names
/// the one to load; without it, only the editor's settings can.
///
/// Returns `(tmp, root_uri, app_file_uri, app_source)`.
fn create_multi_solution_workspace(with_toml: bool) -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    let app_dir = root.join("app").join("App");
    let other_dir = root.join("other").join("Other");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::create_dir_all(&other_dir).unwrap();

    std::fs::write(app_dir.join("App.csproj"), library_csproj()).unwrap();
    std::fs::write(other_dir.join("Other.csproj"), library_csproj()).unwrap();

    let app_source = r"namespace App;

public class Calculator
{
    public int Add(int a, int b) { return a + b; }
}
";
    std::fs::write(app_dir.join("Calculator.cs"), app_source).unwrap();
    std::fs::write(
        other_dir.join("Decoy.cs"),
        "namespace Other;\npublic class Decoy { }\n",
    )
    .unwrap();

    std::fs::write(
        root.join("app").join("App.sln"),
        solution_referencing("App", "App/App.csproj"),
    )
    .unwrap();
    std::fs::write(
        root.join("other").join("Other.sln"),
        solution_referencing("Other", "Other/Other.csproj"),
    )
    .unwrap();

    // The knob under test: name the solution to load, relative to the root.
    if with_toml {
        std::fs::write(
            root.join("sharplsp.toml"),
            "[csharp]\nsolution_path = \"app/App.sln\"\n",
        )
        .unwrap();
    }

    restore_project(&app_dir);

    let real_root = std::fs::canonicalize(root).unwrap();
    let root_uri = path_to_file_uri(&real_root);
    let file_uri = path_to_file_uri(&real_root.join("app").join("App").join("Calculator.cs"));
    (tmp, root_uri, file_uri, app_source.to_string())
}

fn library_csproj() -> &'static str {
    r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#
}

fn solution_referencing(name: &str, relative_csproj: &str) -> String {
    format!(
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}}") = "{name}", "{relative_csproj}", "{{00000000-0000-0000-0000-000000000001}}"
EndProject
Global
EndGlobal"#
    )
}

/// Hover must return content when the workspace root holds several solutions
/// and `sharplsp.toml` says which one to load.
///
/// Without an explicit `solution_path`, recursive discovery finds two `.sln`
/// files, refuses to pick one, and the C# sidecar reports
/// `No .sln, .slnx, or .csproj found at or under '<root>'` — no solution loads
/// and every semantic request returns null. Implements
/// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
#[test]
fn test_full_stack_hover_uses_configured_solution_path_in_multi_solution_root() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_multi_solution_workspace(true);

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Hover on the "Calculator" class name (line 2, char 14).
    let result = poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));

    let value = result["contents"]["value"].as_str().unwrap();
    assert!(
        value.contains("Calculator"),
        "hover on class must mention Calculator, got: {value}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// The editor's settings choose the solution, with no `sharplsp.toml`.
/// `initializationOptions.sharplsp` takes the `sharplsp.toml` schema (Zed sends
/// `lsp.sharplsp.settings` there), and the host reads it before the eager
/// `workspace/open`, so the right solution loads first time and no error is
/// shown. Regression test for #375. Implements
/// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
#[test]
fn test_full_stack_initialization_options_choose_the_solution_in_multi_solution_root() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_multi_solution_workspace(false);

    let mut client = LspClient::start_verbose();
    let init = client.initialize_with_options(json!(root_uri), choose_app_solution());
    assert!(
        init.get("error").is_none(),
        "initialize must accept SharpLsp settings: {init}"
    );
    assert!(
        init["result"]["capabilities"]["hoverProvider"].as_bool() == Some(true),
        "the server must still offer hover: {init}"
    );
    client.open_document(&file_uri, &source);

    // Hover on the "Calculator" class name (line 2, char 14).
    let (class_hover, notifications) =
        poll_hover_collecting(&mut client, &file_uri, 2, 14, Duration::from_secs(90));
    assert!(
        hover_text(&class_hover).contains("Calculator"),
        "the configured App.sln must load, got: {class_hover}"
    );
    assert_eq!(
        error_messages(&notifications),
        Vec::<String>::new(),
        "a configured solution must not show an error"
    );

    // `Add` on line 4 answers from the same solution.
    let method_hover = hover(&mut client, &file_uri, 4, 16);
    assert_hover_ok(&method_hover);
    assert!(
        hover_text(&method_hover["result"]).contains("Add"),
        "hover on Add must describe the method, got: {method_hover}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// With several solutions and no `solution_path`, the host shows an error
/// naming every candidate and the setting. Choosing one in the editor's
/// settings (`workspace/didChangeConfiguration`) then loads it, with no
/// restart. Regression test for #375. Implements
/// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
#[test]
fn test_full_stack_ambiguous_root_shows_error_until_settings_choose_a_solution() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_multi_solution_workspace(false);

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    let shown = client.wait_for_notification("window/showMessage", Duration::from_secs(120));
    assert_eq!(
        shown["params"]["type"], 1,
        "an ambiguous root is an error: {shown}"
    );
    let message = shown["params"]["message"].as_str().unwrap();
    assert!(
        message.contains("App.sln") && message.contains("Other.sln"),
        "the error must name every candidate: {message}"
    );
    assert!(
        message.contains("solution_path"),
        "the error must name the setting that resolves it: {message}"
    );

    client.open_document(&file_uri, &source);
    let unloaded = hover(&mut client, &file_uri, 2, 14);
    assert_hover_ok(&unloaded);
    assert!(
        unloaded["result"].is_null(),
        "no solution is loaded yet, got: {unloaded}"
    );

    client.notify(
        "workspace/didChangeConfiguration",
        json!({ "settings": choose_app_solution() }),
    );
    let loaded = poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));
    assert!(
        hover_text(&loaded).contains("Calculator"),
        "the solution chosen in settings must load, got: {loaded}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// A client with its own solution picker (VS Code) declares
/// `solutionPicker`, so an ambiguous root is its to resolve: the host shows
/// no error, and the solution the client sends through
/// `sharplsp/loadSolution` loads. Implements
/// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
#[test]
fn test_full_stack_solution_picker_client_gets_no_ambiguity_error() {
    require_dotnet();

    let (tmp, root_uri, file_uri, source) = create_multi_solution_workspace(false);

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_options(json!(root_uri), json!({ "solutionPicker": true }));

    let solution = std::fs::canonicalize(tmp.path().join("app").join("App.sln")).unwrap();
    let picked = client.request(
        "sharplsp/loadSolution",
        json!({ "solutionPath": solution.to_string_lossy() }),
    );
    assert!(
        picked.get("error").is_none(),
        "loadSolution failed: {picked}"
    );
    assert_eq!(
        picked["result"]["success"], true,
        "loadSolution must report success: {picked}"
    );

    client.open_document(&file_uri, &source);
    let (class_hover, notifications) =
        poll_hover_collecting(&mut client, &file_uri, 2, 14, Duration::from_secs(90));
    assert!(
        hover_text(&class_hover).contains("Calculator"),
        "the picked App.sln must load, got: {class_hover}"
    );
    assert_eq!(
        error_messages(&notifications),
        Vec::<String>::new(),
        "a solution-picker client must not be shown the ambiguity error"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `SharpLsp` settings, in the `sharplsp.toml` schema, that choose `app/App.sln`.
fn choose_app_solution() -> Value {
    json!({ "sharplsp": { "csharp": { "solution_path": "app/App.sln" } } })
}

/// The markdown a hover result shows.
fn hover_text(result: &Value) -> &str {
    result["contents"]["value"].as_str().unwrap_or_default()
}

/// The text of every error `window/showMessage` among `notifications`.
fn error_messages(notifications: &[Value]) -> Vec<String> {
    notifications
        .iter()
        .filter(|message| message["method"] == "window/showMessage")
        .filter(|message| message["params"]["type"] == 1)
        .map(|message| message["params"]["message"].to_string())
        .collect()
}
