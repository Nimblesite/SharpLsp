//! Actual SDK graph reloads preserve unsaved F# truth and retire deleted C# sources.
//! Implements [DIAG-LSP-REFRESH] and [DIAG-TRUTH-GUARANTEES].
use super::*;

const ADDED_SOURCE: &str = "namespace Medium.Core;\npublic static class Added {\n public static int Value => absentAfterSourceCreation;\n}\n";
const PROPS: &str = r"<Project><PropertyGroup><DefineConstants>$(DefineConstants);INPUT_RELOAD_PROOF</DefineConstants></PropertyGroup></Project>";

#[test]
fn source_creation_metadata_reload_and_deletion_preserve_unsaved_fsharp_truth() {
    let workspace = broken_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    workspace_diagnostic_session::warm_clean_documents(&workspace, &mut client, &mut traffic);
    let fs_uri = path_to_file_uri(&workspace.calculations_path());
    client.notify(
        "textDocument/didOpen",
        json!({"textDocument":{"uri":fs_uri,"languageId":"fsharp","version":1,"text":BROKEN_FS}}),
    );
    client.change_document(&fs_uri, 2, fixtures_medium::CALCULATIONS_FS);
    let added = workspace.root.join("Core/Added.cs");
    let added_uri = path_to_file_uri(&added);
    std::fs::write(&added, ADDED_SOURCE).expect("create actual SDK source");
    assert_build(&workspace.root.join("Core/Core.csproj"), Some("CS0103"));
    watched(&mut client, &added_uri, 1);
    let before = assert_loaded(
        &mut client,
        &workspace,
        &fs_uri,
        Some(&added_uri),
        &[],
        &mut traffic,
    );
    let props = workspace.root.join("Directory.Build.props");
    std::fs::write(&props, PROPS).expect("write actual SDK metadata input");
    watched(&mut client, &path_to_file_uri(&props), 2);
    let after = assert_loaded(
        &mut client,
        &workspace,
        &fs_uri,
        Some(&added_uri),
        &[],
        &mut traffic,
    );
    assert_ne!(
        report_for(&before, &added_uri)["resultId"],
        report_for(&after, &added_uri)["resultId"]
    );
    let previous =
        vec![json!({"uri":added_uri,"value":report_for(&after, &added_uri)["resultId"]})];
    std::fs::remove_file(&added).expect("delete only this test's newly created temporary source");
    assert_build(&workspace.root.join("Core/Core.csproj"), Some("CS0029"));
    watched(&mut client, &added_uri, 3);
    let retired = assert_loaded(
        &mut client,
        &workspace,
        &fs_uri,
        None,
        &previous,
        &mut traffic,
    );
    assert_eq!(report_for(&retired, &added_uri)["items"], json!([]));
    assert_ne!(
        report_for(&retired, &added_uri)["resultId"],
        previous[0]["value"]
    );
    let (native_added, reports) =
        native_source_created(&workspace, &mut client, &fs_uri, &mut traffic);
    native_source_removed(
        &workspace,
        &mut client,
        &fs_uri,
        &native_added,
        &reports,
        &mut traffic,
    );
    assert_saved_truth_returns(&workspace, &mut client, &fs_uri, &mut traffic);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Native subscriptions must discover SDK implicit sources without editor file events.
fn native_source_created(
    workspace: &fixtures_medium::MediumWorkspace,
    client: &mut LspClient,
    fs_uri: &str,
    traffic: &mut Vec<Value>,
) -> (PathBuf, Vec<Value>) {
    idle_restore::drain_for(client, Duration::from_secs(3), traffic);
    let added = workspace.root.join("Core/NativeAdded.cs");
    let uri = path_to_file_uri(&added);
    std::fs::write(&added, ADDED_SOURCE).expect("create native-watched SDK source");
    assert_build(&workspace.root.join("Core/Core.csproj"), Some("CS0103"));
    let mut invalidation = Vec::new();
    idle_restore::await_compiler_refresh(client, &mut invalidation);
    traffic.extend(invalidation);
    let reports = assert_loaded(client, workspace, fs_uri, Some(&uri), &[], traffic);
    (added, reports)
}

/// Removing that actual source must retire its prior result without a client notification.
fn native_source_removed(
    workspace: &fixtures_medium::MediumWorkspace,
    client: &mut LspClient,
    fs_uri: &str,
    added: &Path,
    reports: &[Value],
    traffic: &mut Vec<Value>,
) {
    idle_restore::drain_for(client, Duration::from_secs(3), traffic);
    let uri = path_to_file_uri(added);
    let previous = vec![json!({"uri":uri,"value":report_for(reports, &uri)["resultId"]})];
    std::fs::remove_file(added).expect("delete this test's native-watched SDK source");
    assert_build(&workspace.root.join("Core/Core.csproj"), Some("CS0029"));
    let mut invalidation = Vec::new();
    idle_restore::await_compiler_refresh(client, &mut invalidation);
    traffic.extend(invalidation);
    let retired = assert_loaded(client, workspace, fs_uri, None, &previous, traffic);
    assert_eq!(report_for(&retired, &uri)["items"], json!([]));
    assert_ne!(report_for(&retired, &uri)["resultId"], previous[0]["value"]);
    let current = complete_workspace_pull(client, traffic);
    let sources = current["result"]["items"]
        .as_array()
        .expect("current source metadata");
    assert!(sources.iter().all(|report| report["uri"] != uri));
}

/// Send the standard event only after the real filesystem operation has completed.
fn watched(client: &mut LspClient, uri: &str, typ: u32) {
    client.notify(
        "workspace/didChangeWatchedFiles",
        json!({"changes":[{"uri":uri,"type":typ}]}),
    );
}

/// Every completed graph reload must preserve overlays and real closed-file errors.
fn assert_loaded(
    client: &mut LspClient,
    workspace: &fixtures_medium::MediumWorkspace,
    fs_uri: &str,
    added_uri: Option<&str>,
    previous: &[Value],
    traffic: &mut Vec<Value>,
) -> Vec<Value> {
    let response = workspace_pull(client, previous, traffic);
    let items = response["result"]["items"]
        .as_array()
        .expect("reloaded SDK reports");
    let fs = report_for(items, fs_uri);
    assert_eq!(fs["kind"], "full");
    assert_eq!(fs["version"], 2);
    assert!(
        fs["items"]
            .as_array()
            .expect("unsaved F# diagnostics")
            .iter()
            .all(|item| item["severity"] != 1),
        "disk FS0001 must not overwrite the valid unsaved F# buffer: {fs}"
    );
    assert_error(
        report_for(
            items,
            &path_to_file_uri(&workspace.root.join("Core/Broken.cs")),
        )["items"]
            .as_array()
            .expect("closed compiler errors survive reload"),
        "CS0029",
        "sharplsp-csharp",
    );
    if let Some(uri) = added_uri {
        assert_error(
            report_for(items, uri)["items"]
                .as_array()
                .expect("new source compiler error"),
            "CS0103",
            "sharplsp-csharp",
        );
    }
    assert_eq!(
        std::fs::read_to_string(workspace.calculations_path())
            .expect("read original saved F# source"),
        BROKEN_FS
    );
    items.clone()
}

/// Closing the valid overlay reveals the independently confirmed saved-file error again.
fn assert_saved_truth_returns(
    workspace: &fixtures_medium::MediumWorkspace,
    client: &mut LspClient,
    fs_uri: &str,
    traffic: &mut Vec<Value>,
) {
    client.close_document(fs_uri);
    let response = complete_workspace_pull(client, traffic);
    let items = response["result"]["items"]
        .as_array()
        .expect("saved compiler reports");
    let fs = report_for(items, fs_uri);
    assert!(fs["version"].is_null());
    assert_error(
        fs["items"].as_array().expect("saved F# compiler error"),
        "FS0001",
        "sharplsp-fsharp",
    );
    assert_build(
        &workspace.root.join("FsDomain/FsDomain.fsproj"),
        Some("FS0001"),
    );
}
