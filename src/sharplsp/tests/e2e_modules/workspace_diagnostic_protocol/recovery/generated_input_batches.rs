//! Generated output must not abort later genuine compiler inputs. [DIAG-ARCHITECTURE-SCOPE]
//! Exercises [DIAG-LSP-REFRESH] through real SDK projects and the public watched-file protocol.
use super::*;

#[test]
fn closed_disk_repair_survives_generated_first_event_batch() {
    let (workspace, generated) = generated_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    let uris = open_unsaved_error(&workspace, &mut client, &mut traffic);
    assert_truth(&mut client, &uris, &mut traffic, "before batch");
    let compiler = analyzer_replay::owned_csharp(&client);
    repair_in_one_batch(&workspace, &generated, &mut client);
    assert_batch_truth(&mut client, &uris, &generated, &mut traffic);
    assert_eq!(analyzer_replay::owned_csharp(&client), compiler);
    analyzer_replay::assert_host_alive(&mut client);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// An actual unrestored SDK project in build output exists before the watcher starts.
fn generated_workspace() -> (fixtures_medium::MediumWorkspace, std::path::PathBuf) {
    let workspace = recovery_workspace();
    let generated = output_project(&workspace);
    std::fs::write(
        workspace.root.join("sharplsp.toml"),
        "[diagnostics]\nanalyzers_enabled=false\nrefresh_debounce_ms=60000\n",
    )
    .expect("delay native coalescing independently of immediate client notifications");
    (workspace, generated)
}

/// Copy existing genuine SDK inputs without restoring the project under bin.
fn output_project(workspace: &fixtures_medium::MediumWorkspace) -> std::path::PathBuf {
    let output = workspace.root.join("Core/bin/Generated");
    std::fs::create_dir_all(&output).expect("create nested build output");
    let project_bytes = std::fs::copy(
        workspace.root.join("Core/Core.csproj"),
        output.join("Generated.csproj"),
    )
    .expect("copy real SDK project into output");
    assert!(project_bytes > 0);
    let generated = output.join("Generated.cs");
    let source_bytes =
        std::fs::copy(workspace.entities_path(), &generated).expect("copy generated source");
    assert!(source_bytes > 0);
    assert!(!output.join("obj/project.assets.json").exists());
    generated
}

/// A client batch must complete in order even when its first entry is ignored output.
fn repair_in_one_batch(
    workspace: &fixtures_medium::MediumWorkspace,
    generated: &std::path::Path,
    client: &mut LspClient,
) {
    let source = workspace.root.join("Core/Broken.cs");
    std::fs::write(&source, FIXED_CS).expect("repair actual closed C# input");
    client.notify(
        "workspace/didChangeWatchedFiles",
        json!({"changes":[
            {"uri":path_to_file_uri(generated),"type":2},
            {"uri":path_to_file_uri(&source),"type":2}
        ]}),
    );
}

/// The first successful pull preserves the unsaved F# error and clears the repaired C# error.
fn assert_batch_truth(
    client: &mut LspClient,
    uris: &[String; 2],
    generated: &std::path::Path,
    traffic: &mut Vec<Value>,
) {
    let report = complete_workspace_pull(client, traffic);
    let items = workspace_reports(&report);
    assert_repaired_reports(items, uris);
    assert!(!items
        .iter()
        .any(|item| item["uri"] == path_to_file_uri(generated)));
}

/// Independent invalidation preserves unsaved F# truth and applies the closed C# repair.
fn assert_repaired_reports(items: &[Value], uris: &[String; 2]) {
    assert_fsharp_overlay(report_for(items, &uris[0]));
    let cs = report_for(items, &uris[1]);
    assert_eq!(cs["kind"], "full");
    assert_eq!(cs["items"], json!([]), "genuine input must not be dropped");
}
