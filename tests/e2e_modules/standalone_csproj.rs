use super::*;

// ── Standalone .csproj (no .sln) — Hover & Definition ───────────

/// Create a workspace with only a `.csproj` file (no `.sln`).
/// This mirrors the `editors/vscode/test-fixtures/workspace/` layout
/// used by `code serve-web` for automated screenshots.
fn create_standalone_csproj_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path();

    std::fs::write(
        proj_dir.join("TestStandalone.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    let cs_source = r#"namespace TestStandalone;

public class Calculator
{
    public int Add(int a, int b) { return a + b; }
    public string Name { get; set; } = "Default";
}"#;
    std::fs::write(proj_dir.join("Calculator.cs"), cs_source).unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        .current_dir(proj_dir)
        .status()
        .expect("dotnet restore failed to start");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(proj_dir).unwrap();
    let root_uri = format!("file://{}", real_root.display());
    let file_uri = format!("file://{}", real_root.join("Calculator.cs").display());
    (tmp, root_uri, file_uri, cs_source.to_string())
}

/// Hover must return content for a standalone `.csproj` workspace (no `.sln`).
/// This is the layout used by `code serve-web` for screenshots.
#[test]
fn test_full_stack_hover_standalone_csproj_no_sln() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_standalone_csproj_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Hover on "Calculator" class name (line 2, char 14).
    let result = poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));

    let contents = &result["contents"];
    assert_eq!(contents["kind"], "markdown", "contents must be markdown");
    let value = contents["value"].as_str().unwrap();
    assert!(
        value.contains("Calculator"),
        "hover on class must mention Calculator, got: {value}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Go to definition must return a location for a standalone `.csproj`
/// workspace (no `.sln`).
#[test]
fn test_full_stack_definition_standalone_csproj_no_sln() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_standalone_csproj_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar to load before requesting definition.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));

    // Definition on "Add" method name (line 4, char 16).
    let resp = definition(&mut client, &file_uri, 4, 16);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        !result.is_null() && !result.as_array().is_some_and(Vec::is_empty),
        "definition on method must return a location for standalone .csproj, got: {result}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
