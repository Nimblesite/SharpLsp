//! E2E for F# Fix All through the host ([FIXALL-SCOPES], [FIXALL-LSP], GitHub
//! #577): "Remove unused open" (SLSPF0102) across a real two-project F# solution.
//! Each scope resolves, through the `FixAllRequest` in its `data`, to one
//! `WorkspaceEdit` deleting exactly the unused opens of that scope.

use super::*;
use std::path::{Path, PathBuf};

/// A file of `module`, with one unused `open System.Text` on line 2 (0-based).
fn unused_open_source(module: &str) -> String {
    format!("module {module}\n\nopen System.Text\n\nlet value = 1\n")
}

/// A project file compiling `files`, referencing `references`.
fn fsproj(files: &[&str], references: &[&str]) -> String {
    let compiles: String = files
        .iter()
        .map(|file| format!("    <Compile Include=\"{file}\" />\n"))
        .collect();
    let refs: String = references
        .iter()
        .map(|reference| format!("    <ProjectReference Include=\"{reference}\" />\n"))
        .collect();
    format!(
        "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    \
         <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n  \
         <ItemGroup>\n{compiles}{refs}  </ItemGroup>\n</Project>\n"
    )
}

fn write_project(root: &Path, name: &str, files: &[(&str, String)], references: &[&str]) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let names: Vec<&str> = files.iter().map(|(file, _)| *file).collect();
    std::fs::write(
        dir.join(format!("{name}.fsproj")),
        fsproj(&names, references),
    )
    .unwrap();
    for (file, text) in files {
        std::fs::write(dir.join(file), text).unwrap();
    }
}

/// `Core` (Alpha.fs, Beta.fs) referenced by `App` (Program.fs), one unused open each,
/// in one `.slnx`, restored. Keep the temp dir alive for the test.
fn create_fsharp_fixall_workspace() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_project(
        root,
        "Core",
        &[
            ("Alpha.fs", unused_open_source("Core.Alpha")),
            ("Beta.fs", unused_open_source("Core.Beta")),
        ],
        &[],
    );
    write_project(
        root,
        "App",
        &[("Program.fs", unused_open_source("App.Program"))],
        &["../Core/Core.fsproj"],
    );
    std::fs::write(
        root.join("FixAll.slnx"),
        "<Solution>\n  <Project Path=\"Core/Core.fsproj\" />\n  <Project Path=\"App/App.fsproj\" />\n</Solution>\n",
    )
    .unwrap();
    restore_project(&root.join("App"));
    let canonical = std::fs::canonicalize(root).unwrap();
    (tmp, canonical)
}

/// Every edit of a resolved fix-all deletes one whole `open` line.
fn assert_all_edits_delete_lines(resp: &Value, label: &str) {
    let edits: Vec<&Value> = resp["result"]["edit"]["changes"]
        .as_object()
        .unwrap_or_else(|| panic!("{label} must have changes: {resp}"))
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .collect();
    assert!(!edits.is_empty(), "{label} must have edits: {resp}");
    for edit in edits {
        assert_eq!(
            edit["newText"], "",
            "{label}: an unused open is deleted: {edit}"
        );
        assert_eq!(
            edit["range"]["start"]["line"], 2,
            "{label}: the open's own line: {edit}"
        );
        assert_eq!(
            edit["range"]["start"]["character"], 0,
            "{label}: from column 0: {edit}"
        );
    }
}

/// F# first ([FIXALL-SCOPES]): the same document < project < solution nesting the
/// C# fix-all has, over the F# sidecar's batch engine.
#[test]
fn fsharp_fix_all_remove_unused_open_document_project_solution_scope() {
    require_dotnet();
    let (_tmp, root) = create_fsharp_fixall_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(path_to_file_uri(&root)));
    let alpha = root.join("Core").join("Alpha.fs");
    let alpha_uri = path_to_file_uri(&alpha);
    client.open_document(&alpha_uri, &unused_open_source("Core.Alpha"));
    let _ready = poll_hover_until_ready(&mut client, &alpha_uri, 4, 5, Duration::from_secs(150));

    // Interaction 1 — the unused open offers one fix-all action per scope.
    let actions = poll_fix_all_actions(&mut client, &alpha_uri, (2, 0, 16));
    for scope in ["document", "project", "solution"] {
        let fix_all = fix_all_for(&actions, scope, "Remove unused open");
        let request = &fix_all["data"]["fixAll"];
        assert_eq!(
            request["scope"],
            json!(scope),
            "the data carries the scope: {fix_all}"
        );
        assert_eq!(
            request["fixKey"], "SLSPF0102",
            "the fix key is the rule id: {fix_all}"
        );
        assert_eq!(request["enforce"], false, "no enforcement yet: {fix_all}");
        assert_eq!(fix_all["data"]["uri"], json!(alpha_uri));
    }

    // Interactions 2-4 — each scope resolves to exactly its files.
    let resolve = |client: &mut LspClient, scope: &str| {
        let action = fix_all_for(&actions, scope, "Remove unused open").clone();
        let resp = client.request("codeAction/resolve", action);
        assert!(
            resp.get("error").is_none(),
            "{scope} resolve must not error: {resp}"
        );
        assert_all_edits_delete_lines(&resp, scope);
        edit_files(&resp, scope)
    };
    let document = resolve(&mut client, "document");
    assert_eq!(
        document.len(),
        1,
        "document scope touches the anchor only: {document:?}"
    );
    assert_eq!(edits_in(&document, "Alpha.fs"), 1);

    let project = resolve(&mut client, "project");
    assert_eq!(
        project.len(),
        2,
        "project scope touches Core's two files: {project:?}"
    );
    assert_eq!(edits_in(&project, "Beta.fs"), 1);
    assert_eq!(
        edits_in(&project, "Program.fs"),
        0,
        "never leaves the owning project"
    );

    let solution = resolve(&mut client, "solution");
    assert_eq!(
        solution.len(),
        3,
        "solution scope touches every project: {solution:?}"
    );
    assert_eq!(edits_in(&solution, "Program.fs"), 1);
    assert!(document.len() < project.len() && project.len() < solution.len());

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
