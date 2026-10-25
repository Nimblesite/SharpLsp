//! Independent metadata remains available without making an unrestored compiler ready.
//! Implements [SE-WORKSPACE-SYMBOLS-REQUEST] and [DIAG-TRUTH-RECOVERY]. Regression #478.
//! Verifies [SIDECAR-RECOVERY-METADATA] with real SDK projects, owned processes, and heartbeat traffic.
use super::*;
use analyzer_replay::{assert_host_alive, crash_csharp, owned_csharp};
use fixtures_medium::cs_med_pos::ICUSTOMER_REPOSITORY_DECL;
use fixtures_medium::{create_medium_workspace, MediumWorkspace};
use workspace_diagnostic_session::warm_clean_documents;

#[test]
fn valid_selection_rehydrates_after_independent_metadata_and_heartbeat() {
    let selected = recovery_workspace();
    let next = create_medium_workspace();
    let mut client = initialized(&selected);
    let mut traffic = Vec::new();
    let uris = open_unsaved_error(&selected, &mut client, &mut traffic);
    assert_truth(&mut client, &uris, &mut traffic, "before metadata recovery");
    let original = crash_csharp(&client);
    std::thread::sleep(Duration::from_secs(7));
    assert_metadata_stable(&mut client, &next, original);
    analyzer_replay::save_fsharp(&selected, &mut client);
    assert_truth(&mut client, &uris, &mut traffic, "valid A after metadata");
    assert_no_push(&traffic);
    assert_host_alive(&mut client);
    client.shutdown_and_exit();
}

#[test]
fn deleted_selected_solution_preserves_metadata_and_deferred_semantic_recovery() {
    require_dotnet();
    let selected = create_medium_workspace();
    let next = create_medium_workspace();
    let mut client = initialized(&selected);
    let host = client.child.id();
    let mut traffic = Vec::new();
    select(&mut client, &selected, &mut traffic);
    let original = delete_and_crash(&selected, &mut client, &mut traffic);
    assert_metadata_stable(&mut client, &next, original);
    assert_deferred(&mut client, &selected, &mut traffic, (6, 20));
    select(&mut client, &next, &mut traffic);
    assert_metadata(&mut client, &next);
    assert_same_host(&mut client, host);
    client.shutdown_and_exit();
}

/// Selecting a real solution remains a separate operation from inspecting another target.
fn select(client: &mut LspClient, workspace: &MediumWorkspace, traffic: &mut Vec<Value>) {
    let response = observed_request(
        client,
        "sharplsp/loadSolution",
        json!({"solutionPath":workspace.root.join("Medium.sln")}),
        traffic,
    );
    assert_rpc_ok(&response, "select actual SDK solution");
    assert_eq!(response["result"]["success"], true);
    warm_clean_documents(workspace, client, traffic);
}

/// Removing only the chosen selector leaves both real SDK projects intact.
fn delete_and_crash(
    workspace: &MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
) -> sysinfo::Pid {
    std::fs::remove_file(workspace.root.join("Medium.sln")).expect("delete selected solution");
    let original = crash_csharp(client);
    // The production monitor checks every five seconds; let it discard the killed pipe.
    std::thread::sleep(Duration::from_secs(7));
    assert_deferred(client, workspace, traffic, ICUSTOMER_REPOSITORY_DECL);
    original
}

/// A workspace switch never replaces or terminates the editor's native host.
fn assert_same_host(client: &mut LspClient, original: u32) {
    assert_eq!(client.child.id(), original, "same native host");
    assert_host_alive(client);
}

/// Two independent reads share one recovered compiler process without restoring the deleted root.
fn assert_metadata_stable(
    client: &mut LspClient,
    workspace: &MediumWorkspace,
    original: sysinfo::Pid,
) {
    let recovered = metadata_transport(client, workspace, original);
    assert_metadata(client, workspace);
    assert_eq!(owned_csharp(client), recovered, "no respawn on metadata");
    // A real health ping must not consume the pending compiler replay either.
    std::thread::sleep(Duration::from_secs(6));
    assert_eq!(
        owned_csharp(client),
        recovered,
        "health preserves pending replay"
    );
}

/// Metadata and configuration acknowledge the recovered transport without completing compiler replay.
fn metadata_transport(
    client: &mut LspClient,
    workspace: &MediumWorkspace,
    original: sysinfo::Pid,
) -> sysinfo::Pid {
    assert_metadata(client, workspace);
    let recovered = owned_csharp(client);
    assert_ne!(recovered, original, "new compiler");
    let response = observed_request(client, "sharplsp/configuration", json!({}), &mut Vec::new());
    assert_rpc_ok(&response, "metadata leaves the host responsive");
    assert_eq!(response["result"]["testing"]["configuration"], "Debug");
    recovered
}

/// F# metadata is inspected first; every project belongs to the requested independent solution.
fn assert_metadata(client: &mut LspClient, workspace: &MediumWorkspace) {
    let projects = metadata(client, workspace);
    for (name, relative) in [
        ("FsDomain", "FsDomain/FsDomain.fsproj"),
        ("Core", "Core/Core.csproj"),
        ("Services", "Services/Services.csproj"),
    ] {
        assert_project(&projects, workspace, name, relative);
    }
}

/// Inspect real solution/project data through the public LSP, not a manager or transport mock.
fn metadata(client: &mut LspClient, workspace: &MediumWorkspace) -> Vec<Value> {
    let response = observed_request(
        client,
        "sharplsp/workspaceSymbols",
        json!({"solution":workspace.root.join("Medium.sln")}),
        &mut Vec::new(),
    );
    assert_rpc_ok(&response, "metadata remains available");
    assert!(
        response["result"]["projects"].is_array(),
        "actual metadata reply: {response}"
    );
    let projects = response["result"]["projects"]
        .as_array()
        .expect("project metadata");
    assert_eq!(projects.len(), 3, "three actual projects");
    projects.clone()
}

/// Native paths identify the actual target projects; all symbol collections retain their shape.
fn assert_project(projects: &[Value], workspace: &MediumWorkspace, name: &str, relative: &str) {
    let project = projects
        .iter()
        .find(|project| project["name"] == name)
        .expect("expected project");
    let actual = project["path"].as_str().expect("native project path");
    assert_eq!(
        canonical_file_uri(std::path::Path::new(actual)).expect("actual project URI"),
        canonical_file_uri(&workspace.root.join(relative)).expect("expected project URI"),
        "metadata belongs to the requested solution, never the deleted selection",
    );
    assert!(
        project["symbols"].is_array(),
        "the project retains its symbol collection"
    );
}

/// A metadata read must not silently mark the same fresh connection semantically ready.
fn assert_deferred(
    client: &mut LspClient,
    workspace: &MediumWorkspace,
    traffic: &mut Vec<Value>,
    position: (u32, u32),
) {
    let uri = path_to_file_uri(&workspace.entities_path());
    let params =
        json!({"textDocument":{"uri":uri},"position":{"line":position.0,"character":position.1}});
    let response = observed_request(client, "textDocument/hover", params, traffic);
    assert_rpc_ok(&response, "an unrestored compiler degrades truthfully");
    assert_eq!(
        response["result"],
        Value::Null,
        "the deleted selection cannot be bypassed"
    );
    assert_host_alive(client);
}
