//! A watched-file reload must never re-open a solution a switch already superseded.
//!
//! Implements [DIAG-LSP-REFRESH]: the observer supersedes pending diagnostic
//! work before forwarding a full compiler-workspace reload. PR #494 moved that
//! reload onto a background worker; the worker read the selected workspace ONCE
//! and then queued behind the slow C# `workspace/open`, so a `sharplsp/loadSolution`
//! that landed in that gap was clobbered when the worker's stale F# open re-opened
//! the OLD solution. This test pins the invariant: the last selection always wins.

use super::*;

use std::fmt::Write as _;

/// The C# project count in solution A. Large enough that A's design-time build
/// reliably outlives the storm → reload-read → switch sequence, so the reload's
/// F# open is still pending when the switch's F# open lands.
const A_CSHARP_PROJECTS: usize = 16;

/// The C# project type GUID in a `.sln`.
const CSHARP_PROJECT: &str = "{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}";
/// The F# project type GUID in a `.sln`.
const FSHARP_PROJECT: &str = "{F2A71F9B-5D33-465A-A702-920D77279786}";

const CALCULATOR_CS: &str = "namespace CsB;\n\npublic class Calculator\n{\n    public int Add(int a, int b) { return a + b; }\n}\n";

#[test]
fn test_reload_cannot_reopen_a_superseded_solution() {
    require_dotnet();

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    // Solution A: many C# projects (slow design-time build) + one F# project;
    // solution B: one of each. `sharplsp.toml` picks A so discovery is not ambiguous.
    write_solution_a(root);
    write_solution_b(root);
    std::fs::write(
        root.join("sharplsp.toml"),
        "[csharp]\nsolution_path = \"a/A.sln\"\n",
    )
    .unwrap();

    restore_solution(&root.join("a/A.sln"));
    restore_solution(&root.join("b/B.sln"));

    let real_root = std::fs::canonicalize(root).unwrap();
    let root_uri = path_to_file_uri(&real_root);
    let b_sln = std::fs::canonicalize(root.join("b/B.sln")).unwrap();
    let b_cs_uri = path_to_file_uri(&real_root.join("b/CsB/Calculator.cs"));
    let probe_b_uri = path_to_file_uri(&real_root.join("b/FsB/ProbeB.fs"));
    let superseded_fs_uri = path_to_file_uri(&real_root.join("a/FsA/ProbeA.fs"));

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    // Arm the native watcher and let both sidecars begin loading A.
    std::thread::sleep(Duration::from_millis(500));

    // The storm: a project-graph change owes a reload while A's initial load is
    // still running. A new `.fsproj` beneath the folder the F# compiler opened is
    // one it must reload for, so the reload races the switch below. (A C#
    // project outside the loaded solution concerns neither compiler.)
    write_fsharp_project(&root.join("a"), "Storm", "Storm.fs", "Storm");

    // Let the watcher coalesce, the reload worker read the OLD workspace, and its
    // C# open queue behind A's slow initial load.
    std::thread::sleep(Duration::from_millis(1500));

    // Switch to B while the reload is still pending behind A's C# load.
    let picked = client.request(
        "sharplsp/loadSolution",
        json!({ "solutionPath": b_sln.to_string_lossy() }),
    );
    assert!(
        picked.get("error").is_none(),
        "loadSolution failed: {picked}"
    );
    assert_eq!(
        picked["result"]["success"], true,
        "loadSolution must succeed: {picked}"
    );

    // C# must reach B: its document's hover resolves (the control leg).
    client.open_document(&b_cs_uri, CALCULATOR_CS);
    let csharp_hover =
        poll_hover_until_ready(&mut client, &b_cs_uri, 2, 13, Duration::from_mins(2));
    assert!(
        csharp_hover["contents"]["value"]
            .as_str()
            .unwrap_or_default()
            .contains("Calculator"),
        "the C# sidecar must hold solution B: {csharp_hover}"
    );

    // F# must ALSO hold B: B's F# document is owned by B's project.
    client.open_document(&probe_b_uri, &probe_fs("ProbeB"));
    let b_owner = client.request(
        "sharplsp/targetFramework",
        json!({ "textDocument": { "uri": probe_b_uri } }),
    );
    let b_project = b_owner["result"]["project"].as_str().unwrap_or_else(|| {
        panic!("the F# sidecar must own B's F# document, but no project answered: {b_owner}")
    });
    assert!(
        b_project.ends_with("FsB.fsproj"),
        "the F# sidecar must hold solution B (FsB), got project {b_project:?}"
    );

    // ...and A's F# document is NOT owned: F# now holds B, not the superseded A.
    let a_owner = client.request(
        "sharplsp/targetFramework",
        json!({ "textDocument": { "uri": superseded_fs_uri } }),
    );
    assert!(
        a_owner["result"]["project"].is_null(),
        "the F# sidecar must not still hold A: {a_owner}"
    );

    client.shutdown_and_exit();
}

/// Solution A: `A_CSHARP_PROJECTS` C# projects plus one F# project, all referenced.
fn write_solution_a(root: &Path) {
    let a = root.join("a");
    let mut projects = Vec::with_capacity(A_CSHARP_PROJECTS + 1);
    for index in 0..A_CSHARP_PROJECTS {
        let name = format!("CsA{index}");
        write_csharp_project(&a, &name);
        projects.push((
            CSHARP_PROJECT.to_owned(),
            name.clone(),
            format!("{name}/{name}.csproj"),
        ));
    }
    write_fsharp_project(&a, "FsA", "ProbeA.fs", "ProbeA");
    projects.push((
        FSHARP_PROJECT.to_owned(),
        "FsA".to_owned(),
        "FsA/FsA.fsproj".to_owned(),
    ));
    std::fs::write(a.join("A.sln"), solution(&projects)).unwrap();
}

/// Solution B: one C# project and one F# project, both referenced.
fn write_solution_b(root: &Path) {
    let b = root.join("b");
    write_fsharp_project(&b, "FsB", "ProbeB.fs", "ProbeB");
    write_csharp_project(&b, "CsB");
    std::fs::write(b.join("CsB/Calculator.cs"), CALCULATOR_CS).unwrap();
    std::fs::write(
        b.join("B.sln"),
        solution(&[
            (
                CSHARP_PROJECT.to_owned(),
                "CsB".to_owned(),
                "CsB/CsB.csproj".to_owned(),
            ),
            (
                FSHARP_PROJECT.to_owned(),
                "FsB".to_owned(),
                "FsB/FsB.fsproj".to_owned(),
            ),
        ]),
    )
    .unwrap();
}

/// A trivial SDK library project directory holding one source file.
fn write_csharp_project(root: &Path, name: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.csproj")), library_csproj("net9.0")).unwrap();
    std::fs::write(
        dir.join("Class1.cs"),
        format!("namespace {name};\npublic class Class1 {{ }}\n"),
    )
    .unwrap();
}

/// An F# SDK project directory holding the named module file.
fn write_fsharp_project(root: &Path, name: &str, file: &str, module: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.fsproj")), fsproj(file)).unwrap();
    std::fs::write(dir.join(file), probe_fs(module)).unwrap();
}

/// A minimal SDK library project for the target framework.
fn library_csproj(target_framework: &str) -> String {
    format!(
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>{target_framework}</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
</Project>"#
    )
}

/// A minimal F# SDK project compiling the one named module file.
fn fsproj(file: &str) -> String {
    format!(
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="{file}" />
  </ItemGroup>
</Project>"#
    )
}

/// The F# module source: one binding, so hover and ownership both resolve.
fn probe_fs(module: &str) -> String {
    format!("module {module}\n\n/// Adds two integers.\nlet add (a: int) (b: int) : int = a + b\n")
}

/// A `.sln` listing `projects` as `(type GUID, name, relative path)`.
fn solution(projects: &[(String, String, String)]) -> String {
    let mut body = String::from("Microsoft Visual Studio Solution File, Format Version 12.00\n");
    for (index, (kind, name, path)) in projects.iter().enumerate() {
        let guid = format!("{{00000000-0000-0000-0000-{:012}}}", index + 1);
        let _ = write!(
            body,
            "Project(\"{kind}\") = \"{name}\", \"{path}\", \"{guid}\"\nEndProject\n"
        );
    }
    body.push_str("Global\nEndGlobal\n");
    body
}

/// Restore a solution so each referenced project has design-time assets.
fn restore_solution(sln: &Path) {
    let status = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        .arg(sln)
        .status()
        .expect("dotnet restore failed to start");
    assert!(status.success(), "dotnet restore must succeed");
}
