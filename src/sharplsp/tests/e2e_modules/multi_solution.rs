use super::*;

// ── Multi-solution workspace roots ────────────────────────────────
//
// A workspace root holding more than one `.sln`/`.slnx` is ambiguous: the C#
// sidecar's recursive discovery deliberately refuses to guess which one to
// load. `sharplsp.toml`'s `csharp.solution_path` is the documented way to
// resolve that ambiguity. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].

/// Two solutions in sibling subdirectories — the shape of every real monorepo,
/// and of the `SharpLsp` repo itself. `sharplsp.toml` names the one to load.
///
/// Returns `(tmp, root_uri, app_file_uri, app_source)`.
fn create_multi_solution_workspace() -> (tempfile::TempDir, String, String, String) {
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
    std::fs::write(
        root.join("sharplsp.toml"),
        "[csharp]\nsolution_path = \"app/App.sln\"\n",
    )
    .unwrap();

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

    let (_tmp, root_uri, file_uri, source) = create_multi_solution_workspace();

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
