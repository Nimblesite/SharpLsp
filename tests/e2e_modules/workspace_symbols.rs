use super::*;

// ── Workspace Symbols Tests ──────────────────────────────────────

/// Create a temp .sln + .csproj + .cs workspace for workspaceSymbols tests.
fn create_workspace_symbols_fixture() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("MyLib");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("MyLib.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    std::fs::write(
        proj_dir.join("Models.cs"),
        r#"namespace MyLib.Models;

public class Customer
{
    public string Name { get; set; } = "";
    public int Age { get; set; }

    public void Greet() { }
    private int _id;
}

public interface IRepository
{
    void Save();
}

public enum Status
{
    Active,
    Inactive
}

public struct Point
{
    public int X;
    public int Y;
}

public record Address(string Street, string City);

public delegate void Handler(string msg);
"#,
    )
    .unwrap();

    std::fs::write(
        tmp.path().join("Test.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyLib", "MyLib/MyLib.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let sln_path = tmp
        .path()
        .canonicalize()
        .unwrap()
        .join("Test.sln")
        .to_string_lossy()
        .to_string();
    (tmp, sln_path)
}

#[test]
fn test_workspace_symbols_returns_project_with_symbols() {
    let (_tmp, sln_path) = create_workspace_symbols_fixture();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/workspaceSymbols", json!({ "solution": sln_path }));
    assert!(resp.get("error").is_none(), "must not error: {resp}");

    let projects = resp["result"]["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1, "must find one project");
    assert_eq!(projects[0]["name"], "MyLib");

    let symbols = projects[0]["symbols"].as_array().unwrap();
    assert!(!symbols.is_empty(), "project must have file symbols");

    let file_sym = &symbols[0];
    assert!(
        file_sym["file"].as_str().unwrap().contains("Models.cs"),
        "must reference Models.cs"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_workspace_symbols_extracts_all_symbol_kinds() {
    fn collect_kinds(syms: &[Value]) -> Vec<String> {
        let mut kinds = Vec::new();
        for s in syms {
            kinds.push(s["kind"].as_str().unwrap_or("").to_string());
            if let Some(children) = s["children"].as_array() {
                kinds.extend(collect_kinds(children));
            }
        }
        kinds
    }

    let (_tmp, sln_path) = create_workspace_symbols_fixture();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/workspaceSymbols", json!({ "solution": sln_path }));
    assert!(resp.get("error").is_none(), "must not error: {resp}");

    let file_symbols = &resp["result"]["projects"][0]["symbols"][0]["symbols"];
    let syms = file_symbols.as_array().unwrap();

    let kinds = collect_kinds(syms);

    for expected in [
        "Namespace",
        "Class",
        "Interface",
        "Enum",
        "Struct",
        "Method",
        "Property",
        "EnumMember",
        "Function",
    ] {
        assert!(
            kinds.iter().any(|k| k == expected),
            "must find {expected} symbol kind, got: {kinds:?}"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_workspace_symbols_symbol_ranges_valid() {
    fn assert_ranges(syms: &[Value]) {
        for s in syms {
            let range = &s["range"];
            let start_line = range["start"]["line"].as_u64().unwrap();
            let end_line = range["end"]["line"].as_u64().unwrap();
            assert!(
                end_line >= start_line,
                "end line must be >= start line for symbol {}",
                s["name"]
            );
            if let Some(children) = s["children"].as_array() {
                assert_ranges(children);
            }
        }
    }

    let (_tmp, sln_path) = create_workspace_symbols_fixture();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/workspaceSymbols", json!({ "solution": sln_path }));
    let file_symbols = &resp["result"]["projects"][0]["symbols"][0]["symbols"];

    assert_ranges(file_symbols.as_array().unwrap());

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_workspace_symbols_access_modifiers() {
    fn find_symbol<'a>(syms: &'a [Value], name: &str) -> Option<&'a Value> {
        for s in syms {
            if s["name"].as_str() == Some(name) {
                return Some(s);
            }
            if let Some(children) = s["children"].as_array() {
                if let Some(found) = find_symbol(children, name) {
                    return Some(found);
                }
            }
        }
        None
    }

    let (_tmp, sln_path) = create_workspace_symbols_fixture();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/workspaceSymbols", json!({ "solution": sln_path }));

    let syms = resp["result"]["projects"][0]["symbols"][0]["symbols"]
        .as_array()
        .unwrap();

    let customer = find_symbol(syms, "Customer").expect("must find Customer");
    assert_eq!(customer["access"], "public");

    let greet = find_symbol(syms, "Greet").expect("must find Greet");
    assert_eq!(greet["access"], "public");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_workspace_symbols_nonexistent_solution() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/workspaceSymbols",
        json!({ "solution": "/nonexistent/path.sln" }),
    );
    assert!(
        resp.get("error").is_some(),
        "nonexistent solution must return error"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_workspace_symbols_file_scoped_namespace_reparenting() {
    let (_tmp, sln_path) = create_workspace_symbols_fixture();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/workspaceSymbols", json!({ "solution": sln_path }));
    let syms = resp["result"]["projects"][0]["symbols"][0]["symbols"]
        .as_array()
        .unwrap();

    // File-scoped namespace: all types should be children of the namespace.
    let ns = syms.iter().find(|s| s["kind"] == "Namespace");
    assert!(ns.is_some(), "must have a namespace symbol");
    let ns = ns.unwrap();
    assert_eq!(ns["name"], "MyLib.Models");

    let children = ns["children"].as_array().unwrap();
    let child_names: Vec<&str> = children.iter().filter_map(|c| c["name"].as_str()).collect();
    assert!(
        child_names.contains(&"Customer"),
        "Customer must be a child of namespace: {child_names:?}"
    );
    assert!(
        child_names.contains(&"IRepository"),
        "IRepository must be a child of namespace: {child_names:?}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Create a workspace with a solution folder and `NestedProjects` section
/// to exercise the parent folder resolution code path.
fn create_nested_workspace() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("SrcLib");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("SrcLib.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    std::fs::write(
        proj_dir.join("Core.cs"),
        "namespace SrcLib;\npublic class Core { public void Run() {} }\n",
    )
    .unwrap();

    // Solution with a solution folder "src" containing SrcLib.
    std::fs::write(
        tmp.path().join("Nested.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{AAAAAAAA-0000-0000-0000-000000000001}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "SrcLib", "SrcLib/SrcLib.csproj", "{BBBBBBBB-0000-0000-0000-000000000002}"
EndProject
Global
	GlobalSection(NestedProjects) = preSolution
		{BBBBBBBB-0000-0000-0000-000000000002} = {AAAAAAAA-0000-0000-0000-000000000001}
	EndGlobalSection
EndGlobal"#,
    )
    .unwrap();

    let sln_path = tmp
        .path()
        .canonicalize()
        .unwrap()
        .join("Nested.sln")
        .to_string_lossy()
        .to_string();
    (tmp, sln_path)
}

#[test]
fn test_workspace_symbols_with_nested_solution_folders() {
    let (_tmp, sln_path) = create_nested_workspace();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/workspaceSymbols", json!({ "solution": sln_path }));
    assert!(
        resp.get("error").is_none(),
        "nested solution must not error: {resp}"
    );

    let result = &resp["result"];

    // The NestedProjects section exercises the nesting code path.
    // The solutionFolders array exists (may be empty depending on GUID matching).
    assert!(
        result["solutionFolders"].is_array(),
        "solutionFolders must be an array: {result}"
    );

    // The SrcLib project must be found.
    let projects = result["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1, "must find one project");
    assert_eq!(projects[0]["name"], "SrcLib");

    // Symbols must be extracted from Core.cs.
    let syms = projects[0]["symbols"].as_array().unwrap();
    assert!(!syms.is_empty(), "SrcLib must have file symbols");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_workspace_symbols_solution_with_multiple_projects() {
    let tmp = tempfile::tempdir().unwrap();

    // Two projects side by side.
    for name in &["Alpha", "Beta"] {
        let proj_dir = tmp.path().join(name);
        std::fs::create_dir_all(&proj_dir).unwrap();

        std::fs::write(
            proj_dir.join(format!("{name}.csproj")),
            r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>"#,
        )
        .unwrap();

        std::fs::write(
            proj_dir.join("Lib.cs"),
            format!(
                "namespace {name};\npublic class {name}Lib {{ public void Do() {{}} }}\n"
            ),
        )
        .unwrap();
    }

    std::fs::write(
        tmp.path().join("Multi.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Alpha", "Alpha/Alpha.csproj", "{11111111-0000-0000-0000-000000000001}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Beta", "Beta/Beta.csproj", "{22222222-0000-0000-0000-000000000002}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let sln_path = tmp
        .path()
        .canonicalize()
        .unwrap()
        .join("Multi.sln")
        .to_string_lossy()
        .to_string();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/workspaceSymbols", json!({ "solution": sln_path }));
    assert!(
        resp.get("error").is_none(),
        "multi-project solution must not error: {resp}"
    );

    let projects = resp["result"]["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 2, "must find two projects");

    let names: Vec<&str> = projects
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    assert!(names.contains(&"Alpha"), "must find Alpha: {names:?}");
    assert!(names.contains(&"Beta"), "must find Beta: {names:?}");

    // Both projects have symbols.
    for proj in projects {
        let syms = proj["symbols"].as_array().unwrap();
        assert!(
            !syms.is_empty(),
            "project {} must have symbols",
            proj["name"]
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
